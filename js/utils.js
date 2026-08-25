// ═══════════ Helpers ═══════════
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
// escapeJs：用于单引号 JS 字符串上下文（onclick="fn('...')"），先转义反斜杠再转义引号与换行，
// 避免反斜杠绕过（如 \');alert(1)// 变为 \\' 时先转义 \\ 再闭合字符串）。
function escapeJs(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}
// escapeAttr：仅用于 HTML 属性值上下文（双引号包裹）。
function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ═══════════ Update keyboard shortcuts ═══════════
// (Overwritten below in init)

function renderChangelogModal() {
  const body = document.getElementById('changelogModalBody');
  if (!body) return;
  body.innerHTML = changelog.map(e => {
    const d = new Date(e.time);
    const dateStr = d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
    const timeStr = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    return `
      <div class="modal-changelog-entry">
        <div class="modal-changelog-meta">
          <span class="version">#${e.id}</span>
          <span>${dateStr}</span>
          <span>${timeStr}</span>
        </div>
        <div class="modal-changelog-content">${escapeHtml(e.content)}</div>
      </div>
    `;
  }).join('');
}

// ═══════════ Keyboard shortcuts ═══════════
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    if (convSettingsModalOpen) {
      closeConvSettingsModal();
    } else if (settingsModalOpen) {
      closeSettingsModal();
    } else if (changelogModalOpen) {
      closeChangelogModal();
    } else if (helpModalOpen) {
      closeHelpModal();
    } else if (document.getElementById('checkinQuoteOverlay').classList.contains('open')) {
      closeCheckinQuote();
    } else if (editModalOpen) {
      closeEditModal();
    }
  }
  // Undo/redo: notes when textarea focused, else todo operations
  // 焦点在任意输入框时保留浏览器原生撤销/重做，避免 Ctrl+Z 误触发待办回滚
  const activeEl = document.activeElement;
  const inTextInput = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');
  const inNoteField = activeEl && (activeEl.id === 'notesTextarea' || activeEl.id === 'noteTitleInput');
  if (e.ctrlKey && !e.shiftKey && e.key === 'z') {
    if (inTextInput && !inNoteField) return; // 交给原生输入撤销
    e.preventDefault();
    if (inNoteField) undoNote(); else undoTodo();
  }
  if ((e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && e.key === 'z')) {
    if (inTextInput && !inNoteField) return; // 交给原生输入重做
    e.preventDefault();
    if (inNoteField) redoNote(); else redoTodo();
  }
  // Ctrl+R / F5 刷新页面
  if ((e.ctrlKey && e.key === 'r') || e.key === 'F5') {
    e.preventDefault();
    location.reload();
  }
});

// ═══════════ Init ═══════════

// ── 滚动条自动显隐 ──
let scrollTimer;
function showScrollbars() {
  document.documentElement.classList.add('scrolling');
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    document.documentElement.classList.remove('scrolling');
  }, 800);
}
document.addEventListener('scroll', showScrollbars, { passive: true, capture: true });
// 也监听 wheel 事件，因为有些容器自己滚动不会冒泡到 document
document.addEventListener('wheel', showScrollbars, { passive: true, capture: true });

// Application startup is centralized in bootstrap.js so feature initialization order
// is explicit and independently observable.
