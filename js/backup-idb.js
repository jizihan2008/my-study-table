// ═══════════════════════════════════════════════════════════════════
// js/backup-idb.js — 手机端（PWA）本地备份的 IndexedDB 存储
// 手机端无法像 Electron 一样写文件到本地磁盘，故用 IndexedDB 存储完整备份
// （容量大，可存含大 AI 对话/记忆的完整数据），模拟「电脑文件备份」。
//   - BackupIDB.save(data)            → 存一份完整备份，返回 {time}
//   - BackupIDB.list()                → [{time, size}] 按时间倒序
//   - BackupIDB.read(time)            → 读取指定备份的 data
//   - BackupIDB.remove(time)
//   - BackupIDB.count()               → 备份数量
//   - BackupIDB.cleanup(maxFiles)     → 超过 maxFiles 时删除最旧的
// ═══════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';
  const IDB_NAME = 'mst-backup';
  const IDB_VERSION = 1;
  const STORE = 'backups';

  function _open() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('no-indexeddb')); return; }
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          // keyPath: time（ISO 字符串），天然按时间排序
          const store = db.createObjectStore(STORE, { keyPath: 'time' });
          store.createIndex('time', 'time');
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  const BackupIDB = {
    // 存一份完整备份（data 为 key→value 的对象）
    async save(data) {
      try {
        const db = await _open();
        const time = new Date().toISOString();
        return new Promise((resolve) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put({ time, data, size: JSON.stringify(data).length });
          tx.oncomplete = function () { db.close(); resolve({ time }); };
          tx.onerror = function () { db.close(); resolve(null); };
        });
      } catch (e) { return null; }
    },
    // 列出所有备份（不含 data，只含元信息），按时间倒序
    async list() {
      try {
        const db = await _open();
        return new Promise((resolve) => {
          const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
          req.onsuccess = function () {
            db.close();
            const recs = req.result || [];
            recs.sort((a, b) => (a.time < b.time ? 1 : -1));
            resolve(recs.map((r) => ({ time: r.time, size: r.size || 0 })));
          };
          req.onerror = function () { db.close(); resolve([]); };
        });
      } catch (e) { return []; }
    },
    // 读取指定备份的完整数据
    async read(time) {
      try {
        const db = await _open();
        return new Promise((resolve) => {
          const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(time);
          req.onsuccess = function () {
            db.close();
            const rec = req.result;
            resolve(rec && rec.data ? rec.data : null);
          };
          req.onerror = function () { db.close(); resolve(null); };
        });
      } catch (e) { return null; }
    },
    async remove(time) {
      try {
        const db = await _open();
        return new Promise((resolve) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).delete(time);
          tx.oncomplete = function () { db.close(); resolve(true); };
          tx.onerror = function () { db.close(); resolve(false); };
        });
      } catch (e) { return false; }
    },
    async count() {
      try {
        const db = await _open();
        return new Promise((resolve) => {
          const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
          req.onsuccess = function () { db.close(); resolve(req.result || 0); };
          req.onerror = function () { db.close(); resolve(0); };
        });
      } catch (e) { return 0; }
    },
    // 超过 maxFiles 时删除最旧的，返回删除数量
    async cleanup(maxFiles) {
      try {
        const list = await BackupIDB.list();
        const limit = Math.max(Number(maxFiles) || 30, 1);
        if (list.length <= limit) return 0;
        const toDelete = list.slice(limit); // list 已按时间倒序，slice 取最旧的
        for (const item of toDelete) {
          await BackupIDB.remove(item.time);
        }
        return toDelete.length;
      } catch (e) { return 0; }
    }
  };

  global.BackupIDB = BackupIDB;
})(window);
