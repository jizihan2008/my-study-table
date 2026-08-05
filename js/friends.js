// ═══════════════════════════════════════════════════════════════════
// js/friends.js — 好友系统（Supabase 后端）
// 依赖：lib/supabase/supabase.js（window.supabase）、core.js（loadData/saveData）、
//       todos.js（formatDate）、ai-utils.js（showCustomConfirm）、utils.js（escapeHtml）
// 模块划分：本文件负责 配置 / Supabase 客户端 / 认证 / 好友管理 / 分组 / 聚合统计 /
//           动态流 / 好友页整体渲染；聊天功能在 friends-chat.js 中。
// ═══════════════════════════════════════════════════════════════════

// ═══════════════ 配置管理（与插件市场共用 Supabase 连接） ═══════════════
const FRIENDS_CFG_KEY = 'study_supabase_config';
const OLD_FRIENDS_CFG_KEY = 'study_friends_config';

function getFriendsConfig() {
  try {
    let raw = localStorage.getItem(FRIENDS_CFG_KEY);
    if (raw) return JSON.parse(raw);
    // 从旧键迁移
    raw = localStorage.getItem(OLD_FRIENDS_CFG_KEY);
    if (raw) {
      const cfg = JSON.parse(raw);
      if (cfg.url && cfg.anonKey) {
        localStorage.setItem(FRIENDS_CFG_KEY, raw);
      }
      return cfg;
    }
    // 再尝试插件市场的旧键
    raw = localStorage.getItem('study_plugin_store_config');
    if (raw) {
      const cfg = JSON.parse(raw);
      if (cfg.url && cfg.anonKey) return cfg;
    }
    return {};
  } catch (e) { return {}; }
}
function saveFriendsConfig(cfg) {
  localStorage.setItem(FRIENDS_CFG_KEY, JSON.stringify(cfg));
}
function isFriendsConfigured() {
  const cfg = getFriendsConfig();
  return !!(cfg.url && cfg.anonKey);
}

// ═══════════════ Supabase 客户端单例 ═══════════════
let _frdClient = null;

function getSupabaseClient() {
  if (_frdClient) return _frdClient;
  if (typeof window.supabase === 'undefined') return null;
  const cfg = getFriendsConfig();
  if (!cfg.url || !cfg.anonKey) return null;
  try {
    _frdClient = window.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: window.localStorage
      }
    });
  } catch (e) {
    console.error('[Friends] createClient failed:', e);
    return null;
  }
  return _frdClient;
}
function resetSupabaseClient() {
  friendsUnsubscribeAll();
  if (_friendsAuthUnsub) { try { _friendsAuthUnsub.unsubscribe(); } catch (e) {} }
  _friendsAuthUnsub = null;
  _friendsAuthInit = false;
  const old = _frdClient;
  _frdClient = null;
  if (old) { try { old.auth.signOut(); } catch (e) {} }
}

// ═══════════════ 认证状态 ═══════════════
let friendsAuthUser = null; // 缓存当前登录用户（profile 行）

async function friendsGetSession() {
  const client = getSupabaseClient();
  if (!client) return null;
  try {
    const { data, error } = await client.auth.getSession();
    if (error || !data.session) return null;
    return data.session;
  } catch (e) { return null; }
}

// 获取当前登录用户的 profile 行
async function friendsGetMyProfile() {
  const client = getSupabaseClient();
  if (!client) return null;
  try {
    const { data: { user } } = await client.auth.getUser();
    if (!user) return null;
    const { data, error } = await client.from('profiles')
      .select('*').eq('id', user.id).maybeSingle();
    if (error || !data) return null;
    return data;
  } catch (e) { return null; }
}

// 注册：username（唯一）/ nickname（可选）/ email / password
async function friendsRegister(username, nickname, email, password) {
  const client = getSupabaseClient();
  if (!client) return { error: 'Supabase 未配置，请先到 设置 → 好友 填写项目地址与 anon key。' };
  if (!username || !email || !password) return { error: '请填写用户名、邮箱和密码。' };
  if (password.length < 6) return { error: '密码至少需要 6 位。' };
  try {
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: {
        data: { username: username.trim(), nickname: (nickname || username).trim() }
      }
    });
    if (error) return { error: error.message };
    if (!data.user) return { error: '注册失败，请重试。' };
    // signUp 返回 data.session 为 null = Supabase 已开启邮箱确认
    if (!data.session) {
      return { ok: true, needEmailConfirm: true, data };
    }
    // 邮箱确认未开启，已自动登录
    return { ok: true, data };
  } catch (e) {
    return { error: '注册异常：' + e.message };
  }
}

async function friendsLogin(email, password) {
  const client = getSupabaseClient();
  if (!client) return { error: 'Supabase 未配置，请先到 设置 → 好友 填写项目地址与 anon key。' };
  if (!email || !password) return { error: '请输入邮箱和密码。' };
  try {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    if (!data.user) return { error: '登录失败，请重试。' };
    return { ok: true, data };
  } catch (e) {
    return { error: '登录异常：' + e.message };
  }
}

// 退出登录：带二次确认与结果反馈
async function friendsLogout() {
  const confirmed = await showCustomConfirm('确定要退出登录吗？退出后将无法查看好友动态与聊天，需要重新登录。');
  if (!confirmed) return;
  const client = getSupabaseClient();
  try {
    if (client) { try { await client.auth.signOut(); } catch (e) {} }
    friendsAuthUser = null;
    friendsUnsubscribeAll();
    if (typeof friendsCloseChat === 'function') friendsCloseChat();
    friendsShowToast('👋 已退出登录');
    renderFriends();
  } catch (e) {
    friendsShowToast('退出失败：' + e.message, 'error');
  }
}

let _friendsAuthInit = false;
let _friendsAuthUnsub = null;

function initFriendsAuth() {
  if (_friendsAuthInit) return;
  const client = getSupabaseClient();
  if (!client) return;
  _friendsAuthInit = true;
  const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
      friendsAuthUser = null;
      if (document.getElementById('section-friends')?.classList.contains('active')) {
        refreshFriendsAll();
      }
    } else if (event === 'SIGNED_OUT') {
      friendsAuthUser = null;
      friendsUnsubscribeAll();
      if (typeof friendsCloseChat === 'function') friendsCloseChat();
      if (document.getElementById('section-friends')?.classList.contains('active')) {
        renderFriends();
      }
    }
  });
  _friendsAuthUnsub = subscription;
}

// ═══════════════ 工具函数 ═══════════════

// 头像颜色：根据字符串稳定取色
function friendsAvatarColor(seed) {
  const colors = ['#4f6ef7', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];
  let h = 0;
  const s = String(seed || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997;
  return colors[h % colors.length];
}

function friendsInitial(profile) {
  const n = (profile && (profile.nickname || profile.username)) || '?';
  return n.trim().charAt(0).toUpperCase();
}

function friendsAvatarHtml(profile, size) {
  const color = friendsAvatarColor(profile && (profile.username || profile.id));
  const px = size || 40;
  const url = profile && profile.avatar_url;
  if (url) {
    return `<span class="fr-avatar" style="width:${px}px;height:${px}px;flex-shrink:0;">
      <img src="${escapeAttr(url)}" alt="" onerror="this.style.display='none';this.parentElement.classList.add('fr-avatar-fallback');this.parentElement.innerHTML='<span style=\'font-weight:600;color:#fff\'>${friendsInitial(profile)}</span>';">
      <span style="color:${color};font-size:${Math.round(px * 0.44)}px;font-weight:700;">${friendsInitial(profile)}</span>
    </span>`;
  }
  return `<span class="fr-avatar" style="width:${px}px;height:${px}px;background:${color};flex-shrink:0;"><span style="color:#fff;font-size:${Math.round(px * 0.44)}px;font-weight:700;">${friendsInitial(profile)}</span></span>`;
}

// 判断好友是否在线：last_seen 在 2 分钟内
function friendsIsOnline(p) {
  if (!p || !p.last_seen) return false;
  try {
    return (Date.now() - new Date(p.last_seen).getTime()) < 120000;
  } catch (e) { return false; }
}

function friendsFormatTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (sameDay) return hm;
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return '昨天 ' + hm;
    return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  } catch (e) { return ''; }
}

function friendsFormatDuration(ms) {
  const min = Math.round((ms || 0) / 60000);
  if (min < 60) return min + ' 分钟';
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

// ═══════════════ 状态缓存 ═══════════════
let friendsGroupsCache = [];
let friendsListCache = [];       // [{ friendship:{...}, profile:{...} }]
let friendsRequestsCache = { incoming: [], outgoing: [] };
let friendsActivitiesCache = [];
let friendsMainView = 'feed';    // feed | requests | chat
let friendsChatFriendId = null;
let friendsLoading = false;

// ═══════════════ 分组管理 ═══════════════
async function friendsLoadGroups() {
  const client = getSupabaseClient();
  const me = await friendsGetMyProfile();
  if (!client || !me) return [];
  try {
    const { data, error } = await client.from('friend_groups')
      .select('*').eq('user_id', me.id).order('created_at');
    if (error) return [];
    friendsGroupsCache = data || [];
  } catch (e) { friendsGroupsCache = []; }
  return friendsGroupsCache;
}

async function friendsCreateGroup(name, color) {
  const client = getSupabaseClient();
  const me = await friendsGetMyProfile();
  if (!client || !me) return { error: '请先登录' };
  if (!name.trim()) return { error: '请输入分组名称' };
  try {
    const { data, error } = await client.from('friend_groups')
      .insert({ user_id: me.id, name: name.trim(), color: color || '#4f6ef7' }).select().single();
    if (error) return { error: error.message };
    await friendsLoadGroups();
    renderFriendsSidebar();
    return { ok: true, data };
  } catch (e) { return { error: e.message }; }
}

async function friendsRenameGroup(groupId, name) {
  const client = getSupabaseClient();
  if (!client || !name.trim()) return { error: '请输入分组名称' };
  try {
    const { error } = await client.from('friend_groups')
      .update({ name: name.trim() }).eq('id', groupId);
    if (error) return { error: error.message };
    await friendsLoadGroups();
    renderFriendsSidebar();
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}

async function friendsDeleteGroup(groupId) {
  const client = getSupabaseClient();
  if (!client) return { error: '请先登录' };
  try {
    // 先清除该分组下好友的 group_id（ON DELETE SET NULL 已兜底，此处显式处理）
    const { error: e2 } = await client.from('friendships')
      .update({ group_id: null }).eq('group_id', groupId);
    const { error } = await client.from('friend_groups').delete().eq('id', groupId);
    if (error) return { error: error.message };
    await friendsLoadGroups();
    renderFriendsSidebar();
    renderFriendList();
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}

// 为好友设置分组
async function friendsAssignGroup(friendId, groupId) {
  const client = getSupabaseClient();
  const me = await friendsGetMyProfile();
  if (!client || !me) return { error: '请先登录' };
  try {
    // 找到与 friendId 相关的 friendship 记录
    const { data: rel, error } = await client.from('friendships')
      .select('id').eq('status', 'accepted')
      .or(`and(user_id.eq.${me.id},friend_id.eq.${friendId}),and(user_id.eq.${friendId},friend_id.eq.${me.id})`)
      .maybeSingle();
    if (error || !rel) return { error: '未找到好友关系' };
    const { error: e2 } = await client.from('friendships')
      .update({ group_id: groupId || null }).eq('id', rel.id);
    if (e2) return { error: e2.message };
    await friendsLoadAll();
    renderFriendsSidebar();
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}

// ═══════════════ 好友管理 ═══════════════

// 加载全部数据：好友列表 + 请求 + 分组
async function friendsLoadAll() {
  const client = getSupabaseClient();
  const me = await friendsGetMyProfile();
  if (!client || !me) return;
  await friendsLoadGroups();
  // 好友列表（双向 accepted）
  try {
    const [r1, r2] = await Promise.all([
      client.from('friendships').select('*, profile:friend_id(*)')
        .eq('user_id', me.id).eq('status', 'accepted'),
      client.from('friendships').select('*, profile:user_id(*)')
        .eq('friend_id', me.id).eq('status', 'accepted')
    ]);
    const list = [];
    (r1.data || []).forEach(f => { if (f.profile) list.push({ friendship: f, profile: f.profile }); });
    (r2.data || []).forEach(f => { if (f.profile) list.push({ friendship: f, profile: f.profile }); });
    // 去重 + 按最近更新时间排序
    const seen = new Set();
    friendsListCache = list.filter(x => { if (seen.has(x.profile.id)) return false; seen.add(x.profile.id); return true; })
      .sort((a, b) => (b.friendship.created_at || '').localeCompare(a.friendship.created_at || ''));
  } catch (e) {
    console.error('[Friends] load list failed:', e);
    friendsListCache = [];
  }
  // 收到的请求
  try {
    const { data: inc, error: ei } = await client.from('friendships')
      .select('*, profile:user_id(*)').eq('friend_id', me.id).eq('status', 'pending');
    friendsRequestsCache.incoming = inc || [];
  } catch (e) { friendsRequestsCache.incoming = []; }
  // 发出的请求
  try {
    const { data: out, error: eo } = await client.from('friendships')
      .select('*, profile:friend_id(*)').eq('user_id', me.id).eq('status', 'pending');
    friendsRequestsCache.outgoing = out || [];
  } catch (e) { friendsRequestsCache.outgoing = []; }
}

// 搜索用户（按用户名或昵称模糊匹配）
async function friendsSearchUsers(query) {
  const client = getSupabaseClient();
  const me = await friendsGetMyProfile();
  if (!client || !me) return [];
  if (!query.trim()) return [];
  try {
    const q = '%' + query.trim() + '%';
    const { data, error } = await client.from('profiles')
      .select('*').neq('id', me.id)
      .or(`username.ilike.${q},nickname.ilike.${q}`)
      .limit(20);
    if (error) return [];
    return data || [];
  } catch (e) { return []; }
}

// 发送好友请求（若对方已向自己发出请求，则直接建立好友关系）
async function friendsSendRequest(targetId) {
  const client = getSupabaseClient();
  const me = await friendsGetMyProfile();
  if (!client || !me) return { error: '请先登录' };
  try {
    // 检查是否已有反向 pending 请求
    const { data: reverse, error: e1 } = await client.from('friendships')
      .select('*').eq('user_id', targetId).eq('friend_id', me.id).eq('status', 'pending').maybeSingle();
    if (e1) return { error: e1.message };
    if (reverse) {
      // 双方互加 → 直接接受，建立好友
      const { error: e2 } = await client.from('friendships')
        .update({ status: 'accepted' }).eq('id', reverse.id);
      if (e2) return { error: e2.message };
      return { ok: true, autoAccepted: true };
    }
    // 检查是否已是好友
    const { data: exist } = await client.from('friendships')
      .select('id,status').or(`and(user_id.eq.${me.id},friend_id.eq.${targetId}),and(user_id.eq.${targetId},friend_id.eq.${me.id})`)
      .maybeSingle();
    if (exist) {
      if (exist.status === 'accepted') return { error: '你们已经是好友啦' };
      return { error: '好友请求已发送，等待对方处理中' };
    }
    const { error } = await client.from('friendships')
      .insert({ user_id: me.id, friend_id: targetId, status: 'pending' });
    if (error) return { error: error.message };
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}

// 处理收到的请求
async function friendsRespondRequest(friendshipId, accept) {
  const client = getSupabaseClient();
  if (!client) return { error: '请先登录' };
  try {
    if (accept) {
      const { error } = await client.from('friendships')
        .update({ status: 'accepted' }).eq('id', friendshipId);
      if (error) return { error: error.message };
    } else {
      const { error } = await client.from('friendships').delete().eq('id', friendshipId);
      if (error) return { error: error.message };
    }
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}

// 删除好友
async function friendsRemove(friendId) {
  const client = getSupabaseClient();
  const me = await friendsGetMyProfile();
  if (!client || !me) return { error: '请先登录' };
  try {
    const { error } = await client.from('friendships')
      .delete().or(`and(user_id.eq.${me.id},friend_id.eq.${friendId}),and(user_id.eq.${friendId},friend_id.eq.${me.id})`);
    if (error) return { error: error.message };
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}

// ═══════════════ 聚合统计与动态 ═══════════════

// 计算指定日期的聚合统计（仅聚合数据，不含连续天数）
function computeDailyStatsForDate(dateStr) {
  let checkin = false, focusMs = 0, todosDone = 0, habitCount = 0;
  try {
    const ci = JSON.parse(localStorage.getItem('study_checkin') || '{}');
    checkin = !!(ci.dates && ci.dates.includes(dateStr));
  } catch (e) {}
  try {
    const recs = JSON.parse(localStorage.getItem('study_timer_records') || '[]');
    recs.forEach(r => { if (r.date === dateStr && r.affectsFocus !== false) focusMs += (r.totalMs || 0); });
  } catch (e) {}
  try {
    const all = loadData('study_todos_v2');
    all.forEach(t => { if (t.done && t.completedAt === dateStr) todosDone++; });
    const trash = loadData('study_todos_trash');
    trash.forEach(t => { if (t.done && t.completedAt === dateStr) todosDone++; });
  } catch (e) {}
  try {
    const habits = loadData('study_habits_v2');
    habits.forEach(h => { if (h.checkins && h.checkins[dateStr]) habitCount += h.checkins[dateStr]; });
  } catch (e) {}
  return { checkin, focusMs, todosDone, habitCount };
}

// 计算今日聚合统计（含连续天数）
function computeDailyStats() {
  const today = formatDate(new Date());
  const stats = computeDailyStatsForDate(today);
  let streak = 0;
  try {
    const ci = JSON.parse(localStorage.getItem('study_checkin') || '{}');
    streak = ci.streak || 0;
  } catch (e) {}
  return { ...stats, streak, date: today };
}

// 同步状态（本地，防止同一天重复发布动态）
function loadSyncState() {
  try { return JSON.parse(localStorage.getItem('study_friends_sync_state') || '{}'); }
  catch (e) { return {}; }
}
function saveSyncState(s) {
  localStorage.setItem('study_friends_sync_state', JSON.stringify(s));
}

// 本周周一日期（YYYY-MM-DD）
function friendsWeekStart() {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7; // 周一=0
  d.setDate(d.getDate() - dow);
  return formatDate(d);
}

// 回填过去 7 天的统计到云端（新用户启用好友系统时调用一次）
async function backfillStudyStats() {
  if (localStorage.getItem('study_stats_backfilled')) return;
  const client = getSupabaseClient();
  if (!client) return;
  let me;
  try {
    const { data: { user } } = await client.auth.getUser();
    if (!user) return;
    me = user;
  } catch (e) { return; }

  const today = new Date();
  const rows = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = formatDate(d);
    const stats = computeDailyStatsForDate(dateStr);
    let streak = 0;
    if (i === 0) {
      try { const ci = JSON.parse(localStorage.getItem('study_checkin') || '{}'); streak = ci.streak || 0; } catch (e) {}
    }
    rows.push({
      user_id: me.id,
      date: dateStr,
      checkin: stats.checkin,
      focus_ms: stats.focusMs,
      todos_done: stats.todosDone,
      habit_count: stats.habitCount,
      streak
    });
  }
  try {
    const { error } = await client.from('study_stats').upsert(rows, { onConflict: 'user_id,date' });
    if (!error) localStorage.setItem('study_stats_backfilled', '1');
    else console.warn('[Friends] backfill stats upsert failed:', error.message);
  } catch (e) {
    console.warn('[Friends] backfill stats failed:', e);
  }
}

// 计算本周专注 Top5 待办（按 targetType='todo' 或能从 todos 找到的 targetId 统计）
function computeWeeklyTopTodos() {
  const weekStart = friendsWeekStart();
  const today = formatDate(new Date());
  const map = {}; // todoId -> { title, focusMs }
  try {
    const records = JSON.parse(localStorage.getItem('study_timer_records') || '[]');
    records.forEach(r => {
      if (!r.affectsFocus || r.affectsFocus === false) return;
      if (!r.date || r.date < weekStart || r.date > today) return;
      if (r.targetType && r.targetType !== 'todo') return;
      if (!r.targetId) return;
      if (!map[r.targetId]) map[r.targetId] = { title: '', focusMs: 0 };
      map[r.targetId].focusMs += (r.totalMs || 0);
    });
  } catch (e) {}
  // 补标题
  try {
    const all = loadData('study_todos_v2');
    all.forEach(t => { if (map[t.id]) map[t.id].title = t.text; });
  } catch (e) {}
  const list = Object.keys(map).map(id => ({ todoId: Number(id), title: map[id].title, focusMs: map[id].focusMs }))
    .filter(x => x.title && x.focusMs > 0)
    .sort((a, b) => b.focusMs - a.focusMs)
    .slice(0, 5);
  return { weekStart, list };
}

// 今日完成且尚未发布动态的待办标题列表
function getTodayCompletedTodos() {
  const today = formatDate(new Date());
  const out = [];
  try {
    const all = loadData('study_todos_v2');
    all.forEach(t => { if (t.done && t.completedAt === today && t.text) out.push({ id: t.id, text: t.text }); });
  } catch (e) {}
  return out;
}

// 今日编辑过的笔记（标题 + 摘要；复用应用内已有 summary 字段）
function getTodayEditedNotes() {
  const today = formatDate(new Date());
  const out = [];
  try {
    const all = loadData('study_notes_v2');
    all.forEach(n => {
      if (n.type === 'folder') return;
      let updated = n.updatedAt;
      if (!updated && n.createdAt) updated = n.createdAt;
      if (!updated) return;
      const d = new Date(updated);
      if (isNaN(d.getTime())) return;
      const ds = formatDate(d);
      if (ds === today && n.title) {
        // 优先复用应用内 AI 生成的 summary；为空则从内容截取前 60 字兜底
        let summary = (n.summary || '').trim();
        if (summary) {
          out.push({ id: n.id, title: n.title, summary });
        } else {
          let content = (n.content || '').replace(/[#>*`\-_\[\]()!|]/g, ' ').replace(/\s+/g, ' ').trim();
          out.push({ id: n.id, title: n.title, summary: content.slice(0, 60) });
        }
      }
    });
  } catch (e) {}
  return out;
}

// 上传今日聚合统计，并据增量生成好友动态
async function syncStudyStats() {
  const client = getSupabaseClient();
  if (!client) return;
  let me;
  try {
    const { data: { user } } = await client.auth.getUser();
    if (!user) return;
    me = user;
  } catch (e) { return; }

  // 首次使用好友系统时回填过去 7 天历史数据
  await backfillStudyStats();

  const stats = computeDailyStats();
  const state = loadSyncState();
  // 日期变化则重置当日动态发布记录
  if (state.date !== stats.date) {
    state.date = stats.date;
    state.posted = [];
    state.lastFocusMs = 0; state.lastTodosDone = 0; state.lastHabitCount = 0; state.lastCheckin = false;
  }
  // 读取云端今日记录（用于判断增量）
  let cloud = null;
  try {
    const { data } = await client.from('study_stats')
      .select('*').eq('user_id', me.id).eq('date', stats.date).maybeSingle();
    cloud = data;
  } catch (e) {}

  // upsert 聚合统计
  const row = {
    user_id: me.id,
    date: stats.date,
    checkin: stats.checkin,
    focus_ms: stats.focusMs,
    todos_done: stats.todosDone,
    habit_count: stats.habitCount,
    streak: stats.streak
  };
  let upsertError = null;
  try {
    const { error } = await client.from('study_stats').upsert(row, { onConflict: 'user_id,date' });
    upsertError = error;
  } catch (e) { upsertError = e; }
  if (upsertError) {
    console.warn('[Friends] sync stats failed:', upsertError.message);
    return;
  }

  // 生成动态（每天每种仅发布一次）
  const activities = [];
  const focusMin = Math.floor(stats.focusMs / 60000);
  // 打卡
  if (stats.checkin && !state.posted.includes('checkin') && (!cloud || !cloud.checkin)) {
    activities.push({
      type: 'checkin',
      content: `完成了今天的打卡 ✅`,
      meta: { date: stats.date, streak: stats.streak }
    });
    state.posted.push('checkin');
  }
  // 完成任务（逐条显示标题）
  const doneTodos = getTodayCompletedTodos();
  doneTodos.forEach(t => {
    const key = 'todo:' + t.id;
    if (!state.posted.includes(key)) {
      activities.push({
        type: 'todos_done',
        content: `完成待办「${t.text}」🎯`,
        meta: { date: stats.date, todoId: t.id }
      });
      state.posted.push(key);
    }
  });
  // 编辑笔记（标题 + 摘要）
  const editedNotes = getTodayEditedNotes();
  editedNotes.forEach(n => {
    const key = 'note:' + n.id;
    if (!state.posted.includes(key)) {
      activities.push({
        type: 'note_edit',
        content: `编辑笔记「${n.title}」`,
        meta: { date: stats.date, noteId: n.id, summary: n.summary }
      });
      state.posted.push(key);
    }
  });
  // 专注里程碑（30/60/90/120...分钟）
  if (focusMin >= 30 && !state.posted.includes('focus') && (!cloud || focusMin > Math.floor((cloud.focus_ms || 0) / 60000))) {
    activities.push({
      type: 'focus',
      content: `专注时长突破 ${friendsFormatDuration(stats.focusMs)} ⏱️`,
      meta: { date: stats.date, minutes: focusMin }
    });
    state.posted.push('focus');
  }
  // 习惯打卡
  if (stats.habitCount > 0 && !state.posted.includes('habit') && (!cloud || stats.habitCount > (cloud.habit_count || 0))) {
    activities.push({
      type: 'habit',
      content: `完成了 ${stats.habitCount} 次习惯打卡 🌱`,
      meta: { date: stats.date, count: stats.habitCount }
    });
    state.posted.push('habit');
  }
  // 连续天数里程碑
  if (stats.streak > 0 && stats.streak % 7 === 0 && !state.posted.includes('streak')) {
    activities.push({
      type: 'streak',
      content: `连续学习 ${stats.streak} 天 🔥`,
      meta: { date: stats.date, streak: stats.streak }
    });
    state.posted.push('streak');
  }

  if (activities.length > 0) {
    try {
      const rows = activities.map(a => ({ user_id: me.id, type: a.type, content: a.content, meta: a.meta }));
      await client.from('activities').insert(rows);
    } catch (e) {
      console.warn('[Friends] publish activities failed:', e);
    }
  }
  saveSyncState(state);

  // 上传本周专注 Top5 待办（供好友资料卡展示）
  if (!window._weeklyFocusTodosMissing) {
    try {
      const { weekStart, list } = computeWeeklyTopTodos();
      if (list.length > 0) {
        const rows = list.map(t => ({
          user_id: me.id,
          week_start: weekStart,
          todo_id: t.todoId,
          title: t.title,
          focus_ms: t.focusMs
        }));
        await client.from('weekly_focus_todos').upsert(rows, { onConflict: 'user_id,week_start,todo_id' });
      }
    } catch (e) {
      if (e.message && /(404|Not Found|does not exist|relation.*does not exist)/i.test(String(e.message))) {
        window._weeklyFocusTodosMissing = true;
        console.warn('[Friends] weekly_focus_todos 表不存在，已跳过后续上传。请在 Supabase SQL Editor 执行 supabase/schema.sql 建表。');
      } else {
        console.warn('[Friends] sync weekly top todos failed:', e);
      }
    }
  }
  return { ok: true };
}

// ═══════════════ 动态流 ═══════════════
async function friendsLoadActivities() {
  const client = getSupabaseClient();
  const me = await friendsGetMyProfile();
  if (!client || !me) return [];
  const ids = new Set([me.id]);
  friendsListCache.forEach(f => ids.add(f.profile.id));
  const idArr = [...ids];
  try {
    const { data, error } = await client.from('activities')
      .select('*')
      .in('user_id', idArr)
      .order('created_at', { ascending: false })
      .limit(60);
    if (error) return [];
    // 补充作者资料
    const authors = {};
    try {
      const { data: profs } = await client.from('profiles')
        .select('id,username,nickname,avatar_url').in('id', idArr);
      (profs || []).forEach(p => authors[p.id] = p);
    } catch (e) {}
    friendsActivitiesCache = (data || []).map(a => ({ ...a, author: authors[a.user_id] || null }));
    return friendsActivitiesCache;
  } catch (e) {
    return [];
  }
}

// 订阅动态实时推送（RLS 自动过滤为本人+好友）
function friendsSubscribeActivities() {
  const client = getSupabaseClient();
  if (!client) return;
  try {
    const channel = client
      .channel('friends-activities')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'activities' },
        (payload) => {
          const act = payload.new;
          // 若是自己或好友的动态，插入到列表头部
          const meId = friendsAuthUser ? friendsAuthUser.id : null;
          const isMine = meId && act.user_id === meId;
          const isFriend = friendsListCache.some(f => f.profile.id === act.user_id);
          if (!isMine && !isFriend) return;
          friendsLoadActivities().then(() => {
            if (friendsMainView === 'feed' && document.getElementById('friendsMainView')) {
              document.getElementById('friendsMainView').innerHTML = renderFriendsFeedView();
              initFriendsLucide();
            }
          });
        })
      .subscribe();
    friendsRealtimeChannels.push(channel);
  } catch (e) {
    console.warn('[Friends] subscribe activities failed:', e);
  }
}

function friendsUnsubscribeAll() {
  const client = getSupabaseClient();
  if (client) {
    try { client.removeAllChannels(); } catch (e) {}
  }
  friendsRealtimeChannels = [];
  if (typeof _friendsSubscribedConvs !== 'undefined') _friendsSubscribedConvs = new Set();
}

// ═══════════════ 在线心跳 ═══════════════
let friendsHeartbeatTimer = null;
async function friendsHeartbeat() {
  const client = getSupabaseClient();
  if (!client) return;
  try {
    const { data: { user } } = await client.auth.getUser();
    if (!user) return;
    await client.from('profiles')
      .update({ last_seen: new Date().toISOString(), online_status: 'online' })
      .eq('id', user.id);
    // 刷新好友在线状态（若好友页可见）
    if (document.getElementById('section-friends')?.classList.contains('active')) {
      if (friendsMainView === 'feed' && document.getElementById('friendsMainView')) {
        document.getElementById('friendsMainView').innerHTML = renderFriendsFeedView();
        initFriendsLucide();
      }
      renderFriendList();
    }
  } catch (e) {}
}
function startFriendsHeartbeat() {
  stopFriendsHeartbeat();
  friendsHeartbeatTimer = setInterval(friendsHeartbeat, 60000);
  friendsHeartbeat();
}
function stopFriendsHeartbeat() {
  if (friendsHeartbeatTimer) { clearInterval(friendsHeartbeatTimer); friendsHeartbeatTimer = null; }
}
window.addEventListener('beforeunload', () => {
  const client = getSupabaseClient();
  if (!client) return;
  client.auth.getUser().then(({ data }) => {
    if (data.user) {
      client.from('profiles').update({ online_status: 'offline' }).eq('id', data.user.id).then(() => {});
    }
  }).catch(() => {});
});

// ═══════════════ 刷新入口 ═══════════════
let friendsRefreshing = false;
async function refreshFriendsAll() {
  if (friendsRefreshing) return;
  friendsRefreshing = true;
  try {
    await friendsLoadAll();
    await friendsLoadActivities();
    await syncStudyStats();
    renderFriendsHome();
  } catch (e) {
    console.error('[Friends] refresh failed:', e);
  } finally {
    friendsRefreshing = false;
  }
}

// ═══════════════ 主渲染入口 ═══════════════
async function renderFriends() {
  const container = document.getElementById('friendsApp');
  if (!container) return;
  if (!isFriendsConfigured()) {
    container.innerHTML = renderFriendsSetup();
    initFriendsLucide();
    return;
  }
  const session = await friendsGetSession();
  if (!session) {
    container.innerHTML = renderFriendsLogin();
    initFriendsLucide();
    return;
  }
  // 已登录
  if (!friendsAuthUser) {
    friendsAuthUser = await friendsGetMyProfile();
  }
  if (!friendsAuthUser) {
    // profile 未建（可能刚注册），尝试重取或登出
    container.innerHTML = renderFriendsLogin();
    initFriendsLucide();
    return;
  }
  await friendsLoadAll();
  if (friendsActivitiesCache.length === 0) await friendsLoadActivities();
  renderFriendsHome();
  initFriendsAuth();
  startFriendsHeartbeat();
  friendsSubscribeActivities();
  if (typeof friendsSubscribeAllConversations === 'function') friendsSubscribeAllConversations();
  if (typeof friendsUpdateSidebarBadge === 'function') friendsUpdateSidebarBadge();
  // 若进入页面时没有今天的统计，尝试同步
  syncStudyStats();
}

// 未配置 Supabase 的引导页
function renderFriendsSetup() {
  return `
  <div class="fr-setup-wrap">
    <div class="fr-setup-card">
      <i data-lucide="users" class="lucide-icon fr-setup-icon"></i>
      <h3>好友系统需要先连接云端</h3>
      <p>好友系统基于 Supabase 云服务，首次使用请先完成两件事：</p>
      <ol class="fr-setup-steps">
        <li><b>创建数据库表</b>：打开 Supabase 控制台 → SQL Editor，执行应用目录下 <code>supabase/schema.sql</code> 中的脚本（已随应用提供）。</li>
        <li><b>填写项目配置</b>：在 <b>设置 → 好友</b> 中填入项目的 URL 与 anon public key。</li>
      </ol>
      <button class="btn-add" onclick="openSettingsModal()" style="align-self:center;">
        <i data-lucide="settings" class="lucide-icon" style="width:15px;height:15px;"></i> 前往设置
      </button>
    </div>
  </div>`;
}

// 未登录页
function renderFriendsLogin() {
  return `
  <div class="fr-auth-wrap">
    <div class="fr-auth-card">
      <div class="fr-auth-tabs">
        <button class="fr-auth-tab active" id="frAuthTabLogin" onclick="frSwitchAuthTab('login')">登录账号</button>
        <button class="fr-auth-tab" id="frAuthTabRegister" onclick="frSwitchAuthTab('register')">注册新账号</button>
      </div>
      <div id="frAuthBody">
        ${frLoginForm()}
      </div>
    </div>
  </div>`;
}

function frSwitchAuthTab(mode) {
  document.getElementById('frAuthTabLogin').classList.toggle('active', mode === 'login');
  document.getElementById('frAuthTabRegister').classList.toggle('active', mode === 'register');
  document.getElementById('frAuthBody').innerHTML = mode === 'login' ? frLoginForm() : frRegisterForm();
  initFriendsLucide();
}

function frLoginForm() {
  return `
  <div class="fr-auth-form">
    <i data-lucide="log-in" class="lucide-icon fr-auth-icon"></i>
    <h3>登录账号</h3>
    <label class="fr-auth-label">邮箱</label>
    <input type="email" class="fr-auth-input" id="frLoginEmail" placeholder="you@example.com" onkeydown="if(event.key==='Enter')frDoLogin()">
    <label class="fr-auth-label">密码</label>
    <input type="password" class="fr-auth-input" id="frLoginPassword" placeholder="密码" onkeydown="if(event.key==='Enter')frDoLogin()">
    <div class="fr-auth-status" id="frAuthStatus"></div>
    <button class="btn-add" onclick="frDoLogin()" style="width:100%;justify-content:center;margin-top:6px;">
      <i data-lucide="log-in" class="lucide-icon" style="width:15px;height:15px;"></i> 登录
    </button>
  </div>`;
}

function frRegisterForm() {
  return `
  <div class="fr-auth-form">
    <i data-lucide="user-plus" class="lucide-icon fr-auth-icon"></i>
    <h3>注册新账号</h3>
    <label class="fr-auth-label">用户名（唯一，好友通过它找到你）</label>
    <input type="text" class="fr-auth-input" id="frRegUsername" placeholder="如：小纪" maxlength="30">
    <label class="fr-auth-label">昵称（可选）</label>
    <input type="text" class="fr-auth-input" id="frRegNickname" placeholder="展示昵称" maxlength="30">
    <label class="fr-auth-label">邮箱</label>
    <input type="email" class="fr-auth-input" id="frRegEmail" placeholder="you@example.com">
    <label class="fr-auth-label">密码（至少 6 位）</label>
    <input type="password" class="fr-auth-input" id="frRegPassword" placeholder="密码" onkeydown="if(event.key==='Enter')frDoRegister()">
    <label class="fr-auth-label">确认密码</label>
    <input type="password" class="fr-auth-input" id="frRegPassword2" placeholder="再次输入密码" onkeydown="if(event.key==='Enter')frDoRegister()">
    <div class="fr-auth-status" id="frAuthStatus"></div>
    <button class="btn-add" onclick="frDoRegister()" style="width:100%;justify-content:center;margin-top:6px;">
      <i data-lucide="user-plus" class="lucide-icon" style="width:15px;height:15px;"></i> 注册
    </button>
  </div>`;
}

function frSetAuthStatus(msg, isError) {
  const el = document.getElementById('frAuthStatus');
  if (el) { el.textContent = msg; el.style.color = isError ? 'var(--danger)' : 'var(--done)'; }
}

async function frDoLogin() {
  const email = document.getElementById('frLoginEmail').value.trim();
  const password = document.getElementById('frLoginPassword').value;
  frSetAuthStatus('登录中…');
  const res = await friendsLogin(email, password);
  if (!res.ok) { frSetAuthStatus(res.error, true); return; }
  friendsAuthUser = await friendsGetMyProfile();
  frSetAuthStatus('');
  friendsShowToast('✅ 登录成功，欢迎回来！');
  renderFriends();
}

async function frDoRegister() {
  const username = document.getElementById('frRegUsername').value.trim();
  const nickname = document.getElementById('frRegNickname').value.trim();
  const email = document.getElementById('frRegEmail').value.trim();
  const password = document.getElementById('frRegPassword').value;
  const password2 = document.getElementById('frRegPassword2').value;
  if (!username) { frSetAuthStatus('请填写用户名', true); return; }
  if (!/^[\u4e00-\u9fa5a-zA-Z0-9_-]{1,30}$/.test(username)) { frSetAuthStatus('用户名仅支持中文、字母、数字、下划线和中划线', true); return; }
  if (!email) { frSetAuthStatus('请填写邮箱', true); return; }
  if (password !== password2) { frSetAuthStatus('两次输入的密码不一致', true); return; }
  frSetAuthStatus('注册中…');
  const res = await friendsRegister(username, nickname, email, password);
  if (!res.ok) { frSetAuthStatus(res.error, true); return; }
  if (res.needEmailConfirm) {
    frSetAuthStatus('注册成功！已发送确认邮件，请先到邮箱确认，然后回到这里登录。');
    friendsShowToast('📧 注册成功！已发送确认邮件，请到邮箱确认后登录');
    frSwitchAuthTab('login');
    return;
  }
  friendsAuthUser = await friendsGetMyProfile();
  frSetAuthStatus('');
  friendsShowToast('🎉 注册成功，欢迎加入！');
  renderFriends();
}

// ═══════════════ 已登录主界面 ═══════════════
function renderFriendsHome() {
  const container = document.getElementById('friendsApp');
  if (!container) return;
  const me = friendsAuthUser;
  if (!me) return;
  const incomingCount = friendsRequestsCache.incoming.length;
  container.innerHTML = `
  <div class="fr-layout">
    <aside class="fr-sidebar">
      <div class="fr-me-card">
        ${friendsAvatarHtml(me, 44)}
        <div class="fr-me-info">
          <div class="fr-me-name">${escapeHtml(me.nickname || me.username)}</div>
          <div class="fr-me-user">@${escapeHtml(me.username)}</div>
        </div>
        <div class="fr-me-actions">
          <button class="fr-icon-btn" onclick="frEditProfile()" title="编辑资料"><i data-lucide="pencil" class="lucide-icon" style="width:14px;height:14px;"></i></button>
          <button class="fr-icon-btn" onclick="frShowAbout()" title="关于"><i data-lucide="info" class="lucide-icon" style="width:14px;height:14px;"></i></button>
          <button class="fr-icon-btn" onclick="friendsLogout()" title="退出登录" style="color:var(--danger);"><i data-lucide="log-out" class="lucide-icon" style="width:14px;height:14px;"></i></button>
        </div>
      </div>
      <div class="fr-sidebar-tabs">
        <button class="fr-sidebar-tab active" data-view="feed" onclick="frSwitchMainView('feed')"><i data-lucide="rss" class="lucide-icon" style="width:14px;height:14px;"></i> 动态</button>
        <button class="fr-sidebar-tab" data-view="requests" onclick="frSwitchMainView('requests')">
          <i data-lucide="user-plus" class="lucide-icon" style="width:14px;height:14px;"></i> 请求
          ${incomingCount > 0 ? `<span class="fr-badge">${incomingCount}</span>` : ''}
        </button>
      </div>
      <div class="fr-groups" id="frGroupsBox">
        ${friendsGroupsHtml()}
      </div>
      <div class="fr-list-header">
        <span>好友</span>
        <span class="fr-friend-count">${friendsListCache.length}</span>
      </div>
      <div class="fr-friend-list" id="frFriendList">${friendsFriendListHtml()}</div>
      <div class="fr-sidebar-footer">
        <button class="fr-add-friend-btn" onclick="frOpenAddFriend()">
          <i data-lucide="user-plus" class="lucide-icon" style="width:14px;height:14px;"></i> 添加好友
        </button>
        <button class="fr-icon-btn" onclick="frOpenFriendSettings()" title="好友设置"><i data-lucide="settings" class="lucide-icon" style="width:14px;height:14px;"></i></button>
      </div>
    </aside>
    <main class="fr-main" id="friendsMainView">
      ${friendsMainView === 'chat' ? renderFriendsChatView() : friendsMainView === 'requests' ? renderFriendsRequestsView() : renderFriendsFeedView()}
    </main>
  </div>`;
  initFriendsLucide();
}

// 分组列表 HTML（含全部好友分组切换）
function friendsGroupsHtml() {
  let html = '';
  html += `<div class="fr-group-item ${!friendsGroupFilter ? 'active' : ''}" onclick="frSetGroupFilter(null)">
    <i data-lucide="users" class="lucide-icon" style="width:13px;height:13px;"></i> 全部好友
    <span class="fr-group-count">${friendsListCache.length}</span>
  </div>`;
  friendsGroupsCache.forEach(g => {
    const count = friendsListCache.filter(f => f.friendship.group_id === g.id).length;
    html += `<div class="fr-group-item ${friendsGroupFilter === g.id ? 'active' : ''}" onclick="frSetGroupFilter('${g.id}')">
      <span class="fr-group-dot" style="background:${g.color || '#4f6ef7'}"></span> ${escapeHtml(g.name)}
      <span class="fr-group-count">${count}</span>
      <span class="fr-group-actions">
        <button title="重命名" onclick="event.stopPropagation();frRenameGroup('${g.id}')"><i data-lucide="pencil" class="lucide-icon" style="width:11px;height:11px;"></i></button>
        <button title="删除" style="color:var(--danger);" onclick="event.stopPropagation();frDeleteGroup('${g.id}')"><i data-lucide="trash-2" class="lucide-icon" style="width:11px;height:11px;"></i></button>
      </span>
    </div>`;
  });
  html += `<button class="fr-group-add" onclick="frAddGroup()"><i data-lucide="plus" class="lucide-icon" style="width:12px;height:12px;"></i> 新建分组</button>`;
  return html;
}

// 好友列表 HTML
function friendsFriendListHtml() {
  const filtered = friendsGroupFilter ? friendsListCache.filter(f => f.friendship.group_id === friendsGroupFilter) : friendsListCache;
  if (filtered.length === 0) {
    return `<div class="fr-list-empty">
      <p>暂无好友</p>
      <p class="fr-list-empty-hint">点击下方「添加好友」开始</p>
    </div>`;
  }
  return filtered.map(f => {
    const p = f.profile;
    const online = friendsIsOnline(p);
    const lastMsg = (typeof friendsGetLastMessageText === 'function') ? friendsGetLastMessageText(p.id) : '';
    const unread = (typeof friendsGetUnreadCount === 'function') ? friendsGetUnreadCount(p.id) : 0;
    const active = friendsMainView === 'chat' && friendsChatFriendId === p.id;
    return `<div class="fr-friend-item ${active ? 'active' : ''}" onclick="friendsOpenChat('${p.id}')">
      <span class="fr-avatar-wrap">
        ${friendsAvatarHtml(p, 38)}
        <span class="fr-online-dot ${online ? 'on' : ''}"></span>
      </span>
      <div class="fr-friend-info">
        <div class="fr-friend-name">${escapeHtml(p.nickname || p.username)} ${unread > 0 ? `<span class="fr-badge">${unread}</span>` : ''}</div>
        <div class="fr-friend-preview">${lastMsg ? escapeHtml(lastMsg) : (online ? '在线' : '离线')}</div>
      </div>
    </div>`;
  }).join('');
}

// 动态流视图
function renderFriendsFeedView() {
  const acts = friendsActivitiesCache;
  if (acts.length === 0) {
    return `<div class="fr-main-empty">
      <i data-lucide="rss" class="lucide-icon" style="width:48px;height:48px;opacity:0.4;color:var(--text-secondary);"></i>
      <p>还没有动态</p>
      <p class="fr-main-empty-hint">学习打卡、专注、完成任务都会在这里展示</p>
    </div>`;
  }
  return `
  <div class="fr-main-header">
    <span class="fr-main-title"><i data-lucide="rss" class="lucide-icon" style="width:15px;height:15px;"></i> 好友动态</span>
    <button class="fr-icon-btn" onclick="frRefreshFeed()" title="刷新"><i data-lucide="refresh-cw" class="lucide-icon" style="width:14px;height:14px;"></i></button>
  </div>
  <div class="fr-feed-list">
    ${acts.map(a => {
      const author = a.author || {};
      const isMine = friendsAuthUser && a.user_id === friendsAuthUser.id;
      return `<div class="fr-feed-item">
        ${friendsAvatarHtml(author, 36)}
        <div class="fr-feed-body">
          <div class="fr-feed-head">
            <span class="fr-feed-name">${escapeHtml(isMine ? '我' : (author.nickname || author.username || '好友'))}</span>
            <span class="fr-feed-time">${friendsFormatTime(a.created_at)}</span>
          </div>
          <div class="fr-feed-content">${escapeHtml(a.content)}</div>
          ${a.type === 'note_edit' && a.meta && a.meta.summary
            ? `<div class="fr-feed-note-summary">${escapeHtml(a.meta.summary)}</div>`
            : ''}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

// 请求视图
function renderFriendsRequestsView() {
  const inc = friendsRequestsCache.incoming;
  const out = friendsRequestsCache.outgoing;
  return `
  <div class="fr-main-header">
    <span class="fr-main-title"><i data-lucide="user-plus" class="lucide-icon" style="width:15px;height:15px;"></i> 好友请求</span>
  </div>
  <div class="fr-req-section">
    <div class="fr-req-title">收到的请求${inc.length ? ` <span class="fr-badge">${inc.length}</span>` : ''}</div>
    ${inc.length === 0 ? '<div class="fr-req-empty">暂无新的好友请求</div>' : inc.map(r => {
      const p = r.profile || {};
      return `<div class="fr-req-item">
        ${friendsAvatarHtml(p, 36)}
        <div class="fr-friend-info" style="flex:1;">
          <div class="fr-friend-name">${escapeHtml(p.nickname || p.username)}</div>
          <div class="fr-friend-preview">@${escapeHtml(p.username)}</div>
        </div>
        <button class="fr-btn-sm fr-btn-primary" onclick="frRespondRequest('${r.id}', true)">接受</button>
        <button class="fr-btn-sm" onclick="frRespondRequest('${r.id}', false)">拒绝</button>
      </div>`;
    }).join('')}
  </div>
  <div class="fr-req-section">
    <div class="fr-req-title">已发出的请求${out.length ? ` <span class="fr-badge">${out.length}</span>` : ''}</div>
    ${out.length === 0 ? '<div class="fr-req-empty">没有等待处理的请求</div>' : out.map(r => {
      const p = r.profile || {};
      return `<div class="fr-req-item">
        ${friendsAvatarHtml(p, 36)}
        <div class="fr-friend-info" style="flex:1;">
          <div class="fr-friend-name">${escapeHtml(p.nickname || p.username)}</div>
          <div class="fr-friend-preview">@${escapeHtml(p.username)}</div>
        </div>
        <span class="fr-pending-badge">等待对方确认</span>
        <button class="fr-btn-sm" onclick="frCancelRequest('${r.id}')">撤回</button>
      </div>`;
    }).join('')}
  </div>`;
}

// ═══════════════ 视图切换与交互 ═══════════════
let friendsGroupFilter = null;

function frSwitchMainView(view) {
  friendsMainView = view;
  if (view === 'chat' && !friendsChatFriendId) view = 'feed';
  const main = document.getElementById('friendsMainView');
  if (!main) return;
  main.innerHTML = view === 'chat' ? renderFriendsChatView()
    : view === 'requests' ? renderFriendsRequestsView()
    : renderFriendsFeedView();
  document.querySelectorAll('.fr-sidebar-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.view === (view === 'chat' ? 'feed' : view));
  });
  initFriendsLucide();
}

function frSetGroupFilter(groupId) {
  friendsGroupFilter = groupId;
  document.getElementById('frGroupsBox').innerHTML = friendsGroupsHtml();
  document.getElementById('frFriendList').innerHTML = friendsFriendListHtml();
  initFriendsLucide();
}

function frRefreshFeed() {
  friendsLoadActivities().then(() => {
    const main = document.getElementById('friendsMainView');
    if (main && friendsMainView === 'feed') main.innerHTML = renderFriendsFeedView();
    initFriendsLucide();
  });
}

async function frRespondRequest(reqId, accept) {
  const res = await friendsRespondRequest(reqId, accept);
  if (!res.ok) { showCustomConfirm(res.error); return; }
  await friendsLoadAll();
  if (friendsMainView === 'requests') renderFriendsHome();
  else { renderFriendsHome(); frSwitchMainView('requests'); }
}

async function frCancelRequest(reqId) {
  await friendsRespondRequest(reqId, false);
  await friendsLoadAll();
  renderFriendsHome();
  frSwitchMainView('requests');
}

// ═══════════════ 添加好友弹窗 ═══════════════
async function frOpenAddFriend() {
  document.getElementById('editModalTitle').innerHTML = '<i data-lucide="user-plus" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> 添加好友';
  document.getElementById('editModalBody').innerHTML = `
    <div class="fr-search-box">
      <input type="text" id="frSearchInput" placeholder="输入用户名或昵称搜索…" onkeydown="if(event.key==='Enter')frDoSearch()">
      <button class="btn-add" onclick="frDoSearch()" style="padding:6px 14px;">搜索</button>
    </div>
    <div class="fr-search-status" id="frSearchStatus"></div>
    <div class="fr-search-results" id="frSearchResults"></div>
  `;
  editModalOpen = true;
  document.getElementById('editModal').classList.add('open');
  setTimeout(() => document.getElementById('frSearchInput').focus(), 100);
  initFriendsLucide();
}

async function frDoSearch() {
  const q = document.getElementById('frSearchInput').value.trim();
  const statusEl = document.getElementById('frSearchStatus');
  const resEl = document.getElementById('frSearchResults');
  if (!q) return;
  statusEl.textContent = '搜索中…';
  const results = await friendsSearchUsers(q);
  statusEl.textContent = '';
  if (results.length === 0) {
    resEl.innerHTML = `<div class="fr-search-empty">没有找到相关用户，试试用户名</div>`;
    return;
  }
  const me = friendsAuthUser;
  resEl.innerHTML = results.map(p => {
    // 判断关系状态
    const rel = friendsListCache.find(f => f.profile.id === p.id);
    const incoming = friendsRequestsCache.incoming.find(r => r.user_id === p.id);
    const outgoing = friendsRequestsCache.outgoing.find(r => r.friend_id === p.id);
    let btn = '';
    if (rel) {
      btn = `<span class="fr-pending-badge" style="color:var(--done);">已是好友</span>`;
    } else if (incoming) {
      btn = `<button class="fr-btn-sm fr-btn-primary" onclick="frRespondRequest('${incoming.id}', true)">接受</button>`;
    } else if (outgoing) {
      btn = `<span class="fr-pending-badge">已发送</span>`;
    } else {
      btn = `<button class="fr-btn-sm fr-btn-primary" onclick="frSendRequest('${p.id}', this)"><i data-lucide="user-plus" class="lucide-icon" style="width:12px;height:12px;"></i> 添加</button>`;
    }
    return `<div class="fr-search-item">
      ${friendsAvatarHtml(p, 34)}
      <div class="fr-friend-info" style="flex:1;">
        <div class="fr-friend-name">${escapeHtml(p.nickname || p.username)}</div>
        <div class="fr-friend-preview">@${escapeHtml(p.username)}${p.bio ? ' · ' + escapeHtml(p.bio) : ''}</div>
      </div>
      ${btn}
    </div>`;
  }).join('');
  initFriendsLucide();
}

async function frSendRequest(targetId, btnEl) {
  if (btnEl) btnEl.disabled = true;
  const res = await friendsSendRequest(targetId);
  if (!res.ok) {
    if (btnEl) btnEl.disabled = false;
    showCustomConfirm(res.error);
    return;
  }
  if (res.autoAccepted) showCustomConfirm('对方曾向你发送过请求，已自动成为好友 🎉');
  await friendsLoadAll();
  renderFriendsHome();
  if (btnEl) btnEl.innerHTML = '<span class="fr-pending-badge">已发送</span>';
}

// ═══════════════ 编辑资料 ═══════════════
async function frEditProfile() {
  const me = friendsAuthUser;
  document.getElementById('editModalTitle').innerHTML = '<i data-lucide="user" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> 编辑我的资料';
  document.getElementById('editModalBody').innerHTML = `
    <div class="modal-field">
      <label>昵称</label>
      <input type="text" id="frEditNickname" value="${escapeAttr(me.nickname || '')}" maxlength="30">
    </div>
    <div class="modal-field">
      <label>用户名（唯一标识，不可更改）</label>
      <input type="text" value="${escapeAttr(me.username || '')}" disabled style="opacity:0.6;">
    </div>
    <div class="modal-field">
      <label>简介</label>
      <textarea id="frEditBio" rows="2" maxlength="120" placeholder="一句话介绍自己">${escapeHtml(me.bio || '')}</textarea>
    </div>
    <div class="modal-field">
      <label>头像 URL（可选，留空显示首字母）</label>
      <input type="text" id="frEditAvatar" value="${escapeAttr(me.avatar_url || '')}" placeholder="https://…">
    </div>
    <div class="fr-auth-status" id="frEditStatus"></div>
    <button class="btn-save-modal" onclick="frSaveProfile()">保存</button>
  `;
  editModalOpen = true;
  document.getElementById('editModal').classList.add('open');
  initFriendsLucide();
}

async function frSaveProfile() {
  const nickname = document.getElementById('frEditNickname').value.trim();
  const bio = document.getElementById('frEditBio').value.trim();
  const avatar = document.getElementById('frEditAvatar').value.trim();
  const client = getSupabaseClient();
  if (!client) return;
  try {
    const { error } = await client.from('profiles')
      .update({ nickname, bio, avatar_url: avatar, updated_at: new Date().toISOString() })
      .eq('id', friendsAuthUser.id);
    if (error) {
      document.getElementById('frEditStatus').textContent = '保存失败：' + error.message;
      return;
    }
    friendsAuthUser = await friendsGetMyProfile();
    closeEditModal();
    renderFriendsHome();
  } catch (e) {
    document.getElementById('frEditStatus').textContent = '保存异常：' + e.message;
  }
}

// ═══════════════ 分组管理交互 ═══════════════
async function frAddGroup() {
  document.getElementById('editModalTitle').innerHTML = '<i data-lucide="folder-plus" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> 新建分组';
  document.getElementById('editModalBody').innerHTML = `
    <div class="modal-field"><label>分组名称</label>
      <input type="text" id="frGroupName" maxlength="20" placeholder="如：学习小组" onkeydown="if(event.key==='Enter')frCreateGroup()">
    </div>
    <div class="modal-field">
      <label>颜色</label>
      <div class="fr-color-row" id="frColorPicker"></div>
    </div>
    <button class="btn-save-modal" onclick="frCreateGroup()">创建</button>
  `;
  const colors = ['#4f6ef7', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];
  document.getElementById('frColorPicker').innerHTML = colors.map((c, i) =>
    `<span class="fr-color-swatch ${i === 0 ? 'sel' : ''}" style="background:${c}" onclick="frPickColor(this,'${c}')"></span>`
  ).join('');
  editModalOpen = true;
  document.getElementById('editModal').classList.add('open');
  setTimeout(() => document.getElementById('frGroupName').focus(), 100);
}

function frPickColor(el, color) {
  document.querySelectorAll('#frColorPicker .fr-color-swatch').forEach(s => s.classList.remove('sel'));
  el.classList.add('sel');
  el.dataset.color = color;
}

async function frCreateGroup() {
  const name = document.getElementById('frGroupName').value.trim();
  const sel = document.querySelector('#frColorPicker .fr-color-swatch.sel');
  const color = sel ? (sel.dataset.color || sel.style.background) : '#4f6ef7';
  const res = await friendsCreateGroup(name, color);
  if (!res.ok) { showCustomConfirm(res.error); return; }
  closeEditModal();
  renderFriendsSidebar();
}

function renderFriendsSidebar() {
  const g = document.getElementById('frGroupsBox');
  const l = document.getElementById('frFriendList');
  if (g) g.innerHTML = friendsGroupsHtml();
  if (l) l.innerHTML = friendsFriendListHtml();
  initFriendsLucide();
}

function renderFriendList() {
  const l = document.getElementById('frFriendList');
  if (l) l.innerHTML = friendsFriendListHtml();
}

// 分组重命名
async function frRenameGroup(groupId) {
  const g = friendsGroupsCache.find(x => x.id === groupId);
  if (!g) return;
  document.getElementById('editModalTitle').innerHTML = '<i data-lucide="pencil" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> 重命名分组';
  document.getElementById('editModalBody').innerHTML = `
    <div class="modal-field"><label>分组名称</label>
      <input type="text" id="frGroupName" maxlength="20" value="${escapeAttr(g.name)}" onkeydown="if(event.key==='Enter')frCommitRename('${groupId}')">
    </div>
    <button class="btn-save-modal" onclick="frCommitRename('${groupId}')">保存</button>
  `;
  editModalOpen = true;
  document.getElementById('editModal').classList.add('open');
  setTimeout(() => { const el = document.getElementById('frGroupName'); if (el) { el.focus(); el.select(); } }, 100);
}

async function frCommitRename(groupId) {
  const name = document.getElementById('frGroupName').value.trim();
  if (!name) { showCustomConfirm('分组名称不能为空'); return; }
  const res = await friendsRenameGroup(groupId, name);
  if (!res.ok) { showCustomConfirm(res.error); return; }
  closeEditModal();
  renderFriendsSidebar();
}

async function frDeleteGroup(groupId) {
  const g = friendsGroupsCache.find(x => x.id === groupId);
  showCustomConfirm(`确定删除分组「${g ? g.name : ''}」吗？组内好友会移到「全部好友」。`, {
    dontAskKey: 'study_dontask_delete_friend_group'
  }).then(async confirmed => {
    if (!confirmed) return;
    const res = await friendsDeleteGroup(groupId);
    if (!res.ok) { showCustomConfirm(res.error); return; }
    if (friendsGroupFilter === groupId) friendsGroupFilter = null;
    renderFriendsSidebar();
  });
}

// 好友分组设置弹窗（点击好友卡片上的分组按钮时调用）
function frOpenFriendGroupPicker(friendId) {
  const client = getSupabaseClient();
  const f = friendsListCache.find(x => x.profile.id === friendId);
  if (!f) return;
  const current = f.friendship.group_id;
  let opts = `<div class="fr-group-pick-item ${!current ? 'sel' : ''}" onclick="frAssignGroup('${friendId}', null)"><i data-lucide="users" class="lucide-icon" style="width:13px;height:13px;"></i> 全部好友</div>`;
  friendsGroupsCache.forEach(g => {
    opts += `<div class="fr-group-pick-item ${current === g.id ? 'sel' : ''}" onclick="frAssignGroup('${friendId}', '${g.id}')">
      <span class="fr-group-dot" style="background:${g.color || '#4f6ef7'}"></span> ${escapeHtml(g.name)}
    </div>`;
  });
  document.getElementById('editModalTitle').innerHTML = '<i data-lucide="folder" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> 移动好友到分组';
  document.getElementById('editModalBody').innerHTML = `<div class="fr-group-pick-list">${opts}</div>`;
  editModalOpen = true;
  document.getElementById('editModal').classList.add('open');
  initFriendsLucide();
}

async function frAssignGroup(friendId, groupId) {
  const res = await friendsAssignGroup(friendId, groupId);
  closeEditModal();
  if (!res.ok) { showCustomConfirm(res.error); return; }
  renderFriendsSidebar();
  // 若聊天视图打开，同步刷新资料卡
  if (typeof friendsRefreshChatHeader === 'function' && friendsMainView === 'chat' && friendsChatFriendId === friendId) {
    friendsRefreshChatHeader();
  }
}

// ═══════════════ 关于/设置弹窗 ═══════════════
function frShowAbout() {
  document.getElementById('editModalTitle').innerHTML = '<i data-lucide="info" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> 关于好友系统';
  document.getElementById('editModalBody').innerHTML = `
    <div style="font-size:13px;line-height:1.9;color:var(--text);">
      <p><b>好友系统</b> 让你的学习不再孤单：</p>
      <ul style="padding-left:18px;color:var(--text-secondary);">
        <li>添加好友、分组管理、好友资料卡</li>
        <li>学习动态：打卡、专注、任务完成实时可见</li>
        <li>好友间实时聊天</li>
        <li>只同步<u>聚合统计</u>（打卡/时长/数量），不上传具体待办与笔记内容</li>
      </ul>
      <p style="color:var(--text-secondary);">数据存储于你的 Supabase 项目。</p>
    </div>
  `;
  editModalOpen = true;
  document.getElementById('editModal').classList.add('open');
  initFriendsLucide();
}

function frOpenFriendSettings() {
  openSettingsModal();
  setTimeout(() => { try { switchSettingsTab('friends'); } catch (e) {} }, 50);
}

// ═══════════════ Lucide 辅助 ═══════════════
function initFriendsLucide() {
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}

// ═══════════════ Toast 提示 ═══════════════
let _friendsToastTimer = null;
function friendsShowToast(msg, type) {
  let toast = document.getElementById('friendsToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'friendsToast';
    toast.className = 'fr-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = 'fr-toast show' + (type === 'error' ? ' error' : '');
  clearTimeout(_friendsToastTimer);
  _friendsToastTimer = setTimeout(() => {
    toast.className = 'fr-toast';
  }, 3200);
}

// ═══════════════ 初始化 ═══════════════
let friendsInited = false;
function initFriends() {
  if (friendsInited) return;
  friendsInited = true;
  // 进入好友页时触发刷新
  if (typeof window.ExtManager === 'undefined') return;
}
