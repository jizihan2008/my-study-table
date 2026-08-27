'use strict';

function createQQChatAutoSyncService(options) {
  const fs = options.fs;
  const path = options.path;
  const configPath = options.configPath;
  const validateDirectory = options.validateDirectory;
  const onChanged = options.onChanged;
  const debounceMs = Math.max(1000, Number(options.debounceMs) || 4000);
  let config = { enabled: false, dir: '', lastSyncAt: '', lastAdded: 0 };
  let watchers = [];
  let timer = null;
  let active = false;
  let lastEventAt = '';
  let lastError = '';

  function status() {
    return {
      enabled: config.enabled === true,
      active,
      dir: config.dir || '',
      lastEventAt,
      lastSyncAt: config.lastSyncAt || '',
      lastAdded: Math.max(0, Number(config.lastAdded) || 0),
      lastError
    };
  }

  async function persist() {
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    const payload = {
      version: 1,
      enabled: config.enabled === true,
      dir: config.dir || '',
      lastSyncAt: config.lastSyncAt || '',
      lastAdded: Math.max(0, Number(config.lastAdded) || 0)
    };
    await fs.promises.writeFile(configPath, JSON.stringify(payload, null, 2), 'utf8');
  }

  function closeWatchers() {
    if (timer) clearTimeout(timer);
    timer = null;
    for (const watcher of watchers) {
      try { watcher.close(); } catch (e) {}
    }
    watchers = [];
    active = false;
  }

  function scheduleChange() {
    lastEventAt = new Date().toISOString();
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      Promise.resolve(onChanged({ dir: config.dir, detectedAt: lastEventAt })).catch(function (error) {
        lastError = String((error && error.message) || error || '自动同步通知失败').slice(0, 500);
      });
    }, debounceMs);
  }

  function attachWatcher(dir) {
    const watcher = fs.watch(dir, { persistent: false }, scheduleChange);
    watcher.on('error', function (error) {
      lastError = String((error && error.message) || error || '目录监听失败').slice(0, 500);
      active = false;
    });
    watchers.push(watcher);
  }

  async function enable(dir) {
    const validation = await validateDirectory(String(dir || ''));
    const root = path.resolve(validation.dir);
    const watchDirs = Array.from(new Set([root, path.resolve(validation.chunksDir || root)]));
    closeWatchers();
    try {
      for (const watchDir of watchDirs) attachWatcher(watchDir);
    } catch (error) {
      closeWatchers();
      throw error;
    }
    config.enabled = true;
    config.dir = root;
    active = true;
    lastError = '';
    await persist();
    return status();
  }

  async function restore() {
    try {
      const raw = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
      config = {
        enabled: raw && raw.enabled === true,
        dir: raw && typeof raw.dir === 'string' ? raw.dir : '',
        lastSyncAt: raw && typeof raw.lastSyncAt === 'string' ? raw.lastSyncAt : '',
        lastAdded: Math.max(0, Number(raw && raw.lastAdded) || 0)
      };
    } catch (error) {
      if (!error || error.code !== 'ENOENT') lastError = '自动同步配置读取失败';
      return status();
    }
    if (!config.enabled || !config.dir) return status();
    try {
      return await enable(config.dir);
    } catch (error) {
      closeWatchers();
      lastError = String((error && error.message) || error || '自动同步目录不可用').slice(0, 500);
      return status();
    }
  }

  async function disable() {
    closeWatchers();
    config.enabled = false;
    lastError = '';
    await persist();
    return status();
  }

  async function report(result) {
    if (result && result.ok) {
      config.lastSyncAt = new Date().toISOString();
      config.lastAdded = Math.max(0, Number(result.added) || 0);
      lastError = '';
    } else {
      lastError = String((result && result.reason) || '自动同步失败').slice(0, 500);
    }
    await persist().catch(function () {});
    return status();
  }

  return { enable, restore, disable, report, status, close: closeWatchers };
}

module.exports = { createQQChatAutoSyncService };
