// ═══════════════════════════════════════════════════════════════════
// js/books-pdfstore.js — 教材 PDF 的 IndexedDB 存储（供 PWA/浏览器阅读）
// 手机端 PWA 手动导入的 PDF 原始字节存储在这里（key: bookId），
// books-ai.js 的 bkOpenPdfAtPage 调用它读取原书原文供 pdf.js 现场解析。
//   - BookPdfStore.read(bookId)   → 返回 Uint8Array 或 null
//   - BookPdfStore.exists(bookId) → boolean
//   - BookPdfStore.put(bookId, data, fileName) → 存入（data: Uint8Array）
//   - BookPdfStore.list()         → [{bookId, fileName, size, savedAt}]
//   - BookPdfStore.remove(bookId)
// ═══════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';
  const IDB_NAME = 'mst-pdf';
  const IDB_STORE = 'pdfs';

  function _open() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('no-indexeddb')); return; }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'bookId' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  const BookPdfStore = {
    async read(bookId) {
      try {
        const db = await _open();
        return new Promise((resolve) => {
          const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(String(bookId));
          req.onsuccess = function () {
            db.close();
            const rec = req.result;
            if (rec && rec.data) {
              const arr = rec.data;
              if (arr instanceof Uint8Array) { resolve(arr); return; }
              if (arr && Array.isArray(arr)) { resolve(new Uint8Array(arr)); return; }
              resolve(null);
            } else resolve(null);
          };
          req.onerror = function () { db.close(); resolve(null); };
        });
      } catch (e) { return null; }
    },
    async exists(bookId) {
      const data = await BookPdfStore.read(bookId);
      return !!data;
    },
    async list() {
      try {
        const db = await _open();
        return new Promise((resolve) => {
          const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAll();
          req.onsuccess = function () {
            db.close();
            const recs = req.result || [];
            resolve(recs.map((r) => ({ bookId: r.bookId, fileName: r.fileName || '', size: r.data ? r.data.length : 0, savedAt: r.savedAt || 0 })));
          };
          req.onerror = function () { db.close(); resolve([]); };
        });
      } catch (e) { return []; }
    },
    async remove(bookId) {
      try {
        const db = await _open();
        return new Promise((resolve) => {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).delete(String(bookId));
          tx.oncomplete = function () { db.close(); resolve(); };
          tx.onerror = function () { db.close(); resolve(); };
        });
      } catch (e) {}
    },
    async put(bookId, data, fileName) {
      try {
        const db = await _open();
        return new Promise((resolve) => {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put({ bookId: String(bookId), data: Array.from(data), fileName: fileName || '', savedAt: Date.now() });
          tx.oncomplete = function () { db.close(); resolve(true); };
          tx.onerror = function () { db.close(); resolve(false); };
        });
      } catch (e) { return false; }
    }
  };

  global.BookPdfStore = BookPdfStore;
})(window);
