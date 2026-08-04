// ═══════════════════════════════════════════════════════════════════
// js/friends-chat.js — 好友实时聊天（Supabase Realtime）
// 依赖：friends.js（getSupabaseClient / friendsListCache / friendsAuthUser /
//       renderFriendsHome / initFriendsLucide / friendsGetMyProfile / escapeHtml 等）
// ═══════════════════════════════════════════════════════════════════

// 会话与消息缓存
let friendsConversations = {};   // 已加载会话: { friendId: convId }
let friendsMessages = {};        // 已加载消息: { convId: [{...}] }
let friendsUnread = {};          // 未读数: { friendId: count }
let friendsReadConvs = new Set(); // 已标记已读的会话 id（避免重复触发）
let friendsRealtimeChannels = [];
let _friendsSubscribedConvs = new Set(); // 已订阅的会话 id（避免重复订阅）

// 规范化两个用户 id 的排序（保证 user_a < user_b）
function friendsConvPair(a, b) {
  return a < b ? a + ':' + b : b + ':' + a;
}

// 获取或创建与某好友的会话
async function friendsGetOrCreateConversation(friendId) {
  const client = getSupabaseClient();
  const me = friendsAuthUser;
  if (!client || !me) return null;
  const pair = friendsConvPair(me.id, friendId);
  if (friendsConversations[friendId]) return friendsConversations[friendId];
  // 查找现有会话
  try {
    const { data, error } = await client.from('conversations')
      .select('id').or(`and(user_a.eq.${me.id},user_b.eq.${friendId}),and(user_a.eq.${friendId},user_b.eq.${me.id})`)
      .maybeSingle();
    if (error) return null;
    if (data) {
      friendsConversations[friendId] = data.id;
      return data.id;
    }
  } catch (e) { return null; }
  // 创建新会话
  try {
    const [a, b] = pair.split(':');
    const { data, error } = await client.from('conversations')
      .insert({ user_a: a, user_b: b }).select().single();
    if (error || !data) return null;
    friendsConversations[friendId] = data.id;
    return data.id;
  } catch (e) { return null; }
}

// 加载某个会话的消息（limit 条）
async function friendsLoadMessages(friendId, convId, limit = 50) {
  const client = getSupabaseClient();
  if (!client) return;
  try {
    const { data, error } = await client.from('messages')
      .select('*').eq('conversation_id', convId)
      .order('created_at', { ascending: false }).limit(limit);
    if (error) return;
    friendsMessages[convId] = (data || []).reverse();
    // 标记该会话已读
    friendsMarkConversationRead(convId, friendId);
  } catch (e) {}
}

// 发送消息
async function friendsSendMessage(friendId, content) {
  const client = getSupabaseClient();
  const me = friendsAuthUser;
  if (!client || !me) return { error: '请先登录' };
  if (!content.trim()) return { error: '消息不能为空' };
  const convId = await friendsGetOrCreateConversation(friendId);
  if (!convId) return { error: '创建会话失败，请重试' };
  try {
    const { error } = await client.from('messages').insert({
      conversation_id: convId,
      sender_id: me.id,
      content: content.trim()
    });
    if (error) return { error: error.message };
    // 更新会话时间
    try {
      await client.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', convId);
    } catch (e) {}
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}

// 标记会话已读
async function friendsMarkConversationRead(convId, friendId) {
  if (friendsReadConvs.has(convId)) return;
  const client = getSupabaseClient();
  const me = friendsAuthUser;
  if (!client || !me) return;
  friendsReadConvs.add(convId);
  try {
    const { error } = await client.from('messages')
      .update({ read_at: new Date().toISOString() })
      .eq('conversation_id', convId)
      .neq('sender_id', me.id)
      .is('read_at', null);
    if (!error) {
      // 本地未读数清零
      if (friendsUnread[friendId] > 0) {
        friendsUnread[friendId] = 0;
        renderFriendList();
        renderFriendsChatHeader(friendId);
      }
    }
  } catch (e) {}
}

// 订阅某会话的实时新消息
function friendsSubscribeConversation(convId, friendId) {
  if (_friendsSubscribedConvs.has(convId)) return;
  _friendsSubscribedConvs.add(convId);
  const client = getSupabaseClient();
  if (!client) return;
  try {
    const channel = client
      .channel('friends-msg-' + convId)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: 'conversation_id=eq.' + convId },
        (payload) => {
          const msg = payload.new;
          if (!Array.isArray(friendsMessages[convId])) friendsMessages[convId] = [];
          friendsMessages[convId].push(msg);
          // 若是别人发来的且聊天窗口正打开该好友 → 标记已读
          const isMe = friendsAuthUser && msg.sender_id === friendsAuthUser.id;
          if (!isMe) {
            const chatOpen = friendsMainView === 'chat' && friendsChatFriendId === friendId;
            if (chatOpen) {
              friendsMarkConversationRead(convId, friendId);
            } else {
              friendsUnread[friendId] = (friendsUnread[friendId] || 0) + 1;
              renderFriendList();
              if (typeof friendsUpdateSidebarBadge === 'function') friendsUpdateSidebarBadge();
            }
            // 刷新资料卡最近消息
            if (typeof friendsRefreshChatHeader === 'function') friendsRefreshChatHeader(friendId);
          }
          // 若当前正在看这个好友的聊天，滚动到底部
          if (friendsMainView === 'chat' && friendsChatFriendId === friendId) {
            renderFriendsChatMessages(convId);
          }
        })
      .subscribe();
    friendsRealtimeChannels.push(channel);
  } catch (e) {
    console.warn('[Friends] subscribe conversation failed:', e);
  }
}

// 获取好友资料
function friendsGetFriendProfile(friendId) {
  const f = friendsListCache.find(x => x.profile.id === friendId);
  return f ? f.profile : null;
}

// 打开聊天
async function friendsOpenChat(friendId) {
  friendsMainView = 'chat';
  friendsChatFriendId = friendId;
  const convId = await friendsGetOrCreateConversation(friendId);
  if (convId) {
    await friendsLoadMessages(friendId, convId);
    friendsSubscribeConversation(convId, friendId);
    renderFriendsHome();
    // 滚动到底部
    setTimeout(() => {
      const box = document.getElementById('frChatMessages');
      if (box) box.scrollTop = box.scrollHeight;
    }, 50);
  } else {
    friendsMainView = 'feed';
    renderFriendsHome();
    showCustomConfirm('无法打开会话，请检查网络后重试');
  }
}

function friendsCloseChat() {
  friendsMainView = 'feed';
  friendsChatFriendId = null;
}

// 最近消息预览（好友列表显示）
function friendsGetLastMessageText(friendId) {
  const convId = friendsConversations[friendId];
  if (!convId || !Array.isArray(friendsMessages[convId]) || friendsMessages[convId].length === 0) return '';
  const last = friendsMessages[convId][friendsMessages[convId].length - 1];
  return last ? last.content : '';
}

function friendsGetUnreadCount(friendId) {
  return friendsUnread[friendId] || 0;
}

// 侧边栏未读总徽标
function friendsTotalUnread() {
  return Object.values(friendsUnread).reduce((s, n) => s + n, 0);
}
function friendsUpdateSidebarBadge() {
  const total = friendsTotalUnread();
  const nav = document.getElementById('nav-friends');
  if (!nav) return;
  const old = nav.querySelector('.nav-friends-badge');
  if (old) old.remove();
  if (total > 0) {
    const b = document.createElement('span');
    b.className = 'nav-friends-badge';
    b.textContent = total > 99 ? '99+' : total;
    nav.appendChild(b);
  }
}

// 渲染聊天视图（主区）
function renderFriendsChatView() {
  const friendId = friendsChatFriendId;
  const p = friendsGetFriendProfile(friendId);
  if (!p) return `<div class="fr-main-empty"><p>未找到该好友</p></div>`;
  const convId = friendsConversations[friendId] || '';
  return `
  <div class="fr-chat">
    <div class="fr-chat-header" id="frChatHeader">
      ${friendsChatHeaderHtml(friendId)}
    </div>
    <div class="fr-chat-messages" id="frChatMessages">
      ${renderFriendsChatMessages(convId, friendId)}
    </div>
    <div class="fr-chat-input-bar">
      <input type="text" id="frChatInput" placeholder="输入消息…" maxlength="2000"
        onkeydown="if(event.key==='Enter')frSendChat()">
      <button class="btn-add" onclick="frSendChat()" title="发送"><i data-lucide="send" class="lucide-icon" style="width:15px;height:15px;"></i></button>
    </div>
  </div>`;
}

function friendsChatHeaderHtml(friendId) {
  const p = friendsGetFriendProfile(friendId);
  if (!p) return '';
  const online = friendsIsOnline(p);
  const me = friendsAuthUser;
  // 最近聚合统计（今日）
  return `
    <span class="fr-avatar-wrap">
      ${friendsAvatarHtml(p, 38)}
      <span class="fr-online-dot ${online ? 'on' : ''}"></span>
    </span>
    <div class="fr-chat-head-info" id="frChatHeadInfo">
      <div class="fr-friend-name">${escapeHtml(p.nickname || p.username)}</div>
      <div class="fr-friend-preview">${online ? '在线' : '离线 · ' + (p.last_seen ? '上次活跃 ' + friendsFormatTime(p.last_seen) : '')}</div>
    </div>
    <div class="fr-chat-head-actions">
      <button class="fr-icon-btn" title="移动分组" onclick="frOpenFriendGroupPicker('${friendId}')"><i data-lucide="folder" class="lucide-icon" style="width:14px;height:14px;"></i></button>
      <button class="fr-icon-btn" title="查看资料" onclick="frShowFriendProfile('${friendId}')"><i data-lucide="user" class="lucide-icon" style="width:14px;height:14px;"></i></button>
      <button class="fr-icon-btn" title="删除好友" style="color:var(--danger);" onclick="frRemoveFriend('${friendId}')"><i data-lucide="user-minus" class="lucide-icon" style="width:14px;height:14px;"></i></button>
    </div>`;
}

// 刷新聊天头部（在线状态/最近消息）
function friendsRefreshChatHeader(friendId) {
  const el = document.getElementById('frChatHeadInfo');
  if (el && friendId) {
    const p = friendsGetFriendProfile(friendId);
    if (p) {
      const online = friendsIsOnline(p);
      el.innerHTML = `
        <div class="fr-friend-name">${escapeHtml(p.nickname || p.username)}</div>
        <div class="fr-friend-preview">${online ? '在线' : '离线 · ' + (p.last_seen ? '上次活跃 ' + friendsFormatTime(p.last_seen) : '')}</div>`;
    }
  }
}

// 渲染消息列表
function renderFriendsChatMessages(convId, friendId) {
  const box = document.getElementById('frChatMessages');
  const msgs = convId && Array.isArray(friendsMessages[convId]) ? friendsMessages[convId] : [];
  if (msgs.length === 0) {
    const p = friendsGetFriendProfile(friendId);
    const html = `<div class="fr-chat-empty">
      <i data-lucide="message-circle" class="lucide-icon" style="width:36px;height:36px;opacity:0.35;color:var(--text-secondary);"></i>
      <p>和 ${escapeHtml(p ? (p.nickname || p.username) : '好友')} 打个招呼吧</p>
    </div>`;
    if (box) { box.innerHTML = html; initFriendsLucide(); }
    return html;
  }
  const me = friendsAuthUser;
  const html = msgs.map(m => {
    const mine = me && m.sender_id === me.id;
    return `<div class="fr-msg ${mine ? 'mine' : 'other'}">
      ${!mine ? friendsAvatarHtml(friendsGetFriendProfile(friendId), 26) : ''}
      <div class="fr-msg-bubble">${escapeHtml(m.content)}</div>
      <div class="fr-msg-time">${friendsFormatTime(m.created_at)}</div>
    </div>`;
  }).join('');
  if (box) {
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
    initFriendsLucide();
  }
  return html;
}

async function frSendChat() {
  const input = document.getElementById('frChatInput');
  if (!input) return;
  const content = input.value.trim();
  if (!content || !friendsChatFriendId) return;
  input.value = '';
  const res = await friendsSendMessage(friendsChatFriendId, content);
  if (!res.ok) {
    input.value = content;
    showCustomConfirm(res.error);
  }
}

// 查看好友资料
async function frShowFriendProfile(friendId) {
  const p = friendsGetFriendProfile(friendId);
  if (!p) return;
  const client = getSupabaseClient();
  let statsHtml = '<div class="fr-profile-stats-empty">暂无学习数据</div>';
  let topHtml = '';
  if (client) {
    try {
      const { data, error } = await client.from('study_stats')
        .select('*').eq('user_id', friendId).order('date', { ascending: false }).limit(7);
      if (!error && data && data.length > 0) {
        const totalFocus = data.reduce((s, r) => s + (r.focus_ms || 0), 0);
        const totalDone = data.reduce((s, r) => s + (r.todos_done || 0), 0);
        const checkins = data.filter(r => r.checkin).length;
        const today = data[0];
        statsHtml = `
          <div class="fr-profile-stats">
            <div class="fr-profile-stat"><div class="fr-profile-stat-num">${checkins}<span>/7</span></div><div class="fr-profile-stat-label">7日打卡</div></div>
            <div class="fr-profile-stat"><div class="fr-profile-stat-num">${friendsFormatDuration(totalFocus)}</div><div class="fr-profile-stat-label">7日专注</div></div>
            <div class="fr-profile-stat"><div class="fr-profile-stat-num">${totalDone}</div><div class="fr-profile-stat-label">7日完成</div></div>
          </div>
          ${today && today.streak ? `<div class="fr-profile-streak">🔥 连续学习 ${today.streak} 天</div>` : ''}`;
      }
    } catch (e) {}
    // 本周专注 Top5 待办
    if (!window._weeklyFocusTodosMissing) {
      try {
        const weekStart = (typeof friendsWeekStart === 'function') ? friendsWeekStart() : '';
        const { data, error } = await client.from('weekly_focus_todos')
          .select('title, focus_ms').eq('user_id', friendId).eq('week_start', weekStart)
          .order('focus_ms', { ascending: false }).limit(5);
        if (!error && data && data.length > 0) {
          topHtml = `
            <div class="fr-profile-section-title">本周专注 Top${data.length} 待办</div>
            <div class="fr-profile-toplist">
              ${data.map((t, i) => `
                <div class="fr-profile-top-item">
                  <span class="fr-profile-top-rank">${i + 1}</span>
                  <span class="fr-profile-top-title">${escapeHtml(t.title)}</span>
                  <span class="fr-profile-top-time">${friendsFormatDuration(t.focus_ms)}</span>
                </div>`).join('')}
            </div>`;
        }
      } catch (e) {
        if (e.message && /(404|Not Found|does not exist|relation.*does not exist)/i.test(String(e.message))) {
          window._weeklyFocusTodosMissing = true;
          console.warn('[Friends] weekly_focus_todos 表不存在，已跳过后续查询。请在 Supabase SQL Editor 执行 supabase/schema.sql 建表。');
        }
      }
    }
  }
  document.getElementById('editModalTitle').innerHTML = '<i data-lucide="user" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> 好友资料';
  document.getElementById('editModalBody').innerHTML = `
    <div class="fr-profile-head">
      ${friendsAvatarHtml(p, 56)}
      <div class="fr-profile-info">
        <div class="fr-profile-name">${escapeHtml(p.nickname || p.username)}</div>
        <div class="fr-profile-user">@${escapeHtml(p.username)}</div>
        ${p.bio ? `<div class="fr-profile-bio">${escapeHtml(p.bio)}</div>` : ''}
      </div>
    </div>
    <div class="fr-profile-section-title">最近学习</div>
    ${statsHtml}
    ${topHtml}
  `;
  editModalOpen = true;
  document.getElementById('editModal').classList.add('open');
  initFriendsLucide();
}

// 删除好友
function frRemoveFriend(friendId) {
  const p = friendsGetFriendProfile(friendId);
  showCustomConfirm(`确定删除好友「${p ? (p.nickname || p.username) : ''}」吗？删除后将看不到彼此的动态与聊天。`, {
    dontAskKey: 'study_dontask_remove_friend'
  }).then(async confirmed => {
    if (!confirmed) return;
    const res = await friendsRemove(friendId);
    if (!res.ok) { showCustomConfirm(res.error); return; }
    // 清理缓存
    const convId = friendsConversations[friendId];
    if (convId) delete friendsMessages[convId];
    delete friendsConversations[friendId];
    delete friendsUnread[friendId];
    await friendsLoadAll();
    friendsMainView = 'feed';
    friendsChatFriendId = null;
    renderFriendsHome();
    renderFriendsSidebar();
  });
}

// ═══════════════ 订阅所有好友会话（进入页面时） ═══════════════
async function friendsSubscribeAllConversations() {
  const me = friendsAuthUser;
  if (!me) return;
  // 为每个好友创建/获取会话并订阅
  for (const f of friendsListCache) {
    const convId = await friendsGetOrCreateConversation(f.profile.id);
    if (convId) {
      friendsSubscribeConversation(convId, f.profile.id);
    }
  }
}
