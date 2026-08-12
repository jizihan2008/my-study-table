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
    'study_todos_v2',          // 待办事项（当前版）
    'study_todos',             // 待办（旧版备份）
    'study_notes_v2',          // 笔记（当前版）
    'study_notes',             // 笔记（旧版备份）
    'study_notes_folders',     // 笔记文件夹结构
    'study_timer_records',     // 专注计时记录
    'study_taskline_v1',       // 任务线（学习任务进度）
    'study_habits',            // 习惯打卡（当前版）
    'study_habits_v1',         // 习惯打卡（旧版）
    'study_books_v1',          // 教材书架
    'study_books_meta',        // 教材元数据
    'study_calendar_events',   // 日历事件
    'study_checkin',           // 打卡记录
    'study_stats',             // 学习统计
    'study_today_focus',       // 今日聚焦（实际存储 key）
    'study_longterm_goals',    // 长期目标（实际存储 key）
    'study_links_v3',          // 快捷链接
    'study_quick_access',      // 快捷访问
    'study_ai_convs',          // AI 助手聊天记录（跨设备查看历史对话）
    'study_ai_memory',         // AI 记忆画像
    'study_bk_explain_logs_v1',// 教材章节讲解日志
    'study_bk_quiz_state_v1',  // 教材测验状态
    'study_todo_completed_log' // 待办完成日志（历史完成记录）
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

  // 同步数据在冲突弹窗中显示的可读名称
  const SYNC_LABELS = {
    'study_todos_v2': '待办事项',
    'study_todos': '待办事项（旧版）',
    'study_notes_v2': '笔记',
    'study_notes': '笔记（旧版）',
    'study_notes_folders': '笔记文件夹',
    'study_timer_records': '计时记录',
    'study_taskline_v1': '任务线',
    'study_habits': '习惯打卡',
    'study_habits_v1': '习惯打卡（旧版）',
    'study_books_v1': '教材书架',
    'study_books_meta': '教材元数据',
    'study_calendar_events': '日历事件',
    'study_checkin': '打卡记录',
    'study_stats': '学习统计',
    'study_today_focus': '今日聚焦',
    'study_longterm_goals': '长期目标',
    'study_links_v3': '快捷链接',
    'study_quick_access': '快捷访问',
    'study_ai_convs': 'AI 助手聊天记录',
    'study_ai_memory': 'AI 记忆画像',
    'study_bk_explain_logs_v1': '教材讲解日志',
    'study_bk_quiz_state_v1': '教材测验状态',
    'study_todo_completed_log': '待办完成日志'
  };

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

  // 判断本地存储值是否为「空」：空数组 / 空对象 / 空字符串 / null。
  // 用于防止「本地是空占位（如 []）」时误上传覆盖云端的真实数据。
  function _isEmptyLocalValue(key) {
    const raw = localStorage.getItem(key);
    if (raw === null) return true;
    const trimmed = raw.trim();
    if (trimmed === '' ) return true;
    try {
      const v = JSON.parse(trimmed);
      if (v === null) return true;
      if (Array.isArray(v)) return v.length === 0;
      if (typeof v === 'object') return Object.keys(v).length === 0;
      return String(v).trim() === '';
    } catch (e) {
      return trimmed === '';
    }
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
    try {
      const cfg = JSON.parse(localStorage.getItem(CFG_KEY)) || {};
      // 默认开启云同步：新用户开箱即用（登录后自动同步）。未显式设置过开关时视为开启。
      if (typeof cfg.enabled !== 'boolean') cfg.enabled = true;
      return cfg;
    } catch (e) { return { enabled: true }; }
  }
  function setConfig(cfg) {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  }

  // ── 登录状态 ─────────────────────────────────────────
  // supabase-js v2 的 auth.getSession() 在 session 已加载时同步返回对象，
  // 在需要从 storage 异步恢复时返回 Promise。必须兼容两者，故统一 await。
  async function getSession() {
    try {
      // 每次实时获取单例客户端，避免 init() 时配置未就绪导致 client 为 null
      const supabaseClient = (typeof getSupabaseClient === 'function') ? getSupabaseClient() : client;
      if (supabaseClient && supabaseClient.auth) {
        let res = supabaseClient.auth.getSession();
        if (res && typeof res.then === 'function') res = await res;
        const data = res && res.data ? res.data : null;
        return data && data.session ? data.session : null;
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  // 实时获取 Supabase 单例客户端（避免 init() 时序问题）
  function _client() {
    if (typeof getSupabaseClient === 'function') {
      const c = getSupabaseClient();
      if (c) { client = c; return c; }
    }
    return client;
  }

  // ── 上传一个 key 到云端（UPSERT）─────────────────────
  async function _uploadKey(key) {
    const session = await getSession();
    if (!session) return { ok: false, reason: 'not-logged-in' };
    const c = _client();
    if (!c) return { ok: false, reason: 'no-client' };
    const value = localStorage.getItem(key);
    const payload = value ? JSON.parse(value) : null;
    const updatedAt = new Date().toISOString();
    const { error } = await c.from('user_data')
      .upsert({ user_id: session.user.id, key, value: payload, updated_at: updatedAt },
        { onConflict: 'user_id,key' });
    if (error) return { ok: false, reason: error.message };
    // 成功上传后清掉对应 outbox
    await _outboxRemove(key);
    // 同步本地与云端时间戳，标记该 key 本地已是最新（避免 _pullAll 误判云端旧而反复上传）
    _setRemoteTs(key, updatedAt);
    _setLocalTs(key, updatedAt);
    return { ok: true, updatedAt };
  }

  // ── 批量上传所有脏 key ──────────────────────────────
  async function _flush() {
    if (!enabled || !loggedIn || !_client()) return;
    if (dirtyKeys.size === 0) {
      // 处理离线队列
      await _flushOutbox();
      return;
    }
    const keys = Array.from(dirtyKeys);
    dirtyKeys.clear();
    let okCount = 0;
    const total = keys.filter(k => isSyncKey(k)).length || 1;
    let done = 0;
    for (const key of keys) {
      if (!isSyncKey(key)) continue;
      _emitProgress({ active: true, phase: 'upload', current: done + 1, total: total, key: key, label: SYNC_LABELS[key] || key });
      const res = await _uploadKey(key);
      if (res.ok) okCount++;
      else {
        // 上传失败（可能离线）：写入 outbox 等待恢复后重传
        const value = localStorage.getItem(key);
        await _outboxPut(key, value ? JSON.parse(value) : null, res.updatedAt || new Date().toISOString());
      }
      done++;
    }
    if (okCount > 0) _emitStatus();
    _emitProgress({ active: false, phase: 'idle', current: 0, total: 0, key: '', label: '' });
  }

  async function _flushOutbox() {
    if (!_client()) return;
    const session = await getSession();
    if (!session) return;
    const c = _client();
    if (!c) return;
    const items = await _outboxGetAll();
    for (const item of items) {
      const { error } = await c.from('user_data')
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
  // ── 本地修改时间戳（Steam 云存档式「谁新用谁」合并用）──
  // { [key]: ISO 本地最后修改时间 }
  const LOCAL_TS_KEY = 'study_sync_local_ts';
  function _getLocalTs() {
    try { return JSON.parse(localStorage.getItem(LOCAL_TS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function _setLocalTs(key, iso) {
    const map = _getLocalTs();
    map[key] = iso;
    localStorage.setItem(LOCAL_TS_KEY, JSON.stringify(map));
  }
  function _delLocalTs(key) {
    const map = _getLocalTs();
    if (key in map) { delete map[key]; localStorage.setItem(LOCAL_TS_KEY, JSON.stringify(map)); }
  }
  // 冲突队列：本次拉取中「两端都改过」的 key（Steam 式用户决策）
  let _conflictQueue = [];
  let _resolvingConflict = false;   // 弹窗互斥锁，避免多个冲突弹窗叠加

  // ── 首次同步：本地有数据则上传（桌面→云），本地缺失则拉取（云→手机）──
  // 避免手机端首次同步时用空数据覆盖云端。
  async function _firstSync() {
    if (!enabled || !_client()) return;
    const session = await getSession();
    if (!session) return;
    const c = _client();
    if (!c) return;

    // 1. 拉取云端现有 key 集合
    let remoteRows = [];
    applyingRemote = true;
    try {
      const { data, error } = await c.from('user_data')
        .select('key,value,updated_at')
        .eq('user_id', session.user.id);
      if (!error && data) remoteRows = data;
    } catch (e) { /* 忽略 */ }

    // 2. 合并策略：云端有非空数据且本地为空 → 拉取云端；
    //    本地有真实数据 → 上传；本地与云端都空 → 跳过（不产生空占位覆盖）
    const firstKeys = SYNC_KEYS.filter(k => isSyncKey(k));
    const firstTotal = firstKeys.length || 1;
    let firstDone = 0;
    for (const key of firstKeys) {
      firstDone++;
      _emitProgress({ active: true, phase: 'first', current: firstDone, total: firstTotal, key: key, label: SYNC_LABELS[key] || key });
      const localEmpty = _isEmptyLocalValue(key);
      const remoteRow = remoteRows.find(r => r.key === key);
      const remoteHasData = remoteRow && remoteRow.value !== null &&
        !(Array.isArray(remoteRow.value) && remoteRow.value.length === 0) &&
        !(remoteRow.value && typeof remoteRow.value === 'object' && !Array.isArray(remoteRow.value) && Object.keys(remoteRow.value).length === 0);

      if (localEmpty && remoteHasData) {
        // 本地空、云端有数据 → 拉取云端（避免用本地空数组覆盖云端真实笔记）
        saveData(key, remoteRow.value);
        _setRemoteTs(key, remoteRow.updated_at);
        _setLocalTs(key, remoteRow.updated_at);
      } else if (!localEmpty) {
        // 本地有真实数据 → 上传到云（覆盖云端旧值）
        await _uploadKey(key);
      }
      // 本地空 且 云端也空/无记录 → 跳过（不产生任何写入）
    }
    applyingRemote = false;
    _refreshUI();
    _emitProgress({ active: false, phase: 'idle', current: 0, total: 0, key: '', label: '' });
  }

  // ── 常规拉取合并：仅当本地缺失时拉取（避免覆盖本地编辑）────
  async function _pullAll() {
    if (!enabled || !_client()) return;
    const session = await getSession();
    if (!session) return;
    const c = _client();
    if (!c) return;
    applyingRemote = true;
    try {
      const { data, error } = await c.from('user_data')
        .select('key,value,updated_at')
        .eq('user_id', session.user.id);
      if (error) { console.warn('[sync] 拉取失败:', error.message); return; }
      if (!data) return;
      _conflictQueue = [];
      const syncRows = data.filter(r => isSyncKey(r.key));
      const pullTotal = syncRows.length || 1;
      let pullDone = 0;
      for (const row of syncRows) {
        pullDone++;
        _emitProgress({ active: true, phase: 'pull', current: pullDone, total: pullTotal, key: row.key, label: SYNC_LABELS[row.key] || row.key });
        // Steam 云存档式合并：「谁新用谁」。
        // 云端比本地新（或本地缺失）→ 拉取覆盖本地；云端比本地旧 → 保留本地（等待本地上传）。
        // 若两端「在上次同步后都改过」（真冲突），则收集起来交由用户选择（见 _resolveConflicts）。
        const localTs = _getLocalTs()[row.key];          // 本地最后修改时间（ISO，可能为空）
        const remoteTs = row.updated_at;                  // 云端更新时间（ISO）
        const localEmpty = _isEmptyLocalValue(row.key);   // 本地缺失或为空占位（如 []）
        const remoteEmpty = row.value === null ||
          (Array.isArray(row.value) && row.value.length === 0) ||
          (row.value && typeof row.value === 'object' && !Array.isArray(row.value) && Object.keys(row.value).length === 0);
        const remoteHasData = !remoteEmpty;

        if (localEmpty && remoteHasData) {
          // 本地空 + 云端有数据 → 拉取云端
          saveData(row.key, row.value);
          _setRemoteTs(row.key, row.updated_at);
          _setLocalTs(row.key, row.updated_at);
        } else if (!localEmpty && !remoteHasData) {
          // 本地有真实数据 + 云端空 → 保留本地，并确保稍后上传到云端
          dirtyKeys.add(row.key);
        } else if (!localEmpty && remoteHasData) {
          // 两端都有真实数据 → 谁新用谁。关键安全规则：
          // 本地有真实数据但「无本地时间戳」（如从备份恢复，study_sync_local_ts 不含该 key）时，
          // 绝不盲目用云端覆盖——视为「本地待保护」，优先上传本地，避免云端旧/空数据清空本地。
          if (localTs && remoteTs) {
            if (new Date(remoteTs).getTime() > new Date(localTs).getTime()) {
              // 云端明确更新 → 拉取覆盖
              saveData(row.key, row.value);
              _setRemoteTs(row.key, row.updated_at);
              _setLocalTs(row.key, row.updated_at);
            } else {
              // 本地更新或相同 → 保留本地并上传
              dirtyKeys.add(row.key);
            }
          } else if (!localTs && remoteTs) {
            // 本地有真实数据但无本地时间戳（恢复备份场景）→ 保护本地，上传覆盖云端
            dirtyKeys.add(row.key);
          } else {
            // 两端都无时间戳等边缘情况 → 保留本地并上传
            dirtyKeys.add(row.key);
          }
        }
        // 本地空 + 云端空 → 跳过
      }
      // 拉取完成，若存在冲突则提示用户选择（异步，不阻塞后续）
      if (_conflictQueue.length) _resolveConflicts();
    } catch (e) {
      console.warn('[sync] 拉取异常:', e);
    } finally {
      applyingRemote = false;
      // 拉取中标记的「本地待保护」dirtyKeys（本地有真实数据需上传）在此一并上传，
      // 确保恢复备份后本地真实数据能推回云端，而不是被云端旧/空数据清空。
      try { if (dirtyKeys.size > 0) await _flush(); } catch (e) { console.warn('[sync] 上传失败:', e); }
      _refreshUI();
      _emitProgress({ active: false, phase: 'idle', current: 0, total: 0, key: '', label: '' });
    }
  }

  // ── 冲突解决：弹窗让用户选择本地版 / 云端版（Steam 云存档式）────────
  function _resolveConflicts() {
    if (_resolvingConflict) return;   // 已在弹窗中，避免叠加
    _resolvingConflict = true;
    (async () => {
      const client2 = _client();
      const session = await getSession();
      while (_conflictQueue.length) {
        const key = _conflictQueue.shift();
        let ok;
        try { ok = await _askConflictChoice(key); } catch (e) { ok = null; }
        if (ok === null) { continue; }
        if (ok === 'local') {
          // 用本地版：上传本地覆盖云端，并同步时间戳
          if (client2 && session) await _uploadKey(key);
          else dirtyKeys.add(key);
        } else {
          // 用云端版：拉取云端覆盖本地
          if (client2 && session) {
            const { data } = await client2.from('user_data')
              .select('key,value,updated_at').eq('user_id', session.user.id).eq('key', key).maybeSingle();
            if (data && data.value !== null) {
              saveData(data.key, data.value);
              _setRemoteTs(data.key, data.updated_at);
              _setLocalTs(data.key, data.updated_at);
            }
          }
        }
      }
      _resolvingConflict = false;
    })();
  }

  // 冲突弹窗：返回 'local' | 'remote' | null（null 表示用户关闭/跳过）
  function _askConflictChoice(key) {
    return new Promise((resolve) => {
      const overlay = document.getElementById('syncConflictOverlay');
      const body = document.getElementById('syncConflictBody');
      if (!overlay || !body) { resolve('remote'); return; }   // 无弹窗时默认用云端
      const label = SYNC_LABELS && SYNC_LABELS[key] ? SYNC_LABELS[key] : key;
      body.innerHTML = `“<b>${escapeHtml(label)}</b>”在本地与云端都做了修改，无法自动合并。<br>请选择保留哪个版本：<br><span style="font-size:11px;opacity:.7">本地 ${new Date(_getLocalTs()[key]||'').toLocaleString()} ｜ 云端 ${new Date(_getRemoteTs()[key]||'').toLocaleString()}</span>`;
      overlay.style.display = 'flex';
      if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
      const done = (val) => {
        overlay.style.display = 'none';
        const l = document.getElementById('syncConflictLocal');
        const r = document.getElementById('syncConflictRemote');
        if (l) l.onclick = null;
        if (r) r.onclick = null;
        resolve(val);
      };
      const l = document.getElementById('syncConflictLocal');
      const r = document.getElementById('syncConflictRemote');
      if (l) l.onclick = function() { done('local'); };
      if (r) r.onclick = function() { done('remote'); };
      // 若用户未点选（如切换页面），不清除 resolve，避免悬空 Promise
    });
  }

  // ── 变更上报（saveData 钩子调用）─────────────────────
  function onLocalChange(key) {
    if (!isSyncKey(key)) return;
    if (applyingRemote) return;   // 远端写回本地不触发回传，防循环
    // 无论是否登录都记录本地修改时间（Steam 云存档式合并需要；未登录时修改也会在登录后正确对比）
    _setLocalTs(key, new Date().toISOString());
    if (!enabled || !loggedIn || !client) return;
    dirtyKeys.add(key);
    clearTimeout(uploadTimer);
    uploadTimer = setTimeout(_flush, UPLOAD_DEBOUNCE);
  }

  // ── Realtime 订阅远端变更 ───────────────────────────
  let _subscribing = false;   // 并发锁：防止 _subscribe 被重复触发导致 channel 冲突
  async function _subscribe() {
    const c = _client();
    if (!c || !enabled || !loggedIn) return;
    if (_subscribing) return;             // 已在订阅中，忽略重复调用
    _subscribing = true;
    try {
      const session = await getSession();
      if (!session) return;
      // 彻底移除旧 channel（不能只 unsubscribe，否则 c.channel('mst-user-data') 会复用
      // 已 subscribe 的同名 channel，再次 .on('postgres_changes') 即报错）
      if (realtimeChannel) {
        try { await c.removeChannel(realtimeChannel); } catch (e) {}
        realtimeChannel = null;
      }
      const channel = c.channel('mst-user-data')
        .on('postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'user_data', filter: 'user_id=eq.' + session.user.id },
          () => _debouncedPull())
        .on('postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'user_data', filter: 'user_id=eq.' + session.user.id },
          () => _debouncedPull());
      channel.subscribe();
      realtimeChannel = channel;
    } catch (e) {
      // 订阅失败不影响主流程，仅日志
      if (typeof console !== 'undefined') console.error('[Sync] _subscribe error:', e);
    } finally {
      _subscribing = false;
    }
  }

  let pullDebounceTimer = null;
  function _debouncedPull() {
    clearTimeout(pullDebounceTimer);
    pullDebounceTimer = setTimeout(_pullAll, 800);
  }

  // ── 拉取后刷新界面 ─────────────────────────────────
  // 同步写入 localStorage 后，内存中的全局变量（notes/todos/links 等）不会自动更新，
  // 需重新加载并重渲染，否则用户看到的是旧数据（即使 localStorage 已更新）。
  // 此处用 try/catch 逐个调用，避免单个模块异常影响整体刷新。
  function _refreshUI() {
    try {
      // 重新从 localStorage 加载内存变量（若模块已定义全局 let 变量）。
      // 注：notes/todos/links 是 core.js 的全局 let 绑定，IIFE 作用域链可解析到它们，
      // 直接赋值即可更新（此处不会被误判为「未声明」）。
      if (typeof notes !== 'undefined') notes = loadData('study_notes_v2');
      if (typeof todos !== 'undefined') todos = loadData('study_todos_v2');
      if (typeof links !== 'undefined') links = loadData('study_links_v3');
    } catch (e) { /* 忽略 */ }
    const calls = [
      'renderNotes', 'renderTodos', 'renderToday', 'renderLinks', 'renderCalendar',
      'renderTaskLine', 'renderFocusList', 'renderHabits', 'renderStats'
    ];
    for (const fn of calls) {
      try { if (typeof window[fn] === 'function') window[fn](); } catch (e) { /* 忽略单个模块失败 */ }
    }
  }

  // ── 状态通知 ────────────────────────────────────────
  async function _emitStatus() {
    const status = await getStatus();
    listeners.forEach(fn => { try { fn(status); } catch (e) {} });
  }
  function onStatus(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // ── 同步进度（上传/拉取）通知 ──────────────────────
  let progressListeners = new Set();
  let _lastProgress = null;
  // 上报进度。state: { active, phase: 'upload'|'pull'|'first'|'idle', current, total, key?, label? }
  function _emitProgress(state) {
    _lastProgress = state;
    progressListeners.forEach(fn => { try { fn(state); } catch (e) {} });
  }
  function onProgress(fn) {
    progressListeners.add(fn);
    if (_lastProgress) { try { fn(_lastProgress); } catch (e) {} }
    return () => progressListeners.delete(fn);
  }
  // 进度清零（一次同步开始/结束时）
  function _resetProgress() { _lastProgress = null; }
  async function getStatus() {
    const cfg = getConfig();
    // 实时刷新登录态，避免依赖事件时序导致误判"未登录"
    const sess = await getSession();
    if (sess && !loggedIn) loggedIn = true;
    if (!sess && loggedIn) loggedIn = false;
    return {
      enabled: enabled,
      loggedIn: !!sess,
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
  async function _init() {
    if (typeof getSupabaseClient !== 'function') { enabled = false; return; }
    client = getSupabaseClient();
    if (!client) { enabled = false; return; }
    const session = await getSession();
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

  async function _doSyncAfterLogin() {
    if (!enabled || !loggedIn || !_client()) return;
    _subscribe();
    const ts = _getRemoteTs();
    const isFirst = Object.keys(ts).length === 0;
    if (isFirst) _firstSync();
    else _pullAll();
  }

  function init() {
    const cfg = getConfig();
    enabled = !!cfg.enabled;
    if (enabled) {
      setTimeout(_init, 1500);   // 等 friends.js 客户端就绪
    }
    // 监听登录状态变化：使用 Supabase 官方 onAuthStateChange（friends.js 同款），
    // 不依赖可能未派发的 fr-auth-change 自定义事件。
    try {
      if (typeof getSupabaseClient === 'function') {
        client = getSupabaseClient();
      }
    } catch (e) { /* 忽略 */ }
    if (client && client.auth && typeof client.auth.onAuthStateChange === 'function') {
      try {
        client.auth.onAuthStateChange(function (event, session) {
          if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') {
            if (session) {
              loggedIn = true;
              _doSyncAfterLogin();
              clearTimeout(pullTimer);
              pullTimer = setTimeout(() => { _pullAll(); _emitStatus(); }, PULL_INTERVAL);
            } else {
              // 事件未带 session，异步获取确认
              getSession().then(function (s) {
                loggedIn = !!s;
                if (loggedIn) {
                  _doSyncAfterLogin();
                  clearTimeout(pullTimer);
                  pullTimer = setTimeout(() => { _pullAll(); _emitStatus(); }, PULL_INTERVAL);
                }
                _emitStatus();
              });
            }
            _emitStatus();
          } else if (event === 'SIGNED_OUT') {
            loggedIn = false;
            if (realtimeChannel) { try { realtimeChannel.unsubscribe(); } catch (e) {} realtimeChannel = null; }
            _emitStatus();
          }
        });
      } catch (e) { /* 忽略订阅失败 */ }
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
    onProgress,
    get enabled() { return enabled; },
    get loggedIn() { return loggedIn; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
