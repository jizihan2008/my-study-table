'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { parsePublicWebUrl, isPublicIp } = require('../electron/security');
const { normalizeReadOptions, createSnapshotCache, pageSnapshot, checkRequestUrl, installRequestGuard, waitForContent } = require('../electron/web-reader');

test('public URLs reject canonicalization bypasses and non-public IPs', () => {
  for (const host of ['localhost.', 'foo.localhost.', 'printer.local', '127.1', '2130706433', '0.1.2.3', '100.64.0.1', '[::ffff:127.0.0.1]', '[::ffff:172.16.0.1]', '[::ffff:192.168.1.8]', '[::ffff:a9fe:1]', '[::]', '[2001:db8::1]', '[2002:7f00:1::]']) {
    assert.throws(() => parsePublicWebUrl(`http://${host}/`), /本机|局域网/);
  }
  assert.throws(() => parsePublicWebUrl('https://name:secret@example.com/'), /用户名/);
  assert.equal(isPublicIp('2606:4700:4700::1111'), true);
  assert.equal(parsePublicWebUrl('https://example.com/a').href, 'https://example.com/a');
});

test('each network request checks Chromium DNS and rejects mixed/private answers', async () => {
  const hosts = [];
  const session = { resolveHost: async host => { hosts.push(host); return { endpoints: [{ address: '93.184.216.34' }] }; } };
  assert.equal(await checkRequestUrl(session, 'wss://example.com/socket'), 'https://example.com/socket');
  assert.deepEqual(hosts, ['example.com']);
  session.resolveHost = async () => ({ endpoints: [{ address: '93.184.216.34' }, { address: '10.0.0.1' }] });
  await assert.rejects(checkRequestUrl(session, 'https://example.com/'), /域名解析/);
  session.resolveHost = async () => ({ endpoints: [] });
  await assert.rejects(checkRequestUrl(session, 'https://example.com/'), /域名解析/);
});

test('request guard covers frames, XHR and downloads and releases listeners', async () => {
  const session = new EventEmitter();
  session.webRequest = { onBeforeRequest: fn => { session.guard = fn; } };
  session.resolveHost = async () => ({ endpoints: [{ address: '127.0.0.1' }] });
  const blocked = [];
  const cleanup = installRequestGuard(session, d => blocked.push(d.resourceType));
  for (const resourceType of ['mainFrame', 'subFrame', 'xhr', 'webSocket']) {
    const result = await new Promise(resolve => session.guard({ url: 'https://evil.example/', resourceType }, resolve));
    assert.equal(result.cancel, true);
  }
  assert.equal(blocked.length, 4);
  let cancelled = false;
  session.emit('will-download', { preventDefault() { cancelled = true; } });
  assert.equal(cancelled, true);
  cleanup();
  assert.equal(session.guard, null);
  assert.equal(session.listenerCount('will-download'), 0);
});

test('pagination keeps a stable snapshot and provides bounded continuation and search offsets', () => {
  const cache = createSnapshotCache();
  const text = 'İ' + 'a'.repeat(1100) + '目标关键词' + 'b'.repeat(3000) + '目标关键词' + 'c'.repeat(500);
  const data = { title: '长文', text, finalUrl: 'https://example.com/', headings: [], links: [], warnings: [] };
  const first = normalizeReadOptions({ url: data.finalUrl, maxChars: 500 });
  const id = cache.put(1, first.url, data);
  data.text = 'changed';
  const stored = cache.get(1, { ...first, snapshotId: id });
  assert.equal(stored.text, text);
  const pages = [];
  let offset = 0;
  do {
    const result = pageSnapshot(stored, { ...first, offset }, id);
    pages.push(result.text);
    assert.ok(result.text.length <= 500);
    offset = result.nextOffset;
  } while (offset !== null);
  assert.equal(pages.join(''), text);
  assert.throws(() => cache.get(2, { ...first, snapshotId: id }), /不属于/);
  assert.throws(() => cache.get(1, { ...first, url: 'https://other.com/', snapshotId: id }), /URL/);
  assert.throws(() => cache.get(1, { ...first, snapshotId: 'expired' }), /过期/);
  const searched = pageSnapshot(stored, { ...first, query: '目标关键词' }, id);
  assert.equal(searched.matches[0].offset, text.indexOf('目标关键词'));
  assert.ok(searched.nextOffset > searched.matches[0].offset);
  const next = pageSnapshot(stored, { ...first, offset: searched.nextOffset, query: '目标关键词' }, id);
  assert.equal(next.matches[0].offset, text.lastIndexOf('目标关键词'));
  assert.equal(next.nextOffset, null);
});

test('read options reject invalid values and bound extraction output before IPC', () => {
  for (const payload of [{ limit: NaN }, { maxChars: Infinity }, { offset: -1 }, { limit: 1.5 }, { limit: 499 }, { query: {} }, { snapshotId: [] }]) {
    assert.throws(() => normalizeReadOptions({ url: 'https://example.com', ...payload }));
  }
  assert.equal(normalizeReadOptions({ url: 'https://example.com', maxChars: 999999 }).limit, 8000);
  assert.equal(normalizeReadOptions({ url: 'https://example.com', limit: 500, maxChars: 6000 }).limit, 500);
});

test('stability uses content changes rather than length and reports incomplete loaders', async () => {
  let calls = 0;
  const wc = { executeJavaScriptInIsolatedWorld: async () => {
    calls++;
    return { text: 'x'.repeat(120), bodyText: calls < 4 ? (calls % 2 ? 'aaa' : 'bbb') : 'done', ready: 'complete', busy: false };
  } };
  const result = await waitForContent(wc, { minWaitMs: 0, quietMs: 12, intervalMs: 5, timeoutMs: 200 });
  assert.equal(result.stable, true);
  assert.ok(calls >= 5);
  wc.executeJavaScriptInIsolatedWorld = async () => ({ text: '加载中', bodyText: '加载中', ready: 'complete', busy: true });
  assert.equal((await waitForContent(wc, { minWaitMs: 0, quietMs: 0, intervalMs: 5, timeoutMs: 25 })).stable, false);
  await assert.rejects(waitForContent(wc, { alive: () => false }), /取消/);
});

test('AI webpage output retains metadata, distrust boundary and stays below tool budget', async () => {
  const ctx = { console, getMaxFocusCount: () => 3, window: { electronAPI: { webRead: async payload => {
    assert.equal(payload.snapshotId, 'snapshot');
    assert.equal(payload.offset, 500);
    return { ok: true, text: '正文'.repeat(4000), title: '文章', finalUrl: 'https://example.com/', snapshotId: 'snapshot', totalChars: 16000, offset: 500, nextOffset: 8500, truncated: true, warnings: ['正文可能未加载完整'] };
  } } }, document: { getElementById: () => null } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ai-tools.js'), 'utf8'), ctx);
  const output = await ctx.executeToolCall('read_webpage', { url: 'https://example.com/', offset: 500, snapshotId: 'snapshot', limit: 8000 });
  assert.match(output, /"nextOffset":8500/);
  assert.match(output, /不可信外部资料/);
  assert.match(output, /未加载完整/);
  assert.ok(output.length < 12000);
});
