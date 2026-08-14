// ═══════════ Todo Input Toggle ═══════════
function toggleTodoInput() {
  todoInputOpen = !todoInputOpen;
  const panel = document.getElementById('todoInputPanel');
  const btn = document.getElementById('btnTodoToggle');
  if (todoInputOpen) {
    panel.classList.add('open'); btn.classList.add('active');
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14"/></svg>收起';
    setTimeout(() => document.getElementById('todoInput').focus(), 350);
  } else {
    panel.classList.remove('open'); btn.classList.remove('active');
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>新增';
  }
}

// ═══════════ Link Input Toggle ═══════════
function toggleLinkInput() {
  linkInputOpen = !linkInputOpen;
  const panel = document.getElementById('linkInputPanel');
  const btn = document.getElementById('btnLinkToggle');
  if (linkInputOpen) {
    panel.classList.add('open'); btn.classList.add('active');
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14"/></svg>收起';
    setTimeout(() => document.getElementById('linkNameInput').focus(), 350);
    updateCatSuggestions();
  } else {
    panel.classList.remove('open'); btn.classList.remove('active');
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>新增';
  }
}

function onLinkTypeChange() {
  const type = document.getElementById('linkTypeSelect').value;
  const urlInput = document.getElementById('linkUrlInput');
  urlInput.placeholder = type === 'app'
    ? '应用链接（如 todoist:?? 或 https://mail.qq.com）...'
    : '网址 (URL)...';
}

// ═══════════ Todo Search ═══════════
function onTodoSearch() {
  todoSearchQuery = document.getElementById('todoSearch').value.trim().toLowerCase();
  const clearBtn = document.getElementById('searchClear');
  clearBtn.classList.toggle('visible', !!todoSearchQuery);
  renderTodos();
}

function clearSearch() {
  document.getElementById('todoSearch').value = '';
  todoSearchQuery = '';
  document.getElementById('searchClear').classList.remove('visible');
  renderTodos();
  document.getElementById('todoSearch').focus();
}

// Get ancestor path from root
function getAncestorPath(id, visited = new Set()) {
  const path = [];
  let t = findTodo(id);
  while (t && t.parentId !== null) {
    if (visited.has(t.id)) break; // circular reference guard
    visited.add(t.id);
    t = findTodo(t.parentId);
    if (t) path.unshift({ id: t.id, text: t.text });
  }
  return path;
}

// ═══════════ Todo: Tree helpers ═══════════
function getChildren(parentId) {
  return todos.filter(t => t.parentId === parentId);
}

function sortTodoChildren(parentId, mode) {
  const children = getChildren(parentId);
  if (children.length <= 1) return;
  // Build map of child-id → current index in todos array
  const idxMap = {};
  const sortedChildren = [...children];
  if (mode === 'alpha') {
    sortedChildren.sort((a, b) => a.text.localeCompare(b.text, 'zh-CN'));
  } else if (mode === 'time') {
    sortedChildren.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  } else if (mode === 'recent') {
    sortedChildren.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  // Rebuild child indices: remove all children, re-insert sorted at the position of first child
  const minIdx = Math.min(...children.map(c => todos.indexOf(c)));
  // Remove children from their current positions (work backwards to preserve indices)
  const toRemove = new Set(children.map(c => c.id));
  todos = todos.filter(t => !toRemove.has(t.id));
  // Insert sorted children at minIdx
  todos.splice(minIdx, 0, ...sortedChildren);
  saveData('study_todos_v2', todos);
  renderTodos();
}

function getAllDescendantIds(rootId, visited = new Set()) {
  if (visited.has(rootId)) return []; // circular reference guard
  visited.add(rootId);
  const ids = [rootId];
  for (const c of getChildren(rootId)) {
    ids.push(...getAllDescendantIds(c.id, visited));
  }
  return ids;
}

// Format Date to YYYY-MM-DD string
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── Completed todo log (survives todo deletion) ──
// Stores { id, text, completedAt, deletedAt } records for deleted todos
// so calendar can still show historical completion data.
function loadTodoCompletedLog() {
  try { return JSON.parse(localStorage.getItem('study_todo_completed_log') || '[]'); }
  catch { return []; }
}
function saveTodoCompletedLog(log) {
  // 走 saveData → 触发 Sync.onLocalChange → 待办完成日志跨设备同步
  if (typeof saveData === 'function') {
    saveData('study_todo_completed_log', log);
  } else {
    localStorage.setItem('study_todo_completed_log', JSON.stringify(log));
  }
}

function toggleTodoHideDone() {
  todoHideDone = !todoHideDone;
  const btn = document.getElementById('todoHideDoneBtn');
  if (btn) {
    const icon = btn.querySelector('[data-lucide]') || btn;
    icon.setAttribute('data-lucide', todoHideDone ? 'eye-off' : 'eye');
    if (typeof lucide !== 'undefined') lucide.createIcons();
    btn.title = todoHideDone ? '显示已完成待办' : '隐藏已完成待办';
  }
  renderTodos();
}

// ═══════════ Multi-select & Batch Operations ═══════════
function toggleTodoMultiSelect() {
  todoMultiSelectMode = !todoMultiSelectMode;
  if (!todoMultiSelectMode) todoSelectedIds.clear();
  renderTodos();
  updateBatchActionsBar();
}

function toggleTodoSelect(id) {
  if (todoSelectedIds.has(id)) todoSelectedIds.delete(id);
  else todoSelectedIds.add(id);
  renderTodos();
  updateBatchActionsBar();
}

function updateBatchActionsBar() {
  const batchDiv = document.getElementById('todoBatchActions');
  const selectBtn = document.getElementById('todoSelectBtn');
  if (!batchDiv || !selectBtn) return;
  if (todoMultiSelectMode) {
    selectBtn.style.display = 'none';
    batchDiv.style.display = 'flex';
  } else {
    selectBtn.style.display = '';
    batchDiv.style.display = 'none';
  }
}

function batchDeleteTodos() {
  if (todoSelectedIds.size === 0) return;
  showCustomConfirm(`确定要删除选中的 ${todoSelectedIds.size} 个待办及其所有子任务吗？<br><small>删除后可在回收站中恢复。</small>`).then(confirmed => {
    if (!confirmed) return;
    pushTodoUndo();
    const allToDelete = new Set();
    for (const id of todoSelectedIds) {
      const ids = getAllDescendantIds(id);
      ids.forEach(did => allToDelete.add(did));
    }
    const completedLog = loadTodoCompletedLog();
    for (const did of allToDelete) {
      const t = todos.find(t => t.id === did);
      if (t && t.completedAt) {
        completedLog.push({ id: t.id, text: t.text, completedAt: t.completedAt, deletedAt: formatDate(new Date()) });
      }
    }
    saveTodoCompletedLog(completedLog);
    // Soft delete: move each selected root to trash
    if (typeof moveToTrash === 'function') {
      for (const id of todoSelectedIds) {
        const todo = todos.find(t => t.id === id);
        if (todo) moveToTrash('todos', todo);
      }
    }
    todoSelectedIds.clear();
    todoMultiSelectMode = false;
    renderTodos();
    updateBatchActionsBar();
  });
}

function batchEditTodos() {
  if (todoSelectedIds.size === 0) return;
  const selectedTodos = [...todoSelectedIds].map(id => findTodo(id)).filter(Boolean);
  if (selectedTodos.length === 0) return;

  // Compute common values
  const commonText = selectedTodos.every(t => t.text === selectedTodos[0].text) ? selectedTodos[0].text : null;
  const commonDueDate = selectedTodos.every(t => t.dueDate === selectedTodos[0].dueDate) ? selectedTodos[0].dueDate : null;
  const commonCompletedAt = selectedTodos.every(t => t.completedAt === selectedTodos[0].completedAt) ? selectedTodos[0].completedAt : null;
  const commonTags = selectedTodos.every(t => JSON.stringify((t.tags || []).sort()) === JSON.stringify((selectedTodos[0].tags || []).sort())) ? (selectedTodos[0].tags || []).join(', ') : null;
  const commonContent = selectedTodos.every(t => t.content === selectedTodos[0].content) ? selectedTodos[0].content : null;

  editModalOpen = true;
  document.getElementById('editModalTitle').innerHTML = '<i data-lucide="pencil" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> 批量编辑（' + selectedTodos.length + ' 个待办）';
  document.getElementById('editModalBody').innerHTML = `
    <div class="modal-field">
      <label>名称</label>
      <input type="text" id="batchEditText" value="${commonText !== null ? escapeHtml(commonText) : ''}" placeholder="${commonText !== null ? '' : '多个待办名称不同，留空则不修改'}">
      <span class="hint">留空 = 不修改</span>
    </div>
    <div class="modal-field">
      <label>截止日期</label>
      <input type="date" id="batchEditDue" value="${commonDueDate || ''}" placeholder="留空则不修改">
      <span class="hint">留空 = 不修改，填写 = 统一设为该日期</span>
    </div>
    <div class="modal-field">
      <label>完成日期</label>
      <input type="date" id="batchEditCompletedAt" value="${commonCompletedAt || ''}" placeholder="${commonCompletedAt !== null ? '' : '多个待办完成日期不同，留空则不修改'}">
      <span class="hint">留空 = 不修改，填写 = 统一设为该日期并标记为已完成</span>
    </div>
    <div class="modal-field">
      <label>正文</label>
      <textarea id="batchEditContent" placeholder="${commonContent !== null ? '' : '多个待办正文不同，留空则不修改'}">${commonContent !== null ? escapeHtml(commonContent) : ''}</textarea>
      <span class="hint">留空 = 不修改</span>
    </div>
    <div class="modal-field">
      <label>标签（用逗号分隔）</label>
      <input type="text" id="batchEditTags" value="${commonTags !== null ? escapeHtml(commonTags) : ''}" placeholder="${commonTags !== null ? '' : '多个待办标签不同，留空则不修改'}">
      <span class="hint">留空 = 不修改，填写 = 统一设为该标签</span>
    </div>
    <button class="btn-save-modal" onclick="saveBatchEdit()">💾 保存</button>
  `;
  document.getElementById('editModal').classList.add('open');
}

function saveBatchEdit() {
  const textVal = document.getElementById('batchEditText').value.trim();
  const dueVal = document.getElementById('batchEditDue').value;
  const completedVal = document.getElementById('batchEditCompletedAt').value;
  const contentVal = document.getElementById('batchEditContent').value.trim();
  const tagsVal = document.getElementById('batchEditTags').value.trim();

  for (const id of todoSelectedIds) {
    const t = findTodo(id);
    if (!t) continue;
    if (textVal) t.text = textVal;
    if (dueVal) t.dueDate = dueVal;
    if (completedVal) { t.done = true; t.completedAt = completedVal; }
    if (contentVal) t.content = contentVal;
    if (tagsVal) t.tags = tagsVal.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  }
  saveData('study_todos_v2', todos);
  closeEditModal();
  todoSelectedIds.clear();
  todoMultiSelectMode = false;
  renderTodos();
  updateBatchActionsBar();
}

function getVisibleTodos() {
  let visible;
  if (currentTodoRoot === null) {
    visible = todos.filter(t => t.parentId === null);
  } else {
    visible = getChildren(currentTodoRoot);
  }
  if (todoHideDone) {
    visible = visible.filter(t => !t.done);
  }
  return visible;
}

function getVisibleDescendantIds() {
  if (currentTodoRoot === null) {
    let all = todos.map(t => t.id);
    if (todoHideDone) all = all.filter(id => !todos.find(t => t.id === id)?.done);
    return all;
  }
  const ids = [];
  for (const c of getChildren(currentTodoRoot)) {
    if (todoHideDone && c.done) continue;
    ids.push(...getAllDescendantIds(c.id));
  }
  return ids;
}

function findTodo(id) { return todos.find(t => t.id === id); }

function findAllMatchingTodos() {
  if (!todoSearchQuery) return [];
  return todos.filter(t => t.text.toLowerCase().includes(todoSearchQuery));
}

// ═══════════ Todo: Breadcrumb ═══════════
function buildBreadcrumb() {
  if (currentTodoRoot === null) return [];
  const chain = [];
  let id = currentTodoRoot;
  while (id !== null) {
    const t = findTodo(id);
    if (!t) break;
    chain.unshift(t);
    id = t.parentId;
  }
  return chain;
}

function renderBreadcrumb() {
  const bc = document.getElementById('todoBreadcrumb');
  const chain = buildBreadcrumb();
  if (chain.length === 0) {
    bc.style.display = 'none';
    bc.innerHTML = '';
    return;
  }
  bc.style.display = 'flex';
  bc.innerHTML = `
    <button class="breadcrumb-back" onclick="navigateUp()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      返回上级
    </button>
    <span class="breadcrumb-sep">|</span>
    <span class="breadcrumb-item" onclick="navigateToRoot(null)">全部</span>
    ${chain.map((t, i) => `
      <span class="breadcrumb-sep">›</span>
      <span class="breadcrumb-item${i === chain.length - 1 ? ' current' : ''}" onclick="${i < chain.length - 1 ? `navigateToRoot(${t.id})` : ''}">${escapeHtml(t.text.length > 12 ? t.text.slice(0,12)+'…' : t.text)}</span>
    `).join('')}
  `;
}

function navigateToRoot(id) {
  currentTodoRoot = id;
  activeSubInputId = null;
  renderTodos();
}

function navigateUp() {
  if (currentTodoRoot === null) return;
  const t = findTodo(currentTodoRoot);
  currentTodoRoot = t ? t.parentId : null;
  activeSubInputId = null;
  renderTodos();
}

// ═══════════ Todo: Root info collapse ═══════════
// 打开子目录时顶部显示根目录信息卡；用户可折叠/展开（状态存 localStorage）
function renderTodoRootInfo() {
  const rootInfo = document.getElementById('todoRootInfo');
  if (!rootInfo) return;
  if (currentTodoRoot === null) {
    rootInfo.style.display = 'none';
    rootInfo.innerHTML = '';
    return;
  }
  const rootTodo = findTodo(currentTodoRoot);
  if (!rootTodo) {
    rootInfo.style.display = 'none';
    rootInfo.innerHTML = '';
    return;
  }
  const collapsed = localStorage.getItem('study_todo_rootinfo_collapsed') === '1';
  const tagsHtml = (rootTodo.tags && rootTodo.tags.length > 0)
    ? `<div class="todo-root-tags">${rootTodo.tags.map(tag => `<span class="todo-tag">${escapeHtml(tag)}</span>`).join('')}</div>`
    : '';
  const chevron = collapsed
    ? '<path d="M6 9l6 6 6-6"/>'
    : '<path d="M6 15l6-6 6 6"/>';
  rootInfo.style.display = '';
  rootInfo.innerHTML = `
    <div class="todo-root-head">
      <div class="todo-root-title">📁 ${escapeHtml(rootTodo.text)}</div>
      <button class="todo-root-collapse" onclick="toggleTodoRootInfo()" title="${collapsed ? '展开根目录信息' : '折叠根目录信息'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${chevron}</svg>
      </button>
    </div>
    <div class="todo-root-info-body"${collapsed ? ' style="display:none;"' : ''}>
      <div class="todo-root-meta">
        ${rootTodo.dueDate ? `<span class="todo-root-due">📅 ${rootTodo.dueDate}</span>` : ''}
        <span class="todo-root-status" style="color:${rootTodo.done ? '#10b981' : '#f59e0b'};background:${rootTodo.done ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.1)'};">${rootTodo.done ? '✅ 已完成' : '⏳ 进行中'}</span>
      </div>
      ${rootTodo.content ? `<div class="todo-root-content">${escapeHtml(rootTodo.content)}</div>` : ''}
      ${tagsHtml}
    </div>
  `;
}
function toggleTodoRootInfo() {
  const collapsed = localStorage.getItem('study_todo_rootinfo_collapsed') === '1';
  localStorage.setItem('study_todo_rootinfo_collapsed', collapsed ? '0' : '1');
  // 只重渲染根目录信息区块，避免整个列表闪烁/滚动位置丢失
  renderTodoRootInfo();
}

function goToTodoDirectory(id) {
  const t = findTodo(id);
  if (!t) return;
  document.getElementById('todoSearch').value = '';
  todoSearchQuery = '';
  document.getElementById('searchClear').classList.remove('visible');
  currentTodoRoot = t.parentId;
  activeSubInputId = null;
  renderTodos();
}

// ═══════════ Todo: Operations ═══════════
function addTodo() {
  const input = document.getElementById('todoInput');
  const text = input.value.trim();
  if (!text) return;
  const parentId = currentTodoRoot;
  const dateInput = document.getElementById('todoDueDateInput');
  const dueDate = dateInput ? dateInput.value : null;
  pushTodoUndo();
  const newTodo = { id: genId(), text, done: false, parentId, dueDate, content: '', tags: [], createdAt: Date.now(), repeat: null };
  todos.push(newTodo);
  saveData('study_todos_v2', todos);
  input.value = '';
  input.focus();
  if (parentId !== null) { expandedTodoIds.add(parentId); saveExpandedTodoIds(); }
  renderTodos();
}

function toggleSubInput(parentId) {
  if (activeSubInputId === parentId) {
    activeSubInputId = null;
  } else {
    activeSubInputId = parentId;
    expandedTodoIds.add(parentId); saveExpandedTodoIds();
  }
  renderTodos();
  if (activeSubInputId !== null) {
    setTimeout(() => {
      const inp = document.getElementById('subInput-' + activeSubInputId);
      if (inp) inp.focus();
    }, 350);
  }
}

function confirmSubTodo(parentId) {
  const inp = document.getElementById('subInput-' + parentId);
  if (!inp) return;
  const text = inp.value.trim();
  if (!text) { activeSubInputId = null; renderTodos(); return; }
  pushTodoUndo();
  const newTodo = { id: genId(), text, done: false, parentId, content: '', tags: [], createdAt: Date.now(), repeat: null };
  todos.push(newTodo);
  saveData('study_todos_v2', todos);
  activeSubInputId = null;
  expandedTodoIds.add(parentId); saveExpandedTodoIds();
  renderTodos();
}

function cancelSubInput() {
  activeSubInputId = null;
  renderTodos();
}

// Only cascade on COMPLETING (done=true), NOT on unchecking
function toggleTodo(id) {
  const todo = findTodo(id);
  if (!todo) return;
  pushTodoUndo();
  const newDone = !todo.done;
  todo.done = newDone;
  // Record completion time (YYYY-MM-DD format)
  if (newDone) {
    todo.completedAt = formatDate(new Date());
    const descendantIds = getAllDescendantIds(id).filter(did => did !== id);
    for (const did of descendantIds) {
      const d = findTodo(did);
      if (d) {
        d.done = true;
        // Only set completedAt if the child wasn't already completed
        if (!d.completedAt) d.completedAt = formatDate(new Date());
      }
    }
  } else {
    // Clear completion time when unchecking
    delete todo.completedAt;
  }
  // When unchecking parent, children keep their current state
  saveData('study_todos_v2', todos);
  // 任务线联动：待办完成状态变化后自动结算任务线完成条件
  if (typeof tlOnTodosChanged === 'function') tlOnTodosChanged();
  renderTodos();
}

function toggleExpand(id) {
  if (expandedTodoIds.has(id)) {
    expandedTodoIds.delete(id);
  } else {
    expandedTodoIds.add(id);
  }
  saveExpandedTodoIds();
  renderTodos();
}

// ═══════════ Repeat Todo Refresh ═══════════
// Auto-reset completed repeating todos when their cycle has passed
function refreshRepeatTodos() {
  const today = formatDate(new Date());
  let changed = false;
  const completedLog = loadTodoCompletedLog();
  let logChanged = false;
  for (const t of todos) {
    if (!t.repeat || !t.done || !t.completedAt) continue;
    let shouldReset = false;
    if (t.repeat === 'daily') {
      shouldReset = t.completedAt !== today;
    } else if (t.repeat === 'weekly') {
      // Get Monday of current week
      const d = new Date();
      const dow = d.getDay() || 7; // Mon=1..Sun=7
      const monday = new Date(d);
      monday.setDate(d.getDate() - dow + 1);
      shouldReset = t.completedAt < formatDate(monday);
    } else if (t.repeat === 'monthly') {
      shouldReset = t.completedAt.substring(0, 7) !== today.substring(0, 7);
    }
    if (shouldReset) {
      // Save completion to log so calendar still shows it
      completedLog.push({ id: t.id, text: t.text, completedAt: t.completedAt, repeat: t.repeat });
      logChanged = true;
      t.done = false;
      delete t.completedAt;
      changed = true;
    }
  }
  if (logChanged) saveTodoCompletedLog(completedLog);
  if (changed) {
    saveData('study_todos_v2', todos);
    renderTodos();
  }
}

function onEditTodoRepeatChange() {
  // Placeholder — currently no dynamic UI needed on repeat change
}

function expandAllTodos() {
  // Recursively collect all todo IDs that have children
  function collectAllWithChildren(ids) {
    const result = [];
    for (const id of ids) {
      const children = getChildren(id);
      if (children.length > 0) {
        result.push(id);
        result.push(...collectAllWithChildren(children.map(c => c.id)));
      }
    }
    return result;
  }
  const allExpandable = collectAllWithChildren(todos.filter(t => t.parentId === null).map(t => t.id));
  for (const id of allExpandable) expandedTodoIds.add(id);
  saveExpandedTodoIds();
  renderTodos();
}

function collapseAllTodos() {
  expandedTodoIds.clear();
  saveExpandedTodoIds();
  renderTodos();
}

function deleteTodo(id) {
  const todo = todos.find(t => t.id === id);
  const name = todo ? todo.text.slice(0, 30) : '此任务';
  showCustomConfirm(`确定要删除「${escapeHtml(name)}」及其所有子任务吗？<br><small>删除后可在回收站中恢复。</small>`, { dontAskKey: 'study_dontask_delete_todo' }).then(confirmed => {
    if (!confirmed) return;
    pushTodoUndo();
    const descendantIds = getAllDescendantIds(id);
    const completedLog = loadTodoCompletedLog();
    for (const did of descendantIds) {
      const t = todos.find(t => t.id === did);
      if (t && t.completedAt) {
        completedLog.push({ id: t.id, text: t.text, completedAt: t.completedAt, deletedAt: formatDate(new Date()) });
      }
    }
    saveTodoCompletedLog(completedLog);
    // Soft delete: move to trash
    if (typeof moveToTrash === 'function') { moveToTrash('todos', todo); }
    expandedTodoIds.delete(id); saveExpandedTodoIds();
    if (activeSubInputId === id) activeSubInputId = null;
    renderTodos();
  });
}

function archiveTodo(id) {
  const todo = todos.find(t => t.id === id);
  if (!todo) return;
  const name = todo.text.slice(0, 30);
  showCustomConfirm(`确定要归档「${escapeHtml(name)}」吗？<br><small>归档后可从归档页面查看和恢复。</small>`).then(confirmed => {
    if (!confirmed) return;
    pushTodoUndo();
    if (typeof moveToArchive === 'function') { moveToArchive('todos', todo); }
    expandedTodoIds.delete(id); saveExpandedTodoIds();
    renderTodos();
  });
}

// ═══════════ Todo: Undo / Redo ═══════════
function pushTodoUndo() {
  todoUndoStack.push({ todos: JSON.parse(JSON.stringify(todos)), expanded: [...expandedTodoIds] });
  if (todoUndoStack.length > 50) todoUndoStack.shift();
  todoRedoStack = [];
  updateTodoUndoRedoButtons();
}
function updateTodoUndoRedoButtons() {
  const undoBtn = document.getElementById('todoUndoBtn');
  const redoBtn = document.getElementById('todoRedoBtn');
  if (undoBtn) undoBtn.disabled = todoUndoStack.length === 0;
  if (redoBtn) redoBtn.disabled = todoRedoStack.length === 0;
}
function undoTodo() {
  if (todoUndoStack.length === 0) return;
  const snap = todoUndoStack.pop();
  todoRedoStack.push({ todos: JSON.parse(JSON.stringify(todos)), expanded: [...expandedTodoIds] });
  todos = snap.todos;
  expandedTodoIds = new Set(snap.expanded);
  saveExpandedTodoIds();
  saveData('study_todos_v2', todos);
  renderTodos();
  updateTodoUndoRedoButtons();
}
function redoTodo() {
  if (todoRedoStack.length === 0) return;
  const snap = todoRedoStack.pop();
  todoUndoStack.push({ todos: JSON.parse(JSON.stringify(todos)), expanded: [...expandedTodoIds] });
  todos = snap.todos;
  expandedTodoIds = new Set(snap.expanded);
  saveExpandedTodoIds();
  saveData('study_todos_v2', todos);
  renderTodos();
  updateTodoUndoRedoButtons();
}

// ═══════════ Todo: Drag & Drop ═══════════
let _draggedTodoId = null;
let _dropTargetCtx = null; // { li: Element, zone: 'before'|'after'|'child' }
let _dragScrollRaf = null;

function clearCurrentDropIndicator() {
  if (_dropTargetCtx) {
    const { li, zone } = _dropTargetCtx;
    if (zone === 'child') {
      li.querySelector('.todo-item')?.classList.remove('drop-target');
    } else {
      li.querySelector('.todo-drop-indicator')?.remove();
    }
    _dropTargetCtx = null;
  }
}

function startDragAutoScroll(container, mouseY) {
  const threshold = 50; // px from top/bottom edge to trigger scroll
  const maxSpeed = 12;  // max scroll speed in px/frame
  const rect = container.getBoundingClientRect();
  const topDist = mouseY - rect.top;
  const bottomDist = rect.bottom - mouseY;

  let speed = 0;
  if (topDist < threshold && topDist > 0) {
    // Near top: scroll up, speed increases as cursor gets closer to edge
    speed = -maxSpeed * (1 - topDist / threshold);
  } else if (bottomDist < threshold && bottomDist > 0) {
    // Near bottom: scroll down
    speed = maxSpeed * (1 - bottomDist / threshold);
  }

  // Cancel existing scroll animation
  if (_dragScrollRaf) { cancelAnimationFrame(_dragScrollRaf); _dragScrollRaf = null; }

  if (speed === 0) return; // Not near edge, stop scrolling

  function step() {
    container.scrollTop += speed;
    _dragScrollRaf = requestAnimationFrame(step);
  }
  _dragScrollRaf = requestAnimationFrame(step);
}

function stopDragAutoScroll() {
  if (_dragScrollRaf) {
    cancelAnimationFrame(_dragScrollRaf);
    _dragScrollRaf = null;
  }
}

function showDropIndicator(li, zone) {
  if (_dropTargetCtx && _dropTargetCtx.li === li && _dropTargetCtx.zone === zone) return;
  clearCurrentDropIndicator();

  if (zone === 'child') {
    li.querySelector('.todo-item')?.classList.add('drop-target');
  } else {
    const indicator = document.createElement('div');
    indicator.className = 'todo-drop-indicator ' + zone;
    const item = li.querySelector('.todo-item');
    if (item) {
      if (zone === 'before') {
        item.before(indicator);
      } else {
        const childrenUl = li.querySelector(':scope > ul.todo-children');
        if (childrenUl) {
          li.insertBefore(indicator, childrenUl);
        } else {
          item.after(indicator);
        }
      }
    }
  }
  _dropTargetCtx = { li, zone };
}

function isDescendantOf(todoId, potentialChildId) {
  let current = findTodo(potentialChildId);
  while (current) {
    if (current.id === todoId) return true;
    current = current.parentId ? findTodo(current.parentId) : null;
  }
  return false;
}

function reorderTodo(draggedId, targetId, zone) {
  pushTodoUndo();
  const dragged = findTodo(draggedId);
  const target = findTodo(targetId);
  if (!dragged || !target) return;
  // Remove dragged first so target index is correct
  todos = todos.filter(t => t.id !== draggedId);
  const targetIdx = todos.findIndex(t => t.id === targetId);
  if (targetIdx === -1) { todos.push(dragged); return; }

  if (zone === 'child') {
    dragged.parentId = targetId;
    const firstChildIdx = todos.findIndex(t => t.parentId === targetId);
    if (firstChildIdx >= 0) todos.splice(firstChildIdx, 0, dragged);
    else todos.splice(targetIdx + 1, 0, dragged);
    expandedTodoIds.add(targetId); saveExpandedTodoIds();
  } else if (zone === 'before') {
    dragged.parentId = target.parentId;
    todos.splice(targetIdx, 0, dragged);
  } else { // after
    dragged.parentId = target.parentId;
    todos.splice(targetIdx + 1, 0, dragged);
  }
  saveData('study_todos_v2', todos);
}

// Delegated DnD listeners on document
document.addEventListener('dragstart', function(e) {
  const item = e.target.closest('.todo-item');
  if (!item) return;
  // Don't start drag from interactive elements (buttons, inputs, checkboxes)
  if (e.target.closest('button, input, textarea, .todo-check, .todo-expand')) return;
  const li = item.closest('li[data-id]');
  if (!li) return;
  const id = parseInt(li.dataset.id);
  if (isNaN(id)) return;
  _draggedTodoId = id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(id));
  requestAnimationFrame(() => item.classList.add('dragging'));
});

document.addEventListener('dragend', function() {
  stopDragAutoScroll();
  document.querySelectorAll('.todo-item.dragging').forEach(el => el.classList.remove('dragging'));
  clearCurrentDropIndicator();
  _draggedTodoId = null;
});

document.addEventListener('dragover', function(e) {
  // Always check auto-scroll while dragging, even over empty areas
  if (_draggedTodoId !== null) {
    const scrollContainer = e.target.closest('.card-scroll');
    if (scrollContainer) {
      startDragAutoScroll(scrollContainer, e.clientY);
    } else {
      stopDragAutoScroll();
    }
  }

  const li = e.target.closest('li[data-id]');
  if (!li || _draggedTodoId === null) return;
  const targetId = parseInt(li.dataset.id);
  if (targetId === _draggedTodoId || isNaN(targetId)) return;
  // Prevent dropping parent into its own descendant
  if (isDescendantOf(_draggedTodoId, targetId)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const item = li.querySelector('.todo-item');
  if (!item) return;
  const rect = item.getBoundingClientRect();
  const relY = e.clientY - rect.top;
  const h = rect.height;
  const zone = relY < h * 0.25 ? 'before' : relY > h * 0.75 ? 'after' : 'child';
  showDropIndicator(li, zone);
});

document.addEventListener('dragleave', function(e) {
  const li = e.target.closest('li[data-id]');
  if (!li || !_dropTargetCtx || _dropTargetCtx.li !== li) return;
  if (!li.contains(e.relatedTarget)) clearCurrentDropIndicator();
});

document.addEventListener('drop', function(e) {
  const li = e.target.closest('li[data-id]');
  if (!li || _draggedTodoId === null) return;
  const targetId = parseInt(li.dataset.id);
  if (targetId === _draggedTodoId || isDescendantOf(_draggedTodoId, targetId)) {
    clearCurrentDropIndicator(); _draggedTodoId = null; return;
  }
  e.preventDefault();
  const zone = _dropTargetCtx && _dropTargetCtx.li === li ? _dropTargetCtx.zone : 'after';
  reorderTodo(_draggedTodoId, targetId, zone);
  clearCurrentDropIndicator();
  _draggedTodoId = null;
  renderTodos();
});

// ═══════════ Todo: Tree Rendering ═══════════
function renderTodoNode(t, depth, visited = new Set(), timerRecords = null) {
  if (visited.has(t.id)) return ''; // circular reference guard
  visited.add(t.id);
  let children = getChildren(t.id);
  if (todoHideDone) children = children.filter(c => !c.done);
  const hasKids = children.length > 0;
  const isExpanded = expandedTodoIds.has(t.id);
  const isSubInputActive = activeSubInputId === t.id;
  const indent = depth * 20;

  let totalChildCount = 0;
  if (hasKids) {
    // 单次迭代统计所有后代数量，避免对每个子节点重复递归（O(n²)→O(n)）
    const stack = [...children];
    while (stack.length) {
      const cur = stack.pop();
      for (const child of getChildren(cur.id)) { totalChildCount++; stack.push(child); }
    }
  }

  const renderedChildren = children.map(c => renderTodoNode(c, depth + 1, visited, timerRecords)).join('');

  const tagsHtml = (t.tags && t.tags.length > 0)
    ? `<div class="todo-tags">${t.tags.map(tag => `<span class="todo-tag">${escapeHtml(tag)}</span>`).join('')}</div>`
    : '';

  const contentHtml = (t.content && t.content.trim())
    ? `<div class="todo-content-preview" onclick="event.stopPropagation(); this.classList.toggle('expanded')" title="点击展开/收起正文">${escapeHtml(t.content)}</div>`
    : '';

  return `
    <li data-id="${t.id}">
      <div class="todo-item" draggable="true" style="padding-left:${12 + indent}px;">
        <span class="todo-grip" title="拖拽排序">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>
        </span>
        <button class="todo-expand${hasKids ? (isExpanded ? ' expanded' : '') : ' hidden'}"
                onclick="event.stopPropagation(); toggleExpand(${t.id})"
                ondblclick="event.stopPropagation()"
                title="${hasKids ? '展开/折叠' : ''}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>
        </button>
        ${todoMultiSelectMode
          ? `<div class="todo-check todo-multi-check${todoSelectedIds.has(t.id) ? ' done' : ''}" onclick="event.stopPropagation(); toggleTodoSelect(${t.id})" ondblclick="event.stopPropagation()"></div>`
          : `<div class="todo-check${t.done ? ' done' : ''}" onclick="event.stopPropagation(); toggleTodo(${t.id})" ondblclick="event.stopPropagation()"></div>`}
        <span class="todo-text${t.done ? ' completed' : ''}" ondblclick="navigateToRoot(${t.id})">${escapeHtml(t.text)}</span>
        ${t.dueDate ? `<span class="todo-due-date" style="font-size:11px;color:${new Date(t.dueDate) < new Date(new Date().toDateString()) && !t.done ? 'var(--danger)' : 'var(--text-secondary)'};flex-shrink:0;">📅 ${t.dueDate}</span>` : ''}
        ${t.status ? `<span class="todo-status-pill" style="--pill-color:${statusBgColor(t.status)}">${escapeHtml(t.status)}</span>` : ''}
        ${t.estMinutes ? `<span class="todo-est-pill">⏳ ${t.estMinutes}分钟</span>` : ''}
        ${tagsHtml}
        ${t.repeat ? `<span class="todo-repeat-badge" title="${t.repeat === 'daily' ? '每天重复刷新' : t.repeat === 'weekly' ? '每周重复刷新' : t.repeat === 'monthly' ? '每月重复刷新' : ''}">🔄 ${t.repeat === 'daily' ? '每天' : t.repeat === 'weekly' ? '每周' : '每月'}</span>` : ''}
        ${renderTodoTimer(t.id)}
        ${hasKids ? `<span class="todo-badge">${totalChildCount}</span>` : ''}
        ${contentHtml}
      </div>
      <div class="sub-input-wrap${isSubInputActive ? ' open' : ''}" style="padding-left:${12 + indent}px;">
        <div class="sub-input-row">
          <input type="text" id="subInput-${t.id}" placeholder="输入子任务，回车添加..."
                 onkeydown="if(event.key==='Enter')confirmSubTodo(${t.id})">
          <button class="btn-sub-add" onclick="confirmSubTodo(${t.id})">添加</button>
          <button class="btn-sub-cancel" onclick="cancelSubInput()">取消</button>
        </div>
      </div>
      ${(hasKids && renderedChildren) ? `
        <ul class="todo-children${isExpanded ? '' : ' collapsed'}" style="max-height:${isExpanded ? 'none' : '0'};">
          ${renderedChildren}
        </ul>
      ` : ''}
    </li>
  `;
}

// ═══════════ Search Results Rendering ═══════════
function renderSearchResults() {
  const resultsContainer = document.getElementById('searchResults');
  const tree = document.getElementById('todoTree');
  const empty = document.getElementById('todoEmpty');
  const progress = document.getElementById('todoProgress');
  const hint = document.getElementById('searchHint');
  const bc = document.getElementById('todoBreadcrumb');

  tree.innerHTML = '';
  tree.style.display = 'none';
  bc.style.display = 'none';

  const matches = findAllMatchingTodos();
  if (matches.length === 0) {
    resultsContainer.style.display = 'none';
    empty.style.display = '';
    document.getElementById('todoEmptyText').textContent = '没有匹配的待办事项';
    progress.style.display = 'none';
    hint.classList.add('visible');
    hint.textContent = '';
    document.getElementById('todoSectionTitle').textContent = '🔍 无搜索结果';
    return;
  }

  document.getElementById('todoSectionTitle').textContent = `🔍 找到 ${matches.length} 个匹配项`;
  hint.classList.add('visible');
  hint.textContent = '';
  empty.style.display = 'none';
  progress.style.display = 'none';
  resultsContainer.style.display = 'flex';

  resultsContainer.innerHTML = matches.map(t => {
    const ancestors = getAncestorPath(t.id);
    const pathHtml = ancestors.length > 0
      ? ancestors.map((a, i) => {
          const sep = i > 0 ? '<span class="search-result-path-sep">›</span>' : '';
          return `${sep}<span>${escapeHtml(a.text.length > 15 ? a.text.slice(0,15)+'…' : a.text)}</span>`;
        }).join('')
      : '<span style="opacity:0.6;">顶层任务</span>';

    const tagsHtml = (t.tags && t.tags.length > 0)
      ? `<div class="todo-tags">${t.tags.map(tag => `<span class="todo-tag">${escapeHtml(tag)}</span>`).join('')}</div>`
      : '';

    return `
      <div class="search-result-card">
        <div class="search-result-row">
          ${todoMultiSelectMode
            ? `<div class="todo-check todo-multi-check${todoSelectedIds.has(t.id) ? ' done' : ''}" onclick="event.stopPropagation(); toggleTodoSelect(${t.id})" ondblclick="event.stopPropagation()"></div>`
            : `<div class="todo-check${t.done ? ' done' : ''}" onclick="event.stopPropagation(); toggleTodo(${t.id})" ondblclick="event.stopPropagation()"></div>`}
          <span class="todo-text${t.done ? ' completed' : ''}">${escapeHtml(t.text)}</span>
          ${tagsHtml}
          <button class="search-result-nav" onclick="goToTodoDirectory(${t.id})" title="跳转到该任务所在目录">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
            去目录
          </button>
        </div>
        <div class="search-result-path">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0; opacity:0.5;"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
          ${pathHtml}
        </div>
      </div>
    `;
  }).join('');
}

function renderTodos() {
  const tree = document.getElementById('todoTree');
  const resultsContainer = document.getElementById('searchResults');
  const empty = document.getElementById('todoEmpty');
  const progress = document.getElementById('todoProgress');
  const hint = document.getElementById('searchHint');

  if (todoSearchQuery) {
    renderBreadcrumb();
    renderSearchResults();
    return;
  }

  resultsContainer.style.display = 'none';
  tree.style.display = '';
  hint.classList.remove('visible');

  renderBreadcrumb();
  document.getElementById('todoSectionTitle').textContent = '待办事项';

  // Render root info when inside a directory（支持折叠，见 renderTodoRootInfo/toggleTodoRootInfo）
  renderTodoRootInfo();

  const visibleRoots = getVisibleTodos();
  // 整个渲染过程只解析一次计时记录，避免每个节点都重复 JSON.parse
  let timerRecords = null;
  try { timerRecords = JSON.parse(localStorage.getItem('study_timer_records') || '[]'); } catch { timerRecords = []; }
  tree.innerHTML = visibleRoots.map(t => renderTodoNode(t, 0, new Set(), timerRecords)).join('');

  const hasVisible = visibleRoots.length > 0;
  empty.style.display = hasVisible ? 'none' : '';
  document.getElementById('todoEmptyText').textContent = '暂无待办事项，点击「新增」添加吧 ✨';

  if (hasVisible) {
    // Progress always uses ALL todos in current scope (not affected by hide-done)
    const scopeIds = currentTodoRoot === null
      ? todos.map(t => t.id)
      : getAllDescendantIds(currentTodoRoot);
    const scopeTodos = todos.filter(t => scopeIds.includes(t.id));
    if (scopeTodos.length > 0) {
      progress.style.display = '';
      const doneCount = scopeTodos.filter(t => t.done).length;
      const pct = Math.round((doneCount / scopeTodos.length) * 100);
      document.getElementById('progressFill').style.width = pct + '%';
      document.getElementById('progressText').textContent =
        pct === 100 ? '🎉 全部完成！' : `${doneCount}/${scopeTodos.length} 已完成（${pct}%）`;
    } else {
      progress.style.display = 'none';
    }
  } else {
    progress.style.display = 'none';
  }
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}

// ═══════════ Status Options ═══════════
// 缓存状态配置，避免每个待办节点都重复 JSON.parse（保存时在 settings.js 中失效）
let _statusOptionsCache = null;
function loadStatusOptions() {
  if (_statusOptionsCache) return _statusOptionsCache;
  try {
    const raw = localStorage.getItem('study_todo_statuses');
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        // Migrate old string[] format
        if (data.length > 0 && typeof data[0] === 'string') {
          return _statusOptionsCache = data.map((name, i) => ({
            name,
            color: STATUS_COLORS[i % STATUS_COLORS.length]
          }));
        }
        // New {name, color}[] format
        return _statusOptionsCache = data.map((o, i) => ({
          name: o.name || o,
          color: o.color || STATUS_COLORS[i % STATUS_COLORS.length]
        }));
      }
    }
  } catch {}
  return _statusOptionsCache = ['还未开始', '刚开始', '进行中', '即将完成', '已完成'].map((name, i) => ({
    name,
    color: STATUS_COLORS[i % STATUS_COLORS.length]
  }));
}
function invalidateStatusOptionsCache() { _statusOptionsCache = null; }

// Simpler loader: names only
function loadStatusNames() {
  return loadStatusOptions().map(o => o.name);
}

// Map status to its stored color
const STATUS_COLORS = ['#6b7280','#3b82f6','#f59e0b','#10b981','#8b5cf6','#ef4444','#ec4899','#06b6d4','#84cc16','#f97316'];
function statusBgColor(status) {
  if (!status) return '#6b7280';
  const options = loadStatusOptions();
  const found = options.find(o => o.name === status);
  // 仅允许合法十六进制颜色，防止用户自定义状态色注入 CSS
  return (found && /^#[0-9a-fA-F]{3,8}$/.test(found.color || '')) ? found.color : '#6b7280';
}

function buildStatusOptions(current) {
  const options = loadStatusOptions();
  let html = '';
  for (const o of options) {
    const sel = o.name === current ? ' selected' : '';
    html += `<option value="${escapeAttr(o.name)}"${sel}>● ${escapeHtml(o.name)}</option>`;
  }
  if (current && !options.some(o => o.name === current)) {
    html += `<option value="${escapeAttr(current)}" selected>● ${escapeHtml(current)} (自定义)</option>`;
  }
  return html;
}

// Custom dropdown for status (theme-adaptive, works with glass/dark/light)
let _statusDropdownOpen = null;
function toggleStatusDropdown(selectEl) {
  const wrapper = selectEl.closest('.status-select-wrapper');
  if (!wrapper) return;
  const list = wrapper.querySelector('.status-dropdown-list');
  const trigger = wrapper.querySelector('.status-select-trigger');
  if (!list || !trigger) return;

  // Close any other open dropdown
  if (_statusDropdownOpen && _statusDropdownOpen !== list) {
    _statusDropdownOpen.style.display = 'none';
  }

  const isOpen = list.style.display === 'block';
  if (isOpen) {
    list.style.display = 'none';
    _statusDropdownOpen = null;
  } else {
    list.style.display = 'block';
    _statusDropdownOpen = list;
    // Scroll selected item into view
    const selItem = list.querySelector('.status-option.selected');
    if (selItem) selItem.scrollIntoView({ block: 'nearest' });
  }
}

function selectStatusOption(selectEl, value) {
  const wrapper = selectEl.closest('.status-select-wrapper');
  if (!wrapper) return;
  const trigger = wrapper.querySelector('.status-select-trigger');
  const list = wrapper.querySelector('.status-dropdown-list');
  const hiddenSelect = wrapper.querySelector('select');

  if (hiddenSelect) hiddenSelect.value = value;
  if (trigger) {
    const color = statusBgColor(value);
    trigger.innerHTML = value
      ? `<span class="status-dot" style="background:${color}"></span>${escapeHtml(value)}`
      : `<span class="status-dot"></span>无`;
  }
  if (list) {
    // 用遍历比较代替 querySelector 拼接，避免状态名含引号时选择器失效/注入
    list.querySelectorAll('.status-option').forEach(o => {
      o.classList.toggle('selected', o.getAttribute('data-value') === value);
    });
    list.style.display = 'none';
    _statusDropdownOpen = null;
  }
}

function buildStatusSelectHTML(current) {
  const options = loadStatusOptions();
  let optionItems = '';
  for (const o of options) {
    const cls = o.name === current ? ' selected' : '';
    const oNameJs = escapeJs(o.name);
    const oColor = /^#[0-9a-fA-F]{3,8}$/.test(o.color || '') ? o.color : '#6b7280';
    optionItems += `<div class="status-option${cls}" data-value="${escapeAttr(o.name)}" onclick="selectStatusOption(this.closest('.status-select-wrapper').querySelector('select'),'${oNameJs}')"><span class="status-dot" style="background:${oColor}"></span>${escapeHtml(o.name)}</div>`;
  }
  if (current && !options.some(o => o.name === current)) {
    const curJs = escapeJs(current);
    optionItems += `<div class="status-option selected" data-value="${escapeAttr(current)}" onclick="selectStatusOption(this.closest('.status-select-wrapper').querySelector('select'),'${curJs}')"><span class="status-dot" style="background:#6b7280"></span>${escapeHtml(current)} <span class="status-custom-tag">自定义</span></div>`;
  }

  const curColor = current ? statusBgColor(current) : '#6b7280';
  const triggerHtml = current
    ? `<span class="status-dot" style="background:${curColor}"></span>${escapeHtml(current)}`
    : `<span class="status-dot"></span>无`;

  return `
    <div class="status-select-wrapper" onclick="event.stopPropagation()">
      <select id="editTodoStatus" style="display:none">
        <option value=""${!current ? ' selected' : ''}>无</option>
        ${buildStatusOptions(current)}
      </select>
      <div class="status-select-trigger" onclick="toggleStatusDropdown(this.nextElementSibling.nextElementSibling?.querySelector?.('select')||this.parentElement.querySelector('select'))">
        ${triggerHtml}
        <i data-lucide="chevron-down" class="lucide-icon" style="width:14px;height:14px;margin-left:auto"></i>
      </div>
      <div class="status-dropdown-list" style="display:none">
        <div class="status-option${!current ? ' selected' : ''}" data-value="" onclick="selectStatusOption(this.closest('.status-select-wrapper').querySelector('select'),'')"><span class="status-dot"></span>无</div>
        ${optionItems}
      </div>
    </div>`;
}

// ═══════════ Edit Modal ═══════════
let editModalOpen = false;

function openEditTodoModal(id) {
  const t = findTodo(id);
  if (!t) return;
  editModalOpen = true;
  document.getElementById('editModalTitle').innerHTML = '<i data-lucide="pencil" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> 编辑待办';
  document.getElementById('editModalBody').innerHTML = `
    <div class="modal-field">
      <label>名称</label>
      <input type="text" id="editTodoText" value="${escapeHtml(t.text)}" onkeydown="if(event.key==='Enter')saveEditTodo(${t.id})">
    </div>
    <div class="modal-field">
      <label>截止日期</label>
      <input type="date" id="editTodoDue" value="${t.dueDate || ''}">
    </div>
    <div class="modal-field">
      <label>重复刷新</label>
      <select id="editTodoRepeat" onchange="onEditTodoRepeatChange()">
        <option value=""${!t.repeat ? ' selected' : ''}>不重复</option>
        <option value="daily"${t.repeat === 'daily' ? ' selected' : ''}>每天</option>
        <option value="weekly"${t.repeat === 'weekly' ? ' selected' : ''}>每周</option>
        <option value="monthly"${t.repeat === 'monthly' ? ' selected' : ''}>每月</option>
      </select>
    </div>
    <div class="modal-field">
      <label>正文</label>
      <textarea id="editTodoContent" placeholder="补充说明、备注等..." onkeydown="if(event.ctrlKey&&event.key==='Enter')saveEditTodo(${t.id})">${escapeHtml(t.content || '')}</textarea>
    </div>
    <div class="modal-row">
      <div class="modal-field modal-field-half">
        <label>状态</label>
        ${buildStatusSelectHTML(t.status)}
        <span class="hint">任务进度，可在设置中自定义</span>
      </div>
      <div class="modal-field modal-field-half">
        <label>预计时长（分钟）</label>
        <input type="number" id="editTodoEstMinutes" value="${t.estMinutes || ''}" placeholder="如 30" min="1">
        <span class="hint">预估所需时间</span>
      </div>
    </div>
    ${isDebugMode() ? `
    <div class="modal-field">
      <label>完成日期（调试模式）</label>
      <input type="date" id="editTodoCompletedAt" value="${t.completedAt || ''}">
      <span class="hint">修改此任务的完成日期，留空表示未完成</span>
    </div>
    <div class="modal-field">
      <label>计时器总时间（调试模式）</label>
      <input type="text" id="editTodoTimerMs" value="${getTodoTimerMs(t.id)}" placeholder="毫秒数，如 3600000 表示 1 小时">
      <span class="hint">手动修改此任务的计时器时间（毫秒）。保存后只修改显示值，不影响原有的计时记录。</span>
    </div>` : ''}
    <div class="modal-field">
      <label>标签（用逗号分隔）</label>
      <input type="text" id="editTodoTags" value="${(t.tags || []).join(', ')}" placeholder="如: 重要, 学习, 项目A">
      <span class="hint">多个标签用逗号分隔</span>
    </div>
    <button class="btn-save-modal" onclick="saveEditTodo(${t.id})">💾 保存</button>
  `;
  document.getElementById('editModal').classList.add('open');
  setTimeout(() => document.getElementById('editTodoText').focus(), 300);
}

function saveEditTodo(id) {
  const t = findTodo(id);
  if (!t) return;
  const text = document.getElementById('editTodoText').value.trim();
  if (!text) return;
  t.text = text;
  t.dueDate = document.getElementById('editTodoDue').value || null;
  const repeatEl = document.getElementById('editTodoRepeat');
  t.repeat = repeatEl ? (repeatEl.value || null) : null;
  t.content = document.getElementById('editTodoContent').value.trim();
  // Save completedAt in debug mode
  if (isDebugMode()) {
    const completedInput = document.getElementById('editTodoCompletedAt');
    if (completedInput) {
      const val = completedInput.value;
      if (val) {
        t.done = true;
        t.completedAt = val;
      } else {
        t.done = false;
        delete t.completedAt;
      }
    }
    // Save timer total in debug mode — stores as todo override, never touches timer records
    const timerInput = document.getElementById('editTodoTimerMs');
    if (timerInput) {
      const val = timerInput.value.trim();
      if (val !== '' && !isNaN(val) && Number(val) >= 0) {
        t._timerManualMs = Number(val);
      } else {
        delete t._timerManualMs;
      }
    }
  }
  const tagsStr = document.getElementById('editTodoTags').value.trim();
  t.tags = tagsStr ? tagsStr.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [];
  // Status
  const statusEl = document.getElementById('editTodoStatus');
  if (statusEl) { t.status = statusEl.value || null; }
  // Estimated time
  const estEl = document.getElementById('editTodoEstMinutes');
  if (estEl) { const v = parseInt(estEl.value, 10); t.estMinutes = (v > 0) ? v : null; }
  saveData('study_todos_v2', todos);
  closeEditModal();
  renderTodos();
}

function openEditLinkModal(id) {
  const l = links.find(link => link.id === id);
  if (!l) return;
  editModalOpen = true;
  document.getElementById('editModalTitle').innerHTML = '<i data-lucide="pencil" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> 编辑快捷访问';
  document.getElementById('editModalBody').innerHTML = `
    <div class="modal-field">
      <label>类型</label>
      <select id="editLinkType">
        <option value="link" ${l.type === 'link' ? 'selected' : ''}>🌐 网页链接</option>
        <option value="app" ${l.type === 'app' ? 'selected' : ''}>📱 应用</option>
      </select>
    </div>
    <div class="modal-field">
      <label>名称</label>
      <input type="text" id="editLinkName" value="${escapeHtml(l.name)}" onkeydown="if(event.key==='Enter')saveEditLink(${l.id})">
    </div>
    <div class="modal-field">
      <label>链接 / 地址</label>
      <input type="text" id="editLinkUrl" value="${escapeHtml(l.url || '')}">
    </div>
    <div class="modal-field">
      <label>分类</label>
      <input type="text" id="editLinkCat" value="${escapeHtml(l.category || '')}" placeholder="如：学习 / 工具 / 娱乐">
    </div>
    <button class="btn-save-modal" onclick="saveEditLink(${l.id})">💾 保存</button>
  `;
  document.getElementById('editModal').classList.add('open');
  setTimeout(() => document.getElementById('editLinkName').focus(), 300);
}

function saveEditLink(id) {
  const l = links.find(link => link.id === id);
  if (!l) return;
  const name = document.getElementById('editLinkName').value.trim();
  if (!name) return;
  l.type = document.getElementById('editLinkType').value;
  l.name = name;
  l.url = document.getElementById('editLinkUrl').value.trim();
  l.category = document.getElementById('editLinkCat').value.trim() || '默认分类';
  saveData('study_links_v3', links);
  closeEditModal();
  renderLinks();
}

function closeEditModal(e) {
  if (e && e.target !== document.getElementById('editModal')) return;
  editModalOpen = false;
  document.getElementById('editModal').classList.remove('open');
}

// ═══════════ Timer display in todo list ═══════════
// Shows total time spent on this todo and all its descendants
function renderTodoTimer(todoId, records) {
  if (!records) {
    try { records = JSON.parse(localStorage.getItem('study_timer_records') || '[]'); }
    catch { records = []; }
  }
  const allIds = getAllDescendantIds(todoId);
  let totalMs = 0;
  // Collect manual overrides for descendants
  const manualOverrides = {};
  for (const tid of allIds) {
    const t = findTodo(tid);
    if (t && t._timerManualMs !== undefined) manualOverrides[tid] = t._timerManualMs;
  }
  // Sum timer records (skip records for todos that have manual overrides)
  for (const rec of records) {
    if (rec.affectsFocus === false) continue;
    const rid = rec.targetId || rec.todoId;
    if (rid && allIds.includes(rid) && !(rid in manualOverrides)) {
      totalMs += rec.totalMs;
    }
  }
  // Add manual override values
  for (const ms of Object.values(manualOverrides)) totalMs += ms;
  if (totalMs < 10000) return ''; // Hide if less than 10 seconds
  const display = formatTimerDisplay(totalMs);
  return `<span class="todo-timer-badge" title="计时：该待办及子任务共 ${display}">⏱️ ${display}</span>`;
}

// Get timer ms for this todo only (not including descendants), used by debug edit modal
function getTodoTimerMs(todoId) {
  // Manual override takes priority — doesn't touch timer records
  const t = findTodo(todoId);
  if (t && t._timerManualMs !== undefined) return t._timerManualMs;
  let records;
  try { records = JSON.parse(localStorage.getItem('study_timer_records') || '[]'); }
  catch { records = []; }
  let totalMs = 0;
  for (const rec of records) {
    if (rec.affectsFocus === false) continue;
    const rid = rec.targetId || rec.todoId;
    if (rid === todoId) totalMs += rec.totalMs;
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

// ═══════════ Todo: Context Menu ═══════════
var todoCtxTargetId = null;

function showTodoContextMenu(x, y, id) {
  var menu = document.getElementById('todoContextMenu');
  if (!menu) return;
  todoCtxTargetId = id;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  var t = findTodo(id);
  var hasKids = t ? getChildren(t.id).length > 0 : false;
  var sortItems = document.getElementById('todoCtxSortItems');
  if (sortItems) sortItems.style.display = hasKids ? '' : 'none';
  menu.classList.add('visible');
  // Keep menu inside viewport
  var rect = menu.getBoundingClientRect();
  var vw = window.innerWidth;
  var vh = window.innerHeight;
  if (rect.right > vw) menu.style.left = Math.max(0, vw - rect.width - 6) + 'px';
  if (rect.bottom > vh) menu.style.top = Math.max(0, vh - rect.height - 6) + 'px';
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}

function closeTodoContextMenu() {
  var menu = document.getElementById('todoContextMenu');
  if (menu) menu.classList.remove('visible');
  todoCtxTargetId = null;
}

document.addEventListener('click', function(e) {
  if (!e.target.closest('#todoContextMenu')) closeTodoContextMenu();
});

var todoTreeForMenu = document.getElementById('todoTree');
if (todoTreeForMenu) {
  todoTreeForMenu.addEventListener('contextmenu', function(e) {
    var li = e.target.closest('[data-id]');
    if (!li) return;
    var id = parseInt(li.dataset.id);
    if (isNaN(id)) return;
    e.preventDefault();
    showTodoContextMenu(e.clientX, e.clientY, id);
  });
}

var searchResultsForMenu = document.getElementById('searchResults');
if (searchResultsForMenu) {
  searchResultsForMenu.addEventListener('contextmenu', function(e) {
    var card = e.target.closest('.search-result-card');
    if (!card) return;
    var el = card.querySelector('.todo-check, [onclick*="toggleTodo"]');
    if (!el) return;
    // Extract id from onclick
    var m = el.getAttribute('onclick');
    if (!m) return;
    var idm = m.match(/\((\d+)\)/);
    if (!idm) return;
    var id = parseInt(idm[1]);
    if (isNaN(id)) return;
    e.preventDefault();
    showTodoContextMenu(e.clientX, e.clientY, id);
  });
}

// Context menu actions
function todoCtxEdit() {
  var id = todoCtxTargetId;
  closeTodoContextMenu();
  if (id != null) openEditTodoModal(id);
}

function todoCtxAddSub() {
  var id = todoCtxTargetId;
  closeTodoContextMenu();
  if (id != null) toggleSubInput(id);
}

// 右键：将待办添加至今日聚焦（与 AI set_focus_task 共用同一数据逻辑）
function todoCtxAddFocus() {
  var id = todoCtxTargetId;
  closeTodoContextMenu();
  if (id == null) return;
  var todo = findTodo(id);
  if (!todo) return;
  var todayStr = typeof getTodayStr === 'function' ? getTodayStr() : new Date().toISOString().slice(0, 10);
  var data = loadFocusData();
  if (!data._date || data._date !== todayStr) {
    data._date = todayStr;
    data.items = [];
  }
  if (!data.items) data.items = [];
  var maxFocus = typeof getMaxFocusCount === 'function' ? getMaxFocusCount() : 3;
  if (data.items.length >= maxFocus) {
    if (typeof sendNotification === 'function') sendNotification('添加至聚焦失败', `今日聚焦最多 ${maxFocus} 个任务，请先在「今天」页面移除一些再添加`);
    return;
  }
  if (data.items.some(function (i) { return i.todoId === id; })) {
    if (typeof sendNotification === 'function') sendNotification('添加至聚焦失败', '该待办已是今日聚焦任务');
    return;
  }
  data.items.push({ todoId: todo.id, text: todo.text, done: todo.done });
  saveFocusData(data);
  if (typeof sendNotification === 'function') sendNotification('已添加至今日聚焦', `「${todo.text}」（${data.items.length}/${maxFocus}）`);
  // 刷新今日视图（聚焦列表）与待办列表
  if (typeof renderToday === 'function') renderToday();
  if (typeof renderTodos === 'function') renderTodos();
}

function todoCtxSort(mode) {
  var id = todoCtxTargetId;
  closeTodoContextMenu();
  if (id != null) { sortTodoChildren(id, mode); renderTodos(); }
}

function todoCtxArchive() {
  var id = todoCtxTargetId;
  closeTodoContextMenu();
  if (id != null) archiveTodo(id);
}

function todoCtxDelete() {
  var id = todoCtxTargetId;
  closeTodoContextMenu();
  if (id != null) deleteTodo(id);
}

// Close status dropdown on outside click
document.addEventListener('click', function(e) {
  if (_statusDropdownOpen && !e.target.closest('.status-select-wrapper')) {
    _statusDropdownOpen.style.display = 'none';
    _statusDropdownOpen = null;
  }
});
