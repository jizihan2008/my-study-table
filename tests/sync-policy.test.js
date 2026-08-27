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

test('multiple ordinary dirty keys are written in one batch', async () => {
  const values = new Map([
    ['study_sync_config', JSON.stringify({ enabled: true, autoSync: false })],
    ['study_todos_v2', JSON.stringify([{ id: 1, text: 'todo' }])],
    ['study_calendar_events', JSON.stringify([{ id: 2, title: 'event' }])]
  ]);
  const localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  let upsertCalls = 0;
  let uploadedRows = [];
  const client = {
    auth: { getSession: () => ({ data: { session: { user: { id: 'u1' } } } }) },
    from() {
      const builder = {
        upsert(rows) { upsertCalls++; uploadedRows = rows; return this; },
        select() { return this; }, eq() { return this; }, in() { return this; },
        then(resolve, reject) {
          const data = uploadedRows.map((row, index) => ({ key: row.key, updated_at: `2026-08-26T08:00:0${index}.000Z` }));
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        }
      };
      return builder;
    }
  };
  const window = { __MST_TEST__: true, SyncPolicy: policy };
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'sync.js'), 'utf8');
  vm.runInNewContext(code, {
    window, localStorage, getSupabaseClient: () => client,
    setTimeout() { return 1; }, clearTimeout() {},
    console: { log() {}, warn() {}, error() {} }
  });

  window.Sync.init();
  await window.Sync.getStatus();
  const status = await window.Sync.uploadAll();
  assert.equal(upsertCalls, 1);
  assert.equal(uploadedRows.length, 2);
  assert.equal(status.pendingCount, 0);
  assert.equal(window.Sync.__test.isOwnRealtimeChange('study_todos_v2', '2026-08-26T08:00:00.000Z'), true);
});

test('pending conflicts survive reload and are exposed without opening a dialog', async () => {
  const pending = {
    study_notes_v2: {
      key: 'study_notes_v2',
      reason: 'both-changed',
      baseTimestamp: '2026-08-25T08:00:00.000Z',
      remoteTimestamp: '2026-08-25T08:05:00.000Z',
      detectedAt: '2026-08-25T08:06:00.000Z'
    }
  };
  const values = new Map([
    ['study_sync_config', JSON.stringify({ enabled: false, autoSync: false })],
    ['study_sync_pending_conflicts_v1', JSON.stringify(pending)]
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
  const conflicts = window.Sync.getPendingConflicts();
  const status = await window.Sync.getStatus();
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].key, 'study_notes_v2');
  assert.equal(conflicts[0].remoteTimestamp, '2026-08-25T08:05:00.000Z');
  assert.equal(status.pendingConflictCount, 1);
  assert.equal('document' in window, false);
});

test('choosing the cloud version resolves and records a pending conflict', async () => {
  const remoteValue = [{ id: 2, text: 'cloud copy' }];
  const values = new Map([
    ['study_sync_config', JSON.stringify({ enabled: true, autoSync: false })],
    ['study_notes_v2', JSON.stringify([{ id: 1, text: 'local copy' }])],
    ['study_sync_dirty_v1', JSON.stringify({ study_notes_v2: true })],
    ['study_sync_pending_conflicts_v1', JSON.stringify({
      study_notes_v2: {
        key: 'study_notes_v2',
        reason: 'both-changed',
        baseTimestamp: '2026-08-25T08:00:00.000Z',
        remoteTimestamp: '2026-08-25T08:05:00.000Z',
        detectedAt: '2026-08-25T08:06:00.000Z'
      }
    })]
  ]);
  const localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  const client = {
    auth: { getSession: () => ({ data: { session: { user: { id: 'u1' } } } }) },
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() {
          return Promise.resolve({
            data: { key: 'study_notes_v2', value: remoteValue, updated_at: '2026-08-25T08:05:00.000Z' },
            error: null
          });
        }
      };
    }
  };
  const window = { SyncPolicy: policy };
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'sync.js'), 'utf8');
  vm.runInNewContext(code, {
    window,
    localStorage,
    getSupabaseClient: () => client,
    saveData: (key, value) => localStorage.setItem(key, JSON.stringify(value)),
    setTimeout() { return 1; },
    clearTimeout() {},
    console: { log() {}, warn() {}, error() {} }
  });

  window.Sync.init();
  const result = await window.Sync.resolveConflict('study_notes_v2', 'remote');
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(values.get('study_notes_v2')), remoteValue);
  assert.equal(window.Sync.getPendingConflicts().length, 0);
  assert.equal(JSON.parse(values.get('study_sync_conflict_history'))[0].choice, 'remote');
});
