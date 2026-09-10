'use strict';

const MIN_INTERVAL_HOURS = 6;
const MAX_INTERVAL_HOURS = 168;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MANUAL_COOLDOWN_MS = 30 * 60 * 1000;

function normalizeLoopbackEndpoint(value) {
  let parsed;
  try { parsed = new URL(String(value || 'http://127.0.0.1:40653').trim()); }
  catch { throw new Error('QCE 地址格式无效'); }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    throw new Error('QCE 地址仅允许本机 HTTP 回环地址');
  }
  if (parsed.username || parsed.password || (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error('QCE 地址不能包含凭据、路径或查询参数');
  }
  return parsed.origin;
}

function normalizeConfig(raw, path) {
  raw = raw || {};
  const ids = Array.isArray(raw.scheduleIds)
    ? Array.from(new Set(raw.scheduleIds.map(String).map(value => value.trim()).filter(value => /^[\w.-]{1,128}$/.test(value)))).slice(0, 100)
    : [];
  const intervalHours = Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, Number(raw.intervalHours) || 24));
  return {
    enabled: raw.enabled === true,
    mode: raw.mode === 'trigger' ? 'trigger' : 'native',
    endpoint: normalizeLoopbackEndpoint(raw.endpoint),
    outputRoot: raw.outputRoot ? path.resolve(String(raw.outputRoot)) : '',
    scheduleIds: ids,
    intervalHours,
    lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : '',
    nextRunAt: typeof raw.nextRunAt === 'string' ? raw.nextRunAt : '',
    failureCount: Math.max(0, Math.min(10, Number(raw.failureCount) || 0)),
    processed: raw.processed && typeof raw.processed === 'object' ? raw.processed : {}
  };
}

function qceHttpRequest({ http, endpoint, method, route, token, body, timeoutMs }) {
  return new Promise(function (resolve, reject) {
    const target = new URL(route, endpoint);
    const payload = body == null ? '' : JSON.stringify(body);
    const headers = { Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (token) headers.Authorization = 'Bearer ' + token;
    const request = http.request(target, { method: method || 'GET', headers }, function (response) {
      const chunks = [];
      let size = 0;
      response.on('data', function (chunk) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          request.destroy(new Error('QCE 响应过大'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', function () {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
        catch { reject(new Error('QCE 返回了无效 JSON')); return; }
        if ((response.statusCode || 500) >= 400 || parsed.success === false) {
          const message = parsed?.error?.message || parsed?.message || ('QCE 请求失败（HTTP ' + response.statusCode + '）');
          reject(new Error(String(message).slice(0, 500)));
          return;
        }
        resolve(parsed && Object.prototype.hasOwnProperty.call(parsed, 'data') ? parsed.data : parsed);
      });
    });
    request.setTimeout(Math.max(3000, Number(timeoutMs) || 15000), function () { request.destroy(new Error('QCE 连接超时')); });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function createQQChatExporterIntegration(options) {
  const fs = options.fs;
  const path = options.path;
  const http = options.http;
  const configPath = options.configPath;
  const validateOutputRoot = options.validateOutputRoot;
  const getToken = options.getToken;
  const onExports = options.onExports;
  const requestJson = options.requestJson || (args => qceHttpRequest(Object.assign({ http }, args)));
  let config = normalizeConfig({}, path);
  let watcher = null;
  let scanTimer = null;
  let runTimer = null;
  let running = false;
  let lastError = '';
  const pending = new Map();

  function publicStatus() {
    return {
      enabled: config.enabled,
      mode: config.mode,
      endpoint: config.endpoint,
      outputRoot: config.outputRoot,
      scheduleIds: config.scheduleIds.slice(),
      intervalHours: config.intervalHours,
      lastRunAt: config.lastRunAt,
      nextRunAt: config.nextRunAt,
      failureCount: config.failureCount,
      running,
      lastError
    };
  }

  async function persist() {
    const processedEntries = Object.entries(config.processed || {}).slice(-500);
    config.processed = Object.fromEntries(processedEntries);
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    await fs.promises.writeFile(configPath, JSON.stringify(Object.assign({ version: 1 }, config), null, 2), 'utf8');
  }

  function stopTimersAndWatcher() {
    if (scanTimer) clearTimeout(scanTimer);
    if (runTimer) clearTimeout(runTimer);
    scanTimer = null;
    runTimer = null;
    if (watcher) { try { watcher.close(); } catch (e) {} }
    watcher = null;
  }

  function scheduleScan(delayMs) {
    if (!config.enabled || !config.outputRoot) return;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(function () {
      scanTimer = null;
      scanExports().catch(function (error) { lastError = String((error && error.message) || error).slice(0, 500); });
    }, Math.max(1000, Number(delayMs) || 5000));
  }

  function attachWatcher() {
    if (watcher) { try { watcher.close(); } catch (e) {} }
    watcher = null;
    if (!config.enabled || !config.outputRoot) return;
    try {
      watcher = fs.watch(config.outputRoot, { persistent: false, recursive: process.platform === 'win32' || process.platform === 'darwin' }, function () {
        scheduleScan(5000);
      });
      watcher.on('error', function (error) { lastError = String((error && error.message) || error).slice(0, 500); });
    } catch (error) {
      lastError = String((error && error.message) || error).slice(0, 500);
    }
  }

  function nextDelayMs() {
    const base = config.intervalHours * 60 * 60 * 1000;
    return Math.min(14 * 24 * 60 * 60 * 1000, base * Math.pow(2, config.failureCount));
  }

  function scheduleRun() {
    if (runTimer) clearTimeout(runTimer);
    runTimer = null;
    if (!config.enabled || config.mode !== 'trigger') { config.nextRunAt = ''; return; }
    const last = Date.parse(config.lastRunAt) || Date.now();
    const due = Math.max(Date.now() + 60000, last + nextDelayMs());
    config.nextRunAt = new Date(due).toISOString();
    runTimer = setTimeout(function () { runNow(false).catch(function () {}); }, Math.min(2147483647, due - Date.now()));
  }

  async function scanExports() {
    const root = config.outputRoot;
    if (!root) return [];
    const found = [];
    let entriesSeen = 0;
    async function walk(dir, depth) {
      if (depth > 6 || entriesSeen > 5000) return;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (++entriesSeen > 5000 || entry.name.startsWith('.')) break;
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') continue;
        let stat;
        try { stat = await fs.promises.lstat(full); } catch { continue; }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_JSON_BYTES || Date.now() - stat.mtimeMs < 5000) continue;
        const signature = stat.size + ':' + Math.floor(stat.mtimeMs);
        if (config.processed[full] === signature || pending.get(full) === signature) continue;
        found.push({ path: full, name: entry.name, size: stat.size, mtime: stat.mtime.toISOString(), signature });
      }
    }
    await walk(root, 0);
    found.sort((a, b) => String(a.mtime).localeCompare(String(b.mtime)));
    const selected = found.slice(0, 50);
    for (const file of selected) pending.set(file.path, file.signature);
    if (selected.length) await Promise.resolve(onExports(selected.map(function (file) {
      return { path: file.path, name: file.name, size: file.size, mtime: file.mtime };
    })));
    return selected;
  }

  async function readExport(filePath) {
    const requested = path.resolve(String(filePath || ''));
    const root = await fs.promises.realpath(config.outputRoot);
    const real = await fs.promises.realpath(requested);
    const relative = path.relative(root, real);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QCE 导出文件不在已授权目录内');
    const stat = await fs.promises.lstat(requested);
    if (!stat.isFile() || stat.isSymbolicLink() || path.extname(real).toLowerCase() !== '.json' || stat.size > MAX_JSON_BYTES) {
      throw new Error('QCE 导出文件类型或大小无效');
    }
    const json = JSON.parse(await fs.promises.readFile(real, 'utf8'));
    if (!json || !json.chatInfo || !Array.isArray(json.messages)) throw new Error('不是有效的 QCE JSON 聊天导出');
    return { filePath: requested, json };
  }

  async function acknowledge(filePath, ok) {
    const requested = path.resolve(String(filePath || ''));
    const signature = pending.get(requested);
    pending.delete(requested);
    if (ok && signature) {
      config.processed[requested] = signature;
      await persist();
    } else if (!ok) {
      scheduleScan(60000);
    }
    return publicStatus();
  }

  async function token() {
    const value = String(await getToken() || '').trim();
    if (!value) throw new Error('请先填写 QCE Access Token');
    return value;
  }

  async function testConnection(endpoint) {
    const target = normalizeLoopbackEndpoint(endpoint || config.endpoint);
    const accessToken = await token();
    return requestJson({ endpoint: target, method: 'POST', route: '/auth', body: { token: accessToken }, timeoutMs: 10000 });
  }

  async function listSchedules(endpoint) {
    const target = normalizeLoopbackEndpoint(endpoint || config.endpoint);
    const data = await requestJson({ endpoint: target, method: 'GET', route: '/api/scheduled-exports', token: await token(), timeoutMs: 15000 });
    return Array.isArray(data?.scheduledExports) ? data.scheduledExports : (Array.isArray(data) ? data : []);
  }

  async function runNow(manual) {
    if (running) return { ok: false, reason: 'QCE 导出任务正在触发中', status: publicStatus() };
    if (!config.enabled || config.mode !== 'trigger') return { ok: false, reason: '当前不是低频触发模式', status: publicStatus() };
    if (!config.scheduleIds.length) return { ok: false, reason: '未选择 QCE 定时导出任务', status: publicStatus() };
    const elapsed = Date.now() - (Date.parse(config.lastRunAt) || 0);
    if (manual && config.lastRunAt && elapsed < MANUAL_COOLDOWN_MS) {
      return { ok: false, reason: '为减少访问频率，手动触发需间隔至少 30 分钟', status: publicStatus() };
    }
    running = true;
    try {
      const data = await requestJson({
        endpoint: config.endpoint,
        method: 'POST',
        route: '/api/scheduled-exports/trigger-batch',
        token: await token(),
        body: { ids: config.scheduleIds },
        timeoutMs: 20000
      });
      config.lastRunAt = new Date().toISOString();
      config.failureCount = 0;
      lastError = '';
      scheduleScan(30000);
      scheduleRun();
      await persist();
      running = false;
      return { ok: true, data, status: publicStatus() };
    } catch (error) {
      config.lastRunAt = new Date().toISOString();
      config.failureCount = Math.min(10, config.failureCount + 1);
      lastError = String((error && error.message) || error).slice(0, 500);
      scheduleRun();
      await persist().catch(function () {});
      running = false;
      return { ok: false, reason: lastError, status: publicStatus(), manual: !!manual };
    } finally {
      running = false;
    }
  }

  async function configure(raw) {
    const next = normalizeConfig(Object.assign({}, config, raw, { enabled: true }), path);
    if (!next.outputRoot) throw new Error('请选择 QCE JSON 导出目录');
    const validated = await validateOutputRoot(next.outputRoot);
    next.outputRoot = path.resolve(validated.dir);
    if (next.mode === 'trigger' && !next.scheduleIds.length) throw new Error('低频触发模式至少需要选择一个 QCE 计划任务');
    config = next;
    lastError = '';
    stopTimersAndWatcher();
    attachWatcher();
    scheduleRun();
    await persist();
    scheduleScan(1500);
    return publicStatus();
  }

  async function restore() {
    try { config = normalizeConfig(JSON.parse(await fs.promises.readFile(configPath, 'utf8')), path); }
    catch (error) {
      if (!error || error.code !== 'ENOENT') lastError = 'QCE 整合配置读取失败';
      return publicStatus();
    }
    if (!config.enabled || !config.outputRoot) return publicStatus();
    try { await validateOutputRoot(config.outputRoot); }
    catch (error) { lastError = String((error && error.message) || error).slice(0, 500); return publicStatus(); }
    attachWatcher();
    scheduleRun();
    scheduleScan(3000);
    return publicStatus();
  }

  async function disable() {
    stopTimersAndWatcher();
    config.enabled = false;
    config.nextRunAt = '';
    await persist();
    return publicStatus();
  }

  return { acknowledge, configure, disable, listSchedules, publicStatus, readExport, restore, runNow, scanExports, testConnection, close: stopTimersAndWatcher };
}

module.exports = {
  MAX_JSON_BYTES,
  MAX_INTERVAL_HOURS,
  MIN_INTERVAL_HOURS,
  createQQChatExporterIntegration,
  normalizeConfig,
  normalizeLoopbackEndpoint,
  qceHttpRequest
};
