// ═══════════════════════════════════════════════
//  AI 工具函数：JSON 序列化、数据保存、确认弹窗、计时格式化
// ═══════════════════════════════════════════════

// Helper: JSON.stringify without escaping non-ASCII characters (so Emoji stay readable)
// Includes circular reference detection to prevent "Maximum call stack size exceeded"
function safeJsonStringify(obj, space) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (_, val) => {
    // Return strings as-is so JSON.stringify won't escape non-ASCII chars
    if (typeof val === 'string') return val;
    // Detect and handle circular references
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
    }
    return val;
  }, space);
}

// Helper: safely save aiConvs, cleaning _rawLogs if JSON.stringify fails
function safeSaveAiConvs() {
  try {
    const json = JSON.stringify(aiConvs);
    localStorage.setItem('study_ai_convs', json);
  } catch (e) {
    console.warn('[safeSaveAiConvs] JSON.stringify failed:', e.message, '— retrying after cleanup');
    try {
      // Strip _-prefixed fields which may contain circular refs (e.g. _rawLogs),
      // but MUST keep _dailyReport / _hasUnread / _hasUnreadAuto so daily report marker survives
      const cleaned = aiConvs.map(c => {
        if (c && typeof c === 'object') {
          const copy = { messages: c.messages || [] };
          if (c.id !== undefined) copy.id = c.id;
          if (c.title !== undefined) copy.title = c.title;
          if (c.systemPrompt !== undefined) copy.systemPrompt = c.systemPrompt;
          if (c.autoTitled !== undefined) copy.autoTitled = c.autoTitled;
          if (c.createdAt !== undefined) copy.createdAt = c.createdAt;
          // 树状对话字段
          if (c.tree !== undefined) copy.tree = c.tree;
          if (c.activePath !== undefined) copy.activePath = c.activePath;
          // 关键标记字段（保留，防止日报对话标记丢失导致重复新建）
          if (c._dailyReport !== undefined) copy._dailyReport = c._dailyReport;
          if (c._hasUnread !== undefined) copy._hasUnread = c._hasUnread;
          if (c._hasUnreadAuto !== undefined) copy._hasUnreadAuto = c._hasUnreadAuto;
          return copy;
        }
        return c;
      });
      localStorage.setItem('study_ai_convs', JSON.stringify(cleaned));
      console.warn('[safeSaveAiConvs] 清理后保存成功');
    } catch (e2) {
      // Last resort: save minimal data
      console.error('[safeSaveAiConvs] 彻底失败:', e2.message);
      const minimal = aiConvs.map(c => ({ id: c.id, title: c.title, systemPrompt: '', messages: c.messages || [], autoTitled: c.autoTitled }));
      try { localStorage.setItem('study_ai_convs', JSON.stringify(minimal)); } catch (_) {}
    }
  }
  // 上报日志同步通道（js/sync-logs.js，按会话 id 拆分 + 分片 + 配额）
  if (typeof SyncLogs !== 'undefined' && SyncLogs.onLocalChange) {
    try { SyncLogs.onLocalChange('study_ai_convs'); } catch (e) {}
  }
}

// ═══════════ Custom Confirm Dialog (replaces native confirm to avoid Electron focus bugs) ═══════════
function showCustomConfirm(message, options = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirmOverlay');
    const msgEl = document.getElementById('confirmMsg');
    const cancelBtn = document.getElementById('confirmCancel');
    const okBtn = document.getElementById('confirmOk');
    const dontAskEl = document.getElementById('confirmDontAsk');
    const dontAskLabel = document.getElementById('confirmDontAskLabel');

    if (!overlay || !msgEl || !cancelBtn || !okBtn) {
      resolve(confirm(message));
      return;
    }

    // If "don't ask again" was previously confirmed, auto-resolve
    if (options.dontAskKey && localStorage.getItem(options.dontAskKey) === 'true') {
      resolve(true);
      return;
    }

    msgEl.innerHTML = message;

    // Show/hide "don't ask again" checkbox
    if (dontAskEl && dontAskLabel) {
      dontAskLabel.style.display = options.dontAskKey ? '' : 'none';
      dontAskEl.checked = false;
    }

    // Optional: hide warning icon and/or action buttons (for custom modal content)
    // 感叹号默认隐藏（用户不喜欢警告图标），除非显式 showIcon: true
    const iconEl = document.getElementById('confirmIcon');
    if (iconEl) iconEl.style.display = options.showIcon ? '' : 'none';
    if (cancelBtn && okBtn && cancelBtn.parentElement) {
      cancelBtn.parentElement.style.display = options.hideActions ? 'none' : '';
    }

    overlay.classList.add('open');

    // JS 兜底：限制弹窗不超过窗口高度，超高时弹窗整体滚动（不影响内容贴合高度）
    requestAnimationFrame(() => {
      const dialog = overlay.querySelector('.confirm-dialog');
      if (!dialog) return;
      const availH = window.innerHeight - 40;
      if (dialog.offsetHeight > availH) {
        dialog.style.maxHeight = availH + 'px';
        dialog.style.overflowY = 'auto';
      }
    });

    function cleanup(result) {
      overlay.classList.remove('open');
      // 恢复内联高度，避免影响下次弹窗
      const dialog = overlay.querySelector('.confirm-dialog');
      if (dialog) {
        dialog.style.maxHeight = '';
        dialog.style.overflowY = '';
      }
      cancelBtn.removeEventListener('click', onCancel);
      okBtn.removeEventListener('click', onOk);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKeyDown);
      // Save "don't ask again" preference if confirmed and checkbox is checked
      if (result && options.dontAskKey && dontAskEl && dontAskEl.checked) {
        try { localStorage.setItem(options.dontAskKey, 'true'); } catch {}
      }
      resolve(result);
    }

    function onCancel() { cleanup(false); }
    function onOk() { cleanup(true); }
    function onOverlayClick(e) {
      if (e.target === overlay) cleanup(false);
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') cleanup(false);
      // 隐藏按钮的自定义弹窗有自己的提交逻辑，Enter 不自动关闭
      if (e.key === 'Enter' && !options.hideActions) cleanup(true);
    }

    cancelBtn.addEventListener('click', onCancel);
    okBtn.addEventListener('click', onOk);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeyDown);

    setTimeout(() => cancelBtn.focus(), 50);
  });
}

// Format ms into a human-readable duration string (e.g. "2h15m" or "45m")
function formatTimerDuration(ms) {
  if (ms < 60000) return '<1m';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

// Get timer duration string for a todo (includes all descendants)
function getTodoTimerStr(todoId) {
  try {
    const allIds = getAllDescendantIds(todoId);
    const records = JSON.parse(localStorage.getItem('study_timer_records') || '[]');
    let timerMs = 0;
    for (const rec of records) {
      const rid = rec.targetId || rec.todoId;
      if (rid && allIds.includes(rid)) timerMs += rec.totalMs;
    }
    return timerMs >= 60000 ? ` ⏱️${formatTimerDuration(timerMs)}` : '';
  } catch { return ''; }
}
