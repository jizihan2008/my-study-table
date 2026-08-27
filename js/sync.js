// ═══════════════════════════════════════════════════════════════════
// js/sync.js — Supabase 双向数据云同步（手机端 PWA / 桌面端共用）
// 将白名单内的 localStorage key（待办/笔记/计时/习惯/任务线/电子书元数据等）
// 同步到 Supabase user_data 表，per-key updated_at 后写者胜（LWW）。
// 注：AI 对话 / 教材讲解 / 全书问答三类日志已剥离到 js/sync-logs.js 独立通道。
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

  const policy = global.SyncPolicy;
  if (!policy) throw new Error('SyncPolicy must be loaded before sync.js');

  // 单条同步数据大小上限（字节）。超过则不参与云端同步（本地保留），
  // 防止超大 value（如 AI 聊天记录可到几十 MB）导致 user_data 查询/写入 statement timeout。
  // 用 JSON.stringify 长度近似（UTF-8 中文约 3 字节，取 0.8MB 字符串长度≈2MB 实际 → 保守）
  const MAX_SYNC_VALUE_LEN = 800 * 1024; // 字符串长度≈800K（中文时实际字节数约×2~3）
  function _valueTooLarge(value) {
    if (value == null) return false;
    try { return String(value).length > MAX_SYNC_VALUE_LEN; }
    catch (e) { return false; }
  }

  // ── 同步白名单：仅这些 key 参与云同步（不含任何敏感凭据）──────────
  const SYNC_KEYS = [
    'study_todos_v2',          // 待办事项（当前版）
    'study_todos',             // 待办（旧版备份）
    'study_notes_v2',          // 笔记（当前版）
    'study_notes',             // 笔记（旧版备份）
    'study_notes_folders',     // 笔记文件夹结构
    'study_timer_records',     // 专注计时记录
    'study_taskline_v1',       // 任务线（学习任务进度）
    'study_habits_v2',         // 习惯打卡（当前版 v2，habits.js HABITS_KEY）
    'study_habits',            // 习惯打卡（旧版）
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
    // 注：study_ai_convs / study_bk_explain_logs_v1 / study_bk_qa_logs_v1
    // 已剥离到独立通道 sync-logs.js（gzip 压缩 + 分片 + 配额），不再走普通同步
    'study_ai_memory',         // AI 记忆画像
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

  // 同步数据在冲突列表中显示的可读名称
  const SYNC_LABELS = {
    'study_todos_v2': '待办事项',
    'study_todos': '待办事项（旧版）',
    'study_notes_v2': '笔记',
    'study_notes': '笔记（旧版）',
    'study_notes_folders': '笔记文件夹',
    'study_timer_records': '计时记录',
    'study_taskline_v1': '任务线',
    'study_habits': '习惯打卡',
    'study_habits_v2': '习惯打卡（当前版）',
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
    'study_ai_memory': 'AI 记忆画像',
    'study_bk_quiz_state_v1': '教材测验状态',
    'study_todo_completed_log': '待办完成日志'
  };

  const SYNC_VER = '20260826-r12';           // 同步模块版本（面板诊断用，需与 index.html 同步）
  const CONFLICT_HISTORY_KEY = 'study_sync_conflict_history';
  const PENDING_CONFLICTS_KEY = 'study_sync_pending_conflicts_v1';
  const CFG_KEY = 'study_sync_config';       // 本地同步配置（开关 + 上次全量拉取时间）
  const IDB_NAME = 'mst-sync';
  const IDB_STORE = 'outbox';                // 离线变更队列
  const OUTBOX_KEY = 'pending';              // 单条记录 key
  const UPLOAD_DEBOUNCE = 2000;              // 变更后等待上传的毫秒数
  const PULL_INTERVAL = 30 * 60 * 1000;      // 定时全量拉取间隔（30 分钟）
  const FULL_RECONCILE_INTERVAL = 24 * 60 * 60 * 1000; // 每天做一次完整对账，其余走增量游标

  let client = null;                          // Supabase 客户端
  let enabled = false;                        // 是否开启云同步（总开关）
  let autoSync = false;                       // 是否自动同步（子开关：自动上传/定时拉取/Realtime）
  let loggedIn = false;
  let dirtyKeys = new Set();                  // 待上传的 key
  let uploadTimer = null;
  let realtimeChannel = null;
  let syncInProgress = false;                 // 拉取/合并互斥锁
  let remoteApplyDepth = 0;                   // 仅抑制远端写回产生的本地变更通知
  let _lastPushAt = 0;                        // 上次主动上传完成时间（抑制自己变更的 realtime 回显）
  let _lastPullError = '';                    // 最近一次手动同步的失败原因（诊断用）
  let listeners = new Set();                  // 状态监听器（settings 面板刷新用）
  const pullScheduler = policy.createRecurringTask(
    () => _pullAll(false),
    PULL_INTERVAL
  );

  // 判断某 key 是否参与同步
  function isSyncKey(key) {
    if (!key) return false;
    if (SENSITIVE_KEYS.indexOf(key) !== -1) return false;
    return SYNC_KEYS.indexOf(key) !== -1;
  }

  // 判断本地存储值是否为「空」：空数组 / 空对象 / 空字符串 / null，
  // 以及「空壳对象」（对象键存在但所有值均为空，如 AI 记忆的空结构）。
  // 用于防止「本地是空占位」时误上传覆盖云端的真实数据，也防止空壳阻挡云端真实数据拉取。
  function _isEmptyValue(v) {
    if (v === null || v === undefined) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') {
      // 空对象 → 空
      if (Object.keys(v).length === 0) return true;
      // 空壳对象：所有值均为空（递归）才视为空，避免误判有配置的正常对象
      return Object.keys(v).every(k => _isEmptyValue(v[k]));
    }
    return String(v).trim() === '';
  }
  function _isEmptyLocalValue(key) {
    const raw = localStorage.getItem(key);
    if (raw === null) return true;
    const trimmed = raw.trim();
    if (trimmed === '') return true;
    try {
      const v = JSON.parse(trimmed);
      // AI 长期记忆特殊判定：只看核心数据字段是否为空，忽略 lastDailyIntegration/dailySummaryDate 等元数据标记，
      // 否则一个「空记忆壳」（含日期标记但无实际内容）会被误判为非空而阻挡云端真实记忆拉取。
      if (key === 'study_ai_memory' && v && typeof v === 'object') {
        return _isEmptyValue(v.profileText) && _isEmptyValue(v.autoFacts) && _isEmptyValue(v.manualNotes) &&
          _isEmptyValue(v.convSummaries) && _isEmptyValue(v.dailySummary);
      }
      return _isEmptyValue(v);
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
      // 默认开启自动同步（跟随总开关）。未显式设置过时视为开启。
      if (typeof cfg.autoSync !== 'boolean') cfg.autoSync = true;
      return cfg;
    } catch (e) { return { enabled: true, autoSync: true }; }
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
    if (value != null && _valueTooLarge(value)) {
      // 超大 value 不上传，避免云端 user_data 超时；本地数据保留，仅警告。
      console.warn('[sync] 跳过上传超大 key:', key, '(len=' + value.length + ')');
      // 注意：不能用客户端本地时钟写 localTs（iPad 时钟偏差会污染 LWW 比较，
      // 导致后续其他设备「云端不比本地新」→ 永不拉取）。这里不设置 localTs，
      // 仅从云端时间戳兜底：若已有 remoteTs 则用 remoteTs 标记已处理。
      const remoteMap = _getRemoteTs();
      if (remoteMap[key]) {
        _setLocalTs(key, remoteMap[key]);
        _clearLocalDirty(key);   // 超大 key 不参与上传，标记已处理，避免每轮拉取重复入队
      }
      return { ok: true, skipped: true, reason: 'too-large' };
    }
    let payload = null;
    try {
      payload = value ? JSON.parse(value) : null;
    } catch (e) {
      return { ok: false, reason: 'invalid-local-json' };
    }
    // 用「服务器时间」作为云端 updated_at（不传该字段 → 数据库 default now()），
    // 避免客户端时钟偏差（手机时间慢于电脑）导致 LWW 判定「云端不新」→ 另一设备永不拉取。
    // 兜底优先用既有服务器时间（remoteTs），其次才设备时钟——避免 select 失败时把
    // 设备时钟写进 localTs 造成新的污染（污染值会被 _tsIsFuture 5s 灵敏识别并校准）。
    let updatedAt = '';
    try {
      const { data, error } = await c.from('user_data')
        .upsert({ user_id: session.user.id, key, value: payload },
          { onConflict: 'user_id,key' })
        .select('updated_at')
        .single();
      if (error) return { ok: false, reason: error.message || 'upload-failed' };
      if (!data || !data.updated_at) return { ok: false, reason: 'missing-server-timestamp' };
      updatedAt = data.updated_at;
    } catch (e) {
      // 网络异常的结果是不确定的，绝不能按成功清除 dirty/outbox。
      return { ok: false, reason: String((e && e.message) || e || 'network-error') };
    }
    // 成功上传后清掉对应 outbox
    await _outboxRemove(key);
    // 同步本地与云端时间戳（以服务器时间为准），标记该 key 本地已是最新
    _setRemoteTs(key, updatedAt);
    _setLocalTs(key, updatedAt);
    _clearLocalDirty(key);   // 上传成功 → 清除待上传标记
    return { ok: true, updatedAt };
  }

  // 同一轮有多个 dirty key 时一次 upsert，减少逐 key 往返；单 key 仍走原路径，
  // 便于保留精确错误信息和兼容旧版 Supabase/PostgREST 行为。
  async function _uploadKeys(keys) {
    const list = Array.from(new Set((keys || []).filter(isSyncKey)));
    if (list.length <= 1) {
      const only = list[0];
      return only ? { [only]: await _uploadKey(only) } : {};
    }
    const session = await getSession();
    const c = _client();
    if (!session || !c) {
      return Object.fromEntries(list.map(key => [key, { ok: false, reason: !session ? 'not-logged-in' : 'no-client' }]));
    }

    const results = {};
    const rows = [];
    for (const key of list) {
      const raw = localStorage.getItem(key);
      if (raw != null && _valueTooLarge(raw)) {
        results[key] = await _uploadKey(key); // 本地完成“超大值跳过”处理，不产生网络写入
        continue;
      }
      try {
        rows.push({ user_id: session.user.id, key, value: raw ? JSON.parse(raw) : null });
      } catch (e) {
        results[key] = { ok: false, reason: 'invalid-local-json' };
      }
    }
    if (!rows.length) return results;

    try {
      const { data, error } = await c.from('user_data')
        .upsert(rows, { onConflict: 'user_id,key' })
        .select('key,updated_at');
      if (error) throw new Error(error.message || 'batch-upload-failed');
      const returned = new Map((data || []).map(row => [row.key, row.updated_at]));
      for (const row of rows) {
        const updatedAt = returned.get(row.key);
        if (!updatedAt) {
          results[row.key] = { ok: false, reason: 'missing-server-timestamp' };
          continue;
        }
        await _outboxRemove(row.key);
        _setRemoteTs(row.key, updatedAt);
        _setLocalTs(row.key, updatedAt);
        _clearLocalDirty(row.key);
        results[row.key] = { ok: true, updatedAt };
      }
    } catch (e) {
      const reason = String((e && e.message) || e || 'network-error');
      for (const row of rows) results[row.key] = { ok: false, reason };
    }
    return results;
  }

  // ── 批量上传所有脏 key（队列：串行排队，同时只允许一个上传进程） ──
  // 用 Promise 链实现队列：所有 _flush 请求追加到队列尾部，逐个串行执行，不丢失任何请求
  let uploadChain = Promise.resolve();
  let queuePending = 0;        // 队列中等待执行的任务数（用于可视化）
  const MAX_QUEUE = 20;        // 队列长度上限，防止极端情况下无限堆积

  async function _restoreOutboxDirtyKeys() {
    const items = await _outboxGetAll();
    for (const item of items) {
      if (!item || !isSyncKey(item.key)) continue;
      _markLocalDirty(item.key);
      dirtyKeys.add(item.key);
    }
  }

  async function _storeFailedUpload(key, reason) {
    let payload = null;
    const raw = localStorage.getItem(key);
    try { payload = raw ? JSON.parse(raw) : null; } catch (e) {}
    _markLocalDirty(key);
    dirtyKeys.add(key);
    await _outboxPut(key, payload, new Date().toISOString());
    _lastPullError = reason || '上传失败，已加入离线队列';
  }

  async function _findUploadConflicts(keys) {
    if (!keys.length) return { ok: true, conflicts: new Map() };
    const session = await getSession();
    const c = _client();
    if (!session || !c) return { ok: false, reason: '未登录或 Supabase 客户端不可用' };
    try {
      const { data, error } = await c.from('user_data')
        .select('key,updated_at')
        .eq('user_id', session.user.id)
        .in('key', keys);
      if (error) return { ok: false, reason: error.message || '无法检查云端版本' };
      const remoteMap = {};
      (data || []).forEach(row => { remoteMap[row.key] = row.updated_at; });
      const localMap = _getLocalTs();
      const conflicts = new Map();
      for (const key of keys) {
        const remoteTs = remoteMap[key];
        if (!remoteTs) continue;
        const baseTs = localMap[key];
        const compared = policy.compareTimestamps(remoteTs, baseTs);
        if (!baseTs || compared === null || compared > 0) conflicts.set(key, remoteTs);
      }
      return { ok: true, conflicts };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e || '网络异常') };
    }
  }

  function _flush(options = {}) {
    const forceUpload = !!options.forceUpload;
    // 已积压大量任务时丢弃最旧的积压，避免队列无限增长
    if (queuePending > MAX_QUEUE) return uploadChain;
    queuePending++;
    _emitProgress({ active: true, phase: 'upload', current: 0, total: 0, key: '', label: '', queuePending: queuePending });
    uploadChain = uploadChain.then(async () => {
      queuePending--;
      if (!enabled || !loggedIn || !_client()) return;
      // 持久化 dirty/outbox 是事实来源，应用重启后也必须恢复到运行时队列。
      _hydrateDirtyKeys();
      await _restoreOutboxDirtyKeys();
      // 取出当前所有脏 key 作为本次批次；本地变更/其他触发在本次执行期间新加入的 key
      // 会留在 dirtyKeys，由后续入队任务处理，不会丢失
      const keys = Array.from(dirtyKeys).filter(key => isSyncKey(key) && !_conflictKeys.has(key));
      keys.forEach(key => dirtyKeys.delete(key));
      if (!keys.length) return;

      if (!forceUpload) {
        const checked = await _findUploadConflicts(keys);
        if (!checked.ok) {
          for (const key of keys) await _storeFailedUpload(key, checked.reason);
          return;
        }
        for (const [key, remoteTimestamp] of checked.conflicts) {
          _queueConflict(key, remoteTimestamp, _getLocalTs()[key] ? 'cloud-newer-than-base' : 'missing-sync-base');
          const index = keys.indexOf(key);
          if (index >= 0) keys.splice(index, 1);
        }
      }

      let okCount = 0;
      const total = keys.filter(k => isSyncKey(k)).length || 1;
      if (keys.length) {
        _emitProgress({ active: true, phase: 'upload', current: 1, total, key: keys[0], label: keys.length > 1 ? ('批量上传 ' + keys.length + ' 项') : (SYNC_LABELS[keys[0]] || keys[0]), queuePending });
      }
      const results = await _uploadKeys(keys);
      let done = 0;
      for (const key of keys) {
        const res = results[key] || { ok: false, reason: 'missing-upload-result' };
        if (res.ok) okCount++;
        else await _storeFailedUpload(key, res.reason);
        done++;
      }
      if (okCount > 0) {
        _emitStatus();
        _lastPushAt = Date.now();
      }
    }).catch((e) => {
      _lastPullError = String((e && e.message) || e || '上传队列异常');
      console.warn('[sync] 上传队列异常:', e);
    })
      .finally(() => {
        // 队列已全部处理完时才显示空闲；否则保持等待（下一个任务会继续更新）
        if (queuePending <= 0) _emitProgress({ active: false, phase: 'idle', current: 0, total: 0, key: '', label: '', queuePending: 0 });
      });
    return uploadChain;
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

  // ── 本地「待上传修改」标记（方案 B 核心）────────────────────
  // 历史问题：localTs 用设备时钟写（new Date()），iPad 时钟偏快 → localTs 恒大于云端
  // updated_at → LWW 判定「本地更新」→ 永不拉取。修复：本地修改不再写时间戳，改用持久化
  // dirty 标记承载「本地有未上传修改」；localTs 只在与服务器成功交互后写入服务器 updated_at，
  // 与 remoteTs 同源可比 → 时间戳比较永远可靠，自动同步无需再依赖强制拉取。
  const DIRTY_KEY = 'study_sync_dirty_v1';   // { [key]: true } 本地有未上传修改
  function _getDirtyMap() {
    try { return JSON.parse(localStorage.getItem(DIRTY_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function _markLocalDirty(key) {
    const map = _getDirtyMap();
    map[key] = true;
    localStorage.setItem(DIRTY_KEY, JSON.stringify(map));
  }
  function _clearLocalDirty(key) {
    const map = _getDirtyMap();
    if (key in map) { delete map[key]; localStorage.setItem(DIRTY_KEY, JSON.stringify(map)); }
  }
  function _isLocalDirty(key) { return !!_getDirtyMap()[key]; }
  function _hydrateDirtyKeys() {
    const map = _getDirtyMap();
    Object.keys(map).filter(isSyncKey).forEach(key => dirtyKeys.add(key));
  }

  async function _applyRemoteValue(key, value, updatedAt) {
    remoteApplyDepth++;
    try {
      saveData(key, value);
    } finally {
      remoteApplyDepth--;
    }
    _setRemoteTs(key, updatedAt);
    _setLocalTs(key, updatedAt);
    _clearLocalDirty(key);
    dirtyKeys.delete(key);
    await _outboxRemove(key);
  }
  // 判断本地时间戳是否为「未来值」（旧版本用设备时钟写 localTs 的污染残留）：
  // localTs 语义 = 服务器 updated_at，与 remoteMaxTs（本次拉取的最大服务器时间）同源。
  // 服务器时间单向递增 → localTs 不可能真正晚于 remoteMaxTs；任何超出微小抖动的正值
  // 都是旧版设备时钟污染 → 本地时间不可信 → 以云端为权威（拉取覆盖校准），
  // 避免「iPad 时钟偏快 → 永不拉取」死循环。
  // 容忍 50ms：仅吸收同毫秒字符串的解析抖动；iPad 秒级/分钟级/小时级时钟偏差全部识别。
  // （曾用 15 分钟/5 秒，均放过 iPad 的更小偏差导致电脑→iPad 不同步）
  const TS_FUTURE_TOLERANCE = 50;   // 50ms 容忍
  function _tsIsFuture(localTs, remoteMaxTs) {
    if (!localTs || !remoteMaxTs) return false;
    return new Date(localTs).getTime() - new Date(remoteMaxTs).getTime() > TS_FUTURE_TOLERANCE;
  }
  // 待处理冲突持久化在 localStorage；自动同步只暂停冲突项，不主动打断用户。
  const _conflictKeys = new Set();
  const _resolvingConflictKeys = new Set();

  function _getPendingConflictMap() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PENDING_CONFLICTS_KEY)) || {};
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) { return {}; }
  }

  function _savePendingConflictMap(map) {
    localStorage.setItem(PENDING_CONFLICTS_KEY, JSON.stringify(map));
  }

  function _hydratePendingConflicts() {
    _conflictKeys.clear();
    const map = _getPendingConflictMap();
    let changed = false;
    Object.keys(map).forEach(key => {
      if (isSyncKey(key)) _conflictKeys.add(key);
      else { delete map[key]; changed = true; }
    });
    if (changed) _savePendingConflictMap(map);
  }

  function _queueConflict(key, remoteTimestamp, reason) {
    if (!isSyncKey(key)) return;
    const map = _getPendingConflictMap();
    const existing = map[key] || {};
    map[key] = {
      key,
      label: SYNC_LABELS[key] || key,
      reason: reason || existing.reason || 'both-changed',
      baseTimestamp: existing.baseTimestamp || _getLocalTs()[key] || null,
      remoteTimestamp: remoteTimestamp || existing.remoteTimestamp || _getRemoteTs()[key] || null,
      detectedAt: existing.detectedAt || new Date().toISOString(),
      localHash: existing.localHash || (global.StudyData ? global.StudyData.hashText(localStorage.getItem(key) || '') : null)
    };
    _savePendingConflictMap(map);
    _conflictKeys.add(key);
    _emitStatus();
  }

  function _clearPendingConflict(key) {
    const map = _getPendingConflictMap();
    if (key in map) {
      delete map[key];
      _savePendingConflictMap(map);
    }
    _conflictKeys.delete(key);
  }

  function getPendingConflicts() {
    const map = _getPendingConflictMap();
    return Object.keys(map)
      .filter(isSyncKey)
      .map(key => ({
        key,
        label: SYNC_LABELS[key] || key,
        reason: map[key].reason || 'both-changed',
        baseTimestamp: map[key].baseTimestamp || null,
        remoteTimestamp: map[key].remoteTimestamp || null,
        detectedAt: map[key].detectedAt || null,
        localHash: map[key].localHash || null,
        resolving: _resolvingConflictKeys.has(key)
      }))
      .sort((a, b) => String(a.detectedAt || '').localeCompare(String(b.detectedAt || '')));
  }


  // Safe merge cycle. force=true only waits for an active cycle; it never means
  // that the cloud may silently overwrite unsent local edits.
  async function _pullAll(force, targetKeys) {
    if (!enabled) { _lastPullError = '同步未开启'; return false; }
    if (!_client()) { _lastPullError = 'Supabase 客户端不可用（检查 Supabase 连接配置）'; return false; }
    if (syncInProgress) {
      if (!force) return false;
      const waitStart = Date.now();
      while (syncInProgress && Date.now() - waitStart < 15000) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (syncInProgress) {
        _lastPullError = '上一次同步仍未完成，请稍后重试';
        return false;
      }
    }

    _lastPullError = '';
    const session = await getSession();
    if (!session) {
      _lastPullError = '未登录或登录状态失效（请在「好友」页面重新登录）';
      return false;
    }
    const c = _client();
    if (!c) { _lastPullError = 'Supabase 客户端不可用（检查 Supabase 连接配置）'; return false; }

    syncInProgress = true;
    try {
      _hydrateDirtyKeys();
      const targeted = Array.isArray(targetKeys) && targetKeys.length > 0;
      const cfg = getConfig();
      const fullReconcile = !targeted && (force || !cfg.syncCursor || !cfg.lastFullReconcile ||
        Date.now() - cfg.lastFullReconcile >= FULL_RECONCILE_INTERVAL);
      const incremental = !targeted && !fullReconcile;
      let metaQuery = c.from('user_data')
        .select('key,updated_at')
        .eq('user_id', session.user.id);
      if (targeted) metaQuery = metaQuery.in('key', targetKeys.filter(isSyncKey));
      else if (incremental && typeof metaQuery.gte === 'function') metaQuery = metaQuery.gte('updated_at', cfg.syncCursor);
      const { data: meta, error } = await metaQuery;
      if (error) {
        _lastPullError = error.message || '拉取云端元数据失败';
        return false;
      }

      const syncRows = (meta || []).filter(row => isSyncKey(row.key));
      const remoteKeys = new Set(syncRows.map(row => row.key));
      const localTsMap = _getLocalTs();
      let remoteMaxTs = '';
      for (const row of syncRows) {
        if (!remoteMaxTs || policy.compareTimestamps(row.updated_at, remoteMaxTs) > 0) remoteMaxTs = row.updated_at;
      }

      const needValueKeys = [];
      for (const row of syncRows) {
        const localTs = localTsMap[row.key];
        const compared = policy.compareTimestamps(row.updated_at, localTs);
        if (_isEmptyLocalValue(row.key) || _isLocalDirty(row.key) || !localTs ||
          compared === null || compared !== 0 || _tsIsFuture(localTs, remoteMaxTs)) {
          needValueKeys.push(row.key);
        }
      }

      const valueMap = {};
      if (needValueKeys.length) {
        const { data: values, error: valueError } = await c.from('user_data')
          .select('key,value,updated_at')
          .eq('user_id', session.user.id)
          .in('key', needValueKeys);
        if (valueError) {
          _lastPullError = valueError.message || '拉取云端数据失败';
          return false;
        }
        (values || []).forEach(row => { valueMap[row.key] = row; });
      }

      const total = syncRows.length || 1;
      let current = 0;
      for (const row of syncRows) {
        current++;
        const remoteRow = valueMap[row.key];
        const localEmpty = _isEmptyLocalValue(row.key);
        const localDirty = _isLocalDirty(row.key);
        const localTs = localTsMap[row.key];
        const futureTimestamp = _tsIsFuture(localTs, remoteMaxTs);
        const remoteHasData = !!remoteRow && !_isEmptyValue(remoteRow.value);
        let action;

        if (!remoteRow) {
          const compared = policy.compareTimestamps(row.updated_at, localTs);
          action = localDirty ? 'upload' : (compared === 0 ? 'noop' : 'conflict');
        } else if (futureTimestamp) {
          action = localDirty ? 'conflict' : (remoteHasData ? 'pull' : 'upload');
        } else {
          action = policy.decideMerge({
            localEmpty,
            localDirty,
            baseTimestamp: localTs,
            remoteExists: true,
            remoteHasData,
            remoteTimestamp: remoteRow.updated_at
          });
        }

        if (action === 'pull') {
          await _applyRemoteValue(row.key, remoteRow.value, remoteRow.updated_at);
        } else if (action === 'upload') {
          _markLocalDirty(row.key);
          dirtyKeys.add(row.key);
        } else if (action === 'conflict') {
          _markLocalDirty(row.key);
          _queueConflict(
            row.key,
            (remoteRow && remoteRow.updated_at) || row.updated_at,
            futureTimestamp ? 'timestamp-uncertain' : (!localTs ? 'missing-sync-base' : 'both-changed')
          );
        }

        _emitProgress({ active: true, phase: 'pull', current, total, key: row.key, label: SYNC_LABELS[row.key] || row.key });
      }

      if (fullReconcile) {
        for (const key of SYNC_KEYS) {
          if (remoteKeys.has(key) || _isEmptyLocalValue(key)) continue;
          _markLocalDirty(key);
          dirtyKeys.add(key);
        }
      }

      if (remoteMaxTs) cfg.syncCursor = remoteMaxTs;
      if (fullReconcile) cfg.lastFullReconcile = Date.now();
      setConfig(cfg);

      return true;
    } catch (e) {
      _lastPullError = String((e && e.message) || e || '拉取异常');
      console.warn('[sync] 拉取异常:', e);
      return false;
    } finally {
      syncInProgress = false;
      try { await _flush(); } catch (e) { console.warn('[sync] 上传失败:', e); }
      _refreshUI();
      _emitProgress({ active: false, phase: 'idle', current: 0, total: 0, key: '', label: '' });
    }
  }

  function _getConflictHistory() {
    try { return JSON.parse(localStorage.getItem(CONFLICT_HISTORY_KEY)) || []; }
    catch (e) { return []; }
  }

  function _recordConflict(key, choice, conflict) {
    const raw = localStorage.getItem(key) || '';
    let deviceId = localStorage.getItem('study_device_id');
    if (!deviceId) {
      deviceId = 'device_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('study_device_id', deviceId);
    }
    const history = _getConflictHistory();
    history.unshift({
      key,
      label: SYNC_LABELS[key] || key,
      choice,
      deviceId,
      localUpdatedAt: (conflict && conflict.baseTimestamp) || _getLocalTs()[key] || null,
      remoteUpdatedAt: (conflict && conflict.remoteTimestamp) || _getRemoteTs()[key] || null,
      localHash: (conflict && conflict.localHash) || (global.StudyData ? global.StudyData.hashText(raw) : null),
      resolvedAt: new Date().toISOString()
    });
    localStorage.setItem(CONFLICT_HISTORY_KEY, JSON.stringify(history.slice(0, 100)));
  }

  async function resolveConflict(key, choice) {
    const conflicts = _getPendingConflictMap();
    const conflict = conflicts[key];
    if (!conflict || !isSyncKey(key)) return { ok: false, reason: '该冲突已不存在或已处理' };
    if (choice !== 'local' && choice !== 'remote') return { ok: false, reason: '无效的冲突处理方式' };
    if (_resolvingConflictKeys.has(key)) return { ok: false, reason: '该冲突正在处理中' };

    _resolvingConflictKeys.add(key);
    _emitStatus();
    try {
      const session = await getSession();
      const c = _client();
      if (!session || !c) throw new Error('未登录或 Supabase 客户端不可用');

      if (choice === 'local') {
        const result = await _uploadKey(key);
        if (!result.ok || result.skipped) {
          if (!result.skipped) await _storeFailedUpload(key, result.reason);
          throw new Error(result.skipped ? '该类本地数据过大，无法上传覆盖云端' : (result.reason || '上传本地版本失败'));
        }
      } else {
        const { data, error } = await c.from('user_data')
          .select('key,value,updated_at').eq('user_id', session.user.id).eq('key', key).maybeSingle();
        if (error) throw new Error(error.message || '读取云端版本失败');
        if (!data || !data.updated_at) throw new Error('云端版本已不存在，暂时无法覆盖本地');
        await _applyRemoteValue(data.key, data.value, data.updated_at);
      }

      _recordConflict(key, choice, conflict);
      _clearPendingConflict(key);
      _lastPullError = '';
      return { ok: true, key, choice };
    } catch (e) {
      const reason = String((e && e.message) || e || '处理冲突失败');
      _lastPullError = reason;
      return { ok: false, key, choice, reason };
    } finally {
      _resolvingConflictKeys.delete(key);
      _emitStatus();
    }
  }

  // ── 变更上报（saveData 钩子调用）─────────────────────
  function onLocalChange(key) {
    // 日志类 key（AI 对话 / 教材讲解 / 全书问答）已剥离到独立通道 sync-logs.js：
    // 走 saveData 的写点（如 settings.js 写 study_ai_convs）在此转发给 SyncLogs。
    if (key === 'study_ai_convs' || key === 'study_bk_explain_logs_v1' || key === 'study_bk_qa_logs_v1') {
      if (typeof window.SyncLogs !== 'undefined' && window.SyncLogs.onLocalChange) {
        window.SyncLogs.onLocalChange(key);
      }
      return;
    }
    if (!isSyncKey(key)) return;
    if (remoteApplyDepth > 0) return;   // 远端写回本地不触发回传，防循环
    // 本地修改 → 标记「本地 dirty（有未上传修改）」。
    // 不再用设备时钟写 localTs：设备时钟偏差（如 iPad 时钟偏快）会污染 LWW 比较，
    // 导致「云端不比本地新」→ 永不拉取。localTs 只在与服务器成功交互后写入服务器
    // updated_at（与 remoteTs 同源可比）；本地是否有未上传修改由 dirty 标记承载。
    _markLocalDirty(key);
    dirtyKeys.add(key);
    // 自动上传仅在「云同步 + 自动同步」均开启时触发；关掉自动同步后需手动「立即同步/上传全部」
    if (!enabled || !autoSync || !loggedIn || !client) return;
    dirtyKeys.add(key);
    clearTimeout(uploadTimer);
    uploadTimer = setTimeout(_flush, UPLOAD_DEBOUNCE);
  }

  // ── Realtime 订阅远端变更 ───────────────────────────
  let _subscribing = false;   // 并发锁：防止 _subscribe 被重复触发导致 channel 冲突
  async function _subscribe() {
    const c = _client();
    if (!c || !enabled || !autoSync || !loggedIn) return;
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
          payload => _debouncedPull(payload))
        .on('postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'user_data', filter: 'user_id=eq.' + session.user.id },
          payload => _debouncedPull(payload));
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
  const pendingRealtimeRows = new Map();
  function _isOwnRealtimeChange(key, updatedAt) {
    return !!key && !!updatedAt && _getRemoteTs()[key] === updatedAt;
  }
  function _debouncedPull(payload) {
    const row = payload && payload.new;
    if (row && isSyncKey(row.key)) pendingRealtimeRows.set(row.key, row.updated_at || '');
    clearTimeout(pullDebounceTimer);
    pullDebounceTimer = setTimeout(() => {
      if (!enabled || !autoSync) return;
      const known = _getRemoteTs();
      const keys = [];
      for (const [key, updatedAt] of pendingRealtimeRows) {
        // 自身 upsert 的 Realtime 回显与刚记录的服务器时间戳一致，直接忽略。
        if (!updatedAt || known[key] !== updatedAt) keys.push(key);
      }
      pendingRealtimeRows.clear();
      if (keys.length) void _pullAll(false, keys);
    }, 250);
  }

  // ── 拉取后刷新界面 ─────────────────────────────────
  // 同步写入 localStorage 后，内存中的全局变量（notes/todos/links 等）不会自动更新，
  // 需重新加载并重渲染，否则用户看到的是旧数据（即使 localStorage 已更新）。
  // 此处用 try/catch 逐个调用，避免单个模块异常影响整体刷新。
  function _refreshUI() {
    // ── 正在编辑的笔记保护：刷新会重渲染 DOM 并用 localStorage 覆盖内存，
    //    若用户正在编辑笔记标题/正文，先把输入框当前值保存，刷新后写回内存并恢复输入框与焦点，避免回退。──
    let editSnap = null;
    try {
      if (typeof getActiveNote === 'function') {
        const n = getActiveNote();
        const t = document.getElementById('noteTitleInput');
        const a = document.getElementById('notesTextarea');
        const dirty = !!(n && (n._dirtyTitle || n._dirtyContent));
        const focusT = !!t && document.activeElement === t;
        const focusA = !!a && document.activeElement === a;
        if (n && n.id && (dirty || focusT || focusA)) {
          editSnap = { id: n.id, title: t ? t.value : n.title, content: a ? a.value : n.content };
        }
      }
    } catch (e) {}
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
    // 恢复正在编辑的笔记输入（值 + 焦点），避免同步刷新打断标题/正文编辑
    if (editSnap) {
      try {
        if (typeof notes !== 'undefined' && Array.isArray(notes)) {
          const n = notes.find(x => String(x.id) === String(editSnap.id));
          if (n) { n.title = editSnap.title; n.content = editSnap.content; }
        }
        setTimeout(() => {
          const t = document.getElementById('noteTitleInput');
          const a = document.getElementById('notesTextarea');
          if (t) t.value = editSnap.title;
          if (a) a.value = editSnap.content;
          if (t) t.focus();
        }, 0);
      } catch (e) {}
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
      ver: SYNC_VER,
      enabled: enabled,
      autoSync: !!cfg.autoSync,
      loggedIn: !!sess,
      pendingCount: Object.keys(_getDirtyMap()).filter(isSyncKey).length,
      lastPull: cfg.lastPull || 0,
      lastError: _lastPullError || '',
      // 诊断字段（排查 iPad 不同步）：
      remoteTsCount: Object.keys(_getRemoteTs()).length,   // 远端时间戳记录数（0=从未成功交互→走首次同步）
      dirtyKeys: Object.keys(_getDirtyMap()),              // 待上传 dirty 标记列表（残留会挡住拉取）
      localTs: _getLocalTs(),                              // 本地时间戳（含旧版污染值，排查用）
      conflictCount: _getConflictHistory().length,
      pendingConflictCount: getPendingConflicts().length
    };
  }

  // ── 开关 ────────────────────────────────────────────
  // 总开关：开启云同步。关闭则移除订阅、清理定时器、清空队列。
  function setEnabled(on) {
    const cfg = getConfig();
    cfg.enabled = !!on;
    setConfig(cfg);
    enabled = !!on;
    // 同步 autoSync 状态（来自持久化配置）
    autoSync = !!cfg.autoSync;
    if (enabled) {
      _init();
    } else {
      _stopAutoSync();
    }
    if (global.SyncLogs && typeof global.SyncLogs.refreshAutoSync === 'function') {
      void global.SyncLogs.refreshAutoSync();
    }
    _emitStatus();
  }

  // 子开关：开启自动同步（本地变更自动上传、定时拉取、Realtime 实时、登录后自动同步）。
  // 关闭后仍可手动「立即同步」「上传全部」。
  function setAutoSync(on) {
    const cfg = getConfig();
    cfg.autoSync = !!on;
    setConfig(cfg);
    autoSync = !!on;
    if (!enabled) { _emitStatus(); return; }
    if (autoSync) {
      _init();
    } else {
      _stopAutoSync();
    }
    if (global.SyncLogs && typeof global.SyncLogs.refreshAutoSync === 'function') {
      void global.SyncLogs.refreshAutoSync();
    }
    _emitStatus();
  }

  // 停止所有自动行为：移除 Realtime 订阅 + 清理定时器 + 清空待上传队列
  function _stopAutoSync() {
    if (realtimeChannel) {
      try {
        if (_client() && typeof _client().removeChannel === 'function') _client().removeChannel(realtimeChannel);
        else realtimeChannel.unsubscribe();
      } catch (e) {}
      realtimeChannel = null;
    }
    clearTimeout(uploadTimer);
    pullScheduler.stop();
    clearTimeout(pullDebounceTimer);
    pullDebounceTimer = null;
    // 持久化 dirty/outbox 必须保留，重新开启后继续补传。
    // 复位进度条（避免界面一直显示「上传中」）
    _emitProgress({ active: false, phase: 'idle', current: 0, total: 0, key: '', label: '' });
  }

  // ── 手动触发 ────────────────────────────────────────
  async function manualSync() {
    const completed = await _pullAll(true);
    if (completed) {
      const cfg = getConfig();
      cfg.lastPull = Date.now();
      setConfig(cfg);
    }
    _emitStatus();
    return getStatus();
  }
  async function uploadAll() {
    dirtyKeys = new Set(SYNC_KEYS.filter(k => localStorage.getItem(k) !== null));
    dirtyKeys.forEach(_markLocalDirty);
    await _flush({ forceUpload: true });
    _emitStatus();
    return getStatus();
  }

  // ── 初始化 ──────────────────────────────────────────
  async function _init() {
    if (typeof getSupabaseClient !== 'function') { enabled = false; return; }
    client = getSupabaseClient();
    if (!client) { enabled = false; return; }
    // 自动同步子开关关闭时：不自动拉取/定时/订阅（仍可手动同步/上传全部）
    if (!autoSync) return;
    const session = await getSession();
    loggedIn = !!session;
    if (loggedIn) {
      _subscribe();
      await _pullAll(true);
      pullScheduler.start();
    }
    _emitStatus();
  }

  async function _doSyncAfterLogin() {
    if (!enabled || !autoSync || !loggedIn || !_client()) return;
    _subscribe();
    await _pullAll(true);
    pullScheduler.start();
  }

  let lifecycleBound = false;
  function _bindLifecycleSync() {
    if (lifecycleBound || typeof global.addEventListener !== 'function') return;
    lifecycleBound = true;
    global.addEventListener('online', function () {
      if (!enabled || !autoSync || !loggedIn) return;
      _hydrateDirtyKeys();
      void pullScheduler.trigger();
      if (global.SyncLogs && typeof global.SyncLogs.retryPending === 'function') {
        void global.SyncLogs.retryPending();
      }
    });
    if (global.document && typeof global.document.addEventListener === 'function') {
      global.document.addEventListener('visibilitychange', function () {
        if (global.document.visibilityState === 'visible' && enabled && autoSync && loggedIn) {
          void pullScheduler.trigger();
        }
      });
    }
  }

  function init() {
    const cfg = getConfig();
    enabled = !!cfg.enabled;
    autoSync = !!cfg.autoSync;
    _hydrateDirtyKeys();
    _hydratePendingConflicts();
    _bindLifecycleSync();
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
            } else {
              // 事件未带 session，异步获取确认
              getSession().then(function (s) {
                loggedIn = !!s;
                if (loggedIn) {
                  _doSyncAfterLogin();
                }
                _emitStatus();
              });
            }
            _emitStatus();
          } else if (event === 'SIGNED_OUT') {
            loggedIn = false;
            pullScheduler.stop();
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
    setAutoSync,
    isSyncKey,
    onLocalChange,
    manualSync,
    uploadAll,
    getStatus,
    getPendingConflicts,
    resolveConflict,
    getConflictHistory: _getConflictHistory,
    clearConflictHistory() { localStorage.removeItem(CONFLICT_HISTORY_KEY); },
    onStatus,
    onProgress,
    get enabled() { return enabled; },
    get autoSync() { return autoSync; },
    get loggedIn() { return loggedIn; }
  };
  if (global.__MST_TEST__) {
    global.Sync.__test = { isOwnRealtimeChange: _isOwnRealtimeChange, uploadKeys: _uploadKeys };
  }
  if (global.StudyPlatform && !global.StudyPlatform.getModule('sync')) {
    global.StudyPlatform.defineModule('sync', global.Sync);
  }
})(typeof window !== 'undefined' ? window : globalThis);
