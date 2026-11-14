(function (global) {
  'use strict';

  const DATABASE = 'mst-note-history';
  const STORE = 'snapshots';
  const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
  const MAX_PER_NOTE = 10;
  const MAX_BYTES = 20 * 1024 * 1024;
  const session = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  let sequence = 0;
  let connection;

  function noteKey(id) {
    return JSON.stringify([global.localStorage.getItem('study_sync_account_id_v1') || '', String(id)]);
  }

  function open() {
    if (!connection) {
      connection = new Promise((resolve, reject) => {
        const request = global.indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore(STORE, { keyPath: 'snapshotId' });
          // Key cursors can list and prune history without loading Markdown bodies.
          store.createIndex('retention', ['timestamp', 'snapshotId', 'noteKey', 'size']);
          store.createIndex('note', ['noteKey', 'timestamp', 'snapshotId', 'totalLength', 'action']);
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); connection = null; };
          resolve(db);
        };
      }).catch(error => {
        connection = null;
        throw error;
      });
    }
    return connection;
  }

  async function transact(mode, run) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      let value;
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () => reject(transaction.error || new Error('笔记历史事务已取消'));
      run(transaction.objectStore(STORE), result => { value = result; });
    });
  }

  function prune(store) {
    const cutoff = Date.now() - MAX_AGE;
    const count = new Map();
    let used = 0;
    let budgetExceeded = false;
    const request = store.index('retention').openKeyCursor(null, 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const [timestamp, , key, size] = cursor.key;
      const kept = count.get(key) || 0;
      if (timestamp < cutoff || kept >= MAX_PER_NOTE) {
        store.delete(cursor.primaryKey);
      } else if (budgetExceeded || used + size > MAX_BYTES) {
        budgetExceeded = true;
        store.delete(cursor.primaryKey);
      } else {
        count.set(key, kept + 1);
        used += size;
      }
      cursor.continue();
    };
  }

  async function record(snapshot) {
    snapshot.snapshotId = session + '-h' + (++sequence).toString(36).padStart(8, '0');
    try {
      const entry = {
        ...snapshot, noteKey: noteKey(snapshot.noteId),
        content: String(snapshot.content ?? ''), title: String(snapshot.title ?? ''), action: snapshot.action || ''
      };
      entry.totalLength = entry.content.length;
      entry.size = new Blob([JSON.stringify(entry)]).size;
      if (entry.size > MAX_BYTES) return;
      await transact('readwrite', store => {
        store.add(entry);
        prune(store);
      });
    } catch (error) {
      console.warn('[笔记历史] 保存快照失败', error);
    }
  }

  function list(id) {
    const key = noteKey(id);
    const range = IDBKeyRange.bound([key, Date.now() - MAX_AGE], [key, Number.MAX_SAFE_INTEGER]);
    return transact('readonly', (store, setResult) => {
      const entries = [];
      const request = store.index('note').openKeyCursor(range, 'prev');
      setResult(entries);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const [, timestamp, snapshotId, totalLength, action] = cursor.key;
        entries.push({ timestamp, snapshotId, totalLength, action });
        cursor.continue();
      };
    });
  }

  function get(id, snapshotId) {
    const key = noteKey(id);
    return transact('readonly', (store, setResult) => {
      const request = store.get(snapshotId);
      request.onsuccess = () => {
        const entry = request.result;
        if (entry?.noteKey === key && entry.timestamp >= Date.now() - MAX_AGE) setResult(entry);
      };
    });
  }

  global.NoteHistory = { record, list, get };
  transact('readwrite', prune).catch(error => console.warn('[笔记历史] 清理过期快照失败', error));
})(window);
