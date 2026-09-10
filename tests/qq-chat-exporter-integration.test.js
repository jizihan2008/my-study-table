'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createQQChatExporterIntegration,
  normalizeConfig,
  normalizeLoopbackEndpoint
} = require('../electron/qq-chat-exporter-integration');

test('QCE integration accepts only local HTTP endpoints', function () {
  assert.equal(normalizeLoopbackEndpoint('http://127.0.0.1:40653'), 'http://127.0.0.1:40653');
  assert.equal(normalizeLoopbackEndpoint('http://localhost:40653/'), 'http://localhost:40653');
  assert.throws(() => normalizeLoopbackEndpoint('https://127.0.0.1:40653'), /本机 HTTP/);
  assert.throws(() => normalizeLoopbackEndpoint('http://192.168.1.8:40653'), /回环地址/);
  assert.throws(() => normalizeLoopbackEndpoint('http://127.0.0.1:40653/api'), /路径/);
});

test('QCE integration clamps trigger frequency and sanitizes schedule identifiers', function () {
  const config = normalizeConfig({
    enabled: true,
    mode: 'trigger',
    intervalHours: 1,
    scheduleIds: ['ok-id', '../bad', 'ok-id', 'second.id']
  }, path);
  assert.equal(config.intervalHours, 6);
  assert.deepEqual(config.scheduleIds, ['ok-id', 'second.id']);
});

async function fixture(t, requestJson) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mst-qce-integration-'));
  const outputRoot = path.join(root, 'exports');
  await fsp.mkdir(outputRoot);
  const exportPath = path.join(outputRoot, 'chat.json');
  await fsp.writeFile(exportPath, JSON.stringify({ chatInfo: { name: '测试', type: 'private' }, messages: [] }), 'utf8');
  const old = new Date(Date.now() - 10000);
  await fsp.utimes(exportPath, old, old);
  const events = [];
  const service = createQQChatExporterIntegration({
    fs,
    path,
    http: require('node:http'),
    configPath: path.join(root, 'state.json'),
    validateOutputRoot: async dir => ({ dir }),
    getToken: async () => 'secret-token',
    requestJson: requestJson || (async () => ({})),
    onExports: files => events.push(files)
  });
  t.after(async function () { service.close(); await fsp.rm(root, { recursive: true, force: true }); });
  return { service, outputRoot, exportPath, events };
}

test('QCE native mode discovers stable JSON exports without API polling', async function (t) {
  let apiCalls = 0;
  const f = await fixture(t, async function () { apiCalls++; return {}; });
  await f.service.configure({ enabled: true, mode: 'native', outputRoot: f.outputRoot, intervalHours: 24 });
  const found = await f.service.scanExports();
  assert.equal(found.length, 1);
  assert.equal(apiCalls, 0);
  const loaded = await f.service.readExport(f.exportPath);
  assert.equal(loaded.json.chatInfo.name, '测试');
  await f.service.acknowledge(f.exportPath, true);
  assert.equal((await f.service.scanExports()).length, 0);
});

test('QCE low-frequency mode performs one trigger call and never polls task status', async function (t) {
  const calls = [];
  const f = await fixture(t, async function (request) {
    calls.push(request);
    return { triggeredCount: 1 };
  });
  await f.service.configure({
    enabled: true,
    mode: 'trigger',
    endpoint: 'http://127.0.0.1:40653',
    outputRoot: f.outputRoot,
    intervalHours: 6,
    scheduleIds: ['daily-json']
  });
  const result = await f.service.runNow(true);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, '/api/scheduled-exports/trigger-batch');
  assert.deepEqual(calls[0].body, { ids: ['daily-json'] });
  assert.ok(Date.parse(result.status.nextRunAt) - Date.now() >= 5.9 * 60 * 60 * 1000);
  const repeated = await f.service.runNow(true);
  assert.equal(repeated.ok, false);
  assert.match(repeated.reason, /30 分钟/);
  assert.equal(calls.length, 1);
});
