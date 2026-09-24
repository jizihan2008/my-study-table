// Cross-platform extension persistence.
// Electron keeps using the filesystem IPC service; browsers/PWA use IndexedDB.
(function createExtensionRepository(global) {
  'use strict';

  const DB_NAME = 'my-study-table-extensions';
  const DB_VERSION = 1;
  const STORE = 'extensions';
  const MAX_MANIFEST_BYTES = 256 * 1024;
  const MAX_MAIN_BYTES = 2 * 1024 * 1024;
  const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  let dbPromise = null;

  function byteLength(value) {
    const text = String(value == null ? '' : value);
    return encoder ? encoder.encode(text).byteLength : text.length;
  }

  function validId(value) {
    const id = String(value || '').trim();
    // Match the desktop extension-id policy so the same package works cross-platform.
    return /^[a-zA-Z0-9_-]+$/.test(id) ? id : '';
  }

  function validateManifest(manifest, expectedId) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest 必须是对象');
    const id = validId(manifest.id);
    if (!id || id !== String(manifest.id || '').trim()) throw new Error('manifest 缺少合法 id');
    if (expectedId && id !== expectedId) throw new Error('manifest id 与目标扩展不一致');
    const serialized = JSON.stringify(manifest);
    if (byteLength(serialized) > MAX_MANIFEST_BYTES) throw new Error('manifest 超过 256KB 限制');
    return id;
  }

  function openWebDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!global.indexedDB) return reject(new Error('IndexedDB 不可用'));
      const request = global.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('trashed', 'trashed');
          store.createIndex('updatedAt', 'updatedAt');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB 打开失败'));
    }).catch(error => { dbPromise = null; throw error; });
    return dbPromise;
  }

  async function webStore(mode, operation) {
    const db = await openWebDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const store = transaction.objectStore(STORE);
      let request;
      try { request = operation(store); } catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(request && request.result !== undefined ? request.result : request);
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 事务失败'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB 事务已中止'));
    });
  }

  const web = {
    kind: 'indexeddb',
    async list() {
      const rows = await webStore('readonly', store => store.getAll());
      return (rows || []).filter(row => !row.trashed).map(toListItem);
    },
    async read({ id, file, filename } = {}) {
      const safeId = validId(id);
      const name = String(file || filename || 'main.js');
      if (!safeId) throw new Error('非法扩展 id');
      if (name !== 'main.js' && name !== 'manifest.json') throw new Error('不允许读取该扩展文件');
      const row = await webStore('readonly', store => store.get(safeId));
      if (!row || row.trashed) throw new Error('扩展不存在');
      return name === 'manifest.json' ? JSON.stringify(row.manifest, null, 2) : String(row.mainCode || '');
    },
    async write({ id, files } = {}) {
      const safeId = validId(id);
      if (!safeId || safeId !== String(id || '').trim()) throw new Error('非法扩展 id');
      if (!files || typeof files !== 'object') throw new Error('缺少扩展文件');
      const previous = await webStore('readonly', store => store.get(safeId));
      const manifest = files.manifest !== undefined ? files.manifest : previous && previous.manifest;
      validateManifest(manifest, safeId);
      const mainCode = files.main !== undefined ? String(files.main || '') : String(previous && previous.mainCode || '');
      if (byteLength(mainCode) > MAX_MAIN_BYTES) throw new Error('main.js 超过 2MB 限制');
      const now = new Date().toISOString();
      const row = {
        id: safeId,
        manifest,
        mainCode,
        createdAt: previous && previous.createdAt || now,
        updatedAt: now,
        trashed: false,
        trashName: '',
        deletedAt: null,
        backups: Array.isArray(previous && previous.backups) ? previous.backups : []
      };
      await webStore('readwrite', store => store.put(row));
      return { ok: true, storage: 'indexeddb', id: safeId };
    },
    async backup({ id } = {}) {
      const safeId = validId(id);
      const row = safeId && await webStore('readonly', store => store.get(safeId));
      if (!row || row.trashed) return { ok: false, reason: '扩展不存在' };
      const name = new Date().toISOString().replace(/[:.]/g, '-');
      row.backups = Array.isArray(row.backups) ? row.backups : [];
      row.backups.push({ name, manifest: row.manifest, mainCode: row.mainCode, createdAt: new Date().toISOString() });
      row.backups = row.backups.slice(-10);
      await webStore('readwrite', store => store.put(row));
      return { ok: true, backupName: name, files: ['manifest.json', 'main.js'] };
    },
    async listBackups({ id } = {}) {
      const safeId = validId(id);
      const row = safeId && await webStore('readonly', store => store.get(safeId));
      return (row && row.backups || []).map(item => ({ name: item.name, mtime: item.createdAt })).reverse();
    },
    async restore({ id, backupName } = {}) {
      const safeId = validId(id);
      const row = safeId && await webStore('readonly', store => store.get(safeId));
      const backup = row && (row.backups || []).find(item => item.name === backupName);
      if (!row || !backup) return { ok: false, reason: '备份不存在' };
      row.manifest = backup.manifest;
      row.mainCode = backup.mainCode;
      row.updatedAt = new Date().toISOString();
      await webStore('readwrite', store => store.put(row));
      return { ok: true };
    },
    async remove({ id } = {}) {
      const safeId = validId(id);
      const row = safeId && await webStore('readonly', store => store.get(safeId));
      if (!row) return { ok: true, trashed: false, reason: 'not-exists' };
      row.trashed = true;
      row.deletedAt = new Date().toISOString();
      row.trashName = safeId + '-' + Date.now().toString(36);
      await webStore('readwrite', store => store.put(row));
      return { ok: true, trashed: true, trashDir: row.trashName };
    },
    async trashList() {
      const rows = await webStore('readonly', store => store.getAll());
      return (rows || []).filter(row => row.trashed).map(row => ({
        id: row.id, trashDir: row.trashName, manifest: row.manifest,
        hasMain: !!row.mainCode, error: null, deletedAt: row.deletedAt
      })).sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')));
    },
    async trashRestore({ trashDir } = {}) {
      const rows = await webStore('readonly', store => store.getAll());
      const row = (rows || []).find(item => item.trashed && item.trashName === trashDir);
      if (!row) return { ok: false, reason: '回收站项不存在' };
      row.trashed = false; row.trashName = ''; row.deletedAt = null; row.updatedAt = new Date().toISOString();
      await webStore('readwrite', store => store.put(row));
      return { ok: true, id: row.id };
    },
    async trashPurge({ trashDir } = {}) {
      const rows = await webStore('readonly', store => store.getAll());
      const row = (rows || []).find(item => item.trashed && item.trashName === trashDir);
      if (!row) return { ok: true };
      await webStore('readwrite', store => store.delete(row.id));
      return { ok: true };
    },
    async trashEmpty() {
      const rows = await webStore('readonly', store => store.getAll());
      for (const row of (rows || []).filter(item => item.trashed)) {
        await webStore('readwrite', store => store.delete(row.id));
      }
      return { ok: true };
    }
  };

  function toListItem(row) {
    const manifest = row.manifest || null;
    return {
      id: row.id,
      manifest,
      hasMain: !!row.mainCode,
      hasManifest: !!manifest,
      type: manifest && manifest.type || 'plugin',
      builtin: false,
      name: manifest && manifest.name || row.id,
      version: manifest && manifest.version || '1.0.0',
      author: manifest && manifest.author || '',
      size: byteLength(row.mainCode || ''),
      mtime: row.updatedAt || null,
      error: null
    };
  }

  function electronCall(method, payload) {
    const api = global.electronAPI && global.electronAPI[method];
    if (typeof api !== 'function') throw new Error('扩展桌面能力不可用');
    return api(payload);
  }

  const electron = {
    kind: 'electron',
    list: () => electronCall('extList'),
    read: payload => electronCall('extRead', payload),
    write: payload => electronCall('extWrite', payload),
    backup: payload => electronCall('extBackup', payload),
    listBackups: payload => electronCall('extListBackups', payload),
    restore: payload => electronCall('extRestore', payload),
    remove: payload => electronCall('extRemove', payload),
    trashList: () => electronCall('extTrashList'),
    trashRestore: payload => electronCall('extTrashRestore', payload),
    trashPurge: payload => electronCall('extTrashPurge', payload),
    trashEmpty: () => electronCall('extTrashEmpty')
  };

  const repository = global.electronAPI && global.electronAPI.isElectron ? electron : web;
  global.ExtensionRepository = Object.freeze({
    DB_NAME,
    kind: repository.kind,
    isWeb: repository.kind === 'indexeddb',
    list: repository.list,
    read: repository.read,
    write: repository.write,
    backup: repository.backup,
    listBackups: repository.listBackups,
    restore: repository.restore,
    remove: repository.remove,
    trashList: repository.trashList,
    trashRestore: repository.trashRestore,
    trashPurge: repository.trashPurge,
    trashEmpty: repository.trashEmpty,
    validateManifest
  });
})(window);
