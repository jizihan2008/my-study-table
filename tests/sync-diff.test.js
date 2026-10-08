'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const diff = require('../js/sync-diff');
const policy = require('../js/sync-policy');

test('diff identifies changed fields, missing fields and types without reporting key order', () => {
  assert.deepEqual(diff.compare({ a: 1, b: [2] }, { b: [2], a: 1 }).entries, []);
  const result = diff.compare({ title: '本地标题', completed: false, score: 1, extra: null }, { title: '云端标题', completed: true, score: '1' });
  assert.deepEqual(result.entries.map(entry => entry.path), ['标题', '完成状态', 'score', 'extra']);
  assert.equal(result.entries[3].kind, '仅本地存在');
  assert.notEqual(result.entries[2].local, result.entries[2].remote);
  assert.deepEqual(diff.compare(null, null, { localMissing: true, remoteMissing: true }).entries, []);
  assert.equal(diff.compare(null, null, { localMissing: true }).entries[0].kind, '仅云端存在');
});

test('ID arrays identify additions and removals without shifting every subsequent record', () => {
  const result = diff.compare([{ id: 1, title: 'one' }, { id: 2, title: 'two' }], [{ id: 2, title: 'updated' }, { id: 3, title: 'three' }]);
  assert.equal(result.entries.length, 3);
  assert.deepEqual(result.entries.map(entry => entry.kind), ['仅本地存在', '修改', '仅云端存在']);
  assert.match(result.entries[1].path, /two \[ID 2\] → 标题/);
  const reordered = diff.compare([{ id: 1, text: 'one' }, { id: 2, text: 'two' }], [{ id: 2, text: 'two' }, { id: 1, text: 'one' }]);
  assert.equal(reordered.entries.length, 1);
  assert.equal(reordered.entries[0].kind, '顺序变化');
});

test('long text previews show the actual differing location and limit output size', () => {
  const shared = '相同前文\n'.repeat(100);
  const result = diff.compare({ content: shared + '甲' + '后文'.repeat(1000) }, { content: shared + '乙' + '后文'.repeat(1000) });
  assert.match(result.entries[0].location, /第 101 行，第 1 个字符/);
  assert.match(result.entries[0].local, /甲/);
  assert.match(result.entries[0].remote, /乙/);
  assert.ok(result.entries[0].local.length <= 262);
  const many = diff.compare(Array.from({ length: 100 }, () => 1), Array.from({ length: 100 }, () => 2));
  assert.equal(many.entries.length, 40);
  assert.equal(many.truncated, true);
});

test('diff escapes business content, locations and errors before rendering HTML', () => {
  const html = diff.render({ ok: true, local: { '<img src=x onerror=alert(1)>': '<script>danger</script>' }, remote: {} });
  assert.doesNotMatch(html, /<img|<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(diff.render({ ok: false, reason: '<svg onload=alert(1)>' }), /<svg/);
  assert.match(diff.render({ ok: true, local: [1], remote: [1] }), /当前内容一致/);
});

function loadSync(seed, rows, userId = 'u1') {
  const values = new Map(Object.entries({ study_sync_account_id_v1: 'u1', ...seed }).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  let reads = 0;
  const client = {
    auth: { getSession: () => ({ data: { session: { user: { id: userId } } } }) },
    from() {
      const filters = [];
      const run = single => { reads++; const data = rows.filter(row => filters.every(filter => filter(row))); return Promise.resolve({ data: single ? data[0] || null : data, error: null }); };
      return {
        select() { return this; },
        eq(key, value) { filters.push(row => row[key] === value); return this; },
        in(key, list) { filters.push(row => list.includes(row[key])); return this; },
        maybeSingle() { return run(true); },
        then(resolve, reject) { return run(false).then(resolve, reject); }
      };
    }
  };
  const window = { SyncPolicy: policy };
  const context = {
    window, localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    getSupabaseClient: () => client, setTimeout() { return 1; }, clearTimeout() {},
    console: { log() {}, warn() {}, error() {} }
  };
  for (const file of ['sync-collections.js', 'sync.js']) vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js', file), 'utf8'), context);
  return { sync: window.Sync, values, reads: () => reads };
}

test('ordinary conflict preview reads current copies without resolving, dirtying or persisting payloads', async () => {
  const key = 'study_taskline_v1';
  const { sync, values } = loadSync({ [key]: { title: 'local' }, study_sync_pending_conflicts_v1: { [key]: { key, reason: 'both-changed' } } },
    [{ user_id: 'u1', key, value: { title: 'remote' }, updated_at: '2026-10-08T00:00:00Z' }]);
  const before = [...values];
  const result = await sync.getConflictDifferences(key);
  assert.equal(result.ok, true);
  assert.equal(diff.compare(result.local, result.remote).entries[0].path, '标题');
  assert.deepEqual([...values], before);
});

test('preview rejects another account and unknown conflicts before reading business data', async () => {
  const key = 'study_taskline_v1';
  const { sync, reads } = loadSync({ study_sync_pending_conflicts_v1: { [key]: { key } } }, [], 'u2');
  assert.equal((await sync.getConflictDifferences(key)).ok, false);
  assert.equal((await sync.getConflictDifferences('unknown')).ok, false);
  assert.equal(reads(), 0);
});

for (const mode of ['record', 'legacy', 'deleted', 'order']) {
  test(`record-level previews support ${mode} conflicts`, async () => {
    const collection = 'study_notes_v2';
    const key = mode === 'order' ? 'mst:order:v1:' + collection : 'mst:item:v1:' + collection + ':1';
    const { sync, values } = loadSync({
      [collection]: [{ id: 1, title: 'first', content: 'local' }, { id: 2, title: 'second' }],
      study_sync_collection_conflicts_v1: { [key]: { key, collection, reason: mode === 'legacy' ? 'legacy-device-change' : 'both-changed' } }
    }, [{ user_id: 'u1', key: mode === 'legacy' ? collection : key, updated_at: '2026-10-08T00:00:00Z',
      value: mode === 'legacy' ? [{ id: 1, title: 'first', content: 'remote' }] : mode === 'order' ? ['2', '1'] : mode === 'deleted' ? { deleted: true } : { item: { id: 1, title: 'first', content: 'remote' }, index: 0 } }]);
    const before = [...values];
    const result = await sync.getConflictDifferences(key);
    assert.equal(result.ok, true, result.reason);
    const changes = diff.compare(result.local, result.remote, result).entries;
    assert.ok(changes.length > 0);
    if (mode === 'order') assert.match(changes[0].remote, /second/);
    else if (mode === 'deleted') assert.equal(changes[0].kind, '仅本地存在');
    else assert.equal(changes[0].path, '正文');
    assert.deepEqual([...values], before);
  });
}
