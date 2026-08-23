// ═══════════════════════════════════════════════
//  AI 对话管理：设置弹窗、创建/切换/删除/清空对话、导出日志、标签页拖拽、输入草稿
// ═══════════════════════════════════════════════

// ═══════════ Conversation Settings Modal ═══════════
function openConvSettingsModal() {
  convSettingsModalOpen = true;
  const conv = getActiveConv();
  document.getElementById('convSettingsModal').classList.add('open');
  document.getElementById('convTitleInput').value = conv ? conv.title : '';
  document.getElementById('convSystemPrompt').value = conv ? (conv.systemPrompt || '') : '';
  document.getElementById('convSettingsStatus').className = 'settings-status';
  document.getElementById('convSettingsStatus').textContent = '';
  // Show debug info (only in debug mode)
  const debugEl = document.getElementById('convDebugInfo');
  if (debugEl && conv) {
    if (isDebugMode()) {
      const autoTitled = conv.autoTitled ? '是（由 AI 自动生成）' : '否（用户手动设置或默认名称）';
      const msgCount = conv.messages ? conv.messages.length : 0;
      const createdAt = conv.createdAt ? new Date(conv.createdAt).toLocaleString('zh-CN') : '未知';
      debugEl.innerHTML = `
        ID：${conv.id}<br>
        消息数：${msgCount}<br>
        创建时间：${createdAt}<br>
        AI 自动生成标题：${autoTitled}
      `;
    } else {
      debugEl.textContent = '开启调试模式可查看更多对话信息。';
    }
  }
}

function closeConvSettingsModal(e) {
  if (e && e.target !== document.getElementById('convSettingsModal')) return;
  convSettingsModalOpen = false;
  document.getElementById('convSettingsModal').classList.remove('open');
}

function saveConvSettings() {
  const conv = getActiveConv();
  if (!conv) return;
  conv.title = document.getElementById('convTitleInput').value.trim() || '未命名对话';
  conv.systemPrompt = document.getElementById('convSystemPrompt').value.trim();
  safeSaveAiConvs();
  renderAiChat();
}

// ═══════════ AI Chat: Conversation Management ═══════════
function createNewConv() {
  // Extract memory from current conv before leaving
  if (typeof scheduleMemoryExtract === 'function') {
    const oldConv = getActiveConv();
    if (oldConv) scheduleMemoryExtract(oldConv);
  }
  const conv = {
    id: genId(),
    title: '新对话 ' + (aiConvs.length + 1),
    systemPrompt: '',
    messages: [],
    autoTitled: false
  };
  if (typeof initTreeOnConv === 'function') initTreeOnConv(conv);
  aiConvs.push(conv);
  activeConvId = conv.id;
  localStorage.setItem('study_active_conv', activeConvId);
  safeSaveAiConvs();
  renderAiChat();
}

function switchConv(id) {
  // Save draft of current conv before switching
  saveAiDraft();
  // Extract memory from current conv before switching
  if (typeof scheduleMemoryExtract === 'function') {
    const oldConv = getActiveConv();
    if (oldConv && oldConv.id !== id) scheduleMemoryExtract(oldConv);
  }
  activeConvId = id;
  localStorage.setItem('study_active_conv', activeConvId);
  // Clear unread for this conversation
  const conv = aiConvs.find(c => c.id === id);
  if (conv && (conv._hasUnread || conv._hasUnreadAuto)) {
    conv._hasUnread = false;
    conv._hasUnreadAuto = false;
    safeSaveAiConvs();
    updateSidebarAiBadge();
  }
  renderAiChat();
  // Restore draft for the target conv
  restoreAiDraft();
  // Update send button to reflect target conv's loading state
  updateAiSendButton();
  // 切回有排队消息的会话：若该会话未在回复中，自动继续发送队列
  if (typeof drainAiSendQueue === 'function' && typeof isAiLoading === 'function' && !isAiLoading(id)) {
    setTimeout(function () { drainAiSendQueue(id); }, 120);
  }
}

function deleteConv(id, e) {
  e.stopPropagation();
  // Extract memory before deleting
  if (typeof scheduleMemoryExtract === 'function') {
    const targetConv = aiConvs.find(c => c.id === id);
    if (targetConv) scheduleMemoryExtract(targetConv);
  }
  if (aiConvs.length <= 1) {
    // Don't delete the last one, just clear it
    const lastConv = aiConvs[0];
    if (typeof resetConvTree === 'function') resetConvTree(lastConv);
    else lastConv.messages = [];
    lastConv.title = '默认对话';
    lastConv.systemPrompt = '';
    safeSaveAiConvs();
    renderAiChat();
    return;
  }

  // Check for associated automations
  const linkedAutos = automations.filter(a => a.convId === id);
  let confirmMsg = '确定要删除此对话吗？';
  if (linkedAutos.length > 0) {
    const autoNames = linkedAutos.map(a => `"${a.prompt.slice(0, 30)}${a.prompt.length > 30 ? '…' : ''}"`).join('、');
    confirmMsg = `此对话关联了 ${linkedAutos.length} 个自动化任务：\n${autoNames}\n\n删除对话将同时删除这些自动化任务。\n确定要删除吗？`;
  }

  showCustomConfirm(confirmMsg, { dontAskKey: 'study_dontask_delete_conv' }).then(confirmed => {
    if (!confirmed) return;

    // Delete associated automations
    if (linkedAutos.length > 0) {
      automations = automations.filter(a => a.convId !== id);
      saveData('study_automations', automations);
      if (automations.length === 0 || automations.every(a => a.enabled === false)) stopAutomationTimer();
    }

    aiConvs = aiConvs.filter(c => c.id !== id);
    if (activeConvId === id) activeConvId = aiConvs[0].id;
    localStorage.setItem('study_active_conv', activeConvId);
    // Clean up draft for deleted conv
    try {
      const drafts = JSON.parse(localStorage.getItem('study_ai_drafts') || '{}');
      delete drafts[id];
      localStorage.setItem('study_ai_drafts', JSON.stringify(drafts));
    } catch {}
    safeSaveAiConvs();
    renderAiChat();
  });
}

function clearConvMessages(e) {
  if (e) e.stopPropagation();
  // Extract memory before clearing
  if (typeof scheduleMemoryExtract === 'function') {
    const conv = getActiveConv();
    if (conv) scheduleMemoryExtract(conv);
  }
  showCustomConfirm('确定要清空当前对话的所有消息吗？清空后不可恢复。', { dontAskKey: 'study_dontask_clear_conv' }).then(confirmed => {
    if (!confirmed) return;
    const conv = getActiveConv();
    if (!conv) return;
    if (typeof resetConvTree === 'function') resetConvTree(conv);
    else conv.messages = [];
    safeSaveAiConvs();
    renderAiMessages();
  });
}

// ═══════════ Export Conversation Log ═══════════
function exportConvLog() {
  try {
    const conv = getActiveConv();
    if (!conv) return;

    const now = new Date();
    const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

    const apiCfg = getEffectiveApiConfig();
    const settings = getSettings();

    // Build log
    const log = [];

    log.push('='.repeat(70));
    log.push('  我的学习桌面 — 对话日志导出');
    log.push('='.repeat(70));
    log.push('');
    log.push(`导出时间：${timeStr}`);
    log.push('');

    // ── Conversation metadata ──
    log.push('─── 对话信息 ───');
    log.push(`  标题：${conv.title}`);
    log.push(`  ID：${conv.id}`);
    log.push(`  日报对话：${conv._dailyReport ? '是' : '否'}`);
    log.push(`  自动标题：${conv.autoTitled ? '是' : '否'}`);
    log.push(`  系统提示词：${conv.systemPrompt || '(无)'}`);
    log.push(`  消息总数：${conv.messages.length}`);
    if (conv.createdAt) log.push(`  创建时间：${conv.createdAt}`);
    log.push('');

    // ── API Configuration ──
    log.push('─── 当前 API 配置 ───');
    log.push(`  名称：${apiCfg.name || '(未配置)'}`);
    log.push(`  模型：${apiCfg.model}`);
    log.push(`  接口地址：${apiCfg.baseUrl}`);
    log.push(`  温度：${apiCfg.temperature}`);
    log.push(`  深度思考：${apiCfg.deepThink ? '开启' : '关闭'}`);
    log.push('');

    // ── App settings ──
    log.push('─── 应用设置 ───');
    log.push(`  开发者模式：${settings.developerMode ? '开启' : '关闭'}`);
    log.push('');

    // ── System prompt sent to AI ──
    log.push('─── 发送给 AI 的 System Prompt ───');
    const sysPrompt = conv.systemPrompt
      ? buildToolsSystemPrompt() + '\n\n【用户自定义角色】' + conv.systemPrompt
      : buildToolsSystemPrompt();
    log.push(sysPrompt);
    log.push('');

    // ── Messages ──
    log.push('─── 对话消息（共 ' + conv.messages.length + ' 条）───');
    log.push('');
    conv.messages.forEach((m, idx) => {
      const roleLabel = m.role === 'user' ? '👤 用户' : m.role === 'assistant' ? '🤖 AI' : '⚙️ 系统';
      log.push(`[#${idx + 1}] ${roleLabel}` + (m.time ? ` — ${m.time}` : ''));
      log.push('-'.repeat(40));

      if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
        log.push(`  附件：${m.attachments.map(a => `${a.name}(${formatFileSize(a.size)})`).join(', ')}`);
        for (const a of m.attachments) {
          if (a.content) {
            log.push(`  ── 附件内容：${a.name} ──`);
            log.push(a.content);
            log.push(`  ── 附件结束 ──`);
          }
        }
        // Show user text without embedded file content
        let userText = typeof m.content === 'string' ? m.content.replace(/\n\n\[附件：[^\]]+\]\n[\s\S]*$/, '') : m.content;
        log.push(`  ${userText}`);
      } else {
        log.push(`  ${typeof m.content === 'string' ? m.content : safeJsonStringify(m.content)}`);
      }

      if (m.reasoning) {
        log.push('');
        log.push('  🧠 深度思考：');
        log.push(`  ${m.reasoning}`);
      }

      // ── 分支导出：树模式下 user 节点可能有多个候选分支（兄弟节点）──
      // 兼容旧 _candidates 数据（导出前已迁移，正常不会再出现）
      if (m._candidates && m._candidates.length > 0) {
        const activeIdx = m._activeCandidate || 0;
        log.push('');
        log.push(`  📎 候选回复（共 ${m._candidates.length} 条，当前显示第 ${activeIdx + 1} 条）：`);
        m._candidates.forEach((cand, ci) => {
          const marker = ci === activeIdx ? ' → [当前]' : '';
          const candMsgs = cand.messages || (cand.content ? [cand] : []); // support legacy format
          log.push(`  ── 候选 #${ci + 1}${marker}（共 ${candMsgs.length} 条消息）──`);
          for (const cm of candMsgs) {
            const roleLabel = cm.role === 'user' ? '👤 用户' : cm.role === 'assistant' ? '🤖 AI' : '⚙️ 系统';
            log.push(`   [${roleLabel}]${cm.time ? ' — ' + cm.time : ''}`);
            if (cm.keyName) log.push(`   Key: ${cm.keyName}`);
            if (cm.reasoning) {
              log.push(`   🧠 深度思考：`);
              log.push(`   ${cm.reasoning}`);
            }
            log.push(`   ${typeof cm.content === 'string' ? cm.content : safeJsonStringify(cm.content)}`);
          }
          log.push(`  ── 候选 #${ci + 1} 结束 ──`);
        });
      } else if (m.role === 'user' && conv.tree && m.id && conv.tree[m.id] && conv.tree[m.id].children && conv.tree[m.id].children.length > 1) {
        const node = conv.tree[m.id];
        const activeChildId = (conv.activePath || []).includes(node.children[0]) ? node.children[0] : (conv.activePath || []).find(id => node.children.includes(id));
        const activeIdx = activeChildId ? node.children.indexOf(activeChildId) : 0;
        log.push('');
        log.push(`  🔀 分支回复（共 ${node.children.length} 个分支，当前显示第 ${activeIdx + 1} 个）`);
        node.children.forEach((cid, ci) => {
          const marker = ci === activeIdx ? ' → [当前]' : '';
          const branchMsgs = [];
          // 收集该分支的完整链（沿 children 向下直到无分支）
          let cur = cid;
          let guard = 0;
          while (cur && conv.tree[cur] && guard++ < 100) {
            branchMsgs.push(conv.tree[cur]);
            const kids = conv.tree[cur].children || [];
            if (kids.length === 0) break;
            cur = kids[0];
          }
          log.push(`  ── 分支 #${ci + 1}${marker}（共 ${branchMsgs.length} 条消息）──`);
          for (const bm of branchMsgs) {
            const roleLabel = bm.role === 'user' ? '👤 用户' : bm.role === 'assistant' ? '🤖 AI' : '⚙️ 系统';
            log.push(`   [${roleLabel}]${bm.time ? ' — ' + bm.time : ''}`);
            if (bm.keyName) log.push(`   Key: ${bm.keyName}`);
            if (bm.reasoning) {
              log.push(`   🧠 深度思考：`);
              log.push(`   ${bm.reasoning}`);
            }
            log.push(`   ${typeof bm.content === 'string' ? bm.content : safeJsonStringify(bm.content)}`);
          }
          log.push(`  ── 分支 #${ci + 1} 结束 ──`);
        });
      }
    });

    // ── Raw API Call Logs ──
    const rawLogs = conv._rawLogs || [];
    if (rawLogs.length > 0) {
      log.push('='.repeat(70));
      log.push('  原始 API 调用记录（共 ' + rawLogs.length + ' 次）');
      log.push('='.repeat(70));
      log.push('');

      rawLogs.forEach((rl, idx) => {
        log.push(`─── API 调用 #${idx + 1} ───`);
        log.push(`  请求时间：${rl.requestTime}`);
        log.push(`  响应时间：${rl.responseTime}`);
        log.push('');

        log.push('  📤 请求 (Request):');
        log.push('  ' + safeJsonStringify(rl.request, 2));
        log.push('');

        log.push('  📥 响应 (Response):');
        if (rl.response.error) {
          log.push('  ❌ 错误: ' + rl.response.error + ' (HTTP ' + rl.response.httpStatus + ')');
        } else {
          log.push('  ' + safeJsonStringify(rl.response, 2));
        }
        log.push('');
        log.push('');
      });
    } else {
      log.push('─── 原始 API 调用记录 ───');
      log.push('  (无记录 — 此对话可能是在日志功能添加之前创建的)');
      log.push('');
    }

    // ── Raw JSON (对话数据结构) ──
    log.push('─── 对话数据结构（JSON）───');
    // Export conversation without rawLogs (already shown above), strip _ prefixed fields
    const cleanConv = {};
    for (const [k, v] of Object.entries(conv)) {
      if (!k.startsWith('_')) cleanConv[k] = v;
    }
    log.push(safeJsonStringify(cleanConv, 2));

    const logText = log.join('\n');
    const safeTitle = conv.title.replace(/[\\/:*?"<>|]/g, '_');
    const filename = `对话日志_${safeTitle}_${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}.log`;

    // Download as file
    const blob = new Blob([logText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error('[exportConvLog] 导出日志失败:', e.message);
    alert('导出日志失败：' + e.message);
  }
}

// ═══════════ Conv tab drag-and-drop reorder ═══════════
let _convDragSrcIdx = -1;

function onConvTabDragStart(event, idx) {
  _convDragSrcIdx = idx;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', idx);
  event.target.classList.add('dragging');
}

function onConvTabDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
}

function onConvTabDrop(event, dropIdx) {
  event.preventDefault();
  const srcIdx = _convDragSrcIdx;
  if (srcIdx < 0 || srcIdx === dropIdx) return;
  const [moved] = aiConvs.splice(srcIdx, 1);
  const actualDropIdx = dropIdx > srcIdx ? dropIdx - 1 : dropIdx;
  aiConvs.splice(actualDropIdx, 0, moved);
  safeSaveAiConvs();
  renderAiChat();
}

function onConvTabDragEnd(event) {
  event.target.classList.remove('dragging');
  _convDragSrcIdx = -1;
}

// ═══════════ Input draft (per-conversation) ═══════════
// Saves and restores the textarea content per conversation tab,
// so switching tabs preserves what the user was typing (like WeChat).

function saveAiDraft() {
  const input = document.getElementById('aiInput');
  if (!input) return;
  const conv = getActiveConv();
  if (!conv) return;
  try {
    const drafts = JSON.parse(localStorage.getItem('study_ai_drafts') || '{}');
    drafts[conv.id] = input.value;
    localStorage.setItem('study_ai_drafts', JSON.stringify(drafts));
  } catch {}
}

function restoreAiDraft() {
  const input = document.getElementById('aiInput');
  if (!input) return;
  const conv = getActiveConv();
  if (!conv) return;
  try {
    const drafts = JSON.parse(localStorage.getItem('study_ai_drafts') || '{}');
    input.value = drafts[conv.id] || '';
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  } catch {}
}

function clearAiDraft() {
  const conv = getActiveConv();
  if (!conv) return;
  try {
    const drafts = JSON.parse(localStorage.getItem('study_ai_drafts') || '{}');
    delete drafts[conv.id];
    localStorage.setItem('study_ai_drafts', JSON.stringify(drafts));
  } catch {}
}
