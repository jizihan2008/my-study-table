// 待办队列只保存待办 ID；标题与完成状态始终读取原待办。
let todoQueueDraggedId = null;
let queueNoteEditingId = null;
let queuePickerExpandedIds = new Set();

function showQueueTodoPicker() {
  const picker = document.getElementById('queueTodoPicker');
  picker.style.display = 'block';
  document.getElementById('queueTodoPickerSearch').value = '';
  queuePickerExpandedIds = new Set();
  renderQueueTodoPicker();
  document.getElementById('queueTodoPickerSearch').focus();
}

function closeQueueTodoPicker() {
  const picker = document.getElementById('queueTodoPicker');
  if (picker) picker.style.display = 'none';
}

function toggleQueuePickerExpand(id, event) {
  event.stopPropagation();
  if (queuePickerExpandedIds.has(id)) queuePickerExpandedIds.delete(id);
  else queuePickerExpandedIds.add(id);
  renderQueueTodoPicker();
}

function toggleQueuePickTodo(id) {
  if (loadTodoQueue().includes(id)) removeTodoFromQueue(id);
  else addTodoToQueue(id);
}

function renderQueueTodoPicker() {
  const list = document.getElementById('queueTodoPickerList');
  if (!list) return;
  const query = (document.getElementById('queueTodoPickerSearch').value || '').trim().toLowerCase();
  const selected = new Set(loadTodoQueue());
  const renderNode = (todo, depth, ancestors = new Set()) => {
    if (ancestors.has(todo.id)) return '';
    const visited = new Set(ancestors).add(todo.id);
    const children = query ? [] : getChildren(todo.id);
    const expanded = queuePickerExpandedIds.has(todo.id);
    return `<div><div class="todo-picker-item${selected.has(todo.id) ? ' selected' : ''}" onclick="toggleQueuePickTodo(${todo.id})" style="padding-left:${14 + depth * 16}px;">
      ${children.length ? `<button class="picker-expand${expanded ? ' expanded' : ''}" onclick="toggleQueuePickerExpand(${todo.id}, event)" title="展开/折叠">▶</button>` : '<span class="picker-expand-spacer"></span>'}
      <div class="picker-check"></div><span class="picker-text${todo.done ? ' done' : ''}">${escapeHtml(todo.text)}</span>
      ${children.length ? `<span class="picker-badge">${children.length}</span>` : ''}
      ${todo.dueDate ? `<span class="picker-due">📅 ${escapeHtml(todo.dueDate)}</span>` : ''}
      </div>${children.length && expanded ? `<div class="picker-children">${children.map(child => renderNode(child, depth + 1, visited)).join('')}</div>` : ''}</div>`;
  };
  const items = query ? getAllAvailableTodos().filter(todo => todo.text.toLowerCase().includes(query)) : getAvailableTodos();
  list.innerHTML = items.length ? items.map(todo => renderNode(todo, 0)).join('') : '<div class="todo-picker-empty">没有匹配的待办事项</div>';
}

function loadTodoQueue() {
  try {
    const ids = JSON.parse(localStorage.getItem('study_todo_queue') || '[]');
    return Array.isArray(ids) ? [...new Set(ids)].filter(id => findTodo(id)) : [];
  } catch { return []; }
}

function saveTodoQueue(ids) {
  if (typeof saveData === 'function') return saveData('study_todo_queue', ids) === true;
  try {
    localStorage.setItem('study_todo_queue', JSON.stringify(ids));
    return true;
  } catch { return false; }
}

function buildAiTodoQueueSnapshot() {
  const ids = loadTodoQueue();
  if (!ids.length) return '📋 待办队列：暂无待办\n';
  const lines = ids.map((id, index) => {
    const todo = findTodo(id);
    const path = getFocusTodoDisplayPath(todo).full;
    const note = typeof getTodoSharedNote === 'function' ? getTodoSharedNote(id) : '';
    return `  ${index + 1}. [ID:${id}] ${todo.done ? '已完成' : '未完成'} ${path}`
      + (todo.dueDate ? `（截止 ${todo.dueDate}）` : '')
      + (note ? `｜共享备注：${note}` : '');
  });
  return `📋 待办队列（共 ${ids.length} 项，按用户当前排序；这是候选待办，不代表已经加入今日或明日聚焦）：\n${lines.join('\n')}\n`;
}

function addTodoToQueue(id) {
  if (!findTodo(id)) return;
  const ids = loadTodoQueue();
  if (ids.includes(id)) { showMiniToast('该待办已在队列中'); return; }
  ids.push(id);
  if (!saveTodoQueue(ids)) { showMiniToast('队列保存失败', 'error'); return; }
  renderTodoQueue();
  showMiniToast('已加入待办队列');
}

function todoCtxAddQueue() {
  const id = todoCtxTargetId;
  closeTodoContextMenu();
  if (id != null) addTodoToQueue(id);
}

function removeTodoFromQueue(id) {
  if (!saveTodoQueue(loadTodoQueue().filter(item => item !== id))) {
    showMiniToast('队列保存失败', 'error'); return;
  }
  renderTodoQueue();
}

function toggleTodoQueue() {
  const expanded = localStorage.getItem('study_todo_queue_expanded') === 'true';
  localStorage.setItem('study_todo_queue_expanded', String(!expanded));
  renderTodoQueue();
}

function setTodoQueueHideDone(hidden) {
  try {
    localStorage.setItem('study_todo_queue_hide_done', String(hidden));
  } catch {
    showMiniToast('队列显示设置保存失败', 'error');
  }
  renderTodoQueue();
}

function reorderTodoQueue(id, targetId, after) {
  const ids = loadTodoQueue();
  if (id === targetId || !ids.includes(id) || !ids.includes(targetId)) return false;
  ids.splice(ids.indexOf(id), 1);
  ids.splice(ids.indexOf(targetId) + (after ? 1 : 0), 0, id);
  return saveTodoQueue(ids);
}

function startTodoQueueDrag(event, id) {
  todoQueueDraggedId = id;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(id));
  event.currentTarget.classList.add('dragging');
}

function overTodoQueue(event) {
  if (todoQueueDraggedId == null) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const row = event.currentTarget;
  const after = event.clientY >= row.getBoundingClientRect().top + row.offsetHeight / 2;
  row.classList.toggle('drop-before', !after);
  row.classList.toggle('drop-after', after);
}

function dropTodoQueue(event, targetId) {
  if (todoQueueDraggedId == null) return;
  event.preventDefault();
  if (todoQueueDraggedId === targetId) { endTodoQueueDrag(); return; }
  const row = event.currentTarget;
  const after = event.clientY >= row.getBoundingClientRect().top + row.offsetHeight / 2;
  if (!reorderTodoQueue(todoQueueDraggedId, targetId, after)) showMiniToast('队列排序未保存', 'error');
  endTodoQueueDrag();
}

function endTodoQueueDrag() {
  todoQueueDraggedId = null;
  renderTodoQueue();
}

// 单项或按队列顺序填入指定日期；跳过已完成与已有聚焦，保留队列。
function addQueueToFocus(offset, id) {
  const date = getFocusDateByOffset(offset);
  const label = offset === 1 ? '明日' : '今日';
  const data = getFocusItemsForDate(date);
  const ids = id == null ? loadTodoQueue() : [id];
  const limit = getMaxFocusCount();
  let added = 0;
  for (const todoId of ids) {
    const todo = findTodo(todoId);
    if (!todo || todo.done || data.items.some(item => item.todoId === todoId)) continue;
    if (data.items.length >= limit) break;
    data.items.push({ todoId, text: todo.text, done: false });
    added++;
  }
  if (!added) {
    showMiniToast(data.items.length >= limit ? `${label}聚焦已满（上限 ${limit} 项）` : '没有可添加的待办（已完成或已在聚焦中）');
    return;
  }
  if (!saveFocusData(data)) { showMiniToast('聚焦保存失败', 'error'); return; }
  selectedFocusDate = date;
  renderFocusList();
  renderTodoQueue();
  if (typeof renderTodos === 'function') renderTodos();
  showMiniToast(`已添加 ${added} 项到${label}聚焦`);
}

function editQueueTodoNote(id) {
  document.activeElement?.blur();
  queueNoteEditingId = id;
  renderTodoQueue();
  requestAnimationFrame(() => {
    const input = document.getElementById('queueTodoNoteInput-' + id);
    if (input) { input.focus(); input.select(); }
  });
}

function saveQueueTodoNote(id, value) {
  if (!saveTodoSharedNote(id, value)) { showMiniToast('一句话保存失败', 'error'); return; }
  queueNoteEditingId = null;
  renderTodoQueue();
  renderFocusList();
}

function handleQueueTodoNoteKeydown(event, id) {
  if (event.isComposing) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    event.currentTarget.blur();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    queueNoteEditingId = null;
    event.currentTarget.onblur = null;
    renderTodoQueue();
  }
}

function renderTodoQueue() {
  const activeInput = document.activeElement;
  if (activeInput && queueNoteEditingId != null && activeInput.id === 'queueTodoNoteInput-' + queueNoteEditingId) {
    if (!activeInput._queueRefreshPending) {
      activeInput._queueRefreshPending = true;
      activeInput.addEventListener('blur', () => {
        activeInput._queueRefreshPending = false;
        setTimeout(() => renderTodoQueue(), 0);
      }, { once: true });
    }
    return;
  }
  const list = document.getElementById('todayTodoQueueList');
  if (!list) return;
  const ids = loadTodoQueue();
  const hideDone = localStorage.getItem('study_todo_queue_hide_done') === 'true';
  const visibleIds = hideDone ? ids.filter(id => !findTodo(id).done) : ids;
  const hideDoneButton = document.getElementById('todayTodoQueueHideDone');
  hideDoneButton.setAttribute('aria-pressed', String(hideDone));
  hideDoneButton.textContent = hideDone ? '显示已完成' : '隐藏已完成';
  hideDoneButton.title = hideDone ? '显示已完成待办' : '隐藏已完成待办';
  const expanded = localStorage.getItem('study_todo_queue_expanded') === 'true';
  document.getElementById('todayTodoQueueCount').textContent = hideDone && visibleIds.length !== ids.length
    ? `${visibleIds.length} / ${ids.length} 项` : `${ids.length} 项`;
  const toggle = document.getElementById('todayTodoQueueToggle');
  toggle.hidden = visibleIds.length <= 5;
  document.getElementById('todayTodoQueueToggleLabel').textContent = expanded ? '折叠' : '展开';
  toggle.title = expanded ? '折叠待办队列（显示前 5 项）' : '展开全部待办队列';
  document.getElementById('todayTodoQueueCard').classList.toggle('is-collapsed', !expanded);
  toggle.setAttribute('aria-expanded', String(expanded));
  list.innerHTML = visibleIds.length ? (expanded ? visibleIds : visibleIds.slice(0, 5)).map((id, index) => {
    const todo = findTodo(id);
    const path = getFocusTodoDisplayPath(todo);
    const note = getTodoSharedNote(id);
    const editing = queueNoteEditingId === id;
    return `<div class="today-focus-item todo-queue-item${todo.done ? ' completed' : ''}" draggable="true"
      ondragstart="startTodoQueueDrag(event, ${id})" ondragover="overTodoQueue(event)"
      ondragleave="this.classList.remove('drop-before','drop-after')" ondrop="dropTodoQueue(event, ${id})" ondragend="endTodoQueueDrag()">
      <div class="today-focus-main">
      <span class="todo-queue-grip" title="拖拽排序 · 第 ${index + 1} 项">⠿</span>
      <span class="focus-check${todo.done ? ' done' : ''} disabled" title="${todo.done ? '已完成' : '未完成'}" aria-label="${todo.done ? '已完成' : '未完成'}"></span>
      <span class="focus-text${todo.done ? ' completed' : ''}" title="${escapeAttr(path.full)}">
        ${path.parents.length ? '<span class="focus-parent-path">' + path.parents.map(escapeHtml).join('<span class="focus-path-separator">›</span>') + '</span>' : ''}
        <span class="focus-title">${escapeHtml(todo.text)}</span>
      </span>
      <button class="focus-nav" onclick="goToTodoFromFocus(${id})" title="跳转到待办目录" aria-label="跳转到待办目录"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg></button>
      <button class="focus-note-edit" onclick="event.stopPropagation(); editQueueTodoNote(${id})" title="${note ? '编辑一句话' : '添加一句话'}" aria-label="${note ? '编辑一句话' : '添加一句话'}"><i data-lucide="message-square-plus" class="lucide-icon"></i></button>
      <div class="todo-queue-actions">
        <button class="focus-nav" title="添加到今日聚焦" onclick="addQueueToFocus(0, ${id})" ${todo.done ? 'disabled' : ''}>今日</button>
        <button class="focus-nav" title="添加到明日聚焦" onclick="addQueueToFocus(1, ${id})" ${todo.done ? 'disabled' : ''}>明日</button>
        <button class="focus-delete" onclick="removeTodoFromQueue(${id})" title="移出队列" aria-label="移出队列">✕</button>
      </div></div>
      ${editing ? `<div class="today-focus-note-row editing" draggable="false" ondragstart="event.stopPropagation(); event.preventDefault()">
        <input class="today-focus-note-input" id="queueTodoNoteInput-${id}" type="text" maxlength="160" value="${escapeAttr(note)}" placeholder="写一句话提醒自己…" onkeydown="handleQueueTodoNoteKeydown(event, ${id})" onblur="saveQueueTodoNote(${id}, this.value)">
      </div>` : (note ? `<button class="today-focus-note-row" onclick="editQueueTodoNote(${id})" title="点击编辑"><i data-lucide="message-square" class="lucide-icon"></i><span>${escapeHtml(note)}</span></button>` : '')}
      </div>`;
  }).join('') : `<div class="todo-queue-empty">${ids.length ? '队列中的待办均已完成，点击「显示已完成」可查看' : '在待办上右键，选择「加入待办队列」'}</div>`;
  document.querySelectorAll('[data-queue-fill]').forEach(button => { button.disabled = !ids.some(id => !findTodo(id).done); });
  if (document.getElementById('queueTodoPicker')?.style.display === 'block') renderQueueTodoPicker();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}
