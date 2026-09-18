'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../js/sync-policy');

function loadSyncLogs(seed = {}, options = {}) {
  let nextId = 999;
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
  const state = { renders: 0, renderOptions: [] };
  const context = {
    window,
    localStorage,
    aiConvs: options.aiConvs,
    activeConvId: options.activeConvId,
    genId: () => ++nextId,
    safeSaveAiConvs() {
      localStorage.setItem('study_ai_convs', JSON.stringify(context.aiConvs));
      return true;
    },
    renderAiChat(options) { state.renders++; state.renderOptions.push(options); },
    SyncPolicy: policy,
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
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'ai-tree.js'), 'utf8'), context);
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'sync-logs.js'), 'utf8');
  vm.runInNewContext(code, context);
  return { SyncLogs: window.SyncLogs, values, context, state };
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

test('a conversation outside the recent 20 is not treated as a user deletion', async () => {
  const conversations = Array.from({ length: 21 }, (_, i) => ({ id: i + 1, messages: [] }));
  const { SyncLogs, values } = loadSyncLogs({
    study_ai_convs: conversations,
    study_sync_logs_known_items_v2: { ai_conv: ['1'] }
  });
  await SyncLogs.__test.refreshLocalState(true);
  assert.equal(JSON.parse(values.get('study_sync_logs_tombstones_v2'))['ai_conv/1'], undefined);
});

test('a partial upload retries its own successful shard without a false conflict', async () => {
  let calls = 0;
  const client = {
    from() {
      return {
        upsert() { return this; },
        select() { return this; },
        single() {
          calls++;
          return Promise.resolve(calls === 2
            ? { data: null, error: { message: 'offline' } }
            : { data: { updated_at: calls === 1 ? '2026-08-25T08:01:00Z' : '2026-08-25T08:02:00Z' }, error: null });
        }
      };
    }
  };
  const { SyncLogs, values } = loadSyncLogs({
    study_sync_logs_dirty_v2: { 'ai_conv/7': true },
    study_sync_logs_ts: { 'ai_conv/7': '2026-08-25T08:00:00Z' }
  }, { client });
  const item = { kind: 'ai_conv', itemId: '7', meta: { id: 7 }, items: [] };
  const pieces = [
    { itemId: '7_p0', wrap: { d: 'first' }, bytes: 5 },
    { itemId: '7_p1', wrap: { d: 'second' }, bytes: 6 }
  ];
  const session = { user: { id: 'u1' } };
  const first = await SyncLogs.__test.uploadPreparedItem(session, client, item, pieces,
    { groups: { 'ai_conv/7': [] }, set: new Set() }, false);
  assert.equal(first.ok, false);
  const row = { item_id: '7_p0', updated_at: '2026-08-25T08:01:00Z' };
  const retried = await SyncLogs.__test.uploadPreparedItem(session, client, item, pieces,
    { groups: { 'ai_conv/7': [row] }, set: new Set(['ai_conv/7_p0']) }, false);
  assert.equal(retried.ok, true);
  assert.equal(calls, 3);
  assert.equal(JSON.parse(values.get('study_sync_logs_ts'))['ai_conv/7'], '2026-08-25T08:02:00Z');
  assert.equal(SyncLogs.getPendingConflicts().length, 0);
});

test('a remote tombstone removes the local conversation and refreshes the chat', async () => {
  const row = {
    kind: 'ai_conv', item_id: '7', updated_at: '2026-08-25T08:02:00Z',
    data: { v: 2, deleted: true }
  };
  const client = {
    from() {
      return {
        select() { return this; }, eq() { return this; }, in() { return this; },
        then(resolve, reject) { return Promise.resolve({ data: [row], error: null }).then(resolve, reject); }
      };
    }
  };
  const convs = [{ id: 7, title: '旧对话', messages: [] }, { id: 8, title: '保留', messages: [] }];
  const { SyncLogs, values, state } = loadSyncLogs({
    study_ai_convs: convs,
    study_sync_logs_ts: { 'ai_conv/7': '2026-08-25T08:00:00Z' },
    study_sync_logs_known_items_v2: { ai_conv: ['7', '8'] }
  }, { client, aiConvs: convs, activeConvId: 7 });
  await SyncLogs.__test.pullItems({ user: { id: 'u1' } }, client, [{ kind: 'ai_conv', itemId: '7' }]);
  assert.deepEqual(JSON.parse(values.get('study_ai_convs')).map(conv => conv.id), [8]);
  assert.equal(values.get('study_active_conv'), '8');
  assert.equal(state.renders, 1);
  assert.equal(state.renderOptions[0].skipDraftSave, true);
});

test('deleting a conversation leaves a durable cloud tombstone', async () => {
  let written = null;
  const client = {
    from() {
      return {
        upsert(row) { written = row; return this; },
        select() { return this; },
        single() { return Promise.resolve({ data: { updated_at: '2026-08-25T08:02:00Z' }, error: null }); }
      };
    }
  };
  const { SyncLogs, values } = loadSyncLogs({
    study_sync_logs_tombstones_v2: { 'ai_conv/7': { kind: 'ai_conv', itemId: '7' } },
    study_sync_logs_dirty_v2: { 'ai_conv/7': true },
    study_sync_logs_ts: { 'ai_conv/7': '2026-08-25T08:00:00Z' }
  }, { client });
  const result = await SyncLogs.__test.processTombstone(
    { user: { id: 'u1' } }, client, { kind: 'ai_conv', itemId: '7' },
    { groups: { 'ai_conv/7': [] } }, false
  );
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(written.data)), { v: 2, deleted: true });
  assert.equal(written.bytes, 0);
  assert.equal(JSON.parse(values.get('study_sync_logs_tombstones_v2'))['ai_conv/7'], undefined);
});

test('a pulled conversation refreshes the visible chat', async () => {
  const row = {
    kind: 'ai_conv', item_id: '7', updated_at: '2026-08-25T08:02:00Z',
    data: { meta: { id: 7, title: '云端版本' }, items: [{ role: 'assistant', content: '新消息' }] }
  };
  const client = {
    from() {
      return {
        select() { return this; }, eq() { return this; }, in() { return this; },
        then(resolve, reject) { return Promise.resolve({ data: [row], error: null }).then(resolve, reject); }
      };
    }
  };
  const convs = [{ id: 7, title: '旧版本', messages: [] }];
  const { SyncLogs, values, state } = loadSyncLogs({
    study_ai_convs: convs,
    study_sync_logs_ts: { 'ai_conv/7': '2026-08-25T08:00:00Z' }
  }, { client, aiConvs: convs, activeConvId: 7 });
  await SyncLogs.__test.pullItems({ user: { id: 'u1' } }, client, [{ kind: 'ai_conv', itemId: '7' }]);
  assert.equal(JSON.parse(values.get('study_ai_convs'))[0].title, '云端版本');
  assert.equal(state.renders, 1);
});

test('cross-device daily report merge persists new messages in the tree without duplicates', async () => {
  const row = {
    kind: 'ai_conv', item_id: '20', updated_at: '2026-08-25T08:02:00Z',
    data: {
      meta: { id: 20, title: '📋 每日日报', daily: true },
      items: [
        { id: 101, role: 'user', content: '远端日报请求' },
        { id: 102, role: 'assistant', content: '远端日报内容' },
        { role: 'system', content: '远端无 ID 的补充' }
      ]
    }
  };
  const client = {
    from() {
      return {
        select() { return this; }, eq() { return this; }, in() { return this; },
        then(resolve, reject) { return Promise.resolve({ data: [row], error: null }).then(resolve, reject); }
      };
    }
  };
  const local = { id: 10, title: '📋 每日日报', _dailyReport: true, messages: [] };
  const { SyncLogs, context, values } = loadSyncLogs({
    study_ai_convs: [local],
    study_sync_logs_ts: { 'ai_conv/20': '2026-08-25T08:00:00Z' }
  }, { client, aiConvs: [local], activeConvId: 10 });
  context.initTreeOnConv(local);
  context.appendMessage(local, { role: 'user', content: '本地日报请求' });
  context.appendMessage(local, { role: 'assistant', content: '本地日报内容' });
  context.safeSaveAiConvs();

  await SyncLogs.__test.pullItems({ user: { id: 'u1' } }, client, [{ kind: 'ai_conv', itemId: '20' }]);
  const restored = JSON.parse(values.get('study_ai_convs'))[0];
  context.ensureTree(restored);
  assert.deepEqual(restored.messages.map(m => m.content), [
    '本地日报请求', '本地日报内容', '远端日报请求', '远端日报内容', '远端无 ID 的补充'
  ]);
  assert.equal(Object.keys(restored.tree).length, 6);

  row.updated_at = '2026-08-25T08:03:00Z';
  await SyncLogs.__test.pullItems({ user: { id: 'u1' } }, client, [{ kind: 'ai_conv', itemId: '20' }]);
  context.ensureTree(local);
  assert.equal(local.messages.length, 5);
});

test('a tree-only fallback payload rebuilds the message cache after cloud pull', async () => {
  const row = {
    kind: 'ai_conv', item_id: '30', updated_at: '2026-08-25T08:02:00Z', data: null
  };
  const client = {
    from() {
      return {
        select() { return this; }, eq() { return this; }, in() { return this; },
        then(resolve, reject) { return Promise.resolve({ data: [row], error: null }).then(resolve, reject); }
      };
    }
  };
  const { SyncLogs, context, values } = loadSyncLogs({}, { client, aiConvs: [], activeConvId: 30 });
  const remote = {};
  context.initTreeOnConv(remote);
  context.appendMessage(remote, { role: 'user', content: 'question' });
  context.appendMessage(remote, { role: 'assistant', content: 'answer' });
  row.data = { meta: { id: 30, title: 'tree only' }, tree: remote.tree, activePath: remote.activePath, items: [] };

  await SyncLogs.__test.pullItems({ user: { id: 'u1' } }, client, [{ kind: 'ai_conv', itemId: '30' }]);
  const restored = JSON.parse(values.get('study_ai_convs'))[0];
  assert.deepEqual(restored.messages.map(m => m.content), ['question', 'answer']);
});
