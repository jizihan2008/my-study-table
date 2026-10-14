// IndexedDB is authoritative for business data. Legacy synchronous readers use
// a hydrated memory view, never a second full copy in native localStorage.
(function createStudyData(global) {
  'use strict';

  const DB_NAME = 'my-study-table-data';
  const DB_VERSION = 1;
  const STORE = 'records';
  const META_KEY = '__study_data_migrated_v1';
  const SECRET_KEYS = new Set(global.SecretVault ? global.SecretVault.keys : []);
  // 计时器是实时会话状态，localStorage 是唯一存档。旧快照不能在清零后补回。
  const LOCAL_ONLY_KEYS = new Set(['study_timer_state']);
  let dbPromise = null;
  let lastError = '';
  let initialization = null;
  let ready = false;
  const nativeStorage = global.localStorage;
  const cache = new Map();
  const committed = new Map();
  const managed = new Set([
    'study_notes_v2', 'study_notes', 'study_notes_folders', 'study_todos_v2', 'study_todos',
    'study_ai_convs', 'study_ai_memory', 'study_ai_drafts', 'study_ai_skills_v1',
    'study_timer_records', 'study_habits', 'study_habits_v1', 'study_taskline_v1',
    'study_books_v1', 'study_books_meta', 'study_bk_explain_logs_v1', 'study_bk_quiz_state_v1',
    'study_calendar_events', 'study_stats', 'study_longterm_goals', 'study_quick_access',
    'study_translation_history_v1', 'study_translation_cet4_progress_v1', 'study_translation_cet6_progress_v1',
    'study_checkin', 'study_today_focus', 'study_todo_queue', 'study_links_v3', 'study_automations',
    'study_todo_completed_log', 'study_backups', 'study_ai_usage_v1', 'study_ai_usage_v2'
  ]);
  const failures = new Map();
  const pending = new Map();
  let queue = Promise.resolve();
  function isManaged(key, raw = '') {
    return !SECRET_KEYS.has(key) && !LOCAL_ONLY_KEYS.has(key) && key !== META_KEY &&
      (managed.has(key) || /^study_(sync_|.*_(archive|trash)$)/.test(key) || raw.length > 65536);
  }
  function reportFailure(key, error) {
    failures.set(key, error);
    lastError = error.message || String(error);
    global.StudyPlatform?.events.emit('storage:failed', { key, error });
    const status = global.document?.getElementById('notesStatus');
    if (key === 'study_notes_v2' && status) status.textContent = '保存失败，内容仍保留在当前页：' + lastError;
    console.error('[IndexedDB] 保存失败 (' + key + '):', error);
  }
  function enqueue(key, raw) {
    managed.add(key);
    if (raw === null) cache.delete(key); else cache.set(key, raw);
    // A failed commit left the previous durable value intact. Restoring that
    // exact snapshot needs no new transaction (which may fail for the same reason).
    if (!pending.has(key) && (committed.get(key) ?? null) === raw) {
      failures.delete(key);
      lastError = failures.size ? String([...failures.values()][0].message) : '';
      global.StudyPlatform?.events.emit('storage:recovered', { key });
      return;
    }
    pending.set(key, (pending.get(key) || 0) + 1);
    queue = queue.then(async () => {
      try {
        if (raw === null) await remove(key); else await put(key, raw, { backend: 'indexeddb' });
        if (raw === null) committed.delete(key); else committed.set(key, raw);
        try { nativeStorage.removeItem(key); } catch (error) { console.warn('[IndexedDB] 旧副本清理失败:', error); }
        failures.delete(key);
        lastError = failures.size ? String([...failures.values()][0].message) : '';
        global.StudyPlatform?.events.emit('storage:committed', { key });
      } catch (error) { reportFailure(key, error); }
      finally {
        const count = pending.get(key) - 1;
        if (count) pending.set(key, count); else pending.delete(key);
      }
    });
  }
  async function flush(keys) {
    // Capture all writes queued by this operation, not later unrelated edits.
    await queue;
    const wanted = keys ? new Set(keys) : null;
    for (const [key, error] of failures) if (!wanted || wanted.has(key)) throw error;
    return true;
  }
  function installMemoryStorage() {
    const keys = () => {
      const result = new Set(cache.keys());
      for (let i = 0; i < nativeStorage.length; i++) {
        const key = nativeStorage.key(i);
        if (key && !managed.has(key)) result.add(key);
      }
      return [...result];
    };
    const methods = {
      getItem(key) { key = String(key); return managed.has(key) ? cache.get(key) ?? null : nativeStorage.getItem(key); },
      setItem(key, value) {
        key = String(key); const raw = String(value);
        if (isManaged(key, raw)) {
          if (cache.get(key) !== raw || failures.has(key)) enqueue(key, raw);
        } else {
          if (nativeStorage.getItem(key) === raw) return;
          try { nativeStorage.setItem(key, raw); }
          catch (error) {
            // A full small-settings store must not break rendering after a note
            // commit. Promote non-secret settings safely when native quota fills.
            if (!SECRET_KEYS.has(key) && !LOCAL_ONLY_KEYS.has(key) &&
              (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error.code === 22 || error.code === 1014)) enqueue(key, raw);
            else throw error;
          }
        }
      },
      removeItem(key) {
        key = String(key);
        if (managed.has(key)) enqueue(key, null); else nativeStorage.removeItem(key);
      },
      clear() { for (const key of keys()) methods.removeItem(key); },
      key(index) { return keys()[Number(index)] ?? null; }
    };
    const facade = new Proxy(methods, {
      get(target, key) { return key === 'length' ? keys().length : key in target ? target[key] : typeof key === 'string' ? methods.getItem(key) : undefined; },
      set(target, key, value) { methods.setItem(key, value); return true; },
      deleteProperty(target, key) { methods.removeItem(key); return true; },
      ownKeys: keys,
      getOwnPropertyDescriptor(target, key) { return methods.getItem(key) === null ? undefined : { configurable: true, enumerable: true, value: methods.getItem(key), writable: true }; }
    });
    Object.defineProperty(global, 'localStorage', { configurable: true, value: facade });
  }

  function hashText(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!global.indexedDB) return reject(new Error('IndexedDB 不可用'));
      const request = global.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('updatedAt', 'updatedAt');
          store.createIndex('deletedAt', 'deletedAt');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB 打开失败'));
    }).catch(error => {
      lastError = error.message;
      dbPromise = null;
      throw error;
    });
    return dbPromise;
  }

  async function withStore(mode, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const store = transaction.objectStore(STORE);
      let value;
      try { value = operation(store); } catch (error) { try { transaction.abort(); } catch (_) {} reject(error); return; }
      transaction.oncomplete = () => resolve(value && typeof value === 'object' && 'result' in value ? value.result : value);
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 事务失败'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB 事务已中止'));
    });
  }

  async function getRecord(key) {
    return withStore('readonly', store => store.get(String(key)));
  }

  async function put(key, rawValue, options = {}) {
    const safeKey = String(key || '');
    if (!safeKey || SECRET_KEYS.has(safeKey) || LOCAL_ONLY_KEYS.has(safeKey)) return { ok: false, skipped: true };
    const raw = String(rawValue == null ? '' : rawValue);
    const previous = await getRecord(safeKey).catch(() => null);
    const record = {
      key: safeKey,
      value: raw,
      schemaVersion: 1,
      revision: Math.max(0, Number(previous && previous.revision) || 0) + 1,
      contentHash: hashText(raw),
      updatedAt: options.updatedAt || new Date().toISOString(),
      deletedAt: null
    };
    if (options.backend || previous?.backend) record.backend = options.backend || previous.backend;
    await withStore('readwrite', store => store.put(record));
    return { ok: true, record };
  }

  async function remove(key) {
    const safeKey = String(key || '');
    if (!safeKey || SECRET_KEYS.has(safeKey)) return { ok: false, skipped: true };
    const previous = await getRecord(safeKey).catch(() => null);
    const now = new Date().toISOString();
    const record = {
      key: safeKey,
      value: null,
      schemaVersion: 1,
      revision: Math.max(0, Number(previous && previous.revision) || 0) + 1,
      contentHash: '',
      updatedAt: now,
      deletedAt: now
    };
    if (previous?.backend) record.backend = previous.backend;
    await withStore('readwrite', store => store.put(record));
    return { ok: true, record };
  }

  async function list() {
    return withStore('readonly', store => store.getAll());
  }

  async function migrateAndHydrate() {
    await open();
    // 清除旧版本迁移过来的会话快照；不改动 localStorage 中真实的当前计时。
    await withStore('readwrite', store => {
      for (const key of LOCAL_ONLY_KEYS) store.delete(key);
    });
    const records = await list();
    const byKey = new Map(records.map(record => [record.key, record]));
    const changed = [];
    let restored = 0;
    for (const record of records) if (record.backend === 'indexeddb' || isManaged(record.key, record.value || '')) managed.add(record.key);
    for (let index = 0; index < nativeStorage.length; index++) {
      const key = nativeStorage.key(index);
      if (!key || key === META_KEY || SECRET_KEYS.has(key) || LOCAL_ONLY_KEYS.has(key)) continue;
      const raw = nativeStorage.getItem(key);
      if (raw === null) continue;
      const existing = byKey.get(key);
      // Once migrated, stale copies left by an interrupted cleanup must never
      // overwrite the committed IndexedDB value (or resurrect a tombstone).
      if (existing?.backend === 'indexeddb') continue;
      if (isManaged(key, raw)) {
        managed.add(key);
        changed.push({ key, value: raw });
      }
    }
    // One transaction: old native values are removed only after commit.
    await withStore('readwrite', store => {
      const byKey = new Map(records.map(record => [record.key, record]));
      for (const entry of changed) store.put({ key: entry.key, value: entry.value, backend: 'indexeddb', schemaVersion: 1,
        revision: (Number(byKey.get(entry.key)?.revision) || 0) + 1, contentHash: hashText(entry.value), updatedAt: new Date().toISOString(), deletedAt: null });
      for (const record of records) if (managed.has(record.key) && record.backend !== 'indexeddb' && !changed.some(entry => entry.key === record.key)) store.put({ ...record, backend: 'indexeddb' });
    });
    const hydrated = await list();
    for (const record of hydrated) {
      if (!managed.has(record.key) || SECRET_KEYS.has(record.key) || LOCAL_ONLY_KEYS.has(record.key)) continue;
      if (!record.deletedAt) { cache.set(record.key, record.value); committed.set(record.key, record.value); }
      try { nativeStorage.removeItem(record.key); } catch (error) { console.warn('[IndexedDB] 旧副本清理失败:', error); }
    }
    installMemoryStorage();
    ready = true;
    return { ok: true, copied: changed.length, restored, records: hydrated.length };
  }
  function initialize() {
    if (!initialization) initialization = migrateAndHydrate().catch(error => { lastError = error.message; initialization = null; throw error; });
    return initialization;
  }

  global.StudyData = Object.freeze({
    DB_NAME,
    get: async key => {
      const record = await getRecord(key);
      return record && !record.deletedAt ? record.value : null;
    },
    getRecord,
    hashText,
    initialize,
    flush,
    retryFailed: async () => {
      for (const key of failures.keys()) enqueue(key, cache.get(key) ?? null);
      return flush();
    },
    isManaged: key => ready && managed.has(String(key)),
    nativeStorage,
    list,
    put: (key, value, options) => put(key, value, options).catch(error => {
      lastError = error.message;
      return { ok: false, error };
    }),
    remove: key => remove(key).catch(error => ({ ok: false, error })),
    status: () => ({ database: DB_NAME, version: DB_VERSION, ready, pending: pending.size, lastError })
  });
  if (global.StudyPlatform) global.StudyPlatform.defineModule('data', global.StudyData);
})(window);
