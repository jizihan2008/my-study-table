'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = file => fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8');
function harness() {
  const values = new Map();
  let limit = Infinity;
  let failure = null;
  let writes = 0;
  const localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem(key, value) {
      writes++;
      if (failure) throw failure;
      const used = [...values].reduce((sum, [k, v]) => sum + (k === key ? 0 : k.length + v.length), 0);
      if (used + key.length + String(value).length > limit) {
        const error = new Error('Setting the value exceeded the quota');
        error.name = 'QuotaExceededError';
        throw error;
      }
      values.set(key, String(value));
    }
  };
  const window = {};
  const ctx = vm.createContext({ window, localStorage, console: { error() {}, warn() {} } });
  vm.runInContext(source('platform.js'), ctx);
  ctx.StudyPlatform = window.StudyPlatform;
  const core = source('core.js');
  vm.runInContext(core.slice(0, core.indexOf('let todos = loadData')), ctx);
  return { ctx, window, values, setLimit(v) { limit = v; }, fail(error) { failure = error; }, writes: () => writes };
}

test('quota retry compacts redundant AI caches without losing branches or native tool history', () => {
  const h = harness();
  const message = { role: 'assistant', content: 'answer'.repeat(200), tool_calls: [{ id: 'call_1', type: 'function' }] };
  const conv = { id: 1, tree: { a: { message }, b: { message: { role: 'tool', tool_call_id: 'call_1', content: 'result' } } }, activePath: ['a'], messages: [message], _rawLogs: ['diagnostic'], _dailyReport: true };
  h.values.set('study_ai_convs', JSON.stringify([conv]));
  h.values.set('study_notes_v2', JSON.stringify([{ id: 1, content: 'old' }]));
  const used = [...h.values].reduce((sum, [k,v]) => sum + k.length + v.length, 0);
  h.setLimit(used + 50);
  assert.equal(h.ctx.saveData('study_notes_v2', [{ id: 1, content: 'new'.repeat(180) }]), true);
  const stored = JSON.parse(h.values.get('study_ai_convs'))[0];
  assert.deepEqual(stored.tree, conv.tree);
  assert.deepEqual(stored.activePath, conv.activePath);
  assert.deepEqual(stored._rawLogs, conv._rawLogs);
  assert.equal(stored._dailyReport, true);
  assert.equal(stored.messages, undefined);
  assert.equal(h.ctx.saveData.lastError, '');
  assert.equal(JSON.parse(h.values.get('study_notes_v2'))[0].content, 'new'.repeat(180));
});

test('quota retry trims only diagnostic logs and preserves pending sync state', () => {
  const h = harness();
  const log = Array.from({ length: 100 }, (_, i) => ({ event: 'sync', key: 'study_notes_v2', at: i }));
  h.values.set('study_sync_event_log_v1', JSON.stringify(log));
  h.values.set('study_sync_conflict_history', JSON.stringify(log));
  const protectedKeys = ['study_sync_collection_conflicts_v1', 'study_sync_dirty_v1', 'study_notes_archive'];
  for (const key of protectedKeys) h.values.set(key, '[{"keep":true}]');
  const used = [...h.values].reduce((sum, [k,v]) => sum + k.length + v.length, 0);
  h.setLimit(used + 10);
  assert.equal(h.ctx.saveData('study_notes_v2', [{ id: 1, content: 'large'.repeat(100) }]), true);
  for (const key of protectedKeys) assert.equal(h.values.get(key), '[{"keep":true}]');
  for (const key of ['study_sync_event_log_v1', 'study_sync_conflict_history']) assert.deepEqual(JSON.parse(h.values.get(key)), log.slice(0, 10));
});

async function resolveRemote(h) {
  const key = 'mst:item:v1:study_notes_v2:1';
  h.values.set('study_sync_collection_conflicts_v1', JSON.stringify({ [key]: { key, collection: 'study_notes_v2', id: '1', reason: 'both-changed' } }));
  h.window.Sync = { canSyncAccount: () => true };
  h.window.SyncPolicy = require('../js/sync-policy');
  vm.runInContext(source('sync-collections.js'), h.ctx);
  const client = { from() { return {
    select() { return this; }, eq() { return this; }, like() { return this; },
    then(resolve, reject) { return Promise.resolve({ data: [{ key, value: { item: { id: 1, content: 'remote' }, index: 0 }, updated_at: '2026-10-12T00:00:00Z' }], error: null }).then(resolve, reject); }
  }; } };
  return h.window.SyncCollections.resolveConflict(key, 'remote', { user: { id: 'u1' } }, client);
}

test('failed iPad-style quota write reports its cause and retains the note and conflict', async () => {
  const h = harness();
  const before = '[{"id":1,"content":"local"}]';
  h.values.set('study_notes_v2', before);
  const error = new Error('Setting the value exceeded the quota');
  error.name = 'QuotaExceededError';
  h.fail(error);
  const result = await resolveRemote(h);
  assert.equal(result.ok, false);
  assert.match(result.reason, /本地存储空间不足/);
  assert.equal(h.values.get('study_notes_v2'), before);
  assert.equal(Object.keys(JSON.parse(h.values.get('study_sync_collection_conflicts_v1'))).length, 1);
  assert.equal(h.values.has('study_sync_collection_state_v1'), false);
  assert.equal(h.writes(), 1, 'no unbounded retries or metadata acknowledgement');
});

test('blocked browser storage does not trigger quota cleanup', () => {
  const h = harness();
  const raw = JSON.stringify(Array.from({ length: 30 }, () => ({ event: 'sync' })));
  h.values.set('study_sync_event_log_v1', raw);
  const error = new Error('Access denied');
  error.name = 'SecurityError';
  h.fail(error);
  assert.equal(h.ctx.saveData('study_notes_v2', []), false);
  assert.match(h.ctx.saveData.lastError, /网站存储权限/);
  assert.equal(h.values.get('study_sync_event_log_v1'), raw);
});

test('byte-identical notes succeed even when further writes are blocked', () => {
  const h = harness();
  h.values.set('study_notes_v2', '[{"id":1,"content":"same"}]');
  h.fail(new Error('quota exceeded'));
  assert.equal(h.ctx.saveData('study_notes_v2', [{ id: 1, content: 'same' }]), true);
  assert.equal(h.ctx.saveData.lastError, '');
  assert.equal(h.writes(), 0);
});


test('remote conflict completes after quota recovery and records the new baseline', async () => {
  const h = harness();
  h.values.set('study_notes_v2', '[{"id":1,"content":"local"}]');
  h.values.set('study_sync_event_log_v1', JSON.stringify(Array.from({ length: 100 }, () => ({ event: 'sync', reason: 'diagnostic'.repeat(20) }))));
  const key = 'mst:item:v1:study_notes_v2:1';
  h.values.set('study_sync_collection_conflicts_v1', JSON.stringify({ [key]: { key, collection: 'study_notes_v2', id: '1', reason: 'both-changed' } }));
  h.setLimit([...h.values].reduce((sum, [k, v]) => sum + k.length + v.length, 0));
  const result = await resolveRemote(h);
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(h.values.get('study_notes_v2'))[0].content, 'remote');
  assert.equal(Object.keys(JSON.parse(h.values.get('study_sync_collection_conflicts_v1'))).length, 0);
  assert.equal(JSON.parse(h.values.get('study_sync_collection_state_v1')).study_notes_v2['1'].timestamp, '2026-10-12T00:00:00Z');
  assert.equal(JSON.parse(h.values.get('study_sync_event_log_v1')).length, 10);
});

test('insufficient reclaimed space stops after one retry and keeps the last good note', () => {
  const h = harness();
  const before = '[{"id":1,"content":"local"}]';
  h.values.set('study_notes_v2', before);
  h.values.set('study_sync_event_log_v1', JSON.stringify(Array.from({ length: 11 }, () => ({ event: 'sync' }))));
  h.setLimit([...h.values].reduce((sum, [k, v]) => sum + k.length + v.length, 0));
  assert.equal(h.ctx.saveData('study_notes_v2', [{ id: 1, content: 'remote'.repeat(1000) }]), false);
  assert.equal(h.values.get('study_notes_v2'), before);
  assert.match(h.ctx.saveData.lastError, /本地存储空间不足/);
  assert.equal(h.writes(), 3, 'two attempts plus one diagnostic trim');
});
