// ═══════════════════════════════════════════════
//  AI 渲染：聊天界面、消息列表、Markdown格式化、LaTeX数学公式
// ═══════════════════════════════════════════════

let _aiForceScrollBottom = false; // 强制滚动到底部标志（发送/切换对话时置位）
const _aiStreamingDrafts = new Map(); // convId -> transient assistant output (never persisted)
const _aiStreamingPaintTimers = new Map();
const AI_STREAM_PAINT_INTERVAL_MS = 32;

function stripHallucinatedToolTranscriptForDisplay(value) {
  const text = String(value || '');
  const protocol = text.match(/\\?<\s*(?:tool(?:\\?_)?(?:call|action)|[|｜]+\s*DSML\s*[|｜]+)/i);
  if (!protocol) return text;
  const tail = text.slice(protocol.index);
  const fakeRole = tail.match(/^[ \t]*(?:user|assistant|system)[ \t]*【工具执行结果】/mi);
  return fakeRole ? text.slice(0, protocol.index + fakeRole.index).trimEnd() : text;
}

function sanitizeAiToolRoundText(value) {
  const text = stripHallucinatedToolTranscriptForDisplay(value);
  if (typeof parseDsmlToolCalls === 'function') {
    const dsml = parseDsmlToolCalls(text);
    if (dsml && dsml.valid) return dsml.cleanText;
  }
  return text
    .replace(/<(tool_call|tool_action)>[\s\S]*?<\/(?:tool_call|tool_action|call)>/g, '')
    .replace(/\\?<tool\\?_(?:call|action)>[\s\S]*?\\?<\/(?:tool\\?_(?:call|action)|call)>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizeAiStreamingText(value) {
  return sanitizeAiToolRoundText(value)
    .replace(/<(tool_call|call_ai|memory)>[\s\S]*?<\/\1>/g, '')
    .replace(/<(?:tool_call|call_ai|memory)>[\s\S]*$/g, '')
    .replace(/<[a-z_]*$/i, '')
    .replace(/\n{3,}/g, '\n\n');
}

function setAiStreamingDraft(convId, snapshot) {
  const key = String(convId);
  const draft = {
    // Keep the raw accumulated text here. Sanitizing once per paint is much
    // cheaper than repeatedly scanning the complete reply for every token.
    content: String(snapshot?.content || ''),
    reasoning: String(snapshot?.reasoning || ''),
    keyName: snapshot?.keyName || ''
  };
  _aiStreamingDrafts.set(key, draft);
  if (String(getActiveConvId()) !== key) return;

  const row = document.getElementById('aiStreamingDraft');
  if (!row) {
    // First token creates the transient bubble immediately. Later tokens are
    // batched so the full conversation is not re-rendered for every SSE event.
    renderAiMessages();
    return;
  }
  scheduleAiStreamingPaint(key);
}

function updateStreamingTextNode(element, nextValue) {
  if (!element) return;
  const next = String(nextValue || '');
  const current = element.textContent || '';
  if (next === current) return;
  if (next.startsWith(current)) {
    element.appendChild(document.createTextNode(next.slice(current.length)));
  } else {
    element.textContent = next;
  }
}

function paintAiStreamingDraft(key) {
  _aiStreamingPaintTimers.delete(key);
  if (String(getActiveConvId()) !== key) return;
  const draft = _aiStreamingDrafts.get(key);
  const row = document.getElementById('aiStreamingDraft');
  if (!draft || !row) return;
  const container = document.getElementById('aiMessages');
  const wasNearBottom = !!container && container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  const content = row.querySelector('.ai-streaming-content');
  const reasoningWrap = row.querySelector('.ai-streaming-reasoning');
  const reasoningText = row.querySelector('.ai-streaming-reasoning-text');
  updateStreamingTextNode(content, sanitizeAiStreamingText(draft.content));
  updateStreamingTextNode(reasoningText, draft.reasoning);
  if (reasoningWrap) reasoningWrap.style.display = draft.reasoning ? '' : 'none';
  if (wasNearBottom && container) container.scrollTop = container.scrollHeight;
}

function scheduleAiStreamingPaint(key) {
  if (_aiStreamingPaintTimers.has(key)) return;
  const timer = setTimeout(() => paintAiStreamingDraft(key), AI_STREAM_PAINT_INTERVAL_MS);
  _aiStreamingPaintTimers.set(key, timer);
}

function clearAiStreamingDraft(convId, shouldRender = true) {
  const key = String(convId);
  const timer = _aiStreamingPaintTimers.get(key);
  if (timer) clearTimeout(timer);
  _aiStreamingPaintTimers.delete(key);
  const existed = _aiStreamingDrafts.delete(key);
  if (existed && shouldRender && String(getActiveConvId()) === key) renderAiMessages();
}

// ═══════════ AI Chat: Rendering ═══════════
function renderAiChat() {
  const layout = document.getElementById('aiChatLayout');
  if (!layout) return;
  // 切换/重建对话视图：强制滚动到底部展示最新消息
  _aiForceScrollBottom = true;
  // 重建前：记录输入框焦点 + 实时保存草稿。避免重渲染（自动标题生成 / 日报完成 / 首次发送命名等
  // 异步完成后调用本函数）把用户正在输入的内容与焦点一并替换，导致"无法输入文字"。
  const _prevInput = document.getElementById('aiInput');
  const _hadInputFocus = !!(_prevInput && document.activeElement === _prevInput);
  if (typeof saveAiDraft === 'function') { try { saveAiDraft(); } catch (e) {} }
  const hasApiKey = !!(loadApiKeys().length > 0);

  // 无 API Key 时也正常渲染界面（可查看历史聊天记录），仅禁用发送并在顶部提示。
  // 不再整页替换为「未配置 Key」提示页，避免看不到已有对话。
  const noKey = !hasApiKey;
  const noKeyBanner = noKey ? `
    <div class="ai-no-key-banner">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="16" height="16">
        <path d="M12 2a4 4 0 014 4c0 1.1-.5 2.1-1.2 2.8l3.4 6.5A3 3 0 0115.5 19H8.5a3 3 0 01-2.7-3.7l3.4-6.5A4 4 0 0112 2z"/><circle cx="12" cy="8" r="2"/><path d="M12 22v-2"/>
      </svg>
      <span>尚未配置 AI API Key，当前仅可查看历史聊天记录。发送消息需先在设置中配置。</span>
      <button class="ai-no-key-setup" onclick="openSettingsModal()">去设置</button>
    </div>` : '';

  const conv = getActiveConv();
  if (!conv) return;

  // Build tabs HTML with drag-and-drop attributes
  const tabsHtml = aiConvs.map((c, i) => {
    const isReport = c._dailyReport;
    const hasUnread = c._hasUnread === true || c._hasUnreadAuto === true;
    return `
    <button class="ai-conv-tab${c.id === activeConvId ? ' active' : ''}" draggable="true"
            data-conv-index="${i}" data-conv-id="${c.id}"
            ondragstart="onConvTabDragStart(event, ${i})"
            ondragover="onConvTabDragOver(event)"
            ondrop="onConvTabDrop(event, ${i})"
            ondragend="onConvTabDragEnd(event)"
            onclick="switchConv(${c.id})" title="${escapeHtml(c.title)}">
      <span class="ai-conv-tab-name">${escapeHtml(c.title)}</span>
      ${hasUnread ? '<span class="ai-conv-unread-dot"></span>' : ''}
      <span class="ai-conv-tab-clear" onclick="event.stopPropagation(); clearConvMessages(event)" title="清空对话消息">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
      </span>
      ${!isReport ? '<span class="ai-conv-tab-delete" onclick="event.stopPropagation(); deleteConv(' + c.id + ', event)" title="删除对话">✕</span>' : ''}
    </button>
  `;
  }).join('');

  const hasSystemPrompt = conv.systemPrompt && conv.systemPrompt.trim().length > 0;
  const activeKeyName = getActiveKeyDisplayName();

  layout.innerHTML = `
    <div class="ai-conv-tabs-wrap" id="aiConvTabsWrap">
      ${tabsHtml}
      <button class="ai-conv-tab-add" onclick="createNewConv()" title="新建对话">＋</button>
      <button class="ai-conv-tab-settings" onclick="openConvSettingsModal()" title="对话设置">⚙️</button>
    </div>
    ${hasSystemPrompt ? `<div class="ai-chat-header" style="background:var(--path-bg);">
      <span class="ai-chat-header-title" style="font-size:12px;color:var(--text-secondary);">💡 提示词：${escapeHtml(conv.systemPrompt.length > 60 ? conv.systemPrompt.slice(0,60)+'…' : conv.systemPrompt)}</span>
    </div>` : ''}
    ${noKeyBanner}
    <div class="ai-chat-messages" id="aiMessages"></div>
    <div class="ai-attach-preview-wrap" id="aiAttachPreview" style="display:none;"></div>
    <!-- Toolbar: API Key selector + toggles + quick actions -->
    <div class="ai-toolbar" id="aiToolbar">
      <div class="ai-toolbar-row">
        <select class="ai-toolbar-key-select" id="aiToolbarKeySelect" onchange="onAiToolbarKeyChange()"></select>
        <div class="ai-toolbar-toggles">
          <button type="button" class="ai-pill-toggle" id="aiToolbarDeepThinkBtn" onclick="toggleAiDeepThink()" title="深度思考（部分模型支持）">
            <i data-lucide="atom" class="lucide-icon" style="width:16px;height:16px;"></i>
            <span>深度思考</span>
          </button>
          <button type="button" class="ai-pill-toggle" id="aiToolbarWebSearchBtn" onclick="toggleAiWebSearch()" title="联网搜索">
            <i data-lucide="globe" class="lucide-icon" style="width:16px;height:16px;"></i>
            <span>智能搜索</span>
          </button>
          <button type="button" class="ai-pill-toggle" id="aiToolbarImageUploadBtn" onclick="cycleAiImageUploadMode()" title="图片上传方式">
            <i data-lucide="image-plus" class="lucide-icon" style="width:16px;height:16px;"></i>
            <span>图片上传</span>
          </button>
          <button type="button" class="ai-pill-toggle" id="aiToolbarTreeBtn" onclick="toggleAiTreePanel()" title="分支树导航（查看所有对话分支）">
            <i data-lucide="git-branch" class="lucide-icon" style="width:16px;height:16px;"></i>
            <span>分支树</span>
          </button>
        </div>
        <select class="ai-toolbar-quick" id="aiToolbarQuick" onchange="onAiToolbarQuickChange()">
          <option value="">📋 快捷操作...</option>
          <option value="总结我的待办事项">📊 待办总结</option>
          <option value="查看今日状态">📅 今日状态</option>
          <option value="根据我的待办，推荐1个今日聚焦任务">🎯 推荐聚焦</option>
          <option value="帮我写一份今天的学习日报">☀️ 生成晨间日报</option>
          <option value="分析我的待办情况并给我一些学习建议">💡 学习建议</option>
        </select>
      </div>
    </div>
    <div class="ai-queue-indicator" id="aiQueueIndicator" style="display:none;" onclick="toggleAiQueuePanel(event)"></div>
    <div class="ai-queue-panel" id="aiQueuePanel" style="display:none;"></div>
    <div class="ai-chat-input-wrap">
      <textarea id="aiInput" placeholder="${noKey ? '未配置 AI Key，仅可查看历史记录' : '输入你的问题，回车发送... (可上传 .txt 附件)'}" rows="1"
                ${noKey ? 'disabled' : ''}
                onkeydown="handleAiInputKey(event)"
                oninput="autoResizeAiInput()"></textarea>
      <input type="file" id="aiFileInput" accept="" multiple style="display:none;" onchange="handleAiFileSelect(event)">
      <button class="ai-attach-btn" id="aiAttachBtn" ${noKey ? 'disabled' : ''} onclick="document.getElementById('aiFileInput').click()" title="上传附件">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
      </button>
      <button class="ai-chat-send-btn" id="aiSendBtn" ${noKey ? 'disabled' : ''} onclick="handleAiSendOrStop()" title="发送">
        <svg id="aiSendIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
      </button>
    </div>
  `;
  renderAiMessages();
  renderAttachPreview(); // Restore attachment preview after DOM rebuild
  updateAiFileInput(); // Update file input based on current model
  initAiPasteZone(); // 输入框已重建 → 重新绑定剪贴板粘贴图片
  // Restore loading state after DOM rebuild: toggle send/stop button
  updateAiSendButton();
  // 恢复发送队列指示器
  if (typeof updateAiQueueIndicator === 'function') updateAiQueueIndicator();
  // 无 API Key 时强制禁用发送/上传/输入（覆盖 updateAiSendButton 可能的 enabled）
  if (noKey) {
    const _inp = document.getElementById('aiInput');
    const _send = document.getElementById('aiSendBtn');
    const _at = document.getElementById('aiAttachBtn');
    if (_inp) _inp.disabled = true;
    if (_send) _send.disabled = true;
    if (_at) _at.disabled = true;
  }
  setTimeout(() => {
    const msgs = document.getElementById('aiMessages');
    if (!msgs) return;
    // 若切换对话/发送消息触发的整页重建已强制滚动，或用户本就接近底部，才滚到底
    if (_aiForceScrollBottom) {
      msgs.scrollTop = msgs.scrollHeight;
      _aiForceScrollBottom = false;
    } else if (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 120) {
      msgs.scrollTop = msgs.scrollHeight;
    }
  }, 100);
  // Restore input draft for current conv
  restoreAiDraft();
  // 重建后恢复输入焦点与光标（此前正在输入时被重渲染打断的场景）
  if (_hadInputFocus && !noKey) {
    const _inp = document.getElementById('aiInput');
    if (_inp && !_inp.disabled) {
      _inp.focus();
      const _len = _inp.value.length;
      try { _inp.setSelectionRange(_len, _len); } catch (e) {}
    }
  }
  updateSidebarAiBadge();
  // Initialize toolbar state
  initAiToolbar();
  // Restore tree float open state after DOM rebuild
  if (_aiTreePanelOpen) {
    const overlay = document.getElementById('aiTreeFloatOverlay');
    if (overlay && overlay.style.display !== 'none') {
      renderAiTreePanel();
    }
  }
  // Enable horizontal scroll on tabs via mouse wheel
  const tabsWrap = document.querySelector('.ai-conv-tabs-wrap');
  if (tabsWrap && !tabsWrap._wheelAttached) {
    tabsWrap._wheelAttached = true;
    tabsWrap.addEventListener('wheel', function(e) {
      // Only intercept if the container can scroll horizontally
      if (this.scrollWidth > this.clientWidth) {
        this.scrollLeft += e.deltaY + e.deltaX;
        e.preventDefault();
      }
    }, { passive: false });
  }
}

// 点击用户消息里的图片缩略图 → 全屏查看（再次点击或按 Esc 关闭）
function openAiAttachmentImage(imgEl) {
  const src = imgEl && imgEl.getAttribute ? imgEl.getAttribute('src') : '';
  if (!src || !/^data:image\//i.test(src)) return;
  const overlay = document.createElement('div');
  overlay.className = 'ai-image-overlay';
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', close);
  const img = document.createElement('img');
  img.src = src;
  img.alt = (imgEl && imgEl.getAttribute('alt')) || '附件图片';
  overlay.appendChild(img);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey);
}

function renderAiMessages() {
  const container = document.getElementById('aiMessages');
  if (!container) return;
  const conv = getActiveConv();
  if (!conv) return;

  // ── 滚动位置保持：记录渲染前状态 ──
  // AI 回复/工具调用会频繁重渲染；若用户正在翻阅历史消息，不应被强制拉到末尾。
  // 仅当用户本就接近底部（或显式强制）时才在渲染后滚动到底部。
  const prevScrollTop = container.scrollTop;
  const wasNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;

  // 树状对话：conv.messages 是活跃路径的扁平视图（由树引擎同步）。
  // 直接遍历节点序列渲染，同时为每个消息记录其树节点 id（nodeId），
  // 以便挂载分支切换/分叉按钮。迁移后的旧数据也已转换为树。
  const renderItems = [];
  const pathNodes = isTreeConv(conv) ? activePathNodes(conv) : [];
  // 无树结构兜底：直接用 messages（正常情况下不应发生）
  const seq = pathNodes.length > 0 ? pathNodes : (conv.messages || []);
  for (let idx = 0; idx < seq.length; idx++) {
    const n = seq[idx];
    if (!n || !n.role || n.role === 'root') continue;
    const m = n; // 树节点即消息（含全部字段 + nodeId）
    const nodeId = n.id;
    if (m.role === 'user') {
      // 用户消息处的分支 = 编辑产生的"不同问题"分支（同父下的 user 兄弟数，含自己）
      // 渲染层用现有 siblingNodeIds 过滤 role 计算，不改底层逻辑
      // curIndex：当前 user 在同父 user 兄弟中的序号（从 1 开始）
      let userSib = 1, userCur = 1;
      if (isTreeConv(conv)) {
        const parentId = conv.tree[nodeId] ? conv.tree[nodeId].parentId : null;
        const allSib = parentId && conv.tree[parentId] ? conv.tree[parentId].children : [];
        const userSibs = allSib.filter(sid => conv.tree[sid] && conv.tree[sid].role === 'user');
        userSib = userSibs.length || 1;
        userCur = userSibs.indexOf(nodeId) >= 0 ? userSibs.indexOf(nodeId) + 1 : 1;
      }
      renderItems.push({
        type: 'user', msg: m, idx, nodeId,
        branchCount: userSib,
        branchCurIndex: userCur,
        activeBranchChild: null
      });
    } else if (m.role === 'assistant') {
      // AI 消息处的分支 = 同一问题重新生成的候选数（同父下的 assistant 兄弟数，含自己）
      // curIndex：当前 assistant 在同父 assistant 兄弟中的序号（从 1 开始）
      let sib = 1, asstCur = 1;
      if (isTreeConv(conv)) {
        const parentId = conv.tree[nodeId] ? conv.tree[nodeId].parentId : null;
        const allSib = parentId && conv.tree[parentId] ? conv.tree[parentId].children : [];
        const asstSibs = allSib.filter(sid => conv.tree[sid] && conv.tree[sid].role === 'assistant');
        sib = asstSibs.length || 1;
        asstCur = asstSibs.indexOf(nodeId) >= 0 ? asstSibs.indexOf(nodeId) + 1 : 1;
      }
      renderItems.push({ type: 'assistant', msg: m, idx, nodeId, branchCount: sib, branchCurIndex: asstCur });
    } else if (m.role === 'system') {
      renderItems.push({ type: 'system', msg: m, idx, nodeId });
    }
  }
  const streamingDraft = _aiStreamingDrafts.get(String(conv.id));
  if (streamingDraft) {
    renderItems.push({
      type: 'assistant',
      msg: { ...streamingDraft, role: 'assistant', _streaming: true },
      idx: 'streaming',
      nodeId: null,
      branchCount: 1,
      branchCurIndex: 1
    });
  }

  container.innerHTML = renderItems.map(item => {
    const m = item.msg;
    if (!m) return ''; // safety: skip items without a message object
    const idx = item.idx;
    const reasoningHtml = m._streaming ? `
      <div class="ai-streaming-reasoning"${m.reasoning ? '' : ' style="display:none"'}>
        <span class="ai-streaming-reasoning-label">🧠 深度思考</span>
        <span class="ai-streaming-reasoning-text">${escapeHtml(m.reasoning || '')}</span>
      </div>
    ` : m.reasoning ? `
      <div class="ai-reasoning-toggle" onclick="toggleReasoning(this)" data-idx="${idx}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        🧠 深度思考
      </div>
      <div class="ai-reasoning-content">${formatAiContent(m.reasoning)}</div>
    ` : '';

    // Render attachments in user messages
    let attachHtml = '';
    let cleanContent = m.content;
    if (item.type === 'user' && m.attachments && m.attachments.length > 0) {
      // 图片附件：优先用发送时记录在附件上的图片地址（可能是 Files API 的小缩略图），
      // 旧消息没有该字段时退回按顺序取 visionFiles 里的 dataUrl
      const imgUrls = (m.visionFiles || [])
        .filter(v => v && typeof v.dataUrl === 'string' && /^data:image\//i.test(v.dataUrl))
        .map(v => v.dataUrl);
      let imgCursor = 0;
      attachHtml = '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">' + m.attachments.map(a => {
        const looksImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(a.name || ''));
        const thumb = (typeof a.displayUrl === 'string' && /^data:image\//i.test(a.displayUrl))
          ? a.displayUrl
          : (looksImage ? imgUrls[imgCursor] : '');
        if (looksImage && thumb) {
          imgCursor++;
          return `<span class="msg-attachment-img" title="${escapeHtml(a.name)}"><img src="${thumb}" alt="${escapeHtml(a.name)}" onclick="openAiAttachmentImage(this)"></span>`;
        }
        return `<span class="msg-attachment">📝 ${escapeHtml(a.name)}</span>`;
      }).join('') + '</div>';
      // Build collapsible file content sections
      for (const a of m.attachments) {
        if (a.content) {
          const escapedContent = escapeHtml(a.content);
          attachHtml += `<details class="file-content"><summary>📝 查看文件内容：${escapeHtml(a.name)}</summary><pre>${escapedContent}</pre></details>`;
        }
      }
      // Strip file content from display text (keep only user's typed text)
      if (typeof cleanContent === 'string') {
        cleanContent = cleanContent.replace(/\n\n\[附件：[^\]]+\]\n[\s\S]*$/, '');
      }
    }

    // For system messages with tool call info, render as friendly notification
    if (m._toolInfo) {
      const friendlyLabels = {
        'list_todos': '📋 待办事项列表',
        'get_todo_detail': '📋 待办详情',
        'get_today_status': '📅 今日状态',
        'get_focus_tasks': '🎯 查看聚焦任务',
        'get_stats': '📊 统计信息',
        'get_todo_stats': '📊 待办统计',
        'list_notes': '📝 笔记列表',
        'search_notes': '🔍 笔记搜索结果',
        'get_note_detail': '📝 笔记详情',
        'get_note_changes': '📝 笔记变更',
        'list_links': '🔗 链接列表',
        'list_automations': '⏰ 自动化列表',
        'add_todo': '➕ 创建待办',
        'update_todo': '✏️ 更新待办',
        'delete_todo': '🗑️ 删除待办',
        'toggle_todo': '✅ 切换待办状态',
        'batch_update_todos': '📋 批量操作待办',
        'batch_add_todos': '📋 批量创建待办',
        'set_focus_task': '🎯 设置聚焦任务',
        'add_note': '➕ 创建笔记',
        'update_note': '✏️ 更新笔记',
        'move_note': '📂 移动笔记',
        'delete_note': '🗑️ 删除笔记',
        'add_link': '➕ 添加链接',
        'delete_link': '🗑️ 删除链接',
        'schedule_automation': '⏰ 创建自动化',
        'delete_automation': '🗑️ 删除自动化',
        'web_search': '🌐 网络搜索',
        'tool_protocol': '⚠️ 工具协议错误'
      };
      // Handle multiple tool calls: get the unique tool names and look up each one
      const toolNameSet = [...new Set(m._toolInfo.toolNames.split('、').map(s => s.trim()))];
      let label;
      if (toolNameSet.length === 1) {
        label = friendlyLabels[toolNameSet[0]] || `🔧 ${toolNameSet[0]}`;
      } else {
        // Multiple different tools were called, list them all
        label = toolNameSet.map(n => friendlyLabels[n] || `🔧 ${n}`).join('、');
      }
      // Strip the "[工具调用结果——...]" prefix and the summary line (e.g. "📋 待办事项列表（共3个）")
      // Only keep the data content (the numbered list starting with [1])
      let dataContent = m.content.replace(/^\[工具调用[^\]]*\]\n?/, '');
      dataContent = dataContent.replace(/^【工具执行结果】\n?/, '').replace(/^【结构化状态】[^\n]*\n?/, '');
      dataContent = dataContent.replace(/^.*?（共\d+个）\n*/m, '');
      dataContent = dataContent.replace(/\n{3,}/g, '\n\n'); // 压缩多余空行
      dataContent = dataContent.replace(/\n+$/, ''); // trim trailing newlines
      dataContent = escapeHtml(dataContent);
      const statusHtml = (m._toolInfo.outcomes || []).map(outcome => {
        const icon = outcome.status === 'success' ? '✅' : (outcome.status === 'duplicate' ? '🛡️' : outcome.status === 'skipped' ? '⏹️' : '❌');
        const duration = outcome.durationMs ? ` · ${outcome.durationMs}ms` : '';
        return `<span class="ai-tool-status ${escapeHtml(outcome.status || '')}" title="${escapeHtml(outcome.error || '')}">${icon} ${escapeHtml(outcome.action || '')}${duration}</span>`;
      }).join('');
      return `
        <div class="ai-chat-msg system">
          <div class="ai-chat-avatar">⚙️</div>
          <div class="ai-chat-bubble ai-chat-tool-call">
            <div class="ai-tool-call-toggle" onclick="toggleToolCallData(this)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
              ${label}
            </div>
            ${statusHtml ? `<div class="ai-tool-status-row">${statusHtml}</div>` : ''}
            <div class="ai-tool-call-data">${dataContent}</div>
          </div>
        </div>
      `;
    }

    // Hide tool_call, call_ai, and memory tags from user-facing messages
    const hasToolCall = m._malformedToolProtocol === true || m._dsmlToolProtocol === true
      || (typeof cleanContent === 'string' && /<tool_call>/.test(cleanContent));
    if (m._streaming) {
      cleanContent = sanitizeAiStreamingText(cleanContent);
    } else if (typeof cleanContent === 'string') {
      if (typeof m._toolRoundCleanText === 'string') {
        cleanContent = m._toolRoundCleanText;
      } else if (hasToolCall) {
        const sanitized = sanitizeAiToolRoundText(cleanContent);
        cleanContent = m._malformedToolProtocol && sanitized === cleanContent ? '' : sanitized;
      } else {
        cleanContent = cleanContent
          .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
          .replace(/<tool_call>[\s\S]*?<tool_call>/g, '')
          .replace(/<call_ai>[\s\S]*?<\/call_ai>/g, '')
          .replace(/<memory>[\s\S]*?<\/memory>/g, '')
          .replace(/\n{3,}/g, '\n\n') // 压缩移除标签后残留的空行
          .trim();
      }
    }

    // If the assistant message only contained tool calls (no visible text),
    // show a friendly placeholder instead of an empty bubble.
    const isAssistant = item.type === 'assistant';
    // 编辑模式：user 消息正在内联编辑时，气泡内容替换为 textarea + 操作按钮
    const isEditingMsg = item.type === 'user' && _aiMsgEditingUserId === item.nodeId;
    let contentHtml;
    if (isEditingMsg) {
      const rawText = typeof m.content === 'string' ? m.content : '';
      contentHtml = `
        <textarea id="aiMsgEditInput-${item.nodeId}" class="ai-msg-edit-input" rows="3" onkeydown="onAiMsgEditKeydown(event, ${item.nodeId})">${escapeHtml(rawText)}</textarea>
        <div class="ai-msg-edit-actions">
          <button class="ai-tree-edit-btn primary" onclick="event.stopPropagation(); confirmEditAiMsg(${item.nodeId})">发送</button>
          <button class="ai-tree-edit-btn" onclick="event.stopPropagation(); cancelEditAiMsg()">取消</button>
        </div>
      `;
    } else if (m._streaming) {
      contentHtml = `<div class="ai-streaming-content">${escapeHtml(cleanContent || '')}</div>`;
    } else {
      contentHtml = formatAiContent(cleanContent);
      if (!contentHtml && isAssistant && hasToolCall) {
        contentHtml = m._malformedToolProtocol
          ? '<span class="ai-tool-placeholder">⚠️ 工具指令格式错误，已返回给 AI 修正...</span>'
          : '<span class="ai-tool-placeholder">🔧 正在执行操作...</span>';
      }
    }

    const timeLabel = m.time ? `<div class="ai-chat-time">${m.time}</div>` : '';
    const keyNameHtml = (isAssistant && m.keyName) ? `<div class="ai-chat-keyname">🔑 ${escapeHtml(m.keyName)}</div>` : '';

    // ── 树状对话底部控制 ──
    let bottomHtml = '';
    if (item.type === 'assistant') {
      const loading = isAiLoading(conv.id);
      const canNav = item.branchCount > 1 && !loading;
      // 分支切换（多个候选回复 = 兄弟分支）
      let pagerHtml = '';
      if (canNav) {
        pagerHtml = `
          <button class="ai-msg-cand-nav" onclick="navigateCandidateBranch(${item.nodeId}, -1)" title="上一个候选">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <span class="ai-msg-cand-count">${item.branchCurIndex}/${item.branchCount}</span>
          <button class="ai-msg-cand-nav" onclick="navigateCandidateBranch(${item.nodeId}, 1)" title="下一个候选">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="9 18 15 12 9 6"/></svg>
          </button>`;
      }
      // 换一条 / 从这里分叉：在父 user 下新建分支
      const regenBtn = !loading ? `<button class="ai-msg-regen" onclick="regenerateAiMessage(${item.nodeId})" title="换一条（在父节点下新建分支）">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
        换一条
      </button>` : '';
      if (pagerHtml || regenBtn) {
        bottomHtml = `<div class="ai-msg-controls"><div class="ai-msg-cand-pager">${pagerHtml}</div><div class="ai-msg-actions">${regenBtn}</div></div>`;
      }
    } else if (item.type === 'user') {
      // 用户消息下方操作栏：编辑按钮（始终显示）+ 分叉时显示候选分支切换
      const loading = isAiLoading(conv.id);
      let userControls = '';
      if (!loading && item.nodeId) {
        // 编辑按钮：点击进入内联编辑模式（在气泡内）
        userControls += `<button class="ai-msg-edit-btn" onclick="startEditAiMsg(${item.nodeId})" title="编辑这条消息，编辑后发送将创建新分支">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          编辑
        </button>`;
      }
      if (item.branchCount > 1 && !loading) {
        userControls += `<button class="ai-msg-cand-nav" onclick="switchUserVersion(${item.nodeId}, -1)" title="编辑产生的其他版本">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span class="ai-msg-branch-label">${item.branchCurIndex}/${item.branchCount}</span>
        <button class="ai-msg-cand-nav" onclick="switchUserVersion(${item.nodeId}, 1)" title="编辑产生的其他版本">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="9 18 15 12 9 6"/></svg>
        </button>`;
      }
      if (userControls) {
        bottomHtml = `<div class="ai-msg-controls" style="justify-content:flex-start;">${userControls}</div>`;
      }
    }

    const roleClass = isAssistant ? 'assistant' : (item.type === 'system' ? 'system' : 'user');
    const avatar = isAssistant ? '🤖' : (item.type === 'system' ? '⚙️' : '👤');
    const kimiSearchBadge = (m._kimiSearchResult) ? '<div class="ai-kimi-search-badge">🔍 Kimi 联网搜索</div>' : '';

    return `
      <div class="ai-chat-msg ${roleClass}"${m._streaming ? ' id="aiStreamingDraft" aria-live="polite"' : ''}>
        <div class="ai-chat-avatar">${avatar}</div>
        <div class="ai-chat-msg-body">
          ${keyNameHtml}
          <div class="ai-chat-bubble">${kimiSearchBadge}${attachHtml}${reasoningHtml}${contentHtml}${timeLabel}</div>
          ${bottomHtml}
        </div>
      </div>
    `;
  }).join('');
  // Show typing indicator only when loading and there are no pending intermediate messages
  // (i.e., during the first API call before any tool results come back)
  if (!streamingDraft && isAiLoading(conv.id) && conv.messages.length > 0) {
    const lastMsg = conv.messages[conv.messages.length - 1];
    // Show typing indicator if the last message is from user (waiting for first AI response)
    // or if the last message is a tool result (waiting for AI to process it)
    if (lastMsg.role === 'user' || (lastMsg.role === 'system' && lastMsg._toolInfo)) {
      container.innerHTML += `
        <div class="ai-chat-msg assistant">
          <div class="ai-chat-avatar">🤖</div>
          <div class="ai-chat-bubble"><div class="ai-chat-typing"><span></span><span></span><span></span></div></div>
        </div>
      `;
    }
  }
  // ── 渲染后滚动：仅在接近底部或强制时滚到底，否则保持原位置 ──
  if (_aiForceScrollBottom || wasNearBottom) {
    container.scrollTop = container.scrollHeight;
  } else {
    container.scrollTop = prevScrollTop;
  }
  _aiForceScrollBottom = false;
}

// ═══════════ 树形导航浮窗（模仿复习浮窗，body 级可拖拽） ═══════════
let _aiTreePanelOpen = false;
// 编辑消息状态：记录正在内联编辑的 user 节点 id
let _aiTreeEditingUserId = null;
// 主消息流编辑状态：记录正在内联编辑的 user 节点 id
let _aiMsgEditingUserId = null;

// ── 主消息流：编辑用户消息（编辑后发送 = 创建编辑分支并重新生成）──
function startEditAiMsg(nodeId) {
  _aiMsgEditingUserId = nodeId;
  renderAiMessages();
}

function cancelEditAiMsg() {
  _aiMsgEditingUserId = null;
  renderAiMessages();
}

async function confirmEditAiMsg(nodeId) {
  const input = document.getElementById('aiMsgEditInput-' + nodeId);
  if (!input) return;
  const text = input.value;
  _aiMsgEditingUserId = null;
  renderAiMessages();
  if (text && text.trim()) {
    await sendEditedMessage(nodeId, text);
  }
}

function onAiMsgEditKeydown(event, nodeId) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    confirmEditAiMsg(nodeId);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    cancelEditAiMsg();
  }
}

// 开始编辑某条 user 消息（在树浮窗中）
function startEditAiTreeMsg(nodeId) {
  _aiTreeEditingUserId = nodeId;
  renderAiTreePanel();
}

// 取消编辑
function cancelEditAiTreeMsg() {
  _aiTreeEditingUserId = null;
  renderAiTreePanel();
}

// 确认编辑：读取输入框内容 → 创建编辑分支并发送（类似重新生成）
async function confirmEditAiTreeMsg(nodeId) {
  const input = document.getElementById('aiTreeEditInput-' + nodeId);
  if (!input) return;
  const text = input.value;
  _aiTreeEditingUserId = null;
  renderAiTreePanel();
  if (text && text.trim()) {
    await sendEditedMessage(nodeId, text);
  }
}

// 树浮窗内编辑输入框的键盘事件（Enter 发送，Esc 取消）
function onAiTreeEditKeydown(event, nodeId) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    confirmEditAiTreeMsg(nodeId);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    cancelEditAiTreeMsg();
  }
}

function openAiTreeFloat() {
  const overlay = document.getElementById('aiTreeFloatOverlay');
  if (!overlay) return;
  overlay.style.display = 'block';
  renderAiTreePanel();
  // 默认定位右下角
  const f = document.getElementById('aiTreeFloat');
  if (f) {
    f.style.left = ''; f.style.top = '';
    f.style.right = '24px'; f.style.bottom = '24px';
    f.style.position = 'fixed';
  }
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}

function closeAiTreeFloat() {
  const overlay = document.getElementById('aiTreeFloatOverlay');
  if (overlay) overlay.style.display = 'none';
  _aiTreePanelOpen = false;
}

function toggleAiTreePanel() {
  const overlay = document.getElementById('aiTreeFloatOverlay');
  if (!overlay) return;
  if (overlay.style.display === 'none') {
    _aiTreePanelOpen = true;
    openAiTreeFloat();
  } else {
    _aiTreePanelOpen = false;
    closeAiTreeFloat();
  }
}

function renderAiTreePanel() {
  const body = document.getElementById('aiTreeFloatBody');
  if (!body) return;
  const conv = getActiveConv();
  if (!conv || !isTreeConv(conv)) {
    body.innerHTML = '<div class="ai-tree-empty">当前对话没有可展示的树。</div>';
    return;
  }
  const tree = conv.tree;
  const activeSet = new Set(conv.activePath);
  const root = tree['root'];

  // ── 完整树路径渲染（交换组）──
  // 数据模型仍为消息级节点（保证消息流/上下文兼容）。树导航按「交换」聚合展示：
  //   - 一次「用户提问 + AI 回复（含工具链）」= 一个**交换组**：👤 行 + 🤖 行作为同一节点，
  //     选中/取消联动（点击组内任意位置切换该分支）。
  //   - user 下的每个 child = 一个候选回复分支，各形成一个交换组（父 user 在多个分支前重复出现）：
  //       👤 b → 🤖 回复B → 👤 c → 🤖 回复C
  //       与   👤 b → 🤖 回复B'  （并列，无"分支 N"文字）
  //   - 分支内的嵌套交换递归展开（缩进表示层级）。

  // 沿 first-child 链折叠工具链，返回该分支的交换终点信息：
  // { replyNodeId, replyText, hasReply }
  const foldBranch = (cid) => {
    let lastReply = null;
    let cur = cid;
    let guard = 0;
    while (cur && tree[cur] && guard++ < 300) {
      const n = tree[cur];
      if (n.role === 'user') break; // 嵌套交换起点，停止折叠
      if (n.role === 'assistant' && n.content && String(n.content).trim()) {
        lastReply = { nodeId: cur, content: n.content };
      }
      const kids2 = n.children || [];
      if (kids2.length === 0) break;
      cur = kids2[0];
    }
    const replyNodeId = lastReply ? lastReply.nodeId : cid;
    const replyText = lastReply
      ? summarizeNode({ content: lastReply.content })
      : '(等待回复…)';
    return { replyNodeId, replyText, hasReply: !!lastReply };
  };

  // 渲染一个 user 节点的 👤 行（支持编辑模式：编辑中显示输入框 + 发送/取消）
  const renderUserLine = (userId, depth, groupActive) => {
    const user = tree[userId];
    const editing = _aiTreeEditingUserId === userId;
    const label = editing
      ? ''
      : (groupActive ? '<span class="ai-tree-dot"></span>' : '');
    // 编辑模式：输入框 + 操作按钮
    if (editing) {
      const rawText = typeof user.content === 'string' ? user.content : '';
      return `
        <div class="ai-tree-edit" style="padding-left:${depth * 16}px;">
          <textarea id="aiTreeEditInput-${userId}" class="ai-tree-edit-input" rows="2" onkeydown="onAiTreeEditKeydown(event, ${userId})">${escapeHtml(rawText)}</textarea>
          <div class="ai-tree-edit-actions">
            <button class="ai-tree-edit-btn primary" onclick="event.stopPropagation(); confirmEditAiTreeMsg(${userId})">发送</button>
            <button class="ai-tree-edit-btn" onclick="event.stopPropagation(); cancelEditAiTreeMsg()">取消</button>
          </div>
        </div>
      `;
    }
    // 普通模式：👤 行 + 编辑按钮
    return `
      <div class="ai-tree-row" style="padding-left:${depth * 16}px;">
        <div class="ai-tree-node exchange ${groupActive ? 'active' : ''}">
          ${label}
          <span class="ai-tree-q">👤 ${summarizeNode(user)}</span>
          <button class="ai-tree-edit-ico" title="编辑这条消息" onclick="event.stopPropagation(); startEditAiTreeMsg(${userId})">
            <i data-lucide="pencil" class="lucide-icon" style="width:12px;height:12px;"></i>
          </button>
        </div>
      </div>
    `;
  };

  // 渲染一个交换组（👤 行 + 🤖 行，整体选中联动），并递归其嵌套交换。
  const renderExchangeGroup = (userId, depth) => {
    const user = tree[userId];
    if (!user) return '';
    const kids = user.children || [];
    // 无回复分支：只渲染 user 行（自身可切换）
    if (kids.length === 0) {
      const isActive = activeSet.has(userId);
      return `
        <div class="ai-tree-exchange-group" onclick="switchToTreeBranch(${userId})">
          ${renderUserLine(userId, depth, isActive)}
        </div>
      `;
    }
    let html = '';
    for (let bi = 0; bi < kids.length; bi++) {
      const cid = kids[bi];
      const childNode = tree[cid];
      if (!childNode) continue;
      const { replyNodeId, replyText, hasReply } = foldBranch(cid);
      // 交换组 active：以该分支的回复链终点是否在活跃路径为准（选中/取消联动）。
      // 注意不能用 activeSet.has(userId)——同一 user 的多个候选分支会共享该 user 节点，
      // 若用 user 判断会导致所有分支组同时高亮。
      const groupActive = activeSet.has(replyNodeId);
      const clickId = replyNodeId || userId;
      html += `
        <div class="ai-tree-exchange-group ${groupActive ? 'active' : ''}" onclick="switchToTreeBranch(${clickId})">
          ${renderUserLine(userId, depth, groupActive)}
          <div class="ai-tree-reply ${groupActive ? 'active' : ''}">
            🤖 ${hasReply ? replyText : '(等待回复…)'}
          </div>
        </div>
      `;
      // 该分支内嵌套的 user 交换：下钻到回复终点（最后一个非 user 节点），
      // 对其所有 role==='user' 的 children 分别递归渲染交换组。
      // （编辑消息场景下，一个 assistant 回复节点下可并列多个 user 分支：b 与 b'）
      let endNodeId = cid;
      let cur2 = cid;
      let guard2 = 0;
      while (cur2 && tree[cur2] && guard2++ < 300) {
        const n2 = tree[cur2];
        if (n2.role === 'user') break;
        endNodeId = cur2;
        const kids2 = n2.children || [];
        if (kids2.length === 0) break;
        cur2 = kids2[0];
      }
      const endNode = tree[endNodeId];
      if (endNode && endNode.children) {
        for (const kid of endNode.children) {
          const k = tree[kid];
          if (k && k.role === 'user') {
            html += renderExchangeGroup(k.id, depth + 1);
          }
        }
      }
    }
    return html;
  };

  // 从 root 开始：渲染第一层所有 user 交换
  const firstUsers = collectNestedUserIds(conv, root.id)
    .filter(uid => !tree[uid].parentId || tree[uid].parentId === 'root' || tree[tree[uid].parentId].role === 'root');
  // 兜底：若第一层无 user（异常数据），用全部顶层 user
  let html = '';
  for (const nu of firstUsers.length > 0 ? firstUsers : collectNestedUserIds(conv, root.id)) {
    html += renderExchangeGroup(nu, 0);
  }
  body.innerHTML = html || '<div class="ai-tree-empty">当前对话没有可展示的树。</div>';
  if (typeof lucide !== 'undefined') {
    try { lucide.createIcons(); } catch (_) {}
  }
}

// 节点摘要：取内容前 28 字符（user 用原文，assistant 去掉隐藏标签）
function summarizeNode(node) {
  if (!node || typeof node.content !== 'string') return '(空)';
  let text = node.content
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<call_ai>[\s\S]*?<\/call_ai>/g, '')
    .replace(/<memory>[\s\S]*?<\/memory>/g, '')
    .trim();
  if (!text) return '(工具调用)';
  return escapeHtml(text.length > 28 ? text.slice(0, 28) + '…' : text);
}

// 点击树节点 → 切换到该分支
function switchToTreeBranch(nodeId) {
  const conv = getActiveConv();
  if (!conv || isAiLoading(conv.id)) return;
  if (switchBranch(conv, nodeId)) {
    safeSaveAiConvs();
    renderAiMessages();
    renderAiTreePanel();
  }
}

// 用户消息处：切换"编辑产生的版本"（user 兄弟）。
// 切到目标 user 后，若其有回复链（children），继续下钻到回复链终点，
// 避免切换后该 user 下方的 assistant 消息消失（activePath 只到 user 节点）。
function switchUserVersion(userNodeId, delta) {
  const conv = getActiveConv();
  if (!conv || isAiLoading(conv.id) || !isTreeConv(conv) || !conv.tree[userNodeId]) return;
  // 同父下的 user 兄弟（编辑产生的其他版本）
  const siblings = siblingNodeIds(conv, userNodeId)
    .filter(sid => conv.tree[sid] && conv.tree[sid].role === 'user');
  if (siblings.length === 0) return;
  const n = siblings.length + 1; // 含自己
  const curIdx = siblings.indexOf(userNodeId);
  const newIdx = (curIdx + delta + n) % n;
  const targetId = newIdx === curIdx ? userNodeId : siblings[newIdx];
  // 下钻到回复链终点：若目标 user 有 assistant 回复（children），沿 first-child 走到末尾
  let target = targetId;
  const tNode = conv.tree[targetId];
  if (tNode && tNode.children && tNode.children.length > 0) {
    let cur = tNode.children[0];
    let guard = 0;
    while (cur && conv.tree[cur] && guard++ < 300) {
      const cn = conv.tree[cur];
      if (cn.role === 'user') break; // 嵌套交换起点，停在回复链终点
      const kids = cn.children || [];
      if (kids.length === 0) break;
      cur = kids[0];
    }
    target = cur;
  }
  if (switchBranch(conv, target)) {
    safeSaveAiConvs();
    renderAiMessages();
  }
}

// ═══════════ 树形导航浮窗拖拽（仿复习浮窗） ═══════════
(function() {
  let dragState = null;
  let dragOccurred = false;

  function initDrag(e) {
    const float = document.getElementById('aiTreeFloat');
    const header = document.getElementById('aiTreeFloatHeader');
    if (!float || !header) return;
    if (!header.contains(e.target)) return;
    dragOccurred = false;
    const rect = float.getBoundingClientRect();
    dragState = {
      el: float,
      startX: e.clientX,
      startY: e.clientY,
      origLeft: rect.left,
      origTop: rect.top
    };
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
    e.preventDefault();
  }

  function onDragMove(e) {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragOccurred = true;
    if (!dragOccurred) return;
    dragState.el.style.position = 'fixed';
    dragState.el.style.left = (dragState.origLeft + dx) + 'px';
    dragState.el.style.top = (dragState.origTop + dy) + 'px';
    dragState.el.style.margin = '0';
  }

  function onDragEnd() {
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    dragState = null;
  }

  document.addEventListener('mousedown', function(e) {
    const overlay = document.getElementById('aiTreeFloatOverlay');
    if (!overlay || overlay.style.display === 'none') return;
    initDrag(e);
  });
})();

function toggleReasoning(toggleEl) {
  const contentEl = toggleEl.nextElementSibling;
  toggleEl.classList.toggle('open');
  contentEl.classList.toggle('open');
}

function toggleToolCallData(toggleEl) {
  const contentEl = toggleEl.nextElementSibling;
  toggleEl.classList.toggle('open');
  contentEl.classList.toggle('open');
}

// ── 内嵌思维导图（```mindmap），复用教材知识库导图样式 ──
// 支持两种格式（自动识别）：
//   A. 缩进树：每行一个节点，2 空格 / Tab 表示层级
//   B. Unicode 树形字符（AI 常用）：├─ / └─ / │ 前缀，如：
//       0x22 深度优先搜索
//       ├─ 概念体系
//       │  ├─ 状态空间 = 图
//       │  └─ DFS 三要素
//       └─ 方法论
// 输入 code 已由 formatMarkdownBase 整体 HTML 转义，节点名不再二次转义。
// 判断代码块内容是否"看起来像"思维导图（用于裸 ``` 无语言标记时自动识别）：
//   - 含树形字符（├ └ │）→ 是
//   - 否则：≥2 个非空行 + ≥2 个不同缩进级别 + 无代码特征 + 无 ASCII 树连接线
function looksLikeMindmap(code) {
  const s = String(code || '');
  if (/[├└]/.test(s)) return true; // 树形字符格式
  const nonEmpty = s.split('\n').filter(l => l.trim());
  if (nonEmpty.length < 2) return false;
  // 排除 ASCII 树/图（如二叉树图、目录树）：
  // 存在以连接符（\ / |）开头的行（如 "/"、"/ \"、"|-- main.js"、"|\"）→ 是结构图，
  // 不是"每行一个纯文本节点名"的思维导图缩进树
  if (nonEmpty.some(l => /^[\\/|]/.test(l.trim()))) return false;
  const indents = nonEmpty.map(l => (l.match(/^(\t| {2,})/) ? l.match(/^(\t| {2,})/)[0].length : 0));
  if (new Set(indents).size < 2) return false; // 无嵌套层级
  if (/[{};]|=>|<\/|<!--|\$\{|\b(function|const|let|var|return|if|else|for|while|class|import|export)\b/.test(s)) return false;
  return true;
}

function renderNoteMindmap(code) {
  const lines = String(code || '').split('\n');
  const root = { name: '', children: [] };
  const isTreeChar = lines.some(l => /[├└]/.test(l));

  const stack = [{ node: root, depth: -1 }];
  const pushNode = (depth, name) => {
    const node = { name: name, children: [] };
    while (stack.length > 1 && depth <= stack[stack.length - 1].depth) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ node: node, depth: depth });
  };

  // 树形字符格式的层级宽度：收集所有 ├/└ 的列位置，取第一个非零列作为每级缩进宽度。
  // （不能只数 │：最后分支的子行用「空格」代替竖线，如 `   ├─`，无 │ 但已是下一级。）
  let unit = 0;
  if (isTreeChar) {
    const uniqCols = [...new Set(lines.map(l => l.search(/[├└]/)).filter(i => i >= 0))].sort((a, b) => a - b);
    for (const c of uniqCols) { if (c > 0) { unit = c; break; } }
  }

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ').replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (isTreeChar) {
      // ─+ 匹配一个或多个横线：AI 常用 tree 命令风格 `├── name`（双横线），
      // 单 ─ 会漏掉第二个横线导致节点名残留 "─ " 前缀。
      const m = line.match(/^([│| ]*)([├└])─+[ \t]*(.*)$/);
      if (m) {
        const col = line.indexOf(m[2]);
        const depth = unit > 0 ? Math.round(col / unit) + 1 : 1;
        pushNode(depth, m[3].trim());
      } else {
        pushNode(0, line.trim());
      }
    } else {
      // 缩进：层级 = 前导空格数
      const indent = line.length - line.trimStart().length;
      pushNode(indent, line.trim());
    }
  }

  const renderNode = (node, level) => {
    const children = (node.children && node.children.length)
      ? node.children.map(c => renderNode(c, level + 1)).join('')
      : '';
    return `<div class="bk-mm-node level-${Math.min(level, 4)}">${node.name}${children}</div>`;
  };
  if (root.children.length === 0) {
    return `<div class="bk-mindmap-wrap"><div class="bk-mindmap"><div class="bk-mm-node level-1">${String(code || '').trim()}</div></div></div>`;
  }
  const html = root.children.map(c => renderNode(c, 1)).join('');
  return `<div class="bk-mindmap-wrap"><div class="bk-mindmap">${html}</div></div>`;
}

// ── Shared Markdown-to-HTML base renderer ──
// 统一交给 StudyMarkdown：CommonMark/GFM、KaTeX、脚注、任务列表、代码高亮和 DOMPurify。
// extraProcessor 在最终消毒前执行，供 AI 的 [ID:数字] 等受控扩展注入 HTML。
function formatMarkdownBase(text, extraProcessor) {
  if (typeof text !== 'string') return '';
  if (typeof StudyMarkdown !== 'undefined' && StudyMarkdown && typeof StudyMarkdown.render === 'function') {
    return StudyMarkdown.render(text, { transformHtml: extraProcessor });
  }
  let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  return html;
}

function formatAiContent(text) {
  // Handle array content (multimodal messages): extract text parts only
  if (Array.isArray(text)) {
    const textParts = text.filter(p => p.type === 'text').map(p => p.text);
    return formatAiContent(textParts.join('\n'));
  }
  if (typeof text !== 'string') return '';

  return formatMarkdownBase(text, (html) => {
    // Convert [ID:数字] patterns into clickable action links
    return html.replace(/\[ID:(\d+)\]/g, (match, id) => {
      const t = findTodo(Number(id));
      if (!t) return match;
      const escapedId = Number(id);
      const isDone = t.done;
      return `<span class="ai-action-link" data-todo-id="${escapedId}" role="button" tabindex="0" title="去目录查看"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>${escapeHtml(t.text.length > 15 ? t.text.slice(0,15)+'…' : t.text)}</span>` + (isDone ? ' ✅' : '');
    });
  });
}

// 把笔记批注锚点注入为 ⟦id⟧ 标记（formatMarkdownBase 渲染后再替换为 <mark class="note-ann">）
// 锚点 start/end 基于源文本（textarea.value）偏移，从后往前替换避免偏移漂移。
function injectNoteAnnotations(text, note) {
  if (!note || !Array.isArray(note._annotations)) return text;
  const anns = note._annotations.filter(a => a.end > a.start && (a.text || '').trim());
  if (anns.length === 0) return text;
  const sorted = anns.slice().sort((x, y) => x.start - y.start);
  let s = String(text || '');
  for (let i = sorted.length - 1; i >= 0; i--) {
    const a = sorted[i];
    const start = Math.max(0, Math.min(a.start, s.length));
    const end = Math.max(start, Math.min(a.end, s.length));
    if (end <= start) continue;
    s = s.slice(0, start) + '\u27E6' + a.id + '\u27E7' + s.slice(start, end) + '\u27E6/' + a.id + '\u27E7' + s.slice(end);
  }
  return s;
}

function formatNoteContent(text, note) {
  // Replace literal \n (backslash-n) with real newlines before markdown processing
  let cleaned = (text || '').replace(/\\n/g, '\n');
  // 注入批注锚点标记（基于源文本偏移，与 textarea 一致）
  const n = note || (typeof getActiveNote === 'function' ? getActiveNote() : null);
  cleaned = injectNoteAnnotations(cleaned, n);
  let html = formatMarkdownBase(cleaned);
  // 批注标记 → 高亮 <mark>（⟦id⟧ / ⟦/id⟧ 不受 markdown 处理影响）
  html = html.replace(/\u27E6([A-Za-z0-9_-]+)\u27E7/g, '<mark class="note-ann" data-id="$1">');
  html = html.replace(/\u27E6\/([A-Za-z0-9_-]+)\u27E7/g, '</mark>');
  return html;
}

// ═══════════ AI Chat: 选中文字右键保存为笔记 ═══════════
let _aiCtxSelection = '';    // 纯文本（用于复制）
let _aiCtxMarkdown = '';     // 还原为 Markdown（用于保存为笔记，保留表格/分隔线等格式）

// 右键在 AI 消息区内且存在选中文字时，显示"保存为笔记"菜单
function showAiChatContextMenu(e) {
  const container = document.getElementById('aiMessages');
  if (!container || !container.contains(e.target)) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return; // 无选中文字 → 走默认右键菜单
  const text = sel.toString().trim();
  // 确保选区位于 AI 聊天区域之内
  if (!container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) return;
  // 同时捕获选区 HTML 并还原为 Markdown（表格/分隔线等格式化内容不丢失）
  const md = selectionToMarkdown();
  if (!text && !md) return;
  e.preventDefault();
  _aiCtxSelection = text;
  _aiCtxMarkdown = md;
  const menu = document.getElementById('aiChatContextMenu');
  if (!menu) return;
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.classList.add('visible');
  // 边界修正：菜单不超出视口
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  if (rect.right > vw) menu.style.left = Math.max(0, vw - rect.width - 6) + 'px';
  if (rect.bottom > vh) menu.style.top = Math.max(0, vh - rect.height - 6) + 'px';
}

function closeAiChatContextMenu() {
  const menu = document.getElementById('aiChatContextMenu');
  if (menu) menu.classList.remove('visible');
  _aiCtxSelection = '';
  _aiCtxMarkdown = '';
}

function saveAiSelectionAsNote() {
  // 优先保存还原后的 Markdown，保留表格/分隔线/代码块/标题等格式
  const text = (_aiCtxMarkdown || _aiCtxSelection || '').trim();
  closeAiChatContextMenu();
  if (!text) return;
  const note = {
    id: genId(), type: 'note', title: '', content: text,
    summary: '', _summaryFresh: false, parentId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    _reviewHistory: [], _skipReview: false, tags: []
  };
  notes.push(note);
  activeNoteId = note.id;
  localStorage.setItem('study_active_note', activeNoteId);
  saveData('study_notes_v2', notes);
  renderNotes();
  showAiToast('已保存为笔记 📝');
}

function copyAiSelection() {
  const text = _aiCtxSelection || '';
  closeAiChatContextMenu();
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  } else {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (err) {}
    ta.remove();
  }
  showAiToast('已复制选中文字 📋');
}

// 右键「仔细讲解」：把选中文字作为提问，在当前 AI 对话内发送
function askAiExplainSelection() {
  const text = _aiCtxSelection || '';
  closeAiChatContextMenu();
  if (!text) return;
  const input = document.getElementById('aiInput');
  if (!input) return;
  const conv = (typeof getActiveConv === 'function') ? getActiveConv() : null;
  if (!conv) { showAiToast('请先新建或选择一个 AI 对话'); return; }
  // 拼装提问：引用选中内容 + 指示 AI 深入讲解（在当前对话内继续，保留上下文）
  input.value = '请仔细讲解下面这段内容，拆解其中涉及的概念，补充直觉、例子与易错点：\n\n' + text;
  autoResizeAiInput();
  // 交给统一发送入口（内部处理 loading 时自动进入发送队列，回复完成后自动发送）
  if (typeof sendAiMessage === 'function') sendAiMessage();
}

// ── 选区 HTML → Markdown ──
// 将选区克隆为 DOM，再逆向还原为 Markdown，以保留表格、分隔线、代码块、标题等格式。
function selectionToMarkdown() {
  try {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
    const container = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) {
      container.appendChild(sel.getRangeAt(i).cloneContents());
    }
    let md = Array.from(container.childNodes).map(nodeToMarkdown).join('');
    md = md.replace(/\n{3,}/g, '\n\n').trim();
    return md;
  } catch (e) {
    return '';
  }
}

function nodeToMarkdown(node) {
  if (!node) return '';
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = node.tagName.toLowerCase();
  const children = () => Array.from(node.childNodes).map(nodeToMarkdown).join('');
  switch (tag) {
    case 'br': return '\n';
    case 'hr': return '\n\n---\n\n';
    case 'p': return '\n\n' + children().replace(/\n+$/, '') + '\n\n';
    case 'strong': case 'b': return '**' + children() + '**';
    case 'em': case 'i': return '*' + children() + '*';
    case 'code': {
      const value = children();
      const marker = value.includes('`') ? '``' : '`';
      return marker + value + marker;
    }
    case 'pre': {
      const code = node.querySelector('code');
      const languageClass = code ? Array.from(code.classList).find(c => c.startsWith('language-')) : '';
      const language = languageClass ? languageClass.slice('language-'.length) : '';
      return '\n\n```' + language + '\n' + (code ? code.textContent : node.textContent).replace(/\n$/, '') + '\n```\n\n';
    }
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + children() + '\n\n';
    case 'ul': case 'ol': {
      const items = Array.from(node.children)
        .filter(c => c.tagName === 'LI')
        .map((li, i) => (tag === 'ul' ? '- ' : (i + 1) + '. ') + nodeToMarkdown(li));
      return '\n\n' + items.join('\n') + '\n\n';
    }
    case 'li': {
      const checkbox = node.querySelector(':scope > input[type="checkbox"]');
      return (checkbox ? '[' + (checkbox.checked ? 'x' : ' ') + '] ' : '') + children();
    }
    case 'table': return tableToMarkdown(node);
    case 'tr': { // 选区仅覆盖部分行（无 <table> 包裹）时尽力还原
      const cells = Array.from(node.children)
        .filter(c => c.tagName === 'TD' || c.tagName === 'TH')
        .map(c => nodeToInline(c).trim());
      return cells.length ? '| ' + cells.join(' | ') + ' |' : '';
    }
    case 'th': case 'td': return nodeToInline(node);
    case 'blockquote': return '\n\n> ' + children().replace(/\n/g, '\n> ') + '\n\n';
    case 'del': case 's': return '~~' + children() + '~~';
    case 'span':
      if (node.classList.contains('katex')) return katexToLatex(node);
      return children(); // ai-action-link 等保留其文字
    case 'a': {
      const href = node.getAttribute('href') || '';
      if (!href) return children();
      const title = node.getAttribute('title');
      return '[' + children() + '](' + href + (title ? ' "' + title.replace(/"/g, '\\"') + '"' : '') + ')';
    }
    case 'img': {
      const src = node.getAttribute('src') || '';
      const alt = node.getAttribute('alt') || '';
      const title = node.getAttribute('title');
      return src ? '![' + alt + '](' + src + (title ? ' "' + title.replace(/"/g, '\\"') + '"' : '') + ')' : alt;
    }
    case 'input': return '';
    case 'div':
      // 跳过聊天界面装饰性元素，避免混入时间戳/按钮等噪音
      if (node.classList.contains('ai-chat-time') || node.classList.contains('ai-chat-keyname') ||
          node.classList.contains('ai-chat-avatar') || node.classList.contains('ai-reasoning-toggle') ||
          node.classList.contains('ai-msg-controls') || node.classList.contains('ai-tool-call-toggle')) return '';
      return '\n' + children() + '\n';
    case 'details': case 'summary': case 'button': return ''; // 附件/按钮等界面元素不纳入
    default: return children();
  }
}

// 表格节点 → Markdown 表格（首行为 th 时生成表头分隔行）
function tableToMarkdown(table) {
  const rows = [];
  table.querySelectorAll('tr').forEach(tr => {
    const cells = [];
    tr.querySelectorAll('th, td').forEach(c => {
      cells.push(nodeToInline(c).trim().replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|'));
    });
    if (cells.length) rows.push(cells);
  });
  if (!rows.length) return '';
  const hasHeader = table.querySelector('tr th') !== null;
  let md = '';
  rows.forEach((cells, i) => {
    md += (i > 0 ? '\n' : '') + '| ' + cells.join(' | ') + ' |';
    if (i === 0 && hasHeader) md += '\n| ' + cells.map(() => '---').join(' | ') + ' |';
  });
  return '\n\n' + md + '\n\n';
}

// 行内内容（用于表格单元格等，只保留加粗/斜体/行内代码）
function nodeToInline(node) {
  if (!node) return '';
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = node.tagName.toLowerCase();
  const children = () => Array.from(node.childNodes).map(nodeToInline).join('');
  switch (tag) {
    case 'br': return ' ';
    case 'strong': case 'b': return '**' + children() + '**';
    case 'em': case 'i': return '*' + children() + '*';
    case 'code': {
      const value = children();
      const marker = value.includes('`') ? '``' : '`';
      return marker + value + marker;
    }
    case 'del': case 's': return '~~' + children() + '~~';
    case 'span': return node.classList.contains('katex') ? katexToLatex(node) : children();
    case 'a': {
      const href = node.getAttribute('href') || '';
      return href ? '[' + children() + '](' + href + ')' : children();
    }
    default: return children();
  }
}

// 从 KaTeX 渲染结果还原原始 LaTeX（MathML 的 annotation 携带 TeX 源）
function katexToLatex(node) {
  const ann = node.querySelector('annotation[encoding="application/x-tex"]');
  if (ann && ann.textContent) return ' $' + ann.textContent.trim() + '$ ';
  return node.textContent.trim();
}

// 轻量 toast 提示（保存/复制成功后反馈）
function showAiToast(msg) {
  let toast = document.getElementById('aiToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'aiToast';
    toast.className = 'ai-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('visible'), 2000);
}

// 全局右键：仅当目标是 AI 消息区时接管；否则恢复默认并关闭本菜单
document.addEventListener('contextmenu', function(e) {
  const container = document.getElementById('aiMessages');
  if (container && container.contains(e.target)) {
    showAiChatContextMenu(e);
  } else {
    closeAiChatContextMenu();
  }
});
document.addEventListener('click', function(e) {
  const todoLink = e.target.closest && e.target.closest('.ai-action-link[data-todo-id]');
  if (todoLink) {
    e.stopPropagation();
    aiNavigateToTodo(Number(todoLink.dataset.todoId));
  }
  if (!e.target.closest('#aiChatContextMenu')) closeAiChatContextMenu();
});
document.addEventListener('keydown', function(e) {
  const todoLink = e.target.closest && e.target.closest('.ai-action-link[data-todo-id]');
  if (todoLink && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    aiNavigateToTodo(Number(todoLink.dataset.todoId));
    return;
  }
  if (e.key === 'Escape') closeAiChatContextMenu();
});
