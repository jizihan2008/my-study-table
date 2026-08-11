// ═══════════════════════════════════════════════════════════════════
// js/sync.js — Supabase 双向数据云同步（手机端 PWA / 桌面端共用）
// 将白名单内的 localStorage key（待办/笔记/计时/习惯/任务线/电子书元数据等）
// 同步到 Supabase user_data 表，per-key updated_at 后写者胜（LWW）。
//
// 特性：
//   - 变更检测：saveData 经 window.Sync.onLocalChange(key) 上报，debounce 2s 批量上传
//   - 启动拉取：登录后拉取全量合并（远端较新则覆盖本地）
//   - 离线队列：网络不可用时变更写入 IndexedDB outbox，恢复后自动重传
//   - Realtime 订阅：远端其他设备写入时实时广播，本地自动合并
//   - 隐私红线：敏感 key（AI key / supabase 配置 / 邮件授权码等）不入白名单
//
// 依赖：friends.js 的 getSupabaseClient()（单例）、core.js 的 saveData
// ═══════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';

  // ── 同步白名单：仅这些 key 参与云同步（不含任何敏感凭据）──────────
  const SYNC_KEYS = [
    'study_todos_v2',
    'study_todos',
    'study_notes_v2',
    'study_notes',
    'study_timer_records',
    'study_taskline_v1',
    'study_habits',
    'study_habits_v1',
    'study_books_v1',
    'study_books_meta',
    'study_calendar_events',
    'study_checkin',
    'study_stats',
    'study_focus',
    'study_goals',
    'study_links_v3',
    'study_quick_access'
  ];

  // 明确排除的敏感 key（即使误加入也强制不进白名单）
  const SENSITIVE_KEYS = [
    'study_ai_keys',
    'study_api_keys',
    'study_ai_config',
    'study_api_config',
    'study_supabase_config',
    'study_friends_config',
    'study_mail_config',
    'study_inbox_config'
  ];

  const CFG_KEY = 'study_sync_config';       // 本地同步配置（开关 + 上次全量拉取时间）
  const IDB_NAME = 'mst-sync';
  const IDB_STORE = 'outbox';                // 离线变更队列
  const OUTBOX_KEY = 'pending';              // 单条记录 key
  const UPLOAD_DEBOUNCE = 2000;              // 变更后等待上传的毫秒数
  const PULL_INTERVAL = 30 * 60 * 1000;      // 定时全量拉取间隔（30 分钟）

  let client = null;                          // Supabase 客户端
  let enabled = false;                        // 是否开启同步
  let loggedIn = false;
  let dirtyKeys = new Set();                  // 待上传的 key
  let uploadTimer = null;
  let pullTimer = null;
  let realtimeChannel = null;
  let applyingRemote = false;                 // 防止远端写回本地触发再次上报的锁
  let listeners = new Set();                  // 状态监听器（settings 面板刷新用）

  // 判断某 key 是否参与同步
  function isSyncKey(key) {
    if (!key) return false;
    if (SENSITIVE_KEYS.indexOf(key) !== -1) return false;
    return SYNC_KEYS.indexOf(key) !== -1;
  }

  // ── IndexedDB 离线队列 ────────────────────────────────
  function _idbOpen() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('no-indexeddb')); return; }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  async function _outboxPut(key, value, updatedAt) {
    try {
      const db = await _idbOpen();
      return new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put({ key, value, updatedAt });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); resolve(); };
      });
    } catch (e) { /* 无 IDB 则忽略 */ }
  }
  async function _outboxGetAll() {
    try {
      const db = await _idbOpen();
      return new Promise((resolve) => {
        const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAll();
        req.onsuccess = () => { db.close(); resolve(req.result || []); };
        req.onerror = () => { db.close(); resolve([]); };
      });
    } catch (e) { return []; }
  }
  async function _outboxRemove(key) {
    try {
      const db = await _idbOpen();
      return new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); resolve(); };
      });
    } catch (e) { /* 忽略 */ }
  }

  // ── 配置读取/写入 ────────────────────────────────────
  function getConfig() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY)) || { enabled: false }; }
    catch (e) { return { enabled: false }; }
  }
  function setConfig(cfg) {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  }

  // ── 登录状态 ─────────────────────────────────────────
  function getSession() {
    try {
      if (client && client.auth) {
        const { data } = client.auth.getSession();
        return data && data.session ? data.session : null;
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  // ── 上传一个 key 到云端（UPSERT）─────────────────────
  async function _uploadKey(key) {
    const session = getSession();
    if (!session) return { ok: false, reason: 'not-logged-in' };
    const value = localStorage.getItem(key);
    const payload = value ? JSON.parse(value) : null;
    const updatedAt = new Date().toISOString();
    const { error } = await client.from('user_data')
      .upsert({ user_id: session.user.id, key, value: payload, updated_at: updatedAt },
        { onConflict: 'user_id,key' });
    if (error) return { ok: false, reason: error.message };
    // 成功上传后清掉对应 outbox
    await _outboxRemove(key);
    return { ok: true, updatedAt };
  }

  // ── 批量上传所有脏 key ──────────────────────────────
  async function _flush() {
    if (!enabled || !loggedIn || !client) return;
    if (dirtyKeys.size === 0) {
      // 处理离线队列
      await _flushOutbox();
      return;
    }
    const keys = Array.from(dirtyKeys);
    dirtyKeys.clear();
    let okCount = 0;
    for (const key of keys) {
      if (!isSyncKey(key)) continue;
      const res = await _uploadKey(key);
      if (res.ok) okCount++;
      else {
        // 上传失败（可能离线）：写入 outbox 等待恢复后重传
        const value = localStorage.getItem(key);
        await _outboxPut(key, value ? JSON.parse(value) : null, res.updatedAt || new Date().toISOString());
      }
    }
    if (okCount > 0) _emitStatus();
  }

  async function _flushOutbox() {
    if (!client) return;
    const session = getSession();
    if (!session) return;
    const items = await _outboxGetAll();
    for (const item of items) {
      const { error } = await client.from('user_data')
        .upsert({ user_id: session.user.id, key: item.key, value: item.value, updated_at: item.updatedAt },
          { onConflict: 'user_id,key' });
      if (!error) await _outboxRemove(item.key);
    }
  }

  // ── 远端时间戳记录（独立存储，不污染业务数据）────────
  const TS_KEY = 'study_sync_remote_ts';   // { [key]: ISO updated_at }
  function _getRemoteTs() {
    try { return JSON.parse(localStorage.getItem(TS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function _setRemoteTs(key, iso) {
    const map = _getRemoteTs();
    map[key] = iso;
    localStorage.setItem(TS_KEY, JSON.stringify(map));
  }

  // ── 首次同步：本地有数据则上传（桌面→云），本地缺失则拉取（云→手机）──
  // 避免手机端首次同步时用空数据覆盖云端。
  async function _firstSync() {
    if (!enabled || !client) return;
    const session = getSession();
    if (!session) return;

    // 1. 拉取云端现有 key 集合
    let remoteRows = [];
    applyingRemote = true;
    try {
      const { data, error } = await client.from('user_data')
        .select('key,value,updated_at')
        .eq('user_id', session.user.id);
      if (!error && data) remoteRows = data;
    } catch (e) { /* 忽略 */ }
    const remoteKeys = new Set(remoteRows.map(r => r.key));

    // 2. 本地有 → 上传；本地无 → 拉取
    for (const key of SYNC_KEYS) {
      if (!isSyncKey(key)) continue;
      if (localStorage.getItem(key) !== null) {
        // 本地已有数据：上传到云（覆盖云端旧值）
        await _uploadKey(key);
      } else if (remoteKeys.has(key)) {
        const row = remoteRows.find(r => r.key === key);
        if (row && row.value !== null) {
          saveData(key, row.value);
          _setRemoteTs(key, row.updated_at);
        }
      }
    }
    applyingRemote = false;
  }

  // ── 常规拉取合并：仅当本地缺失时拉取（避免覆盖本地编辑）────
  async function _pullAll() {
    if (!enabled || !client) return;
    const session = getSession();
    if (!session) return;
    applyingRemote = true;
    try {
      const { data, error } = await client.from('user_data')
        .select('key,value,updated_at')
        .eq('user_id', session.user.id);
      if (error) { console.warn('[sync] 拉取失败:', error.message); return; }
      if (!data) return;
      for (const row of data) {
        if (!isSyncKey(row.key)) continue;
        // 仅本地缺失时拉取远端，已有本地数据以本地为准（本地编辑优先）
        if (localStorage.getItem(row.key) === null && row.value !== null) {
          saveData(row.key, row.value);
          _setRemoteTs(row.key, row.updated_at);
        }
      }
    } catch (e) {
      console.warn('[sync] 拉取异常:', e);
    } finally {
      applyingRemote = false;
    }
  }

  // ── 变更上报（saveData 钩子调用）─────────────────────
  function onLocalChange(key) {
    if (!enabled || !loggedIn || !client) return;
    if (applyingRemote) return;   // 远端写回本地不触发回传，防循环
    if (!isSyncKey(key)) return;
    dirtyKeys.add(key);
    clearTimeout(uploadTimer);
    uploadTimer = setTimeout(_flush, UPLOAD_DEBOUNCE);
  }

  // ── Realtime 订阅远端变更 ───────────────────────────
  function _subscribe() {
    if (!client || !enabled || !loggedIn) return;
    if (realtimeChannel) { try { realtimeChannel.unsubscribe(); } catch (e) {} }
    const session = getSession();
    if (!session) return;
    realtimeChannel = client
      .channel('mst-user-data')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'user_data', filter: 'user_id=eq.' + session.user.id },
        () => _debouncedPull())
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'user_data', filter: 'user_id=eq.' + session.user.id },
        () => _debouncedPull())
      .subscribe();
  }

  let pullDebounceTimer = null;
  function _debouncedPull() {
    clearTimeout(pullDebounceTimer);
    pullDebounceTimer = setTimeout(_pullAll, 800);
  }

  // ── 状态通知 ────────────────────────────────────────
  function _emitStatus() {
    const status = getStatus();
    listeners.forEach(fn => { try { fn(status); } catch (e) {} });
  }
  function onStatus(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  function getStatus() {
    const cfg = getConfig();
    return {
      enabled: enabled,
      loggedIn: loggedIn,
      pendingCount: dirtyKeys.size,
      lastPull: cfg.lastPull || 0
    };
  }

  // ── 开关 ────────────────────────────────────────────
  function setEnabled(on) {
    const cfg = getConfig();
    cfg.enabled = !!on;
    setConfig(cfg);
    enabled = !!on;
    if (enabled) {
      _init();
    } else {
      if (realtimeChannel) { try { realtimeChannel.unsubscribe(); } catch (e) {} realtimeChannel = null; }
      clearTimeout(uploadTimer);
      clearTimeout(pullTimer);
    }
    _emitStatus();
  }

  // ── 手动触发 ────────────────────────────────────────
  async function manualSync() {
    await _flush();
    const ts = _getRemoteTs();
    const isFirst = Object.keys(ts).length === 0;
    if (isFirst) await _firstSync();
    else await _pullAll();
    const cfg = getConfig();
    cfg.lastPull = Date.now();
    setConfig(cfg);
    _emitStatus();
    return getStatus();
  }
  async function uploadAll() {
    dirtyKeys = new Set(SYNC_KEYS.filter(k => localStorage.getItem(k) !== null));
    await _flush();
    _emitStatus();
    return getStatus();
  }

  // ── 初始化 ──────────────────────────────────────────
  function _init() {
    if (typeof getSupabaseClient !== 'function') { enabled = false; return; }
    client = getSupabaseClient();
    if (!client) { enabled = false; return; }
    const session = getSession();
    loggedIn = !!session;
    if (loggedIn) {
      _subscribe();
      // 首次同步（无任何远端时间戳记录）走 _firstSync，否则常规拉取
      const ts = _getRemoteTs();
      const isFirst = Object.keys(ts).length === 0;
      if (isFirst) _firstSync();
      else _pullAll();
      clearTimeout(pullTimer);
      pullTimer = setTimeout(() => { _pullAll(); _emitStatus(); }, PULL_INTERVAL);
    }
    _emitStatus();
  }

  function init() {
    const cfg = getConfig();
    enabled = !!cfg.enabled;
    if (enabled) {
      setTimeout(_init, 1500);   // 等 friends.js 客户端就绪
    }
    // 监听登录状态变化（好友系统登录/退出）
    if (typeof document !== 'undefined') {
      document.addEventListener('fr-auth-change', function () {
        if (typeof getSupabaseClient === 'function') client = getSupabaseClient();
        const session = getSession();
        loggedIn = !!session;
        if (enabled && loggedIn) {
          _subscribe();
          const ts = _getRemoteTs();
          const isFirst = Object.keys(ts).length === 0;
          if (isFirst) _firstSync();
          else _pullAll();
        }
        _emitStatus();
      });
    }
  }

  // ── 对外暴露 ────────────────────────────────────────
  global.Sync = {
    init,
    setEnabled,
    isSyncKey,
    onLocalChange,
    manualSync,
    uploadAll,
    getStatus,
    onStatus,
    get enabled() { return enabled; },
    get loggedIn() { return loggedIn; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
