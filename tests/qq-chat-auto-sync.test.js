'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createQQChatAutoSyncService } = require('../electron/qq-chat-auto-sync');

async function makeFixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mst-qq-auto-'));
  const chunksDir = path.join(root, 'chunks');
  await fsp.mkdir(chunksDir);
  const configPath = path.join(root, 'state', 'auto.json');
  const services = [];
  t.after(async function () {
    for (const service of services) service.close();
    await fsp.rm(root, { recursive: true, force: true });
  });
  function create(validateDirectory) {
    const service = createQQChatAutoSyncService({
      fs,
      path,
      configPath,
      debounceMs: 1000,
      validateDirectory: validateDirectory || (async function (dir) { return { dir, chunksDir }; }),
      onChanged: function () {}
    });
    services.push(service);
    return service;
  }
  return { root, chunksDir, configPath, create };
}

test('QQ auto sync persists an explicitly validated directory and restores its watcher', async function (t) {
  const fixture = await makeFixture(t);
  const first = fixture.create();
  const enabled = await first.enable(fixture.root);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.active, true);
  assert.equal(enabled.dir, path.resolve(fixture.root));

  const saved = JSON.parse(await fsp.readFile(fixture.configPath, 'utf8'));
  assert.equal(saved.enabled, true);
  assert.equal(saved.dir, path.resolve(fixture.root));
  first.close();

  const restored = fixture.create();
  const status = await restored.restore();
  assert.equal(status.enabled, true);
  assert.equal(status.active, true);
  assert.equal(status.lastError, '');
});

test('QQ auto sync reports results and can be disabled without deleting its selected path', async function (t) {
  const fixture = await makeFixture(t);
  const service = fixture.create();
  await service.enable(fixture.root);
  const reported = await service.report({ ok: true, added: 7 });
  assert.equal(reported.lastAdded, 7);
  assert.ok(reported.lastSyncAt);

  const disabled = await service.disable();
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.active, false);
  assert.equal(disabled.dir, path.resolve(fixture.root));
});

test('QQ auto sync refuses a directory that fails manifest validation', async function (t) {
  const fixture = await makeFixture(t);
  const service = fixture.create(async function () { throw new Error('manifest 无效'); });
  await assert.rejects(service.enable(fixture.root), /manifest 无效/);
  assert.equal(service.status().enabled, false);
  assert.equal(service.status().active, false);
});
