(function createStorageUsage(global) {
  'use strict';
  const knownDatabases = ['my-study-table-data', 'my-study-table-extensions', 'study-file-library',
    'study-ai-attachments', 'mst-backup', 'mst-bgmedia', 'mst-booktext', 'mst-pdf', 'mst-qqchats', 'mst-sync', 'mst-sync-logs'];
  function bytes(value, seen = new Set()) {
    if (value == null) return 0;
    if (typeof value === 'string') return new Blob([value]).size;
    if (typeof value !== 'object') return new Blob([String(value)]).size;
    if (value instanceof Blob) return value.size;
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
    if (seen.has(value)) return 0;
    seen.add(value);
    return Object.entries(value).reduce((sum, [key, item]) => sum + bytes(key) + bytes(item, seen), 0);
  }
  function scanDatabase(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      // Enumerating known names must not create unused databases on Safari.
      let absent = false;
      request.onupgradeneeded = () => { absent = true; request.transaction.abort(); };
      request.onerror = () => absent ? resolve(0) : reject(request.error);
      request.onblocked = () => reject(new Error('数据库被其他页面占用：' + name));
      request.onsuccess = () => {
        const db = request.result;
        const names = [...db.objectStoreNames];
        if (!names.length) { db.close(); resolve(0); return; }
        let total = 0;
        const transaction = db.transaction(names, 'readonly');
        transaction.oncomplete = () => { db.close(); resolve(total); };
        transaction.onerror = transaction.onabort = () => { db.close(); reject(transaction.error || new Error('无法统计 ' + name)); };
        for (const store of names) {
          const cursor = transaction.objectStore(store).openCursor();
          cursor.onsuccess = () => {
            if (!cursor.result) return;
            total += bytes(cursor.result.key) + bytes(cursor.result.value);
            cursor.result.continue();
          };
        }
      };
    });
  }
  async function measure() {
    const native = global.StudyData?.nativeStorage || localStorage;
    let localBytes = 0;
    for (let i = 0; i < native.length; i++) {
      const key = native.key(i);
      localBytes += 2 * (key.length + (native.getItem(key) || '').length);
    }
    let names = knownDatabases;
    if (typeof indexedDB.databases === 'function') {
      try { names = (await indexedDB.databases()).map(db => db.name).filter(Boolean); } catch (_) {}
    }
    const results = await Promise.allSettled(names.map(scanDatabase));
    const idbBytes = results.reduce((sum, result) => sum + (result.status === 'fulfilled' ? result.value : 0), 0);
    let estimate = null;
    try { estimate = await navigator.storage?.estimate(); } catch (_) {}
    return { localBytes, idbBytes, partial: results.some(result => result.status === 'rejected'), estimate };
  }
  function format(size) {
    if (!Number.isFinite(size)) return '暂不可用';
    if (size < 1024) return size + ' B';
    if (size < 1024 ** 2) return (size / 1024).toFixed(1) + ' KiB';
    if (size < 1024 ** 3) return (size / 1024 ** 2).toFixed(2) + ' MiB';
    return (size / 1024 ** 3).toFixed(2) + ' GiB';
  }
  let refreshing = false;
  global.refreshStorageUsage = async function refreshStorageUsage() {
    const status = document.getElementById('storageUsageStatus');
    if (!status || refreshing) return;
    refreshing = true;
    const button = document.getElementById('storageUsageRefresh');
    if (button) button.disabled = true;
    status.textContent = '正在统计…';
    try {
      const data = await measure();
      document.getElementById('localStorageUsage').textContent = format(data.localBytes) + ' / 参考上限约 5 MiB';
      const reported = data.estimate?.usageDetails?.indexedDB;
      document.getElementById('indexedDbUsage').textContent = Number.isFinite(reported)
        ? format(reported) + '（浏览器估算）'
        : format(data.idbBytes) + (data.partial ? '（部分数据库未能统计）' : '（内容体积估算）');
      document.getElementById('siteStorageQuota').textContent = data.estimate && Number.isFinite(data.estimate.quota)
        ? '浏览器报告网站已用 ' + format(data.estimate.usage) + ' / 配额 ' + format(data.estimate.quota) + '（含离线缓存等，共享配额；可能与内容体积不同）'
        : '浏览器未提供网站整体配额。IndexedDB 没有独立的固定容量上限。';
      const state = global.StudyData?.status();
      status.textContent = state?.lastError ? '最近保存失败：' + state.lastError : state?.pending ? '仍有数据正在保存，稍后刷新可更新用量。' : '用量已更新。';
    } catch (error) { status.textContent = '统计失败：' + (error.message || error); }
    finally { refreshing = false; if (button) button.disabled = false; }
  };
  global.StorageUsage = Object.freeze({ measure, format });
})(window);
