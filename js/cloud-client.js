(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StudyCloud = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  function isCloudBaseConfig(config) {
    return !!(config && config.provider === 'cloudbase' && config.envId && config.accessKey);
  }

  function isSupabaseConfig(config) {
    return !!(config && config.url && config.anonKey && config.provider !== 'cloudbase');
  }

  // Safari（尤其是添加到主屏幕、隐私模式或存储空间紧张时）可能允许登录请求
  // 成功，却在 Supabase 保存会话时拒绝 localStorage。提供逐级回退，保证同一
  // 运行会话内好友页、设置页和同步模块读取到完全相同的认证状态。
  function createResilientAuthStorage() {
    const memory = Object.create(null);

    function availableStorage(name) {
      try {
        const storage = root && root[name];
        return storage && typeof storage.getItem === 'function' ? storage : null;
      } catch (e) { return null; }
    }

    return {
      getItem: function (key) {
        const stores = [availableStorage('localStorage'), availableStorage('sessionStorage')];
        for (let i = 0; i < stores.length; i++) {
          if (!stores[i]) continue;
          try {
            const value = stores[i].getItem(key);
            if (value != null) {
              memory[key] = value;
              return value;
            }
          } catch (e) {}
        }
        return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
      },
      setItem: function (key, value) {
        memory[key] = String(value);
        const stores = [availableStorage('localStorage'), availableStorage('sessionStorage')];
        for (let i = 0; i < stores.length; i++) {
          if (!stores[i]) continue;
          try { stores[i].setItem(key, String(value)); } catch (e) {}
        }
      },
      removeItem: function (key) {
        delete memory[key];
        const stores = [availableStorage('localStorage'), availableStorage('sessionStorage')];
        for (let i = 0; i < stores.length; i++) {
          if (!stores[i]) continue;
          try { stores[i].removeItem(key); } catch (e) {}
        }
      }
    };
  }

  function createCloudBaseClient(config) {
    if (!root.cloudbase || typeof root.cloudbase.init !== 'function') return null;
    const app = root.cloudbase.init({
      env: config.envId,
      region: config.region || 'ap-shanghai',
      accessKey: config.accessKey
    });
    const auth = typeof app.auth === 'function'
      ? app.auth({ persistence: 'local' })
      : app.auth;
    const database = typeof app.rdb === 'function' ? app.rdb() : app.rdb;
    if (!auth || !database || typeof database.from !== 'function') return null;

    return {
      provider: 'cloudbase',
      auth,
      storage: app.storage,
      from: database.from.bind(database),
      rpc: typeof database.rpc === 'function' ? database.rpc.bind(database) : undefined,
      // CloudBase for Supabase 暂无 Realtime。好友模块会自动启用自适应轮询。
      removeAllChannels: function () {},
      removeChannel: function () {}
    };
  }

  function createSupabaseClient(config) {
    if (!root.supabase || typeof root.supabase.createClient !== 'function') return null;
    const client = root.supabase.createClient(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: createResilientAuthStorage()
      }
    });
    client.provider = 'supabase';
    return client;
  }

  function createClient(config) {
    if (isCloudBaseConfig(config)) return createCloudBaseClient(config);
    if (isSupabaseConfig(config)) return createSupabaseClient(config);
    return null;
  }

  return {
    createClient,
    createResilientAuthStorage,
    isCloudBaseConfig,
    isSupabaseConfig
  };
});
