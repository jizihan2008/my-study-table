'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../js/sync-policy');

function loadSyncLogs(seed = {}, options = {}) {
  const values = new Map(Object.entries(seed).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  const localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  const window = {
    __MST_TEST__: true,
    SyncPolicy: policy,
    Sync: { enabled: true, autoSync: false }
  };
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'sync-logs.js'), 'utf8');
  vm.runInNewContext(code, {
    window,
    localStorage,
    getSupabaseClient: options.client ? () => options.client : undefined,
    setTimeout() { return 1; },
    clearTimeout() {},
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    encodeURIComponent,
    decodeURIComponent,
    escape,
    unescape,
    TextEncoder,
    TextDecoder,
    document: { getElementById() { return null; } },
    console: { log() {}, warn() {}, error() {} }
  });
  return { SyncLogs: window.SyncLogs, values };
}

test('conversation changes remain dirty while automatic cloud storage is off', () => {
  const { SyncLogs, values } = loadSyncLogs({
    study_ai_convs: [{ id: 1, title: '本地', messages: [] }]
  });
  SyncLogs.onLocalChange('study_ai_convs');
  assert.deepEqual(JSON.parse(values.get('study_sync_logs_dirty_v2')), { 'ai_conv/*': true });
});

test('local deletion creates a persistent cloud tombstone', () => {
  const { SyncLogs, values } = loadSyncLogs();
  SyncLogs.markItemDeleted('ai_conv', 42);
  const tombstones = JSON.parse(values.get('study_sync_logs_tombstones_v2'));
  const dirty = JSON.parse(values.get('study_sync_logs_dirty_v2'));
  assert.equal(tombstones['ai_conv/42'].itemId, '42');
  assert.equal(dirty['ai_conv/42'], true);
});

test('state refresh detects conversations removed since the last synchronized snapshot', async () => {
  const { SyncLogs, values } = loadSyncLogs({
    study_ai_convs: [{ id: 1, title: '保留', messages: [{ role: 'user', content: 'hello' }] }],
    study_sync_logs_known_items_v2: { ai_conv: ['1', '2'] }
  });
  await SyncLogs.__test.refreshLocalState(true);
  const tombstones = JSON.parse(values.get('study_sync_logs_tombstones_v2'));
  const dirty = JSON.parse(values.get('study_sync_logs_dirty_v2'));
  assert.equal(tombstones['ai_conv/2'].itemId, '2');
  assert.equal(dirty['ai_conv/1'], true);
  assert.equal(dirty['ai_conv/2'], true);
});

test('newer unsharded conversation wins over stale cloud shards after a clear', () => {
  const { SyncLogs } = loadSyncLogs();
  const rows = [
    { item_id: '7_p0', updated_at: '2026-08-25T08:00:00.000Z' },
    { item_id: '7_p1', updated_at: '2026-08-25T08:00:01.000Z' },
    { item_id: '7', updated_at: '2026-08-25T08:05:00.000Z' }
  ];
  const selected = SyncLogs.__test.selectCurrentRows(rows);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].item_id, '7');
});

test('newer child shards replace a stale parent shard as one coherent generation', () => {
  const { SyncLogs } = loadSyncLogs();
  const rows = [
    { item_id: '7_p0', updated_at: '2026-08-25T08:00:00.000Z' },
    { item_id: '7_p0_p0', updated_at: '2026-08-25T08:05:00.000Z' },
    { item_id: '7_p0_p1', updated_at: '2026-08-25T08:05:01.000Z' },
    { item_id: '7_p1', updated_at: '2026-08-25T08:05:02.000Z' }
  ];
  const selected = SyncLogs.__test.selectCurrentRows(rows);
  assert.equal(selected.some(row => row.item_id === '7_p0'), false);
  assert.equal(selected.some(row => row.item_id === '7_p0_p0'), true);
  assert.equal(selected.some(row => row.item_id === '7_p0_p1'), true);
  assert.equal(selected.some(row => row.item_id === '7_p1'), true);
});

test('a partial child upload does not replace its last complete parent shard', () => {
  const { SyncLogs } = loadSyncLogs();
  const rows = [
    { item_id: '7_p0', updated_at: '2026-08-25T08:00:00.000Z' },
    { item_id: '7_p0_p0', updated_at: '2026-08-25T08:05:00.000Z' },
    { item_id: '7_p0_p1', updated_at: '2026-08-25T07:55:00.000Z' },
    { item_id: '7_p1', updated_at: '2026-08-25T08:00:01.000Z' }
  ];
  const selected = SyncLogs.__test.selectCurrentRows(rows);
  assert.equal(selected.some(row => row.item_id === '7_p0'), true);
  assert.equal(selected.some(row => row.item_id === '7_p0_p0'), false);
  assert.equal(selected.some(row => row.item_id === '7_p0_p1'), false);
});

test('remote edits after the shared base require a conversation conflict', () => {
  const { SyncLogs } = loadSyncLogs();
  assert.equal(SyncLogs.__test.hasRemoteAdvanced(
    '2026-08-25T08:05:00.000Z',
    '2026-08-25T08:00:00.000Z'
  ), true);
  assert.equal(SyncLogs.__test.hasRemoteAdvanced(
    '2026-08-25T08:00:00.000Z',
    '2026-08-25T08:00:00.000Z'
  ), false);
});

test('persisted conversation conflicts are available to the settings interface', () => {
  const { SyncLogs } = loadSyncLogs({
    study_sync_logs_conflicts_v2: {
      'ai_conv/9': {
        kind: 'ai_conv', itemId: '9', name: '并发对话', reason: 'both-changed',
        detectedAt: '2026-08-25T08:05:00.000Z'
      }
    }
  });
  const conflicts = SyncLogs.getPendingConflicts();
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].itemId, '9');
});

test('a local conversation edit uses the fast path without downloading all payloads', async () => {
  const calls = { inventory: 0, payload: 0, upload: 0, usageRpc: 0 };
  const client = {
    auth: { getSession: () => ({ data: { session: { user: { id: 'u1' } } } }) },
    rpc(name) {
      assert.equal(name, 'get_user_sync_usage');
      calls.usageRpc++;
      return Promise.resolve({ data: [{ kind: 'ai_conv', total_bytes: 0 }], error: null });
    },
    from() {
      let selected = '';
      let upserted = null;
      return {
        select(columns) {
          selected = columns;
          if (String(columns).split(',').map(value => value.trim()).includes('data')) calls.payload++;
          else calls.inventory++;
          return this;
        },
        eq() { return this; },
        in() { return this; },
        upsert(row) { upserted = row; calls.upload++; return this; },
        single() {
          return Promise.resolve({ data: { updated_at: '2026-08-26T08:00:00.000Z' }, error: null });
        },
        then(resolve, reject) {
          return Promise.resolve({ data: upserted ? [{ updated_at: '2026-08-26T08:00:00.000Z' }] : [], error: null }).then(resolve, reject);
        }
      };
    }
  };
  const { SyncLogs } = loadSyncLogs({
    study_ai_convs: [{ id: 1, title: '只改这一条', messages: [{ role: 'user', content: 'hello' }] }]
  }, { client });
  SyncLogs.onLocalChange('study_ai_convs');
  await SyncLogs.__test.flushLogs({ pullMode: 'none', maintenance: false });
  assert.equal(calls.upload, 1);
  assert.equal(calls.payload, 0);
  assert.equal(calls.usageRpc, 1);
  assert.equal((await SyncLogs.getStatus()).pendingCount, 0);
});
