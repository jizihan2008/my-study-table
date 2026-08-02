// ═══════════ Timer / Stopwatch ═══════════
// Records time spent on linked todos or long-term goals.
// Data stored in localStorage key: study_timer_records
//
// Record format: { id, targetId, targetType: 'todo'|'goal', date (YYYY-MM-DD), totalMs, sessions: [{ start: timestamp_ms, end: timestamp_ms }], affectsFocus: bool, manual: bool }

// ═══════════ Data persistence ═══════════
let _timerRecordIdCounter = Date.now();

function genTimerRecordId() {
  return _timerRecordIdCounter++;
}

function loadTimerRecords() {
  let records;
  try { records = JSON.parse(localStorage.getItem('study_timer_records') || '[]'); }
  catch { return []; }
  let changed = false;
  for (const rec of records) {
    if (!rec.id) { rec.id = genTimerRecordId(); changed = true; }
    if (rec.affectsFocus == null) { rec.affectsFocus = true; changed = true; }
    if (rec.manual == null) { rec.manual = false; changed = true; }
  }
  if (changed) saveTimerRecords(records);
  return records;
}

function saveTimerRecords(records) {
  localStorage.setItem('study_timer_records', JSON.stringify(records));
}

// ═══════════ Global state ═══════════
let timerRunning = false;
let timerSessionStart = 0;   // timestamp when current segment started
let timerElapsed = 0;        // ms accumulated from completed segments
let timerSessions = [];      // completed segments: [{ start: timestamp, end: timestamp }]
let timerLinkedTodoId = null;
let timerLinkedGoalId = null;
let timerPickerMode = 'todo'; // 'todo' or 'goal'
let timerPickerTarget = 'timer'; // 'timer' | 'manualTodo' — who opened the picker
let timerInterval = null;
let timerStateRestored = false; // flag: timer was restored from saved state

// ═══════════ Timer state persistence (survive refresh/close) ═══════════
function saveTimerState() {
  const state = {
    running: timerRunning,
    elapsed: timerElapsed,
    sessionStart: timerSessionStart,
    sessions: timerSessions,
    linkedTodoId: timerLinkedTodoId,
    linkedGoalId: timerLinkedGoalId,
    savedAt: Date.now()
  };
  localStorage.setItem('study_timer_state', JSON.stringify(state));
}

function clearTimerState() {
  localStorage.removeItem('study_timer_state');
}

function loadAndRestoreTimerState() {
  let state;
  try { state = JSON.parse(localStorage.getItem('study_timer_state')); }
  catch { return; }
  if (!state) return;

  // Restore linked targets
  timerLinkedTodoId = state.linkedTodoId || null;
  timerLinkedGoalId = state.linkedGoalId || null;

  // Restore completed sessions & elapsed
  timerElapsed = state.elapsed || 0;
  timerSessions = state.sessions || [];
  timerStateRestored = true;

  if (state.running) {
    // Timer was running when last saved — resume with gap accumulated
    timerRunning = true;
    const now = Date.now();
    const origSessionStart = state.sessionStart || state.savedAt || now;
    // Continue the same segment seamlessly (keep original sessionStart)
    timerSessionStart = origSessionStart;
    timerInterval = setInterval(function() {
      renderTimer();
      saveTimerState(); // persist on every tick
    }, 500);
    clearTimerState(); // consumed
  } else {
    // Timer was paused/stopped — just restore state
    timerRunning = false;
    clearTimerState(); // consumed
    // Do NOT auto-render; wait for user to open timer tab
  }
}

// Save state on every tick + on visibility/page unload
window.addEventListener('beforeunload', function() {
  saveTimerState();
});

document.addEventListener('visibilitychange', function() {
  if (document.hidden && timerRunning) {
    saveTimerState();
  }
});

// Manual record state
let timerManualFormOpen = false;
let timerEditingRecordId = null; // null = add mode, id = edit mode
let manualRecSelectedTodoId = null; // selected todo for the manual record form
let timerPickerOpen = false; // 待办选择遮罩是否打开（心跳重绘后需恢复）

// ═══════════ Render ═══════════
function renderTimer() {
  const container = document.getElementById('timerContainer');
  const linkedTodo = timerLinkedTodoId ? findTodo(timerLinkedTodoId) : null;
  const linkedGoal = timerLinkedGoalId ? loadGoals().find(g => g.id === timerLinkedGoalId) : null;

  const totalMs = timerElapsed + (timerRunning ? Date.now() - timerSessionStart : 0);
  const display = formatTimerTime(totalMs);

  const todayStr = formatDate(new Date());
  const records = loadTimerRecords();
  let todayMs = 0;
  const todaySessions = [];
  for (const rec of records) {
    if (rec.date === todayStr) {
      let match = false;
      // Show records matching todo OR goal (both independent)
      if (timerLinkedTodoId && rec.targetType === 'todo') {
        match = getAllDescendantIds(timerLinkedTodoId).includes(rec.targetId);
      }
      if (timerLinkedGoalId && rec.targetType === 'goal') {
        if (rec.targetId === timerLinkedGoalId) match = true;
      }
      // If nothing linked, show all records
      if (!timerLinkedTodoId && !timerLinkedGoalId) match = true;
      if (match) {
        todayMs += rec.totalMs;
        if (rec.sessions) todaySessions.push(...rec.sessions);
      }
    }
  }

  // Linked target picker — independent todo + goal
  const todoPath = timerLinkedTodoId && linkedTodo ? getAncestorPath(timerLinkedTodoId) : [];
  const todoPathStr = timerHistoryExpanded ? todoPath.map(p => p.text).join(' › ') : '';
  const todoHtml = timerLinkedTodoId && linkedTodo
    ? `<div class="timer-linked-todo" onclick="openTimerTodoPicker()">
        <span class="timer-linked-label">📋 待办：</span>
        <span class="timer-linked-text">${todoPathStr ? escapeHtml(todoPathStr) + ' › ' : ''}${escapeHtml(linkedTodo.text)}</span>
        <button class="timer-unlink-btn" onclick="event.stopPropagation(); unlinkTimerTodo()" title="解除关联">✕</button>
      </div>`
    : `<button class="timer-link-btn" onclick="openTimerTodoPicker()">📋 关联待办</button>`;
  const goalHtml = timerLinkedGoalId && linkedGoal
    ? `<div class="timer-linked-todo" onclick="openTimerGoalPicker()">
        <span class="timer-linked-label">🎯 目标：</span>
        <span class="timer-linked-text">${escapeHtml(linkedGoal.text)}</span>
        <button class="timer-unlink-btn" onclick="event.stopPropagation(); unlinkTimerGoal()" title="解除关联">✕</button>
      </div>`
    : `<button class="timer-link-btn" onclick="openTimerGoalPicker()">🎯 关联目标</button>`;
  const isCentered = !timerHistoryExpanded;
  const pickerHtml = isCentered
    ? `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:center;">${todoHtml}${goalHtml}</div>`
    : `<div style="display:flex;flex-direction:column;gap:4px;"><div style="display:flex;gap:6px;align-items:center;">${todoHtml}</div><div style="display:flex;gap:6px;align-items:center;">${goalHtml}</div></div>`;

  // Today's sessions
  let sessionsHtml = '';
  if (todaySessions.length > 0) {
    sessionsHtml = '<div class="timer-sessions">';
    todaySessions.sort((a, b) => a.start - b.start);
    for (const s of todaySessions) {
      const startStr = formatTimeOnly(s.start);
      const endStr = formatTimeOnly(s.end);
      const dur = formatTimerTime(s.end - s.start);
      sessionsHtml += `<div class="timer-session-item">
        <span class="timer-session-time">${startStr} — ${endStr}</span>
        <span class="timer-session-dur">${dur}</span>
      </div>`;
    }
    sessionsHtml += '</div>';
  }

  container.innerHTML = `
    <div class="timer-panel">
      ${pickerHtml}
      <div class="timer-display">${display}</div>
      <div class="timer-today">今日累计：${formatTimerTime(todayMs)}</div>
      ${sessionsHtml}
      <div class="timer-controls">
        ${!timerRunning
          ? `<button class="timer-btn timer-btn-start" onclick="timerStart()">▶ 开始</button>
             <button class="timer-btn timer-btn-save" onclick="timerSave()"><i data-lucide="save" class="lucide-icon"></i> 保存</button>
             <button class="timer-btn timer-btn-reset" onclick="timerReset()">⟲ 重置</button>`
          : `<button class="timer-btn timer-btn-pause" onclick="timerPause()"><i data-lucide="pause-circle" class="lucide-icon"></i> 暂停</button>
             <button class="timer-btn timer-btn-stop" onclick="timerStop()"><i data-lucide="stop-circle" class="lucide-icon"></i> 停止并保存</button>`
        }
        ${!isCentered ? `<button class="timer-btn timer-btn-manual${timerManualFormOpen ? ' active' : ''}" onclick="toggleManualRecordForm()">📝 ${timerManualFormOpen ? '取消' : '手动记录'}</button>` : ''}
      </div>
      ${!isCentered && timerManualFormOpen ? renderManualRecordForm() : ''}
    </div>
    <div class="timer-history" id="timerHistory">
      ${renderTimerHistory(records)}
    </div>
    <div class="timer-picker-overlay" id="timerPickerOverlay" style="display:none;" onclick="closeTimerTodoPicker(event)">
      <div class="timer-picker" onclick="event.stopPropagation()">
        <div class="timer-picker-header">
          <span>选择要关联的待办</span>
          <button class="timer-picker-close" onclick="closeTimerTodoPicker()">✕</button>
        </div>
        <input type="text" class="timer-picker-search" id="timerPickerSearch" placeholder="搜索待办..." oninput="renderTimerPickerList()">
        <div class="todo-picker-list" id="timerPickerList"></div>
      </div>
    </div>
  `;

  // 心跳每 500ms 重绘一次容器：若选择遮罩正打开则恢复显示并重建列表，否则跳过（避免重复渲染开销）
  const pickerOverlay = document.getElementById('timerPickerOverlay');
  if (timerPickerOpen && pickerOverlay) {
    pickerOverlay.style.display = '';
    const header = pickerOverlay.querySelector('.timer-picker-header span');
    if (header) header.textContent = timerPickerMode === 'goal' ? '选择要关联的长期目标' : '选择要关联的待办';
    renderTimerPickerList();
  }

  // Refresh Lucide icons for newly rendered buttons
  if (typeof lucide !== 'undefined') lucide.createIcons();

  // Center the timer panel when history is collapsed
  const card = container.closest('.card');
  if (card) card.classList.toggle('timer-centered', !timerHistoryExpanded);
}

// ── Timer history collapse state ──
let timerHistoryExpanded = true; // entire history block expand/collapse

function toggleTimerHistory() {
  timerHistoryExpanded = !timerHistoryExpanded;

  if (timerHistoryExpanded) {
    animateTimerHistoryExpand();
  } else {
    // COLLAPSE: animate existing DOM to 0, then re-render
    const body = document.querySelector('.timer-history-body');
    if (body) {
      body.style.overflow = 'hidden';
      body.style.maxHeight = body.scrollHeight + 'px';
      body.offsetHeight;
      body.style.maxHeight = '0px';
      body.addEventListener('transitionend', () => {
        renderTimer();
      }, { once: true });
    } else {
      renderTimer();
    }
  }
}

function animateTimerHistoryExpand() {
  renderTimer();
  requestAnimationFrame(() => {
    const body = document.querySelector('.timer-history-body');
    if (!body) return;
    body.style.transition = 'none';
    body.style.maxHeight = '0px';
    body.style.overflow = 'hidden';
    body.offsetHeight; // force reflow
    body.style.transition = '';
    body.style.maxHeight = body.scrollHeight + 'px';
    body.addEventListener('transitionend', () => {
      body.style.maxHeight = '';
      body.style.overflow = '';
    }, { once: true });
  });
}

function renderTimerHistory(records) {
  const todayStr = formatDate(new Date());
  const dateMap = {};
  for (const rec of records) {
    if (!dateMap[rec.date]) dateMap[rec.date] = [];
    dateMap[rec.date].push(rec);
  }
  const sortedDates = Object.keys(dateMap).sort().reverse().slice(0, 14);

  if (sortedDates.length === 0) return '';

  let bodyHtml = '';
  for (const dateStr of sortedDates) {
    const items = dateMap[dateStr];
    let dayTotal = 0;
    const itemHtml = [];
    for (const rec of items) {
      let name = '⏱ 自由计时';
      if (rec.targetType === 'goal' || rec.targetId) {
        const targetId = rec.targetId || rec.todoId;
        const targetType = rec.targetType || 'todo';
        if (targetType === 'goal') {
          const goal = loadGoals().find(g => g.id === targetId);
          name = goal ? '🎯 ' + goal.text : '(已删除的目标)';
        } else {
          const todo = findTodo(targetId);
          name = todo ? todo.text : '(已删除)';
        }
      } else if (rec.todoId) {
        const todo = findTodo(rec.todoId);
        name = todo ? todo.text : '(已删除)';
      }
      dayTotal += rec.totalMs;
      if (rec.totalMs >= 1000) {
        let sessionDetail = '';
        if (rec.sessions && rec.sessions.length > 0) {
          const sorted = [...rec.sessions].sort((a, b) => a.start - b.start);
          const detailItems = sorted.map(s =>
            `<div class="timer-history-session">${formatTimeOnly(s.start)} — ${formatTimeOnly(s.end)} (${formatTimerTime(s.end - s.start)})</div>`
          ).join('');
          sessionDetail = `<div class="timer-history-sessions">${detailItems}</div>`;
        }
        itemHtml.push(`<div class="timer-history-item${(!rec.affectsFocus) ? ' no-focus' : ''}">
          <span class="timer-history-name">
            ${escapeHtml(name)}
            ${(!rec.affectsFocus) ? '<span class="timer-no-focus-badge" title="不计入专注时间">⚡</span>' : ''}
            ${rec.manual ? '<span class="timer-manual-badge" title="手动添加">✍</span>' : ''}
          </span>
          <span class="timer-history-time">
            <span class="timer-history-actions">
              <button class="timer-hist-btn" onclick="editTimerRecord(${rec.id})" title="编辑">✎</button>
              <button class="timer-hist-btn danger" onclick="deleteTimerRecord(${rec.id})" title="删除">✕</button>
            </span>
            ${formatTimerTime(rec.totalMs)}
          </span>
        </div>`);
        if (sessionDetail) itemHtml.push(`<div class="timer-history-sessions-wrap">${sessionDetail}</div>`);
      }
    }
    if (itemHtml.length === 0) continue;
    const isToday = dateStr === todayStr;
    const label = isToday ? '今天' : dateStr;
    bodyHtml += `<div class="timer-history-date">
      <div class="timer-history-date-header">
        <span>${label}</span>
        <span class="timer-history-date-total">共 ${formatTimerTime(dayTotal)}</span>
      </div>
      ${itemHtml.join('')}
    </div>`;
  }

  const arrow = timerHistoryExpanded ? '▼' : '▶';
  const count = sortedDates.length;
  return `<div class="timer-history-title" onclick="toggleTimerHistory()">
    <span class="timer-history-toggle">${arrow}</span> 📊 计时记录
    <span class="timer-history-count">(${count})</span>
  </div>
  <div class="timer-history-body${timerHistoryExpanded ? '' : ' collapsed'}">
    ${bodyHtml}
  </div>`;
}

function formatTimerTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function formatTimeOnly(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}

// ═══════════ Timer controls ═══════════
function timerStart() {
  if (timerRunning) return;
  timerRunning = true;
  timerSessionStart = Date.now();
  timerHistoryExpanded = false;
  timerInterval = setInterval(function() {
    renderTimer();
    saveTimerState();
  }, 500);
  saveTimerState();
  renderTimer();
}

function timerPause() {
  if (!timerRunning) return;
  const now = Date.now();
  timerRunning = false;
  timerElapsed += now - timerSessionStart;
  timerSessions.push({ start: timerSessionStart, end: now });
  clearInterval(timerInterval);
  timerInterval = null;
  saveTimerState();
  renderTimer();
}

function timerStop() {
  const now = Date.now();
  if (timerRunning) {
    timerElapsed += now - timerSessionStart;
    timerSessions.push({ start: timerSessionStart, end: now });
    clearInterval(timerInterval);
    timerInterval = null;
    timerRunning = false;
  }
  if (timerElapsed >= 1000) {
    const records = loadTimerRecords();
    const todayStr = formatDate(new Date());
    const sessions = timerSessions.length > 0 ? [...timerSessions] : [{ start: timerSessionStart, end: now }];
    const baseRecord = { id: genTimerRecordId(), date: todayStr, totalMs: timerElapsed, sessions, affectsFocus: true, manual: false };
    // Save for todo if linked
    if (timerLinkedTodoId) {
      records.push({ ...baseRecord, id: genTimerRecordId(), targetId: timerLinkedTodoId, targetType: 'todo' });
    }
    // Save for goal if linked
    if (timerLinkedGoalId) {
      records.push({ ...baseRecord, id: genTimerRecordId(), targetId: timerLinkedGoalId, targetType: 'goal' });
    }
    // Always push a generic record if not linked to anything
    if (!timerLinkedTodoId && !timerLinkedGoalId) {
      records.push(baseRecord);
    }
    saveTimerRecords(records);
  }
  timerElapsed = 0;
  timerSessions = [];
  clearTimerState();
  if (!timerHistoryExpanded) { timerHistoryExpanded = true; animateTimerHistoryExpand(); }
  else renderTimer();
}

function timerSave() {
  if (timerRunning) return;
  if (timerElapsed < 1000) return;
  const now = Date.now();
  const records = loadTimerRecords();
  const todayStr = formatDate(new Date());
  const sessions = timerSessions.length > 0 ? [...timerSessions] : [{ start: timerSessionStart, end: now }];
  const baseRecord = { id: genTimerRecordId(), date: todayStr, totalMs: timerElapsed, sessions, affectsFocus: true, manual: false };
  if (timerLinkedTodoId) {
    records.push({ ...baseRecord, id: genTimerRecordId(), targetId: timerLinkedTodoId, targetType: 'todo' });
  }
  if (timerLinkedGoalId) {
    records.push({ ...baseRecord, id: genTimerRecordId(), targetId: timerLinkedGoalId, targetType: 'goal' });
  }
  if (!timerLinkedTodoId && !timerLinkedGoalId) {
    records.push(baseRecord);
  }
  saveTimerRecords(records);
  timerElapsed = 0;
  timerSessions = [];
  clearTimerState();
  if (!timerHistoryExpanded) { timerHistoryExpanded = true; animateTimerHistoryExpand(); }
  else renderTimer();
}

function timerReset() {
  if (timerRunning) {
    clearInterval(timerInterval);
    timerInterval = null;
    timerRunning = false;
  }
  timerElapsed = 0;
  timerSessions = [];
  clearTimerState();
  renderTimer();
}

function unlinkTimerTodo() {
  timerLinkedTodoId = null;
  if (timerRunning) {
    clearInterval(timerInterval);
    timerInterval = null;
    timerRunning = false;
  }
  timerElapsed = 0;
  timerSessions = [];
  clearTimerState();
  renderTimer();
}

function unlinkTimerGoal() {
  timerLinkedGoalId = null;
  if (timerRunning) {
    clearInterval(timerInterval);
    timerInterval = null;
    timerRunning = false;
  }
  timerElapsed = 0;
  timerSessions = [];
  clearTimerState();
  renderTimer();
}

function openTimerGoalPicker() {
  timerPickerMode = 'goal';
  timerPickerOpen = true;
  const overlay = document.getElementById('timerPickerOverlay');
  const header = overlay?.querySelector('.timer-picker-header span');
  if (header) header.textContent = '选择要关联的长期目标';
  document.getElementById('timerPickerOverlay').style.display = '';
  document.getElementById('timerPickerSearch').value = '';
  renderTimerPickerList();
  setTimeout(() => document.getElementById('timerPickerSearch')?.focus(), 100);
}

function pickTimerGoal(id) {
  timerLinkedGoalId = id;
  closeTimerTodoPicker();
  if (timerRunning) {
    clearInterval(timerInterval);
    timerInterval = null;
    timerRunning = false;
  }
  timerElapsed = 0;
  timerSessions = [];
  clearTimerState();
  renderTimer();
}

// ═══════════ Todo picker (tree view) ═══════════
let timerPickerExpandedIds = new Set();

function openTimerTodoPicker(target = 'timer') {
  timerPickerTarget = target;
  timerPickerMode = 'todo';
  const overlay = document.getElementById('timerPickerOverlay');
  const header = overlay?.querySelector('.timer-picker-header span');
  if (header) header.textContent = '选择要关联的待办';
  document.getElementById('timerPickerOverlay').style.display = '';
  document.getElementById('timerPickerSearch').value = '';
  timerPickerExpandedIds = new Set();
  renderTimerPickerList();
  setTimeout(() => document.getElementById('timerPickerSearch')?.focus(), 100);
}

function closeTimerTodoPicker(e) {
  if (e && e.target !== document.getElementById('timerPickerOverlay')) return;
  timerPickerOpen = false;
  document.getElementById('timerPickerOverlay').style.display = 'none';
  timerPickerExpandedIds = new Set();
}

function toggleTimerPickerExpand(id, event) {
  if (event) event.stopPropagation();
  if (timerPickerExpandedIds.has(id)) timerPickerExpandedIds.delete(id);
  else timerPickerExpandedIds.add(id);
  renderTimerPickerList();
}

function renderTimerPickerNode(t, depth) {
  const children = getChildren(t.id);
  const hasKids = children.length > 0;
  const isExpanded = timerPickerExpandedIds.has(t.id);
  const selId = timerPickerTarget === 'manualTodo' ? manualRecSelectedTodoId : timerLinkedTodoId;
  const isSelected = selId === t.id;
  const indent = depth * 16;
  const renderedChildren = children.map(c => renderTimerPickerNode(c, depth + 1)).join('');
  return `
    <div>
      <div class="todo-picker-item${isSelected ? ' selected' : ''}" onclick="selectTimerTodo(${t.id})" style="padding-left:${14 + indent}px;">
        ${hasKids ? `<button class="picker-expand${isExpanded ? ' expanded' : ''}" onclick="toggleTimerPickerExpand(${t.id}, event)" title="展开/折叠">▶</button>` : '<span class="picker-expand-spacer"></span>'}
        <div class="picker-check"></div>
        <span class="picker-text${t.done ? ' done' : ''}">${escapeHtml(t.text)}</span>
        ${hasKids ? '<span class="picker-badge">' + children.length + '</span>' : ''}
        ${t.dueDate ? '<span class="picker-due">📅 ' + t.dueDate + '</span>' : ''}
      </div>
      ${(hasKids && renderedChildren) ? `<div class="picker-children${isExpanded ? '' : ' collapsed'}">${renderedChildren}</div>` : ''}
    </div>
  `;
}

function renderTimerPickerQuickSelect() {
  const records = loadTimerRecords();
  if (!records.length) return '';

  const todayStr = formatDate(new Date());
  const todayIds = []; // unique todo ids focused today
  const seenToday = new Set();
  const histIds = []; // recent 3 unique todo ids from past
  const seenHist = new Set();

  // Process most recent first
  for (const r of records.slice().reverse()) {
    if (r.targetType !== 'todo' || !r.targetId) continue;
    const todo = findTodo(r.targetId);
    if (!todo) continue;
    if (r.date === todayStr) {
      if (!seenToday.has(r.targetId)) {
        seenToday.add(r.targetId);
        todayIds.push(r.targetId);
      }
    } else {
      if (!seenHist.has(r.targetId) && histIds.length < 3) {
        seenHist.add(r.targetId);
        histIds.push(r.targetId);
      }
    }
  }

  const selId = timerPickerTarget === 'manualTodo' ? manualRecSelectedTodoId : timerLinkedTodoId;
  let html = '';

  if (todayIds.length) {
    html += '<div class="picker-quick-head">今日聚焦</div>';
    html += '<div class="picker-quick-row">';
    html += todayIds.map(id => {
      const t = findTodo(id);
      if (!t) return '';
      const cls = selId === id ? 'picker-quick-chip selected' : 'picker-quick-chip';
      return `<button class="${cls}" onclick="selectTimerTodo(${id})" title="${escapeHtml(t.text)}">${escapeHtml(t.text.length > 12 ? t.text.slice(0,12)+'…' : t.text)}</button>`;
    }).join('');
    html += '</div>';
  }

  if (histIds.length) {
    html += '<div class="picker-quick-head">最近使用</div>';
    html += '<div class="picker-quick-row">';
    html += histIds.map(id => {
      const t = findTodo(id);
      if (!t) return '';
      const cls = selId === id ? 'picker-quick-chip selected' : 'picker-quick-chip';
      return `<button class="${cls}" onclick="selectTimerTodo(${id})" title="${escapeHtml(t.text)}">${escapeHtml(t.text.length > 12 ? t.text.slice(0,12)+'…' : t.text)}</button>`;
    }).join('');
    html += '</div>';
  }

  return html;
}

function renderTimerPickerList() {
  const list = document.getElementById('timerPickerList');
  if (!list) return;

  if (timerPickerMode === 'goal') {
    // Show long-term goals
    const goals = loadGoals();
    const searchQuery = (document.getElementById('timerPickerSearch')?.value || '').toLowerCase();
    let filtered = goals;
    if (searchQuery) filtered = goals.filter(g => g.text.toLowerCase().includes(searchQuery));
    if (filtered.length === 0) { list.innerHTML = '<div class="todo-picker-empty">没有匹配的长期目标</div>'; return; }
    list.innerHTML = filtered.map(g => {
      const isSelected = timerLinkedGoalId === g.id;
      return `<div class="todo-picker-item${isSelected ? ' selected' : ''}" onclick="pickTimerGoal(${g.id})">
        <span class="picker-expand-spacer"></span>
        <div class="picker-check"></div>
        <span class="picker-text${g.done ? ' done' : ''}">🎯 ${escapeHtml(g.text)}</span>
        ${g.dueDate ? '<span class="picker-due">📅 ' + g.dueDate + '</span>' : ''}
      </div>`;
    }).join('');
    return;
  }

  // Todo picker mode
  const searchQuery = (document.getElementById('timerPickerSearch')?.value || '').toLowerCase();
  if (searchQuery) {
    const filtered = todos.filter(t => t.text.toLowerCase().includes(searchQuery));
    if (filtered.length === 0) { list.innerHTML = '<div class="todo-picker-empty">没有匹配的待办事项</div>'; return; }
    list.innerHTML = filtered.map(t => {
      const selId = timerPickerTarget === 'manualTodo' ? manualRecSelectedTodoId : timerLinkedTodoId;
      const isSelected = selId === t.id;
      return `<div class="todo-picker-item${isSelected ? ' selected' : ''}" onclick="selectTimerTodo(${t.id})">
        <span class="picker-expand-spacer"></span>
        <div class="picker-check"></div>
        <span class="picker-text${t.done ? ' done' : ''}">${escapeHtml(t.text)}</span>
        ${t.dueDate ? '<span class="picker-due">📅 ' + t.dueDate + '</span>' : ''}
      </div>`;
    }).join('');
  } else {
    const roots = todos.filter(t => t.parentId === null);
    const quickHtml = renderTimerPickerQuickSelect();
    if (roots.length === 0 && !quickHtml) { list.innerHTML = '<div class="todo-picker-empty">暂无待办</div>'; return; }
    list.innerHTML = (quickHtml || '') + (roots.length ? roots.map(t => renderTimerPickerNode(t, 0)).join('') : '');
  }
}

function selectTimerTodo(id) {
  if (timerPickerTarget === 'manualTodo') {
    manualRecSelectedTodoId = id;
    // Clear goal selection (mutual exclusion)
    const goalEl = document.getElementById('manualRecGoal');
    if (goalEl) goalEl.value = '';
    closeTimerTodoPicker();
    // Targeted DOM update — don't re-render the whole form to preserve unsaved edits
    const container = document.getElementById('manualRecTodoContainer');
    if (container) container.outerHTML = `<span id="manualRecTodoContainer">${renderManualTodoSelector(null, null)}</span>`;
    return;
  }
  timerLinkedTodoId = id;
  timerElapsed = 0;
  timerSessions = [];
  if (timerRunning) { clearInterval(timerInterval); timerInterval = null; timerRunning = false; }
  clearTimerState();
  closeTimerTodoPicker();
  renderTimer();
}

// ═══════════ Manual Record Management ═══════════
function toTimeStr(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function toggleManualRecordForm() {
  timerManualFormOpen = !timerManualFormOpen;
  timerEditingRecordId = null;
  manualRecSelectedTodoId = null;
  renderTimer();
}

function renderManualRecordForm() {
  const isEdit = timerEditingRecordId !== null;
  const records = loadTimerRecords();
  const rec = isEdit ? records.find(r => r.id === timerEditingRecordId) : null;

  const now = new Date();
  const defaultDate = rec ? rec.date : formatDate(now);
  const defaultStart = rec && rec.sessions && rec.sessions.length ? new Date(rec.sessions[0].start) : new Date(now.getTime() - 25 * 60000);
  const defaultEnd = rec && rec.sessions && rec.sessions.length ? new Date(rec.sessions[rec.sessions.length - 1].end) : now;
  const defaultAffectsFocus = rec ? rec.affectsFocus : true;

  // Normalize target for old-format records
  const recTargetType = rec ? (rec.targetType || (rec.todoId ? 'todo' : null)) : null;
  const recTargetId = rec ? (rec.targetId || rec.todoId || null) : null;

  return `
    <div class="timer-manual-form">
      <div class="timer-manual-form-title">${isEdit ? '编辑记录' : '手动添加专注记录'}</div>
      <div class="timer-manual-row">
        <div class="timer-manual-field">
          <label>日期</label>
          <input type="date" id="manualRecDate" value="${defaultDate}">
        </div>
        <div class="timer-manual-field">
          <label>开始时间</label>
          <input type="time" id="manualRecStart" value="${toTimeStr(defaultStart)}">
        </div>
        <div class="timer-manual-field">
          <label>结束时间</label>
          <input type="time" id="manualRecEnd" value="${toTimeStr(defaultEnd)}">
        </div>
      </div>
      <div class="timer-manual-row">
        <div class="timer-manual-field">
          <label>关联待办</label>
          <span id="manualRecTodoContainer">${renderManualTodoSelector(recTargetId, recTargetType)}</span>
        </div>
        <div class="timer-manual-field">
          <label>关联目标</label>
          <select id="manualRecGoal" onchange="onManualRecGoalChange()">
            <option value="">无关联</option>
            ${buildManualGoalOptions(recTargetId, recTargetType)}
          </select>
        </div>
      </div>
      <div class="timer-manual-row timer-manual-check">
        <label class="timer-manual-check-label">
          <input type="checkbox" id="manualRecAffectsFocus" ${defaultAffectsFocus ? 'checked' : ''}>
          <span>计入待办/目标的专注时间</span>
        </label>
      </div>
      <div class="timer-manual-actions">
        <button class="timer-btn timer-btn-start" onclick="saveManualRecord()">💾 ${isEdit ? '保存修改' : '添加记录'}</button>
        <button class="timer-btn timer-btn-reset" onclick="toggleManualRecordForm()">取消</button>
      </div>
    </div>`;
}

function renderManualTodoSelector(recTargetId, recTargetType) {
  // Determine selected todo: from editing record OR from picker state
  const selId = (recTargetType === 'todo' && recTargetId) ? recTargetId : (manualRecSelectedTodoId || null);
  const selTodo = selId ? findTodo(selId) : null;
  const todoPath = selTodo ? getAncestorPath(selId) : [];
  const todoPathStr = todoPath.map(p => p.text).join(' › ');

  if (selTodo) {
    return `<div class="timer-linked-todo" onclick="openTimerTodoPicker('manualTodo')" style="margin:0;">
      <span class="timer-linked-label">📋 待办：</span>
      <span class="timer-linked-text">${todoPathStr ? escapeHtml(todoPathStr) + ' › ' : ''}${escapeHtml(selTodo.text)}</span>
      <button class="timer-unlink-btn" onclick="event.stopPropagation(); clearManualRecTodo()" title="清除选择">✕</button>
    </div>
    <input type="hidden" id="manualRecTodo" value="${selId}">`;
  } else {
    return `<button class="timer-link-btn" onclick="openTimerTodoPicker('manualTodo')" style="margin:0;">📋 选择待办</button>
    <input type="hidden" id="manualRecTodo" value="">`;
  }
}

function clearManualRecTodo() {
  manualRecSelectedTodoId = null;
  const todoEl = document.getElementById('manualRecTodo');
  if (todoEl) todoEl.value = '';
  // Targeted DOM update for the todo selector
  const container = document.getElementById('manualRecTodoContainer');
  if (container) container.outerHTML = `<span id="manualRecTodoContainer">${renderManualTodoSelector(null, null)}</span>`;
}

function buildManualGoalOptions(recTargetId, recTargetType) {
  return loadGoals().map(g => {
    return `<option value="${g.id}"${recTargetType === 'goal' && recTargetId === g.id ? ' selected' : ''}>${escapeHtml(g.text)}</option>`;
  }).join('');
}

function onManualRecGoalChange() {
  manualRecSelectedTodoId = null;
  const todoEl = document.getElementById('manualRecTodo');
  if (todoEl) todoEl.value = '';
  // Targeted DOM update
  const container = document.getElementById('manualRecTodoContainer');
  if (container) container.outerHTML = `<span id="manualRecTodoContainer">${renderManualTodoSelector(null, null)}</span>`;
}

function saveManualRecord() {
  const dateEl = document.getElementById('manualRecDate');
  const startEl = document.getElementById('manualRecStart');
  const endEl = document.getElementById('manualRecEnd');
  const todoEl = document.getElementById('manualRecTodo');
  const goalEl = document.getElementById('manualRecGoal');
  const affectsEl = document.getElementById('manualRecAffectsFocus');

  if (!dateEl || !startEl || !endEl) return;

  const dateStr = dateEl.value;
  const startStr = startEl.value;
  const endStr = endEl.value;

  if (!dateStr || !startStr || !endStr) return;

  // Parse times
  const [sh, sm] = startStr.split(':').map(Number);
  const [eh, em] = endStr.split(':').map(Number);
  const dateParts = dateStr.split('-').map(Number);
  const startTs = new Date(dateParts[0], dateParts[1] - 1, dateParts[2], sh, sm).getTime();
  let endTs = new Date(dateParts[0], dateParts[1] - 1, dateParts[2], eh, em).getTime();

  // If end is before start, assume next day
  if (endTs <= startTs) endTs += 86400000;

  const totalMs = endTs - startTs;
  if (totalMs < 1000) return; // at least 1 second

  const todoId = todoEl ? parseInt(todoEl.value) || null : null;
  const goalId = goalEl ? parseInt(goalEl.value) || null : null;
  const affectsFocus = affectsEl ? affectsEl.checked : true;

  // Determine target
  let targetId = null, targetType = null;
  if (todoId) { targetId = todoId; targetType = 'todo'; }
  else if (goalId) { targetId = goalId; targetType = 'goal'; }

  const records = loadTimerRecords();

  if (timerEditingRecordId !== null) {
    // Edit mode: replace existing record
    const idx = records.findIndex(r => r.id === timerEditingRecordId);
    if (idx >= 0) {
      records[idx] = {
        ...records[idx],
        targetId, targetType,
        date: dateStr, totalMs,
        sessions: [{ start: startTs, end: endTs }],
        affectsFocus, manual: true
      };
    }
  } else {
    // Add mode
    records.push({
      id: genTimerRecordId(),
      targetId, targetType,
      date: dateStr, totalMs,
      sessions: [{ start: startTs, end: endTs }],
      affectsFocus, manual: true
    });
  }

  saveTimerRecords(records);
  timerManualFormOpen = false;
  timerEditingRecordId = null;
  manualRecSelectedTodoId = null;
  renderTimer();
}

function editTimerRecord(recordId) {
  timerEditingRecordId = recordId;
  timerManualFormOpen = true;
  renderTimer();
}

function deleteTimerRecord(recordId) {
  const records = loadTimerRecords();
  const rec = records.find(r => r.id === recordId);
  if (!rec) return;

  let name = '记录';
  if (rec.targetType === 'goal') {
    const goal = loadGoals().find(g => g.id === rec.targetId);
    if (goal) name = '目标「' + goal.text + '」';
  } else if (rec.targetType === 'todo' || rec.todoId) {
    const todo = findTodo(rec.targetId || rec.todoId);
    if (todo) name = '待办「' + todo.text + '」';
  }

  if (typeof showCustomConfirm === 'function') {
    showCustomConfirm(
      `确定要删除 ${name} 的计时记录吗？\n时长：${formatTimerTime(rec.totalMs)}，此操作不可撤销。`
    ).then(confirmed => {
      if (!confirmed) return;
      const remaining = records.filter(r => r.id !== recordId);
      saveTimerRecords(remaining);
      renderTimer();
    });
  } else {
    if (confirm(`确定要删除 ${name} 的计时记录吗？时长：${formatTimerTime(rec.totalMs)}`)) {
      const remaining = records.filter(r => r.id !== recordId);
      saveTimerRecords(remaining);
      renderTimer();
    }
  }
}

// Restore timer state on page load (survives refresh / window close)
loadAndRestoreTimerState();
