
// ═══════════ Data ═══════════
function loadData(key) { try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; } }
// Generate a globally-unique numeric ID. Monotonic (newest = largest value) so any
// time-based ordering is preserved, and collision-resistant even when many IDs are
// created within the same millisecond (global sequence suffix).
let _genIdSeq = 0;
function genId() {
  _genIdSeq = (_genIdSeq + 1) % 100000;
  return Date.now() * 1000 + _genIdSeq;
}
// Persist/restore expanded todo IDs so the collapse state survives refreshes
function loadExpandedTodoIds() {
  try { return new Set(JSON.parse(localStorage.getItem('study_todo_expanded') || '[]')); }
  catch { return new Set(); }
}
function saveExpandedTodoIds() {
  try { localStorage.setItem('study_todo_expanded', JSON.stringify([...expandedTodoIds])); } catch {}
}
function saveData(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    console.error('[saveData] 序列化失败 (' + key + '):', e.message);
    // Fallback: try removing problematic _rawLogs and _ prefixed fields before retry
    if (key === 'study_ai_convs' && Array.isArray(data)) {
      try {
        const cleaned = data.map(c => {
          if (c && typeof c === 'object') {
            const copy = {};
            for (const [k, v] of Object.entries(c)) {
              if (!k.startsWith('_')) copy[k] = v;
            }
            return copy;
          }
          return c;
        });
        localStorage.setItem(key, JSON.stringify(cleaned));
        console.warn('[saveData] 已清理 _ 前缀字段后重试成功');
        return;
      } catch (e2) {
        console.error('[saveData] 清理后重试仍然失败:', e2.message);
      }
    }
    // If all fails, try saving without the problematic conversation
    if (key.startsWith('study_')) {
      try {
        const fallback = { _saveError: true, _errorTime: new Date().toISOString() };
        localStorage.setItem(key, JSON.stringify(fallback));
        console.warn('[saveData] 使用降级数据保存');
      } catch (_) { /* give up */ }
    }
  }
}

let todos = loadData('study_todos_v2');
let links = loadData('study_links_v3');
let notes = loadData('study_notes_v2');
let activeNoteId = localStorage.getItem('study_active_note') ? Number(localStorage.getItem('study_active_note')) : null;
let changelog = loadData('study_changelog');

// Migrate: single note to multi-note
if (notes.length === 0 && localStorage.getItem('study_notes')) {
  const oldContent = localStorage.getItem('study_notes');
  notes = [{ id: genId(), title: '我的笔记', content: oldContent, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
  activeNoteId = notes[0].id;
  saveData('study_notes_v2', notes);
  localStorage.removeItem('study_notes');
}
// Migrate old links without type
links = links.map(l => ({ ...l, type: l.type || 'link' }));
// Migrate old todos without content/tags
todos = todos.map(t => ({ ...t, content: t.content || '', tags: t.tags || [] }));
// Migrate old completed todos without completedAt — estimate from id timestamp
todos = todos.map(t => {
  if (t.done && !t.completedAt) {
    const ts = t.id;
    const d = new Date(ts);
    t.completedAt = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  return t;
});

// ═══════════ State ═══════════
let expandedTodoIds = loadExpandedTodoIds();
let pickerExpandedIds = new Set(); // For the todo picker panel
let focusExpandedIds = new Set(); // For the focus list
let currentTodoRoot = null;
let activeSubInputId = null;
let todoInputOpen = false;
let linkInputOpen = false;
let todoSearchQuery = '';
// editModalOpen is declared in todos.js
let todoHideDone = false; // Whether to hide completed todos
let todoMultiSelectMode = false; // Whether multi-select mode is active
let todoSelectedIds = new Set(); // IDs selected in multi-select mode
let notesDebounceId = null;
let notesUndoStack = []; // [{noteId, content, title, timestamp}]
let notesRedoStack = []; // [{noteId, content, title, timestamp}]
let todoUndoStack = []; // [{todos, expanded, timestamp}]
let todoRedoStack = []; // full state snapshots for todo operations
let notesSaveTimeout = null;
let sidebarOpen = false;
let changelogModalOpen = false;

// ═══════════ Sidebar (hover-triggered) ═══════════
let sidebarCloseTimer = null;
const SIDEBAR_HOVER_DELAY = 250; // ms before closing after mouse leaves

function openSidebar() {
  if (sidebarCloseTimer) { clearTimeout(sidebarCloseTimer); sidebarCloseTimer = null; }
  if (!sidebarOpen) {
    sidebarOpen = true;
    document.getElementById('sidebar').classList.add('open');
    localStorage.setItem('study_sidebar_open', true);
  }
}

function scheduleCloseSidebar() {
  sidebarCloseTimer = setTimeout(() => {
    sidebarOpen = false;
    document.getElementById('sidebar').classList.remove('open');
    localStorage.setItem('study_sidebar_open', false);
  }, SIDEBAR_HOVER_DELAY);
}

function initSidebarHover() {
  const trigger = document.getElementById('sidebarHoverTrigger');
  const sidebar = document.getElementById('sidebar');
  if (!trigger || !sidebar) return;

  trigger.addEventListener('mouseenter', openSidebar);
  sidebar.addEventListener('mouseenter', openSidebar);
  sidebar.addEventListener('mouseleave', scheduleCloseSidebar);
  // Also close if mouse leaves the trigger (when sidebar isn't open yet)
  trigger.addEventListener('mouseleave', () => {
    if (!sidebarOpen) { /* nothing to close */ }
  });
}

// ═══════════ Dark Mode ═══════════
function getTheme() { return localStorage.getItem('study_theme') || 'light'; }
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('themeIcon');
  icon.setAttribute('data-lucide', theme === 'dark' ? 'sun' : 'moon');
  if (typeof lucide !== 'undefined') lucide.createIcons();
  localStorage.setItem('study_theme', theme);
  // Apply custom theme CSS overrides (if any)
  if (typeof applyCustomTheme === 'function') applyCustomTheme();
}
function toggleTheme() {
  applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

// ── Apply theme on init ──
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(getTheme());
});

// ═══════════ Tab Switching ═══════════
function switchTab(tab) {
  // Save AI chat draft when leaving AI page
  if (document.getElementById('section-ai')?.classList.contains('active') && tab !== 'ai') {
    if (typeof saveAiDraft === 'function') saveAiDraft();
  }
  // Check/update note summary when leaving notes page
  if (document.getElementById('section-notes')?.classList.contains('active') && tab !== 'notes') {
    if (typeof checkAndUpdateSummary === 'function') checkAndUpdateSummary();
  }
  document.querySelectorAll('.sidebar-nav-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  const navBtn = document.getElementById('nav-' + tab);
  if (navBtn) navBtn.classList.add('active');
  const sectionEl = document.getElementById('section-' + tab);
  if (!sectionEl) return;
  sectionEl.classList.add('active');
  // 动态扩展面板：触发其自定义 render
  if (typeof window.ExtManager !== 'undefined' && window.ExtManager.switchToExtSection) {
    window.ExtManager.switchToExtSection(tab);
  }
  if (tab === 'todo' && typeof refreshRepeatTodos === 'function') refreshRepeatTodos();
  if (tab === 'notes') renderNotes();
  if (tab === 'ai') renderAiChat();
  if (tab === 'today') renderToday();
  if (tab === 'calendar') renderCalendar();
  if (tab === 'timer') renderTimer();
  if (tab === 'habits') renderHabits();
  if (tab === 'friends') { if (typeof renderFriends === 'function') renderFriends(); }
  if (tab === 'trash') { if (typeof renderTrash === 'function') renderTrash(); }
  if (tab === 'archive') { if (typeof renderArchive === 'function') renderArchive(); }
  // links / music / stats 由内置扩展（builtin-links / builtin-music / builtin-stats）负责渲染
  if (tab === 'codegen') { if (typeof renderCodegen === 'function') renderCodegen(); }
  if (tab === 'extensions') { if (typeof renderExtensionsPanel === 'function') renderExtensionsPanel(); }
  // Initialize Lucide icons for dynamically rendered content
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}

// ═══════════ Navigation Management ═══════════
const ALL_NAV_ITEMS = [
  { id: 'todo',      icon: 'check-square',  label: '待办' },
  { id: 'notes',     icon: 'file-text',     label: '笔记' },
  { id: 'today',     icon: 'calendar-check',label: '今天' },
  { id: 'calendar',  icon: 'calendar',      label: '日历' },
  { id: 'timer',     icon: 'timer',         label: '计时器' },
  { id: 'friends',   icon: 'users',         label: '好友' },
  { id: 'habits',    icon: 'target',        label: '习惯' },
  { id: 'ai',        icon: 'bot',           label: 'AI 助手' },
  { id: 'codegen',   icon: 'code-2',        label: 'AI 编程' },
  { id: 'extensions',icon: 'puzzle',        label: '扩展' },
  { id: 'trash',     icon: 'trash-2',       label: '回收站' },
  { id: 'archive',   icon: 'archive',       label: '归档' }
];

function loadNavConfig() {
  let cfg;
  try {
    const saved = JSON.parse(localStorage.getItem('study_nav_config'));
    cfg = (saved && saved.order) ? saved : { order: [], hidden: (saved && saved.hidden) || [], homeTab: (saved && saved.homeTab) || 'today' };
  } catch (e) {
    cfg = { order: [], hidden: [], homeTab: 'today' };
  }
  // 动态扩展导航项（内置扩展 / 插件注册）也保留在排序配置中
  const dynIds = (typeof window.ExtManager !== 'undefined' && window.ExtManager.getDynamicNavItems)
    ? window.ExtManager.getDynamicNavItems().map(d => d.id) : [];
  const allIds = [...ALL_NAV_ITEMS.map(n => n.id), ...dynIds];
  if (cfg.order.length === 0) cfg.order = allIds.slice();
  const newIds = allIds.filter(id => !cfg.order.includes(id));
  cfg.order = [...cfg.order.filter(id => allIds.includes(id)), ...newIds];
  if (!Array.isArray(cfg.hidden)) cfg.hidden = [];
  return cfg;
}

function saveNavConfig(cfg) {
  localStorage.setItem('study_nav_config', JSON.stringify(cfg));
}

function renderSidebarNav() {
  const nav = document.getElementById('sidebarNav');
  if (!nav) return;
  const cfg = loadNavConfig();
  // 合并动态扩展侧边栏项（追加到末尾，去重）
  let dynamicIds = [];
  if (typeof window.ExtManager !== 'undefined' && window.ExtManager.getDynamicNavItems) {
    dynamicIds = window.ExtManager.getDynamicNavItems();
  }
  const mergedOrder = [];
  cfg.order.forEach(id => mergedOrder.push(id));
  dynamicIds.forEach(d => { if (!mergedOrder.includes(d.id)) mergedOrder.push(d.id); });
  let visibleIdx = 0;
  nav.innerHTML = mergedOrder.map((tabId, i) => {
    const info = ALL_NAV_ITEMS.find(n => n.id === tabId);
    const dyn = dynamicIds.find(d => d.id === tabId);
    if (!info && !dyn) return '';
    const icon = info ? info.icon : dyn.icon;
    const label = info ? info.label : dyn.label;
    const isHidden = cfg.hidden.includes(tabId);
    if (isHidden) return '';
    const keyHint = visibleIdx < 9 ? `<span class="nav-key-hint">Ctrl+${visibleIdx + 1}</span>` : '';
    visibleIdx++;
    return `<button class="sidebar-nav-item" onclick="switchTab('${tabId}')" id="nav-${tabId}">
      <i data-lucide="${icon}" class="lucide-icon"></i>${label}${keyHint}
    </button>`;
  }).join('');
  // Mark active tab
  const activeSection = document.querySelector('.section.active');
  if (activeSection) {
    const activeId = activeSection.id.replace('section-', '');
    const activeBtn = document.getElementById('nav-' + activeId);
    if (activeBtn) activeBtn.classList.add('active');
  }
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}

// 全部导航项（核心 + 动态扩展项），供编辑界面栏使用
function getNavDisplayItems() {
  const dyn = (typeof window.ExtManager !== 'undefined' && window.ExtManager.getDynamicNavItems)
    ? window.ExtManager.getDynamicNavItems() : [];
  return [...ALL_NAV_ITEMS, ...dyn];
}

function openNavSettings() {
  const cfg = loadNavConfig();
  const body = document.getElementById('editModalBody');
  const title = document.getElementById('editModalTitle');
  title.innerHTML = '<i data-lucide="sliders-horizontal" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> 编辑界面栏';
  const homeOptions = getNavDisplayItems().filter(n => !cfg.hidden.includes(n.id)).map(n =>
    `<option value="${n.id}" ${cfg.homeTab === n.id ? 'selected' : ''}>${n.label}</option>`
  ).join('');
  body.innerHTML = `
    <p class="hint" style="margin-bottom:10px;">拖拽排序，勾选控制显示/隐藏。Ctrl+数字键快速跳转。</p>
    <div class="modal-field" style="margin-bottom:10px;">
      <label>🏠 启动时默认进入</label>
      <select id="navHomeSelect" onchange="onNavHomeChange()">${homeOptions}</select>
    </div>
    <div id="navSortList" style="display:flex;flex-direction:column;gap:4px;"></div>
    <button class="btn-save-modal" onclick="saveNavSettings()" style="margin-top:10px;">💾 保存</button>
  `;
  renderNavSortList(cfg);
  editModalOpen = true;
  document.getElementById('editModal').classList.add('open');
  setTimeout(() => document.getElementById('editModal').focus(), 100);
}

function onNavHomeChange() {
  const cfg = loadNavConfig();
  cfg.homeTab = document.getElementById('navHomeSelect').value;
  saveNavConfig(cfg);
}

function renderNavSortList(cfg) {
  const list = document.getElementById('navSortList');
  if (!list) return;
  const displayItems = getNavDisplayItems();
  let visibleIdx = 0;
  list.innerHTML = cfg.order.map((tabId, i) => {
    const info = displayItems.find(n => n.id === tabId);
    if (!info) return '';
    const isHidden = cfg.hidden.includes(tabId);
    const shortcut = !isHidden && visibleIdx < 9 ? `<span class="nav-sort-shortcut">Ctrl+${visibleIdx + 1}</span>` : '';
    if (!isHidden) visibleIdx++;
    return `<div class="nav-sort-item" data-id="${tabId}" draggable="true">
      <span class="nav-sort-grip" draggable="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>
      </span>
      <i data-lucide="${info.icon}" class="lucide-icon" style="width:16px;height:16px;"></i>
      <span class="nav-sort-label">${info.label}</span>
      ${shortcut}
      <label class="nav-sort-toggle">
        <input type="checkbox" ${isHidden ? '' : 'checked'} onchange="toggleNavItemVisibility('${tabId}')">
        <span class="nav-sort-toggle-slider"></span>
      </label>
    </div>`;
  }).join('');
  initNavSortDrag();
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}

function toggleNavItemVisibility(tabId) {
  const cfg = loadNavConfig();
  const idx = cfg.hidden.indexOf(tabId);
  if (idx >= 0) cfg.hidden.splice(idx, 1);
  else cfg.hidden.push(tabId);
  saveNavConfig(cfg);
  // Re-render the sort list so shortcut numbers update for visible-only items
  renderNavSortList(cfg);
  // 立即刷新侧边栏，让显示/隐藏即时生效
  renderSidebarNav();
}

function saveNavSettings() {
  const items = document.querySelectorAll('#navSortList .nav-sort-item');
  const order = [];
  for (const item of items) {
    order.push(item.dataset.id);
  }
  const cfg = loadNavConfig();
  cfg.order = order;
  saveNavConfig(cfg);
  closeEditModal();
  renderSidebarNav();
}

// ── Nav sort drag & drop ──
let _navDragId = null;
function initNavSortDrag() {
  const list = document.getElementById('navSortList');
  if (!list) return;
  list.querySelectorAll('.nav-sort-item').forEach(el => {
    el.addEventListener('dragstart', function(e) {
      _navDragId = this.dataset.id;
      this.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', function() {
      this.classList.remove('dragging');
      _navDragId = null;
      document.querySelectorAll('.nav-sort-item').forEach(i => i.classList.remove('drag-over'));
    });
    el.addEventListener('dragover', function(e) {
      e.preventDefault();
      if (!_navDragId || this.dataset.id === _navDragId) return;
      document.querySelectorAll('.nav-sort-item').forEach(i => i.classList.remove('drag-over'));
      this.classList.add('drag-over');
    });
    el.addEventListener('drop', function(e) {
      e.preventDefault();
      if (!_navDragId || this.dataset.id === _navDragId) return;
      const from = document.querySelector(`.nav-sort-item[data-id="${_navDragId}"]`);
      const to = this;
      if (from && to && from !== to) {
        const parent = list;
        const idx = Array.from(parent.children).indexOf(to);
        if (idx >= 0) {
          if (from.parentNode) from.parentNode.removeChild(from);
          if (idx >= parent.children.length) parent.appendChild(from);
          else parent.insertBefore(from, parent.children[idx]);
        }
      }
    });
  });
}

// ═══════════ Keyboard shortcuts: Ctrl+number → switch tab ═══════════
document.addEventListener('keydown', function(e) {
  if (!e.ctrlKey && !e.metaKey) return;
  const num = parseInt(e.key);
  if (num < 1 || num > 9) return;
  // Don't interfere with text editing
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const cfg = loadNavConfig();
  const visibleItems = cfg.order.filter(id => !cfg.hidden.includes(id));
  const idx = num - 1;
  if (idx < visibleItems.length) {
    e.preventDefault();
    switchTab(visibleItems[idx]);
  }
});
