// Move the existing chat surface so drafts, attachments and streaming stay shared.
let aiFloatReturnFocus = null;
let aiFloatHome = null;
let aiFloatCleanup = null;
let aiFloatToolbarCollapsed = false;
try { aiFloatToolbarCollapsed = localStorage.getItem('study_ai_float_toolbar_collapsed') === 'true'; } catch {}

function toggleAiFloatToolbar() {
  const panel = document.getElementById('aiFloat');
  if (!panel) return;
  aiFloatToolbarCollapsed = !aiFloatToolbarCollapsed;
  panel.dataset.toolbarCollapsed = String(aiFloatToolbarCollapsed);
  const button = panel.querySelector('.ai-float-toolbar-toggle');
  if (button) {
    button.setAttribute('aria-expanded', String(!aiFloatToolbarCollapsed));
    button.textContent = aiFloatToolbarCollapsed ? '展开工具' : '收起工具';
  }
  try { localStorage.setItem('study_ai_float_toolbar_collapsed', String(aiFloatToolbarCollapsed)); } catch {}
}

function initAiFloatGeometry(panel) {
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const margin = 8;
  let gesture = null;
  function apply(rect) {
    const maxWidth = Math.max(1, innerWidth - margin * 2);
    const maxHeight = Math.max(1, innerHeight - margin * 2);
    const width = Math.min(maxWidth, Math.max(Math.min(320, maxWidth), rect.width));
    const height = Math.min(maxHeight, Math.max(Math.min(360, maxHeight), rect.height));
    Object.assign(panel.style, {
      left: Math.max(margin, Math.min(innerWidth - width - margin, rect.x)) + 'px',
      top: Math.max(margin, Math.min(innerHeight - height - margin, rect.y)) + 'px',
      right: 'auto', bottom: 'auto', width: width + 'px', height: height + 'px'
    });
  }
  function save() {
    const { x, y, width, height } = panel.getBoundingClientRect();
    try { localStorage.setItem('study_ai_float_geometry', JSON.stringify({ x, y, width, height })); } catch {}
  }
  let saved;
  try { saved = JSON.parse(localStorage.getItem('study_ai_float_geometry')); } catch {}
  apply(saved && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(saved[key]))
    ? saved : panel.getBoundingClientRect());
  panel.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    const handle = event.target.closest('[data-ai-resize]');
    if (!handle && (!event.target.closest('.ai-float-header') || event.target.closest('button'))) return;
    event.preventDefault();
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY,
      rect: panel.getBoundingClientRect(), edge: handle?.dataset.aiResize || '' };
    panel.setPointerCapture(event.pointerId);
    panel.classList.add('ai-float-adjusting');
  }, options);
  panel.addEventListener('pointermove', event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const { rect, edge } = gesture;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (!edge) { apply({ x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height }); return; }
    const minWidth = Math.min(320, innerWidth - margin * 2);
    const minHeight = Math.min(360, innerHeight - margin * 2);
    let left = rect.left, right = rect.right, top = rect.top, bottom = rect.bottom;
    if (edge.includes('w')) left = Math.max(margin, Math.min(right - minWidth, left + dx));
    if (edge.includes('e')) right = Math.min(innerWidth - margin, Math.max(left + minWidth, right + dx));
    if (edge.includes('n')) top = Math.max(margin, Math.min(bottom - minHeight, top + dy));
    if (edge.includes('s')) bottom = Math.min(innerHeight - margin, Math.max(top + minHeight, bottom + dy));
    apply({ x: left, y: top, width: right - left, height: bottom - top });
  }, options);
  function end(event) {
    if (!gesture || event.pointerId !== gesture.id) return;
    gesture = null;
    panel.classList.remove('ai-float-adjusting');
    if (panel.hasPointerCapture(event.pointerId)) panel.releasePointerCapture(event.pointerId);
    save();
  }
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => panel.addEventListener(type, end, options));
  window.addEventListener('resize', () => {
    gesture = null;
    panel.classList.remove('ai-float-adjusting');
    apply(panel.getBoundingClientRect());
    save();
  }, options);
  return () => { save(); controller.abort(); };
}

function showAiFloat() {
  if (document.getElementById('aiFloat')) return;
  const layout = document.getElementById('aiChatLayout');
  if (!layout) return;
  aiFloatReturnFocus = document.activeElement;
  aiFloatHome = document.createComment('AI chat home');
  layout.before(aiFloatHome);
  const panel = document.createElement('section');
  panel.id = 'aiFloat';
  panel.className = 'ai-float';
  panel.dataset.toolbarCollapsed = String(aiFloatToolbarCollapsed);
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'AI 对话浮窗');
  panel.tabIndex = -1;
  panel.innerHTML = `<header class="ai-float-header"><strong>AI 对话</strong><small>Ctrl+Shift+A</small>
    <button type="button" onclick="expandAiFloat()" title="展开到 AI 页面" aria-label="展开到 AI 页面">↗</button>
    <button type="button" onclick="closeAiFloat()" title="收起浮窗" aria-label="收起 AI 浮窗">×</button></header>`;
  document.body.appendChild(panel);
  panel.appendChild(layout);
  ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'].forEach(edge => {
    const handle = document.createElement('div');
    handle.className = 'ai-float-resize ai-float-resize-' + edge;
    handle.dataset.aiResize = edge;
    handle.setAttribute('aria-hidden', 'true');
    panel.appendChild(handle);
  });
  aiFloatCleanup = initAiFloatGeometry(panel);
  renderAiChat({ reuseExisting: true });
  const input = document.getElementById('aiInput');
  if (input && !input.disabled) input.focus();
  else panel.focus();
}

function closeAiFloat(restoreFocus = true) {
  const panel = document.getElementById('aiFloat');
  if (!panel) return;
  aiFloatCleanup?.();
  aiFloatCleanup = null;
  saveAiDraft();
  const layout = document.getElementById('aiChatLayout');
  if (layout && aiFloatHome) aiFloatHome.replaceWith(layout);
  panel.remove();
  aiFloatHome = null;
  if (restoreFocus && aiFloatReturnFocus?.isConnected) aiFloatReturnFocus.focus({ preventScroll: true });
  aiFloatReturnFocus = null;
}

function expandAiFloat() {
  closeAiFloat(false);
  switchTab('ai');
  document.getElementById('aiInput')?.focus();
}

document.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229) return;
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey
      && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) {
      if (document.getElementById('aiFloat')) closeAiFloat();
      else showAiFloat();
    }
  } else if (event.key === 'Escape' && document.getElementById('aiFloat')
      && document.getElementById('aiFloat').contains(document.activeElement)
      && !document.querySelector('.modal-overlay.open, .overlay.open')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeAiFloat();
  }
}, true);
