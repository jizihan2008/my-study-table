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
  if (isAiLoading(getActiveConvId())) return;
  const input = document.getElementById('aiInput');
  if (!input) return;
  const text = input.value.trim();
  // Allow empty text if there are attachments
  if (!text && aiAttachments.length === 0) return;
  // Clear draft for this conv before sending
  clearAiDraft();
  const apiCfg = getEffectiveApiConfig();
  if (!apiCfg.apiKey) { openSettingsModal(); return; }

  const conv = getActiveConv();
  if (!conv) return;

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
  conv.messages.push(userMsg);
  safeSaveAiConvs();

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

  try {
    const { finalCleanText, finalRawReply, finalReasoning } = await runToolCallLoop(apiCfg, conv, null);

    // Build the final assistant message
    const keyName = getActiveKeyDisplayName();
    const finalAssistantMsg = { role: 'assistant', content: finalCleanText, time: timeStr, keyName };
    if (finalReasoning) finalAssistantMsg.reasoning = finalReasoning;

    // Find the last user message index BEFORE adding the final message
    let lastUserIdx = -1;
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }

    if (lastUserIdx >= 0) {
      // Build the chain: messages after user + the final assistant message
      const chain = conv.messages.slice(lastUserIdx + 1).map(m => JSON.parse(JSON.stringify(m)));
      chain.push(JSON.parse(JSON.stringify(finalAssistantMsg)));
      const lastUser = conv.messages[lastUserIdx];
      lastUser._candidates = [{ messages: chain }];
      lastUser._activeCandidate = 0;
      // Also push the final message to conv.messages so subsequent context (in later exchanges) can find it
      conv.messages.push(finalAssistantMsg);
    } else {
      conv.messages.push(finalAssistantMsg);
    }
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
          // Attach as another candidate of the same user message
          for (let i = conv.messages.length - 1; i >= 0; i--) {
            if (conv.messages[i].role === 'user') {
              const lastUser = conv.messages[i];
              if (lastUser._candidates) {
                lastUser._candidates.push({ role: 'assistant', content: errMsg, time: timeStr, keyName: getActiveKeyDisplayName() });
                lastUser._activeCandidate = lastUser._candidates.length - 1;
              }
              break;
            }
          }
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
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'user') {
        const lastUser = conv.messages[i];
        lastUser._candidates = [errMsg];
        lastUser._activeCandidate = 0;
        break;
      }
    }
    safeSaveAiConvs();
    sendAiNotification(conv, errorMsg, getActiveKeyDisplayName());
  }

  // Always reset loading state for this conversation
  setAiLoading(conv.id, false);
  setAiStopRequested(conv.id, false);
  renderAiMessages();
  updateAiSendButton();

  // AI Auto-title: trigger after first AI reply is pushed to conversation
  if (shouldAutoTitle && typeof isAutoTitleEnabled === 'function' && isAutoTitleEnabled()) {
    generateConvTitle(conv);
  }
}

// ═══════════ Multi-Candidate Regenerate (DeepSeek-style) ═══════════
// Data model:
//   - A user message can have multiple assistant candidates attached:
//     userMsg._candidates = [assistantObj1, assistantObj2, ...]
//     userMsg._activeCandidate = 0 (index into _candidates)
//   - On regenerate: append a new candidate and switch to it
//   - On navigation: just change _activeCandidate index
//   - On "use this" (adopt): clear other candidates, strip _candidates from user msg
//   - In context: only the active candidate is sent to API

function getActiveCandidate(userMsg) {
  if (!userMsg || !userMsg._candidates || userMsg._candidates.length === 0) return null;
  const idx = Math.min(userMsg._activeCandidate || 0, userMsg._candidates.length - 1);
  return userMsg._candidates[idx];
}

function navigateCandidate(userIdx, delta) {
  const conv = getActiveConv();
  if (!conv) return;
  const userMsg = conv.messages[userIdx];
  if (!userMsg || !userMsg._candidates || userMsg._candidates.length === 0) return;
  const n = userMsg._candidates.length;
  const cur = userMsg._activeCandidate || 0;
  const newIdx = (cur + delta + n) % n;
  userMsg._activeCandidate = newIdx;

  // Replace only the segment belonging to this user message.
  // The segment spans from userIdx+1 to the next user message (or end of array).
  let endIdx = conv.messages.length;
  for (let i = userIdx + 1; i < conv.messages.length; i++) {
    if (conv.messages[i].role === 'user') {
      endIdx = i;
      break;
    }
  }
  const deleteCount = endIdx - userIdx - 1;
  const activeCand = userMsg._candidates[newIdx];
  if (activeCand && activeCand.messages) {
    conv.messages.splice(userIdx + 1, deleteCount, ...JSON.parse(JSON.stringify(activeCand.messages)));
  } else {
    // If no messages in candidate, just delete the old segment
    conv.messages.splice(userIdx + 1, deleteCount);
  }
  safeSaveAiConvs();
  renderAiMessages();
}

function adoptCandidate(userIdx) {
  const conv = getActiveConv();
  if (!conv) return;
  const userMsg = conv.messages[userIdx];
  if (!userMsg || !userMsg._candidates || userMsg._candidates.length === 0) return;
  // Replace only the segment belonging to this user message (not beyond next user msg)
  let endIdx = conv.messages.length;
  for (let i = userIdx + 1; i < conv.messages.length; i++) {
    if (conv.messages[i].role === 'user') {
      endIdx = i;
      break;
    }
  }
  const deleteCount = endIdx - userIdx - 1;
  const activeCand = getActiveCandidate(userMsg);
  if (activeCand && activeCand.messages) {
    conv.messages.splice(userIdx + 1, deleteCount, ...JSON.parse(JSON.stringify(activeCand.messages)));
  } else {
    conv.messages.splice(userIdx + 1, deleteCount);
  }
  userMsg._adopted = true;
  safeSaveAiConvs();
  renderAiMessages();
}

function unadoptCandidate(userIdx) {
  const conv = getActiveConv();
  if (!conv) return;
  const userMsg = conv.messages[userIdx];
  if (!userMsg) return;
  userMsg._adopted = false;
  safeSaveAiConvs();
  renderAiMessages();
}

async function regenerateAiMessage(targetIdx) {
  const conv = getActiveConv();
  if (!conv || isAiLoading(conv.id)) return;

  // Determine target user message. Two cases:
  //  (a) Called from a candidate (DeepSeek-style): targetIdx is the user msg index
  //  (b) Called from a legacy standalone assistant msg: targetIdx is the assistant msg index
  let userIdx = -1;
  const target = conv.messages[targetIdx];
  if (target && target.role === 'user') {
    userIdx = targetIdx;
  } else if (target && target.role === 'assistant') {
    // Find preceding user message; for legacy data, also remove this assistant and any messages after
    for (let i = targetIdx - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'user') {
        userIdx = i;
        break;
      }
    }
    if (userIdx < 0) return;
    // Remove the assistant message and any subsequent messages (system tool results, etc.)
    conv.messages.splice(targetIdx);
    safeSaveAiConvs();
    renderAiMessages();
  } else {
    return;
  }
  const userMsg = conv.messages[userIdx];
  if (!userMsg || userMsg.role !== 'user') return;

  // Remove any messages after userIdx (e.g. system tool results)
  if (conv.messages.length > userIdx + 1) {
    conv.messages.splice(userIdx + 1);
    safeSaveAiConvs();
    renderAiMessages();
  }

  const apiCfg = getEffectiveApiConfig();
  if (!apiCfg.apiKey) return;

  setAiLoading(conv.id, true);
  updateAiSendButton();

  try {
    const { finalCleanText, finalRawReply, finalReasoning } = await runToolCallLoop(apiCfg, conv, null);

    const keyName = getActiveKeyDisplayName();
    const timeStr = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    // Build the final assistant message and push to conv.messages first
    const finalAssistantMsg = { role: 'assistant', content: finalCleanText, time: timeStr, keyName };
    if (finalReasoning) finalAssistantMsg.reasoning = finalReasoning;
    conv.messages.push(finalAssistantMsg);

    // Collect the full message chain after userIdx (tool call assistants + systems + final)
    const chain = conv.messages.slice(userIdx + 1).map(m => JSON.parse(JSON.stringify(m)));
    const newCandidate = { messages: chain };

    // Initialize or append to _candidates on the user message
    if (!userMsg._candidates) {
      userMsg._candidates = [newCandidate];
      userMsg._activeCandidate = 0;
    } else {
      userMsg._candidates.push(newCandidate);
      userMsg._activeCandidate = userMsg._candidates.length - 1;
    }
    safeSaveAiConvs();
    sendAiNotification(conv, finalCleanText, keyName);

    // Parse <memory> tags (only from the most recent reply)
    if (typeof parseMemoryTags === 'function') {
      parseMemoryTags(finalRawReply || finalCleanText, conv.id, conv.title);
    }
  } catch (err) {
    const errorMsg = '❌ 出错了：' + err.message;
    const errMsg = { role: 'assistant', content: errorMsg + '\n\n请检查 API Key 和网络连接是否正确。', time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), keyName: getActiveKeyDisplayName() };
    const errCandidate = { messages: [errMsg] };
    if (!userMsg._candidates) {
      userMsg._candidates = [errCandidate];
      userMsg._activeCandidate = 0;
    } else {
      userMsg._candidates.push(errCandidate);
      userMsg._activeCandidate = userMsg._candidates.length - 1;
    }
    safeSaveAiConvs();
    sendAiNotification(conv, errorMsg, getActiveKeyDisplayName());
  }

  setAiLoading(conv.id, false);
  setAiStopRequested(conv.id, false);
  renderAiMessages();
  updateAiSendButton();
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
