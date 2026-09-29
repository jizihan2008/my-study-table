(function initSiteDataReset(global) {
  'use strict';

  // Safari 尚未稳定支持 indexedDB.databases()，因此保留完整的已知数据库列表。
  const KNOWN_DATABASES = [
    'my-study-table-data',
    'my-study-table-extensions',
    'study-file-library',
    'mst-backup',
    'mst-bgmedia',
    'mst-booktext',
    'mst-pdf',
    'mst-qqchats',
    'mst-sync',
    'mst-sync-logs'
  ];

  function deleteDatabase(name, timeoutMs) {
    return new Promise(resolve => {
      if (!global.indexedDB) {
        resolve({ name, ok: true, skipped: true });
        return;
      }
      let settled = false;
      let timer = null;
      const finish = result => {
        if (settled) return;
        settled = true;
        if (timer !== null) global.clearTimeout(timer);
        resolve(result);
      };
      try {
        const request = global.indexedDB.deleteDatabase(name);
        request.onsuccess = () => finish({ name, ok: true });
        request.onerror = () => finish({ name, ok: false, reason: String(request.error?.message || '删除失败') });
        request.onblocked = () => finish({ name, ok: false, blocked: true, reason: '仍被其他标签页占用' });
        timer = global.setTimeout(() => finish({ name, ok: false, reason: '删除超时' }), timeoutMs);
      } catch (error) {
        finish({ name, ok: false, reason: String(error?.message || error) });
      }
    });
  }

  async function databaseNames() {
    const names = new Set(KNOWN_DATABASES);
    if (global.indexedDB && typeof global.indexedDB.databases === 'function') {
      try {
        const databases = await global.indexedDB.databases();
        databases.forEach(database => {
          if (database && database.name) names.add(database.name);
        });
      } catch (_) {
        // iOS / iPadOS 上可能不支持枚举；已知列表仍可完成清理。
      }
    }
    return Array.from(names);
  }

  function clearAccessibleCookies() {
    try {
      const cookies = String(global.document?.cookie || '').split(';');
      const hostname = global.location?.hostname || '';
      cookies.forEach(cookie => {
        const separator = cookie.indexOf('=');
        const name = (separator >= 0 ? cookie.slice(0, separator) : cookie).trim();
        if (!name) return;
        const expires = '=; Max-Age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
        global.document.cookie = name + expires;
        if (hostname) global.document.cookie = name + expires + '; domain=' + hostname;
      });
    } catch (_) {}
  }

  async function run(options = {}) {
    const timeoutMs = Math.max(500, Number(options.timeoutMs) || 4000);
    const report = { databases: [], caches: [], serviceWorkers: [], storage: true };

    try { global.localStorage?.clear(); } catch (_) { report.storage = false; }
    try { global.sessionStorage?.clear(); } catch (_) { report.storage = false; }
    clearAccessibleCookies();

    if (global.caches && typeof global.caches.keys === 'function') {
      try {
        const keys = await global.caches.keys();
        report.caches = await Promise.all(keys.map(async name => ({ name, ok: await global.caches.delete(name) })));
      } catch (error) {
        report.caches.push({ name: '*', ok: false, reason: String(error?.message || error) });
      }
    }

    if (global.navigator?.serviceWorker?.getRegistrations) {
      try {
        const registrations = await global.navigator.serviceWorker.getRegistrations();
        report.serviceWorkers = await Promise.all(registrations.map(async registration => ({
          scope: registration.scope,
          ok: await registration.unregister()
        })));
      } catch (error) {
        report.serviceWorkers.push({ scope: '*', ok: false, reason: String(error?.message || error) });
      }
    }

    const names = await databaseNames();
    report.databases = await Promise.all(names.map(name => deleteDatabase(name, timeoutMs)));
    report.ok = report.storage && [report.databases, report.caches, report.serviceWorkers]
      .flat()
      .every(item => item.ok || item.skipped);
    return report;
  }

  global.SiteDataReset = Object.freeze({ KNOWN_DATABASES: KNOWN_DATABASES.slice(), run });
})(typeof window !== 'undefined' ? window : globalThis);
