// ═══════════════════════════════════════════════════════════════════
// js/sync-logs.js — 日志类数据独立云同步通道（v0.4.1）
// 将三类「大数据」从通用同步（sync.js → user_data）中剥离：
//   - ai_conv     AI 对话（study_ai_convs）
//   - bk_explain  教材章节讲解日志（study_bk_explain_logs_v1）
//   - bk_qa       教材全书问答日志（study_bk_qa_logs_v1）
// 与 sync.js 的 uploadChain 完全并行（独立 Promise 链），超大 item 不会
// 阻塞待办/笔记等普通同步。
//
// 特性：
//   - 按 item 粒度分片增量上传（章节/书/会话），仅对变更 item 上传
//   - 传输层 gzip 压缩（原生 CompressionStream，零依赖），云端存压缩串
//   - 每用户配额（默认 50MB，可配置）+ TTL 保留策略（教材 3 个月 / AI 最近 20 会话）
//   - 离线队列：失败写入 IndexedDB，网络恢复自动补传
//   - 设置页「云存储」管理面板：配额进度条 + item 列表 + 同步开关
//   - 旧数据迁移：user_data 表残留三 key 云端行自动导入并清理
//
// 依赖：friends.js 的 getSupabaseClient()、sync.js 的 Sync.enabled 总开关
// 加载顺序：必须在 sync.js 之后（需同步其 enabled 状态），仅运行期依赖全局函数
// ═══════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';

  // ── 常量 ──────────────────────────────────────────────
  const LOG_KEYS = {
    'study_ai_convs': 'ai_conv',
    'study_bk_explain_logs_v1': 'bk_explain',
    'study_bk_qa_logs_v1': 'bk_qa'
  };
  const KIND_LABELS = {
    'ai_conv': 'AI 对话',
    'bk_explain': '章节讲解',
    'bk_qa': '全书问答'
  };
  // item 压缩后 base64 长度上限（约 525K 二进制 → 1.5MB 原始文本量级），
  // 超过则按 items 数组二分分片（_p0/_p1 后缀），避免单行 jsonb / 请求体过大。
  const MAX_ITEM_CHAR = 700 * 1024;
  const CFG_KEY = 'study_sync_logs_cfg';       // { quotaMB, autoSync }
  const TS_KEY = 'study_sync_logs_ts';         // { [kind/itemId]: ISO }
  const HASH_KEY = 'study_sync_logs_hash';     // { [kind/itemId]: base64 哈希 }
  const MARKS_KEY = 'study_sync_logs_marks';   // { [kind/itemId]: boolean 是否上传 }
  const MIGRATED_KEY = 'study_sync_logs_migrated'; // 旧数据迁移完成标记
  const IDB_NAME = 'mst-sync-logs';
  const IDB_STORE = 'outbox';
  const UPLOAD_DEBOUNCE = 2000;
  const PULL_INTERVAL = 30 * 60 * 1000;
  const BK_TTL_MS = 90 * 24 * 3600 * 1000;     // 教材日志云端保留 3 个月
  const AI_MAX_CONVS = 20;                     // AI 会话云端保留最近 20 个
  const DEFAULT_QUOTA_MB = 50;

  let client = null;
  let cfg = { quotaMB: DEFAULT_QUOTA_MB, autoSync: true };
  let loggedIn = false;
  let applyingRemote = false;
  let uploadTimer = null;
  let pullTimer = null;
  let realtimeChannel = null;
  let pullDebounceTimer = null;
  let listeners = new Set();
  let progressListeners = new Set();
  // 同步进度状态（面板「同步」区块实时显示；见 _emitProgress / _statusLine）
  let progressState = {
    phase: 'idle',        // idle | quota | uploading | outbox | pulling | done | error
    current: '',          // 正在同步的 item 名称（如「算法导论 · 排序与堆」）
    uploaded: 0,
    total: 0,             // 当前批次待上传分片总数
    pending: 0,           // 待同步 item 数（从未上传过的 on 项）
    outbox: 0,            // 离线待补传条数
    dirtyHint: false,     // 本地有变更尚未同步（onLocalChange 置位，上传完成后清除）
    lastSyncAt: null,     // 上次同步完成时间 HH:mm
    lastError: ''
  };

  // ── 工具：本地读取 ────────────────────────────────────
  function _getLocal(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch (e) { return fallback; }
  }
  function _setLocal(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function _getTs(kindItemId) { return _getLocal(TS_KEY, {})[kindItemId] || null; }
  function _setTs(kindItemId, iso) { const m = _getLocal(TS_KEY, {}); m[kindItemId] = iso; _setLocal(TS_KEY, m); }
  function _getHash(kindItemId) { return _getLocal(HASH_KEY, {})[kindItemId] || null; }
  function _setHash(kindItemId, h) { const m = _getLocal(HASH_KEY, {}); m[kindItemId] = h; _setLocal(HASH_KEY, m); }
  function _delHash(kindItemId) { const m = _getLocal(HASH_KEY, {}); delete m[kindItemId]; _setLocal(HASH_KEY, m); }
  function _getMarks() { return _getLocal(MARKS_KEY, {}); }
  function _isItemOn(kind, itemId) { const m = _getMarks(); const v = m[kind + '/' + itemId]; return v !== false; }
  function _setItemEnabled(kind, itemId, on) {
    const m = _getMarks();
    m[kind + '/' + itemId] = !!on;
    _setLocal(MARKS_KEY, m);
  }

  function _loadCfg() {
    cfg = Object.assign({ quotaMB: DEFAULT_QUOTA_MB, autoSync: true }, _getLocal(CFG_KEY, {}));
    if (typeof cfg.quotaMB !== 'number' || !(cfg.quotaMB > 0)) cfg.quotaMB = DEFAULT_QUOTA_MB;
  }
  function _saveCfg() { _setLocal(CFG_KEY, cfg); }

  // ── Supabase 会话与客户端 ─────────────────────────────
  async function _session() {
    try {
      const supabaseClient = (typeof getSupabaseClient === 'function') ? getSupabaseClient() : client;
      if (!supabaseClient || !supabaseClient.auth) return null;
      let res = supabaseClient.auth.getSession();
      if (res && typeof res.then === 'function') res = await res;
      const data = res && res.data ? res.data : null;
      return data && data.session ? data.session : null;
    } catch (e) { return null; }
  }
  function _client() {
    if (typeof getSupabaseClient === 'function') {
      const c = getSupabaseClient();
      if (c) { client = c; return c; }
    }
    return client;
  }
  // 总开关跟随 sync.js 的 Sync.enabled
  function _enabled() {
    return !!(global.Sync && global.Sync.enabled);
  }
  function _autoSyncOn() {
    return !!cfg.autoSync && _enabled();
  }

  // ── 变更上报（写点 / saveData 转发调用）────────────────
  function onLocalChange(key) {
    if (!LOG_KEYS[key]) return;
    if (applyingRemote) return;   // 远端写回本地不触发回传，防循环
    if (!_enabled() || !cfg.autoSync || !loggedIn || !client) return;
    // 仅置 dirty 标记（不在高频写点里重算 pending，避免流式输出卡顿）
    _emitProgress({ dirtyHint: true });
    scheduleUpload();
  }

  let scheduled = false;
  function scheduleUpload() {
    if (scheduled) return;
    scheduled = true;
    clearTimeout(uploadTimer);
    uploadTimer = setTimeout(() => {
      scheduled = false;
      _flushLogs();
    }, UPLOAD_DEBOUNCE);
  }

  // ── IndexedDB 离线队列（log: 前缀，独立于 sync.js）─────
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
  async function _outboxPut(key, value) {
    try {
      const db = await _idbOpen();
      return new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put({ key, value });
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

  // ── 传输层编码：优先 gzip（原生 CompressionStream），不支持则降级 plain base64 ──
  // 手机 PWA / 旧 WebView 可能缺失 CompressionStream 或 Blob.stream()，
  // 若直接抛错会被 _packItem 的 catch 静默跳过 → 所有 item 都传不上去。
  async function _encodePayload(obj) {
    const text = JSON.stringify(obj);
    const canGzip = typeof CompressionStream === 'function' &&
      typeof DecompressionStream === 'function' &&
      typeof Blob !== 'undefined' && Blob.prototype && typeof Blob.prototype.stream === 'function';
    if (canGzip) {
      try {
        const enc = new TextEncoder();
        const blob = new Blob([enc.encode(text)]);
        const stream = blob.stream().pipeThrough(new CompressionStream('gzip'));
        const buf = await new Response(stream).arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        const CH = 0x8000;
        for (let i = 0; i < bytes.length; i += CH) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        }
        return { b64: btoa(bin), rawBytes: bytes.length, algo: 'gzip' };
      } catch (e) { /* fallthrough to plain */ }
    }
    // 降级：明文 base64（任何环境可用；体积更大，会触发更早分片，仍能增量上传）
    const plain = btoa(unescape(encodeURIComponent(text)));
    return { b64: plain, rawBytes: plain.length, algo: 'plain' };
  }
  async function _decodePayload(data) {
    try {
      if (data && data.v === 1 && typeof data.d === 'string') {
        if (data.c === 'gzip') {
          const bin = atob(data.d);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
          const buf = await new Response(stream).arrayBuffer();
          return JSON.parse(new TextDecoder().decode(buf));
        }
        if (data.c === 'plain') {
          return JSON.parse(decodeURIComponent(escape(atob(data.d))));
        }
      }
      // 旧明文数据透传（未压缩对象）
      return (data && typeof data === 'object') ? data : null;
    } catch (e) { return null; }
  }

  // ── item 提取（含 TTL 过滤，本地数据不动）──────────────
  function _extractBkItems(kind, key) {
    let store = {};
    try { store = JSON.parse(localStorage.getItem(key)) || {}; } catch (e) {}
    const cutoff = Date.now() - BK_TTL_MS;
    const out = [];
    for (const id of Object.keys(store)) {
      const items = (Array.isArray(store[id]) ? store[id] : [])
        .filter(l => l && (typeof l.ts === 'number' ? l.ts >= cutoff : true));
      if (!items.length) continue;
      out.push({ kind, itemId: id, meta: { id }, tree: null, items });
    }
    return out;
  }
  function _extractAiItems() {
    let arr = [];
    try { arr = JSON.parse(localStorage.getItem('study_ai_convs')) || []; } catch (e) {}
    if (!Array.isArray(arr)) return [];
    const recent = arr.slice(-AI_MAX_CONVS);   // TTL：仅最近 20 个会话上传
    const out = [];
    for (const conv of recent) {
      if (!conv || conv.id == null) continue;
      out.push({
        kind: 'ai_conv',
        itemId: String(conv.id),
        meta: {
          id: conv.id,
          title: conv.title || '',
          systemPrompt: conv.systemPrompt || '',
          createdAt: conv.createdAt || 0,
          autoTitled: !!conv.autoTitled
        },
        tree: conv.tree || null,
        activePath: conv.activePath || null,
        items: Array.isArray(conv.messages) ? conv.messages : []
      });
    }
    return out;
  }
  function _extractAll() {
    const items = [];
    items.push.apply(items, _extractBkItems('bk_explain', 'study_bk_explain_logs_v1'));
    items.push.apply(items, _extractBkItems('bk_qa', 'study_bk_qa_logs_v1'));
    items.push.apply(items, _extractAiItems());
    return items;
  }

  // ── 压缩 + 分片（超限按 items 数组二分，_p0/_p1 后缀）──
  function _hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  async function _packRec(itemId, meta, tree, activePath, items, depth) {
    const payload = { meta, tree, activePath, items, part: 0, parts: 1 };
    const r = await _encodePayload(payload);
    if (r.b64.length <= MAX_ITEM_CHAR || items.length <= 1 || depth >= 6) {
      return [{ itemId, wrap: { v: 1, c: r.algo, d: r.b64 }, bytes: r.rawBytes }];
    }
    const mid = Math.ceil(items.length / 2);
    const left = await _packRec(itemId + '_p0', meta, tree, activePath, items.slice(0, mid), depth + 1);
    const right = await _packRec(itemId + '_p1', meta, null, null, items.slice(mid), depth + 1);
    return left.concat(right);
  }
  async function _packItem(item) {
    return _packRec(item.itemId, item.meta, item.tree, item.activePath || null, item.items, 0);
  }

  // ── 上传单 item（含 hash 增量跳过、离线队列）────────────
  // force=true（「上传全部」）：跳过 hash 增量判断，强制 upsert——
  // 用于云端行曾被误删/外部清理时自愈补齐（本地 hash 存在会导致普通增量跳过）。
  async function _uploadPiece(session, piece, force) {
    const key = piece.kind + '/' + piece.itemId;
    const hash = _hashStr(piece.wrap.d);
    if (!force && _getHash(key) === hash) return { ok: true, skipped: true };
    const c = _client();
    if (!c) return { ok: false, reason: 'no-client' };
    const updatedAt = new Date().toISOString();
    const { error } = await c.from('user_sync_items')
      .upsert({
        user_id: session.user.id,
        kind: piece.kind,
        item_id: piece.itemId,
        data: piece.wrap,
        bytes: piece.bytes,
        updated_at: updatedAt
      }, { onConflict: 'user_id,kind,item_id' });
    if (error) {
      await _outboxPut('log:' + key, piece);   // 离线 → 待补传
      return { ok: false, reason: error.message };
    }
    _setTs(key, updatedAt);
    _setHash(key, hash);
    await _outboxRemove('log:' + key);
    return { ok: true };
  }

  // ── 一次完整同步：配额检查 → 提取 → 压缩 → 上传 → 补传 → 拉取 → 清理 ──
  let logUploadChain = Promise.resolve();
  async function _flushLogs() {
    if (!_enabled() || !loggedIn || !client) return;
    const session = await _session();
    if (!session) return;
    const c = _client();
    if (!c) return;
    let syncHadError = '';

    // ① 配额软护栏：已用 ≥ 配额则跳过上传（新日志自动停止上传，本地保留），
    //    仍执行拉取合并；避免配额无限增长。用户删除云端内容后自动恢复。
    _emitProgress({ phase: 'quota', current: '', uploaded: 0, total: 0 });
    let quotaExceeded = false;
    try {
      const usedBytes = await _fetchUsage(session, c);
      quotaExceeded = usedBytes >= cfg.quotaMB * 1024 * 1024;
    } catch (e) {}

    const retainedBase = new Set();   // 本次应保留的云端基础 id（供 TTL 清理）
    if (!quotaExceeded) {
      // ② 提取所有 item（TTL 过滤），仅上传「用户开启 + 数据有变化」的 item；
      //    先全部压缩收集（得到总片数供进度统计），再逐片串行上传
      const items = _extractAll();
      const queue = [];   // [{ kind, name, pieces }]
      for (const item of items) {
        retainedBase.add(item.kind + '/' + item.itemId);
        if (!_isItemOn(item.kind, item.itemId)) continue;   // 用户关闭 → 本地保留、跳过上传
        let pieces;
        try {
          pieces = await _packItem(item);
        } catch (e) {
          console.warn('[SyncLogs] 压缩失败:', item.kind + '/' + item.itemId, e);
          continue;
        }
        queue.push({ kind: item.kind, name: _itemName(item.kind, item), pieces });
      }
      let totalPieces = 0;
      queue.forEach(q => { totalPieces += q.pieces.length; });

      // ③ 逐片串行上传（进度：正在同步「名称」（i/N））
      let done = 0;
      for (const q of queue) {
        for (const p of q.pieces) {
          done++;
          p.kind = q.kind;
          _emitProgress({ phase: 'uploading', current: q.name, uploaded: done, total: totalPieces });
          const r = await _uploadPiece(session, p);
          if (!r.ok) syncHadError = r.reason || '上传失败';
        }
      }

      // ④ 补传离线队列（网络恢复自动重传）
      const outboxAll = await _outboxGetAll();
      const outboxCount = outboxAll.filter(it => typeof it.key === 'string' && it.key.indexOf('log:') === 0).length;
      _emitProgress({ phase: 'outbox', outbox: outboxCount, current: '', uploaded: 0, total: 0 });
      await _flushOutbox(session, c);

      // ⑤ TTL 清理：已禁用！
      // 原 _pruneRemote 用「本机提取集合」判断云端行是否保留，跨设备时灾难性误删——
      // 手机本地只有 4 个会话、电脑 7 个，手机一同步就把云端"本地没有"的会话删掉。
      // 云端 TTL 清理改由云端定时任务（后续）负责；此处不再做任何删除。
      // await _pruneRemote(session, c, retainedBase);
    }

    // ⑥ 拉取远端合并（LWW：远端新于本地才写回；不受配额限制）
    _emitProgress({ phase: 'pulling', current: '', uploaded: 0, total: 0 });
    await _pullItems(session, c);

    // ⑦ 完成：汇总待同步数（仍未上传的项）并清除 dirty 标记
    const nowStr = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    _emitProgress({
      phase: 'done',
      current: '', uploaded: 0, total: 0,
      pending: _computePendingCount(),
      dirtyHint: false,
      outbox: 0,
      lastSyncAt: nowStr,
      lastError: syncHadError
    });
    _emitStatus();
  }

  async function _flushOutbox(session, c) {
    const items = await _outboxGetAll();
    for (const it of items) {
      if (typeof it.key !== 'string' || it.key.indexOf('log:') !== 0) continue;
      const p = it.value;
      if (!p) continue;
      const { error } = await c.from('user_sync_items')
        .upsert({
          user_id: session.user.id,
          kind: p.kind,
          item_id: p.itemId,
          data: p.wrap,
          bytes: p.bytes,
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id,kind,item_id' });
      if (!error) {
        const key = p.kind + '/' + p.itemId;
        _setTs(key, new Date().toISOString());
        _setHash(key, _hashStr(p.wrap.d));
        await _outboxRemove(it.key);
      }
    }
  }

  // ── 拉取合并 ─────────────────────────────────────────
  async function _pullItems(session, c) {
    const { data, error } = await c.from('user_sync_items')
      .select('kind,item_id,data,updated_at')
      .eq('user_id', session.user.id);
    if (error || !data) return;
    // 按 kind + 基础 id（去 _pN 分片后缀）分组
    const grouped = {};
    for (const row of data) {
      const baseId = row.item_id.replace(/_(p\d+)+$/, '');
      const key = row.kind + '/' + baseId;
      (grouped[key] = grouped[key] || []).push(row);
    }
    applyingRemote = true;
    try {
      for (const key of Object.keys(grouped)) {
        const [kind, baseId] = key.split('/');
        const pieces = grouped[key];
        const remoteUpdated = pieces.reduce((m, p) =>
          new Date(p.updated_at).getTime() > new Date(m).getTime() ? p.updated_at : m, pieces[0].updated_at);
        const localTs = _getTs(key);
        if (localTs && new Date(localTs).getTime() >= new Date(remoteUpdated).getTime()) continue;
        // 按 item_id 字典序重组分片（二分分片 p0<p1 顺序正确）
        const built = await _rebuildPieces(pieces);
        if (!built) continue;
        _applyToLocal(kind, baseId, built);
        _setTs(key, remoteUpdated);
      }
    } finally {
      applyingRemote = false;
    }
  }
  async function _rebuildPieces(pieces) {
    const sorted = pieces.slice().sort((a, b) => a.item_id.localeCompare(b.item_id));
    let meta = null, tree = null, activePath = null, items = [];
    for (const p of sorted) {
      const obj = await _decodePayload(p.data);
      if (!obj) return null;
      if (obj.meta) meta = obj.meta;
      if (obj.tree) tree = obj.tree;
      if (obj.activePath) activePath = obj.activePath;
      if (Array.isArray(obj.items)) items = items.concat(obj.items);
    }
    return { meta, tree, activePath, items };
  }
  // 写回本地对应 key（注意：不触发 SyncLogs.onLocalChange，靠 applyingRemote 防回环）
  function _applyToLocal(kind, itemId, built) {
    try {
      if (kind === 'bk_explain' || kind === 'bk_qa') {
        const key = kind === 'bk_explain' ? 'study_bk_explain_logs_v1' : 'study_bk_qa_logs_v1';
        let store = {};
        try { store = JSON.parse(localStorage.getItem(key)) || {}; } catch (e) {}
        if (Array.isArray(built.items)) {
          store[itemId] = built.items;
          localStorage.setItem(key, JSON.stringify(store));
        }
      } else if (kind === 'ai_conv') {
        if (typeof aiConvs === 'undefined' || typeof safeSaveAiConvs !== 'function') return;
        const id = built.meta ? built.meta.id : itemId;
        const patch = {
          id: id,
          title: (built.meta && built.meta.title) || '',
          systemPrompt: (built.meta && built.meta.systemPrompt) || '',
          createdAt: (built.meta && built.meta.createdAt) || 0,
          autoTitled: !!(built.meta && built.meta.autoTitled),
          messages: Array.isArray(built.items) ? built.items : []
        };
        // 树状分支字段仅在远端有值时覆盖，避免旧明文数据（无 tree）清空本地分支树
        if (built.tree) patch.tree = built.tree;
        if (built.activePath) patch.activePath = built.activePath;
        let found = false;
        for (let i = 0; i < aiConvs.length; i++) {
          if (String(aiConvs[i].id) === String(id)) {
            // 仅覆盖远端可能有的字段，保留本地独有字段（_dailyReport 等标记）
            aiConvs[i] = Object.assign({}, aiConvs[i], patch);
            found = true;
            break;
          }
        }
        if (!found) {
          const newConv = Object.assign({ tree: built.tree || null, activePath: built.activePath || null }, patch);
          aiConvs.push(newConv);
        }
        safeSaveAiConvs();
      }
    } catch (e) { /* 写回失败不影响其它 item */ }
  }

  // ── TTL 清理远端（过期 item 自动删，用户关闭的保留）────
  async function _pruneRemote(session, c, retainedBase) {
    const { data, error } = await c.from('user_sync_items')
      .select('id,kind,item_id')
      .eq('user_id', session.user.id);
    if (error || !data) return;
    const toDelete = [];
    for (const row of data) {
      const baseId = row.item_id.replace(/_(p\d+)+$/, '');
      if (!retainedBase.has(row.kind + '/' + baseId)) toDelete.push(row.id);
    }
    if (!toDelete.length) return;
    try {
      await c.from('user_sync_items').delete().in('id', toDelete);
    } catch (e) { /* 清理失败可容忍，下轮再试 */ }
  }

  // ── 配额聚合（bytes 列求和，不拉 data）────────────────
  async function _fetchUsage(session, c) {
    const { data, error } = await c.from('user_sync_items')
      .select('kind,bytes')
      .eq('user_id', session.user.id);
    if (error || !data) return 0;
    let total = 0;
    data.forEach(r => { total += (typeof r.bytes === 'number' ? r.bytes : 0); });
    return total;
  }
  async function getUsage() {
    _loadCfg();
    const empty = { total: 0, usedMB: 0, quotaMB: cfg.quotaMB, byKind: {}, loggedIn: false };
    const session = await _session();
    if (!session) return empty;
    const c = _client();
    if (!c) return empty;
    empty.loggedIn = true;
    const { data, error } = await c.from('user_sync_items')
      .select('kind,bytes')
      .eq('user_id', session.user.id);
    if (error || !data) return empty;
    const byKind = { 'ai_conv': 0, 'bk_explain': 0, 'bk_qa': 0 };
    let total = 0;
    data.forEach(r => {
      const b = typeof r.bytes === 'number' ? r.bytes : 0;
      byKind[r.kind] = (byKind[r.kind] || 0) + b;
      total += b;
    });
    return { total, usedMB: total / (1024 * 1024), quotaMB: cfg.quotaMB, byKind, loggedIn: true };
  }

  // ── 手动触发 ─────────────────────────────────────────
  function manualSync() {
    return _enqueue(() => _flushLogs());
  }
  function uploadAll() {
    return _enqueue(async () => {
      const session = await _session();
      if (!session) return { uploaded: 0, skipped: 0, failed: 0, reasons: [] };
      const items = _extractAll();
      let uploaded = 0, skipped = 0, failed = 0;
      const reasons = [];
      for (const item of items) {
        if (!_isItemOn(item.kind, item.itemId)) continue;
        let pieces;
        try {
          pieces = await _packItem(item);
        } catch (e) {
          failed++;
          const msg = '压缩失败: ' + item.kind + '/' + item.itemId + ' ' + (e && e.message ? e.message : e);
          reasons.push(msg);
          console.warn('[SyncLogs] ' + msg);
          continue;
        }
        for (const p of pieces) {
          p.kind = item.kind;
          try {
            // force=true：跳过 hash 增量判断，确保「全部上传」真正把所有 item 推到云端
            //（自愈云端曾被误删/清理的行；增量上传仍由自动同步走 _flushLogs）
            const r = await _uploadPiece(session, p, true);
            if (r.ok && r.skipped) skipped++;
            else if (r.ok) uploaded++;
            else {
              failed++;
              const msg = item.kind + '/' + item.itemId + ' ' + (r.reason || '上传失败');
              reasons.push(msg);
            }
          } catch (e) {
            failed++;
            const msg = item.kind + '/' + item.itemId + ' 异常: ' + (e && e.message ? e.message : e);
            reasons.push(msg);
          }
        }
      }
      // 结果可见：toast + console + 状态条
      const summary = '上传完成：成功 ' + uploaded + '，跳过 ' + skipped + (failed ? '，失败 ' + failed : '');
      console.warn('[SyncLogs] uploadAll 结果:', { uploaded, skipped, failed, reasons });
      if (typeof showMiniToast === 'function') {
        try {
          showMiniToast(summary + (failed ? '（' + reasons[0] + '）' : ''), failed ? 'error' : '');
        } catch (e) {}
      }
      _emitProgress({
        phase: failed ? 'error' : 'done',
        current: '', uploaded: 0, total: 0,
        lastError: failed ? reasons[0] : '',
        lastSyncAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      });
      if (failed === 0) await _flushLogs();
      return { uploaded, skipped, failed, reasons };
    });
  }
  // 独立串行队列：所有手动/自动任务排队执行，不并发
  function _enqueue(fn) {
    const run = logUploadChain.then(fn).catch((e) => { console.warn('[SyncLogs] 任务异常:', e); });
    logUploadChain = run.catch(() => {});
    return run;
  }

  // ── 面板：配额 + item 列表 ───────────────────────────
  async function renderPanel() {
    const root = document.getElementById('storagePanelRoot');
    if (!root) return;
    root.innerHTML = '<div style="opacity:.7;padding:8px 0;">加载中…</div>';
    const usage = await getUsage();
    const items = _extractAll();
    const marks = _getMarks();
    const tsMap = _getLocal(TS_KEY, {});
    const session = await _session();

    const pct = usage.quotaMB > 0 ? Math.min(100, (usage.usedMB / usage.quotaMB) * 100) : 0;
    const over = pct >= 100;
    const barColor = over ? '#EF4444' : (pct >= 80 ? '#F59E0B' : '#4F6EF7');

    // 配额卡片
    let html = `
      <div class="storage-quota-card">
        <div class="storage-quota-head">
          <span class="storage-quota-title"><i data-lucide="hard-drive" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle;"></i> 云存储用量</span>
          <span class="storage-quota-num">${usage.usedMB.toFixed(2)} MB / ${usage.quotaMB} MB</span>
        </div>
        <div class="storage-quota-bar"><div class="storage-quota-fill" style="width:${pct.toFixed(1)}%;background:${barColor};"></div></div>
        <div class="storage-quota-hint">${over
          ? '已超出配额！新日志将不再上传，请删除部分云端内容或提高配额。'
          : '超出后新日志自动停止上传（本地数据不受影响）。'}</div>
        <div class="storage-quota-ttl">保留策略：教材讲解/问答日志云端仅保留最近 3 个月；AI 对话仅保留最近 20 个会话（本地始终保留全部）。</div>
      </div>
      <div class="storage-actions">
        <button class="storage-btn storage-btn-primary" onclick="SyncLogs.manualSync()"><i data-lucide="refresh-cw" class="lucide-icon" style="width:13px;height:13px;"></i> 立即同步</button>
        <button class="storage-btn" onclick="SyncLogs.uploadAll()"><i data-lucide="upload-cloud" class="lucide-icon" style="width:13px;height:13px;"></i> 上传全部</button>
        <span class="storage-status" id="storageStatus"></span>
      </div>`;

    // 分组
    const groups = [
      { kind: 'ai_conv', icon: 'message-square', title: 'AI 对话' },
      { kind: 'bk_explain', icon: 'book-open', title: '章节讲解' },
      { kind: 'bk_qa', icon: 'search', title: '全书问答' }
    ];
    for (const g of groups) {
      const list = items.filter(i => i.kind === g.kind);
      html += `<div class="storage-group">
        <div class="storage-group-title"><i data-lucide="${g.icon}" class="lucide-icon" style="width:13px;height:13px;"></i> ${g.title}
          <span class="storage-group-count">${list.length}</span></div>`;
      if (!list.length) {
        html += `<div class="storage-empty">暂无数据</div>`;
      } else {
        for (const item of list) {
          const key = item.kind + '/' + item.itemId;
          const on = _isItemOn(item.kind, item.itemId);
          const name = _itemName(g.kind, item);
          const sizeTxt = _itemSizeText(item);
          const hasRemote = !!tsMap[key];
          html += `<div class="storage-item">
            <div class="storage-item-info">
              <div class="storage-item-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
              <div class="storage-item-meta">${sizeTxt} ｜ ${hasRemote ? '已同步' : '未上传'}</div>
            </div>
            <label class="toggle-switch" title="${on ? '关闭后不再上传（本地保留）' : '开启后同步到云端'}">
              <input type="checkbox" ${on ? 'checked' : ''} onchange="SyncLogs.setItemEnabled('${item.kind}','${String(item.itemId).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}',this.checked)">
              <span class="toggle-slider"></span>
            </label>
          </div>`;
        }
      }
      html += `</div>`;
    }

    html += `<div class="storage-actions" style="margin-top:4px;">
      <button class="storage-btn storage-btn-danger" onclick="SyncLogs.deleteAllRemote()"><i data-lucide="trash-2" class="lucide-icon" style="width:13px;height:13px;"></i> 从云端删除全部（本地保留）</button>
    </div>`;

    root.innerHTML = html;
    if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
    const st = document.getElementById('storageStatus');
    if (st) st.textContent = session ? _statusLine() : '未登录，登录后自动同步';
  }
  // 章节 id 为 genId() 生成（全局唯一），可跨书查找章节名（booksData 来自 books.js，加载在 sync-logs.js 之前）
  function _resolveChapterTitle(chapterId) {
    try {
      if (typeof booksData === 'undefined') return null;
      for (const book of booksData) {
        const ch = (book.chapters || []).find(c => String(c.id) === String(chapterId));
        if (ch && ch.title) return { bookTitle: book.title, chapterTitle: ch.title };
      }
    } catch (e) {}
    return null;
  }
  function _resolveBookTitle(bookId) {
    try {
      if (typeof booksData === 'undefined') return null;
      const b = booksData.find(x => String(x.id) === String(bookId));
      return b && b.title ? String(b.title) : null;
    } catch (e) {}
    return null;
  }
  function _itemName(kind, item) {
    if (kind === 'ai_conv') {
      const t = item.meta && item.meta.title;
      if (t) return String(t);
      const msgs = item.items || [];
      const first = msgs.find(m => m && m.role === 'user' && m.content);
      return '会话 ' + String(item.itemId).slice(-6) + (first ? '：' + String(first.content).slice(0, 18) : '');
    }
    if (kind === 'bk_explain') {
      const r = _resolveChapterTitle(item.itemId);
      if (r) return r.bookTitle + ' · ' + r.chapterTitle;
      return '章节 ' + String(item.itemId).slice(-10);
    }
    if (kind === 'bk_qa') {
      const t = _resolveBookTitle(item.itemId);
      if (t) return t;
      return '书本 ' + String(item.itemId).slice(-10);
    }
    return String(item.itemId);
  }
  function _itemSizeText(item) {
    let n = 0;
    for (const m of item.items || []) n += String(m && m.content || '').length;
    return n > 1024 ? (n / 1024).toFixed(1) + 'K 字' : n + ' 字';
  }

  function setItemEnabled(kind, itemId, on) {
    _setItemEnabled(kind, itemId, on);
    if (on && _enabled() && loggedIn && client) scheduleUpload();
    renderPanel();
  }

  async function deleteAllRemote() {
    if (!confirm('确定从云端删除全部日志数据？本地数据不受影响，已删除的条目在下次内容变化前不会重新上传。')) return;
    const session = await _session();
    if (!session) return;
    const c = _client();
    if (!c) return;
    await c.from('user_sync_items').delete().eq('user_id', session.user.id);
    // 保留 ts/hash 状态：数据未变化时不会立即全部重传（增量上传幂等）
    const st = document.getElementById('storageStatus');
    if (st) st.textContent = '已删除云端全部日志数据（本地保留）。';
    renderPanel();
  }

  // ── 同步进度通知（面板实时显示「正在同步什么 / 待同步队列」）──
  function _emitProgress(patch) {
    Object.assign(progressState, patch || {});
    progressListeners.forEach(fn => { try { fn(progressState); } catch (e) {} });
    // 面板打开时轻量更新状态条（不整表重渲染，避免闪烁/滚动丢失）
    const st = document.getElementById('storageStatus');
    if (st) {
      st.textContent = _statusLine();
      st.style.color = progressState.phase === 'error' ? '#EF4444' : '';
    }
  }
  // 综合状态文本
  function _statusLine() {
    const p = progressState;
    const pendTxt = p.pending > 0 ? (p.pending + ' 项待上传') : (p.dirtyHint ? '有变更待同步' : '已全部同步');
    let t;
    switch (p.phase) {
      case 'quota': t = '配额检查中…'; break;
      case 'uploading':
        t = '正在同步「' + (p.current || '…') + '」' + (p.total ? '（' + Math.min(p.uploaded, p.total) + '/' + p.total + '）' : '');
        if (p.outbox > 0) t += ' · 离线补传 ' + p.outbox;
        return t;
      case 'outbox': t = '正在补传离线数据' + (p.outbox ? '（' + p.outbox + ' 条）' : '') + '…'; break;
      case 'pulling': t = '正在拉取云端合并…'; break;
      case 'error': return '同步出错：' + (p.lastError || '未知错误');
      case 'done':
      case 'idle':
      default:
        t = pendTxt;
        if (p.lastSyncAt) t += ' · 上次 ' + p.lastSyncAt;
        if (p.lastError) t += ' · 有失败项';
        return t;
    }
    return t + ' · ' + pendTxt;
  }
  // 待同步 item 数：TTL 内、已开启、且从未上传过（hash 缺失）的项（同步计算，不 gzip）
  function _computePendingCount() {
    let n = 0;
    const hashMap = _getLocal(HASH_KEY, {});
    const items = _extractAll();
    for (const item of items) {
      if (!_isItemOn(item.kind, item.itemId)) continue;
      if (!hashMap[item.kind + '/' + item.itemId]) n++;
    }
    return n;
  }
  function onProgress(fn) {
    progressListeners.add(fn);
    return () => progressListeners.delete(fn);
  }
  function getSyncProgress() {
    return Object.assign({}, progressState);
  }

  // ── 状态通知 ─────────────────────────────────────────
  async function _emitStatus() {
    const status = await getStatus();
    listeners.forEach(fn => { try { fn(status); } catch (e) {} });
  }
  function onStatus(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  async function getStatus() {
    const sess = await _session();
    if (sess && !loggedIn) loggedIn = true;
    if (!sess && loggedIn) loggedIn = false;
    return {
      enabled: _enabled(),
      autoSync: !!cfg.autoSync,
      loggedIn: !!sess
    };
  }

  // ── 旧数据迁移（user_data 三 key 行 → user_sync_items）──
  async function migrateLegacy() {
    try {
      if (localStorage.getItem(MIGRATED_KEY)) return;   // 已迁移过
    } catch (e) {}
    const session = await _session();
    if (!session) return;
    const c = _client();
    if (!c) return;
    const legacyKeys = Object.keys(LOG_KEYS);
    const { data, error } = await c.from('user_data')
      .select('key,value,updated_at')
      .eq('user_id', session.user.id)
      .in('key', legacyKeys);
    if (error || !data || !data.length) {
      _markMigrated();
      return;
    }
    let migrated = 0;
    for (const row of data) {
      const kind = LOG_KEYS[row.key];
      if (!kind || !row.value) continue;
      // 已存在该 kind 的云端 item → 跳过（避免重复迁移覆盖）
      const existing = await c.from('user_sync_items')
        .select('id').eq('user_id', session.user.id).eq('kind', kind).limit(1);
      if (!existing.error && existing.data && existing.data.length) continue;
      const items = _legacyToItems(kind, row.value);
      for (const item of items) {
        let pieces;
        try { pieces = await _packItem(item); } catch (e) { continue; }
        for (const p of pieces) {
          await c.from('user_sync_items').upsert({
            user_id: session.user.id, kind, item_id: p.itemId, data: p.wrap,
            bytes: p.bytes, updated_at: row.updated_at || new Date().toISOString()
          }, { onConflict: 'user_id,kind,item_id' });
        }
        migrated++;
      }
      // 迁移成功后删除旧行（user_data），避免普通同步继续携带大数据
      await c.from('user_data').delete().eq('user_id', session.user.id).eq('key', row.key);
    }
    console.log('[SyncLogs] 旧数据迁移完成，迁移 item 数:', migrated);
    _markMigrated();
  }
  function _legacyToItems(kind, value) {
    if (kind === 'ai_conv' && Array.isArray(value)) {
      return value.filter(c => c && c.id != null).map(conv => ({
        kind, itemId: String(conv.id),
        meta: { id: conv.id, title: conv.title || '', systemPrompt: conv.systemPrompt || '', createdAt: conv.createdAt || 0, autoTitled: !!conv.autoTitled },
        tree: conv.tree || null, activePath: conv.activePath || null,
        items: Array.isArray(conv.messages) ? conv.messages : []
      }));
    }
    if (kind === 'bk_explain' || kind === 'bk_qa') {
      if (!value || typeof value !== 'object') return [];
      return Object.keys(value).map(id => ({
        kind, itemId: id, meta: { id }, tree: null,
        items: Array.isArray(value[id]) ? value[id] : []
      }));
    }
    return [];
  }
  function _markMigrated() {
    try { localStorage.setItem(MIGRATED_KEY, '1'); } catch (e) {}
  }

  // ── 初始化 ─────────────────────────────────────────
  async function _init() {
    _loadCfg();
    client = (typeof getSupabaseClient === 'function') ? getSupabaseClient() : null;
    if (!client) return;
    const session = await _session();
    loggedIn = !!session;
    if (!session) return;
    try { await migrateLegacy(); } catch (e) { console.warn('[SyncLogs] 迁移失败:', e); }
    _subscribe();
    if (_autoSyncOn()) {
      _enqueue(() => _flushLogs());
      clearTimeout(pullTimer);
      pullTimer = setTimeout(() => { if (_autoSyncOn()) _enqueue(() => _flushLogs()); }, PULL_INTERVAL);
    }
    _emitStatus();
  }

  // Realtime 订阅 user_sync_items（其他设备写入时实时合并）
  async function _subscribe() {
    const c = _client();
    if (!c || !_autoSyncOn() || !loggedIn) return;
    try {
      const session = await _session();
      if (!session) return;
      if (realtimeChannel) { try { await c.removeChannel(realtimeChannel); } catch (e) {} realtimeChannel = null; }
      const channel = c.channel('mst-user-sync-items')
        .on('postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'user_sync_items', filter: 'user_id=eq.' + session.user.id },
          () => _debouncedPull())
        .on('postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'user_sync_items', filter: 'user_id=eq.' + session.user.id },
          () => _debouncedPull());
      channel.subscribe();
      realtimeChannel = channel;
    } catch (e) { /* 订阅失败不影响主流程 */ }
  }
  function _debouncedPull() {
    clearTimeout(pullDebounceTimer);
    pullDebounceTimer = setTimeout(() => { if (_autoSyncOn() && loggedIn) _enqueue(() => _flushLogs()); }, 800);
  }

  // 登录状态监听（复用 sync.js 的 onAuthStateChange 思路，避免事件时序问题）
  function init() {
    _loadCfg();
    try {
      if (typeof getSupabaseClient === 'function') client = getSupabaseClient();
    } catch (e) {}
    if (client && client.auth && typeof client.auth.onAuthStateChange === 'function') {
      try {
        client.auth.onAuthStateChange(function (event, session) {
          if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') {
            if (session) {
              loggedIn = true;
              _init();
            } else {
              getSessionSafe().then(function (s) {
                loggedIn = !!s;
                if (loggedIn) _init();
                _emitStatus();
              });
            }
          } else if (event === 'SIGNED_OUT') {
            loggedIn = false;
            if (realtimeChannel) { try { realtimeChannel.unsubscribe(); } catch (e) {} realtimeChannel = null; }
            _emitStatus();
          }
        });
      } catch (e) {}
    }
    // 延迟初始化（等 sync.js 与 friends.js 就绪）
    setTimeout(() => {
      if (_enabled()) _init();
    }, 2000);
  }
  async function getSessionSafe() {
    try {
      const supabaseClient = (typeof getSupabaseClient === 'function') ? getSupabaseClient() : client;
      if (!supabaseClient || !supabaseClient.auth) return null;
      let res = supabaseClient.auth.getSession();
      if (res && typeof res.then === 'function') res = await res;
      return res && res.data && res.data.session ? res.data.session : null;
    } catch (e) { return null; }
  }

  // 供 settings.js 在「云存储」tab 打开时调用
  function renderPanelSafe() {
    try { renderPanel(); } catch (e) { console.warn('[SyncLogs] 面板渲染失败:', e); }
  }

  // ── 对外暴露 ────────────────────────────────────────
  global.SyncLogs = {
    init,
    onLocalChange,
    manualSync,
    uploadAll,
    getStatus,
    getUsage,
    getSyncProgress,
    renderPanel: renderPanelSafe,
    setItemEnabled,
    deleteAllRemote,
    migrateLegacy,
    onStatus,
    onProgress,
    get enabled() { return _enabled(); },
    get autoSync() { return !!cfg.autoSync; },
    get loggedIn() { return loggedIn; }
  };

  // 页面加载后自动初始化
  if (typeof global.addEventListener === 'function') {
    global.addEventListener('load', function () { setTimeout(init, 800); });
  } else {
    setTimeout(init, 1200);
  }
})(typeof window !== 'undefined' ? window : globalThis);
