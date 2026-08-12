// ═══════════════════════════════════════════════════════════════════
// js/books-pdfstore.js — 教材 PDF 的 IndexedDB 存储（供 PWA/浏览器阅读）
// 手机端 PWA 手动导入的 PDF 原始字节存储在这里（key: bookId），
// books-ai.js 的 bkOpenPdfAtPage 调用它读取原书原文供 pdf.js 现场解析。
//   - BookPdfStore.read(bookId)   → 返回 Uint8Array 或 null
//   - BookPdfStore.exists(bookId) → boolean
//   - BookPdfStore.put(bookId, data, fileName) → 存入（data: Uint8Array）
//   - BookPdfStore.list()         → [{bookId, fileName, size, savedAt}]
//   - BookPdfStore.remove(bookId)
//
// 性能设计（v2）：
//   - PDF 原始字节存 store 'pdfs'（keyPath bookId，直接存 Uint8Array，不做 Array.from 拷贝）
//   - 元信息（fileName/size/savedAt）存独立 store 'meta'，list() 只读 meta，
//     避免 getAll() 把几十 MB 的 PDF 字节全部加载进内存导致卡顿。
//   - 数据库版本 v2：升级时把已有 'pdfs' 记录的元信息回填到 'meta'。
// ═══════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';
  const IDB_NAME = 'mst-pdf';
  const IDB_VERSION = 2;
  const STORE_PDFS = 'pdfs';
  const STORE_META = 'meta';

  function _open() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('no-indexeddb')); return; }
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = function (ev) {
        const db = req.result;
        const oldVer = ev.oldVersion || 0;
        if (!db.objectStoreNames.contains(STORE_PDFS)) {
          db.createObjectStore(STORE_PDFS, { keyPath: 'bookId' });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'bookId' });
        }
        // 从 v1 升级：把已有 'pdfs' 记录回填元信息（异步，升级事务内发起）
        if (oldVer < 2) {
          try {
            const pdfs = db.transaction(STORE_PDFS, 'readonly').objectStore(STORE_PDFS);
            const meta = db.transaction(STORE_META, 'readwrite').objectStore(STORE_META);
            pdfs.openCursor().onsuccess = function (e) {
              const cur = e.target.result;
              if (cur) {
                const r = cur.value;
                meta.put({ bookId: String(r.bookId), fileName: r.fileName || '', size: (r.data ? r.data.length : 0), savedAt: r.savedAt || 0 });
                cur.continue();
              }
            };
          } catch (e) {}
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
          const req = db.transaction(STORE_PDFS, 'readonly').objectStore(STORE_PDFS).get(String(bookId));
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
      try {
        const db = await _open();
        return new Promise((resolve) => {
          const req = db.transaction(STORE_META, 'readonly').objectStore(STORE_META).count(String(bookId));
          req.onsuccess = function () { db.close(); resolve(req.result > 0); };
          req.onerror = function () { db.close(); resolve(false); };
        });
      } catch (e) { return false; }
    },
    async list() {
      try {
        const db = await _open();
        return new Promise((resolve) => {
          const req = db.transaction(STORE_META, 'readonly').objectStore(STORE_META).getAll();
          req.onsuccess = function () {
            db.close();
            const recs = req.result || [];
            resolve(recs.map((r) => ({ bookId: r.bookId, fileName: r.fileName || '', size: r.size || 0, savedAt: r.savedAt || 0 })));
          };
          req.onerror = function () { db.close(); resolve([]); };
        });
      } catch (e) { return []; }
    },
    async remove(bookId) {
      try {
        const db = await _open();
        return new Promise((resolve) => {
          const tx = db.transaction([STORE_PDFS, STORE_META], 'readwrite');
          tx.objectStore(STORE_PDFS).delete(String(bookId));
          tx.objectStore(STORE_META).delete(String(bookId));
          tx.oncomplete = function () { db.close(); resolve(); };
          tx.onerror = function () { db.close(); resolve(); };
        });
      } catch (e) {}
    },
    async put(bookId, data, fileName) {
      try {
        const db = await _open();
        const size = data ? data.length : 0;
        return new Promise((resolve) => {
          const tx = db.transaction([STORE_PDFS, STORE_META], 'readwrite');
          // 直接存 Uint8Array（structured-clone 原生支持），避免 Array.from 超大数组拷贝
          tx.objectStore(STORE_PDFS).put({ bookId: String(bookId), data: data, fileName: fileName || '', savedAt: Date.now() });
          tx.objectStore(STORE_META).put({ bookId: String(bookId), fileName: fileName || '', size: size, savedAt: Date.now() });
          tx.oncomplete = function () { db.close(); resolve(true); };
          tx.onerror = function () { db.close(); resolve(false); };
        });
      } catch (e) { return false; }
    }
  };

  global.BookPdfStore = BookPdfStore;
})(window);
