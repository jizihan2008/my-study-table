// ═══════════════════════════════════════════════
//  AI 发送与交互：消息发送、候选回复管理、工具栏、快速操作
// ═══════════════════════════════════════════════

// ═══════════ Send/stop button handler ═══════════
function handleAiSendOrStop() {
  const convId = getActiveConvId();
  if (isAiLoading(convId)) {
    // Stop the AI for this conversation
    setAiStopRequested(convId, true);
    updateAiSendButton();
  } else {
    sendAiMessage();
  }
}

function updateAiSendButton() {
  const sendBtn = document.getElementById('aiSendBtn');
  const sendIcon = document.getElementById('aiSendIcon');
  if (!sendBtn || !sendIcon) return;
  if (isAiLoading(getActiveConvId())) {
    sendBtn.title = '停止';
    sendBtn.style.background = 'var(--danger, #ef4444)';
    sendBtn.style.borderColor = 'var(--danger, #ef4444)';
    sendIcon.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>';
    sendBtn.disabled = false;
  } else {
    sendBtn.title = '发送';
    sendBtn.style.background = '';
    sendBtn.style.borderColor = '';
    sendIcon.innerHTML = '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>';
    sendBtn.disabled = false;
  }
}

async function sendAiMessage() {
  if (isAiLoading(getActiveConvId())) return null;
  const input = document.getElementById('aiInput');
  if (!input) return null;
  const text = input.value.trim();
  // Allow empty text if there are attachments
  if (!text && aiAttachments.length === 0) return null;
  // Clear draft for this conv before sending
  clearAiDraft();
  const apiCfg = getEffectiveApiConfig();
  if (!apiCfg.apiKey) { openSettingsModal(); return null; }

  const conv = getActiveConv();
  if (!conv) return null;

  // Snapshot current attachments
  const currentAttachments = [...aiAttachments];

  const displayAttachments = currentAttachments.map(a => ({ name: a.name, size: a.size }));

  // Process attachments: for Kimi use file upload API, for others read as txt
  let docTexts = '';
  const isKimi = isKimiModel();
  if (isDebugMode()) console.log('[DEBUG sendAiMessage] isKimi:', isKimi, 'attachments:', currentAttachments.length);
  // Collect vision file references (base64 data URLs) for multimodal content
  let visionFiles = [];
  for (const a of currentAttachments) {
    try {
      if (isKimi) {
        if (isVisionFile(a.file)) {
          // Video: must upload to Kimi first, reference via ms://<fileId>
          if (isVideoFile(a.file)) {
            if (isDebugMode()) console.log('[DEBUG] Video upload', a.name);
            const fileId = await uploadVideoToKimi(a.file);
            visionFiles.push({
              fileId: fileId,
              name: a.name,
              type: 'video_url'
            });
          } else if (a.ocrMode) {
            // OCR mode: upload to Kimi file-extract for text extraction
            if (isDebugMode()) console.log('[DEBUG] Vision path: OCR upload', a.name);
            const content = await uploadToKimi(a.file);
            const maxLen = 80000;
            const truncated = content.length > maxLen ? content.slice(0, maxLen) + '\n\n[内容过长，已截断...]' : content;
            docTexts += `\n\n[附件(OCR)：${a.name}]\n` + truncated;
            const idx = displayAttachments.findIndex(d => d.name === a.name && !d.content);
            if (idx >= 0) displayAttachments[idx].content = truncated;
          } else {
            // Image inline mode: read as base64 data URL for multimodal analysis
            if (isDebugMode()) console.log('[DEBUG] Vision path: reading as base64', a.name);
            const dataUrl = await readFileAsDataURL(a.file);
            visionFiles.push({
              dataUrl: dataUrl,
              name: a.name,
              type: 'image_url'
            });
          }
        } else {
          if (isDebugMode()) console.log('[DEBUG] Doc path: uploading', a.name);
          // Document: use file-extract for text/OCR extraction
          const content = await uploadToKimi(a.file);
          const maxLen = 80000;
          const truncated = content.length > maxLen ? content.slice(0, maxLen) + '\n\n[内容过长，已截断...]' : content;
          docTexts += `\n\n[附件：${a.name}]\n` + truncated;
          const idx = displayAttachments.findIndex(d => d.name === a.name && !d.content);
          if (idx >= 0) displayAttachments[idx].content = truncated;
        }
      } else {
        // Read .txt files as text content
        const content = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = e => resolve(e.target.result);
          reader.onerror = reject;
          reader.readAsText(a.file);
        });
        const maxLen = 8000;
        const truncated = content.length > maxLen ? content.slice(0, maxLen) + '\n\n[内容过长，已截断...]' : content;
        docTexts += `\n\n[附件：${a.name}]\n` + truncated;
        const idx = displayAttachments.findIndex(d => d.name === a.name && !d.content);
        if (idx >= 0) displayAttachments[idx].content = truncated;
      }
    } catch (err) {
      docTexts += `\n\n[附件：${a.name} — 读取失败: ${err.message}]`;
    }
  }

  // Build user message content
  const userContent = text + docTexts;

  if (isDebugMode()) console.log('[DEBUG sendAiMessage] docTexts:', docTexts.slice(0,200), 'visionFiles:', JSON.stringify(visionFiles));

  const now = new Date();
  const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const userMsg = { role: 'user', content: userContent, time: timeStr };
  if (displayAttachments.length > 0) {
    userMsg.attachments = displayAttachments;
  }
  // Store vision file refs for multimodal API calls (ms://<file-id>)
  if (visionFiles.length > 0) {
    userMsg.visionFiles = visionFiles;
  }
  // 记录待生成标记（刷新/重启后据此自动恢复被中断的 AI 回复）
  const _pendingUserNodeId = appendMessage(conv, userMsg);
  safeSaveAiConvs();
  if (_pendingUserNodeId) {
    try { localStorage.setItem('study_ai_pending', JSON.stringify({ convId: conv.id, userNodeId: _pendingUserNodeId, at: Date.now() })); } catch {}
  }

  // Clear attachments
  aiAttachments = [];
  renderAttachPreview();

  // AI Auto-title — regenerate after every exchange
  const shouldAutoTitle = conv.messages.filter(m => m.role === 'user').length >= 1;

  let didReRender = false;
  if (conv.title.startsWith('新对话 ') && conv.messages.filter(m => m.role === 'user').length === 1) {
    conv.title = text ? (text.length > 20 ? text.slice(0, 20) + '…' : text) : '附件对话';
    safeSaveAiConvs();
    didReRender = true;
    renderAiChat();
  }

  if (!didReRender) {
    input.value = '';
    input.style.height = 'auto';
  }
  setAiLoading(conv.id, true);
  renderAiMessages();
  updateAiSendButton();

  // Debug
  const deepThinkParams = buildDeepThinkParams(apiCfg);
  console.log('[API] model:', apiCfg.model, 'deepThink:', apiCfg.deepThink, 'deepThinkParams:', JSON.stringify(deepThinkParams));

  let aiReplyText = null; // 最终回复文本（供调用方回填等使用）
  try {
    const loopRes = await runToolCallLoop(apiCfg, conv, null);
    let finalCleanText = loopRes.finalCleanText;
    const finalRawReply = loopRes.finalRawReply;
    const finalReasoning = loopRes.finalReasoning;
    aiReplyText = finalCleanText || null;
    // max_tokens 截断（finish_reason='length'）→ 自动续写一次，让回复完整
    if (loopRes.finishReason === 'length') {
      const more = (typeof continueTruncatedReply === 'function') ? await continueTruncatedReply(apiCfg, conv, finalCleanText) : '';
      if (more) finalCleanText = (finalCleanText || '').replace(/\s+$/, '') + '\n' + more;
      else finalCleanText += '\n\n⚠️（回复因长度限制被截断，可调大 Max Tokens 或发送「继续」）';
      aiReplyText = finalCleanText;
    }

    // Build the final assistant message
    const keyName = getActiveKeyDisplayName();
    const finalAssistantMsg = { role: 'assistant', content: finalCleanText, time: timeStr, keyName };
    if (finalReasoning) finalAssistantMsg.reasoning = finalReasoning;
    appendMessage(conv, finalAssistantMsg);
    safeSaveAiConvs();
    sendAiNotification(conv, finalCleanText, keyName);

    // ── Parse <memory> tags from AI raw response ──
    // Use finalRawReply (the original AI reply before <memory> stripping)
    if (typeof parseMemoryTags === 'function') {
      parseMemoryTags(finalRawReply || finalCleanText, conv.id, conv.title);
    }

    // ═══ call_ai queue: check if the AI requested another AI to respond ═══
    // (For simplicity, the call_ai chain is still pushed as a separate message after the candidate.)
    const callAiMatch = finalCleanText.match(/<call_ai>\s*({[\s\S]*?})\s*<\/call_ai>/);
    if (callAiMatch) {
      try {
        const callAiParams = JSON.parse(callAiMatch[1]);
        const errMsg = await executeCallAiAndPush(callAiParams, conv);
        if (errMsg) {
          appendMessage(conv, { role: 'assistant', content: errMsg, time: timeStr, keyName: getActiveKeyDisplayName() });
          safeSaveAiConvs();
          sendAiNotification(conv, errMsg, getActiveKeyDisplayName());
        }
        renderAiMessages();
      } catch (e) {
        console.warn('[call_ai] parse/exec error:', e);
      }
    }
  } catch (err) {
    const errorMsg = '❌ 出错了：' + err.message;
    const errMsg = { role: 'assistant', content: errorMsg + '\n\n请检查 API Key 和网络连接是否正确。', time: timeStr, keyName: getActiveKeyDisplayName() };
    appendMessage(conv, errMsg);
    safeSaveAiConvs();
    sendAiNotification(conv, errorMsg, getActiveKeyDisplayName());
  }

  // Always reset loading state for this conversation
  setAiLoading(conv.id, false);
  setAiStopRequested(conv.id, false);
  // 已生成/已停止/已失败：清除待生成标记（避免下次启动误判为"被中断"）
  try { localStorage.removeItem('study_ai_pending'); } catch {}
  renderAiMessages();
  updateAiSendButton();

  // AI Auto-title: trigger after first AI reply is pushed to conversation
  if (shouldAutoTitle && typeof isAutoTitleEnabled === 'function' && isAutoTitleEnabled()) {
    generateConvTitle(conv);
  }

  return aiReplyText;
}

// ═══════════ 树状对话：候选分支导航 ═══════════
// 数据模型：一个 user 节点的多个 child 分支 = 多个候选回复。
// 切换候选 = 在 user 节点的 children 间切换活跃路径（switchBranch）。
// navigateCandidateBranch(userNodeId, delta)：在兄弟分支间循环切换。
// 切换候选分支：在同一父节点的兄弟间循环切换。
// - 传 assistant 节点 → 切换"同一问题重新生成"的候选（user 下的 assistant 兄弟）
// - 传 user 节点 → 切换"编辑产生"的版本（assistant 父下的 user 兄弟）
// （原版通用逻辑，未改底层语义）
function navigateCandidateBranch(userNodeId, delta) {
  const conv = getActiveConv();
  if (!conv || !isTreeConv(conv) || !conv.tree[userNodeId]) return;
  const siblings = siblingNodeIds(conv, userNodeId);
  if (siblings.length === 0) return;
  const n = siblings.length + 1; // 含自己
  const curIdx = siblings.indexOf(userNodeId);
  const newIdx = (curIdx + delta + n) % n;
  const targetId = newIdx === curIdx ? userNodeId : siblings[newIdx];
  switchBranch(conv, targetId);
  safeSaveAiConvs();
  renderAiMessages();
}

// "采用本条"：树模式下当前活跃分支即被采用（无需额外动作），
// 仅作向后兼容占位，确保渲染按钮 onclick 不报错。
function adoptCandidate(userNodeId) {
  const conv = getActiveConv();
  if (!conv) return;
  safeSaveAiConvs();
  renderAiMessages();
}

// 旧函数名占位（树模式下无需"取消采用"）
function unadoptCandidate() {
  const conv = getActiveConv();
  if (!conv) return;
  safeSaveAiConvs();
  renderAiMessages();
}

async function regenerateAiMessage(nodeId) {
  const conv = getActiveConv();
  if (!conv || isAiLoading(conv.id)) return;
  ensureTree(conv); // 防御：确保 conv 已迁移为树

  // 树模式：在指定节点（user 或 assistant）下生成新分支。
  // 若传入 assistant 节点，向上找到最近的 user 节点作为分叉点。
  let userNodeId = nodeId;
  if (conv.tree[nodeId]) {
    const node = conv.tree[nodeId];
    if (node.role === 'assistant') {
      let cur = nodeId;
      while (cur && conv.tree[cur]) {
        const n = conv.tree[cur];
        if (n.role === 'user') { userNodeId = cur; break; }
        cur = n.parentId;
      }
    }
  }
  if (!isTreeConv(conv) || !conv.tree[userNodeId] || conv.tree[userNodeId].role !== 'user') return;

  await regenerateFromUserNode(conv, userNodeId);
}

// 核心：从指定 user 节点重新生成回复（在其下新建分支）。
// 被 regenerateAiMessage（换一条）与 sendEditedMessage（编辑后发送）复用。
async function regenerateFromUserNode(conv, userNodeId) {
  if (!conv || !conv.tree[userNodeId] || conv.tree[userNodeId].role !== 'user') return;
  const apiCfg = getEffectiveApiConfig();
  if (!apiCfg.apiKey) return;

  // 切换到该 user 节点，使 runToolCallLoop 的 appendMessage 落在其下，自动形成新分支
  switchBranch(conv, userNodeId);
  setAiLoading(conv.id, true);
  updateAiSendButton();
  // 重新生成同样记录待生成标记（刷新中断后自动续传）
  try { localStorage.setItem('study_ai_pending', JSON.stringify({ convId: conv.id, userNodeId, at: Date.now() })); } catch {}

  try {
    const loopRes = await runToolCallLoop(apiCfg, conv, null);
    let finalCleanText = loopRes.finalCleanText;
    const finalRawReply = loopRes.finalRawReply;
    const finalReasoning = loopRes.finalReasoning;
    // max_tokens 截断（finish_reason='length'）→ 自动续写一次，让回复完整
    if (loopRes.finishReason === 'length') {
      const more = (typeof continueTruncatedReply === 'function') ? await continueTruncatedReply(apiCfg, conv, finalCleanText) : '';
      if (more) finalCleanText = (finalCleanText || '').replace(/\s+$/, '') + '\n' + more;
      else finalCleanText += '\n\n⚠️（回复因长度限制被截断，可调大 Max Tokens 或发送「继续」）';
    }

    // runToolCallLoop 已通过 appendMessage 追加中间工具消息与最终回复，
    // 自动形成 user 节点下的新分支。若无任何追加（异常兜底），则手动创建。
    const lastNode = conv.tree[conv.activePath[conv.activePath.length - 1]];
    if (!lastNode || lastNode.role === 'user') {
      const keyName = getActiveKeyDisplayName();
      const timeStr = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      const finalAssistantMsg = { role: 'assistant', content: finalCleanText || '（未收到回复）', time: timeStr, keyName };
      if (finalReasoning) finalAssistantMsg.reasoning = finalReasoning;
      createBranch(conv, userNodeId, finalAssistantMsg);
    }
    safeSaveAiConvs();
    sendAiNotification(conv, finalCleanText, getActiveKeyDisplayName());

    // Parse <memory> tags (only from the most recent reply)
    if (typeof parseMemoryTags === 'function') {
      parseMemoryTags(finalRawReply || finalCleanText, conv.id, conv.title);
    }
  } catch (err) {
    const errorMsg = '❌ 出错了：' + err.message;
    const errMsg = { role: 'assistant', content: errorMsg + '\n\n请检查 API Key 和网络连接是否正确。', time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), keyName: getActiveKeyDisplayName() };
    createBranch(conv, userNodeId, errMsg);
    safeSaveAiConvs();
    sendAiNotification(conv, errorMsg, getActiveKeyDisplayName());
  }

  setAiLoading(conv.id, false);
  setAiStopRequested(conv.id, false);
  try { localStorage.removeItem('study_ai_pending'); } catch {}
  renderAiMessages();
  updateAiSendButton();
}

// 编辑消息后发送：在原 user 节点父节点下创建「编辑后新 user 分支」，
// 再像重新生成一样在其下生成 AI 回复（👤 b' → 🤖 回复B'）。
async function sendEditedMessage(nodeId, newText) {
  const conv = getActiveConv();
  if (!conv || isAiLoading(conv.id)) return;
  ensureTree(conv);
  const text = (newText || '').trim();
  if (!text) return;

  // 找到目标 user 节点（编辑入口通常传 user 节点 id）
  let userNodeId = nodeId;
  if (conv.tree[nodeId]) {
    const node = conv.tree[nodeId];
    if (node.role === 'assistant') {
      let cur = nodeId;
      while (cur && conv.tree[cur]) {
        const n = conv.tree[cur];
        if (n.role === 'user') { userNodeId = cur; break; }
        cur = n.parentId;
      }
    }
  }
  if (!isTreeConv(conv) || !conv.tree[userNodeId] || conv.tree[userNodeId].role !== 'user') return;

  // 创建编辑后的新 user 分支（与原文并列），并切换过去
  const newUserId = createBranchFromEdit(conv, userNodeId, text, { time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) });
  if (newUserId === null) return;
  safeSaveAiConvs();

  // 在其下重新生成回复（类似重新生成）
  await regenerateFromUserNode(conv, newUserId);
}

// ═══════════ AI Toolbar (Key select + Toggles + Quick actions) ═══════════
function initAiToolbar() {
  const select = document.getElementById('aiToolbarKeySelect');
  if (!select) return;
  const keys = loadApiKeys();
  const activeId = getActiveApiKeyId();
  select.innerHTML = keys.map(k =>
    `<option value="${k.id}" ${k.id === activeId ? 'selected' : ''}>${escapeHtml(k.name)}</option>`
  ).join('');
  if (keys.length === 0) {
    select.innerHTML = '<option value="">未配置 Key</option>';
  }

  // Restore deep think toggle state
  const dtBtn = document.getElementById('aiToolbarDeepThinkBtn');
  if (dtBtn) {
    const activeKey = keys.find(k => k.id === activeId);
    dtBtn.classList.toggle('active', activeKey?.deepThink === true);
  }

  // Restore web search toggle state (per-conversation)
  const wsBtn = document.getElementById('aiToolbarWebSearchBtn');
  if (wsBtn) {
    const conv = getActiveConv();
    const isKimi = typeof isKimiModel === 'function' && isKimiModel();
    if (isKimi && conv) {
      updateWebSearchBtn(wsBtn, conv._webSearchMode || null);
    } else {
      wsBtn.classList.toggle('active', conv?._webSearchEnabled === true);
      // Reset button text for non-Kimi
      const span = wsBtn.querySelector('span');
      if (span) span.textContent = '智能搜索';
      wsBtn.title = '联网搜索';
      wsBtn.classList.remove('kimi-native', 'kimi-external');
    }
  }

  // Reset quick action dropdown
  const quickSelect = document.getElementById('aiToolbarQuick');
  if (quickSelect) quickSelect.value = '';
  // Re-render Lucide icons (the toolbar was just created/updated in DOM)
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}

function onAiToolbarKeyChange() {
  const select = document.getElementById('aiToolbarKeySelect');
  if (!select || !select.value) return;
  switchActiveKey(select.value);
  // Update deep think toggle to match the new key's setting
  const keys = loadApiKeys();
  const key = keys.find(k => k.id === select.value);
  const dtCheckbox = document.getElementById('aiToolbarDeepThink');
  if (dtCheckbox && key) dtCheckbox.checked = key.deepThink === true;
}

function toggleAiDeepThink() {
  const btn = document.getElementById('aiToolbarDeepThinkBtn');
  if (!btn) return;
  const newState = !btn.classList.contains('active');
  btn.classList.toggle('active', newState);
  const keys = loadApiKeys();
  const activeId = getActiveApiKeyId();
  const key = keys.find(k => k.id === activeId);
  if (key) {
    key.deepThink = newState;
    saveApiKeys(keys);
  }
}

function toggleAiWebSearch() {
  const btn = document.getElementById('aiToolbarWebSearchBtn');
  if (!btn) return;
  const conv = getActiveConv();
  if (!conv) return;
  const isKimi = typeof isKimiModel === 'function' && isKimiModel();

  if (isKimi) {
    // Kimi: cycle null → 'native' → 'external' → null
    const current = conv._webSearchMode || null;
    let next;
    if (!current) next = 'native';
    else if (current === 'native') next = 'external';
    else next = null;
    conv._webSearchMode = next;
    updateWebSearchBtn(btn, next);
  } else {
    // Non-Kimi: simple on/off
    const newState = !btn.classList.contains('active');
    btn.classList.toggle('active', newState);
    conv._webSearchEnabled = newState;
  }
  safeSaveAiConvs();
}

function updateWebSearchBtn(btn, mode) {
  const span = btn.querySelector('span');
  btn.classList.remove('active', 'kimi-native', 'kimi-external');
  if (mode === 'native') {
    btn.classList.add('active', 'kimi-native');
    btn.title = 'Kimi 原生联网搜索';
    if (span) span.textContent = '原生搜索';
  } else if (mode === 'external') {
    btn.classList.add('active', 'kimi-external');
    btn.title = '外部引擎搜索 (Brave/Tavily)';
    if (span) span.textContent = '外部搜索';
  } else {
    btn.title = '联网搜索';
    if (span) span.textContent = '智能搜索';
  }
}

function onAiToolbarQuickChange() {
  const select = document.getElementById('aiToolbarQuick');
  if (!select || !select.value) return;
  const prompt = select.value;
  select.value = ''; // Reset immediately
  // Put the prompt into the input box (don't send)
  const input = document.getElementById('aiInput');
  if (!input) return;
  input.value = prompt;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  input.focus();
}

// ═══════════ AI Quick Action (legacy, kept for reference) ═══════════
function aiQuickAction(prompt) {
  const input = document.getElementById('aiInput');
  if (!input) return;
  const apiCfg = getEffectiveApiConfig();
  if (!apiCfg.apiKey) { openSettingsModal(); return; }
  input.value = prompt;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  input.focus();
  // Auto-send the quick action
  sendAiMessage();
}

// ═══════════ AI: Navigate to Todo from Chat ═══════════
function aiNavigateToTodo(todoId) {
  const t = findTodo(todoId);
  if (!t) return;
  document.getElementById('todoSearch').value = '';
  todoSearchQuery = '';
  const searchClear = document.getElementById('searchClear');
  if (searchClear) searchClear.classList.remove('visible');
  currentTodoRoot = t.parentId;
  activeSubInputId = null;
  switchTab('todo');
  renderTodos();
}

// ═══════════ AI: Toggle Todo from Chat ═══════════
function aiToggleTodo(todoId) {
  const t = findTodo(todoId);
  if (!t) return;
  t.done = !t.done;
  if (t.done) {
    t.completedAt = formatDate(new Date());
    const descendantIds = getAllDescendantIds(todoId).filter(did => did !== todoId);
    for (const did of descendantIds) {
      const d = findTodo(did);
      if (d) { d.done = true; if (!d.completedAt) d.completedAt = formatDate(new Date()); }
    }
  } else {
    // 取消勾选时清除完成时间（与 UI 的 toggleTodo 保持一致）
    delete t.completedAt;
  }
  saveData('study_todos_v2', todos);
  renderTodos();
  renderToday();
  renderAiMessages();
}

// ═══════════ 刷新/重启后恢复被中断的 AI 回复 ═══════════
// 发送/重新生成时写入 study_ai_pending { convId, userNodeId }，完成/停止/失败后清除。
// 若刷新打断（fetch 中断、loading 状态丢失），启动时检测到该标记且对应 user 节点下
// 还没有 assistant 回复，则自动切回该节点重新生成，实现"AI 对话不被打断"。
function resumeInterruptedAiReply() {
  let pending = null;
  try { pending = JSON.parse(localStorage.getItem('study_ai_pending') || 'null'); } catch {}
  try { localStorage.removeItem('study_ai_pending'); } catch {}
  if (!pending || !pending.convId) return;
  if (typeof aiConvs === 'undefined' || typeof ensureTree !== 'function' || typeof regenerateFromUserNode !== 'function') return;
  const conv = aiConvs.find(c => String(c.id) === String(pending.convId));
  if (!conv) return;
  ensureTree(conv);
  const userNode = conv.tree && conv.tree[pending.userNodeId];
  // 仅当该节点确为 user 且其下尚无 assistant 回复（含工具中间消息）才续传，避免重复消耗 token
  if (!userNode || userNode.role !== 'user') return;
  const kids = userNode.children || [];
  const hasAssistantReply = kids.some(kid => conv.tree[kid] && conv.tree[kid].role === 'assistant');
  if (hasAssistantReply) return;
  if (activeConvId !== conv.id) {
    activeConvId = conv.id;
    try { localStorage.setItem('study_active_conv', conv.id); } catch {}
  }
  setTimeout(() => {
    if (typeof bkShowMiniToast === 'function') bkShowMiniToast('检测到上次 AI 回复被中断，已自动重新生成');
    regenerateFromUserNode(conv, pending.userNodeId);
  }, 300);
}
if (typeof window._aiResumeInited === 'undefined') {
  window._aiResumeInited = true;
  resumeInterruptedAiReply();
}
