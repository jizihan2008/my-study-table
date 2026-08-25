// Shared renderer infrastructure. Loaded before feature modules.
(function bootstrapPlatform(global) {
  'use strict';

  function parseJson(raw, fallback) {
    if (raw === null || raw === undefined || raw === '') return fallback;
    try { return JSON.parse(raw); } catch (_) { return fallback; }
  }

  function cloneFallback(fallback) {
    if (Array.isArray(fallback)) return fallback.slice();
    if (fallback && typeof fallback === 'object') return { ...fallback };
    return fallback;
  }

  const storage = {
    getRaw(key, fallback = null) {
      try {
        const value = localStorage.getItem(key);
        return value === null ? fallback : value;
      } catch (_) {
        return fallback;
      }
    },
    getJson(key, fallback = null) {
      return parseJson(this.getRaw(key), cloneFallback(fallback));
    },
    setRaw(key, value) {
      const raw = String(value);
      try {
        localStorage.setItem(key, raw);
        if (global.StudyData) global.StudyData.put(key, raw);
        return { ok: true };
      } catch (error) {
        if (global.StudyData) {
          global.StudyData.put(key, raw);
          return { ok: true, durable: 'indexeddb', warning: error };
        }
        return { ok: false, error };
      }
    },
    setJson(key, value) {
      let raw;
      try {
        raw = JSON.stringify(value);
        localStorage.setItem(key, raw);
        if (global.StudyData) global.StudyData.put(key, raw);
        return { ok: true };
      } catch (error) {
        if (raw !== undefined && global.StudyData) {
          global.StudyData.put(key, raw);
          return { ok: true, durable: 'indexeddb', warning: error };
        }
        return { ok: false, error };
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
        if (global.StudyData) global.StudyData.remove(key);
        return true;
      } catch (_) { return false; }
    }
  };

  const initializers = [];
  const eventHandlers = new Map();
  const modules = new Map();

  const events = Object.freeze({
    on(name, handler) {
      if (typeof handler !== 'function') throw new TypeError('event handler must be a function');
      const key = String(name);
      const handlers = eventHandlers.get(key) || new Set();
      handlers.add(handler);
      eventHandlers.set(key, handlers);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) eventHandlers.delete(key);
      };
    },
    emit(name, payload) {
      const handlers = Array.from(eventHandlers.get(String(name)) || []);
      for (const handler of handlers) {
        try { handler(payload); } catch (error) { console.error('[platform:event] handler failed:', error); }
      }
      return handlers.length;
    }
  });
  function registerInitializer(name, fn, order = 100) {
    if (typeof fn !== 'function') throw new TypeError('initializer must be a function');
    initializers.push({ name: String(name || 'anonymous'), fn, order: Number(order) || 100 });
  }

  async function initialize() {
    const results = [];
    const ordered = initializers.slice().sort((a, b) => a.order - b.order);
    for (const item of ordered) {
      try {
        await item.fn();
        results.push({ name: item.name, ok: true });
      } catch (error) {
        console.error('[platform:init] ' + item.name + ' failed:', error);
        results.push({ name: item.name, ok: false, error });
      }
    }
    return results;
  }

  function defineModule(name, api) {
    const key = String(name || '').trim();
    if (!key) throw new Error('module name is required');
    if (modules.has(key)) throw new Error('module already registered: ' + key);
    modules.set(key, api);
    return api;
  }

  function getModule(name) { return modules.get(String(name)) || null; }

  global.StudyPlatform = Object.freeze({
    events,
    defineModule,
    getModule,
    initialize,
    parseJson,
    registerInitializer,
    storage
  });
})(typeof window !== 'undefined' ? window : globalThis);
