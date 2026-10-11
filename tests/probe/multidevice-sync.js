'use strict';

// Two isolated sync.js runtimes sharing one deterministic, in-memory user_data table.
// Run with: node tests/probe/multidevice-sync.js
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../../js/sync-policy');

const source = fs.readFileSync(path.join(__dirname, '../../js/sync.js'), 'utf8');
const collectionSource = fs.readFileSync(path.join(__dirname, '../../js/sync-collections.js'), 'utf8');
const KEY = 'study_todos_v2';
const base = [{ id: 1, text: 'base' }];
const copy = value => JSON.parse(JSON.stringify(value));
let failed = 0;
function check(name, actual, safe, details) {
  const ok = safe();
  if (!ok) failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + ': ' + JSON.stringify({ actual, ...details }));
}

function cloud() {
  const rows = new Map();
  let sequence = 0;
  let beforeVersionRead = null;
  let beforeOrderRead = null;
  function client(device) {
    return {
      auth: { getSession: () => ({ data: { session: { user: { id: device.userId } } } }) },
      from(table) {
        if (table !== 'user_data') throw new Error('unexpected table: ' + table);
        const q = { operation: 'read', fields: '*', filters: [], input: null };
        const builder = {
          select(fields) { q.fields = fields; return this; },
          eq(field, value) {
            if (field === 'key' && String(value).startsWith('mst:order:v1:')) q.isOrderQuery = true;
            q.filters.push(row => row[field] === value); return this;
          },
          in(field, values) { q.filters.push(row => values.includes(row[field])); return this; },
          like(field, pattern) {
            q.isPrefixQuery = true;
            const prefix = pattern.endsWith('%') ? pattern.slice(0, -1) : pattern;
            q.filters.push(row => String(row[field]).startsWith(prefix));
            return this;
          },
          gte(field, value) { q.filters.push(row => row[field] >= value); return this; },
          update(input) { q.operation = 'update'; q.input = input; return this; },
          insert(input) { q.operation = 'insert'; q.input = input; return this; },
          upsert(input) { q.operation = 'write'; q.input = Array.isArray(input) ? input : [input]; return this; },
          single() { return run(true); },
          maybeSingle() { return run(true); },
          then(resolve, reject) { return run(false).then(resolve, reject); }
        };
        async function run(single) {
          if (q.operation === 'read') {
            const result = [...rows.values()].filter(row => q.filters.every(filter => filter(row)));
            const data = result.map(row => pick(row, q.fields));
            if (q.isPrefixQuery) device.prefixReads = (device.prefixReads || 0) + 1;
            if (device.pauseCollectionRead && q.isPrefixQuery) {
              device.pauseCollectionRead = false;
              if (beforeVersionRead) await beforeVersionRead();
            }
            if (device.pauseOrderRead && q.isOrderQuery) {
              device.pauseOrderRead = false;
              if (beforeOrderRead) await beforeOrderRead();
            }
            return { data: single ? (data[0] || null) : data, error: null };
          }
          if (q.operation === 'update') {
            const existing = [...rows.values()].find(row => q.filters.every(filter => filter(row)));
            if (!existing) return { data: single ? null : [], error: null };
            existing.value = copy(q.input.value);
            existing.updated_at = new Date(Date.UTC(2026, 8, 23, 0, 0, ++sequence)).toISOString();
            return { data: single ? pick(existing, q.fields) : [pick(existing, q.fields)], error: null };
          }
          if (q.operation === 'insert') {
            const input = q.input;
            if (rows.has(input.user_id + '/' + input.key)) {
              return { data: null, error: { code: '23505', message: 'duplicate key' } };
            }
            q.input = [input];
          }
          device.writeRequests = (device.writeRequests || 0) + 1;
          const written = q.input.map(input => {
            const row = { user_id: input.user_id, key: input.key, value: copy(input.value),
              updated_at: new Date(Date.UTC(2026, 8, 23, 0, 0, ++sequence)).toISOString() };
            rows.set(row.user_id + '/' + row.key, row);
            return pick(row, q.fields);
          });
          return { data: single ? written[0] : written, error: null };
        }
        return builder;
      }
    };
  }
  return {
    rows, client,
    seedLegacy(userId, key, value) {
      rows.set(userId + '/' + key, { user_id: userId, key, value: copy(value),
        updated_at: new Date(Date.UTC(2026, 8, 23, 0, 0, ++sequence)).toISOString() });
    },
    onVersionRead(fn) { beforeVersionRead = fn; },
    onOrderRead(fn) { beforeOrderRead = fn; },
    value(userId, collection = KEY) {
      const prefix = 'mst:item:v1:' + encodeURIComponent(collection) + ':';
      const records = [...rows.values()].filter(row => row.user_id === userId && row.key.startsWith(prefix));
      if (!records.length) return null;
      return records.filter(row => row.value && !row.value.deleted).map(row => row.value)
        .sort((a, b) => a.index - b.index).map(value => copy(value.item));
    },
    raw(userId, key) {
      const row = rows.get(userId + '/' + key);
      return row ? copy(row.value) : null;
    }
  };
}

function pick(row, fields) {
  if (fields === '*') return copy(row);
  return Object.fromEntries(fields.split(',').map(field => [field, copy(row[field])]));
}

function device(name, backend, userId = 'u1') {
  const state = { name, userId, pauseCollectionRead: false, pauseOrderRead: false, prefixReads: 0, writeRequests: 0 };
  const values = new Map([['study_sync_config', JSON.stringify({ enabled: true, autoSync: false })]]);
  const localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  const window = { SyncPolicy: policy };
  const context = {
    window, localStorage, getSupabaseClient: () => backend.client(state),
    saveData: (key, value) => {
      localStorage.setItem(key, JSON.stringify(value));
      if (window.Sync) window.Sync.onLocalChange(key);
      return true;
    },
    setTimeout() { return 1; }, clearTimeout() {},
    console: { log() {}, warn() {}, error() {} }
  };
  vm.runInNewContext(collectionSource, context);
  vm.runInNewContext(source, context);
  Object.assign(context, {
    document: { getElementById: () => null, querySelector: () => null },
    confirm: () => true,
    activeNoteId: null, expandedTodoIds: new Set(), saveExpandedTodoIds() {},
    renderNotes() {}, renderTodos() {}, renderLinks() {}, renderHabits() {},
    saveHabits() { return context.saveData('study_habits_v2', context.habits); }
  });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../js/trash.js'), 'utf8'), context);
  window.Sync.init();
  return {
    state, sync: window.Sync,
    get() { return JSON.parse(localStorage.getItem(KEY)); },
    getKey(key) { return JSON.parse(localStorage.getItem(key)); },
    setKeyRaw(key, value) { localStorage.setItem(key, JSON.stringify(value)); },
    editKey(key, value) { localStorage.setItem(key, JSON.stringify(value)); window.Sync.onLocalChange(key); },
    edit(value) { localStorage.setItem(KEY, JSON.stringify(value)); window.Sync.onLocalChange(KEY); },
    archiveAction(module, sourceKey, action, id) {
      context[module] = JSON.parse(localStorage.getItem(sourceKey)) || [];
      vm.runInNewContext(action === 'archive'
        ? `moveToArchive('${module}', ${module}.find(item => item.id === ${id}))`
        : action === 'delete' ? `permanentlyDeleteFromArchive('${module}', ${id})`
          : `restoreFromArchive('${module}', ${id})`, context);
    },
    async syncNow(moduleId) { await window.Sync.getStatus(); return window.Sync.manualSync({ moduleId }); },
    async seed(value) { this.edit(value); await window.Sync.getStatus(); await window.Sync.uploadAll(); }
  };
}

async function run() {
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    const skillKey = 'study_ai_skills_v1', noteKey = 'study_notes_v2';
    a.editKey(skillKey, [{ id: 'a', name: 'one', content: 'first' }]);
    a.editKey(noteKey, [{ id: 1, title: 'base note' }]);
    await a.sync.uploadAll();
    await b.syncNow();
    a.editKey(skillKey, [{ id: 'a', name: 'one', content: 'first' }, { id: 'b', name: 'two', content: 'second' }]);
    a.editKey(noteKey, [{ id: 1, title: 'local unsent note' }]);
    await a.sync.uploadAll({ moduleId: 'skills' });
    b.edit([{ id: 1, text: 'unsent todo' }]);
    const cfgBefore = b.getKey('study_sync_config');
    await b.syncNow('skills');
    const cfgAfter = b.getKey('study_sync_config');
    const actual = { skills: b.getKey(skillKey), cloudNotes: db.value('u1', noteKey), bTodoCloud: db.value('u1'),
      pendingA: (await a.sync.getStatus()).pendingCount, pendingB: (await b.sync.getStatus()).pendingCount };
    check('module-skills-sync-does-not-upload-other-dirty-modules', actual,
      () => actual.skills.length === 2 && actual.cloudNotes[0].title === 'base note' && !actual.bTodoCloud && actual.pendingA > 0 && actual.pendingB > 0);
    check('module-sync-preserves-global-reconcile-cursor', cfgAfter,
      () => cfgBefore.syncCursor === cfgAfter.syncCursor && cfgBefore.lastFullReconcile === cfgAfter.lastFullReconcile);
    await a.sync.uploadAll({ moduleId: 'notes' });
    await b.syncNow('notes');
    const afterNotesStatus = await b.sync.getStatus();
    check('module-notes-sync-processes-records-without-other-pending-writes', b.getKey(noteKey),
      () => b.getKey(noteKey)[0].title === 'local unsent note' && !db.value('u1') && afterNotesStatus.pendingCount > 0);
    const dirty = b.getKey('study_sync_dirty_v1') || {};
    check('module-notes-sync-preserves-pending-todo-record', dirty,
      () => (b.get() || [])[0].text === 'unsent todo' && !db.value('u1'));
  }
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    const key = 'study_ai_skills_v1';
    a.editKey(key, [{ id: '1', name: 'base', content: 'base' }]);
    await a.sync.uploadAll();
    await b.syncNow();
    a.editKey(key, [{ id: '1', name: 'A', content: 'A edit' }]);
    b.editKey(key, [{ id: '1', name: 'B', content: 'B edit' }]);
    await a.sync.uploadAll({ moduleId: 'skills' });
    const status = await b.syncNow('skills');
    check('module-manual-sync-retains-real-conflicts', status,
      () => status.pendingConflictCount === 1 && db.raw('u1', key)[0].content === 'A edit' && b.getKey(key)[0].content === 'B edit');
    await b.sync.uploadAll({ moduleId: 'skills' });
    check('module-upload-all-applies-selected-local-choice', b.sync.getPendingConflicts(),
      () => b.sync.getPendingConflicts().length === 0 && db.raw('u1', key)[0].content === 'B edit');
  }
  for (const existingConflict of [false, true]) {
    const db = cloud(), a = device('A', db), b = device('B', db);
    await a.seed(base);
    await b.syncNow();
    a.edit([{ id: 1, text: 'same edit', nested: { x: 1, y: 2 } }]);
    b.edit([{ nested: { y: 2, x: 1 }, text: 'same edit', id: 1 }]);
    await a.syncNow();
    if (existingConflict) {
      const key = 'mst:item:v1:' + encodeURIComponent(KEY) + ':1';
      b.setKeyRaw('study_sync_collection_conflicts_v1', { [key]: { key, collection: KEY, reason: 'both-changed' } });
    }
    await b.syncNow();
    const actual = { local: b.get(), cloud: db.value('u1'), conflicts: b.sync.getPendingConflicts(), status: await b.sync.getStatus() };
    check('same-record-content-' + (existingConflict ? 'clears-pending-conflict' : 'avoids-concurrent-conflict'), actual,
      () => actual.local[0].text === 'same edit' && actual.cloud[0].text === 'same edit' && actual.conflicts.length === 0 && actual.status.pendingCount === 0);
  }
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    await a.seed([{ id: 1, text: 'one' }, { id: 2, text: 'two' }]);
    await b.syncNow();
    a.edit([...a.get(), { id: 3, text: 'added' }]);
    await a.syncNow();
    const key = 'mst:order:v1:' + encodeURIComponent(KEY);
    b.setKeyRaw('study_sync_collection_conflicts_v1', { [key]: {
      key, collection: KEY, label: '待办：排序', reason: 'both-changed-order'
    } });
    await b.syncNow();
    const actual = { local: b.get(), conflicts: b.sync.getPendingConflicts() };
    check('old-membership-order-conflict-clears-on-sync', actual,
      () => actual.local.length === 3 && actual.conflicts.length === 0);
  }
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    await a.seed([{ id: 1, text: 'one' }, { id: 2, text: 'two' }, { id: 3, text: 'three' }]);
    await b.syncNow();
    a.edit([a.get()[2], a.get()[0], a.get()[1]]);
    // 同样的排序被另一台设备重写，只更新时间戳，没有改变相对次序。
    db.seedLegacy('u1', 'mst:order:v1:' + encodeURIComponent(KEY), ['1', '2', '3']);
    await a.syncNow();
    await b.syncNow();
    const actual = { other: b.get().map(x => x.id), conflicts: a.sync.getPendingConflicts() };
    check('order-timestamp-only-change-is-not-a-conflict', actual,
      () => actual.other.join(',') === '3,1,2' && actual.conflicts.length === 0);
  }
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    await a.seed([{ id: 1, text: 'one' }, { id: 2, text: 'two' }]);
    await b.syncNow();
    a.edit([...a.get(), { id: 3, text: 'A added' }]);
    b.edit([...b.get(), { id: 4, text: 'B added' }]);
    a.state.pauseOrderRead = true;
    db.onOrderRead(async () => { await b.syncNow(); });
    await a.syncNow();
    await a.syncNow();
    await b.syncNow();
    const actual = { a: a.get(), b: b.get(), conflicts: a.sync.getPendingConflicts() };
    check('order-upload-race-retries-without-false-conflict', actual,
      () => actual.a.length === 4 && actual.b.length === 4 && actual.conflicts.length === 0 &&
        actual.a.map(x => x.id).join(',') === actual.b.map(x => x.id).join(','));
  }
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    await a.seed([{ id: 1, text: 'one' }, { id: 2, text: 'two' }]);
    await b.syncNow();
    a.edit([...a.get(), { id: 3, text: 'A added' }]);
    b.edit([{ id: 4, text: 'B added' }, ...b.get()]);
    await a.syncNow();
    await b.syncNow();
    await a.syncNow();
    const actual = { a: a.get(), b: b.get(), conflicts: b.sync.getPendingConflicts() };
    check('concurrent-inserts-are-not-order-conflicts', actual,
      () => actual.conflicts.length === 0 && actual.a.length === 4 && actual.b.length === 4);
  }
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    await a.seed([{ id: 1, text: 'one' }, { id: 2, text: 'two' }, { id: 3, text: 'three' }]);
    await b.syncNow();
    a.edit(a.get().filter(item => item.id !== 1));
    b.edit(b.get().filter(item => item.id !== 3));
    await a.syncNow();
    await b.syncNow();
    await a.syncNow();
    const actual = { a: a.get(), b: b.get(), conflicts: b.sync.getPendingConflicts() };
    check('concurrent-deletes-are-not-order-conflicts', actual,
      () => actual.conflicts.length === 0 && actual.a.map(x => x.id).join(',') === '2' && actual.b.map(x => x.id).join(',') === '2');
  }
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    await a.seed([{ id: 1, text: 'one' }, { id: 2, text: 'two' }, { id: 3, text: 'three' }]);
    await b.syncNow();
    b.edit(b.get().map(item => item.id === 2 ? { ...item, text: 'edited only' } : item));
    a.edit([a.get()[2], a.get()[0], a.get()[1]]);
    await a.syncNow();
    // B 上传文字时仍携带旧 index=1，然后才接收 A 的排序。
    await b.syncNow();
    await a.syncNow();
    const actual = { a: a.get().map(x => x.id), b: b.get().map(x => x.id), conflicts: a.sync.getPendingConflicts() };
    check('remote-content-edit-does-not-reorder-records', actual,
      () => actual.a.join(',') === '3,1,2' && actual.b.join(',') === '3,1,2' && actual.conflicts.length === 0);
  }
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    await a.seed([{ id: 1, text: 'one' }, { id: 2, text: 'two' }, { id: 3, text: 'three' }]);
    await b.syncNow();
    a.edit([{ id: 2, text: 'two' }, { id: 1, text: 'one' }, { id: 3, text: 'three' }]);
    b.edit([{ id: 3, text: 'three' }, { id: 1, text: 'one' }, { id: 2, text: 'two' }]);
    await a.syncNow();
    await b.syncNow();
    const conflict = b.sync.getPendingConflicts().find(item => item.reason === 'both-changed-order');
    check('concurrent-order-conflict', { local: b.get().map(x => x.id), conflict },
      () => b.get().map(x => x.id).join(',') === '3,1,2' && !!conflict);
    const resolved = conflict && await b.sync.resolveConflict(conflict.key, 'remote');
    check('order-conflict-resolution', { resolved, local: b.get().map(x => x.id) },
      () => resolved && resolved.ok && b.get().map(x => x.id).join(',') === '2,1,3' &&
        b.sync.getPendingConflicts().length === 0);
  }
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    await a.seed([{ id: 1, text: 'one' }, { id: 2, text: 'two' }, { id: 3, text: 'three' }]);
    await b.syncNow();
    a.edit([{ id: 2, text: 'two' }, { id: 1, text: 'one' }, { id: 3, text: 'three' }]);
    b.edit([{ id: 3, text: 'three' }, { id: 1, text: 'one' }, { id: 2, text: 'two' }]);
    await a.syncNow();
    await b.syncNow();
    const conflict = b.sync.getPendingConflicts().find(item => item.reason === 'both-changed-order');
    const latest = db.raw('u1', conflict.key);
    db.seedLegacy('u1', conflict.key, latest.slice().reverse());
    const resolved = await b.sync.resolveConflict(conflict.key, 'local');
    const actual = { resolved, cloudOrder: db.raw('u1', conflict.key), pending: b.sync.getPendingConflicts() };
    check('stale-order-conflict-resolves-against-latest-remote-version', actual,
      () => resolved.ok && actual.cloudOrder.join(',') === '3,1,2' && actual.pending.length === 0);
  }
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    await a.seed([{ id: 1, text: 'one' }, { id: 2, text: 'two' }]);
    await b.syncNow();
    a.edit([{ id: 2, text: 'two' }, { id: 1, text: 'one' }]);
    await a.syncNow();
    await b.syncNow();
    const actual = { a: a.get().map(x => x.id), b: b.get().map(x => x.id) };
    check('record-order-sync', actual, () => actual.a.join(',') === '2,1' && actual.b.join(',') === '2,1');
  }
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    await a.seed([{ id: 1, text: 'one' }, { id: 2, text: 'two' }]);
    await b.syncNow();
    a.edit([{ id: 3, text: 'new' }, { id: 1, text: 'one' }, { id: 2, text: 'two' }]);
    b.edit([{ id: 1, text: 'B edit' }, { id: 2, text: 'two' }]);
    await a.syncNow();
    await b.syncNow();
    const actual = { b: b.get(), cloud: db.value('u1'), conflicts: b.sync.getPendingConflicts() };
    check('insert-and-edit-different-records', actual, () => actual.b.some(x => x.id === 3) &&
      actual.cloud.some(x => x.id === 1 && x.text === 'B edit') && actual.conflicts.length === 0);
  }
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    const key = 'study_notes_v2';
    a.editKey(key, [{ id: 1, title: 'first', content: 'base' },
      { id: 2, title: 'second', content: 'base' }]);
    await a.syncNow();
    await b.syncNow();
    a.editKey(key, [{ id: 1, title: 'first', content: 'A edit' },
      { id: 2, title: 'second', content: 'base' }]);
    b.editKey(key, [{ id: 1, title: 'first', content: 'base' },
      { id: 2, title: 'second', content: 'B edit' }]);
    await a.syncNow();
    await b.syncNow();
    await a.syncNow();
    const actual = { a: a.getKey(key), b: b.getKey(key), cloud: db.value('u1', key) };
    check('different-note-edits', actual, () => actual.a[0].content === 'A edit' &&
      actual.a[1].content === 'B edit' && actual.b[0].content === 'A edit' &&
      actual.b[1].content === 'B edit');
  }
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    await a.seed([{ id: 1, text: 'delete me' }, { id: 2, text: 'keep me' }]);
    await b.syncNow();
    a.edit([{ id: 2, text: 'keep me' }]);
    b.edit([{ id: 1, text: 'delete me' }, { id: 2, text: 'edited' }]);
    await a.syncNow();
    await b.syncNow();
    await a.syncNow();
    const actual = { a: a.get(), b: b.get(), conflicts: b.sync.getPendingConflicts().length };
    check('delete-one-edit-another', actual, () => actual.a.length === 1 && actual.b.length === 1 &&
      actual.a[0].id === 2 && actual.b[0].text === 'edited' && actual.conflicts === 0);
  }
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    await a.seed([{ id: 1, text: 'one' }, { id: 2, text: 'two' }]);
    await b.syncNow();
    a.edit([{ id: 1, text: 'A changed one' }, { id: 2, text: 'two' }]);
    b.edit([{ id: 1, text: 'one' }, { id: 2, text: 'B changed two' }]);
    await a.syncNow();
    await b.syncNow();
    await a.syncNow();
    const actual = { a: a.get(), b: b.get(), cloud: db.value('u1'), conflicts: b.sync.getPendingConflicts().length };
    check('different-record-edits', actual, () => actual.a[0].text === 'A changed one' &&
      actual.a[1].text === 'B changed two' && actual.b[0].text === 'A changed one' &&
      actual.b[1].text === 'B changed two' && actual.conflicts === 0);
  }
  {
    const db = cloud(), a = device('A', db);
    db.seedLegacy('u1', KEY, [{ id: 10, text: 'old cloud record' }]);
    await a.syncNow();
    const actual = { local: a.get(), itemRows: db.value('u1') };
    check('legacy-array-migration', actual, () => actual.local[0].text === 'old cloud record' &&
      actual.itemRows[0].text === 'old cloud record');
  }
  {
    const db = cloud(), a = device('A', db);
    db.seedLegacy('u1', KEY, [{ id: 10, text: 'old cloud record' }]);
    await a.syncNow();
    db.seedLegacy('u1', KEY, [{ id: 10, text: 'edited by old client' }]);
    await a.syncNow();
    const actual = { local: a.get(), cloud: db.value('u1'), conflicts: a.sync.getPendingConflicts() };
    check('old-client-edit-detected', actual, () => actual.local[0].text === 'old cloud record' &&
      actual.cloud[0].text === 'old cloud record' && actual.conflicts.some(c => c.reason === 'legacy-device-change'));
    const resolved = await a.sync.resolveConflict(actual.conflicts[0].key, 'remote');
    check('old-client-conflict-resolution', { resolved, local: a.get(), cloud: db.value('u1') },
      () => resolved.ok && a.get()[0].text === 'edited by old client' &&
        db.value('u1')[0].text === 'edited by old client');
  }
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    await a.seed(base);
    await b.syncNow();
    b.edit([{ id: 1, text: 'B edit' }]);
    await b.syncNow();
    await a.syncNow();
    const actual = { a: a.get(), b: b.get(), cloud: db.value('u1') };
    check('normal-roundtrip', actual, () => actual.a[0].text === 'B edit' &&
      actual.b[0].text === 'B edit' && actual.cloud[0].text === 'B edit');
  }
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    await a.seed(base);
    await b.syncNow();
    b.edit([{ id: 1, text: 'B offline edit' }]);
    a.edit([{ id: 1, text: 'A online edit' }]);
    await a.syncNow();
    await b.syncNow();
    const actual = { localB: b.get(), cloud: db.value('u1'), bConflicts: b.sync.getPendingConflicts().length };
    check('offline-conflict', actual, () => actual.localB[0].text === 'B offline edit' &&
      actual.cloud[0].text === 'A online edit' && actual.bConflicts === 1);
    const conflictKey = b.sync.getPendingConflicts()[0].key;
    const resolved = await b.sync.resolveConflict(conflictKey, 'remote');
    check('record-conflict-resolution', { resolved, localB: b.get() },
      () => resolved.ok && b.get()[0].text === 'A online edit' &&
        b.sync.getPendingConflicts().length === 0);
  }
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    await a.seed([{ id: 1, text: 'one' }, { id: 2, text: 'two' }]);
    await b.syncNow();
    a.edit([{ id: 1, text: 'A one' }, { id: 2, text: 'A two' }]);
    b.edit([{ id: 1, text: 'B one' }, { id: 2, text: 'B two' }]);
    await a.syncNow();
    await b.syncNow();
    const keys = b.sync.getPendingConflicts().filter(item => item.id).map(item => item.key);
    const readsBefore = b.state.prefixReads;
    const resolved = await b.sync.resolveConflicts(keys, 'remote');
    const actual = { resolved, local: b.get(), prefixReads: b.state.prefixReads - readsBefore };
    check('record-conflict-batch-single-read', actual, () => resolved.ok && resolved.resolved === 2 &&
      actual.local[0].text === 'A one' && actual.local[1].text === 'A two' && actual.prefixReads === 1 &&
      b.sync.getPendingConflicts().length === 0);
  }
  {
    const db = cloud(), a = device('A', db);
    const timers = [{ id: 'timer-1', duration: 60 }, { id: 'timer-2', duration: 120 }];
    const stale = {
      'mst:item:v1:study_timer_records:timer-1': {
        key: 'mst:item:v1:study_timer_records:timer-1', collection: 'study_timer_records', id: 'timer-1'
      },
      'mst:item:v1:study_timer_records:timer-2': {
        key: 'mst:item:v1:study_timer_records:timer-2', collection: 'study_timer_records', id: 'timer-2'
      }
    };
    a.setKeyRaw('study_timer_records', timers);
    a.setKeyRaw('study_sync_collection_conflicts_v1', stale);
    const keys = a.sync.getPendingConflicts().map(item => item.key);
    const resolved = await a.sync.resolveConflicts(keys, 'local');
    const actual = { resolved, cloud: db.raw('u1', 'study_timer_records'), pending: a.sync.getPendingConflicts() };
    check('legacy-timer-conflicts-migrate-as-one-group', actual, () => resolved.ok && resolved.resolved === 2 &&
      JSON.stringify(actual.cloud) === JSON.stringify(timers) && actual.pending.length === 0);
  }
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    await a.seed([{ id: 1, text: 'one' }, { id: 2, text: 'two' }]);
    await b.syncNow();
    a.edit([{ id: 1, text: 'A one' }, { id: 2, text: 'A two' }]);
    b.edit([{ id: 1, text: 'B one' }, { id: 2, text: 'B two' }]);
    await a.syncNow();
    await b.syncNow();
    const keys = b.sync.getPendingConflicts().filter(item => item.id).map(item => item.key);
    const writesBefore = b.state.writeRequests;
    const resolved = await b.sync.resolveConflicts(keys, 'local');
    const actual = { resolved, cloud: db.value('u1'), writeRequests: b.state.writeRequests - writesBefore };
    check('record-conflict-local-batch-single-write', actual, () => resolved.ok && resolved.resolved === 2 &&
      actual.cloud[0].text === 'B one' && actual.cloud[1].text === 'B two' && actual.writeRequests === 1 &&
      b.sync.getPendingConflicts().length === 0);
  }
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    await a.seed(base);
    await b.syncNow();
    a.edit([]);
    await a.syncNow();
    await b.syncNow();
    const actual = { local: a.get(), other: b.get(), cloud: db.value('u1') };
    check('clear-after-sync', actual, () => actual.local.length === 0 && actual.other.length === 0 && actual.cloud.length === 0,
      { expected: [] });
  }
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    await a.seed(base);
    await b.syncNow();
    a.edit([{ id: 1, text: 'A edit' }]);
    b.edit([{ id: 1, text: 'B edit' }]);
    a.state.pauseCollectionRead = true;
    db.onVersionRead(async () => { await b.syncNow(); });
    await a.syncNow();
    const actual = { cloud: db.value('u1'), aConflicts: a.sync.getPendingConflicts().length,
      bConflicts: b.sync.getPendingConflicts().length };
    check('concurrent-edit', actual, () => actual.cloud[0].text === 'B edit' && actual.aConflicts === 1,
      { expected: 'conflict, no overwrite' });
  }
  {
    const db = cloud(), a = device('A', db), b = device('B', db);
    const original = [{ id: 1, text: 'one' }, { id: 2, text: 'two' }, { id: 3, text: 'three' }];
    await a.seed(original);
    await b.syncNow();
    a.edit([{ id: 1, text: 'edited' }, { id: 2, text: 'two' }, { id: 3, text: 'three' }]);
    a.state.pauseOrderRead = true;
    db.onOrderRead(async () => {
      a.edit([{ id: 3, text: 'three' }, { id: 1, text: 'edited' }, { id: 2, text: 'two' }]);
    });
    await a.syncNow();
    const afterInflight = a.get().map(item => item.id);
    await a.syncNow();
    await b.syncNow();
    const actual = { afterInflight, cloudOrder: db.raw('u1', 'mst:order:v1:' + encodeURIComponent(KEY)),
      other: b.get().map(item => item.id) };
    check('inflight-local-reorder-does-not-snap-back', actual,
      () => actual.afterInflight.join(',') === '3,1,2' && actual.cloudOrder.join(',') === '3,1,2' &&
        actual.other.join(',') === '3,1,2');
  }
  {
    const db = cloud(), a = device('A', db, 'account-A');
    await a.seed(base);
    a.state.userId = 'account-B';
    await a.syncNow();
    const actual = { accountA: db.value('account-A'), accountB: db.value('account-B') };
    check('account-switch', actual, () => actual.accountA[0].text === 'base' && !actual.accountB,
      { expectedAccountB: null });
  }
  for (const [module, sourceKey] of [['todos', KEY], ['notes', 'study_notes_v2'],
    ['links', 'study_links_v3'], ['habits', 'study_habits_v2']]) {
    const db = cloud(), a = device('A', db), b = device('B', db);
    const archiveKey = 'study_' + module + '_archive';
    const items = [{ id: 101, text: 'root', title: 'root', name: 'root', type: 'folder' }];
    if (module === 'todos' || module === 'notes') items.push({ id: 102, parentId: 101, title: 'child', text: 'child' });
    a.editKey(sourceKey, items);
    await a.syncNow();
    await b.syncNow();
    a.archiveAction(module, sourceKey, 'archive', 101);
    await a.syncNow();
    await b.syncNow();
    check(module + '-archive-cross-device', b.getKey(archiveKey), () =>
      b.getKey(sourceKey).length === 0 && b.getKey(archiveKey).length === items.length &&
      b.getKey(archiveKey).every(item => item.archivedAt));
    b.archiveAction(module, sourceKey, 'restore', 101);
    await b.syncNow();
    await a.syncNow();
    check(module + '-archive-restore-cross-device', a.getKey(sourceKey), () =>
      a.getKey(sourceKey).length === items.length && a.getKey(archiveKey).length === 0 &&
      a.getKey(sourceKey).every(item => !item.archivedAt));
    // Old local-only archives must be discovered without a new edit notification.
    a.setKeyRaw(archiveKey, [{ id: 201, title: 'old local archive', archivedAt: '2026-10-01' }]);
    await a.syncNow();
    await b.syncNow();
    const oldArchiveUploaded = b.getKey(archiveKey).some(item => item.id === 201);
    a.archiveAction(module, sourceKey, 'delete', 201);
    await a.syncNow();
    await b.syncNow();
    check(module + '-legacy-archive-upload-and-delete', b.getKey(archiveKey), () =>
      oldArchiveUploaded && db.raw('u1', 'mst:item:v1:' + archiveKey + ':201').deleted && b.getKey(archiveKey).length === 0);
  }
  if (failed) process.exitCode = 1;
}

run().catch(error => { console.error(error); process.exitCode = 1; });
