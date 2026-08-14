// ═══════════ Today: Check-in ═══════════
const MOTIVATIONAL_QUOTES = [
  { text: '不积跬步，无以至千里；不积小流，无以成江海。', emoji: '🐾' },
  { text: '今天的努力，是明天成功的基石。', emoji: '💎' },
  { text: '比你优秀的人比你更努力，你还有什么理由不奋斗？', emoji: '⚡' },
  { text: '每一个不曾起舞的日子，都是对生命的辜负。', emoji: '💃' },
  { text: '自律给我自由，坚持给我力量。', emoji: '🦁' },
  { text: '千里之行，始于足下。', emoji: '👣' },
  { text: '你若盛开，蝴蝶自来；你若精彩，天自安排。', emoji: '🦋' },
  { text: '只有极其努力，才能看起来毫不费力。', emoji: '✨' },
  { text: '所有的幸运，都是努力埋下的伏笔。', emoji: '🍀' },
  { text: '坚持就是胜利，放弃就是失败。', emoji: '🏆' },
  { text: '人生没有白走的路，每一步都算数。', emoji: '🛤️' },
  { text: '做最好的自己，而不是别人的影子。', emoji: '🌟' },
  { text: '世界上最快乐的事，莫过于为理想而奋斗。', emoji: '🚀' },
  { text: '志当存高远，行当积跬步。', emoji: '⛰️' },
  { text: '耐心和持久胜过激烈和狂热。', emoji: '🌱' },
  { text: '学而不思则罔，思而不学则殆。', emoji: '📖' },
  { text: '业精于勤，荒于嬉；行成于思，毁于随。', emoji: '🎯' },
  { text: '天行健，君子以自强不息。', emoji: '☀️' },
  { text: '宝剑锋从磨砺出，梅花香自苦寒来。', emoji: '⚔️' },
  { text: '书山有路勤为径，学海无涯苦作舟。', emoji: '⛵' },
];

function getTodayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function loadCheckinData() {
  try {
    const data = JSON.parse(localStorage.getItem('study_checkin') || '{"dates":[],"streak":0,"lastDate":null}');
    // Migration: add checkinTimes if missing
    if (!data.checkinTimes) {
      data.checkinTimes = {};
    }
    return data;
  }
  catch { return { dates: [], streak: 0, lastDate: null, checkinTimes: {} }; }
}

function saveCheckinData(data) {
  // 走 saveData → 触发 Sync.onLocalChange → 打卡记录跨设备同步（此前直接 setItem 不通知同步）
  if (typeof saveData === 'function') {
    saveData('study_checkin', data);
  } else {
    localStorage.setItem('study_checkin', JSON.stringify(data));
  }
}

function getWeekDays() {
  const days = [];
  const today = new Date();
  const dayOfWeek = today.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(today);
  monday.setDate(today.getDate() + mondayOffset);
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const dayLabels = ['日', '一', '二', '三', '四', '五', '六'];
    days.push({
      dateStr,
      dayNum: d.getDate(),
      dayLabel: dayLabels[d.getDay()],
      isToday: dateStr === getTodayStr(),
    });
  }
  return days;
}

// ═══════════ Today: Focus ═══════════
// Focus data: { _date, items: [{todoId, text, done}] }

// Max focus count setting (2-5, default 3)
function getMaxFocusCount() {
  const val = parseInt(localStorage.getItem('study_max_focus_count'));
  if (val >= 2 && val <= 5) return val;
  return 3;
}

function saveMaxFocusSetting() {
  const input = document.getElementById('settingsMaxFocusCount');
  if (!input) return;
  let val = parseInt(input.value);
  if (isNaN(val) || val < 2) val = 2;
  if (val > 5) val = 5;
  input.value = val;
  localStorage.setItem('study_max_focus_count', val);
}

function loadFocusData() {
  try { return JSON.parse(localStorage.getItem('study_today_focus') || '{}'); }
  catch { return {}; }
}

function saveFocusData(data) {
  // 走 saveData → 触发 Sync.onLocalChange → 今日聚焦跨设备同步
  if (typeof saveData === 'function') {
    saveData('study_today_focus', data);
  } else {
    localStorage.setItem('study_today_focus', JSON.stringify(data));
  }
}

function getTodayFocusItems() {
  const data = loadFocusData();
  if (data.items) {
    // Remove focus items whose corresponding todo no longer exists
    let cleaned = false;
    data.items = data.items.filter(item => {
      const exists = todos.find(t => t.id === item.todoId);
      if (!exists) { cleaned = true; return false; }
      return true;
    });
    // Sync completion status from todos (two-way binding)
    data.items.forEach(item => {
      const todo = todos.find(t => t.id === item.todoId);
      if (todo && todo.done !== item.done) {
        item.done = todo.done;
      }
    });
    // Persist cleaned data
    if (cleaned) {
      saveFocusData(data);
    }
  }
  return data;
}

// Get top-level todos (roots for tree), plus search matches
function getAvailableTodos() {
  return todos.filter(t => t.parentId === null);
}

// Get all todos for search
function getAllAvailableTodos() {
  return todos.slice();
}

function getFocusTodoIds() {
  const data = getTodayFocusItems();
  return new Set((data.items || []).map(i => i.todoId));
}

// Render a focus todo node recursively, showing children if expanded
function renderFocusTodoNode(todoId, depth, isDirectFocus) {
  const todo = todos.find(t => t.id === todoId);
  if (!todo) return '';
  const children = getChildren(todoId);
  const hasKids = children.length > 0;
  const isExpanded = focusExpandedIds.has(todoId);
  const indent = depth * 16;

  const renderedChildren = children.map(c => renderFocusTodoNode(c.id, depth + 1, false)).join('');

  return `
    <div>
      <div class="today-focus-item${isDirectFocus ? '' : ' child'}" style="padding-left:${14 + indent}px;">
        ${hasKids ? `<button class="focus-expand${isExpanded ? ' expanded' : ''}" onclick="toggleFocusExpand(${todoId}, event)" title="展开/折叠">▶</button>` : '<span class="focus-expand-spacer"></span>'}
        <div class="focus-check${todo.done ? ' done' : ''}" onclick="event.stopPropagation(); toggleTodayFocusById(${todoId})" title="标记完成"></div>
        <span class="focus-text${todo.done ? ' completed' : ''}">${escapeHtml(todo.text)}</span>
        <button class="focus-nav" onclick="event.stopPropagation(); goToTodoFromFocus(${todoId})" title="跳转到待办目录">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
          去目录
        </button>
        ${isDirectFocus ? `<button class="focus-delete" onclick="event.stopPropagation(); deleteTodayFocusById(${todoId})" title="移除">✕</button>` : ''}
      </div>
      ${(hasKids && renderedChildren) ? `<div class="focus-children${isExpanded ? '' : ' collapsed'}">${renderedChildren}</div>` : ''}
    </div>
  `;
}

function renderFocusList() {
  const list = document.getElementById('todayFocusList');
  const count = document.getElementById('todayFocusCount');
  const addBtn = document.getElementById('todayFocusAddBtn');
  if (!list || !count) return;

  const data = getTodayFocusItems();
  const items = data.items || [];
  const doneCount = items.filter(i => i.done).length;

  const maxCount = getMaxFocusCount();
  if (count) count.textContent = doneCount + '/' + items.length;
  if (addBtn) addBtn.style.display = items.length >= maxCount ? 'none' : 'flex';

  if (items.length === 0) {
    list.innerHTML = '<div class="empty-state" style="padding:20px;"><p style="font-size:13px;">还没有今日目标，点击下方从待办中选择 📌</p></div>';
    return;
  }

  list.innerHTML = items.map(item => renderFocusTodoNode(item.todoId, 0, true)).join('');
}

function toggleFocusExpand(id, e) {
  e.stopPropagation();
  if (focusExpandedIds.has(id)) {
    focusExpandedIds.delete(id);
  } else {
    focusExpandedIds.add(id);
  }
  renderFocusList();
}

function toggleTodayFocusById(todoId) {
  const data = getTodayFocusItems();
  const idx = (data.items || []).findIndex(i => i.todoId === todoId);
  if (idx >= 0) {
    toggleTodayFocus(idx);
    return;
  }
  // Sub-task: directly toggle the todo
  const todo = findTodo(todoId);
  if (todo) {
    todo.done = !todo.done;
    saveData('study_todos_v2', todos);
    renderFocusList();
    renderTodos();
  }
}

function deleteTodayFocusById(todoId) {
  const data = getTodayFocusItems();
  const idx = (data.items || []).findIndex(i => i.todoId === todoId);
  if (idx < 0) return;
  deleteTodayFocus(idx);
}

// ── Todo Picker ──
function showTodoPicker() {
  const data = getTodayFocusItems();
  const maxCount = getMaxFocusCount();
  if ((data.items || []).length >= maxCount) return;
  const picker = document.getElementById('todayTodoPicker');
  if (picker) picker.style.display = 'block';
  pickerExpandedIds = new Set();
  renderTodoPickerList();
  const searchInput = document.getElementById('todoPickerSearch');
  if (searchInput) { searchInput.value = ''; setTimeout(() => searchInput.focus(), 100); }
}

function closeTodoPicker() {
  const picker = document.getElementById('todayTodoPicker');
  if (picker) picker.style.display = 'none';
  pickerExpandedIds = new Set();
}

function togglePickerExpand(id, e) {
  e.stopPropagation();
  if (pickerExpandedIds.has(id)) {
    pickerExpandedIds.delete(id);
  } else {
    pickerExpandedIds.add(id);
  }
  renderTodoPickerList();
}

// Render a todo item for the picker tree (recursive)
function renderPickerNode(t, depth) {
  const children = getChildren(t.id);
  const hasKids = children.length > 0;
  const isExpanded = pickerExpandedIds.has(t.id);
  const focusIds = getFocusTodoIds();
  const indent = depth * 16;
  const isSelected = focusIds.has(t.id);

  const renderedChildren = children.map(c => renderPickerNode(c, depth + 1)).join('');

  return `
    <div>
      <div class="todo-picker-item${isSelected ? ' selected' : ''}" onclick="togglePickTodo(${t.id})" style="padding-left:${14 + indent}px;">
        ${hasKids ? `<button class="picker-expand${isExpanded ? ' expanded' : ''}" onclick="togglePickerExpand(${t.id}, event)" title="展开/折叠">▶</button>` : '<span class="picker-expand-spacer"></span>'}
        <div class="picker-check"></div>
        <span class="picker-text${t.done ? ' done' : ''}">${escapeHtml(t.text)}</span>
        ${hasKids ? '<span class="picker-badge">' + children.length + '</span>' : ''}
        ${t.dueDate ? '<span class="picker-due">📅 ' + t.dueDate + '</span>' : ''}
      </div>
      ${(hasKids && renderedChildren) ? `<div class="picker-children${isExpanded ? '' : ' collapsed'}">${renderedChildren}</div>` : ''}
    </div>
  `;
}

function renderTodoPickerList() {
  const list = document.getElementById('todoPickerList');
  if (!list) return;
  const searchQuery = (document.getElementById('todoPickerSearch')?.value || '').toLowerCase();
  const focusIds = getFocusTodoIds();

  if (searchQuery) {
    // Search mode: flat list of all matching non-done todos
    const allAvailable = getAllAvailableTodos();
    const filtered = allAvailable.filter(t => t.text.toLowerCase().includes(searchQuery));

    if (filtered.length === 0) {
      list.innerHTML = '<div class="todo-picker-empty">没有匹配的待办事项</div>';
      return;
    }

    list.innerHTML = filtered.map(t => {
      const isSelected = focusIds.has(t.id);
      return `
        <div class="todo-picker-item${isSelected ? ' selected' : ''}" onclick="togglePickTodo(${t.id})">
          <span class="picker-expand-spacer"></span>
          <div class="picker-check"></div>
          <span class="picker-text${t.done ? ' done' : ''}">${escapeHtml(t.text)}</span>
          ${t.dueDate ? '<span class="picker-due">📅 ' + t.dueDate + '</span>' : ''}
        </div>
      `;
    }).join('');
  } else {
    // Tree mode: show roots with expand/collapse
    const roots = getAvailableTodos();
    if (roots.length === 0) {
      list.innerHTML = '<div class="todo-picker-empty">所有待办已完成或已添加</div>';
      return;
    }
    list.innerHTML = roots.map(t => renderPickerNode(t, 0)).join('');
  }
}

function togglePickTodo(todoId) {
  let data = getTodayFocusItems();
  if (!data.items) data.items = [];
  const idx = data.items.findIndex(i => i.todoId === todoId);
  if (idx >= 0) {
    data.items.splice(idx, 1);
  } else {
    const maxCount = getMaxFocusCount();
    if (data.items.length >= maxCount) return;
    const todo = todos.find(t => t.id === todoId);
    if (!todo) return;
    data.items.push({ todoId: todo.id, text: todo.text, done: false });
  }
  saveFocusData(data);
  renderTodoPickerList();
  renderFocusList();
}

function toggleTodayFocus(idx) {
  let data = getTodayFocusItems();
  if (!data.items || !data.items[idx]) return;
  const item = data.items[idx];
  const newDone = !item.done;
  item.done = newDone;
  // Sync back to todo: cascade to children when completing, leave children alone when unchecking
  const todo = todos.find(t => t.id === item.todoId);
  if (todo) {
    todo.done = newDone;
    if (newDone) {
      const descendantIds = getAllDescendantIds(item.todoId).filter(did => did !== item.todoId);
      for (const did of descendantIds) {
        const d = findTodo(did);
        if (d) d.done = true;
      }
    }
    saveData('study_todos_v2', todos);
  }
  saveFocusData(data);
  renderFocusList();
  renderTodos();
}

function deleteTodayFocus(idx) {
  let data = getTodayFocusItems();
  if (!data.items || !data.items[idx]) return;
  data.items.splice(idx, 1);
  saveFocusData(data);
  renderFocusList();
}

// ═══════════ Today: Review Card ═══════════
function renderReviewCard() {
  const card = document.getElementById('todayReviewCard');
  const list = document.getElementById('todayReviewList');
  if (!card || !list) return;

  // Always show the card
  card.style.display = '';

  const summary = getReviewSummary();
  const count = document.getElementById('todayReviewCount');
  if (count) count.textContent = summary.totalDue + ' 篇';

  if (summary.totalDue === 0) {
    // Show empty state with a brief explanation
    list.innerHTML = `<div class="review-empty">
      <i data-lucide="check-circle-2" class="lucide-icon" style="width:28px;height:28px;color:#10b981;display:block;margin:0 auto 6px;"></i>
      <span>暂无待复习的笔记</span>
      <span class="review-empty-hint">笔记创建或复习 1 天后会自动出现在这里</span>
    </div>`;
    if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
    return;
  }

  list.innerHTML = summary.dueNotes.map(n => {
    // Calculate review stage label
    const stageLabels = getReviewStageLabels();
    const stageIdx = Math.min(n.reviewCount, stageLabels.length - 1);
    const stageLabel = stageLabels[stageIdx];

    // Calculate how overdue (local date diff in whole days)
    const diffDays = daysBetweenDateStr(toLocalDateStr(n.nextReviewDate), getTodayStr());
    const overdueLabel = diffDays > 0 ? `（逾期 ${diffDays} 天）` : '';

    const preview = n.summary
      ? escapeHtml(n.summary.length > 80 ? n.summary.slice(0, 80) + '…' : n.summary)
      : '';

    return `
      <div class="review-item">
        <div class="review-item-header">
          <span class="review-item-title">${escapeHtml(n.title)}</span>
          <span class="review-item-stage">第 ${n.reviewCount + 1} 轮复习 · ${stageLabel}</span>
        </div>
        ${preview ? `<div class="review-item-preview">${preview}</div>` : ''}
        <div class="review-item-footer">
          <span class="review-item-overdue">${overdueLabel}</span>
          <div class="review-item-actions">
            <button class="review-btn review-btn-review" onclick="reviewOpenNote(${n.id})" title="打开笔记复习">
              <i data-lucide="eye" class="lucide-icon" style="width:14px;height:14px;"></i> 复习
            </button>
            <button class="review-btn review-btn-done" onclick="markNoteReviewed(${n.id})" title="标记为已复习">
              <i data-lucide="check" class="lucide-icon" style="width:14px;height:14px;"></i> 完成
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}

// ═══════════ Review Float Window ═══════════
let reviewFloatIndex = 0;       // which review note is currently active
let reviewFloatNotes = [];      // { id, title, reviewCount, nextReviewDate, summary }
let reviewFloatExpanded = new Set(); // which items are expanded (showing summary)

// Open review float with the full due list, highlighted at the given note
// Now: jumps to notes tab + selects the note so user can review content behind the float
function reviewOpenNote(noteId) {
  const summary = getReviewSummary();
  reviewFloatNotes = summary.dueNotes;
  reviewFloatIndex = summary.dueNotes.findIndex(n => n.id === noteId);
  if (reviewFloatIndex < 0) reviewFloatIndex = 0;
  // Switch to notes tab and select the note for background review
  if (typeof selectNote === 'function') selectNote(noteId);
  if (typeof switchTab === 'function') switchTab('notes');
  // Slight delay to let notes page render, then open float
  setTimeout(() => openReviewFloat(), 150);
}

function openReviewFloat() {
  const overlay = document.getElementById('reviewFloatOverlay');
  if (!overlay) return;
  overlay.style.display = 'block';
  renderReviewFloat();
  // Default: position float at bottom-right corner
  const f = document.getElementById('reviewFloat');
  if (f) {
    f.style.left = ''; f.style.top = '';
    f.style.right = '24px'; f.style.bottom = '24px';
  }
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}

function closeReviewFloat(e) {
  document.getElementById('reviewFloatOverlay').style.display = 'none';
}

function renderReviewFloat() {
  const list = document.getElementById('reviewFloatList');
  const counter = document.getElementById('reviewFloatCounter');
  if (!list) return;

  if (counter) {
    counter.textContent = reviewFloatNotes.length > 0
      ? (reviewFloatIndex + 1) + '/' + reviewFloatNotes.length
      : '0/0';
  }

  if (reviewFloatNotes.length === 0) {
    list.innerHTML = `<div class="review-empty">
      <i data-lucide="check-circle-2" class="lucide-icon" style="width:28px;height:28px;color:#10b981;display:block;margin:0 auto 6px;"></i>
      <span>暂无待复习的笔记</span>
    </div>`;
    return;
  }

  // Ensure active item is expanded
  if (!reviewFloatExpanded.has(reviewFloatIndex)) {
    reviewFloatExpanded.add(reviewFloatIndex);
  }

  const stageLabels = getReviewStageLabels();

  list.innerHTML = reviewFloatNotes.map((n, idx) => {
    const stageIdx = Math.min(n.reviewCount, stageLabels.length - 1);
    const stageLabel = stageLabels[stageIdx];
    const diffDays = daysBetweenDateStr(toLocalDateStr(n.nextReviewDate), getTodayStr());
    const overdueLabel = diffDays > 0 ? `逾期 ${diffDays} 天` : '';
    const preview = n.summary ? escapeHtml(n.summary) : '';
    const expanded = reviewFloatExpanded.has(idx);
    const activeClass = idx === reviewFloatIndex ? ' active' : '';

    return `
    <div class="rf-item${activeClass}" id="rfItem${idx}">
      <div class="rf-item-header" onclick="reviewFloatToggleExpand(${idx})">
        <span class="rf-item-title">${escapeHtml(n.title)}</span>
        <span class="rf-item-badges">
          ${overdueLabel ? `<span class="rf-item-overdue">${overdueLabel}</span>` : ''}
          <span class="rf-item-stage">第 ${n.reviewCount + 1} 轮 · ${stageLabel}</span>
          <span class="rf-item-expand-icon">${expanded ? '▾' : '▸'}</span>
        </span>
      </div>
      <div class="rf-item-body${expanded ? ' expanded' : ''}" id="rfBody${idx}">
        ${preview ? `<div class="rf-item-preview">${preview}</div>` : ''}
        <div class="rf-item-actions">
          <button class="rf-btn rf-btn-review" onclick="event.stopPropagation(); reviewFloatOpenCurrent()" title="打开笔记详情复习">
            <i data-lucide="external-link" class="lucide-icon" style="width:13px;height:13px;"></i> 打开笔记
          </button>
          <button class="rf-btn rf-btn-done" onclick="event.stopPropagation(); reviewFloatMarkDone(${idx})" title="标记复习完成">
            <i data-lucide="check" class="lucide-icon" style="width:13px;height:13px;"></i> 完成复习
          </button>
        </div>
      </div>
    </div>`;
  }).join('');

  // Navigation bar
  const navHtml = `
    <div class="rf-nav">
      <button class="rf-nav-btn" onclick="reviewFloatPrev()" ${reviewFloatIndex <= 0 ? 'disabled' : ''}>← 上一个</button>
      <span class="rf-nav-pos">${reviewFloatIndex + 1} / ${reviewFloatNotes.length}</span>
      <button class="rf-nav-btn" onclick="reviewFloatNext()" ${reviewFloatIndex >= reviewFloatNotes.length - 1 ? 'disabled' : ''}>下一个 →</button>
    </div>`;

  list.innerHTML += navHtml;

  // Scroll active item into view
  setTimeout(() => {
    const activeEl = document.getElementById('rfItem' + reviewFloatIndex);
    if (activeEl) activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 100);

  // Auto-size float height to fit content
  setTimeout(() => adjustReviewFloatHeight(), 80);

  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}

function adjustReviewFloatHeight() {
  const float = document.getElementById('reviewFloat');
  const header = document.getElementById('reviewFloatHeader');
  const list = document.getElementById('reviewFloatList');
  if (!float || !header || !list) return;
  // Measure actual content height from child elements
  const contentH = header.offsetHeight + list.scrollHeight;
  const maxH = window.innerHeight * 0.75;
  if (contentH > maxH) {
    float.style.height = maxH + 'px';
    float.style.overflowY = 'auto';
  } else {
    float.style.height = contentH + 'px';
    float.style.overflowY = 'hidden';
  }
  float.style.maxHeight = maxH + 'px';
}

function reviewFloatJumpTo(idx) {
  if (idx < 0 || idx >= reviewFloatNotes.length) return;
  reviewFloatIndex = idx;
  // Auto-expand newly navigated item
  reviewFloatExpanded.add(idx);
  renderReviewFloat();
}

function reviewFloatToggleExpand(idx) {
  if (reviewFloatExpanded.has(idx)) {
    reviewFloatExpanded.delete(idx);
  } else {
    reviewFloatExpanded.add(idx);
  }
  // Toggle CSS class without full re-render
  const body = document.getElementById('rfBody' + idx);
  const icon = document.querySelector('#rfItem' + idx + ' .rf-item-expand-icon');
  if (body) body.classList.toggle('expanded');
  if (icon) icon.textContent = reviewFloatExpanded.has(idx) ? '▾' : '▸';
  // Re-adjust float height after expand/collapse
  setTimeout(() => adjustReviewFloatHeight(), 50);
}

function reviewFloatPrev() {
  if (reviewFloatIndex > 0) {
    reviewFloatIndex--;
    reviewFloatExpanded.add(reviewFloatIndex);
    renderReviewFloat();
    reviewFloatSelectCurrent();
  }
}

function reviewFloatNext() {
  if (reviewFloatIndex < reviewFloatNotes.length - 1) {
    reviewFloatIndex++;
    reviewFloatExpanded.add(reviewFloatIndex);
    renderReviewFloat();
    reviewFloatSelectCurrent();
  }
}

function reviewFloatSelectCurrent() {
  const note = reviewFloatNotes[reviewFloatIndex];
  if (!note) return;
  // Select note + switch tab but keep float open
  selectNote(note.id);
  switchTab('notes');
  // Re-adjust height after tab switch may have triggered layout changes
  setTimeout(() => adjustReviewFloatHeight(), 150);
}

function reviewFloatOpenCurrent() {
  const note = reviewFloatNotes[reviewFloatIndex];
  if (!note) return;
  // Close float, switch to notes and select the note
  closeReviewFloat();
  selectNote(note.id);
  switchTab('notes');
}

function reviewFloatMarkDone(idx) {
  const note = reviewFloatNotes[idx];
  if (!note) return;
  markNoteReviewed(note.id);
  // Remove from local list
  reviewFloatNotes.splice(idx, 1);
  // Adjust index
  if (reviewFloatIndex >= reviewFloatNotes.length) {
    reviewFloatIndex = Math.max(0, reviewFloatNotes.length - 1);
  }
  if (reviewFloatNotes.length === 0) {
    closeReviewFloat();
    renderReviewCard();
    return;
  }
  renderReviewFloat();
  renderReviewCard();
}

// ═══════════ Today: Long-term Goals ═══════════
// Data stored in localStorage as: study_longterm_goals
// Each goal: { id, text, done, createdAt }
function loadGoals() {
  try { return JSON.parse(localStorage.getItem('study_longterm_goals') || '[]'); }
  catch { return []; }
}

function saveGoals(goals) {
  // 走 saveData → 触发 Sync.onLocalChange → 长期目标跨设备同步
  if (typeof saveData === 'function') {
    saveData('study_longterm_goals', goals);
  } else {
    localStorage.setItem('study_longterm_goals', JSON.stringify(goals));
  }
}

function addGoal() {
  const input = document.getElementById('todayGoalInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const goals = loadGoals();
  goals.push({ id: genId(), text, done: false, content: '', dueDate: null, createdAt: new Date().toISOString() });
  saveGoals(goals);
  input.value = '';
  document.getElementById('todayGoalsInputWrap').style.display = 'none';
  renderGoals();
}

function cancelAddGoal() {
  document.getElementById('todayGoalInput').value = '';
  document.getElementById('todayGoalsInputWrap').style.display = 'none';
}

function showAddGoalInput() {
  const wrap = document.getElementById('todayGoalsInputWrap');
  if (!wrap) return;
  wrap.style.display = '';
  setTimeout(() => document.getElementById('todayGoalInput').focus(), 100);
}

function toggleGoal(id) {
  const goals = loadGoals();
  const goal = goals.find(g => g.id === id);
  if (!goal) return;
  goal.done = !goal.done;
  saveGoals(goals);
  renderGoals();
}

function deleteGoal(id) {
  const goals = loadGoals().filter(g => g.id !== id);
  saveGoals(goals);
  renderGoals();
}

function openEditGoalModal(id) {
  const goal = loadGoals().find(g => g.id === id);
  if (!goal) return;
  editModalOpen = true;
  document.getElementById('editModalTitle').innerHTML = '<i data-lucide="flag" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> 编辑长期目标';
  document.getElementById('editModalBody').innerHTML = `
    <div class="modal-field">
      <label>目标名称</label>
      <input type="text" id="editGoalText" value="${escapeHtml(goal.text)}" onkeydown="if(event.key==='Enter')saveEditGoal(${id})">
    </div>
    <div class="modal-field">
      <label>截止日期</label>
      <input type="date" id="editGoalDue" value="${goal.dueDate || ''}">
    </div>
    <div class="modal-field">
      <label>正文 / 备注</label>
      <textarea id="editGoalContent" placeholder="补充说明、备注等..." onkeydown="if(event.ctrlKey&&event.key==='Enter')saveEditGoal(${id})">${escapeHtml(goal.content || '')}</textarea>
    </div>
    ${isDebugMode() ? `
    <div class="modal-field">
      <label>计时器总时间（调试模式）</label>
      <input type="text" id="editGoalTimerMs" value="${getGoalTimerMs(id)}" placeholder="毫秒数，如 3600000 表示 1 小时">
      <span class="hint">修改此目标的计时器总时间，单位毫秒。</span>
    </div>` : ''}
    <button class="btn-save-modal" onclick="saveEditGoal(${id})">💾 保存</button>
  `;
  document.getElementById('editModal').classList.add('open');
  setTimeout(() => document.getElementById('editGoalText').focus(), 300);
}

function saveEditGoal(id) {
  const goals = loadGoals();
  const goal = goals.find(g => g.id === id);
  if (!goal) return;
  const text = document.getElementById('editGoalText').value.trim();
  if (!text) return;
  goal.text = text;
  goal.dueDate = document.getElementById('editGoalDue').value || null;
  goal.content = document.getElementById('editGoalContent').value.trim();
  // Save timer ms in debug mode
  if (isDebugMode()) {
    const timerInput = document.getElementById('editGoalTimerMs');
    if (timerInput) {
      const val = timerInput.value.trim();
      if (val !== '' && !isNaN(val) && Number(val) >= 0) {
        goal._timerManualMs = Number(val);
      } else {
        delete goal._timerManualMs;
      }
    }
  }
  saveGoals(goals);
  closeEditModal();
  renderGoals();
}

function getGoalTimerMs(id) {
  const goals = loadGoals();
  const g = goals.find(gl => gl.id === id);
  if (g && g._timerManualMs !== undefined) return g._timerManualMs;
  let records;
  try { records = JSON.parse(localStorage.getItem('study_timer_records') || '[]'); }
  catch { records = []; }
  let totalMs = 0;
  for (const rec of records) {
    if (rec.affectsFocus === false) continue;
    if (rec.targetId === id && rec.targetType === 'goal') totalMs += rec.totalMs;
  }
  return totalMs;
}

function formatTimerDisplay(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  return `${m}min`;
}

function renderGoals() {
  const list = document.getElementById('todayGoalsList');
  if (!list) return;
  const goals = loadGoals();
  if (goals.length === 0) {
    list.innerHTML = '<div class="today-goals-empty">还没有长期目标，点击右上角 + 添加</div>';
    return;
  }
  list.innerHTML = goals.map(g => {
    const dueHtml = g.dueDate ? `<span class="today-goal-due" style="font-size:11px;color:${new Date(g.dueDate) < new Date(new Date().toDateString()) && !g.done ? 'var(--danger)' : 'var(--text-secondary)'};flex-shrink:0;">📅 ${g.dueDate}</span>` : '';
    let timerHtml = '';
    const timerMs = getGoalTimerMs(g.id);
    if (timerMs >= 10000) {
      timerHtml = `<span class="today-goal-timer" title="计时：共 ${formatTimerDisplay(timerMs)}">⏱️ ${formatTimerDisplay(timerMs)}</span>`;
    }
    return `
      <div class="today-goal-item${g.done ? ' done' : ''}">
        <div class="today-goal-check${g.done ? ' done' : ''}" onclick="toggleGoal(${g.id})" title="标记完成"></div>
        <div class="today-goal-body" onclick="openEditGoalModal(${g.id})" title="编辑">
          <span class="today-goal-text${g.done ? ' completed' : ''}">${escapeHtml(g.text)}</span>
          ${g.content ? `<div class="goal-content-preview" onclick="event.stopPropagation(); this.classList.toggle('expanded')" title="点击展开/收起">${escapeHtml(g.content)}</div>` : ''}
        </div>
        ${dueHtml}
        ${timerHtml}
        <span style="flex:1;min-width:0;"></span>
        <button class="todo-edit" onclick="event.stopPropagation();openEditGoalModal(${g.id})" ondblclick="event.stopPropagation()" title="编辑">✎</button>
        <button class="todo-delete" onclick="event.stopPropagation();deleteGoal(${g.id})" ondblclick="event.stopPropagation()" title="删除">✕</button>
      </div>
    `;
  }).join('');
}

function renderToday() {
  closeTodoPicker();
  renderCheckinCalendar();
  renderFocusList();
  renderReviewCard();
  renderGoals();
  updateDebugPanel();
}

// 通知功能 - 兼容 Electron 和浏览器环境
const isElectronEnv = !!(window.electronAPI && window.electronAPI.isElectron);

function requestNotificationPermission() {
  if (isElectronEnv) return; // Electron 不需要请求权限
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function sendNotification(title, body, tag) {
  if (isElectronEnv) {
    window.electronAPI.showNotification(title, body);
    return;
  }
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, tag: tag || 'study-table' });
    console.log('[Notify] Sent:', title);
  } catch (e) {
    console.log('[Notify] Failed:', e);
  }
}

function debugTestNotify() {
  if (isElectronEnv) {
    window.electronAPI.showNotification('测试通知', '如果你看到这条消息，说明通知功能正常！');
    return;
  }
  if (Notification.permission === 'granted') {
    new Notification('测试通知', { body: '如果你看到这条消息，说明通知功能正常！', tag: 'test' });
  } else {
    Notification.requestPermission().then(p => {
      if (p === 'granted') {
        new Notification('测试通知', { body: '通知功能正常！', tag: 'test' });
      }
    });
  }
}

// Auto-detect file:// protocol and show tip (skip in Electron)
(function() {
  if (isElectronEnv) return;
  if (location.protocol === 'file:') {
    console.warn('[Notify] ⚠️ file:// 协议不支持桌面通知。请使用 HTTP 服务器打开此页面。');
  }
})();

// ═══════════ Review Float Drag ═══════════
(function() {
  let dragState = null; // { el, startX, startY, origLeft, origTop, mouseDownOnHeader }
  let dragOccurred = false;

  function initDrag(e) {
    const float = document.getElementById('reviewFloat');
    const header = document.getElementById('reviewFloatHeader');
    if (!float || !header) return;

    // Only start drag from header
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

  // Delegate mousedown on overlay
  document.addEventListener('mousedown', function(e) {
    if (!document.getElementById('reviewFloatOverlay') || document.getElementById('reviewFloatOverlay').style.display === 'none') return;
    initDrag(e);
  });
})();
