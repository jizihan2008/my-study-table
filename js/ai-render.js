// ═══════════════════════════════════════════════
//  AI 渲染：聊天界面、消息列表、Markdown格式化、LaTeX数学公式
// ═══════════════════════════════════════════════

// ═══════════ AI Chat: Rendering ═══════════
function renderAiChat() {
  const layout = document.getElementById('aiChatLayout');
  if (!layout) return;
  const hasApiKey = !!(loadApiKeys().length > 0);

  if (!hasApiKey) {
    layout.innerHTML = `
      <div class="ai-no-key">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M12 2a4 4 0 014 4c0 1.1-.5 2.1-1.2 2.8l3.4 6.5A3 3 0 0115.5 19H8.5a3 3 0 01-2.7-3.7l3.4-6.5A4 4 0 0112 2z"/>
          <circle cx="12" cy="8" r="2"/><path d="M12 22v-2"/>
        </svg>
        <p>尚未配置 AI API Key，请在设置中配置后使用</p>
        <button class="btn-setup" onclick="openSettingsModal()">去设置 <i data-lucide="settings" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle;"></i></button>
      </div>
    `;
    return;
  }

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
    <div class="ai-chat-input-wrap">
      <textarea id="aiInput" placeholder="输入你的问题，回车发送... (可上传 .txt 附件)" rows="1"
                onkeydown="handleAiInputKey(event)"
                oninput="autoResizeAiInput()"></textarea>
      <input type="file" id="aiFileInput" accept=".txt" multiple style="display:none;" onchange="handleAiFileSelect(event)">
      <button class="ai-attach-btn" id="aiAttachBtn" onclick="document.getElementById('aiFileInput').click()" title="上传附件">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
      </button>
      <button class="ai-chat-send-btn" id="aiSendBtn" onclick="handleAiSendOrStop()" title="发送">
        <svg id="aiSendIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
      </button>
    </div>
  `;
  renderAiMessages();
  renderAttachPreview(); // Restore attachment preview after DOM rebuild
  updateAiFileInput(); // Update file input based on current model
  // Restore loading state after DOM rebuild: toggle send/stop button
  updateAiSendButton();
  setTimeout(() => {
    const msgs = document.getElementById('aiMessages');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  }, 100);
  // Restore input draft for current conv
  restoreAiDraft();
  updateSidebarAiBadge();
  // Initialize toolbar state
  initAiToolbar();
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

function renderAiMessages() {
  const container = document.getElementById('aiMessages');
  if (!container) return;
  const conv = getActiveConv();
  if (!conv) return;

  // Build a list of items to render. User messages with _candidates emit both the user msg
  // and the full message chain of the active candidate (DeepSeek-style switching).
  // Standalone assistant/system messages (legacy data) are still rendered.
  // When a user msg has _candidates, skip ALL subsequent standalone messages
  // (assistant + system) that belong to that same exchange — they are duplicates
  // already rendered via the candidate chain. Stop skipping when we hit the next user msg.
  const renderItems = [];
  let skipUntilUser = false;
  for (let idx = 0; idx < conv.messages.length; idx++) {
    const m = conv.messages[idx];
    if (m.role === 'user' && m._candidates && m._candidates.length > 0) {
      skipUntilUser = true;
      renderItems.push({ type: 'user', msg: m, idx });
      const activeCand = getActiveCandidate(m);
      if (activeCand && activeCand.messages) {
        const chain = activeCand.messages;
        for (let ci = 0; ci < chain.length; ci++) {
          const isLast = ci === chain.length - 1;
          renderItems.push({
            type: 'candidate_msg',
            msg: chain[ci],
            userIdx: idx,
            isLastInChain: isLast,
            total: m._candidates.length,
            active: m._activeCandidate || 0
          });
        }
      } else if (activeCand && activeCand.content) {
        // Legacy: single assistant message as candidate
        renderItems.push({
          type: 'candidate_msg',
          msg: activeCand,
          userIdx: idx,
          isLastInChain: true,
          total: m._candidates.length,
          active: m._activeCandidate || 0
        });
      }
    } else if (m.role === 'user') {
      skipUntilUser = false;
      renderItems.push({ type: 'user', msg: m, idx });
    } else if (skipUntilUser) {
      // Skip all messages (assistant + system) that are duplicates of the candidate chain
      continue;
    } else if (m.role === 'assistant') {
      renderItems.push({ type: 'assistant', msg: m, idx });
    } else if (m.role === 'system') {
      renderItems.push({ type: 'system', msg: m, idx });
    }
  }

  container.innerHTML = renderItems.map(item => {
    const m = item.msg;
    if (!m) return ''; // safety: skip items without a message object
    const idx = item.idx;
    const reasoningHtml = m.reasoning ? `
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
      attachHtml = '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">' + m.attachments.map(a => {
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
    if ((item.type === 'system' || item.type === 'candidate_msg') && m._toolInfo) {
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
        'web_search': '🌐 网络搜索'
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
      dataContent = dataContent.replace(/^.*?（共\d+个）\n*/m, '');
      dataContent = dataContent.replace(/\n+$/, ''); // trim trailing newlines
      dataContent = escapeHtml(dataContent);
      return `
        <div class="ai-chat-msg system">
          <div class="ai-chat-avatar">⚙️</div>
          <div class="ai-chat-bubble ai-chat-tool-call">
            <div class="ai-tool-call-toggle" onclick="toggleToolCallData(this)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
              ${label}
            </div>
            <div class="ai-tool-call-data">${dataContent}</div>
          </div>
        </div>
      `;
    }

    // Hide tool_call, call_ai, and memory tags from user-facing messages
    const hasToolCall = typeof cleanContent === 'string' && /<tool_call>/.test(cleanContent);
    if (typeof cleanContent === 'string') {
      cleanContent = cleanContent
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
        .replace(/<tool_call>[\s\S]*?<tool_call>/g, '')
        .replace(/<call_ai>[\s\S]*?<\/call_ai>/g, '')
        .replace(/<memory>[\s\S]*?<\/memory>/g, '')
        .trim();
    }

    // If the assistant message only contained tool calls (no visible text),
    // show a friendly placeholder instead of an empty bubble.
    const isAssistant = item.type === 'candidate_msg' ? m.role === 'assistant' : (item.type === 'candidate' || item.type === 'assistant');
    let contentHtml = formatAiContent(cleanContent);
    if (!contentHtml && isAssistant && hasToolCall) {
      contentHtml = '<span class="ai-tool-placeholder">🔧 正在执行操作...</span>';
    }

    const timeLabel = m.time ? `<div class="ai-chat-time">${m.time}</div>` : '';
    const keyNameHtml = (isAssistant && m.keyName) ? `<div class="ai-chat-keyname">🔑 ${escapeHtml(m.keyName)}</div>` : '';

    // Bottom controls for candidate (DeepSeek-style): pager + regen + adopt
    // Attached to the last candidate_msg in the chain
    let bottomHtml = '';
    if (item.type === 'candidate_msg' && item.isLastInChain) {
      const userMsg = conv.messages[item.userIdx];
      const isAdopted = userMsg && userMsg._adopted;
      const canNav = item.total > 1 && !isAdopted;
      const prevDisabled = !canNav ? 'disabled' : '';
      const nextDisabled = !canNav ? 'disabled' : '';
      const userIdx = item.userIdx;
      const pagerHtml = canNav
        ? `<button class="ai-msg-cand-nav" onclick="navigateCandidate(${userIdx}, -1)" title="上一条" ${prevDisabled}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <span class="ai-msg-cand-count">${item.active + 1} / ${item.total}</span>
          <button class="ai-msg-cand-nav" onclick="navigateCandidate(${userIdx}, 1)" title="下一条" ${nextDisabled}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="9 18 15 12 9 6"/></svg>
          </button>`
        : '';
      const regenBtn = (!isAiLoading(conv.id) && !isAdopted) ? `<button class="ai-msg-regen" onclick="regenerateAiMessage(${userIdx})" title="换一条">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
        换一条
      </button>` : '';
      const adoptBtn = (item.total > 1 && !isAiLoading(conv.id) && !isAdopted) ? `<button class="ai-msg-adopt" onclick="adoptCandidate(${userIdx})" title="将这条作为下一条消息的上下文">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>
        采用本条
      </button>` : '';
      if (isAdopted) {
        bottomHtml = item.total > 1
          ? `<div class="ai-msg-controls" style="justify-content:flex-end;">
              <button class="ai-msg-adopted-toggle" onclick="unadoptCandidate(${userIdx})">切换候选 (${item.active + 1}/${item.total})</button>
             </div>`
          : '';
      } else {
        bottomHtml = `<div class="ai-msg-controls">${pagerHtml}<div class="ai-msg-actions">${regenBtn}${adoptBtn}</div></div>`;
      }
    } else if (item.type === 'assistant') {
      // Legacy standalone assistant: keep simple regen
      if (!isAiLoading(conv.id)) {
        bottomHtml = `<button class="ai-msg-regen" onclick="regenerateAiMessage(${idx})" title="重新生成">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
          重新生成
        </button>`;
      }
    }

    const roleClass = isAssistant ? 'assistant' : (item.type === 'system' || (item.type === 'candidate_msg' && m._toolInfo) ? 'system' : 'user');
    const avatar = isAssistant ? '🤖' : (item.type === 'system' || (item.type === 'candidate_msg' && m._toolInfo) ? '⚙️' : '👤');
    const kimiSearchBadge = (m._kimiSearchResult) ? '<div class="ai-kimi-search-badge">🔍 Kimi 联网搜索</div>' : '';

    return `
      <div class="ai-chat-msg ${roleClass}">
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
  if (isAiLoading(conv.id) && conv.messages.length > 0) {
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
  container.scrollTop = container.scrollHeight;
}

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

// Apply inline markdown formatting (bold, italic, inline code) to a string
function formatInline(text) {
  let s = text;
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  return s;
}

// ── Simple LaTeX math to HTML converter ──
// Wraps bare LaTeX commands (without \( ... \) delimiters) in inline math
function wrapBareLatex(text) {
  if (typeof text !== 'string') return text;
  // Split by existing math delimiters \(...\), \[...\], and $$...$$, only wrap outside parts.
  let result = '';
  let i = 0;
  while (i < text.length) {
    const inlineStart = text.indexOf('\\(', i);
    const displayStart = text.indexOf('\\[', i);
    const dollarDisplayStart = text.indexOf('$$', i);
    // Pick the earliest delimiter
    const candidates = [];
    if (inlineStart !== -1) candidates.push({ pos: inlineStart, end: '\\)', len: 2 });
    if (displayStart !== -1) candidates.push({ pos: displayStart, end: '\\]', len: 2 });
    if (dollarDisplayStart !== -1) candidates.push({ pos: dollarDisplayStart, end: '$$', len: 2 });
    candidates.sort((a, b) => a.pos - b.pos);
    if (candidates.length === 0) {
      result += wrapBareLatexSegment(text.slice(i));
      break;
    }
    const delim = candidates[0];
    result += wrapBareLatexSegment(text.slice(i, delim.pos));
    const endIndex = text.indexOf(delim.end, delim.pos + delim.len);
    if (endIndex === -1) {
      result += wrapBareLatexSegment(text.slice(delim.pos));
      break;
    }
    result += text.slice(delim.pos, endIndex + delim.len);
    i = endIndex + delim.len;
  }
  return result;
}

function wrapBareLatexSegment(segment) {
  // Wrap known LaTeX command expressions in \( ... \).
  // Captures the command plus a small trailing expression (no unbalanced parens).
  return segment.replace(
    /\\(sin|cos|tan|log|ln|exp|lim|sup|inf|min|max|frac|sqrt|theta|Theta|Delta|alpha|beta|gamma|delta|lambda|pi|to|cdot|infty|partial)(?![a-zA-Z])(?:\[([^\]]*)\])?(?:\{([^{}]*)\})?(?:\{([^{}]*)\})?(?:([_^])\{([^{}]*)\})?(?:\s*[a-zA-Z0-9+\-*/^_{}\s]*[a-zA-Z0-9}])?/g,
    '\\($&\\)'
  );
}

// Normalize double backslashes (\\) inside LaTeX to single backslashes.
// AI outputs sometimes escape commands as \\frac, \\sin, etc.; this lets
// KaTeX render them correctly.
// Only normalize \\ before letters (command names), preserve \\ used as
// matrix/array line breaks (followed by space, &, digit, or end of line).
function normalizeLatex(formula) {
  return formula.replace(/\\\\(?=[a-zA-Z])/g, '\\');
}

// ── Shared Markdown-to-HTML base renderer ──
// Escapes HTML, then applies: code blocks, tables, inline code, hr, headings, bold, italic, unordered lists.
// Returns HTML string with placeholders for protected blocks already restored.
function formatMarkdownBase(text, extraProcessor) {
  if (typeof text !== 'string') return '';

  // ── LaTeX math: protect from HTML escaping and markdown processing ──
  // Step 0: Convert $...$ inline math to \(...\) BEFORE any other processing.
  //         This must happen before wrapBareLatex to prevent it from breaking
  //         $...$ blocks (which it doesn't recognise as delimiters).
  //         Negative lookbehind/lookahead ensures we match single $, not $$.
  let prepared = text.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, '\\($1\\)');
  // Step 1: Wrap bare LaTeX commands not already in recognised delimiters
  prepared = wrapBareLatex(prepared);
  const mathBlocks = [];
  // Display math: $$ ... $$ (must process before \[...\] to avoid conflict)
  let html = prepared.replace(/\$\$([\s\S]*?)\$\$/g, (_, formula) => {
    const idx = mathBlocks.length;
    mathBlocks.push(katex.renderToString(normalizeLatex(formula.trim()), { displayMode: true, throwOnError: false }));
    return `%%MATH_DISPLAY_${idx}%%`;
  });
  // Display math: \[ ... \]
  html = html.replace(/\\\[([\s\S]*?)\\\]/g, (_, formula) => {
    const idx = mathBlocks.length;
    mathBlocks.push(katex.renderToString(normalizeLatex(formula), { displayMode: true, throwOnError: false }));
    return `%%MATH_DISPLAY_${idx}%%`;
  });
  // Inline math: \( ... \)
  html = html.replace(/\\\(([\s\S]*?)\\\)/g, (_, formula) => {
    const idx = mathBlocks.length;
    mathBlocks.push(katex.renderToString(normalizeLatex(formula), { displayMode: false, throwOnError: false }));
    return `%%MATH_INLINE_${idx}%%`;
  });

  // Escape HTML (including any remaining LaTeX that wasn't matched)
  html = html
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Code blocks (fenced) — protect from further processing
  const codeBlocks = [];
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${code}</code></pre>`);
    return `%%CODEBLOCK_${idx}%%`;
  });

  // Table: protect from other processing, ensure trailing newline for headings after table
  const tablePlaceholders = [];
  html = html.replace(/(?:^\|[^\n]+\|\s*$\n?)+/gm, (tableBlock) => {
    const rows = tableBlock.trim().split('\n').filter(r => r.includes('|'));
    const dataRows = rows.filter(r => !/^\|[\s\-:|]+\|$/.test(r));
    if (dataRows.length === 0) return tableBlock;
    const hasHeader = rows.length >= 2 && /^\|[\s\-:|]+\|$/.test(rows[1]);
    let tableHtml = '<table>';
    dataRows.forEach((row, i) => {
      const cells = row.split('|').filter(c => c.trim() !== '').map(c => c.trim());
      const tag = (hasHeader && i === 0) ? 'th' : 'td';
      tableHtml += '<tr>' + cells.map(c => `<${tag}>${formatInline(c)}</${tag}>`).join('') + '</tr>';
    });
    tableHtml += '</table>';
    const idx = tablePlaceholders.length;
    tablePlaceholders.push(tableHtml);
    return `%%TABLE_${idx}%%\n`;
  });

  // Inline code — protect from further processing (must be after table since table handles its own inline code)
  const inlineCodes = [];
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${code}</code>`);
    return `%%INLINECODE_${idx}%%`;
  });

  // Horizontal rule --- or *** (use [ \t]* instead of \s* to NOT consume trailing newline)
  html = html.replace(/^(---+|\*\*\*+)[ \t]*$/gm, '<hr>');

  // Headings: #### text, ### text, ## text, # text
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold **text**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic *text* (but not **)
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Unordered list: lines starting with - or * (preserve indentation as left padding)
  html = html.replace(/^(\s*)[-*] (.+)$/gm, (_, indent, content) => {
    const pad = Math.min(indent.length * 8, 120);
    return pad > 0 ? `<li style="padding-left:${pad}px">${content}</li>` : `<li>${content}</li>`;
  });
  html = html.replace(/((?:<li>.*<\/li>\s*)+)/g, '<ul>$1</ul>');

  // Run extra processor before restoring protected blocks
  if (extraProcessor) {
    html = extraProcessor(html);
  }

  // Line breaks (before restoring to avoid breaking SVG/code/tables with embedded \n)
  html = html.replace(/\n/g, '<br>');
  // Cleanup: remove <br> that create unwanted blank lines in/around block-level elements
  html = html.replace(/<\/(ul|ol|table|pre|blockquote|h[1-4])><br>/g, '</$1>');   // after closing tag
  html = html.replace(/<hr><br>/g, '<hr>');                                        // after hr
  html = html.replace(/<br>\s*<\/(ul|ol)>/g, '</$1>');                             // before </ul>/</ol>
  html = html.replace(/<br>\s*(?=<li)/g, '');                                      // between <li> items

  // Restore protected blocks
  html = html.replace(/%%TABLE_(\d+)%%/g, (_, i) => tablePlaceholders[Number(i)]);
  html = html.replace(/%%INLINECODE_(\d+)%%/g, (_, i) => inlineCodes[Number(i)]);
  html = html.replace(/%%CODEBLOCK_(\d+)%%/g, (_, i) => codeBlocks[Number(i)]);
  // Restore math blocks (must be after other restorations since math may contain inline HTML)
  html = html.replace(/%%MATH_DISPLAY_(\d+)%%/g, (_, i) => mathBlocks[Number(i)]);
  html = html.replace(/%%MATH_INLINE_(\d+)%%/g, (_, i) => mathBlocks[Number(i)]);

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
      return `<span class="ai-action-link" onclick="event.stopPropagation(); aiNavigateToTodo(${escapedId})" title="去目录查看"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>${escapeHtml(t.text.length > 15 ? t.text.slice(0,15)+'…' : t.text)}</span>` + (isDone ? ' ✅' : '');
    });
  });
}

function formatNoteContent(text) {
  // Replace literal \n (backslash-n) with real newlines before markdown processing
  let cleaned = (text || '').replace(/\\n/g, '\n');
  return formatMarkdownBase(cleaned);
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
  const menuW = 190, menuH = 90;
  menu.style.left = Math.min(e.clientX, window.innerWidth - menuW - 8) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - menuH - 8) + 'px';
  menu.classList.add('visible');
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
    case 'code': return '`' + children() + '`';
    case 'pre': return '\n\n```\n' + children() + '\n```\n\n';
    case 'h1': case 'h2': case 'h3': case 'h4':
      return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + children() + '\n\n';
    case 'ul': case 'ol': {
      const items = Array.from(node.children)
        .filter(c => c.tagName === 'LI')
        .map((li, i) => (tag === 'ul' ? '- ' : (i + 1) + '. ') + nodeToMarkdown(li));
      return '\n\n' + items.join('\n') + '\n\n';
    }
    case 'li': return children();
    case 'table': return tableToMarkdown(node);
    case 'tr': { // 选区仅覆盖部分行（无 <table> 包裹）时尽力还原
      const cells = Array.from(node.children)
        .filter(c => c.tagName === 'TD' || c.tagName === 'TH')
        .map(c => nodeToInline(c).trim());
      return cells.length ? '| ' + cells.join(' | ') + ' |' : '';
    }
    case 'th': case 'td': return nodeToInline(node);
    case 'blockquote': return '\n\n> ' + children().replace(/\n/g, '\n> ') + '\n\n';
    case 'span':
      if (node.classList.contains('katex')) return katexToLatex(node);
      return children(); // ai-action-link 等保留其文字
    case 'a': return children();
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
      cells.push(nodeToInline(c).trim().replace(/\s*\n\s*/g, ' '));
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
    case 'code': return '`' + children() + '`';
    case 'span': return node.classList.contains('katex') ? katexToLatex(node) : children();
    case 'a': return children();
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
  if (!e.target.closest('#aiChatContextMenu')) closeAiChatContextMenu();
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeAiChatContextMenu();
});
