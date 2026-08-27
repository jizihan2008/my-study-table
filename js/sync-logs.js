// ═══════════════════════════════════════════════════════════════════
// js/sync-logs.js — 日志类数据独立云同步通道（v0.6.0，定向增量同步）
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

  const policy = global.SyncPolicy;
  if (!policy) throw new Error('SyncPolicy must be loaded before sync-logs.js');

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
  const CONTENT_HASH_KEY = 'study_sync_logs_content_hash_v2'; // { [kind/itemId]: 内容哈希 }
  const DIRTY_KEY = 'study_sync_logs_dirty_v2';               // { [kind/itemId|kind/*]: true }
  const TOMBSTONE_KEY = 'study_sync_logs_tombstones_v2';       // { [kind/itemId]: { deletedAt } }
  const KNOWN_ITEMS_KEY = 'study_sync_logs_known_items_v2';    // { [kind]: [itemId] }
  const CONFLICTS_KEY = 'study_sync_logs_conflicts_v2';        // { [kind/itemId]: conflict }
  const MARKS_KEY = 'study_sync_logs_marks';   // { [kind/itemId]: boolean 是否上传 }
  const MIGRATED_KEY = 'study_sync_logs_migrated'; // 旧数据迁移完成标记
  const IDB_NAME = 'mst-sync-logs';
  const IDB_STORE = 'outbox';
  const UPLOAD_DEBOUNCE = 2000;
  const PULL_INTERVAL = 30 * 60 * 1000;
  const FULL_PULL_INTERVAL = 24 * 60 * 60 * 1000;
  const MAINTENANCE_INTERVAL = 24 * 60 * 60 * 1000;
  const USAGE_CACHE_MS = 5 * 60 * 1000;
  const USAGE_CACHE_KEY = 'study_sync_logs_usage_cache_v1';
  const BK_TTL_MS = 90 * 24 * 3600 * 1000;     // 教材日志云端保留 3 个月
  const AI_MAX_CONVS = 20;                     // AI 会话云端保留最近 20 个
  const DEFAULT_QUOTA_MB = 50;

  let client = null;
  let cfg = { quotaMB: DEFAULT_QUOTA_MB, autoSync: true };
  let loggedIn = false;
  let applyingRemote = false;
  let uploadTimer = null;
  let realtimeChannel = null;
  let pullDebounceTimer = null;
  let listeners = new Set();
  let progressListeners = new Set();
  const pullScheduler = policy.createRecurringTask(
    () => _enqueue(() => _flushLogs({ pullMode: 'incremental', maintenance: true })),
    PULL_INTERVAL
  );
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

  function _baseKey(kind, itemId) { return kind + '/' + String(itemId); }
  function _getDirtyMap() { return _getLocal(DIRTY_KEY, {}); }
  function _setDirtyMap(map) { _setLocal(DIRTY_KEY, map); }
  function _markKindDirty(kind) {
    const map = _getDirtyMap();
    map[kind + '/*'] = true;
    _setDirtyMap(map);
  }
  function _markItemDirty(kind, itemId) {
    const map = _getDirtyMap();
    map[_baseKey(kind, itemId)] = true;
    _setDirtyMap(map);
  }
  function _clearItemDirty(kind, itemId) {
    const map = _getDirtyMap();
    delete map[_baseKey(kind, itemId)];
    _setDirtyMap(map);
  }
  function _isItemDirty(kind, itemId) { return !!_getDirtyMap()[_baseKey(kind, itemId)]; }
  function _getTombstones() { return _getLocal(TOMBSTONE_KEY, {}); }
  function _getKnownItems() { return _getLocal(KNOWN_ITEMS_KEY, {}); }
  function _getConflicts() { return _getLocal(CONFLICTS_KEY, {}); }
  function _saveConflicts(map) { _setLocal(CONFLICTS_KEY, map); }
  function _isConflicted(kind, itemId) { return !!_getConflicts()[_baseKey(kind, itemId)]; }
  function _clearConflict(kind, itemId) {
    const map = _getConflicts();
    delete map[_baseKey(kind, itemId)];
    _saveConflicts(map);
  }
  function _queueConflict(kind, itemId, details) {
    const key = _baseKey(kind, itemId);
    const map = _getConflicts();
    const existing = map[key] || {};
    map[key] = Object.assign({
      kind,
      itemId: String(itemId),
      label: KIND_LABELS[kind] || kind,
      detectedAt: existing.detectedAt || new Date().toISOString()
    }, existing, details || {});
    _saveConflicts(map);
    _emitStatus();
    if (typeof document !== 'undefined') {
      const panel = document.getElementById('settingsPanelSync');
      if (panel && panel.classList.contains('active')) setTimeout(() => renderPanelSafe(), 0);
    }
  }
  function getPendingConflicts() {
    const map = _getConflicts();
    return Object.keys(map).map(key => Object.assign({ key }, map[key]))
      .sort((a, b) => String(a.detectedAt || '').localeCompare(String(b.detectedAt || '')));
  }

  function _loadCfg() {
    cfg = Object.assign({ quotaMB: DEFAULT_QUOTA_MB, autoSync: true }, _getLocal(CFG_KEY, {}));
    if (typeof cfg.quotaMB !== 'number' || !(cfg.quotaMB > 0)) cfg.quotaMB = DEFAULT_QUOTA_MB;
  }
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
    return !!cfg.autoSync && _enabled() && !!(global.Sync && global.Sync.autoSync);
  }

  // ── 变更上报（写点 / saveData 转发调用）────────────────
  function onLocalChange(key) {
    const kind = LOG_KEYS[key];
    if (!kind) return;
    if (applyingRemote) return;   // 远端写回本地不触发回传，防循环
    // 持久化类别级 dirty：即使离线、未登录或关闭自动同步也不能丢失变更。
    // 真正同步前再按 item 内容哈希细化，避免高频写点压缩整份对话造成卡顿。
    _markKindDirty(kind);
    _emitProgress({ dirtyHint: true });
    if (!_autoSyncOn() || !loggedIn || !_client()) return;
    scheduleUpload();
  }

  let scheduled = false;
  function scheduleUpload() {
    if (scheduled) return;
    scheduled = true;
    clearTimeout(uploadTimer);
    uploadTimer = setTimeout(() => {
      scheduled = false;
      _enqueue(() => _flushLogs({ pullMode: 'none', maintenance: false }));
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
    // 标签页允许拖拽排序，数组尾部不等于“最近使用”。按消息/会话活动时间选最近 20 个。
    const recent = arr.slice().sort((a, b) => _conversationActivity(a) - _conversationActivity(b)).slice(-AI_MAX_CONVS);
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
          autoTitled: !!conv.autoTitled,
          daily: !!conv._dailyReport   // 日报会话标记：拉取侧据此合并而非新建
        },
        tree: conv.tree || null,
        activePath: conv.activePath || null,
        items: Array.isArray(conv.messages) ? conv.messages : []
      });
    }
    return out;
  }
  function _conversationActivity(conv) {
    if (!conv || typeof conv !== 'object') return 0;
    const candidates = [conv.updatedAt, conv.createdAt];
    const messages = Array.isArray(conv.messages) ? conv.messages : [];
    if (messages.length) {
      const last = messages[messages.length - 1] || {};
      candidates.push(last.updatedAt, last.createdAt, last.ts, last.timestamp);
    }
    let max = 0;
    for (const value of candidates) {
      const n = typeof value === 'number' ? value : new Date(value || 0).getTime();
      if (Number.isFinite(n) && n > max) max = n;
    }
    // genId() = Date.now() * 1000 + seq；旧 ID 也常为毫秒时间戳。
    const idNum = Number(conv.id);
    if (Number.isFinite(idNum)) {
      const idTime = idNum > 1e14 ? Math.floor(idNum / 1000) : idNum;
      if (idTime > max) max = idTime;
    }
    return max;
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

  function _contentHash(item) {
    try {
      return _hashStr(JSON.stringify({
        meta: item.meta || null,
        tree: item.tree || null,
        activePath: item.activePath || null,
        items: Array.isArray(item.items) ? item.items : []
      }));
    } catch (e) { return null; }
  }

  // 将类别级 dirty 细化为 item 级，同时识别本地删除并写入墓碑。
  async function _refreshLocalState(forceAll) {
    const allItems = _extractAll();
    const byKind = {};
    allItems.forEach(item => { (byKind[item.kind] = byKind[item.kind] || []).push(item); });
    const dirty = _getDirtyMap();
    const tombstones = _getTombstones();
    const known = _getKnownItems();
    const contentHashes = _getLocal(CONTENT_HASH_KEY, {});
    const pieceHashes = _getLocal(HASH_KEY, {});
    const packed = new Map();

    for (const kind of Object.values(LOG_KEYS)) {
      const scanKind = !!forceAll || !!dirty[kind + '/*'];
      if (!scanKind) continue;
      const items = byKind[kind] || [];
      const currentIds = new Set(items.map(item => String(item.itemId)));
      const previousIds = Array.isArray(known[kind]) ? known[kind].map(String) : [];

      for (const item of items) {
        const key = _baseKey(kind, item.itemId);
        const hash = _contentHash(item);
        let changed = !hash || contentHashes[key] !== hash;
        // 从旧版平滑迁移：若尚无内容哈希，但当前压缩分片哈希与最近成功上传完全一致，则视为干净。
        if (changed && !contentHashes[key]) {
          try {
            const pieces = await _packItem(item);
            pieces.forEach(piece => { piece.kind = kind; });
            packed.set(key, pieces);
            changed = !pieces.length || pieces.some(piece => pieceHashes[_baseKey(kind, piece.itemId)] !== _hashStr(piece.wrap.d));
            if (!changed && hash) contentHashes[key] = hash;
          } catch (e) { changed = true; }
        }
        if (changed) dirty[key] = true;
        else delete dirty[key];
        delete tombstones[key];
      }

      for (const oldId of previousIds) {
        if (currentIds.has(oldId)) continue;
        const key = _baseKey(kind, oldId);
        tombstones[key] = tombstones[key] || { kind, itemId: oldId, deletedAt: new Date().toISOString() };
        dirty[key] = true;
      }
      known[kind] = Array.from(currentIds);
      delete dirty[kind + '/*'];
    }

    _setLocal(CONTENT_HASH_KEY, contentHashes);
    _setDirtyMap(dirty);
    _setLocal(TOMBSTONE_KEY, tombstones);
    _setLocal(KNOWN_ITEMS_KEY, known);
    return { items: allItems, packed };
  }

  // ── 上传单 item（含 hash 增量跳过、离线队列）────────────
  // force=true（「上传全部」）：跳过 hash 增量判断，强制 upsert。
  // 增量（force=false）跳过条件 = hash 相同 **且** 云端该行仍存在（remoteSet 含此 piece）——
  // 否则即便 hash 相同也会重传补齐，防止云端行被外部清理/误删后本地永远 skip 不补。
  async function _uploadPiece(session, piece, force, remoteSet) {
    const key = piece.kind + '/' + piece.itemId;
    const hash = _hashStr(piece.wrap.d);
    const remoteHas = !remoteSet || remoteSet.has(key);   // remoteSet 查询失败(null)时视为存在，保守不重传
    if (!force && _getHash(key) === hash && remoteHas) return { ok: true, skipped: true };
    const c = _client();
    if (!c) return { ok: false, reason: 'no-client' };
    let error = null;
    let serverUpdatedAt = '';
    try {
      const result = await c.from('user_sync_items')
        .upsert({
          user_id: session.user.id,
          kind: piece.kind,
          item_id: piece.itemId,
          data: piece.wrap,
          bytes: piece.bytes
        }, { onConflict: 'user_id,kind,item_id' })
        .select('updated_at')
        .single();
      error = result && result.error;
      serverUpdatedAt = result && result.data && result.data.updated_at;
    } catch (e) {
      error = e || new Error('network-error');
    }
    if (!error && !serverUpdatedAt) error = new Error('missing-server-timestamp');
    if (error) {
      await _outboxPut('log:' + key, piece);   // 离线 → 待补传
      return { ok: false, reason: error.message };
    }
    _setTs(key, serverUpdatedAt);
    _setHash(key, hash);
    await _outboxRemove('log:' + key);
    return { ok: true, updatedAt: serverUpdatedAt };
  }

  function _baseIdFromRemoteId(itemId) {
    return String(itemId).replace(/_(p\d+)+$/, '');
  }
  function _remoteBaseKey(kind, itemId) { return _baseKey(kind, _baseIdFromRemoteId(itemId)); }
  function _latestTimestamp(rows) {
    let latest = null;
    for (const row of rows || []) {
      if (!latest || policy.compareTimestamps(row.updated_at, latest) > 0) latest = row.updated_at;
    }
    return latest;
  }
  function _normalizeTargets(targets) {
    const map = new Map();
    for (const target of targets || []) {
      if (!target || !KIND_LABELS[target.kind] || target.itemId == null) continue;
      map.set(_baseKey(target.kind, target.itemId), { kind: target.kind, itemId: String(target.itemId) });
    }
    return Array.from(map.values());
  }

  function _targetsFromPending(localState) {
    const dirty = _getDirtyMap();
    const targets = [];
    const addKey = key => {
      const slash = String(key).indexOf('/');
      if (slash <= 0) return;
      const kind = String(key).slice(0, slash);
      const itemId = String(key).slice(slash + 1);
      if (itemId !== '*' && KIND_LABELS[kind]) targets.push({ kind, itemId });
    };
    Object.keys(dirty).forEach(addKey);
    Object.keys(_getTombstones()).forEach(addKey);
    for (const item of (localState && localState.items) || []) {
      if (_isItemDirty(item.kind, item.itemId)) targets.push({ kind: item.kind, itemId: String(item.itemId) });
    }
    return _normalizeTargets(targets);
  }

  async function _fetchRemoteInventory(session, c, targets) {
    const wanted = _normalizeTargets(targets);
    let rows = [];
    if (wanted.length) {
      try {
        const byKind = new Map();
        wanted.forEach(target => {
          const ids = byKind.get(target.kind) || [];
          ids.push(target.itemId);
          byKind.set(target.kind, ids);
        });
        for (const [kind, ids] of byKind) {
          const { data, error } = await c.from('user_sync_items')
            .select('id,kind,item_id,base_item_id,bytes,updated_at')
            .eq('user_id', session.user.id)
            .eq('kind', kind)
            .in('base_item_id', ids);
          if (error) throw new Error(error.message || 'target-inventory-failed');
          rows.push(...(data || []));
        }
      } catch (e) {
        // 旧数据库还没有 base_item_id 时保持兼容：退回一次轻量元数据扫描，
        // 再在客户端按基础 item id 精确过滤。
        const { data, error } = await c.from('user_sync_items')
          .select('id,kind,item_id,bytes,updated_at')
          .eq('user_id', session.user.id);
        if (error) throw new Error(error.message || '读取云端对话版本失败');
        const wantedSet = new Set(wanted.map(target => _baseKey(target.kind, target.itemId)));
        rows = (data || []).filter(row => wantedSet.has(_remoteBaseKey(row.kind, row.item_id)));
      }
    } else {
      const { data, error } = await c.from('user_sync_items')
        .select('id,kind,item_id,bytes,updated_at')
        .eq('user_id', session.user.id);
      if (error) throw new Error(error.message || '读取云端对话版本失败');
      rows = Array.isArray(data) ? data : [];
    }
    const groups = {};
    const set = new Set();
    rows.forEach(row => {
      const key = _remoteBaseKey(row.kind, row.item_id);
      (groups[key] = groups[key] || []).push(row);
      set.add(_baseKey(row.kind, row.item_id));
    });
    return { rows, groups, set };
  }

  function _hasRemoteAdvanced(remoteTimestamp, baseTimestamp) {
    if (!remoteTimestamp) return false;
    if (!baseTimestamp) return true;
    const compared = policy.compareTimestamps(remoteTimestamp, baseTimestamp);
    return compared === null || compared > 0;
  }

  async function _deleteRowsById(c, rows) {
    const ids = (rows || []).map(row => row && row.id).filter(Boolean);
    for (let i = 0; i < ids.length; i += 300) {
      const { error } = await c.from('user_sync_items').delete().in('id', ids.slice(i, i + 300));
      if (error) throw new Error(error.message || '清理旧云端分片失败');
    }
  }

  async function _removeOutboxForBase(kind, itemId) {
    const items = await _outboxGetAll();
    const base = String(itemId);
    for (const entry of items) {
      if (!entry || typeof entry.key !== 'string' || entry.key.indexOf('log:') !== 0) continue;
      const piece = entry.value;
      if (piece && piece.kind === kind && _baseIdFromRemoteId(piece.itemId) === base) {
        await _outboxRemove(entry.key);
      }
    }
  }

  function _deriveBaseTimestamp(kind, itemId, remoteRows) {
    const key = _baseKey(kind, itemId);
    let base = _getTs(key);
    if (base) return base;
    for (const row of remoteRows || []) {
      const pieceTs = _getTs(_baseKey(kind, row.item_id));
      if (pieceTs && (!base || policy.compareTimestamps(pieceTs, base) > 0)) base = pieceTs;
    }
    if (base) _setTs(key, base);
    return base;
  }

  async function _uploadPreparedItem(session, c, item, pieces, inventory, force) {
    const key = _baseKey(item.kind, item.itemId);
    const remoteRows = inventory.groups[key] || [];
    const remoteUpdated = _latestTimestamp(remoteRows);
    const baseTimestamp = _deriveBaseTimestamp(item.kind, item.itemId, remoteRows);
    const dirty = _isItemDirty(item.kind, item.itemId);
    if (!force && dirty && _hasRemoteAdvanced(remoteUpdated, baseTimestamp)) {
      _queueConflict(item.kind, item.itemId, {
        name: _itemName(item.kind, item),
        reason: baseTimestamp ? 'both-changed' : 'missing-sync-base',
        localDeleted: false,
        baseTimestamp: baseTimestamp || null,
        remoteTimestamp: remoteUpdated || null
      });
      return { ok: false, conflict: true };
    }

    const currentIds = new Set();
    let latestUploaded = remoteUpdated;
    let latestWriteTimestamp = null;
    for (const piece of pieces) {
      piece.kind = item.kind;
      currentIds.add(_baseKey(item.kind, piece.itemId));
      const result = await _uploadPiece(session, piece, !!force, inventory.set);
      if (!result.ok) return result;
      if (result.updatedAt && (!latestUploaded || policy.compareTimestamps(result.updatedAt, latestUploaded) > 0)) {
        latestUploaded = result.updatedAt;
      }
      if (result.updatedAt && (!latestWriteTimestamp || policy.compareTimestamps(result.updatedAt, latestWriteTimestamp) > 0)) {
        latestWriteTimestamp = result.updatedAt;
      }
    }
    if (dirty && remoteUpdated && (!latestWriteTimestamp || policy.compareTimestamps(latestWriteTimestamp, remoteUpdated) <= 0)) {
      return {
        ok: false,
        reason: '云端更新时间未推进，请在 Supabase 执行最新版 schema.sql 以安装 updated_at 触发器'
      };
    }

    // 新分片全部写入成功后，再删除同一对话不再使用的旧分片，避免清空/缩小后旧消息复活。
    const staleRows = remoteRows.filter(row => !currentIds.has(_baseKey(item.kind, row.item_id)));
    await _deleteRowsById(c, staleRows);
    await _removeOutboxForBase(item.kind, item.itemId);
    if (latestUploaded) _setTs(key, latestUploaded);
    const hashes = _getLocal(CONTENT_HASH_KEY, {});
    hashes[key] = _contentHash(item);
    _setLocal(CONTENT_HASH_KEY, hashes);
    _clearItemDirty(item.kind, item.itemId);
    _clearConflict(item.kind, item.itemId);
    return { ok: true };
  }

  async function _processTombstone(session, c, tombstone, inventory, force) {
    const kind = tombstone.kind;
    const itemId = String(tombstone.itemId);
    const key = _baseKey(kind, itemId);
    const remoteRows = inventory.groups[key] || [];
    const remoteUpdated = _latestTimestamp(remoteRows);
    const baseTimestamp = _deriveBaseTimestamp(kind, itemId, remoteRows);
    if (!force && remoteRows.length && _hasRemoteAdvanced(remoteUpdated, baseTimestamp)) {
      _queueConflict(kind, itemId, {
        name: (KIND_LABELS[kind] || kind) + ' ' + itemId.slice(-8),
        reason: 'delete-versus-remote-change',
        localDeleted: true,
        baseTimestamp: baseTimestamp || null,
        remoteTimestamp: remoteUpdated || null
      });
      return { ok: false, conflict: true };
    }
    await _deleteRowsById(c, remoteRows);
    await _removeOutboxForBase(kind, itemId);
    const tombstones = _getTombstones();
    delete tombstones[key];
    _setLocal(TOMBSTONE_KEY, tombstones);
    const dirty = _getDirtyMap();
    delete dirty[key];
    _setDirtyMap(dirty);
    const hashes = _getLocal(CONTENT_HASH_KEY, {});
    delete hashes[key];
    _setLocal(CONTENT_HASH_KEY, hashes);
    _clearConflict(kind, itemId);
    return { ok: true, deleted: true };
  }

  // ── 一次完整安全同步：识别本地变化 → 检查远端版本 → 上传/删除 → 拉取 ──
  let logUploadChain = Promise.resolve();
  async function _flushLogs(options = {}) {
    const pullMode = options.pullMode || 'none'; // none | incremental | full
    if (!_enabled()) return { ok: false, reason: '同步未开启' };
    const session = await _session();
    loggedIn = !!session;
    if (!session) {
      _emitProgress({ phase: 'error', dirtyHint: _computePendingCount() > 0, lastError: '未登录或登录状态失效' });
      return { ok: false, reason: '未登录或登录状态失效' };
    }
    const c = _client();
    if (!c) {
      _emitProgress({ phase: 'error', dirtyHint: true, lastError: 'Supabase 客户端不可用' });
      return { ok: false, reason: 'Supabase 客户端不可用' };
    }
    let syncHadError = '';

    const localState = await _refreshLocalState(false);
    const pendingTargets = _targetsFromPending(localState);
    const inventory = pendingTargets.length
      ? await _fetchRemoteInventory(session, c, pendingTargets)
      : { rows: [], groups: {}, set: new Set() };

    // ① 本地删除墓碑优先处理；删除可释放空间，不受上传配额限制。
    const tombstones = Object.values(_getTombstones());
    for (const tombstone of tombstones) {
      try {
        const result = await _processTombstone(session, c, tombstone, inventory, false);
        if (!result.ok && !result.conflict) syncHadError = result.reason || '删除云端对话失败';
      } catch (e) {
        syncHadError = String((e && e.message) || e || '删除云端对话失败');
      }
    }

    // ② 配额软护栏：已用 ≥ 配额则暂停新上传，但仍检查冲突并拉取安全的远端更新。
    _emitProgress({ phase: 'quota', current: '', uploaded: 0, total: 0 });
    let quotaExceeded = false;
    const usedBytes = pendingTargets.length ? await _fetchUsage(session, c, false) : 0;
    quotaExceeded = usedBytes >= cfg.quotaMB * 1024 * 1024;

    if (!quotaExceeded) {
      // ③ 仅为已开启的 item 打包；真正上传前逐项检查远端是否越过同步基准。
      const items = localState.items;
      const queue = [];   // [{ kind, name, pieces }]
      for (const item of items) {
        if (!_isItemOn(item.kind, item.itemId)) continue;   // 用户关闭 → 本地保留、跳过上传
        const baseKey = _baseKey(item.kind, item.itemId);
        if (!_isItemDirty(item.kind, item.itemId)) continue;
        let pieces;
        try {
          pieces = localState.packed.get(baseKey) || await _packItem(item);
        } catch (e) {
          console.warn('[SyncLogs] 压缩失败:', item.kind + '/' + item.itemId, e);
          syncHadError = '压缩失败：' + _itemName(item.kind, item);
          continue;
        }
        queue.push({ item, kind: item.kind, name: _itemName(item.kind, item), pieces });
      }
      let totalPieces = 0;
      queue.forEach(q => { totalPieces += q.pieces.length; });

      // ④ 逐个对话安全上传；有并发修改时写入待处理冲突，不覆盖任何一端。
      let done = 0;
      for (const q of queue) {
        _emitProgress({ phase: 'uploading', current: q.name, uploaded: done + 1, total: totalPieces });
        const r = await _uploadPreparedItem(session, c, q.item, q.pieces, inventory, false);
        done += q.pieces.length;
        if (!r.ok && !r.conflict) syncHadError = r.reason || '上传失败';
      }

    }

    // ⑤ TTL 清理每天最多一次；即使已超配额也允许执行，以便释放空间。
    const maintenanceDue = !!options.maintenance &&
      (!cfg.lastMaintenanceAt || Date.now() - cfg.lastMaintenanceAt >= MAINTENANCE_INTERVAL);
    if (maintenanceDue) {
      const maintenanceInventory = await _fetchRemoteInventory(session, c);
      await _pruneRemoteTTL(session, c, maintenanceInventory.rows);
      cfg.lastMaintenanceAt = Date.now();
      _setLocal(CFG_KEY, cfg);
    }

    // ⑥ 本地快速保存不做全量下载；Realtime 定向拉取，轮询走游标增量，
    // 首次/手动同步才完整对账。
    if (pullMode !== 'none') {
      _emitProgress({ phase: 'pulling', current: '', uploaded: 0, total: 0 });
      if (pullMode === 'full') await _pullItems(session, c);
      else await _pullIncremental(session, c);
    }

    // ⑦ 完成：汇总待同步数（仍未上传的项）并清除 dirty 标记
    const nowStr = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const outboxAll = await _outboxGetAll();
    const outboxCount = outboxAll.filter(it => typeof it.key === 'string' && it.key.indexOf('log:') === 0).length;
    const pending = _computePendingCount();
    _emitProgress({
      phase: 'done',
      current: '', uploaded: 0, total: 0,
      pending,
      dirtyHint: pending > 0,
      outbox: outboxCount,
      lastSyncAt: nowStr,
      lastError: syncHadError
    });
    _emitStatus();
  }

  // ── 拉取合并 ─────────────────────────────────────────
  function _selectCurrentRows(rows) {
    const latestById = new Map();
    for (const row of rows || []) {
      const current = latestById.get(row.item_id);
      if (!current || policy.compareTimestamps(row.updated_at, current.updated_at) > 0) latestById.set(row.item_id, row);
    }
    const unique = Array.from(latestById.values());
    const baseRows = unique.filter(row => !/_(p\d+)+$/.test(row.item_id));
    const pieceRows = unique.filter(row => /_(p\d+)+$/.test(row.item_id));
    if (baseRows.length) {
      const base = baseRows.sort((a, b) => policy.compareTimestamps(b.updated_at, a.updated_at))[0];
      const newestPiece = _latestTimestamp(pieceRows);
      if (!newestPiece || policy.compareTimestamps(base.updated_at, newestPiece) >= 0) return [base];
    }

    // 历史分片树可能同时残留父片与子片。父片较新则丢弃旧子片；子片较新则丢弃旧父片。
    const selected = new Set(pieceRows);
    const byDepth = pieceRows.slice().sort((a, b) => String(a.item_id).length - String(b.item_id).length);
    for (const ancestor of byDepth) {
      if (!selected.has(ancestor)) continue;
      const descendants = Array.from(selected).filter(row => row !== ancestor && String(row.item_id).startsWith(String(ancestor.item_id) + '_p'));
      if (!descendants.length) continue;
      const allDescendantsNewer = descendants.every(row => policy.compareTimestamps(row.updated_at, ancestor.updated_at) > 0);
      if (allDescendantsNewer) selected.delete(ancestor);
      else descendants.forEach(row => selected.delete(row));
    }
    return Array.from(selected);
  }

  function _recordPulledContent(kind, itemId) {
    const item = _extractAll().find(candidate => candidate.kind === kind && String(candidate.itemId) === String(itemId));
    if (item) {
      const hashes = _getLocal(CONTENT_HASH_KEY, {});
      hashes[_baseKey(kind, itemId)] = _contentHash(item);
      _setLocal(CONTENT_HASH_KEY, hashes);
      const known = _getKnownItems();
      const ids = new Set(Array.isArray(known[kind]) ? known[kind].map(String) : []);
      ids.add(String(itemId));
      known[kind] = Array.from(ids);
      _setLocal(KNOWN_ITEMS_KEY, known);
    }
    _clearItemDirty(kind, itemId);
    _clearConflict(kind, itemId);
  }

  async function _fetchRemoteItemRows(session, c, targets) {
    const wanted = _normalizeTargets(targets);
    if (!wanted.length) {
      const { data, error } = await c.from('user_sync_items')
        .select('kind,item_id,data,updated_at')
        .eq('user_id', session.user.id);
      if (error) throw new Error(error.message || '拉取云端对话失败');
      return data || [];
    }
    try {
      const rows = [];
      const byKind = new Map();
      wanted.forEach(target => {
        const ids = byKind.get(target.kind) || [];
        ids.push(target.itemId);
        byKind.set(target.kind, ids);
      });
      for (const [kind, ids] of byKind) {
        const { data, error } = await c.from('user_sync_items')
          .select('kind,item_id,base_item_id,data,updated_at')
          .eq('user_id', session.user.id)
          .eq('kind', kind)
          .in('base_item_id', ids);
        if (error) throw new Error(error.message || 'target-pull-failed');
        rows.push(...(data || []));
      }
      return rows;
    } catch (e) {
      // 兼容尚未执行新版 schema 的云端。
      const { data, error } = await c.from('user_sync_items')
        .select('kind,item_id,data,updated_at')
        .eq('user_id', session.user.id);
      if (error) throw new Error(error.message || '拉取云端对话失败');
      const wantedSet = new Set(wanted.map(target => _baseKey(target.kind, target.itemId)));
      return (data || []).filter(row => wantedSet.has(_remoteBaseKey(row.kind, row.item_id)));
    }
  }

  async function _pullIncremental(session, c) {
    if (!cfg.pullCursor || !cfg.lastFullPullAt || Date.now() - cfg.lastFullPullAt >= FULL_PULL_INTERVAL) {
      return _pullItems(session, c);
    }
    let query = c.from('user_sync_items')
      .select('kind,item_id,updated_at')
      .eq('user_id', session.user.id);
    if (typeof query.gte !== 'function') return _pullItems(session, c);
    query = query.gte('updated_at', cfg.pullCursor);
    const { data, error } = await query;
    if (error) throw new Error(error.message || '读取对话增量版本失败');
    const targets = _normalizeTargets((data || []).map(row => ({
      kind: row.kind,
      itemId: _baseIdFromRemoteId(row.item_id)
    })));
    if (!targets.length) return;
    return _pullItems(session, c, targets);
  }

  async function _pullItems(session, c, targets) {
    const wanted = _normalizeTargets(targets);
    const data = await _fetchRemoteItemRows(session, c, wanted);
    if (!data) return;
    // 按 kind + 基础 id（去 _pN 分片后缀）分组；当前分片选择器会按更新时间
    // 淘汰历史父片/子片，兼容旧版本留下的不同分片形态。
    const grouped = {};
    for (const row of data) {
      const baseId = _baseIdFromRemoteId(row.item_id);
      const key = row.kind + '/' + baseId;
      const g = (grouped[key] = grouped[key] || { rows: [] });
      g.rows.push(row);
    }
    applyingRemote = true;
    try {
      for (const key of Object.keys(grouped)) {
        const [kind, baseId] = key.split('/');
        const g = grouped[key];
        if (_isItemDirty(kind, baseId) || _getTombstones()[key] || _isConflicted(kind, baseId)) continue;
        const pieces = _selectCurrentRows(g.rows);
        if (!pieces.length) continue;
        const remoteUpdated = pieces.reduce((m, p) =>
          new Date(p.updated_at).getTime() > new Date(m).getTime() ? p.updated_at : m, pieces[0].updated_at);
        const localTs = _getTs(key);
        if (localTs && new Date(localTs).getTime() >= new Date(remoteUpdated).getTime()) continue;
        // 按 item_id 字典序重组分片（二分分片 p0<p1 顺序正确）
        const built = await _rebuildPieces(pieces);
        if (!built) continue;
        _applyToLocal(kind, baseId, built);
        _setTs(key, remoteUpdated);
        _recordPulledContent(kind, baseId);
      }
    } finally {
      applyingRemote = false;
    }
    let newest = cfg.pullCursor || null;
    for (const row of data) {
      if (!newest || policy.compareTimestamps(row.updated_at, newest) > 0) newest = row.updated_at;
    }
    if (newest) cfg.pullCursor = newest;
    if (!wanted.length) cfg.lastFullPullAt = Date.now();
    _setLocal(CFG_KEY, cfg);
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
        // 防御：本地 study_ai_convs 若被降级写成对象，重置为数组再合并（配合 settings.js 的防御）
        if (!Array.isArray(aiConvs)) aiConvs = [];
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
          // 日报会话特殊处理：不同设备各自用 genId() 创建日报 → id 必然不同，
          // 若按 id 匹配不到就 push 会产生「两个每日日报 tab」。这里识别日报会话
          // （meta.daily 标记 或 标题含「日报」），合并到本地已有日报会话，不新建。
          const isDaily = !!(built.meta && (built.meta.daily || /日报/.test(built.meta.title || '')));
          if (isDaily) {
            let localDaily = null;
            for (let i = 0; i < aiConvs.length; i++) {
              const c = aiConvs[i];
              if (c && (c._dailyReport || c.title === '📋 每日日报' || c.title === '☀️ 晨间日报')) {
                localDaily = c;
                break;
              }
            }
            if (localDaily) {
              // 回填标记 + 统一标题（与 settings.getOrCreateDailyReportConv 保持一致）
              if (!localDaily._dailyReport) localDaily._dailyReport = true;
              if (localDaily.title === '☀️ 晨间日报') localDaily.title = '📋 每日日报';
              // 合并远端消息：按 id 去重；无 id 按 role+content 去重
              if (!Array.isArray(localDaily.messages)) localDaily.messages = [];
              const keys = new Set(localDaily.messages.map(m =>
                m && m.id ? 'id:' + m.id : 'c:' + (m.role || '') + ':' + (m.content || '')));
              const remoteMsgs = Array.isArray(built.items) ? built.items : [];
              for (const m of remoteMsgs) {
                const key = m && m.id ? 'id:' + m.id : 'c:' + (m && m.role || '') + ':' + (m && m.content || '');
                if (!keys.has(key)) { localDaily.messages.push(m); keys.add(key); }
              }
              // 按时间排序，保证跨设备合并后顺序正确
              localDaily.messages.sort((a, b) => (a && a.createdAt || 0) - (b && b.createdAt || 0));
              // 树状分支：本地缺失时补远端（日报一般无分支树，防御性合并）
              if (!localDaily.tree && built.tree) localDaily.tree = built.tree;
              if (!localDaily.activePath && built.activePath) localDaily.activePath = built.activePath;
            } else {
              // 本地无日报会话 → 创建（带标记，标题统一）
              const newConv = Object.assign({ tree: built.tree || null, activePath: built.activePath || null }, patch);
              newConv._dailyReport = true;
              newConv.autoTitled = true;
              newConv.title = '📋 每日日报';
              aiConvs.push(newConv);
            }
          } else {
            const newConv = Object.assign({ tree: built.tree || null, activePath: built.activePath || null }, patch);
            aiConvs.push(newConv);
          }
        }
        safeSaveAiConvs();
      }
    } catch (e) { /* 写回失败不影响其它 item */ }
  }

  // ── TTL 清理远端（纯云端时间戳，跨设备安全）────────────────
  // 策略：
  //   - 教材日志（bk_explain / bk_qa）：updated_at 早于 BK_TTL_MS（3 个月）→ 删除
  //   - AI 对话（ai_conv）：按基础 item_id（去 _pN 分片后缀）分组，取每组最新 updated_at，
  //     只保留最近 AI_MAX_CONVS（20）个会话 → 删除其余（含分片行）
  // 只依据云端 updated_at，不读取本地数据，任何设备同步时都安全、可预期。
  async function _pruneRemoteTTL(session, c, inventoryRows) {
    let data = Array.isArray(inventoryRows) ? inventoryRows : null;
    if (!data) {
      const result = await c.from('user_sync_items')
        .select('id,kind,item_id,updated_at')
        .eq('user_id', session.user.id);
      if (result.error) return;
      data = result.data || [];
    }
    if (!data.length) return;
    const now = Date.now();
    const toDelete = [];
    const conflictKeys = new Set(Object.keys(_getConflicts()));

    // 教材日志：按 TTL 删除过期行
    for (const row of data) {
      if (row.kind === 'bk_explain' || row.kind === 'bk_qa') {
        if (conflictKeys.has(_remoteBaseKey(row.kind, row.item_id))) continue;
        const t = new Date(row.updated_at).getTime();
        if (now - t > BK_TTL_MS) toDelete.push(row.id);
      }
    }

    // AI 对话：按会话（基础 id）分组，只保留最近 AI_MAX_CONVS 个
    const aiRows = data.filter(r => r.kind === 'ai_conv');
    if (aiRows.length) {
      // 基础 id → 该会话所有行中最新 updated_at
      const byConv = new Map();
      for (const row of aiRows) {
        const base = row.item_id.replace(/_(p\d+)+$/, '');
        const t = new Date(row.updated_at).getTime();
        const cur = byConv.get(base);
        if (!cur || t > cur) byConv.set(base, t);
      }
      // 按最新活跃时间降序，保留前 AI_MAX_CONVS 个
      const sorted = [...byConv.entries()].sort((a, b) => b[1] - a[1]);
      const keep = new Set(sorted.slice(0, AI_MAX_CONVS).map(e => e[0]));
      conflictKeys.forEach(key => {
        if (key.startsWith('ai_conv/')) keep.add(key.slice('ai_conv/'.length));
      });
      for (const row of aiRows) {
        const base = row.item_id.replace(/_(p\d+)+$/, '');
        if (!keep.has(base)) toDelete.push(row.id);
      }
    }

    if (!toDelete.length) return;
    try {
      // 分批次删除（in() 有长度限制），避免请求体过大
      for (let i = 0; i < toDelete.length; i += 300) {
        const chunk = toDelete.slice(i, i + 300);
        await c.from('user_sync_items').delete().in('id', chunk);
      }
      localStorage.removeItem(USAGE_CACHE_KEY);
      _emitProgress({ phase: 'pruning', current: '', uploaded: 0, total: toDelete.length });
    } catch (e) { /* 清理失败可容忍，下轮再试 */ }
  }

  // ── 配额聚合（bytes 列求和，不拉 data）────────────────
  async function _fetchUsageSummary(session, c, force) {
    const cached = _getLocal(USAGE_CACHE_KEY, null);
    if (!force && cached && cached.at && Date.now() - cached.at < USAGE_CACHE_MS) return cached;
    let data = null;
    if (typeof c.rpc === 'function') {
      try {
        const result = await c.rpc('get_user_sync_usage');
        if (!result.error && Array.isArray(result.data)) {
          data = result.data.map(row => ({ kind: row.kind, bytes: Number(row.total_bytes || row.bytes || 0) }));
        }
      } catch (e) { /* 旧 schema 无 RPC，退回轻量列查询 */ }
    }
    if (!data) {
      const result = await c.from('user_sync_items')
        .select('kind,bytes')
        .eq('user_id', session.user.id);
      if (result.error) throw new Error(result.error.message || '读取云存储用量失败');
      data = result.data || [];
    }
    const byKind = { ai_conv: 0, bk_explain: 0, bk_qa: 0 };
    let total = 0;
    data.forEach(row => {
      const bytes = typeof row.bytes === 'number' ? row.bytes : Number(row.bytes || 0);
      byKind[row.kind] = (byKind[row.kind] || 0) + bytes;
      total += bytes;
    });
    const summary = { total, byKind, at: Date.now() };
    _setLocal(USAGE_CACHE_KEY, summary);
    return summary;
  }
  async function _fetchUsage(session, c, force) {
    return (await _fetchUsageSummary(session, c, force)).total;
  }
  async function getUsage() {
    _loadCfg();
    const empty = { total: 0, usedMB: 0, quotaMB: cfg.quotaMB, byKind: {}, loggedIn: false };
    const session = await _session();
    if (!session) return empty;
    const c = _client();
    if (!c) return empty;
    empty.loggedIn = true;
    try {
      const summary = await _fetchUsageSummary(session, c, false);
      return { total: summary.total, usedMB: summary.total / (1024 * 1024), quotaMB: cfg.quotaMB, byKind: summary.byKind, loggedIn: true };
    } catch (e) { return empty; }
  }

  // ── 手动触发 ─────────────────────────────────────────
  function manualSync() {
    return _enqueue(() => _flushLogs({ pullMode: 'full', maintenance: true })).then(async result => {
      await renderPanelSafe();
      return result;
    });
  }

  function markItemDeleted(kind, itemId) {
    if (!KIND_LABELS[kind] || itemId == null) return;
    const key = _baseKey(kind, itemId);
    const tombstones = _getTombstones();
    tombstones[key] = tombstones[key] || { kind, itemId: String(itemId), deletedAt: new Date().toISOString() };
    _setLocal(TOMBSTONE_KEY, tombstones);
    _markItemDirty(kind, itemId);
    _emitProgress({ dirtyHint: true, pending: _computePendingCount() });
    if (_autoSyncOn() && loggedIn && client) scheduleUpload();
  }

  function resolveConflict(kind, itemId, choice) {
    return _enqueue(async () => {
      const key = _baseKey(kind, itemId);
      const conflict = _getConflicts()[key];
      if (!conflict) return { ok: false, reason: '该对话冲突已不存在或已处理' };
      if (choice !== 'local' && choice !== 'remote') return { ok: false, reason: '无效的处理方式' };
      const session = await _session();
      const c = _client();
      if (!session || !c) return { ok: false, reason: '未登录或 Supabase 客户端不可用' };

      try {
        const inventory = await _fetchRemoteInventory(session, c, [{ kind, itemId }]);
        if (choice === 'local') {
          if (conflict.localDeleted) {
            await _processTombstone(session, c, conflict, inventory, true);
          } else {
            const item = _extractAll().find(candidate => candidate.kind === kind && String(candidate.itemId) === String(itemId));
            if (!item) throw new Error('本地对话已不存在，请选择使用云端或重新同步');
            const pieces = await _packItem(item);
            const result = await _uploadPreparedItem(session, c, item, pieces, inventory, true);
            if (!result.ok) throw new Error(result.reason || '上传本地版本失败');
          }
        } else {
          const rows = await _fetchRemoteItemRows(session, c, [{ kind, itemId }]);
          const selected = _selectCurrentRows(rows);
          if (!selected.length) throw new Error('云端版本已不存在');
          const built = await _rebuildPieces(selected);
          if (!built) throw new Error('云端分片损坏或不完整');
          applyingRemote = true;
          try { _applyToLocal(kind, String(itemId), built); }
          finally { applyingRemote = false; }
          const tombstones = _getTombstones();
          delete tombstones[key];
          _setLocal(TOMBSTONE_KEY, tombstones);
          _setTs(key, _latestTimestamp(selected));
          _recordPulledContent(kind, String(itemId));
        }
        _clearConflict(kind, itemId);
        _emitProgress({
          phase: 'done',
          pending: _computePendingCount(),
          dirtyHint: _computePendingCount() > 0,
          lastError: '',
          lastSyncAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        });
        _emitStatus();
        return { ok: true, kind, itemId: String(itemId), choice };
      } catch (e) {
        const reason = String((e && e.message) || e || '处理对话冲突失败');
        _emitProgress({ phase: 'error', dirtyHint: true, lastError: reason });
        return { ok: false, reason };
      }
    });
  }

  function resolveConflictToken(token, choice) {
    try {
      const parsed = JSON.parse(decodeURIComponent(token));
      return resolveConflict(parsed[0], parsed[1], choice).then(async result => {
        await renderPanel();
        return result;
      });
    } catch (e) {
      return Promise.resolve({ ok: false, reason: '冲突标识无效' });
    }
  }

  function uploadAll() {
    const run = _enqueue(async () => {
      const session = await _session();
      if (!session) return { uploaded: 0, skipped: 0, failed: 0, reasons: [] };
      const c = _client();
      if (!c) return { uploaded: 0, skipped: 0, failed: 1, reasons: ['Supabase 客户端不可用'] };
      const localState = await _refreshLocalState(true);
      const inventory = await _fetchRemoteInventory(session, c);
      const items = localState.items;
      let uploaded = 0, skipped = 0, failed = 0;
      const reasons = [];

      for (const tombstone of Object.values(_getTombstones())) {
        try {
          const result = await _processTombstone(session, c, tombstone, inventory, true);
          if (result.ok) uploaded++;
        } catch (e) {
          failed++;
          reasons.push('删除 ' + tombstone.kind + '/' + tombstone.itemId + ' 失败：' + String((e && e.message) || e));
        }
      }

      for (const item of items) {
        if (!_isItemOn(item.kind, item.itemId)) continue;
        let pieces;
        try {
          pieces = localState.packed.get(_baseKey(item.kind, item.itemId)) || await _packItem(item);
        } catch (e) {
          failed++;
          const msg = '压缩失败: ' + item.kind + '/' + item.itemId + ' ' + (e && e.message ? e.message : e);
          reasons.push(msg);
          console.warn('[SyncLogs] ' + msg);
          continue;
        }
        try {
          // “上传全部”是用户明确选择本地覆盖云端，因此跳过冲突检查，但仍执行分片清理和状态提交。
          const result = await _uploadPreparedItem(session, c, item, pieces, inventory, true);
          if (result.ok) uploaded++;
          else {
            failed++;
            reasons.push(item.kind + '/' + item.itemId + ' ' + (result.reason || '上传失败'));
          }
        } catch (e) {
          failed++;
          reasons.push(item.kind + '/' + item.itemId + ' 异常: ' + (e && e.message ? e.message : e));
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
      if (failed === 0) await _flushLogs({ pullMode: 'none', maintenance: false });
      return { uploaded, skipped, failed, reasons };
    });
    return run.then(async result => {
      await renderPanelSafe();
      return result;
    });
  }
  // 独立串行队列：所有手动/自动任务排队执行，不并发
  function _enqueue(fn) {
    const run = logUploadChain.then(fn).catch((e) => {
      const message = String((e && e.message) || e || '未知错误');
      console.warn('[SyncLogs] 任务异常:', e);
      _emitProgress({ phase: 'error', dirtyHint: true, lastError: message });
      return { error: message };
    });
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

    const conflicts = getPendingConflicts();
    if (conflicts.length) {
      html += `<section class="sync-conflict-panel" style="display:block;margin-bottom:12px;">
        <div class="sync-conflict-panel-title"><span><i data-lucide="messages-square" class="lucide-icon"></i> 对话云存储冲突</span><span class="sync-conflict-count">${conflicts.length} 项</span></div>
        <p class="sync-conflict-guide">这些项目已暂停自动同步，其他对话仍会继续。保留本地会覆盖云端；使用云端会覆盖或恢复当前设备中的对应项目。</p>
        <div class="sync-conflict-list">`;
      for (const conflict of conflicts) {
        const token = encodeURIComponent(JSON.stringify([conflict.kind, String(conflict.itemId)]));
        const reason = conflict.reason === 'delete-versus-remote-change'
          ? '本机删除后，云端又出现了更新。'
          : (conflict.reason === 'missing-sync-base'
            ? '缺少共同同步基准，本机与云端都存在内容。'
            : '本机和云端都在上次同步后发生了修改。');
        const localChoice = conflict.localDeleted ? '确认本机删除' : '保留本地并上传';
        html += `<article class="sync-conflict-item">
          <div class="sync-conflict-item-head"><div><strong>${escapeHtml(conflict.name || conflict.label || conflict.itemId)}</strong><code>${escapeHtml(conflict.kind + '/' + conflict.itemId)}</code></div><span class="sync-conflict-state">需要选择</span></div>
          <p class="sync-conflict-reason">${escapeHtml(reason)}</p>
          <dl class="sync-conflict-meta">
            <div><dt>本机同步基准</dt><dd>${escapeHtml(_formatTime(conflict.baseTimestamp, '无（首次同步）'))}</dd></div>
            <div><dt>云端更新时间</dt><dd>${escapeHtml(_formatTime(conflict.remoteTimestamp, '未知'))}</dd></div>
            <div><dt>检测时间</dt><dd>${escapeHtml(_formatTime(conflict.detectedAt, '未知'))}</dd></div>
          </dl>
          <div class="sync-conflict-actions">
            <button class="sync-conflict-btn sync-conflict-btn-local" onclick="SyncLogs.resolveConflictToken('${escapeHtml(token)}','local')"><i data-lucide="upload"></i> ${localChoice}</button>
            <button class="sync-conflict-btn sync-conflict-btn-remote" onclick="SyncLogs.resolveConflictToken('${escapeHtml(token)}','remote')"><i data-lucide="cloud-download"></i> 使用云端并覆盖本机</button>
          </div>
        </article>`;
      }
      html += `</div></section>`;
    }

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
      <button class="storage-btn" onclick="SyncLogs.pruneRemote()" title="按保留策略删除超期云端数据：教材日志删 3 个月前的、AI 对话只留最近 20 个会话"><i data-lucide="trash" class="lucide-icon" style="width:13px;height:13px;"></i> 按保留策略清理</button>
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
  function _formatTime(value, fallback) {
    if (!value) return fallback || '未知';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? (fallback || '未知') : date.toLocaleString('zh-CN', { hour12: false });
  }

  function setItemEnabled(kind, itemId, on) {
    _setItemEnabled(kind, itemId, on);
    if (on && _enabled() && loggedIn && client) scheduleUpload();
    renderPanel();
  }

  async function deleteAllRemote() {
    if (!confirm('确定从云端删除全部日志数据？本地数据不受影响，同时会暂停这些项目的云上传；需要时可在列表中逐项重新开启。')) return;
    const session = await _session();
    if (!session) return;
    const c = _client();
    if (!c) return;
    const { error } = await c.from('user_sync_items').delete().eq('user_id', session.user.id);
    if (error) {
      const st = document.getElementById('storageStatus');
      if (st) st.textContent = '删除失败：' + (error.message || '未知错误');
      return { ok: false, reason: error.message || '删除失败' };
    }
    // 明确关闭当前本地 item 的云上传，防止下一轮“云端缺失自愈”把刚删除的数据重新传回去。
    for (const item of _extractAll()) _setItemEnabled(item.kind, item.itemId, false);
    _setLocal(TS_KEY, {});
    _setLocal(HASH_KEY, {});
    _saveConflicts({});
    localStorage.removeItem(USAGE_CACHE_KEY);
    const outbox = await _outboxGetAll();
    for (const entry of outbox) {
      if (entry && typeof entry.key === 'string' && entry.key.indexOf('log:') === 0) await _outboxRemove(entry.key);
    }
    const st = document.getElementById('storageStatus');
    if (st) st.textContent = '已删除云端全部日志数据并暂停这些项目的上传（本地保留）。';
    renderPanel();
    return { ok: true };
  }

  // 手动触发：按保留策略清理云端过期数据（教材 3 个月 / AI 最近 20 会话）
  function pruneRemote() {
    return _enqueue(async () => {
      const session = await _session();
      if (!session) return { deleted: 0 };
      const c = _client();
      if (!c) return { deleted: 0 };
      const before = await _fetchUsage(session, c, true);
      await _pruneRemoteTTL(session, c);
      const after = await _fetchUsage(session, c, true);
      const freedMB = ((before - after) / 1048576).toFixed(2);
      const st = document.getElementById('storageStatus');
      if (st) {
        st.textContent = freedMB > 0
          ? '已清理云端过期数据，释放约 ' + freedMB + ' MB。'
          : '云端无过期数据可清理。';
      }
      renderPanel();
      return { freedMB };
    });
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
      case 'pruning': t = '正在清理云端过期数据…'; break;
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
  // 待同步 item 数：以持久化 dirty / 删除墓碑 / 冲突为事实来源。
  function _computePendingCount() {
    const keys = new Set();
    const dirty = _getDirtyMap();
    Object.keys(dirty).forEach(key => {
      if (key.endsWith('/*')) keys.add(key);
      else {
        const slash = key.indexOf('/');
        const kind = slash > 0 ? key.slice(0, slash) : '';
        const itemId = slash > 0 ? key.slice(slash + 1) : '';
        if (!kind || !itemId || _isItemOn(kind, itemId)) keys.add(key);
      }
    });
    Object.keys(_getTombstones()).forEach(key => keys.add(key));
    Object.keys(_getConflicts()).forEach(key => keys.add(key));
    return keys.size;
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
      loggedIn: !!sess,
      pendingCount: _computePendingCount(),
      pendingConflictCount: getPendingConflicts().length,
      lastError: progressState.lastError || ''
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
    try { await _refreshLocalState(true); } catch (e) { console.warn('[SyncLogs] 本地同步状态初始化失败:', e); }
    _subscribe();
    if (_autoSyncOn()) {
      await _enqueue(() => _flushLogs({ pullMode: 'full', maintenance: true }));
      pullScheduler.start();
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
          payload => _debouncedPull(payload))
        .on('postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'user_sync_items', filter: 'user_id=eq.' + session.user.id },
          payload => _debouncedPull(payload));
      channel.subscribe();
      realtimeChannel = channel;
    } catch (e) { /* 订阅失败不影响主流程 */ }
  }
  const pendingRealtimeItems = new Map();
  function _debouncedPull(payload) {
    const row = payload && payload.new;
    if (row && KIND_LABELS[row.kind] && row.item_id != null) {
      const baseId = _baseIdFromRemoteId(row.item_id);
      pendingRealtimeItems.set(_baseKey(row.kind, baseId), {
        kind: row.kind,
        itemId: baseId,
        pieceId: String(row.item_id),
        updatedAt: row.updated_at || ''
      });
    }
    clearTimeout(pullDebounceTimer);
    pullDebounceTimer = setTimeout(() => {
      if (!_autoSyncOn() || !loggedIn) return;
      const targets = [];
      for (const target of pendingRealtimeItems.values()) {
        const exactTs = _getTs(_baseKey(target.kind, target.pieceId));
        // 本机刚写入的分片已记录同一个服务器时间戳：忽略自身 Realtime 回显。
        if (!target.updatedAt || exactTs !== target.updatedAt) targets.push(target);
      }
      pendingRealtimeItems.clear();
      if (!targets.length) return;
      _enqueue(async () => {
        const session = await _session();
        const c = _client();
        if (!session || !c) return;
        _emitProgress({ phase: 'pulling', current: '', uploaded: 0, total: targets.length });
        await _pullItems(session, c, targets);
        _emitProgress({ phase: 'done', current: '', uploaded: 0, total: 0,
          pending: _computePendingCount(), dirtyHint: _computePendingCount() > 0,
          lastSyncAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) });
        _emitStatus();
      });
    }, 250);
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
            pullScheduler.stop();
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
    try {
      return Promise.resolve(renderPanel()).catch(e => { console.warn('[SyncLogs] 面板渲染失败:', e); });
    } catch (e) {
      console.warn('[SyncLogs] 面板渲染失败:', e);
      return Promise.resolve();
    }
  }

  function retryPending() {
    if (!_autoSyncOn() || !loggedIn) return Promise.resolve(false);
    pullScheduler.start();
    return pullScheduler.trigger();
  }

  function refreshAutoSync() {
    if (_autoSyncOn()) return _init();
    pullScheduler.stop();
    clearTimeout(uploadTimer);
    scheduled = false;
    clearTimeout(pullDebounceTimer);
    if (realtimeChannel) {
      try {
        if (_client() && typeof _client().removeChannel === 'function') _client().removeChannel(realtimeChannel);
        else realtimeChannel.unsubscribe();
      } catch (e) {}
      realtimeChannel = null;
    }
    return Promise.resolve();
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
    getPendingConflicts,
    resolveConflict,
    resolveConflictToken,
    markItemDeleted,
    renderPanel: renderPanelSafe,
    setItemEnabled,
    deleteAllRemote,
    pruneRemote,
    migrateLegacy,
    retryPending,
    refreshAutoSync,
    onStatus,
    onProgress,
    get enabled() { return _enabled(); },
    get autoSync() { return !!cfg.autoSync; },
    get loggedIn() { return loggedIn; }
  };
  if (global.__MST_TEST__) {
    global.SyncLogs.__test = {
      baseIdFromRemoteId: _baseIdFromRemoteId,
      selectCurrentRows: _selectCurrentRows,
      hasRemoteAdvanced: _hasRemoteAdvanced,
      refreshLocalState: _refreshLocalState,
      contentHash: _contentHash,
      flushLogs: _flushLogs,
      normalizeTargets: _normalizeTargets
    };
  }

  // 页面加载后自动初始化
  if (typeof global.addEventListener === 'function') {
    global.addEventListener('load', function () { setTimeout(init, 800); });
  } else {
    setTimeout(init, 1200);
  }
})(typeof window !== 'undefined' ? window : globalThis);
