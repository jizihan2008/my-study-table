// Versioned IndexedDB repository with a synchronous localStorage compatibility cache.
(function createStudyData(global) {
  'use strict';

  const DB_NAME = 'my-study-table-data';
  const DB_VERSION = 1;
  const STORE = 'records';
  const META_KEY = '__study_data_migrated_v1';
  const SECRET_KEYS = new Set(global.SecretVault ? global.SecretVault.keys : []);
  let dbPromise = null;
  let lastError = '';

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
      try { value = operation(store); } catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(value && value.result !== undefined ? value.result : value);
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 事务失败'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB 事务已中止'));
    });
  }

  async function getRecord(key) {
    return withStore('readonly', store => store.get(String(key)));
  }

  async function put(key, rawValue, options = {}) {
    const safeKey = String(key || '');
    if (!safeKey || SECRET_KEYS.has(safeKey)) return { ok: false, skipped: true };
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
    await withStore('readwrite', store => store.put(record));
    return { ok: true, record };
  }

  async function list() {
    return withStore('readonly', store => store.getAll());
  }

  async function initialize() {
    await open();
    const records = await list();
    const byKey = new Map(records.map(record => [record.key, record]));
    let copied = 0;
    let restored = 0;
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key || SECRET_KEYS.has(key)) continue;
      const raw = localStorage.getItem(key);
      const existing = byKey.get(key);
      if (!existing || existing.contentHash !== hashText(String(raw == null ? '' : raw))) {
        await put(key, raw);
        copied++;
      }
    }
    for (const record of records) {
      if (record.deletedAt || SECRET_KEYS.has(record.key) || localStorage.getItem(record.key) !== null) continue;
      localStorage.setItem(record.key, record.value);
      restored++;
    }
    localStorage.setItem(META_KEY, new Date().toISOString());
    if (restored && sessionStorage.getItem('__study_data_restore_reload') !== '1') {
      sessionStorage.setItem('__study_data_restore_reload', '1');
      setTimeout(() => location.reload(), 0);
    }
    return { ok: true, copied, restored, records: records.length };
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
    list,
    put: (key, value, options) => put(key, value, options).catch(error => {
      lastError = error.message;
      return { ok: false, error };
    }),
    remove: key => remove(key).catch(error => ({ ok: false, error })),
    status: () => ({ database: DB_NAME, version: DB_VERSION, lastError })
  });
  if (global.StudyPlatform) global.StudyPlatform.defineModule('data', global.StudyData);
})(window);
