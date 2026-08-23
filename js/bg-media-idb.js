// ═══════════════════════════════════════════════════════════════════
// js/bg-media-idb.js — 背景图片/视频的 IndexedDB 持久化存储（PWA/移动端）
// 解决 iOS Safari localStorage 容量小（~5MB，大图 base64 会超限）与
// URL.createObjectURL 重启后失效的问题：
//   - 图片：Blob 存 IDB，加载时取回生成 blob: URL（可跨会话持久）
//   - 视频：Blob 存 IDB，加载时取回生成 blob: URL（重启后仍可用）
// API：
//   - BgMediaIDB.saveImage(file) / saveVideo(file) → { key, url }
//   - BgMediaIDB.loadImageUrl() / loadVideoUrl()   → { key, url } | null
//   - BgMediaIDB.clearImage() / clearVideo()
// 依赖：无（纯 IndexedDB）
// ═══════════════════════════════════════════════════════════════════

window.BgMediaIDB = (function () {
  'use strict';
  const IDB_NAME = 'mst-bgmedia';
  const IDB_VERSION = 1;
  const STORE = 'media';
  const IMAGE_KEY = 'bgImage';
  const VIDEO_KEY = 'bgVideo';

  function _open() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') { reject(new Error('no-indexeddb')); return; }
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('open failed')); };
    });
  }

  function _save(key, blob) {
    return _open().then(function (db) {
      return new Promise(function (resolve) {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ key: key, blob: blob, savedAt: Date.now() });
        tx.oncomplete = function () { db.close(); resolve(true); };
        tx.onerror = function () { db.close(); resolve(false); };
      });
    });
  }

  function _load(key) {
    return _open().then(function (db) {
      return new Promise(function (resolve) {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        req.onsuccess = function () { db.close(); resolve(req.result ? req.result.blob : null); };
        req.onerror = function () { db.close(); resolve(null); };
      });
    });
  }

  function _clear(key) {
    return _open().then(function (db) {
      return new Promise(function (resolve) {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = function () { db.close(); resolve(true); };
        tx.onerror = function () { db.close(); resolve(false); };
      });
    });
  }

  // Blob → object URL（若已存在旧 URL 则先回收）
  let _imageUrl = null;
  let _videoUrl = null;
  function _makeUrl(blob) {
    return URL.createObjectURL(blob);
  }
  function _revokeUrl(key) {
    if (key === IMAGE_KEY && _imageUrl) { try { URL.revokeObjectURL(_imageUrl); } catch (e) {} _imageUrl = null; }
    if (key === VIDEO_KEY && _videoUrl) { try { URL.revokeObjectURL(_videoUrl); } catch (e) {} _videoUrl = null; }
  }

  return {
    // 保存背景图片文件，返回 { key, url }
    async saveImage(file) {
      if (!file) return null;
      const ok = await _save(IMAGE_KEY, file);
      if (!ok) return null;
      _revokeUrl(IMAGE_KEY);
      _imageUrl = _makeUrl(file);
      return { key: IMAGE_KEY, url: _imageUrl };
    },
    // 保存背景视频文件，返回 { key, url }
    async saveVideo(file) {
      if (!file) return null;
      const ok = await _save(VIDEO_KEY, file);
      if (!ok) return null;
      _revokeUrl(VIDEO_KEY);
      _videoUrl = _makeUrl(file);
      return { key: VIDEO_KEY, url: _videoUrl };
    },
    // 加载已保存的背景图片 URL（启动时调用恢复）
    async loadImageUrl() {
      if (_imageUrl) return { key: IMAGE_KEY, url: _imageUrl };
      const blob = await _load(IMAGE_KEY);
      if (!blob) return null;
      _imageUrl = _makeUrl(blob);
      return { key: IMAGE_KEY, url: _imageUrl };
    },
    // 加载已保存的背景视频 URL（启动时调用恢复）
    async loadVideoUrl() {
      if (_videoUrl) return { key: VIDEO_KEY, url: _videoUrl };
      const blob = await _load(VIDEO_KEY);
      if (!blob) return null;
      _videoUrl = _makeUrl(blob);
      return { key: VIDEO_KEY, url: _videoUrl };
    },
    async clearImage() { _revokeUrl(IMAGE_KEY); return _clear(IMAGE_KEY); },
    async clearVideo() { _revokeUrl(VIDEO_KEY); return _clear(VIDEO_KEY); },
    get imageKey() { return IMAGE_KEY; },
    get videoKey() { return VIDEO_KEY; }
  };
})();
