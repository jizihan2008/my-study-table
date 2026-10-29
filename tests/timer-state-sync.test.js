'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const policy = require('../js/sync-policy');
const source = fs.readFileSync(require.resolve('../js/sync.js'), 'utf8');
const LIVE = 'study_timer_live_state';

function device(rows, timerStateSync = true) {
  const values = new Map([['study_sync_config', JSON.stringify({ enabled: true, autoSync: false, timerStateSync })]]);
  const calls = { today: 0, timer: 0, float: 0, states: [] };
  const localStorage = {
    getItem: k => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k)
  };
  const client = {
    auth: { getSession: () => ({ data: { session: { user: { id: 'test' } } } }) },
    from() {
      const filters = [];
      const q = {
        select() { return this; },
        eq(k, v) { if (k === 'key') filters.push(r => r.key === v); return this; },
        in(k, v) { filters.push(r => v.includes(r[k])); return this; },
        gte() { return this; },
        maybeSingle() { return Promise.resolve({ data: rows.find(r => filters.every(f => f(r))), error: null }); },
        then(resolve, reject) { return Promise.resolve({ data: rows.filter(r => filters.every(f => f(r))), error: null }).then(resolve, reject); }
      };
      return q;
    }
  };
  const window = {
    SyncPolicy: policy,
    renderToday: () => calls.today++, renderTimer: () => calls.timer++, updateTimerFloat: () => calls.float++,
    applySyncedTimerState: s => calls.states.push(s)
  };
  vm.runInNewContext(source, {
    window, localStorage, getSupabaseClient: () => client,
    saveData: (k, v) => { localStorage.setItem(k, JSON.stringify(v)); window.Sync.onLocalChange(k); return true; },
    setTimeout: () => 1, clearTimeout() {}, console
  });
  window.Sync.init();
  return { sync: window.Sync, calls, values };
}
const row = (key, value, seq = 1) => ({ key, value, updated_at: `2026-10-29T00:00:0${seq}.000Z` });

test('remote records refresh Today, timer and float; unchanged reconciliation does not redraw', async () => {
  const d = device([row('study_timer_records', [{ id: 1, totalMs: 60000 }])]);
  await d.sync.manualSync();
  assert.equal(JSON.parse(d.values.get('study_timer_records'))[0].totalMs, 60000);
  assert.deepEqual([d.calls.today, d.calls.timer, d.calls.float], [1, 1, 1]);
  await d.sync.manualSync();
  assert.deepEqual([d.calls.today, d.calls.timer, d.calls.float], [1, 1, 1]);
});

test('opt-in persists, receives start then stop, and opt-out ignores newer cloud state', async () => {
  const rows = [row(LIVE, { running: true, elapsed: 0, sessionStart: Date.now() })];
  const d = device(rows, false);
  await d.sync.manualSync();
  assert.equal(d.calls.states.length, 0);
  assert.equal(d.sync.isSyncKey(LIVE), false);
  d.sync.setTimerStateSync(true);
  assert.equal((await d.sync.getStatus()).timerStateSync, true);
  assert.equal(JSON.parse(d.values.get('study_sync_config')).timerStateSync, true);
  await d.sync.manualSync();
  assert.equal(d.calls.states[0].running, true);
  rows[0] = row(LIVE, { running: false, elapsed: 0 }, 2);
  await d.sync.manualSync();
  assert.equal(d.calls.states[1].running, false);
  d.sync.setTimerStateSync(false);
  rows[0] = row(LIVE, { running: true, elapsed: 0, sessionStart: Date.now() }, 3);
  await d.sync.manualSync();
  assert.equal(d.calls.states.length, 2);
  assert.equal(d.sync.isSyncKey('study_timer_records'), true);
});

test('resolving a records conflict with cloud data refreshes both pages immediately', async () => {
  const d = device([row('study_timer_records', [{ id: 2 }])]);
  d.values.set('study_timer_records', JSON.stringify([{ id: 1 }]));
  d.values.set('study_sync_pending_conflicts_v1', JSON.stringify({ study_timer_records: { key: 'study_timer_records' } }));
  const result = await d.sync.resolveConflict('study_timer_records', 'remote');
  assert.equal(result.ok, true);
  assert.equal(d.calls.timer, 1);
  assert.equal(d.calls.today, 1);
});
