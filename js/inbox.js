// ═══════════════════════════════════════════════
//  Inbox Assistant（消息收件箱）：邮箱 IMAP / 窗口长截图 / 文件目录收集 / AI 概括
// ═══════════════════════════════════════════════
// 依赖：settings.js（getEffectiveApiConfig / loadApiKeys / getActiveApiKeyId）、
//       ai-api.js（callAiApi / buildDeepThinkParams）、ai-attach.js（isKimiModel）、utils.js（escapeHtml）
// 存储键：
//   study_inbox_messages   消息数组（保留最近 MAX_MESSAGES 条）
//   study_mail_accounts    邮箱账号配置
//   study_inbox_watch_dirs 监控目录列表
//   study_inbox_watch_last 最近一次目录扫描时间（毫秒）

window.Inbox = (function () {
  const MSG_KEY = 'study_inbox_messages';
  const MAIL_KEY = 'study_mail_accounts';
  const WATCH_KEY = 'study_inbox_watch_dirs';
  const LAST_SCAN_KEY = 'study_inbox_watch_last';
  const MAX_MESSAGES = 200;

  const CHANNEL_META = {
    mail:   { icon: 'mail',         label: '邮箱',  color: '#4f6ef7' },
    wechat: { icon: 'message-circle', label: '微信', color: '#10b981' },
    qq:     { icon: 'message-square', label: 'QQ',   color: '#f59e0b' },
    file:   { icon: 'file-text',    label: '文件',  color: '#8b5cf6' },
    manual: { icon: 'clipboard',    label: '手动',  color: '#6b7280' }
  };

  // ── 状态 ──
  let messages = [];
  let mailAccounts = [];
  let watchDirs = [];
  let filter = 'all';          // all | mail | wechat | qq | file | manual
  let expandedIds = new Set(); // 已展开查看原文的消息 id
  let expandedSenders = new Set(); // 已展开的发件人聚合组 key
  let summarizing = {};        // id -> true（概括进行中）
  let _inboxModal = null;
  let _pickImportModeResolve = null; // 导入模式选择 Modal 的 resolve 回调
  let _pasteChannel = 'wechat'; // 粘贴导入的渠道
  // 区块折叠状态：filters=筛选行, actions=操作按钮行, mail=邮箱卡, watch=目录监控卡
  let _inboxCollapsed = { filters: false, actions: false, mail: false, watch: false };
  // QQ 聊天记录子视图：_chatView=会话内{chatId,loadFrom}，_chatListOpen=会话列表
  let _chatView = null;
  let _chatListOpen = false;
  let _chatSummarizing = {};   // chatId -> true（会话总结进行中）
  let _chatCardExpand = {};    // chatId -> true（会话卡片总结已展开）
  let _chatDailyOpen = {};     // date -> true（某天日报已展开）
  let _chatDailyIdx = 0;       // 当前显示的日报索引（翻页用）
  let _chatDailyCollapsed = {}; // chatId -> true（日报区折叠）
  let _chatScrollPos = 0;      // 消息区滚动位置（重绘后恢复）
  let _chatJumpTarget = null;  // 待跳转目标：{ order: Number } 或 { keyword: String }

  // ── 存储 ──
  function loadJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch (e) { return fallback; }
  }
  function saveMessages() {
    try { localStorage.setItem(MSG_KEY, JSON.stringify(messages.slice(0, MAX_MESSAGES))); } catch (e) {}
  }
  function saveMailAccounts() {
    try { localStorage.setItem(MAIL_KEY, JSON.stringify(mailAccounts)); } catch (e) {}
  }
  function saveWatchDirs() {
    try { localStorage.setItem(WATCH_KEY, JSON.stringify(watchDirs)); } catch (e) {}
  }

  // ── 工具 ──
  function esc(s) { return (typeof escapeHtml === 'function') ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s); }
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function truncate(text, n) {
    const s = String(text || '');
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function isElectronEnv() {
    return !!(window.electronAPI && window.electronAPI.isElectron);
  }

  // ── 消息 CRUD ──
  function addMessage(msg) {
    // 去重：邮箱按 mailKey，文件按 filePath，其余直接添加
    if (msg.channel === 'mail' && msg.mailKey) {
      if (messages.some(m => m.mailKey === msg.mailKey)) return null;
    }
    if (msg.channel === 'file' && msg.filePath) {
      if (messages.some(m => m.channel === 'file' && m.filePath === msg.filePath)) return null;
    }
    if (typeof genId === 'function') msg.id = genId();
    else msg.id = Date.now();
    msg.createdAt = new Date().toISOString();
    messages.unshift(msg);
    if (messages.length > MAX_MESSAGES) messages = messages.slice(0, MAX_MESSAGES);
    saveMessages();
    return msg;
  }
  function deleteMessage(id) {
    messages = messages.filter(m => m.id !== id);
    expandedIds.delete(id);
    saveMessages();
  }
  function updateMessage(msg) {
    const idx = messages.findIndex(m => m.id === msg.id);
    if (idx >= 0) { messages[idx] = msg; saveMessages(); }
  }

  // ── 主渲染入口 ──
  function render() {
    const root = document.getElementById('inboxApp');
    if (!root) return;
    root.innerHTML = `
      <div class="inbox-toolbar">
        <div class="inbox-toolbar-row inbox-toolbar-filters">
          <div class="inbox-filter-pills ${_inboxCollapsed.filters ? 'collapsed' : ''}">
            ${['all','mail','wechat','qq','file','manual'].map(c => {
              const meta = CHANNEL_META[c] || { label: c };
              if (c === 'qq') {
                // 第一行「QQ」按钮 = 进入 QQ 聊天记录浏览器（导入的聊天记录）
                return `<button class="inbox-pill ${_chatListOpen && !_chatView ? 'active' : ''}" onclick="Inbox.openChatList()">QQ</button>`;
              }
              return `<button class="inbox-pill ${filter === c ? 'active' : ''}" onclick="Inbox.setFilter('${c}')">${c === 'all' ? '全部' : meta.label}</button>`;
            }).join('')}
          </div>
          <button class="inbox-collapse-btn" onclick="Inbox.toggleInboxCollapse('filters')" title="折叠/展开筛选行"><i data-lucide="${_inboxCollapsed.filters ? 'chevron-down' : 'chevron-up'}" style="width:13px;height:13px;"></i></button>
        </div>
        <div class="inbox-toolbar-row inbox-toolbar-actions ${_inboxCollapsed.actions ? 'collapsed' : ''}">
          <button class="inbox-btn inbox-btn-primary" onclick="Inbox.openMailConfig()"><i data-lucide="mail" style="width:14px;height:14px;vertical-align:middle;"></i> 邮箱</button>
          <button class="inbox-btn" onclick="Inbox.openImportModal()"><i data-lucide="camera" style="width:14px;height:14px;vertical-align:middle;"></i> 截图导入</button>
          <button class="inbox-btn" onclick="Inbox.openPasteModal()"><i data-lucide="clipboard-paste" style="width:14px;height:14px;vertical-align:middle;"></i> 粘贴文本</button>
          <button class="inbox-btn" onclick="document.getElementById('inboxFileInput').click()"><i data-lucide="folder-plus" style="width:14px;height:14px;vertical-align:middle;"></i> 导入文件</button>
          <button class="inbox-btn" onclick="Inbox.openWatchModal()"><i data-lucide="folder-search" style="width:14px;height:14px;vertical-align:middle;"></i> 目录监控</button>
          <button class="inbox-btn" onclick="Inbox.importQQChatJsonl()" title="导入 qq-chat-exporter 流式导出的 JSONL 文件夹（manifest.json + chunks/）"><i data-lucide="folder-down" style="width:14px;height:14px;vertical-align:middle;"></i> 导入 JSONL 文件夹</button>
          <button class="inbox-btn inbox-btn-primary" style="background:linear-gradient(135deg,#f59e0b,#ef8a2c);border-color:transparent;" onclick="document.getElementById('inboxQQChatInput').click()" title="导入 qq-chat-exporter 导出的 JSON 文件"><i data-lucide="message-square" style="width:14px;height:14px;vertical-align:middle;"></i> 导入 QQ 聊天</button>
          <button class="inbox-collapse-btn" onclick="Inbox.toggleInboxCollapse('actions')" title="折叠/展开操作按钮"><i data-lucide="${_inboxCollapsed.actions ? 'chevron-down' : 'chevron-up'}" style="width:13px;height:13px;"></i></button>
        </div>
        <input type="file" id="inboxFileInput" multiple style="display:none;" accept=".txt,.md,.markdown,.json,.js,.mjs,.ts,.jsx,.tsx,.py,.java,.c,.cpp,.h,.cs,.go,.rs,.rb,.php,.swift,.kt,.sql,.html,.htm,.css,.xml,.yaml,.yml,.toml,.ini,.cfg,.log,.csv,.tsv,.sh,.bat,.ps1,.png,.jpg,.jpeg,.gif,.webp,.bmp" onchange="Inbox.importFiles(this)">
        <input type="file" id="inboxQQChatInput" accept=".json,application/json" style="display:none;" onchange="Inbox.importQQChat(this)">
        <input type="file" id="inboxQQChatJsonlInput" multiple accept=".json,.jsonl,application/json,application/jsonl" style="display:none;" onchange="Inbox.importQQChatJsonlFiles(this)">
        <span class="inbox-hint" id="inboxQQHint" style="align-self:center;"></span>
      </div>

      <!-- 邮箱状态卡 + 目录监控卡（各自可折叠） -->
      <div class="inbox-status-row">
        <div class="inbox-status-card" id="inboxMailCard"></div>
        <div class="inbox-status-card" id="inboxWatchCard"></div>
      </div>

      <!-- 消息列表 -->
      <div class="inbox-msg-list" id="inboxMsgList"></div>
    `;
    renderMailCard();
    renderWatchCard();
    renderInboxArea();
    if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
  }

  // ── 收件箱区域渲染分发：QQ 聊天子视图（会话列表/会话内消息流）或普通消息列表 ──
  function renderInboxArea() {
    if (typeof window.QQChats === 'undefined') { renderMessages(); return; }
    if (_chatView) { renderChatView(); return; }
    if (_chatListOpen) { renderChatList(); return; }
    renderMessages();
  }

  // ── 邮箱状态卡 ──
  function getMailAccount() { return mailAccounts[0] || null; }
  function renderMailCard() {
    const el = document.getElementById('inboxMailCard');
    if (!el) return;
    const acc = getMailAccount();
    const collapsed = _inboxCollapsed.mail;
    const body = collapsed ? `
      <div class="inbox-status-icon" style="background:rgba(79,110,247,0.12);color:#4f6ef7;"><i data-lucide="mail" style="width:16px;height:16px;"></i></div>
      <div class="inbox-status-body">
        <div class="inbox-status-title">邮箱 ${acc ? '· ' + esc(acc.user) : '未配置'}</div>
      </div>` : (acc ? `
      <div class="inbox-status-icon" style="background:rgba(79,110,247,0.12);color:#4f6ef7;"><i data-lucide="mail" style="width:18px;height:18px;"></i></div>
      <div class="inbox-status-body">
        <div class="inbox-status-title">邮箱 · <span style="color:var(--primary)">${esc(acc.user)}</span></div>
        <div class="inbox-status-sub">${esc(acc.host || '')}${acc.secure ? ' · SSL' : ''}</div>
      </div>
      <div class="inbox-status-actions">
        <button class="inbox-btn inbox-btn-sm" onclick="Inbox.fetchMails()"><i data-lucide="refresh-cw" style="width:13px;height:13px;"></i> 拉取</button>
        <button class="inbox-btn inbox-btn-sm" onclick="Inbox.openMailConfig()">配置</button>
      </div>` : `
      <div class="inbox-status-icon" style="background:rgba(79,110,247,0.12);color:#4f6ef7;"><i data-lucide="mail-open" style="width:18px;height:18px;"></i></div>
      <div class="inbox-status-body">
        <div class="inbox-status-title">邮箱未配置</div>
        <div class="inbox-status-sub">通过 IMAP 自动接收邮件（需开启邮箱的 IMAP 服务并获取授权码）</div>
      </div>
      <div class="inbox-status-actions">
        <button class="inbox-btn inbox-btn-primary inbox-btn-sm" onclick="Inbox.openMailConfig()">配置邮箱</button>
      </div>`);
    el.innerHTML = body + `
      <button class="inbox-collapse-btn inbox-collapse-btn-float" onclick="Inbox.toggleInboxCollapse('mail')" title="${collapsed ? '展开邮箱状态' : '折叠邮箱状态'}"><i data-lucide="${collapsed ? 'chevron-down' : 'chevron-up'}" style="width:13px;height:13px;"></i></button>`;
    if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
  }

  // ── 目录监控卡 ──
  function renderWatchCard() {
    const el = document.getElementById('inboxWatchCard');
    if (!el) return;
    const lastScan = localStorage.getItem(LAST_SCAN_KEY);
    const lastTxt = lastScan ? fmtTime(new Date(Number(lastScan)).toISOString()) : '尚未扫描';
    const collapsed = _inboxCollapsed.watch;
    const body = collapsed ? `
      <div class="inbox-status-icon" style="background:rgba(139,92,246,0.12);color:#8b5cf6;"><i data-lucide="folder-search" style="width:16px;height:16px;"></i></div>
      <div class="inbox-status-body">
        <div class="inbox-status-title">文件目录监控 · ${watchDirs.length} 个目录</div>
      </div>` : `
      <div class="inbox-status-icon" style="background:rgba(139,92,246,0.12);color:#8b5cf6;"><i data-lucide="folder-search" style="width:18px;height:18px;"></i></div>
      <div class="inbox-status-body">
        <div class="inbox-status-title">文件目录监控 · <span style="color:#8b5cf6">${watchDirs.length} 个目录</span></div>
        <div class="inbox-status-sub">自动收集微信 / QQ 保存到本地的文件，最后扫描 ${esc(lastTxt)}</div>
      </div>
      <div class="inbox-status-actions">
        <button class="inbox-btn inbox-btn-sm" onclick="Inbox.scanWatchDirs(true)"><i data-lucide="refresh-cw" style="width:13px;height:13px;"></i> 扫描</button>
        <button class="inbox-btn inbox-btn-sm" onclick="Inbox.openWatchModal()">管理</button>
      </div>`;
    el.innerHTML = body + `
      <button class="inbox-collapse-btn inbox-collapse-btn-float" onclick="Inbox.toggleInboxCollapse('watch')" title="${collapsed ? '展开目录监控状态' : '折叠目录监控状态'}"><i data-lucide="${collapsed ? 'chevron-down' : 'chevron-up'}" style="width:13px;height:13px;"></i></button>`;
    if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
  }

  // ── 发件人聚合工具 ──
  // 提取发件人邮箱地址作为聚合 key（无地址时退回整串文本）
  function senderKey(from) {
    const s = String(from || '');
    let m = s.match(/<([^<>@\s]+@[^<>\s]+)>/);
    if (m) return m[1].toLowerCase();
    m = s.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
    if (m) return m[0].toLowerCase();
    return s.trim() || '未知发件人';
  }
  // 提取显示名：优先取 "名称 <地址>" 中的名称
  function senderName(from) {
    const s = String(from || '');
    const m = s.match(/^(.*?)<[^<>]+>\s*$/);
    if (m && m[1].trim()) return m[1].trim();
    return s.trim() || '未知发件人';
  }

  // ── 消息列表（邮箱按发件人聚合，其他渠道保持单条）──
  function renderMessages() {
    const el = document.getElementById('inboxMsgList');
    if (!el) return;
    const list = filter === 'all' ? messages : messages.filter(m => m.channel === filter);
    if (list.length === 0) {
      el.innerHTML = `<div class="inbox-empty">
        <i data-lucide="inbox" style="width:56px;height:56px;opacity:0.35;display:block;margin:0 auto 12px;"></i>
        <p>${filter === 'all' ? '收件箱空空如也，点击上方按钮导入第一条消息 ✨' : '该渠道暂无消息'}</p>
      </div>`;
      if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
      return;
    }
    // 邮箱按发件人分组，其他渠道单条
    const groups = new Map();
    const singles = [];
    for (const m of list) {
      if (m.channel === 'mail') {
        const key = senderKey(m.from);
        if (!groups.has(key)) groups.set(key, { key, name: senderName(m.from), mails: [] });
        groups.get(key).mails.push(m);
      } else {
        singles.push(m);
      }
    }
    // 组内最新在前、组之间按最新邮件时间排序
    const groupArr = Array.from(groups.values());
    for (const g of groupArr) g.mails.sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt));
    groupArr.sort((a, b) => new Date(b.mails[0].date || b.mails[0].createdAt) - new Date(a.mails[0].date || a.mails[0].createdAt));
    // 与单条消息混合，全局按时间倒序
    const items = [];
    for (const g of groupArr) items.push({ time: new Date(g.mails[0].date || g.mails[0].createdAt), html: renderMailGroup(g) });
    for (const m of singles) items.push({ time: new Date(m.date || m.createdAt), html: renderMsgCard(m) });
    items.sort((a, b) => b.time - a.time);
    el.innerHTML = items.map(i => i.html).join('');
    if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
  }

  // 单条消息卡片（非邮箱渠道）
  function renderMsgCard(m) {
    const meta = CHANNEL_META[m.channel] || CHANNEL_META.manual;
    const expanded = expandedIds.has(m.id);
    const isImg = m.imagePath || m.kind === 'image';
    const bodyPreview = truncate((m.body || '').replace(/\s+/g, ' '), expanded ? 4000 : 180);
    return `
    <div class="inbox-msg-card">
      <div class="inbox-msg-avatar" style="background:${meta.color}1f;color:${meta.color};">
        <i data-lucide="${meta.icon}" style="width:18px;height:18px;"></i>
      </div>
      <div class="inbox-msg-main">
        <div class="inbox-msg-head">
          <span class="inbox-msg-from">${esc(m.from || meta.label)}</span>
          <span class="inbox-msg-date">${fmtTime(m.date || m.createdAt)}</span>
        </div>
        ${m.subject ? `<div class="inbox-msg-subject">${esc(m.subject)}</div>` : ''}
        ${isImg && m.imagePath ? `<button class="inbox-img-thumb-btn" onclick="Inbox.previewImage(${m.id})"><i data-lucide="image" style="width:13px;height:13px;"></i> 查看截图（${m.screens ? m.screens + ' 屏' : '长图'}）</button>` : ''}
        ${m.fileName ? `<div class="inbox-msg-file-tag"><i data-lucide="paperclip" style="width:12px;height:12px;"></i> ${esc(m.fileName)}</div>` : ''}
        ${m.body ? `<div class="inbox-msg-body ${expanded ? 'expanded' : ''}">${expanded ? esc(m.body) : esc(bodyPreview)}</div>` : ''}
        ${m.body && m.body.length > 180 ? `<button class="inbox-toggle-btn" onclick="Inbox.toggleExpand(${m.id})">${expanded ? '收起' : '展开原文'}</button>` : ''}
        ${renderSummaryBlock(m)}
      </div>
      <div class="inbox-msg-actions">
        <button class="inbox-icon-btn" onclick="Inbox.summarize(${m.id})" title="AI 概括"><i data-lucide="sparkles" style="width:14px;height:14px;"></i></button>
        <button class="inbox-icon-btn danger" onclick="Inbox.removeMessage(${m.id})" title="删除"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>
      </div>
    </div>`;
  }

  // 发件人聚合组卡片
  function renderMailGroup(g) {
    const expanded = expandedSenders.has(g.key);
    const latest = g.mails[0];
    const keyEnc = encodeURIComponent(g.key);
    const itemsHtml = expanded ? g.mails.map(m => renderMailItem(m)).join('') : '';
    return `
    <div class="inbox-msg-card inbox-mail-group">
      <div class="inbox-msg-avatar" style="background:rgba(79,110,247,0.12);color:#4f6ef7;">
        <i data-lucide="mail" style="width:18px;height:18px;"></i>
      </div>
      <div class="inbox-msg-main">
        <div class="inbox-mail-group-head" onclick="Inbox.toggleMailGroup('${keyEnc}')">
          <div class="inbox-mail-group-title">
            <span class="inbox-msg-from">${esc(g.name)}</span>
            <span class="inbox-mail-group-count">${g.mails.length} 封</span>
          </div>
          <span class="inbox-msg-date">${fmtTime(latest.date || latest.createdAt)}</span>
          <i data-lucide="${expanded ? 'chevron-up' : 'chevron-down'}" class="inbox-mail-group-chevron"></i>
        </div>
        <div class="inbox-mail-group-sub">${esc(latest.subject || '(无主题)')}</div>
        ${itemsHtml}
      </div>
      <div class="inbox-msg-actions">
        <button class="inbox-icon-btn" onclick="Inbox.summarizeGroup('${keyEnc}')" title="AI 概括整组"><i data-lucide="sparkles" style="width:14px;height:14px;"></i></button>
        <button class="inbox-icon-btn danger" onclick="Inbox.deleteMailGroup('${keyEnc}')" title="删除整组"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>
      </div>
    </div>`;
  }

  // 聚合组内的单封邮件
  function renderMailItem(m) {
    const expanded = expandedIds.has(m.id);
    const bodyPreview = truncate((m.body || '').replace(/\s+/g, ' '), expanded ? 4000 : 180);
    return `
    <div class="inbox-mail-item">
      <div class="inbox-msg-head">
        <span class="inbox-msg-subject">${esc(m.subject || '(无主题)')}</span>
        <span class="inbox-msg-date">${fmtTime(m.date || m.createdAt)}</span>
      </div>
      ${m.body ? `<div class="inbox-msg-body ${expanded ? 'expanded' : ''}">${expanded ? esc(m.body) : esc(bodyPreview)}</div>` : ''}
      ${m.body && m.body.length > 180 ? `<button class="inbox-toggle-btn" onclick="Inbox.toggleExpand(${m.id})">${expanded ? '收起' : '展开原文'}</button>` : ''}
      ${renderSummaryBlock(m)}
      <div class="inbox-mail-item-actions">
        <button class="inbox-icon-btn" onclick="Inbox.summarize(${m.id})" title="AI 概括"><i data-lucide="sparkles" style="width:13px;height:13px;"></i></button>
        <button class="inbox-icon-btn danger" onclick="Inbox.removeMessage(${m.id})" title="删除"><i data-lucide="trash-2" style="width:13px;height:13px;"></i></button>
      </div>
    </div>`;
  }

  // ── AI 概括块（三态：加载中 / 成功摘要 / 失败重试）──
  function renderSummaryBlock(m) {
    if (summarizing[m.id]) {
      return `<div class="inbox-summary loading">
        <div class="inbox-spinner"></div><span>AI 正在概括…</span>
      </div>`;
    }
    if (m.summaryError) {
      return `<div class="inbox-summary error"><i data-lucide="alert-circle" style="width:13px;height:13px;flex-shrink:0;"></i>
        <span>${esc(m.summaryError)}</span>
        <button class="inbox-retry-btn" onclick="Inbox.summarize(${m.id})"><i data-lucide="refresh-cw" style="width:11px;height:11px;"></i> 重试</button></div>`;
    }
    if (m.summary) {
      return `<div class="inbox-summary done"><span class="inbox-summary-label"><i data-lucide="sparkles" style="width:12px;height:12px;"></i> AI 概括</span>
        <div class="inbox-summary-text">${esc(m.summary)}</div></div>`;
    }
    return `<button class="inbox-summarize-btn" onclick="Inbox.summarize(${m.id})"><i data-lucide="sparkles" style="width:12px;height:12px;vertical-align:middle;"></i> AI 概括</button>`;
  }

  // ── AI 概括核心（复用 callAiApi）──
  async function summarize(id) {
    const msg = messages.find(m => m.id === id);
    if (!msg || summarizing[id]) return;
    const apiCfg = (typeof getEffectiveApiConfig === 'function') ? getEffectiveApiConfig() : null;
    if (!apiCfg || !apiCfg.apiKey) {
      msg.summaryError = '未配置 API Key，请先在设置中添加';
      updateMessage(msg); renderMessages(); return;
    }
    summarizing[id] = true;
    delete msg.summary; delete msg.summaryError;
    updateMessage(msg); renderMessages();

    const isVision = (typeof isKimiModel === 'function') && isKimiModel();
    const systemPrompt = '你是一个高效的信息概括助手。请用简洁的中文概括以下邮件/聊天/文件内容的要点：\n' +
      '1. 先一句话总结核心内容；\n2. 再分点列出关键信息（事项、截止时间、需要回复/处理的内容）；\n' +
      '3. 如有需要行动的事项，单独列出「待办」。\n' +
      '用 Markdown 列表呈现，控制在 200 字以内。';

    try {
      let resultText = '';
      const isImg = (msg.kind === 'image') || !!msg.imagePath;
      if (isImg) {
        // 截图 / 图片：需要视觉模型内联 base64
        if (!isVision) {
          throw new Error('当前模型不支持图片，请切换到视觉模型（如 Kimi）后再概括截图');
        }
        const imgPath = msg.imagePath || msg.filePath;
        if (!imgPath) throw new Error('找不到图片路径，无法概括');
        const imgRes = await window.electronAPI.captureReadImage(imgPath);
        if (!imgRes.ok) throw new Error(imgRes.reason || '读取图片失败');
        const apiMessages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: [
            { type: 'text', text: msg.imagePath ? '请概括这张聊天/邮件截图中的内容要点。' : '请概括这张图片的内容要点。' },
            { type: 'image_url', image_url: { url: imgRes.dataUrl } }
          ]}
        ];
        const res = await callAiApi(apiMessages, apiCfg, null);
        resultText = res.cleanText || '（未收到回复）';
      } else {
        // 文本概括（邮件 / 粘贴 / 文本文件）
        const content = (msg.body || msg.fileContent || '（无内容）').slice(0, 80000);
        const apiMessages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: '【' + (msg.subject || msg.fileName || '消息') + '】\n\n' + content }
        ];
        const res = await callAiApi(apiMessages, apiCfg, null);
        resultText = res.cleanText || '（未收到回复）';
      }
      msg.summary = resultText.trim();
      delete msg.summaryError;
    } catch (e) {
      msg.summaryError = String((e && e.message) || e);
    }
    delete summarizing[id];
    updateMessage(msg);
    renderMessages();
  }

  // ── 邮箱配置 / 测试 / 拉取 ──
  function openMailConfig() {
    const acc = getMailAccount() || {};
    const body = `
      <div class="inbox-form-row">
        <label>邮箱账号（完整地址）</label>
        <input id="inboxMailUser" placeholder="user@example.com" value="${esc(acc.user || '')}">
      </div>
      <div class="inbox-form-row">
        <label>IMAP 授权码 / 密码</label>
        <input id="inboxMailPass" type="password" placeholder="授权码（非登录密码）" value="${esc(acc.pass || '')}">
        <span class="inbox-hint">QQ邮箱 / 163 等需在邮箱设置开启 IMAP 并获取授权码</span>
      </div>
      <div class="inbox-form-grid">
        <div class="inbox-form-row">
          <label>服务器 Host</label>
          <input id="inboxMailHost" placeholder="imap.qq.com" value="${esc(acc.host || '')}">
        </div>
        <div class="inbox-form-row">
          <label>端口（留空自动）</label>
          <input id="inboxMailPort" type="number" placeholder="993" value="${acc.port || ''}">
        </div>
      </div>
      <div class="inbox-form-row" style="margin-top:6px;">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <input type="checkbox" id="inboxMailSecure" style="width:16px;height:16px;accent-color:var(--primary);" ${acc.secure ? 'checked' : ''}>
          使用 SSL（推荐，端口 993）
        </label>
      </div>
      <div class="inbox-form-row">
        <label>拉取数量</label>
        <input id="inboxMailLimit" type="number" min="1" max="50" value="${acc.limit || 20}">
      </div>
      <div class="inbox-status" id="inboxMailStatus"></div>
      <div class="inbox-form-actions">
        <button class="inbox-btn" onclick="Inbox.testMail()"><i data-lucide="plug" style="width:13px;height:13px;vertical-align:middle;"></i> 测试连接</button>
        <button class="inbox-btn inbox-btn-primary" onclick="Inbox.saveMailConfig()">保存</button>
      </div>`;
    showInboxModal({ title: '<i data-lucide="mail" style="width:16px;height:16px;vertical-align:middle;"></i> 邮箱配置', body });
    document.getElementById('inboxMailUser').focus();
  }

  function collectMailForm() {
    return {
      user: (document.getElementById('inboxMailUser') || {}).value || '',
      pass: (document.getElementById('inboxMailPass') || {}).value || '',
      host: (document.getElementById('inboxMailHost') || {}).value || '',
      port: Number((document.getElementById('inboxMailPort') || {}).value) || 0,
      secure: !!(document.getElementById('inboxMailSecure') || {}).checked,
      limit: Number((document.getElementById('inboxMailLimit') || {}).value) || 20
    };
  }
  function setMailStatus(text, cls) {
    const el = document.getElementById('inboxMailStatus');
    if (el) { el.textContent = text; el.className = 'inbox-status ' + (cls || 'info'); }
  }

  async function testMail() {
    if (!isElectronEnv()) { setMailStatus('此功能仅 Electron 桌面版可用', 'error'); return; }
    const cfg = collectMailForm();
    if (!cfg.host || !cfg.user || !cfg.pass) { setMailStatus('请填写完整的邮箱配置', 'error'); return; }
    setMailStatus('正在测试连接…', 'info');
    try {
      const res = await window.electronAPI.inboxMailTest(cfg);
      setMailStatus(res.ok ? '✅ ' + (res.message || '连接成功') : '❌ ' + (res.message || '连接失败'), res.ok ? 'ok' : 'error');
    } catch (e) {
      setMailStatus('❌ ' + (e.message || e), 'error');
    }
  }

  async function saveMailConfig() {
    const cfg = collectMailForm();
    if (!cfg.host || !cfg.user || !cfg.pass) { setMailStatus('请填写完整的邮箱配置', 'error'); return; }
    mailAccounts = [cfg];
    saveMailAccounts();
    closeInboxModal();
    renderMailCard();
    renderMessages();
  }

  async function fetchMails() {
    if (!isElectronEnv()) { alert('此功能仅 Electron 桌面版可用'); return; }
    const acc = getMailAccount();
    if (!acc) { openMailConfig(); return; }
    const btn = event && event.target;
    try {
      if (btn) btn.disabled = true;
      const res = await window.electronAPI.inboxMailFetch(acc);
      if (!res.ok) { alert('拉取失败：' + (res.reason || '未知错误')); if (btn) btn.disabled = false; return; }
      let added = 0, skipped = 0;
      for (const mail of res.mails || []) {
        // 去重键包含账号维度（同一 host 可配置多个不同账号，避免 UID 撞 key 误判为重复）
        const key = (acc.user || '') + '@' + (acc.host || '') + '|' + (mail.id || 0);
        const created = addMessage({
          channel: 'mail',
          mailKey: key,
          from: mail.from,
          subject: mail.subject,
          body: mail.body,
          date: mail.date,
          kind: 'text'
        });
        if (created) added++; else skipped++;
      }
      if (btn) btn.disabled = false;
      if (added === 0) alert('没有新邮件（已是最新）' + (skipped > 0 ? '，跳过 ' + skipped + ' 封已导入' : ''));
      renderMessages();
    } catch (e) {
      if (btn) btn.disabled = false;
      alert('拉取失败：' + (e.message || e));
    }
  }

  // ── 截图导入 ──
  function openImportModal() {
    const body = `
      <div class="inbox-import-guide">
        <i data-lucide="camera" style="width:16px;height:16px;vertical-align:middle;"></i>
        在微信 / QQ 中打开要导入的聊天窗口，然后点击下方「刷新窗口」，选择对应窗口即可自动滚动长截图。
      </div>
      <div class="inbox-import-actions">
        <button class="inbox-btn inbox-btn-primary" onclick="Inbox.loadWindows()"><i data-lucide="refresh-cw" style="width:13px;height:13px;vertical-align:middle;"></i> 刷新窗口</button>
        <span class="inbox-hint" id="inboxWinCount"></span>
      </div>
      <div class="inbox-window-list" id="inboxWindowList">
        <div class="inbox-hint" style="text-align:center;padding:16px;">点击「刷新窗口」枚举当前打开的窗口</div>
      </div>
      <div id="inboxShotProgress" style="display:none;">
        <div class="inbox-summary loading"><div class="inbox-spinner"></div><span id="inboxShotText">正在长截图…</span></div>
      </div>`;
    showInboxModal({ title: '<i data-lucide="camera" style="width:16px;height:16px;vertical-align:middle;"></i> 窗口长截图导入', body, width: '620px' });
  }

  async function loadWindows() {
    if (!isElectronEnv()) { alert('此功能仅 Electron 桌面版可用'); return; }
    const listEl = document.getElementById('inboxWindowList');
    const countEl = document.getElementById('inboxWinCount');
    if (!listEl) return;
    listEl.innerHTML = '<div class="inbox-hint" style="text-align:center;padding:16px;">正在枚举窗口…</div>';
    try {
      const res = await window.electronAPI.captureListWindows();
      if (!res.ok || !res.windows || res.windows.length === 0) {
        listEl.innerHTML = '<div class="inbox-hint" style="text-align:center;padding:16px;">未找到可见窗口，请先打开微信 / QQ 聊天窗口</div>';
        return;
      }
      if (countEl) countEl.textContent = '共 ' + res.windows.length + ' 个窗口';
      listEl.innerHTML = res.windows.map(w => `
        <div class="inbox-window-item">
          <div class="inbox-window-title">${esc(w.title)}<span class="inbox-window-size">${w.w || 0}×${w.h || 0}</span></div>
          <div class="inbox-window-btns">
            <button class="inbox-btn inbox-btn-sm" style="background:rgba(16,185,129,0.12);color:#10b981;" onclick="Inbox.doLongShot(${w.hwnd}, '${esc(String(w.title).replace(/'/g, "\\'"))}', 'wechat')">微信</button>
            <button class="inbox-btn inbox-btn-sm" style="background:rgba(245,158,11,0.12);color:#f59e0b;" onclick="Inbox.doLongShot(${w.hwnd}, '${esc(String(w.title).replace(/'/g, "\\'"))}', 'qq')">QQ</button>
            <button class="inbox-btn inbox-btn-sm" onclick="Inbox.doLongShot(${w.hwnd}, '${esc(String(w.title).replace(/'/g, "\\'"))}', 'manual')">其他</button>
          </div>
        </div>`).join('');
    } catch (e) {
      listEl.innerHTML = '<div class="inbox-hint" style="text-align:center;padding:16px;">窗口枚举失败：' + esc(e.message || e) + '</div>';
    }
  }

  async function doLongShot(hwnd, title, channel) {
    if (!isElectronEnv()) { alert('此功能仅 Electron 桌面版可用'); return; }
    const progressEl = document.getElementById('inboxShotProgress');
    const textEl = document.getElementById('inboxShotText');
    if (progressEl) progressEl.style.display = 'block';
    if (textEl) textEl.textContent = '正在长截图（请保持目标窗口显示）…';
    try {
      const res = await window.electronAPI.captureLongShot({ hwnd, maxScreens: 25 });
      if (progressEl) progressEl.style.display = 'none';
      if (!res.ok) { alert('长截图失败：' + (res.reason || '未知错误')); return; }
      const created = addMessage({
        channel: channel || 'manual',
        from: title || '聊天截图',
        subject: '聊天截图',
        body: '',
        date: new Date().toISOString(),
        imagePath: res.imagePath,
        screens: res.screens,
        kind: 'image'
      });
      closeInboxModal();
      renderMessages();
      if (created) {
        const doSum = confirm('截图完成（' + res.screens + ' 屏）。是否立即用 AI 概括？');
        if (doSum) summarize(created.id);
      }
    } catch (e) {
      if (progressEl) progressEl.style.display = 'none';
      alert('长截图失败：' + (e.message || e));
    }
  }

  // ── 粘贴文本导入 ──
  function openPasteModal() {
    const body = `
      <div class="inbox-form-row">
        <label>渠道 / 来源</label>
        <div class="inbox-channel-select" id="inboxPasteChannel">
          ${['wechat','qq','manual'].map(c => {
            const meta = CHANNEL_META[c];
            return `<button class="inbox-pill ${c === _pasteChannel ? 'active' : ''}" data-ch="${c}" onclick="Inbox.selectPasteChannel('${c}')" style="border:1px solid var(--border);">${meta.label}</button>`;
          }).join('')}
        </div>
      </div>
      <div class="inbox-form-row">
        <label>会话名称 / 发件人</label>
        <input id="inboxPasteFrom" placeholder="如：张老师 / 群聊「课程通知」" value="">
      </div>
      <div class="inbox-form-row">
        <label>消息内容</label>
        <textarea id="inboxPasteBody" rows="8" placeholder="在此粘贴要概括的消息内容…" style="resize:vertical;min-height:120px;"></textarea>
      </div>
      <div class="inbox-form-actions">
        <button class="inbox-btn inbox-btn-primary" onclick="Inbox.submitPaste()"><i data-lucide="clipboard-paste" style="width:13px;height:13px;vertical-align:middle;"></i> 导入并概括</button>
      </div>`;
    showInboxModal({ title: '<i data-lucide="clipboard-paste" style="width:16px;height:16px;vertical-align:middle;"></i> 粘贴文本导入', body, width: '560px' });
  }
  function selectPasteChannel(c) {
    const chs = { wechat: 'wechat', qq: 'qq', manual: 'manual' };
    _pasteChannel = chs[c] || 'wechat';
    document.querySelectorAll('#inboxPasteChannel .inbox-pill').forEach(b => {
      b.classList.toggle('active', b.dataset.ch === c);
    });
  }
  function submitPaste() {
    const from = (document.getElementById('inboxPasteFrom') || {}).value || '手动粘贴';
    const body = (document.getElementById('inboxPasteBody') || {}).value || '';
    if (!body.trim()) { alert('请粘贴消息内容'); return; }
    const created = addMessage({
      channel: _pasteChannel || 'manual',
      from,
      subject: '粘贴的消息',
      body,
      date: new Date().toISOString(),
      kind: 'text'
    });
    closeInboxModal();
    renderMessages();
    if (created) summarize(created.id);
  }

  // ── 文件导入（拖拽 / 选择）──
  function importFiles(input) {
    const files = Array.from(input.files || []);
    input.value = '';
    importFileList(files);
  }
  async function importFileList(files) {
    for (const f of files) {
      const ext = '.' + (f.name.split('.').pop() || '').toLowerCase();
      const isImg = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext);
      let body = '';
      let fileContent = '';
      let imgPath = null;
      if (isImg && isElectronEnv()) {
        // 图片：保存到 captures 目录（避免 base64 撑爆 localStorage），后续视觉概括
        try {
          const buf = await f.arrayBuffer();
          const res = await window.electronAPI.captureSaveImage({ name: f.name, buffer: buf });
          if (res.ok) imgPath = res.path;
        } catch (e) { imgPath = null; }
      } else if (!isImg) {
        try { fileContent = await f.text(); body = fileContent.slice(0, 80000); } catch (e) { body = ''; }
      }
      const created = addMessage({
        channel: 'file',
        from: '文件',
        subject: f.name,
        body,
        fileContent,
        fileName: f.name,
        filePath: null,
        imagePath: imgPath,
        kind: isImg ? 'image' : 'text',
        date: new Date().toISOString()
      });
      renderMessages();
      if (created) summarize(created.id);
    }
  }

  // ── 目录监控 ──
  function openWatchModal() {
    const body = `
      <div class="inbox-import-guide">
        <i data-lucide="folder-search" style="width:16px;height:16px;vertical-align:middle;"></i>
        添加微信 / QQ 的文件保存目录，应用会自动扫描新增文件并导入收件箱。<br>
        <span class="inbox-hint">QQ：<code>文档\\Tencent Files\\&lt;QQ号&gt;\\FileRecv</code>　微信：<code>文档\\WeChat Files\\&lt;wxid&gt;\\FileStorage</code></span>
      </div>
      <div class="inbox-watch-list" id="inboxWatchList"></div>
      <div class="inbox-form-actions" style="justify-content:flex-start;">
        <button class="inbox-btn inbox-btn-primary" onclick="Inbox.addWatchDir()"><i data-lucide="folder-plus" style="width:13px;height:13px;vertical-align:middle;"></i> 添加目录</button>
        <button class="inbox-btn" onclick="Inbox.scanWatchDirs(true)"><i data-lucide="refresh-cw" style="width:13px;height:13px;vertical-align:middle;"></i> 立即扫描</button>
      </div>
      <div class="inbox-status" id="inboxWatchStatus"></div>`;
    showInboxModal({ title: '<i data-lucide="folder-search" style="width:16px;height:16px;vertical-align:middle;"></i> 文件目录监控', body, width: '620px' });
    renderWatchList();
  }
  function renderWatchList() {
    const el = document.getElementById('inboxWatchList');
    if (!el) return;
    if (watchDirs.length === 0) {
      el.innerHTML = '<div class="inbox-hint" style="text-align:center;padding:16px;">还没有监控目录，点击「添加目录」选择微信 / QQ 的保存文件夹</div>';
      return;
    }
    el.innerHTML = watchDirs.map(d => `
      <div class="inbox-window-item">
        <div class="inbox-window-title"><i data-lucide="folder" style="width:13px;height:13px;vertical-align:middle;"></i> ${esc(d)}</div>
        <div class="inbox-window-btns">
          <button class="inbox-btn inbox-btn-sm danger" onclick="Inbox.removeWatchDir('${esc(String(d).replace(/'/g, "\\'"))}')">移除</button>
        </div>
      </div>`).join('');
    if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
  }
  async function addWatchDir() {
    if (!isElectronEnv()) { alert('此功能仅 Electron 桌面版可用'); return; }
    const res = await window.electronAPI.capturePickDir();
    if (!res.ok || !res.dir) return;
    if (!watchDirs.includes(res.dir)) {
      watchDirs.push(res.dir);
      saveWatchDirs();
    }
    renderWatchList();
  }
  function removeWatchDir(dir) {
    watchDirs = watchDirs.filter(d => d !== dir);
    saveWatchDirs();
    renderWatchList();
  }
  function setWatchStatus(text, cls) {
    const el = document.getElementById('inboxWatchStatus');
    if (el) { el.textContent = text; el.className = 'inbox-status ' + (cls || 'info'); }
  }
  // 扫描监控目录（进入页面时自动调用；manual=true 时显示结果弹窗）
  async function scanWatchDirs(manual) {
    if (!isElectronEnv()) { if (manual) alert('此功能仅 Electron 桌面版可用'); return; }
    if (watchDirs.length === 0) { if (manual) { openWatchModal(); } return; }
    const statusEl = document.getElementById('inboxWatchStatus');
    if (statusEl) setWatchStatus('正在扫描目录…', 'info');
    const lastScan = Number(localStorage.getItem(LAST_SCAN_KEY)) || 0;
    let addedCount = 0;
    for (const dir of watchDirs) {
      try {
        const res = await window.electronAPI.captureListFiles({ dir, sinceMs: lastScan });
        if (!res.ok || !res.files) continue;
        for (const f of res.files) {
          const created = addMessage({
            channel: 'file',
            from: '文件',
            subject: f.name,
            body: '',
            filePath: f.path,
            fileName: f.name,
            kind: f.kind || 'text',
            date: f.mtime || new Date().toISOString()
          });
          if (created) {
            addedCount++;
            // 文本文件读取内容后概括
            if (f.kind === 'text') {
              try {
                const t = await window.electronAPI.captureReadFileText(f.path);
                if (t && t.ok) { created.body = t.text; updateMessage(created); }
              } catch (e) {}
            }
            summarize(created.id);
          }
        }
      } catch (e) {}
    }
    localStorage.setItem(LAST_SCAN_KEY, String(Date.now()));
    if (statusEl) setWatchStatus(addedCount > 0 ? '✅ 发现 ' + addedCount + ' 个新文件' : '✅ 没有新文件', 'ok');
    renderWatchCard();
    renderMessages();
    if (manual && addedCount > 0) { /* 已通过状态栏提示 */ }
  }

  // ── 预览截图 ──
  async function previewImage(id) {
    const msg = messages.find(m => m.id === id);
    if (!msg) return;
    const imgPath = msg.imagePath || msg.filePath;
    if (imgPath && isElectronEnv()) {
      try {
        const res = await window.electronAPI.captureReadImage(imgPath);
        // 仅允许位图 dataUrl，拒绝 SVG/HTML 等其他类型进入 DOM（防注入）
        if (res.ok && /^data:image\/(png|jpe?g|gif|webp|bmp);/i.test(res.dataUrl || '')) {
          showInboxModal({
            title: '<i data-lucide="image" style="width:16px;height:16px;vertical-align:middle;"></i> 截图预览',
            body: `<img src="${res.dataUrl}" style="max-width:100%;border-radius:8px;" onerror="this.style.display='none'">`,
            width: '700px'
          });
          return;
        }
      } catch (e) {}
    }
    alert('图片路径不可用，无法预览');
  }

  // ── QQ 聊天记录（子视图：会话列表 / 会话内消息流）──
  const CHAT_LOAD_PAGE = 200; // 每次加载的消息条数

  function chatTypeMeta(chatType) {
    if (chatType === 'group') return { label: '群聊', cls: 'chat-type-group', color: '#8b5cf6' };
    if (chatType === 'temp') return { label: '临时', cls: 'chat-type-temp', color: '#f59e0b' };
    return { label: '私聊', cls: 'chat-type-private', color: '#10b981' };
  }
  function chatTimeStr(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function chatTimeRange(start, end) {
    if (!start || !end) return '';
    return chatTimeStr(start) + ' ~ ' + chatTimeStr(end);
  }
  function chatInitial(name) {
    const s = String(name || '?').trim();
    return s ? s.slice(0, 1) : '?';
  }
  function chatIdEsc(id) {
    return String(id).replace(/'/g, "\\'");
  }

  // 导入 qq-chat-exporter JSON 文件
  // 已存在时：合并（去重追加）/ 覆盖 / 取消
  async function importQQChat(input) {
    const file = input && input.files && input.files[0];
    if (input) input.value = '';
    if (!file) return;
    if (typeof window.QQChats === 'undefined') { alert('QQ 聊天模块未加载'); return; }
    const hintEl = document.getElementById('inboxQQHint');
    const setHint = (t) => { if (hintEl) hintEl.textContent = t || ''; };
    const onProgress = (done, total) => setHint('正在导入… ' + done + '/' + total + ' 条');
    try {
      setHint('正在解析文件…');
      let res = await window.QQChats.importJsonFile(file, { onProgress });
      if (res && res.exists) {
        const mode = await pickImportMode(res.chat && res.chat.total != null ? res.chat.total : '?');
        if (mode === 'cancel') { setHint(''); return; }
        if (mode === 'merge') {
          res = await window.QQChats.importJsonFile(file, { merge: true, onProgress });
        } else {
          res = await window.QQChats.importJsonFile(file, { force: true, onProgress });
        }
      }
      setHint('');
      if (!res || !res.chatId) { alert('导入失败：未返回有效会话'); return; }
      const chat = res.chat || {};
      const extra = (res.merged && res.existingCount > 0) ? ('，跳过重复 ' + res.existingCount + ' 条') : '';
      alert('✅ 导入成功：' + (chat.name || 'QQ 会话') + (res.merged ? '（合并）' : '') + '，新增 ' + res.added + ' 条，共 ' + (chat.total != null ? chat.total : res.added) + ' 条' + extra);
      _chatListOpen = true;
      _chatView = { chatId: res.chatId, loadFrom: -1 }; // -1 表示从尾部（最新）开始加载
      renderInboxArea();
      if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
    } catch (e) {
      setHint('');
      alert('导入失败：' + ((e && e.message) || e));
    }
  }

  // 已存在会话时的导入模式选择：合并 / 覆盖 / 取消（自定义 Modal，兼容禁用 prompt 的 Electron）
  // 返回 Promise<'merge'|'overwrite'|'cancel'>
  function pickImportMode(existingTotal) {
    return new Promise(function (resolve) {
      closeInboxModal();
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.style.zIndex = '2500';
      overlay.onclick = function (e) { if (e.target === overlay) { closeInboxModal(); resolve('cancel'); } };
      overlay.innerHTML = `
        <div class="modal" style="max-width:420px;">
          <div class="modal-header">
            <span class="modal-title">导入模式选择</span>
            <button class="modal-close" onclick="Inbox.closeModal()"><i data-lucide="x" style="width:16px;height:16px;"></i></button>
          </div>
          <div class="modal-body inbox-modal-body">
            <p style="margin:0 0 12px;color:var(--text);font-size:13px;line-height:1.6;">该会话已导入过（<b>${existingTotal}</b> 条消息）。请选择导入方式：</p>
            <button class="inbox-btn" style="width:100%;justify-content:flex-start;padding:10px 14px;margin-bottom:8px;text-align:left;height:auto;line-height:1.5;" onclick="Inbox.pickImportModeResolve('merge')">
              <div>
                <div style="font-weight:600;">🔗 合并去重追加（推荐）</div>
                <div style="font-size:11px;opacity:0.75;font-weight:400;">保留旧消息，按消息 ID/内容去重，新消息追加累积</div>
              </div>
            </button>
            <button class="inbox-btn" style="width:100%;justify-content:flex-start;padding:10px 14px;margin-bottom:8px;text-align:left;height:auto;line-height:1.5;" onclick="Inbox.pickImportModeResolve('overwrite')">
              <div>
                <div style="font-weight:600;">🔄 覆盖重导</div>
                <div style="font-size:11px;opacity:0.75;font-weight:400;">清空该会话旧消息，重新导入本次数据</div>
              </div>
            </button>
            <button class="inbox-btn" style="width:100%;justify-content:flex-start;padding:10px 14px;text-align:left;height:auto;line-height:1.5;" onclick="Inbox.pickImportModeResolve('cancel')">
              <div>
                <div style="font-weight:600;">✖ 取消</div>
                <div style="font-size:11px;opacity:0.75;font-weight:400;">放弃本次导入，保留现有数据</div>
              </div>
            </button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      _inboxModal = overlay;
      _pickImportModeResolve = resolve;
      requestAnimationFrame(function () { overlay.classList.add('open'); });
      if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
    });
  }

  // Modal 按钮点击回调（全局）
  function pickImportModeResolve(mode) {
    closeInboxModal();
    if (_pickImportModeResolve) { _pickImportModeResolve(mode); _pickImportModeResolve = null; }
  }

  // ── 导入 JSONL 分块导出（qq-chat-exporter 流式导出：manifest.json + chunks/*.jsonl）──
  // Electron：选文件夹，主进程读 manifest + 所有 chunk
  async function importQQChatJsonl() {
    if (typeof window.QQChats === 'undefined') { alert('QQ 聊天模块未加载'); return; }
    const hintEl = document.getElementById('inboxQQHint');
    const setHint = (t) => { if (hintEl) hintEl.textContent = t || ''; };
    // 浏览器/PWA：无法直接选文件夹，退回多选文件
    const electron = window.electronAPI && typeof window.electronAPI.qqchatPickDir === 'function';
    if (!electron) {
      document.getElementById('inboxQQChatJsonlInput').click();
      return;
    }
    setHint('正在选择文件夹…');
    try {
      const picked = await window.electronAPI.qqchatPickDir();
      if (!picked || !picked.ok) { setHint(''); return; }
      setHint('正在读取 manifest…');
      const mres = await window.electronAPI.qqchatReadManifest(picked.dir);
      if (!mres || !mres.ok) { setHint(''); alert('读取失败：' + ((mres && mres.reason) || '未知错误')); return; }
      const chunks = mres.chunkFiles || [];
      const allMessages = [];
      for (let i = 0; i < chunks.length; i++) {
        setHint('正在读取消息分片 ' + (i + 1) + '/' + chunks.length + '…');
        const cres = await window.electronAPI.qqchatReadChunk(chunks[i]);
        if (cres && cres.ok && Array.isArray(cres.items)) {
          allMessages.push.apply(allMessages, cres.items);
        }
      }
      await finishImportChunkedJsonl(mres.manifest, allMessages, setHint);
    } catch (e) {
      setHint('');
      alert('导入失败：' + ((e && e.message) || e));
    }
  }

  // PWA/浏览器：多选文件（manifest.json + 所有 chunk .jsonl）
  async function importQQChatJsonlFiles(input) {
    const files = input && input.files ? Array.prototype.slice.call(input.files) : [];
    if (input) input.value = '';
    if (files.length === 0 || typeof window.QQChats === 'undefined') return;
    const hintEl = document.getElementById('inboxQQHint');
    const setHint = (t) => { if (hintEl) hintEl.textContent = t || ''; };
    try {
      // 找 manifest.json
      const manifestFile = files.find(f => /manifest\.json$/i.test(f.name));
      if (!manifestFile) { alert('请在所选文件中包含 manifest.json'); return; }
      setHint('正在解析 manifest…');
      const manifest = JSON.parse(await manifestFile.text());
      // 读所有 .jsonl chunk
      const chunkFiles = files.filter(f => /\.jsonl$/i.test(f.name));
      const allMessages = [];
      for (let i = 0; i < chunkFiles.length; i++) {
        setHint('正在读取消息分片 ' + (i + 1) + '/' + chunkFiles.length + '…');
        const text = await chunkFiles[i].text();
        for (const line of text.split('\n')) {
          const s = String(line).trim();
          if (!s) continue;
          try { allMessages.push(JSON.parse(s)); } catch (e) { /* 忽略损坏行 */ }
        }
      }
      await finishImportChunkedJsonl(manifest, allMessages, setHint);
    } catch (e) {
      setHint('');
      alert('导入失败：' + ((e && e.message) || e));
    }
  }

  // 完成 JSONL 导入（合并/覆盖/取消 + 写入 + 刷新）
  async function finishImportChunkedJsonl(manifest, allMessages, setHint) {
    if (!manifest || !allMessages) { setHint(''); alert('数据无效'); return; }
    let res = await window.QQChats.importChunkedJsonl(manifest, allMessages, { onProgress: (d, t) => setHint('正在写入… ' + d + '/' + t + ' 条') });
    if (res && res.exists) {
      const mode = await pickImportMode(res.chat && res.chat.total != null ? res.chat.total : '?');
      if (mode === 'cancel') { setHint(''); return; }
      const opts = { onProgress: (d, t) => setHint('正在写入… ' + d + '/' + t + ' 条') };
      if (mode === 'merge') opts.merge = true;
      else opts.force = true;
      res = await window.QQChats.importChunkedJsonl(manifest, allMessages, opts);
    }
    setHint('');
    if (!res || !res.chatId) { alert('导入失败：未返回有效会话'); return; }
    const chat = res.chat || {};
    const extra = (res.merged && res.existingCount > 0) ? ('，跳过重复 ' + res.existingCount + ' 条') : '';
    alert('✅ 导入成功：' + (chat.name || 'QQ 会话') + (res.merged ? '（合并）' : '') + '，新增 ' + res.added + ' 条，共 ' + (chat.total != null ? chat.total : res.added) + ' 条' + extra);
    _chatListOpen = true;
    _chatView = { chatId: res.chatId, loadFrom: -1 };
    renderInboxArea();
    if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
  }

  // 会话列表渲染
  function renderChatList() {
    const el = document.getElementById('inboxMsgList');
    if (!el) return;
    window.QQChats.listChats().then(chats => {
      if (_chatView || !_chatListOpen) return; // 渲染期间已被切换
      if (!chats || chats.length === 0) {
        el.innerHTML = `<div class="inbox-empty">
          <i data-lucide="message-square" style="width:56px;height:56px;opacity:0.35;display:block;margin:0 auto 12px;"></i>
          <p>尚未导入 QQ 聊天记录。点击工具栏「导入 QQ 聊天」，选择 qq-chat-exporter 导出的 JSON 文件即可按会话浏览，并让 AI 基于聊天记录回答你的问题。</p>
        </div>`;
        if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
        return;
      }
      const groups = chats.filter(c => c.chatType === 'group');
      const privates = chats.filter(c => c.chatType !== 'group');
      const section = (title, list) => list.length ? `
        <div class="chat-sec-title">${title}</div>
        ${list.map(c => renderChatCard(c)).join('')}` : '';
      el.innerHTML = section('群聊', groups) + section('私聊 / 临时', privates);
      if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
    }).catch(() => {
      el.innerHTML = `<div class="inbox-empty"><p>加载聊天记录失败</p></div>`;
    });
  }

  function renderChatCard(c) {
    const meta = chatTypeMeta(c.chatType);
    const cid = chatIdEsc(c.chatId);
    const lastText = (c.lastMessageText || '').replace(/\s+/g, ' ').trim();
    const reports = (c.dailyReports && Array.isArray(c.dailyReports)) ? c.dailyReports : [];
    const hasSummary = reports.length > 0;
    const expanded = !!_chatCardExpand[c.chatId];
    // 日报概览：显示最新一份日报的正文开头（可展开）
    let summaryHtml = '';
    if (hasSummary) {
      const latest = reports[0];
      const previewText = expanded ? latest.report : (latest.report || '').replace(/\s+/g, ' ').slice(0, 120);
      summaryHtml = `
      <div class="chat-card-summary ${expanded ? 'expanded' : ''}" onclick="Inbox.toggleChatCardSummary('${cid}')" title="${expanded ? '收起总结' : '展开完整总结'}">
        <i data-lucide="calendar-days" style="width:12px;height:12px;vertical-align:middle;flex-shrink:0;"></i>
        <span class="chat-card-summary-text">${esc(previewText)}</span>
        <span class="chat-card-summary-toggle">${expanded ? '收起 ▲' : '展开 ▼'}</span>
      </div>`;
    }
    return `
    <div class="chat-card">
      <div class="chat-avatar" style="background:${meta.color}1f;color:${meta.color};" onclick="Inbox.openChat('${cid}')">${esc(chatInitial(c.name))}</div>
      <div class="chat-card-main" onclick="Inbox.openChat('${cid}')">
        <div class="chat-card-head">
          <span class="chat-card-name">${esc(c.name || 'QQ 会话')}</span>
          <span class="chat-type-badge ${meta.cls}">${meta.label}</span>
          <span class="chat-card-count">${c.total || 0} 条</span>
        </div>
        <div class="chat-card-time">${chatTimeRange(c.timeStart, c.timeEnd)}</div>
        <div class="chat-card-preview">${lastText ? esc(lastText) : '<span style="opacity:0.5">（无文本消息）</span>'}</div>
        ${summaryHtml}
      </div>
      <div class="chat-card-actions">
        <button class="inbox-icon-btn" onclick="Inbox.chatSummarize('${cid}')" title="AI 总结该会话"><i data-lucide="sparkles" style="width:14px;height:14px;"></i></button>
        <button class="inbox-icon-btn" onclick="Inbox.openChat('${cid}')" title="打开会话"><i data-lucide="message-circle" style="width:14px;height:14px;"></i></button>
        <button class="inbox-icon-btn danger" onclick="Inbox.deleteChat('${cid}')" title="删除会话"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>
      </div>
    </div>`;
  }

  // 展开/收起会话卡片总结（阻止冒泡到打开会话）
  function toggleChatCardSummary(chatId) {
    if (_chatCardExpand[chatId]) delete _chatCardExpand[chatId];
    else _chatCardExpand[chatId] = true;
    renderChatList();
  }

  // 会话内消息流渲染（累积式：首次从尾部加载，向前扩展）
  function renderChatView() {
    const el = document.getElementById('inboxMsgList');
    if (!el || !_chatView) return;
    const chatId = _chatView.chatId;
    // 渲染前记录当前滚动位置（供重绘后恢复，避免界面刷新后跳回顶部）
    const prevScroller = el.querySelector('.chat-msgs-scroll');
    if (prevScroller) _chatScrollPos = prevScroller.scrollTop;
    window.QQChats.listChats().then(chats => {
      const c = chats.find(x => x.chatId === chatId);
      if (!c) { _chatView = null; renderChatList(); return; }
      const total = c.total || 0;
      // loadFrom === -1：首次打开，定位到尾部一页
      let loadFrom = _chatView.loadFrom;
      if (loadFrom === undefined || loadFrom === null || loadFrom < 0) {
        loadFrom = Math.max(0, total - CHAT_LOAD_PAGE);
        _chatView.loadFrom = loadFrom;
      }
      // 累积加载：从 loadFrom 取到末尾（最多一次取全部已覆盖区间）
      const limit = total - loadFrom;
      return window.QQChats.getMessages(chatId, loadFrom, limit).then(msgs => {
        if (!_chatView || _chatView.chatId !== chatId) return;
        el.innerHTML = renderChatViewHtml(c, msgs, loadFrom);
        if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
        const scroller = el.querySelector('.chat-msgs-scroll');
        if (!scroller) return;
        // 有跳转目标：定位到目标消息并高亮
        if (_chatJumpTarget) {
          const t = _chatJumpTarget;
          _chatJumpTarget = null;
          scrollToChatTarget(scroller, t, msgs);
          return;
        }
        // 无跳转目标：恢复之前的滚动位置（保持"滑到哪"），首次进入则滚到底
        if (_chatScrollPos > 0) {
          scroller.scrollTop = Math.min(_chatScrollPos, scroller.scrollHeight);
        } else {
          scroller.scrollTop = scroller.scrollHeight;
        }
      });
    }).catch(() => {
      el.innerHTML = `<div class="inbox-empty"><p>加载会话失败</p></div>`;
    });
  }

  // 在已渲染的 scroller 中定位目标消息并滚动高亮（order 精确 / keyword 文本模糊）
  function scrollToChatTarget(scroller, target, msgs) {
    let node = null;
    if (target.order !== undefined && target.order !== null && target.order >= 0) {
      const nodes = scroller.querySelectorAll('.chat-msg[data-order="' + target.order + '"]');
      if (nodes.length > 0) node = nodes[0];
      // 目标不在当前已加载范围内：向上加载直到覆盖（先加载整段再定位）
      if (!node && msgs && msgs.length > 0) {
        const firstOrder = msgs[0].order;
        if (target.order < firstOrder) {
          _chatJumpTarget = { order: target.order };
          _chatView.loadFrom = Math.max(0, Math.floor(target.order / CHAT_LOAD_PAGE) * CHAT_LOAD_PAGE);
          renderChatView();
          return;
        }
      }
    } else if (target.keyword) {
      const nodes = scroller.querySelectorAll('.chat-msg');
      for (const n of nodes) {
        if ((n.textContent || '').indexOf(target.keyword) !== -1) { node = n; break; }
      }
    }
    if (node) {
      scroller.scrollTop = node.offsetTop - scroller.clientHeight / 2;
      node.classList.add('chat-msg-flash');
      setTimeout(function () { node.classList.remove('chat-msg-flash'); }, 2500);
    }
  }

  function renderChatViewHtml(c, msgs, loadFrom) {
    const meta = chatTypeMeta(c.chatType);
    const cid = chatIdEsc(c.chatId);
    const total = c.total || 0;
    const hasMore = loadFrom > 0;
    const summaryBlock = renderChatSummaryBlock(c);
    const bubbles = msgs.map(m => renderChatBubble(m, c)).join('');
    return `
      <div class="chat-view">
        <div class="chat-back-bar">
          <button class="inbox-icon-btn" onclick="Inbox.backToChatList()" title="返回会话列表"><i data-lucide="arrow-left" style="width:16px;height:16px;"></i></button>
          <div class="chat-back-info">
            <div class="chat-back-name">${esc(c.name || 'QQ 会话')} <span class="chat-type-badge ${meta.cls}">${meta.label}</span></div>
            <div class="chat-back-sub">${total} 条消息 · ${chatTimeRange(c.timeStart, c.timeEnd)}</div>
          </div>
          <div class="chat-back-actions">
            <button class="inbox-btn inbox-btn-sm" onclick="Inbox.chatSummarize('${cid}')" title="AI 总结该会话"><i data-lucide="sparkles" style="width:13px;height:13px;vertical-align:middle;"></i> AI 总结</button>
          </div>
        </div>
        <div class="chat-summary-block">${summaryBlock}</div>
        <div class="chat-msgs-scroll">
          ${hasMore ? `<div class="chat-load-more"><button class="inbox-btn inbox-btn-sm" onclick="Inbox.chatLoadMore('${cid}')"><i data-lucide="chevrons-up" style="width:13px;height:13px;vertical-align:middle;"></i> 加载更早消息</button></div>` : ''}
          <div class="chat-msgs">${bubbles}</div>
          ${!hasMore && total > CHAT_LOAD_PAGE ? `<div class="chat-load-end">已显示全部 ${total} 条消息</div>` : ''}
        </div>
      </div>`;
  }

  function renderChatBubble(m, c) {
    // 系统消息 / 撤回消息：居中展示
    if (m.system || m.recalled) {
      const text = m.recalled ? '（消息已撤回）' : esc(m.text || '');
      return `<div class="chat-msg chat-msg-system" data-order="${m.order}">${text}</div>`;
    }
    const isSelf = !!c.selfUin && !!m.senderUin && m.senderUin === c.selfUin;
    const time = m.time || chatTimeStr(m.timestamp);
    return `
      <div class="chat-msg ${isSelf ? 'chat-msg-self' : 'chat-msg-other'}" data-order="${m.order}">
        <div class="chat-bubble">
          ${!isSelf ? `<div class="chat-sender">${esc(m.senderName || '未知')}</div>` : ''}
          <div class="chat-text">${esc(m.text || '')}</div>
          <div class="chat-time">${esc(time)}</div>
        </div>
      </div>`;
  }

  // 解析日报正文：带 (m<order>) 标记的「- 」行 → 精确跳转条目（支持一行多个标记，取第一个）；
  // 无标记的「- 」行 → 文本模糊跳转条目；其他行 → 普通文本
  function renderDailyReportContent(report, chatId) {
    if (!report) return '';
    const lines = String(report).split('\n');
    const html = [];
    for (const line of lines) {
      // 行首是「- 」或「* 」列表行
      const bulletMatch = line.match(/^\s*[-*]\s+(.+)$/);
      if (bulletMatch) {
        const rest = bulletMatch[1];
        // 提取行内所有 (m<序号>) 标记
        const markers = [];
        const markerRe = /\(m(\d+)\)/g;
        let mm;
        while ((mm = markerRe.exec(rest)) !== null) {
          markers.push(Number(mm[1]));
        }
        // 移除标记，得到纯文本
        const text = rest.replace(/\(m\d+\)/g, '').trim();
        if (markers.length > 0) {
          // 有精确标记：取第一个 order 跳转
          const order = markers[0];
          html.push(`<div class="chat-daily-item" title="点击/右键跳转到对应消息"
               onclick="Inbox.toggleChatDailyItem('${chatIdEsc(chatId)}','','${order}','')"
               oncontextmenu="Inbox.chatDailyItemMenu(event,'${chatIdEsc(chatId)}','${order}','${escAttr(text)}')">
          <i data-lucide="message-circle" style="width:11px;height:11px;flex-shrink:0;opacity:0.6;"></i>
          <span class="chat-daily-item-text">${esc(text)}</span>
        </div>`);
        } else if (text) {
          // 无标记的列表行：文本模糊跳转
          html.push(`<div class="chat-daily-item" title="点击/右键跳转到对应消息（按文本定位）"
               onclick="Inbox.toggleChatDailyItem('${chatIdEsc(chatId)}','','','${escAttr(text)}')"
               oncontextmenu="Inbox.chatDailyItemMenu(event,'${chatIdEsc(chatId)}','','${escAttr(text)}')">
          <i data-lucide="search" style="width:11px;height:11px;flex-shrink:0;opacity:0.6;"></i>
          <span class="chat-daily-item-text">${esc(text)}</span>
        </div>`);
        } else {
          // 空列表行忽略
        }
        continue;
      }
      // 普通行（主题标题 / 正文）：保留原样，标题加粗显示
      const isHead = /^#{1,6}\s+/.test(line.trim());
      if (isHead) {
        html.push(`<div class="chat-daily-line chat-daily-line-head">${esc(line.trim().replace(/^#{1,6}\s*/, ''))}</div>`);
      } else if (line.trim()) {
        html.push(`<div class="chat-daily-line">${esc(line)}</div>`);
      } else {
        html.push('<div class="chat-daily-line chat-daily-line-blank"></div>');
      }
    }
    return html.join('');
  }

  // 转义 HTML 属性值（用于 oncontextmenu 内嵌字符串参数）
  function escAttr(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 会话总结块（绿群日报式：翻页浏览 + 正文即条目 + 加载中 + 未生成）
  function renderChatSummaryBlock(c) {
    if (_chatSummarizing[c.chatId]) {
      return `<div class="inbox-summary loading"><div class="inbox-spinner"></div><span>AI 正在生成日报…</span></div>`;
    }
    const reports = (c.dailyReports && Array.isArray(c.dailyReports)) ? c.dailyReports : [];
    if (reports.length === 0) {
      return `<button class="inbox-summarize-btn" onclick="Inbox.chatSummarize('${chatIdEsc(c.chatId)}')"><i data-lucide="sparkles" style="width:12px;height:12px;vertical-align:middle;"></i> 生成日报</button>`;
    }
    // 归一化索引（防止旧数据缺 items）
    if (_chatDailyIdx >= reports.length) _chatDailyIdx = reports.length - 1;
    if (_chatDailyIdx < 0) _chatDailyIdx = 0;
    const cur = reports[_chatDailyIdx];
    // 正文本身即条目：解析 (m<order>) 标记行渲染为可跳转条目
    const bodyHtml = renderDailyReportContent(cur.report, c.chatId);
    const pager = reports.length > 1 ? `
      <div class="chat-daily-pager">
        <button class="inbox-btn inbox-btn-sm" onclick="Inbox.chatDailyPrev('${chatIdEsc(c.chatId)}')" ${_chatDailyIdx <= 0 ? 'disabled' : ''} title="前一天日报"><i data-lucide="chevron-left" style="width:13px;height:13px;"></i></button>
        <span class="chat-daily-pager-info">${_chatDailyIdx + 1} / ${reports.length} · ${esc(cur.date)}</span>
        <button class="inbox-btn inbox-btn-sm" onclick="Inbox.chatDailyNext('${chatIdEsc(c.chatId)}')" ${_chatDailyIdx >= reports.length - 1 ? 'disabled' : ''} title="后一天日报"><i data-lucide="chevron-right" style="width:13px;height:13px;"></i></button>
      </div>` : `<div class="chat-daily-pager-single">${esc(cur.date)}</div>`;
    // 折叠状态：只显示标题行
    const collapsed = !!_chatDailyCollapsed[c.chatId];
    if (collapsed) {
      return `<div class="inbox-summary done chat-daily-wrap chat-daily-collapsed">
        <div class="chat-daily-toolbar">
          <span class="inbox-summary-label"><i data-lucide="sparkles" style="width:12px;height:12px;"></i> AI 日报 <span class="chat-daily-count">(${reports.length} 天)</span></span>
          <button class="inbox-btn inbox-btn-sm" onclick="Inbox.toggleChatDailyCollapsed('${chatIdEsc(c.chatId)}')" title="展开日报"><i data-lucide="chevron-down" style="width:13px;height:13px;"></i> 展开</button>
        </div>
      </div>`;
    }
    return `<div class="inbox-summary done chat-daily-wrap">
      <div class="chat-daily-toolbar">
        <span class="inbox-summary-label"><i data-lucide="sparkles" style="width:12px;height:12px;"></i> AI 日报 <span class="chat-daily-count">(${reports.length} 天)</span></span>
        <div class="chat-daily-toolbar-actions">
          <button class="inbox-btn inbox-btn-sm" onclick="Inbox.chatRegenerateDaily('${chatIdEsc(c.chatId)}','${esc(cur.date)}')" title="重新生成这一天日报"><i data-lucide="refresh-cw" style="width:12px;height:12px;vertical-align:middle;"></i> 重新生成</button>
          <button class="inbox-btn inbox-btn-sm" onclick="Inbox.toggleChatDailyCollapsed('${chatIdEsc(c.chatId)}')" title="折叠日报"><i data-lucide="chevron-up" style="width:13px;height:13px;"></i></button>
        </div>
      </div>
      ${pager}
      <div class="chat-daily-body open">${bodyHtml}</div>
      <div class="chat-daily-foot">点击或右键日报条目可跳转到对应消息</div>
    </div>`;
  }

  // 折叠/展开日报区（按会话记忆）
  function toggleChatDailyCollapsed(chatId) {
    if (_chatDailyCollapsed[chatId]) delete _chatDailyCollapsed[chatId];
    else _chatDailyCollapsed[chatId] = true;
    if (_chatView && _chatView.chatId === chatId) renderChatView();
  }

  // 展开/收起某天日报（点击条目不触发，条目有自己的跳转）
  function toggleChatDaily(chatId, date) {
    if (_chatDailyOpen[date]) delete _chatDailyOpen[date];
    else _chatDailyOpen[date] = true;
    if (_chatView && _chatView.chatId === chatId) renderChatView();
  }

  // 点击日报条目：跳转到对应消息（order 优先，无 order 则按文本模糊定位）
  function toggleChatDailyItem(chatId, date, order, text) {
    jumpToChatMessage(chatId, Number(order) >= 0 ? Number(order) : null, text);
  }

  // 右键日报条目：直接跳转到对应消息（简洁交互）
  function chatDailyItemMenu(ev, chatId, order, text) {
    if (ev) ev.preventDefault();
    jumpToChatMessage(chatId, Number(order) >= 0 ? Number(order) : null, text);
  }

  // 跳转到会话内指定消息：order 精确，text 模糊（取消息文本包含该要点的第一条）
  function jumpToChatMessage(chatId, order, text) {
    if (typeof window.QQChats === 'undefined') return;
    const useOrder = order !== null && order !== undefined && !isNaN(order) && order >= 0;
    if (!useOrder && (!text || !text.trim())) return;
    _chatListOpen = true;
    if (useOrder) {
      // 精确跳转：设置目标，让渲染完成后定位
      _chatJumpTarget = { order: Number(order) };
      _chatView = { chatId: chatId, loadFrom: Math.max(0, Math.floor(Number(order) / CHAT_LOAD_PAGE) * CHAT_LOAD_PAGE) };
      renderChatView();
      return;
    }
    // 文本模糊：先搜索出目标消息的 order，再精确跳转
    const keyword = String(text).trim().slice(0, 30);
    window.QQChats.searchMessages(keyword, chatId, 5).then(function (hits) {
      if (!hits || hits.length === 0) {
        _chatJumpTarget = { keyword: keyword };
        _chatView = { chatId: chatId, loadFrom: -1 };
        renderChatView();
        return;
      }
      const hitOrder = hits[0].order;
      if (hitOrder !== undefined && hitOrder >= 0) {
        _chatJumpTarget = { order: hitOrder };
        _chatView = { chatId: chatId, loadFrom: Math.max(0, Math.floor(hitOrder / CHAT_LOAD_PAGE) * CHAT_LOAD_PAGE) };
      } else {
        _chatJumpTarget = { keyword: keyword };
        _chatView = { chatId: chatId, loadFrom: -1 };
      }
      renderChatView();
    }).catch(function () {
      _chatJumpTarget = { keyword: keyword };
      _chatView = { chatId: chatId, loadFrom: -1 };
      renderChatView();
    });
  }

  // 翻页：前一天
  function chatDailyPrev(chatId) {
    if (_chatDailyIdx > 0) {
      _chatDailyIdx--;
      if (_chatView && _chatView.chatId === chatId) renderChatView();
    }
  }
  // 翻页：后一天（上限由 renderChatSummaryBlock 归一化兜底）
  function chatDailyNext(chatId) {
    _chatDailyIdx++;
    if (_chatView && _chatView.chatId === chatId) renderChatView();
  }

  // 重新生成某一天日报（强制覆盖，不跳过已存在）
  async function chatRegenerateDaily(chatId, date) {
    if (typeof window.QQChats === 'undefined') return;
    if (_chatSummarizing[chatId]) return;
    const apiCfg = (typeof getEffectiveApiConfig === 'function') ? getEffectiveApiConfig() : null;
    if (!apiCfg || !apiCfg.apiKey) { alert('未配置 API Key，请先在设置中添加'); return; }
    if (!confirm('重新生成 ' + date + ' 的日报？现有内容将被覆盖。')) return;
    const chats = await window.QQChats.listChats();
    const c = chats.find(x => x.chatId === chatId);
    if (!c) return;
    // 找到该天的全部消息（跨分页读取）
    const allMsgs = [];
    const total = c.total || 0;
    for (let i = 0; i < total; i += 5000) {
      const page = await window.QQChats.getMessages(chatId, i, 5000);
      allMsgs.push.apply(allMsgs, page);
      if (page.length < 5000) break;
    }
    const dayMsgs = allMsgs.filter(m => chatMsgDateKey(m) === date);
    if (dayMsgs.length === 0) { alert('该日期没有消息'); return; }
    _chatSummarizing[chatId] = true;
    if (_chatView && _chatView.chatId === chatId) renderChatView();
    try {
      const payload = await generateDailyReport(c.name || 'QQ 会话', date, dayMsgs, apiCfg, function () {});
      await window.QQChats.setDailyReport(chatId, date, payload);
    } catch (e) {
      alert('重新生成失败：' + ((e && e.message) || e));
    }
    delete _chatSummarizing[chatId];
    if (_chatView && _chatView.chatId === chatId) renderChatView();
    else renderChatList();
  }

  // ── 会话 AI 总结：绿群日报式 —— 按天分离 → 每天按主题分块提取 → AI 汇总日报 ──
  const CHAT_SUMMARY_CHUNK = 150;  // 每块消息条数（主题分块提取）
  const CHAT_SUMMARY_MAX_TOTAL = 50000; // 单次总结的消息数上限
  const CHAT_SUMMARY_CONCURRENCY = 3; // 分块提取的并行并发数（避免触发 API 限流）

  // 并发池：以 limit 并发执行 asyncFn(items)，保持结果顺序
  async function chatMapLimit(items, limit, asyncFn, onOneDone) {
    const results = new Array(items.length);
    let next = 0;
    let done = 0;
    async function worker() {
      while (next < items.length) {
        const idx = next++;
        results[idx] = await asyncFn(items[idx], idx);
        done++;
        if (onOneDone) onOneDone(done, items.length);
      }
    }
    const n = Math.min(limit, items.length);
    if (n <= 0) return results;
    await Promise.all(Array.from({ length: n }, worker));
    return results;
  }

  // 取消息日期键（YYYY-MM-DD）
  function chatMsgDateKey(m) {
    if (m.time && /^\d{4}-\d{2}-\d{2}/.test(m.time)) return m.time.slice(0, 10);
    if (m.timestamp) {
      const d = new Date(m.timestamp);
      if (!isNaN(d.getTime())) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      }
    }
    return '未知日期';
  }

  // 把消息数组格式化为行文本
  function chatMsgLines(msgs) {
    return msgs.map(m => {
      const who = (m.system ? '[系统]' : (m.senderName || '未知')) + (m.recalled ? '(撤回)' : '');
      return (m.time || chatTimeStr(m.timestamp)) + ' ' + who + ': ' + m.text;
    });
  }

  // 生成一份当天的日报（绿群日报核心：主题分块提取 → AI 汇总）
  // 返回 { report, items }：report 为文本日报；items=[{ text, order }]，order 为该条来源消息序号（用于跳转）
  async function generateDailyReport(chatName, date, msgs, apiCfg, onProgress) {
    const lines = chatMsgLines(msgs);
    if (lines.length <= CHAT_SUMMARY_CHUNK) {
      // 少量消息：单次直接生成日报。输入中每条消息带 (m<order>) 标记，让 AI 引用到要点
      const numberedLines = lines.map(function (ln, i) {
        const order = msgs[i] ? msgs[i].order : i;
        return ln + ' (m' + order + ')';
      });
      const content = ('【' + chatName + '】 ' + date + '\n' + numberedLines.join('\n')).slice(0, 80000);
      const res = await aiGenerateDailyReport(content, chatName, date, apiCfg);
      const report = (res && res.trim()) ? res.trim() : '（未收到回复）';
      // items 保留（兼容旧渲染），但前端现在主要解析正文里的 (m) 标记
      return { report: report, items: extractDailyItems(report, msgs) };
    }
    // 大量消息：按时间窗口分块提取主题要点（并行 Map）→ 汇总成日报（Reduce）
    const chunks = [];
    for (let i = 0; i < lines.length; i += CHAT_SUMMARY_CHUNK) {
      chunks.push({ lines: lines.slice(i, i + CHAT_SUMMARY_CHUNK), startIdx: i }); // startIdx=块在 lines 中的起始位置
    }
    // 并行提取每个分块的主题要点（保持结果顺序）
    const blockResults = await chatMapLimit(chunks, CHAT_SUMMARY_CONCURRENCY, async function (chunk, idx) {
      const startOrder = msgs[Math.min(chunk.startIdx, msgs.length - 1)].order;
      // 块内每行消息末尾追加 (m<order>) 标记，供 AI 引用
      const numberedLines = chunk.lines.map(function (ln, li) {
        const order = msgs[Math.min(chunk.startIdx + li, msgs.length - 1)].order;
        return ln + ' (m' + order + ')';
      });
      const content = ('【' + chatName + '】 ' + date + ' · 片段 ' + (idx + 1) + '/' + chunks.length + '\n' + numberedLines.join('\n')).slice(0, 80000);
      const sys = '你是聊天记录分析助手，正在做日报分块提取。输入中每条消息末尾带有其序号标记 (m<序号>)，请从这段聊天记录中提取值得记录的信息：\n' +
        '1. 识别出了哪些话题/主题（每个主题用 ## 标题）；\n' +
        '2. 每个主题下用简短要点列出：讨论结论、通知公告、待办事项、重要人物或事件；\n' +
        '3. 每条要点以「- 」开头；\n' +
        '4. 【重要】每条要点末尾必须标注它对应的消息序号标记 (m<序号>)，且一条要点只允许标注一个 (m<序号>)，序号必须来自输入中真实存在的消息标记；\n' +
        '5. 若某条信息来自多条消息，只取其中一条消息的序号即可，不要写多个标记。\n' +
        '忽略闲聊、表情、无意义的回复。每个主题的要点控制在 60 字内。';
      const res = await callAiApi([
        { role: 'system', content: sys },
        { role: 'user', content: content }
      ], apiCfg, null);
      const t = (res && res.cleanText) ? res.cleanText.trim() : '';
      const itemList = [];
      if (t) {
        const linesOfBlock = t.split('\n').filter(l => /^\s*[-*]\s+/.test(l.trim()));
        if (linesOfBlock.length === 0) {
          itemList.push({ text: t.slice(0, 120), order: startOrder });
        } else {
          linesOfBlock.forEach(function (ln) {
            // 从 AI 输出的 (m<order>) 标记提取真实序号（取第一个），并移除标记得到纯文本
            const mm = ln.match(/\(m(\d+)\)/);
            const order = mm ? Number(mm[1]) : startOrder;
            const text = ln.replace(/^\s*[-*]\s+/, '').replace(/\(m\d+\)/g, '').trim().slice(0, 160);
            if (text) itemList.push({ text: text, order: order });
          });
        }
      }
      return { text: t, startOrder: startOrder, items: itemList };
    }, function (done, total) { if (onProgress) onProgress(done, total); });

    const chunkSummaries = [];
    const items = [];
    for (let i = 0; i < blockResults.length; i++) {
      const br = blockResults[i];
      if (br.items.length > 0) {
        // 每个要点附带来源消息序号标记 (m<order>)，供第二轮整合进正文并跳转
        const annotatedLines = br.items.map(it => '- ' + it.text + ' (m' + it.order + ')').join('\n');
        chunkSummaries.push('## 片段 ' + (i + 1) + '/' + chunks.length + '\n' + annotatedLines);
        items.push.apply(items, br.items);
      } else if (br.text) {
        chunkSummaries.push('## 片段 ' + (i + 1) + '/' + chunks.length + '\n' + br.text);
      }
    }
    if (chunkSummaries.length === 0) return { report: '（当天无有效记录）', items: [] };
    // Reduce：把各片段要点合并成当天日报（要求保留 (m<order>) 标记，正文即条目）
    const mergeContent = '以下是【' + chatName + '】 ' + date + ' 的聊天记录分片段提取结果，请合并去重、按主题归类，生成当天日报：\n\n' + chunkSummaries.join('\n\n');
    const report = await aiGenerateDailyReport(mergeContent, chatName, date, apiCfg);
    return { report: (report && report.trim()) ? report.trim() : '（未收到回复）', items: items };
  }

  // 尝试从 AI 日报文本中提取条目并关联消息序号
  // 支持格式： "- 要点内容"、"* 要点内容"、"1. 要点内容"
  function extractDailyItems(report, msgs) {
    if (!report) return [];
    const items = [];
    const lineRe = /^\s*(?:[-*]|\d+\.)\s+(.+)$/gm;
    let m;
    let idx = 0;
    while ((m = lineRe.exec(report)) !== null) {
      const text = m[1].trim();
      if (!text) continue;
      // 关联到第 idx 条消息的全局 order（msgs 元素含 order 字段）
      const ref = msgs[Math.min(idx, msgs.length - 1)];
      const order = ref ? ref.order : 0;
      items.push({ text: text.slice(0, 160), order: order });
      idx++;
    }
    if (items.length === 0) {
      const ref = msgs[0];
      items.push({ text: report.replace(/\s+/g, ' ').slice(0, 160), order: ref ? ref.order : 0 });
    }
    return items;
  }

  // AI 生成一份日报（Reduce 汇总）：要求保留 (m<order>) 标记，正文即条目
  async function aiGenerateDailyReport(content, chatName, date, apiCfg) {
    const sys = '你是聊天记录分析助手。请为【' + chatName + '】生成 ' + date + ' 的日报：\n' +
      '输入中每条要点带有 (m<序号>) 来源标记，请务必遵守以下规则：\n' +
      '1. 合并去重、按主题归类（用 ## 主题标题），每个主题下用「- 」列出要点；\n' +
      '2. 每条要点的末尾【必须原样保留】它的 (m<序号>) 标记，如「- 今晚八点讲导数 (m123)」；\n' +
      '3. 【重要】一条要点只允许保留一个 (m<序号>) 标记：若多个输入要点合并为一条，只保留其中第一个要点的标记，去掉其余标记；\n' +
      '4. 不要改动保留的那个标记中的数字，不要自行编造新标记；\n' +
      '5. 开头一句话概括当天整体动态，整体控制在 350 字以内。';
    const res = await callAiApi([
      { role: 'system', content: sys },
      { role: 'user', content: content }
    ], apiCfg, null);
    return (res && res.cleanText) ? res.cleanText : '（未收到回复）';
  }

  // 绿群日报式总结入口：按天生成日报，存入 dailyReports
  async function chatSummarize(chatId) {
    if (typeof window.QQChats === 'undefined') return;
    if (_chatSummarizing[chatId]) return;
    const apiCfg = (typeof getEffectiveApiConfig === 'function') ? getEffectiveApiConfig() : null;
    if (!apiCfg || !apiCfg.apiKey) { alert('未配置 API Key，请先在设置中添加'); return; }
    const chats = await window.QQChats.listChats();
    const c = chats.find(x => x.chatId === chatId);
    if (!c) return;
    _chatSummarizing[chatId] = true;
    if (_chatView && _chatView.chatId === chatId) renderChatView();
    try {
      const chatName = c.name || 'QQ 会话';
      const total = c.total || 0;
      const from = (c.summaryUpTo || 0);
      const pendingCount = total - from;
      if (pendingCount <= 0) {
        delete _chatSummarizing[chatId];
        if (_chatView && _chatView.chatId === chatId) renderChatView();
        else renderChatList();
        alert('该会话已全部生成过日报，没有新增消息');
        return;
      }
      const take = Math.min(pendingCount, CHAT_SUMMARY_MAX_TOTAL);
      const msgs = await window.QQChats.getMessages(chatId, from, take);
      if (!msgs || msgs.length === 0) {
        delete _chatSummarizing[chatId];
        if (_chatView && _chatView.chatId === chatId) renderChatView();
        else renderChatList();
        alert('没有可总结的消息');
        return;
      }
      // 按天分组（保持时间顺序，同日消息按序）
      const dayGroups = {};
      const dayOrder = [];
      for (const m of msgs) {
        const key = chatMsgDateKey(m);
        if (!dayGroups[key]) { dayGroups[key] = []; dayOrder.push(key); }
        dayGroups[key].push(m);
      }
      // 逐天生成日报（已有日报的日期跳过；多天之间并行，受并发池限制）
      const existingDates = new Set((c.dailyReports || []).map(d => d.date));
      const daysToMake = dayOrder.filter(date => {
        const dayMsgs = dayGroups[date];
        return dayMsgs && dayMsgs.length > 0 && !existingDates.has(date);
      });
      // 并发处理各天（2 天并发 + 天内 3 块并发，总体可控）
      await chatMapLimit(daysToMake, 2, async function (date) {
        const dayMsgs = dayGroups[date];
        const updateProgress = (i, n) => {
          if (_chatView && _chatView.chatId === chatId) {
            const el = document.getElementById('inboxMsgList');
            const loader = el && el.querySelector('.inbox-summary.loading');
            if (loader) {
              const span = loader.querySelector('span');
              if (span) span.textContent = '正在生成 ' + date + ' 日报（分块 ' + i + '/' + n + '）…';
            }
          }
        };
        const payload = await generateDailyReport(chatName, date, dayMsgs, apiCfg, updateProgress);
        await window.QQChats.setDailyReport(chatId, date, payload);
      });
      // 推进游标（防止重复总结）
      const newUpTo = Math.min(total, from + msgs.length);
      if (daysToMake.length > 0) {
        // 用 setSummary 更新游标（summary 文本保留旧值）
        await window.QQChats.setSummary(chatId, c.summary || '', { summaryUpTo: newUpTo, summaryDate: '' });
      } else {
        alert('新增消息范围内没有新日期需要生成日报（已有日报）');
      }
    } catch (e) {
      alert('AI 日报生成失败：' + ((e && e.message) || e));
    }
    delete _chatSummarizing[chatId];
    if (_chatView && _chatView.chatId === chatId) renderChatView();
    else renderChatList();
  }

  // 交互
  function openChat(chatId) {
    if (typeof window.QQChats === 'undefined') return;
    _chatListOpen = true;
    _chatView = { chatId: chatId, loadFrom: -1 };
    renderChatView();
  }
  function backToChatList() {
    _chatView = null;
    _chatListOpen = true;
    renderChatList();
  }
  function openChatList() {
    _chatView = null;
    _chatListOpen = true;
    renderChatList();
  }
  // 加载更早消息：向前扩展一页（loadFrom 减小）
  function chatLoadMore(chatId) {
    if (!_chatView || _chatView.chatId !== chatId) return;
    const prevFrom = _chatView.loadFrom;
    _chatView.loadFrom = Math.max(0, (prevFrom === undefined || prevFrom < 0) ? 0 : (prevFrom - CHAT_LOAD_PAGE));
    renderChatView();
  }
  async function deleteChat(chatId) {
    if (typeof window.QQChats === 'undefined') return;
    if (!confirm('删除该 QQ 会话及其全部消息？此操作不可恢复。')) return;
    const ok = await window.QQChats.deleteChat(chatId);
    if (!ok) { alert('删除失败'); return; }
    if (_chatView && _chatView.chatId === chatId) _chatView = null;
    renderChatList();
  }

  // ── 区块折叠/展开切换 ──
  function toggleInboxCollapse(key) {
    _inboxCollapsed[key] = !_inboxCollapsed[key];
    render();
  }

  // ── 交互 ──
  function setFilter(f) {
    filter = f;
    _chatView = null;
    _chatListOpen = false;
    renderInboxArea();
  }
  function toggleExpand(id) {
    if (expandedIds.has(id)) expandedIds.delete(id); else expandedIds.add(id);
    renderMessages();
  }
  function removeMessage(id) {
    if (!confirm('删除这条消息？')) return;
    deleteMessage(id);
    renderMessages();
    renderWatchCard();
  }
  // 展开 / 收起发件人聚合组
  function toggleMailGroup(keyEnc) {
    const key = decodeURIComponent(keyEnc);
    if (expandedSenders.has(key)) expandedSenders.delete(key); else expandedSenders.add(key);
    renderMessages();
  }
  // 删除整组（该发件人的全部邮件）
  function deleteMailGroup(keyEnc) {
    const key = decodeURIComponent(keyEnc);
    const ids = messages.filter(m => m.channel === 'mail' && senderKey(m.from) === key).map(m => m.id);
    if (!ids.length) return;
    if (!confirm('删除该发件人聚合下的 ' + ids.length + ' 封邮件？')) return;
    messages = messages.filter(m => !ids.includes(m.id));
    ids.forEach(id => expandedIds.delete(id));
    expandedSenders.delete(key);
    saveMessages();
    renderMessages();
  }
  // 概括整组：对组内所有未概括的邮件依次概括
  async function summarizeGroup(keyEnc) {
    const key = decodeURIComponent(keyEnc);
    const targets = messages.filter(m => m.channel === 'mail' && senderKey(m.from) === key && !m.summary && !m.summaryError);
    if (targets.length === 0) { alert('该发件人的邮件都已概括'); return; }
    for (const t of targets) await summarize(t.id);
  }

  // ── Modal ──
  function showInboxModal({ title, body, width }) {
    closeInboxModal();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.zIndex = '2500';
    overlay.onclick = (e) => { if (e.target === overlay) closeInboxModal(); };
    overlay.innerHTML = `
      <div class="modal" style="${width ? 'max-width:' + width + ';' : ''}">
        <div class="modal-header">
          <span class="modal-title">${title}</span>
          <button class="modal-close" onclick="Inbox.closeModal()"><i data-lucide="x" style="width:16px;height:16px;"></i></button>
        </div>
        <div class="modal-body inbox-modal-body">${body}</div>
      </div>`;
    document.body.appendChild(overlay);
    _inboxModal = overlay;
    requestAnimationFrame(function () { overlay.classList.add('open'); });
    if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
  }
  function closeInboxModal() {
    if (_inboxModal) {
      _inboxModal.remove();
      _inboxModal = null;
    }
  }

  // ── 初始化 ──
  function init() {
    messages = loadJSON(MSG_KEY, []);
    mailAccounts = loadJSON(MAIL_KEY, []);
    watchDirs = loadJSON(WATCH_KEY, []);
    // 预载 QQ 聊天会话概览缓存（供 AI 系统提示词注入）
    if (typeof window.QQChats !== 'undefined' && window.QQChats.loadMetaCache) {
      window.QQChats.loadMetaCache().catch(function () {});
    }
    // 进入收件箱时自动扫描一次（防抖，避免频繁触发）
    if (watchDirs.length > 0) {
      const last = Number(localStorage.getItem(LAST_SCAN_KEY)) || 0;
      if (Date.now() - last > 60 * 60 * 1000) {
        setTimeout(function () { scanWatchDirs(false); }, 1500);
      }
    }
  }

  init();

  return {
    render,
    setFilter,
    toggleExpand,
    removeMessage,
    toggleMailGroup,
    deleteMailGroup,
    summarizeGroup,
    summarize,
    previewImage,
    openMailConfig,
    testMail,
    saveMailConfig,
    fetchMails,
    openImportModal,
    loadWindows,
    doLongShot,
    openPasteModal,
    selectPasteChannel,
    submitPaste,
    importFiles,
    openWatchModal,
    addWatchDir,
    removeWatchDir,
    scanWatchDirs,
    importQQChat,
    importQQChatJsonl,
    importQQChatJsonlFiles,
    pickImportModeResolve,
    toggleChatCardSummary,
    toggleChatDaily,
    toggleChatDailyItem,
    chatDailyItemMenu,
    chatDailyPrev,
    chatDailyNext,
    chatRegenerateDaily,
    toggleChatDailyCollapsed,
    toggleInboxCollapse,
    openChatList,
    openChat,
    backToChatList,
    chatLoadMore,
    chatSummarize,
    deleteChat,
    closeModal: closeInboxModal
  };
})();
