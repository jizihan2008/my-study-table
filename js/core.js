
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
    // 同步钩子：通知 sync.js 该 key 发生本地变更（PWA/云同步）
    if (typeof window.Sync !== 'undefined' && window.Sync.onLocalChange) {
      try { window.Sync.onLocalChange(key); } catch (e) { /* 同步层错误不影响主流程 */ }
    }
  } catch (e) {
    console.error('[saveData] 序列化失败 (' + key + '):', e.message);
    // Fallback: try removing problematic _rawLogs and _ prefixed fields before retry
    // 注意：必须保留 _dailyReport/_hasUnread/_hasUnreadAuto 等关键标记字段，否则日报对话标记会丢失导致重复新建
    if (key === 'study_ai_convs' && Array.isArray(data)) {
      try {
        const cleaned = data.map(c => {
          if (c && typeof c === 'object') {
            const copy = {};
            for (const [k, v] of Object.entries(c)) {
              if (!k.startsWith('_') || k === '_dailyReport' || k === '_hasUnread' || k === '_hasUnreadAuto') {
                copy[k] = v;
              }
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
  // 移动端底部导航栏为动态渲染，DOM 就绪后确保首次渲染（含桌面窗口 resize 到移动宽度时）
  if (typeof renderMobileTabbar === 'function') renderMobileTabbar('');
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
  if (tab === 'taskline' && typeof renderTaskLine === 'function') renderTaskLine();
  if (tab === 'notes') renderNotes();
  if (tab === 'books') { if (typeof renderBooks === 'function') renderBooks(); }
  if (tab === 'ai') renderAiChat();
  if (tab === 'today') renderToday();
  if (tab === 'calendar') renderCalendar();
  if (tab === 'timer') renderTimer();
  if (tab === 'habits') renderHabits();
  if (tab === 'inbox') { if (typeof window.Inbox !== 'undefined' && window.Inbox.render) window.Inbox.render(); }
  if (tab === 'friends') { if (typeof renderFriends === 'function') renderFriends(); }
  if (tab === 'trash') { if (typeof renderTrash === 'function') renderTrash(); }
  if (tab === 'archive') { if (typeof renderArchive === 'function') renderArchive(); }
  // links / music / stats 由内置扩展（builtin-links / builtin-music / builtin-stats）负责渲染
  if (tab === 'codegen') { if (typeof renderCodegen === 'function') renderCodegen(); }
  if (tab === 'extensions') { if (typeof renderExtensionsPanel === 'function') renderExtensionsPanel(); }
  if (tab === 'store') { if (typeof window.Store !== 'undefined' && window.Store.renderStore) window.Store.renderStore(); }
  // Initialize Lucide icons for dynamically rendered content
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
  // 同步移动端底部导航激活态
  updateMobileTabbar(tab);
  // 移动端切换后关闭抽屉
  closeMobileDrawer();
}

// ═══════════ 触屏长按 → 右键菜单（长按 500ms 触发 contextmenu）═══════════
(function initLongPress() {
  if (typeof window === 'undefined') return;
  const LONG_PRESS_MS = 500;
  let timer = null;
  let pressTarget = null;
  const startX = { x: 0, y: 0 };
  const moving = { x: 0, y: 0 };

  document.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    startX.x = moving.x = t.clientX;
    startX.y = moving.y = t.clientY;
    pressTarget = e.target;
    clearTimeout(timer);
    timer = setTimeout(function () {
      if (!pressTarget) return;
      const evt = new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        view: window,
        clientX: moving.x, clientY: moving.y
      });
      pressTarget.dispatchEvent(evt);
    }, LONG_PRESS_MS);
  }, { passive: true });

  function cancel() {
    clearTimeout(timer); timer = null; pressTarget = null;
  }
  document.addEventListener('touchmove', function (e) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    moving.x = t.clientX; moving.y = t.clientY;
    // 位移过大视为滚动，取消长按
    if (Math.abs(moving.x - startX.x) > 12 || Math.abs(moving.y - startX.y) > 12) {
      cancel();
    }
  }, { passive: true });
  document.addEventListener('touchend', cancel);
  document.addEventListener('touchcancel', cancel);
})();

// ═══════════ Mobile Navigation（PWA 手机端）═══════════
// PWA 端隐藏的桌面专属导航入口（收件箱 / 编程 AI / 扩展等）
function isMobileHiddenNav(id) {
  if (typeof Env === 'undefined' || !Env.isPwa) return false;
  return ['inbox', 'codegen', 'extensions'].indexOf(id) !== -1;
}

// 移动端底部导航固定模块 id（不含「更多」，more 始终在最右）
function getMobileBottomTabs() {
  const cfg = loadNavConfig();
  const display = getNavDisplayItems();
  // 过滤：排除已隐藏、移动端不可见（PWA 收件箱/AI编程/扩展）、不在导航里的
  const base = cfg.bottomTabs.filter(id =>
    display.some(n => n.id === id) &&
    !cfg.hidden.includes(id) &&
    !isMobileHiddenNav(id)
  );
  // 确保至少 1 个（避免全部隐藏导致底部只剩「更多」），不足时用「今天」兜底
  if (base.length === 0) base.push('today');
  // 最多 4 个模块 Tab（加「更多」共 5 个，避免过挤）
  return base.slice(0, 4);
}

// 动态渲染移动端底部导航栏（由「编辑界面栏」的底部导航配置驱动）
function renderMobileTabbar(activeTab) {
  const bar = document.getElementById('mobileTabbar');
  if (!bar) return;
  const ids = getMobileBottomTabs();
  const display = getNavDisplayItems();
  const mkTab = (id) => {
    const info = display.find(n => n.id === id);
    if (!info) return '';
    return `<button class="mobile-tab ${activeTab === id ? 'active' : ''}" data-tab="${id}" onclick="switchTab('${id}')">
      <i data-lucide="${info.icon}" class="lucide-icon"></i><span>${info.label}</span>
    </button>`;
  };
  bar.innerHTML = ids.map(mkTab).join('') + `
    <button class="mobile-tab ${ids.indexOf(activeTab) === -1 ? 'active' : ''}" data-tab="more" onclick="openMobileMore()">
      <i data-lucide="layout-grid" class="lucide-icon"></i><span>更多</span>
    </button>`;
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}

function updateMobileTabbar(tab) {
  if (typeof Env === 'undefined' || !Env.isMobile) return;
  const bar = document.getElementById('mobileTabbar');
  if (!bar) return;
  const ids = getMobileBottomTabs();
  const tabs = bar.querySelectorAll('.mobile-tab');
  tabs.forEach(t => {
    const key = t.dataset.tab;
    const isActive = (key === tab) || (key === 'more' && ids.indexOf(tab) === -1);
    t.classList.toggle('active', !!isActive);
  });
}

function openMobileDrawer() {
  document.getElementById('sidebar').classList.add('open');
  const ov = document.getElementById('mobileDrawerOverlay');
  if (ov) ov.classList.add('open');
  document.body.classList.add('mobile-drawer-open');
}
function closeMobileDrawer() {
  if (!window.innerWidth || window.innerWidth > 800) return;
  document.getElementById('sidebar').classList.remove('open');
  const ov = document.getElementById('mobileDrawerOverlay');
  if (ov) ov.classList.remove('open');
  document.body.classList.remove('mobile-drawer-open');
}

function openMobileMore() {
  const panel = document.getElementById('mobileMorePanel');
  const ov = document.getElementById('mobileMoreOverlay');
  if (!panel) return;
  const cfg = loadNavConfig();
  const all = getNavDisplayItems();
  const order = cfg.order.concat(all.filter(n => !cfg.order.includes(n.id)).map(n => n.id));
  panel.innerHTML = order.filter(id => !cfg.hidden.includes(id) && !isMobileHiddenNav(id)).map(id => {
    const info = all.find(n => n.id === id);
    if (!info) return '';
    return `<button class="mobile-more-item" onclick="switchTab('${id}');closeMobileMore();">
      <i data-lucide="${info.icon}" class="lucide-icon"></i><span>${info.label}</span>${info.badge ? `<span class="nav-badge">${info.badge}</span>` : ''}
    </button>`;
  }).join('') +
    `<div class="mobile-more-sep"></div>` +
    `<button class="mobile-more-item" onclick="closeMobileMore();openSettingsModal();"><i data-lucide="settings" class="lucide-icon"></i><span>设置</span></button>` +
    `<button class="mobile-more-item" onclick="closeMobileMore();openHelpModal();"><i data-lucide="help-circle" class="lucide-icon"></i><span>帮助</span></button>` +
    `<button class="mobile-more-item" onclick="closeMobileMore();openNavSettings();"><i data-lucide="sliders-horizontal" class="lucide-icon"></i><span>编辑界面栏</span></button>` +
    `<button class="mobile-more-item" onclick="closeMobileMore();openChangelogModal();"><i data-lucide="list" class="lucide-icon"></i><span>更新日志</span></button>`;
  if (ov) ov.classList.add('open');
  panel.classList.add('open');
  document.body.classList.add('mobile-drawer-open');
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}
function closeMobileMore() {
  const panel = document.getElementById('mobileMorePanel');
  const ov = document.getElementById('mobileMoreOverlay');
  if (panel) panel.classList.remove('open');
  if (ov) ov.classList.remove('open');
  document.body.classList.remove('mobile-drawer-open');
}

// ═══════════ Navigation Management ═══════════
const ALL_NAV_ITEMS = [
  { id: 'todo',      icon: 'check-square',  label: '待办' },
  { id: 'taskline',  icon: 'swords',        label: '任务线' },
  { id: 'notes',     icon: 'file-text',     label: '笔记' },
  { id: 'books',     icon: 'library',       label: '教材' },
  { id: 'today',     icon: 'calendar-check',label: '今天' },
  { id: 'calendar',  icon: 'calendar',      label: '日历' },
  { id: 'timer',     icon: 'timer',         label: '计时器' },
  { id: 'inbox',     icon: 'inbox',         label: '收件箱', badge: '测试' },
  { id: 'friends',   icon: 'users',         label: '好友' },
  { id: 'habits',    icon: 'target',        label: '习惯' },
  { id: 'ai',        icon: 'bot',           label: 'AI 助手' },
  { id: 'codegen',   icon: 'code-2',        label: 'AI 编程' },
  { id: 'extensions',icon: 'puzzle',        label: '扩展' },
  { id: 'store',     icon: 'store',         label: '插件市场' },
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
  // 底部导航固定模块（移动端），默认 today/todo/notes/calendar + 「更多」固定在最右
  if (!Array.isArray(cfg.bottomTabs)) cfg.bottomTabs = ['today', 'todo', 'notes', 'calendar'];
  // 过滤掉已隐藏或移动端不显示、或不在导航里的底部 Tab
  cfg.bottomTabs = cfg.bottomTabs.filter(id => id !== 'more' && allIds.includes(id));
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
    const badge = (info && info.badge) || (dyn && dyn.badge) || '';
    const isHidden = cfg.hidden.includes(tabId) || isMobileHiddenNav(tabId);
    if (isHidden) return '';
    const keyHint = visibleIdx < 9 ? `<span class="nav-key-hint">Ctrl+${visibleIdx + 1}</span>` : '';
    visibleIdx++;
    return `<button class="sidebar-nav-item" onclick="switchTab('${tabId}')" id="nav-${tabId}">
      <i data-lucide="${icon}" class="lucide-icon"></i>${label}${badge ? `<span class="nav-badge">${badge}</span>` : ''}${keyHint}
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
  // 同步刷新移动端底部导航（配置变更后底部 Tab 也即时更新）
  if (typeof renderMobileTabbar === 'function') renderMobileTabbar(activeSection ? activeSection.id.replace('section-', '') : '');
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
    <div class="nav-bottom-title">📱 底部导航栏（手机端固定，最多 4 个）</div>
    <div class="hint" style="margin-bottom:8px;">下方已固定模块可<b>拖拽排序</b>或点击 ✕ 移除；勾选下方模块可添加到手机底部（「更多」始终在最右，其余从「更多」抽屉进入）。</div>
    <div id="navBottomTabs" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;"></div>
    <button class="btn-save-modal" onclick="saveNavSettings()" style="margin-top:10px;">💾 保存</button>
  `;
  renderNavSortList(cfg);
  renderNavBottomTabs();
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
      <span class="nav-sort-move" style="display:inline-flex;gap:4px;align-items:center;margin-left:auto;">
        <button class="nav-sort-arrow" onclick="moveNavItem('${tabId}',-1)" title="上移"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="m18 15-6-6-6 6"/></svg></button>
        <button class="nav-sort-arrow" onclick="moveNavItem('${tabId}',1)" title="下移"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="m6 9 6 6 6-6"/></svg></button>
      </span>
      <label class="nav-sort-toggle">
        <input type="checkbox" ${isHidden ? '' : 'checked'} onchange="toggleNavItemVisibility('${tabId}')">
        <span class="nav-sort-toggle-slider"></span>
      </label>
    </div>`;
  }).join('');
  initNavSortDrag();
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}

// 移动端排序替代：上移/下移按钮（触屏友好，桌面上箭头按钮隐藏）
function moveNavItem(id, dir) {
  const cfg = loadNavConfig();
  const idx = cfg.order.indexOf(id);
  if (idx < 0) return;
  const to = idx + dir;
  if (to < 0 || to >= cfg.order.length) return;
  const tmp = cfg.order[idx];
  cfg.order[idx] = cfg.order[to];
  cfg.order[to] = tmp;
  saveNavConfig(cfg);
  renderNavSortList(cfg);
  renderSidebarNav();
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

// 底部导航栏编辑区：已固定模块可拖拽排序，可选模块点击添加（最多 4 个，「更多」始终在最右）
function renderNavBottomTabs() {
  const wrap = document.getElementById('navBottomTabs');
  if (!wrap) return;
  const cfg = loadNavConfig();
  const display = getNavDisplayItems();
  const byId = {};
  display.forEach(function(n) { byId[n.id] = n; });
  // 已固定的底部模块（保持 bottomTabs 顺序）
  const fixed = cfg.bottomTabs.filter(function(id) { return byId[id] && !cfg.hidden.includes(id); });
  // 可选的底部模块：未隐藏、非移动端隐藏、非 more、且未固定
  const options = display.filter(function(n) {
    return n.id !== 'more' && !cfg.hidden.includes(n.id) && !isMobileHiddenNav(n.id) && fixed.indexOf(n.id) === -1;
  });
  wrap.innerHTML = `
    <div id="navBottomSortList" class="nav-bottom-sort-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;">
      ${fixed.length ? fixed.map(function(id) {
        const n = byId[id];
        return `<div class="nav-bottom-sort-item" data-id="${id}">
          <span class="nav-sort-grip nav-bottom-grip" draggable="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>
          </span>
          <i data-lucide="${n.icon}" class="lucide-icon" style="width:15px;height:15px;"></i>
          <span class="nav-bottom-label">${n.label}</span>
          <button class="nav-bottom-remove" onclick="removeNavBottomTab('${id}')" title="移除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>`;
      }).join('') : '<div class="hint" style="font-size:12px;">尚未固定任何模块（手机底部将只显示「更多」）</div>'}
    </div>
    <div class="nav-bottom-addlist" style="display:flex;flex-wrap:wrap;gap:8px;">
      ${options.length ? options.map(function(n) {
        return `<label class="nav-bottom-chip">
          <input type="checkbox" onchange="addNavBottomTab('${n.id}')">
          <i data-lucide="${n.icon}" class="lucide-icon" style="width:13px;height:13px;"></i>
          <span>${n.label}</span>
        </label>`;
      }).join('') : '<span class="hint" style="font-size:12px;">已无更多可选模块</span>'}
    </div>`;
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
  initNavBottomSort(listifyNavBottom);
}

// 触屏/鼠标拖拽后从 DOM 顺序回写 bottomTabs
function listifyNavBottom() {
  const list = document.getElementById('navBottomSortList');
  if (!list) return;
  const cfg = loadNavConfig();
  cfg.bottomTabs = Array.from(list.children).map(function(c) { return c.dataset.id; }).filter(Boolean);
  saveNavConfig(cfg);
}

// 为底部排序列表初始化拖拽（鼠标 + 触屏）
function initNavBottomSort(onChange) {
  const list = document.getElementById('navBottomSortList');
  if (!list) return;
  // 鼠标：HTML5 拖拽
  list.querySelectorAll('.nav-bottom-sort-item').forEach(function(el) {
    el.draggable = true;
    el.addEventListener('dragstart', function() {
      el.classList.add('dragging');
      _navDragId = el.dataset.id;
    });
    el.addEventListener('dragend', function() {
      el.classList.remove('dragging');
      _navDragId = null;
      if (onChange) onChange();
      renderSidebarNav();
    });
    el.addEventListener('dragover', function(e) { e.preventDefault(); });
    el.addEventListener('drop', function(e) {
      e.preventDefault();
      if (!_navDragId || this.dataset.id === _navDragId) return;
      const from = document.querySelector('.nav-bottom-sort-item[data-id="' + _navDragId + '"]');
      const to = this;
      if (from && to && from !== to) {
        const idx = Array.from(list.children).indexOf(to);
        if (idx >= 0) {
          if (from.parentNode) from.parentNode.removeChild(from);
          if (idx >= list.children.length) list.appendChild(from);
          else list.insertBefore(from, list.children[idx]);
        }
      }
    });
  });
  // 触屏：长按拖动
  list.querySelectorAll('.nav-bottom-sort-item').forEach(function(el) {
    let longPress = false, touchId = null, startY = 0;
    el.addEventListener('touchstart', function(e) {
      if (e.target.closest('.nav-bottom-remove')) return;
      const t = e.changedTouches[0];
      touchId = t.identifier; startY = t.clientY; longPress = false;
      clearTimeout(_navTouchTimer);
      _navTouchTimer = setTimeout(function() {
        longPress = true; _navDragId = el.dataset.id;
        el.classList.add('touch-dragging');
      }, 250);
    });
    el.addEventListener('touchmove', function(e) {
      if (!longPress) return;
      e.preventDefault();
      const t = Array.from(e.changedTouches).find(function(x) { return x.identifier === touchId; });
      if (!t) return;
      const y = t.clientY;
      Array.from(list.children).forEach(function(i) {
        if (i === el) return;
        const r = i.getBoundingClientRect();
        const before = y < (r.top + r.height / 2);
        if (before) { if (el.previousElementSibling !== i) list.insertBefore(el, i); }
        else { if (el.nextElementSibling !== i) list.insertBefore(el, i.nextElementSibling); }
      });
    }, { passive: false });
    el.addEventListener('touchend', function() {
      clearTimeout(_navTouchTimer);
      if (longPress) {
        longPress = false; el.classList.remove('touch-dragging'); _navDragId = null;
        if (onChange) onChange();
        renderSidebarNav();
      }
      touchId = null;
    });
    el.addEventListener('touchcancel', function() {
      clearTimeout(_navTouchTimer); longPress = false; el.classList.remove('touch-dragging'); _navDragId = null; touchId = null;
    });
  });
}

function addNavBottomTab(tabId) {
  const cfg = loadNavConfig();
  if (cfg.bottomTabs.length >= 4) {
    if (typeof showToast === 'function') showToast('底部导航最多固定 4 个模块');
    else alert('底部导航最多固定 4 个模块');
    renderNavBottomTabs();
    return;
  }
  cfg.bottomTabs.push(tabId);
  saveNavConfig(cfg);
  renderNavBottomTabs();
  renderSidebarNav();
}

function removeNavBottomTab(tabId) {
  const cfg = loadNavConfig();
  const idx = cfg.bottomTabs.indexOf(tabId);
  if (idx >= 0) cfg.bottomTabs.splice(idx, 1);
  saveNavConfig(cfg);
  renderNavBottomTabs();
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
  initNavSortTouch(list);
}

// ── 触屏拖拽排序（手机长按 + 拖动）──
let _navTouchTimer = null;
function initNavSortTouch(list) {
  if (!list) return;
  list.querySelectorAll('.nav-sort-item').forEach(el => {
    let longPress = false;
    let startY = 0;
    let touchId = null;

    el.addEventListener('touchstart', function(e) {
      // 点击上移/下移按钮时不触发拖拽
      if (e.target.closest('.nav-sort-arrow') || e.target.closest('.nav-sort-toggle')) return;
      const t = e.changedTouches[0];
      touchId = t.identifier;
      startY = t.clientY;
      longPress = false;
      clearTimeout(_navTouchTimer);
      _navTouchTimer = setTimeout(function() {
        longPress = true;
        _navDragId = el.dataset.id;
        el.classList.add('dragging');
        el.classList.add('touch-dragging');
        // 通知列表项让出空间
        document.querySelectorAll('.nav-sort-item').forEach(function(i) { if (i !== el) i.classList.add('drag-over'); });
        try { el.scrollIntoView({ block: 'nearest' }); } catch (err) {}
      }, 250);
    });

    el.addEventListener('touchmove', function(e) {
      if (!longPress) return;
      e.preventDefault();
      const t = Array.from(e.changedTouches).find(function(x) { return x.identifier === touchId; });
      if (!t) return;
      const y = t.clientY;
      const items = Array.from(list.children);
      const self = el;
      items.forEach(function(i) {
        if (i === self) return;
        const r = i.getBoundingClientRect();
        const before = y < (r.top + r.height / 2);
        const already = (self.nextElementSibling === i && !before) || (self.previousElementSibling === i && before);
        if (already) return;
        if (before) { if (self.previousElementSibling !== i) list.insertBefore(self, i); }
        else { if (self.nextElementSibling !== i) list.insertBefore(self, i.nextElementSibling); }
      });
    }, { passive: false });

    el.addEventListener('touchend', function(e) {
      clearTimeout(_navTouchTimer);
      const changed = e.changedTouches;
      const t = Array.from(changed).find(function(x) { return x.identifier === touchId; });
      if (longPress) {
        longPress = false;
        el.classList.remove('dragging');
        el.classList.remove('touch-dragging');
        document.querySelectorAll('.nav-sort-item').forEach(function(i) { i.classList.remove('drag-over'); });
        _navDragId = null;
        if (t && Math.abs(t.clientY - startY) < 5) {
          // 长按但没移动：视为普通点击，不排序
        }
      }
      touchId = null;
    });
    el.addEventListener('touchcancel', function() {
      clearTimeout(_navTouchTimer);
      longPress = false;
      el.classList.remove('dragging');
      el.classList.remove('touch-dragging');
      document.querySelectorAll('.nav-sort-item').forEach(function(i) { i.classList.remove('drag-over'); });
      _navDragId = null;
      touchId = null;
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
