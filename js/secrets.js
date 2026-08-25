// Encrypted-at-rest credential facade. Values remain synchronous in memory for legacy callers.
(function createSecretVault(global) {
  'use strict';

  const KEYS = Object.freeze([
    'study_ai_api_key', 'study_api_keys', 'study_web_search_key',
    'study_mail_accounts', 'study_mail_config', 'study_inbox_config',
    'study_codegen_api_key', 'study_codebuddy_api_key'
  ]);
  const allowed = new Set(KEYS);
  const cache = new Map();
  let ready = false;
  let secure = false;

  function assertKey(key) {
    const value = String(key || '');
    if (!allowed.has(value)) throw new Error('不允许访问该凭据键');
    return value;
  }

  async function initialize() {
    if (ready) return { secure, migrated: [] };
    const api = global.electronAPI;
    if (!api || typeof api.secretLoadAll !== 'function') {
      for (const key of KEYS) {
        const value = localStorage.getItem(key);
        if (value != null) cache.set(key, value);
      }
      ready = true;
      return { secure: false, migrated: [] };
    }
    const legacy = {};
    for (const key of KEYS) {
      const value = localStorage.getItem(key);
      if (value != null && value !== '') legacy[key] = value;
    }
    const migration = await api.secretMigrate(legacy).catch(() => ({ ok: false, migrated: [] }));
    const loaded = await api.secretLoadAll().catch(() => ({ ok: false, available: false, values: {} }));
    secure = !!(loaded && loaded.ok && loaded.available);
    if (secure) {
      Object.entries(loaded.values || {}).forEach(([key, value]) => cache.set(key, value));
      for (const key of (migration.migrated || [])) localStorage.removeItem(key);
    } else {
      Object.entries(legacy).forEach(([key, value]) => cache.set(key, value));
    }
    ready = true;
    return { secure, migrated: migration.migrated || [] };
  }

  function get(key, fallback = '') {
    const safeKey = assertKey(key);
    if (cache.has(safeKey)) return cache.get(safeKey);
    const legacy = localStorage.getItem(safeKey);
    return legacy == null ? fallback : legacy;
  }

  function set(key, value) {
    const safeKey = assertKey(key);
    const raw = String(value == null ? '' : value);
    cache.set(safeKey, raw);
    const api = global.electronAPI;
    if (api && typeof api.secretSet === 'function') {
      return api.secretSet({ key: safeKey, value: raw }).then(result => {
        if (result && result.ok) localStorage.removeItem(safeKey);
        return result;
      });
    }
    localStorage.setItem(safeKey, raw);
    return Promise.resolve({ ok: true, secure: false });
  }

  function remove(key) {
    const safeKey = assertKey(key);
    cache.delete(safeKey);
    localStorage.removeItem(safeKey);
    const api = global.electronAPI;
    return api && typeof api.secretDelete === 'function'
      ? api.secretDelete({ key: safeKey })
      : Promise.resolve({ ok: true, secure: false });
  }

  global.SecretVault = Object.freeze({
    get,
    getJson(key, fallback) {
      try { return JSON.parse(get(key, '')) || fallback; } catch { return fallback; }
    },
    initialize,
    isReady: () => ready,
    isSecure: () => secure,
    keys: KEYS.slice(),
    remove,
    set,
    setJson: (key, value) => set(key, JSON.stringify(value))
  });
  if (global.StudyPlatform) global.StudyPlatform.defineModule('secrets', global.SecretVault);
})(window);
