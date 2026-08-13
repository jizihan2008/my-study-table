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
  let _pasteChannel = 'wechat'; // 粘贴导入的渠道

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
        <div class="inbox-filter-pills">
          ${['all','mail','wechat','qq','file','manual'].map(c => {
            const meta = CHANNEL_META[c] || { label: c };
            return `<button class="inbox-pill ${filter === c ? 'active' : ''}" onclick="Inbox.setFilter('${c}')">${c === 'all' ? '全部' : meta.label}</button>`;
          }).join('')}
        </div>
        <div class="inbox-toolbar-actions">
          <button class="inbox-btn inbox-btn-primary" onclick="Inbox.openMailConfig()"><i data-lucide="mail" style="width:14px;height:14px;vertical-align:middle;"></i> 邮箱</button>
          <button class="inbox-btn" onclick="Inbox.openImportModal()"><i data-lucide="camera" style="width:14px;height:14px;vertical-align:middle;"></i> 截图导入</button>
          <button class="inbox-btn" onclick="Inbox.openPasteModal()"><i data-lucide="clipboard-paste" style="width:14px;height:14px;vertical-align:middle;"></i> 粘贴文本</button>
          <button class="inbox-btn" onclick="document.getElementById('inboxFileInput').click()"><i data-lucide="folder-plus" style="width:14px;height:14px;vertical-align:middle;"></i> 导入文件</button>
          <button class="inbox-btn" onclick="Inbox.openWatchModal()"><i data-lucide="folder-search" style="width:14px;height:14px;vertical-align:middle;"></i> 目录监控</button>
        </div>
        <input type="file" id="inboxFileInput" multiple style="display:none;" accept=".txt,.md,.markdown,.json,.js,.mjs,.ts,.jsx,.tsx,.py,.java,.c,.cpp,.h,.cs,.go,.rs,.rb,.php,.swift,.kt,.sql,.html,.htm,.css,.xml,.yaml,.yml,.toml,.ini,.cfg,.log,.csv,.tsv,.sh,.bat,.ps1,.png,.jpg,.jpeg,.gif,.webp,.bmp" onchange="Inbox.importFiles(this)">
      </div>

      <!-- 邮箱状态卡 -->
      <div class="inbox-status-row">
        <div class="inbox-status-card" id="inboxMailCard"></div>
        <div class="inbox-status-card" id="inboxWatchCard"></div>
      </div>

      <!-- 消息列表 -->
      <div class="inbox-msg-list" id="inboxMsgList"></div>
    `;
    renderMailCard();
    renderWatchCard();
    renderMessages();
    if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
  }

  // ── 邮箱状态卡 ──
  function getMailAccount() { return mailAccounts[0] || null; }
  function renderMailCard() {
    const el = document.getElementById('inboxMailCard');
    if (!el) return;
    const acc = getMailAccount();
    el.innerHTML = acc ? `
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
      </div>`;
  }

  // ── 目录监控卡 ──
  function renderWatchCard() {
    const el = document.getElementById('inboxWatchCard');
    if (!el) return;
    const lastScan = localStorage.getItem(LAST_SCAN_KEY);
    const lastTxt = lastScan ? fmtTime(new Date(Number(lastScan)).toISOString()) : '尚未扫描';
    el.innerHTML = `
      <div class="inbox-status-icon" style="background:rgba(139,92,246,0.12);color:#8b5cf6;"><i data-lucide="folder-search" style="width:18px;height:18px;"></i></div>
      <div class="inbox-status-body">
        <div class="inbox-status-title">文件目录监控 · <span style="color:#8b5cf6">${watchDirs.length} 个目录</span></div>
        <div class="inbox-status-sub">自动收集微信 / QQ 保存到本地的文件，最后扫描 ${esc(lastTxt)}</div>
      </div>
      <div class="inbox-status-actions">
        <button class="inbox-btn inbox-btn-sm" onclick="Inbox.scanWatchDirs(true)"><i data-lucide="refresh-cw" style="width:13px;height:13px;"></i> 扫描</button>
        <button class="inbox-btn inbox-btn-sm" onclick="Inbox.openWatchModal()">管理</button>
      </div>`;
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

  // ── 交互 ──
  function setFilter(f) { filter = f; renderMessages(); }
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
    closeModal: closeInboxModal
  };
})();
