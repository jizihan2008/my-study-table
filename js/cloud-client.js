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
        storage: root.localStorage
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
    isCloudBaseConfig,
    isSupabaseConfig
  };
});
