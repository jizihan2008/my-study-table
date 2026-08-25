'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../js/sync-policy');

test('merge policy never silently overwrites two unknown non-empty copies', () => {
  assert.equal(policy.decideMerge({
    localEmpty: false,
    localDirty: true,
    baseTimestamp: null,
    remoteExists: true,
    remoteHasData: true,
    remoteTimestamp: '2026-08-25T08:00:00.000Z'
  }), 'conflict');
});

test('merge policy uploads local-only changes and pulls remote-only changes', () => {
  const base = '2026-08-25T08:00:00.000Z';
  assert.equal(policy.decideMerge({
    localEmpty: false,
    localDirty: true,
    baseTimestamp: base,
    remoteExists: true,
    remoteHasData: true,
    remoteTimestamp: base
  }), 'upload');
  assert.equal(policy.decideMerge({
    localEmpty: false,
    localDirty: false,
    baseTimestamp: base,
    remoteExists: true,
    remoteHasData: true,
    remoteTimestamp: '2026-08-25T08:05:00.000Z'
  }), 'pull');
});

test('merge policy detects concurrent edits after a shared base version', () => {
  assert.equal(policy.decideMerge({
    localEmpty: false,
    localDirty: true,
    baseTimestamp: '2026-08-25T08:00:00.000Z',
    remoteExists: true,
    remoteHasData: true,
    remoteTimestamp: '2026-08-25T08:05:00.000Z'
  }), 'conflict');
});

test('recurring task reschedules after every completed run without overlap', async () => {
  let scheduled = null;
  let timerId = 0;
  let runs = 0;
  let release;
  const scheduler = policy.createRecurringTask(async () => {
    runs++;
    await new Promise(resolve => { release = resolve; });
  }, 100, {
    setTimeout(fn) { scheduled = fn; return ++timerId; },
    clearTimeout() { scheduled = null; }
  });

  await scheduler.start();
  assert.equal(typeof scheduled, 'function');
  const first = scheduler.trigger();
  const overlapping = scheduler.trigger();
  await Promise.resolve();
  assert.equal(runs, 1);
  release();
  await Promise.all([first, overlapping]);
  assert.equal(runs, 1);
  assert.equal(typeof scheduled, 'function');
  scheduler.stop();
  assert.equal(scheduled, null);
});

test('local changes remain persistently dirty while automatic sync is disabled', async () => {
  const values = new Map([
    ['study_sync_config', JSON.stringify({ enabled: true, autoSync: false })],
    ['study_todos_v2', JSON.stringify([{ id: 1, text: 'local edit' }])]
  ]);
  const localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  const window = { SyncPolicy: policy };
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'sync.js'), 'utf8');
  vm.runInNewContext(code, {
    window,
    localStorage,
    setTimeout() { return 1; },
    clearTimeout() {},
    console: { log() {}, warn() {}, error() {} }
  });

  window.Sync.init();
  window.Sync.onLocalChange('study_todos_v2');
  const status = await window.Sync.getStatus();
  assert.equal(status.pendingCount, 1);
  assert.deepEqual(JSON.parse(values.get('study_sync_dirty_v1')), { study_todos_v2: true });
});

test('a thrown upload error keeps local data dirty for a later retry', async () => {
  const values = new Map([
    ['study_sync_config', JSON.stringify({ enabled: true, autoSync: false })],
    ['study_todos_v2', JSON.stringify([{ id: 1, text: 'must survive' }])]
  ]);
  const localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  const query = () => ({
    select() { return this; },
    eq() { return this; },
    in() { return this; },
    then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject); }
  });
  const client = {
    auth: { getSession: () => ({ data: { session: { user: { id: 'u1' } } } }) },
    from() {
      const builder = query();
      builder.upsert = () => { throw new Error('offline'); };
      return builder;
    }
  };
  const window = { SyncPolicy: policy };
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'sync.js'), 'utf8');
  vm.runInNewContext(code, {
    window,
    localStorage,
    getSupabaseClient: () => client,
    setTimeout() { return 1; },
    clearTimeout() {},
    console: { log() {}, warn() {}, error() {} }
  });

  window.Sync.init();
  await window.Sync.getStatus();
  window.Sync.onLocalChange('study_todos_v2');
  const status = await window.Sync.manualSync();
  assert.equal(status.pendingCount, 1);
  assert.match(status.lastError, /offline/);
  assert.deepEqual(JSON.parse(values.get('study_sync_dirty_v1')), { study_todos_v2: true });
});
