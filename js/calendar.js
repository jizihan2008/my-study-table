// ═══════════ Calendar View ═══════════
// Shows a monthly calendar with todo due dates, completion dates, and events

let calendarCurrentDate = new Date(); // The month/year being viewed
let calendarSelectedDate = null; // The specific day selected (YYYY-MM-DD)
let calendarEditingEventId = null; // Track which event is being edited in modal

// Week day headers
const CALENDAR_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

// ── Calendar Events Data Layer ──
const CAL_EVENT_COLORS = [
  { key: 'red',    bg: '#ef4444', dot: '#ef4444', bgLight: 'rgba(239,68,68,0.12)' },
  { key: 'orange', bg: '#f97316', dot: '#f97316', bgLight: 'rgba(249,115,22,0.12)' },
  { key: 'amber',  bg: '#f59e0b', dot: '#f59e0b', bgLight: 'rgba(245,158,11,0.12)' },
  { key: 'green',  bg: '#10b981', dot: '#10b981', bgLight: 'rgba(16,185,129,0.12)' },
  { key: 'blue',   bg: '#4f6ef7', dot: '#4f6ef7', bgLight: 'rgba(79,110,247,0.12)' },
  { key: 'purple', bg: '#8b5cf6', dot: '#8b5cf6', bgLight: 'rgba(139,92,246,0.12)' },
  { key: 'pink',   bg: '#ec4899', dot: '#ec4899', bgLight: 'rgba(236,72,153,0.12)' },
  { key: 'teal',   bg: '#14b8a6', dot: '#14b8a6', bgLight: 'rgba(20,184,166,0.12)' },
];

function loadCalendarEvents() {
  try {
    return JSON.parse(localStorage.getItem('calendar_events') || '[]');
  } catch { return []; }
}

function saveCalendarEvents(events) {
  localStorage.setItem('calendar_events', JSON.stringify(events));
}

function getCalColor(key) {
  return CAL_EVENT_COLORS.find(c => c.key === key) || CAL_EVENT_COLORS[4]; // default blue
}

function addCalendarEvent(date, title, time, color, note) {
  const events = loadCalendarEvents();
  const now = Date.now();
  events.push({
    id: now,
    date,
    title: title.trim(),
    time: time || '',
    color: color || 'blue',
    note: note || '',
    createdAt: now
  });
  saveCalendarEvents(events);
  return now;
}

function updateCalendarEvent(id, updates) {
  const events = loadCalendarEvents();
  const idx = events.findIndex(e => e.id === id);
  if (idx === -1) return false;
  if (updates.title !== undefined) events[idx].title = updates.title.trim();
  if (updates.time !== undefined) events[idx].time = updates.time;
  if (updates.color !== undefined) events[idx].color = updates.color;
  if (updates.note !== undefined) events[idx].note = updates.note;
  saveCalendarEvents(events);
  return true;
}

function deleteCalendarEvent(id) {
  let events = loadCalendarEvents();
  events = events.filter(e => e.id !== id);
  saveCalendarEvents(events);
}

function getTimerTotalForDate(dateStr, records) {
  let totalMs = 0;
  try {
    if (!records) records = JSON.parse(localStorage.getItem('study_timer_records') || '[]');
    for (const rec of records) {
      if (rec.date === dateStr) totalMs += rec.totalMs;
    }
  } catch {}
  return totalMs;
}

function getTimerSessionsForDate(dateStr) {
  const sessions = [];
  try {
    const records = JSON.parse(localStorage.getItem('study_timer_records') || '[]');
    for (const rec of records) {
      if (rec.date === dateStr && rec.sessions) {
        for (const s of rec.sessions) {
          // Support both new (targetId + targetType) and old (todoId) formats
          const tid = (rec.targetType === 'todo' && rec.targetId) ? rec.targetId : rec.todoId;
          const todo = tid ? findTodo(tid) : null;
          sessions.push({ ...s, todoName: todo ? todo.text : '(自由计时)' });
        }
      }
    }
  } catch {}
  return sessions;
}

function formatTimerShort(ms) {
  if (ms < 60000) return '';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

function formatTimerFull(ms) {
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

function renderCalendar() {
  const year = calendarCurrentDate.getFullYear();
  const month = calendarCurrentDate.getMonth();

  // Update title
  document.getElementById('calendarTitle').textContent = `${year}年 ${month + 1}月`;

  // Build date grid
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startPad = firstDay.getDay(); // 0=Sun
  const totalDays = lastDay.getDate();

  // Collect todos and timer data for this month
  const todoMap = {}; // "YYYY-MM-DD" -> { due: [], completed: [], timerMs: 0 }
  const todayStr = formatDate(new Date());
  // Yesterday's date string for comparison
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterdayStr = formatDate(yesterdayDate);
  for (const t of todos) {
    if (t.dueDate) {
      // Skip completed todos whose due date is yesterday or earlier
      if (t.done && t.dueDate <= yesterdayStr) {
        // Still count this todo in completedAt below; just skip the due badge
      } else {
        const d = t.dueDate;
        if (d >= `${year}-${String(month+1).padStart(2,'0')}-01` && d <= `${year}-${String(month+1).padStart(2,'0')}-${String(totalDays).padStart(2,'0')}`) {
          if (!todoMap[d]) todoMap[d] = { due: [], completed: [], timerMs: 0, events: [] };
          todoMap[d].due.push(t);
        }
      }
    }
    if (t.completedAt) {
      const d = t.completedAt;
      if (d >= `${year}-${String(month+1).padStart(2,'0')}-01` && d <= `${year}-${String(month+1).padStart(2,'0')}-${String(totalDays).padStart(2,'0')}`) {
        if (!todoMap[d]) todoMap[d] = { due: [], completed: [], timerMs: 0, events: [] };
        todoMap[d].completed.push(t);
      }
    }
  }
  // Include completed log records
  const completedLog = loadTodoCompletedLog();
  for (const rec of completedLog) {
    const d = rec.completedAt;
    if (d >= `${year}-${String(month+1).padStart(2,'0')}-01` && d <= `${year}-${String(month+1).padStart(2,'0')}-${String(totalDays).padStart(2,'0')}`) {
      if (!todoMap[d]) todoMap[d] = { due: [], completed: [], timerMs: 0, events: [] };
      todoMap[d].completed.push(rec);
    }
  }
  // Include timer records for each day of this month
  for (let d = 1; d <= totalDays; d++) {
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const timerMs = getTimerTotalForDate(dateStr);
    if (timerMs > 0) {
      if (!todoMap[dateStr]) todoMap[dateStr] = { due: [], completed: [], timerMs: 0, events: [] };
      todoMap[dateStr].timerMs = timerMs;
    }
  }
  // Load calendar events for this month
  const calEvents = loadCalendarEvents();
  const eventsByDate = {};
  for (const ev of calEvents) {
    if (ev.date >= `${year}-${String(month+1).padStart(2,'0')}-01` &&
        ev.date <= `${year}-${String(month+1).padStart(2,'0')}-${String(totalDays).padStart(2,'0')}`) {
      if (!eventsByDate[ev.date]) eventsByDate[ev.date] = [];
      eventsByDate[ev.date].push(ev);
      if (!todoMap[ev.date]) todoMap[ev.date] = { due: [], completed: [], timerMs: 0, events: [] };
      todoMap[ev.date].events.push(ev);
    }
  }

  const grid = document.getElementById('calendarGrid');

  let html = '';
  // Weekday headers
  for (const wd of CALENDAR_WEEKDAYS) {
    html += `<div class="cal-weekday">${wd}</div>`;
  }
  // Empty cells before first day
  for (let i = 0; i < startPad; i++) {
    html += `<div class="cal-day cal-day-empty"></div>`;
  }
  // Day cells
  for (let d = 1; d <= totalDays; d++) {
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isToday = dateStr === todayStr;
    const isSelected = dateStr === calendarSelectedDate;
    const data = todoMap[dateStr];
    const hasDue = data && data.due.length > 0;
    const hasCompleted = data && data.completed.length > 0;
    const hasTimer = data && data.timerMs > 0;
    // Review count for this date（复用整月构建的映射）
    const reviewCount = (reviewDateMap[dateStr] || []).length;

    let classes = 'cal-day';
    if (isToday) classes += ' cal-today';
    if (isSelected) classes += ' cal-selected';
    if (hasDue) classes += ' cal-has-due';
    if (hasCompleted) classes += ' cal-has-completed';
    if (hasTimer) classes += ' cal-has-timer';
    if (reviewCount > 0) classes += ' cal-has-review';

    let badgeHtml = '';
    // Event dots (max 4, then +N)
    const dayEvents = eventsByDate[dateStr] || [];
    if (dayEvents.length > 0) {
      const showEvents = dayEvents.slice(0, 4);
      for (const ev of showEvents) {
        const c = getCalColor(ev.color);
        badgeHtml += `<span class="cal-event-dot" style="background:${c.dot}" title="${escapeHtml(ev.title)}"></span>`;
      }
      if (dayEvents.length > 4) {
        badgeHtml += `<span class="cal-event-more">+${dayEvents.length - 4}</span>`;
      }
    }
    if (hasDue || hasCompleted || hasTimer || reviewCount > 0) {
      if (hasDue) badgeHtml += `<span class="cal-badge cal-badge-due">${data.due.length}</span>`;
      if (hasCompleted) badgeHtml += `<span class="cal-badge cal-badge-done">${data.completed.length}</span>`;
      if (reviewCount > 0) badgeHtml += `<span class="cal-badge cal-badge-review" title="${reviewCount} 篇笔记待复习">${reviewCount}</span>`;
      if (hasTimer) {
        const timerLabel = formatTimerShort(data.timerMs);
        if (timerLabel) badgeHtml += `<span class="cal-badge cal-badge-timer">⏱${timerLabel}</span>`;
      }
    }

    html += `<div class="${classes}" onclick="selectCalendarDay('${dateStr}')">
      <span class="cal-day-num">${d}</span>
      <div class="cal-day-right">${badgeHtml}</div>
    </div>`;
  }

  grid.innerHTML = html;

  // Show todos for selected date
  renderCalendarTodoList();
}

function selectCalendarDay(dateStr) {
  if (calendarSelectedDate === dateStr) {
    calendarSelectedDate = null; // Toggle off
  } else {
    calendarSelectedDate = dateStr;
  }
  renderCalendar();
}

function renderCalendarTodoList() {
  const container = document.getElementById('calendarTodoList');
  if (!calendarSelectedDate) {
    container.innerHTML = '<div class="calendar-todo-hint">点击日期查看该日的待办事项与事件</div>';
    return;
  }

  let html = `<div class="calendar-todo-date">📅 ${calendarSelectedDate}</div>`;

  // ── Calendar Events ──
  const allEvents = loadCalendarEvents();
  const dateEvents = allEvents.filter(e => e.date === calendarSelectedDate).sort((a, b) => {
    if (a.time && b.time) return a.time.localeCompare(b.time);
    if (a.time) return -1;
    if (b.time) return 1;
    return a.createdAt - b.createdAt;
  });
  if (dateEvents.length > 0) {
    html += `<div class="cal-events-section">
      <span class="calendar-todo-section-title">📌 事件 (${dateEvents.length})</span>`;
    for (const ev of dateEvents) {
      const c = getCalColor(ev.color);
      html += `<div class="cal-event-item" style="border-left-color:${c.dot}" title="${escapeHtml(ev.note || '')}">
        <span class="cal-event-bar" style="background:${c.dot}"></span>
        <span class="cal-event-title">${ev.time ? `<span class="cal-event-time">${escapeHtml(ev.time)}</span>` : ''}${escapeHtml(ev.title)}</span>
        <button class="cal-event-btn" onclick="event.stopPropagation();openCalEventModal('${calendarSelectedDate}', ${ev.id})" title="编辑">✎</button>
        <button class="cal-event-btn cal-event-del" onclick="event.stopPropagation();deleteCalendarEvent(${ev.id});renderCalendar();" title="删除">✕</button>
      </div>`;
    }
    html += `</div>`;
  }

  // Add event button
  html += `<button class="cal-add-event-btn" onclick="openCalEventModal('${calendarSelectedDate}', null)">
    <i data-lucide="plus" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle;"></i> 添加事件
  </button>`;

  const dueTodos = [];
  const completedTodos = [];
  const logTodos = []; // From completed log (deleted todos)
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterdayStr = formatDate(yesterdayDate);
  for (const t of todos) {
    if (t.dueDate === calendarSelectedDate) {
      // Skip completed todos whose due date is yesterday or earlier
      if (!(t.done && t.dueDate <= yesterdayStr)) {
        dueTodos.push(t);
      }
    }
    if (t.completedAt === calendarSelectedDate) {
      completedTodos.push(t);
    }
  }
  // Also show completed log records for this date
  const completedLog = loadTodoCompletedLog();
  for (const rec of completedLog) {
    if (rec.completedAt === calendarSelectedDate) {
      logTodos.push(rec);
    }
  }

  // Timer total for this date
  const timerMs = getTimerTotalForDate(calendarSelectedDate);

  // Review notes for this date
  const reviewNotes = typeof getReviewNotesForDate === 'function'
    ? getReviewNotesForDate(calendarSelectedDate) : [];

  if (dateEvents.length === 0 && dueTodos.length === 0 && completedTodos.length === 0 && logTodos.length === 0 && timerMs === 0 && reviewNotes.length === 0) {
    html += `<div class="calendar-todo-hint">这一天暂无安排</div>`;
    container.innerHTML = html;
    if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
    return;
  }

  if (dueTodos.length > 0) {
    html += `<div class="calendar-todo-section"><span class="calendar-todo-section-title">⏰ 截止日期</span></div>`;
    for (const t of dueTodos) {
      const text = escapeHtml(t.text);
      const doneClass = t.done ? ' cal-todo-done' : '';
      html += `<div class="calendar-todo-item${doneClass}" onclick="toggleTodo(${t.id});renderCalendar();">
        <span class="cal-todo-check${t.done ? ' done' : ''}"></span>
        <span>${text}</span>
      </div>`;
    }
  }

  if (completedTodos.length > 0) {
    html += `<div class="calendar-todo-section"><span class="calendar-todo-section-title">✅ 已完成</span></div>`;
    for (const t of completedTodos) {
      const text = escapeHtml(t.text);
      html += `<div class="calendar-todo-item cal-todo-done">
        <span class="cal-todo-check done"></span>
        <span>${text}</span>
      </div>`;
    }
  }

  // Show completed log records (from deleted todos) with delete button
  if (logTodos.length > 0) {
    html += `<div class="calendar-todo-section"><span class="calendar-todo-section-title">📜 已删除的完成记录</span></div>`;
    for (const rec of logTodos) {
      const text = escapeHtml(rec.text);
      html += `<div class="calendar-todo-item cal-todo-done">
        <span class="cal-todo-check done"></span>
        <span style="opacity:0.6;">${text}</span>
        <button class="todo-delete" onclick="event.stopPropagation(); deleteCalendarCompletedLog(${rec.id})" title="删除此完成记录">✕</button>
      </div>`;
    }
  }

  // Show timer total and sessions for this date
  if (timerMs > 0) {
    html += `<div class="calendar-todo-section" style="margin-top:8px;">
      <span class="calendar-todo-section-title">⏱️ 计时（共 ${formatTimerFull(timerMs)}）</span>`;
    const sessions = getTimerSessionsForDate(calendarSelectedDate);
    sessions.sort((a, b) => a.start - b.start);
    for (const s of sessions) {
      const name = escapeHtml(s.todoName);
      const dur = formatTimerFull(s.end - s.start);
      html += `<div class="calendar-todo-item" style="cursor:default;font-size:12px;">
        <span style="flex:1;">${formatTimeOnly(s.start)} — ${formatTimeOnly(s.end)}</span>
        <span style="color:var(--text-secondary);margin:0 8px;">${dur}</span>
        <span style="color:var(--text-secondary);opacity:0.7;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name}</span>
      </div>`;
    }
    html += `</div>`;
  }

  // Review notes for this date
  if (reviewNotes.length > 0) {
    html += `<div class="cal-section-title"><i data-lucide="book-open" class="lucide-icon cal-sec-icon"></i> 待复习 (${reviewNotes.length})</div>`;
    html += `<div class="cal-review-list">`;
    for (const rn of reviewNotes) {
      const badgeClass = rn.isOverdue ? 'cal-review-badge-overdue' : 'cal-review-badge';
      const label = rn.isNext ? `第${rn.reviewCount}轮` : `第${rn.reviewCount}轮（未来）`;
      html += `<div class="cal-review-item" data-note-id="${escapeHtml(rn.id)}" onclick="selectNote('${escapeHtml(rn.id)}');switchTab('notes');" title="点击跳转到笔记">
        <span class="cal-review-title">${escapeHtml(rn.title)}</span>
        <span class="cal-review-info">
          <span class="${badgeClass}">${label}</span>
        </span>
      </div>`;
    }
    html += `</div>`;
  }

  container.innerHTML = html;
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}

function deleteCalendarCompletedLog(id) {
  let log = loadTodoCompletedLog();
  log = log.filter(rec => rec.id !== id);
  saveTodoCompletedLog(log);
  renderCalendar();
}

function calendarPrevMonth() {
  calendarCurrentDate.setMonth(calendarCurrentDate.getMonth() - 1);
  calendarSelectedDate = null;
  renderCalendar();
}

function calendarNextMonth() {
  calendarCurrentDate.setMonth(calendarCurrentDate.getMonth() + 1);
  calendarSelectedDate = null;
  renderCalendar();
}

function calendarGoToday() {
  calendarCurrentDate = new Date();
  calendarSelectedDate = formatDate(new Date());
  renderCalendar();
}

// ── Calendar Event Modal ──
function openCalEventModal(dateStr, eventId) {
  calendarEditingEventId = eventId;
  const overlay = document.getElementById('calEventModal');
  const titleInput = document.getElementById('calEventTitle');
  const timeInput = document.getElementById('calEventTime');
  const noteInput = document.getElementById('calEventNote');
  const dateLabel = document.getElementById('calEventDateLabel');
  const modalTitle = document.getElementById('calEventModalTitle');
  const deleteBtn = document.getElementById('calEventDeleteBtn');

  dateLabel.textContent = dateStr;
  if (eventId) {
    // Edit existing event
    modalTitle.textContent = '编辑事件';
    deleteBtn.style.display = 'inline-flex';
    const events = loadCalendarEvents();
    const ev = events.find(e => e.id === eventId);
    if (ev) {
      titleInput.value = ev.title;
      timeInput.value = ev.time;
      noteInput.value = ev.note || '';
      // Select the color
      const colorRadios = document.getElementsByName('calEventColor');
      for (const r of colorRadios) {
        r.checked = r.value === ev.color;
      }
    }
  } else {
    // New event
    modalTitle.textContent = '添加事件';
    deleteBtn.style.display = 'none';
    titleInput.value = '';
    timeInput.value = '';
    noteInput.value = '';
    const colorRadios = document.getElementsByName('calEventColor');
    for (const r of colorRadios) {
      r.checked = r.value === 'blue';
    }
  }

  overlay.classList.add('open');
  setTimeout(() => titleInput.focus(), 100);
}

function closeCalEventModal() {
  document.getElementById('calEventModal').classList.remove('open');
  calendarEditingEventId = null;
}

function deleteCalEventFromModal() {
  if (calendarEditingEventId) {
    deleteCalendarEvent(calendarEditingEventId);
    renderCalendar();
  }
  closeCalEventModal();
}

function submitCalEvent() {
  const titleInput = document.getElementById('calEventTitle');
  const timeInput = document.getElementById('calEventTime');
  const noteInput = document.getElementById('calEventNote');
  const dateLabel = document.getElementById('calEventDateLabel');

  const title = titleInput.value.trim();
  if (!title) { titleInput.focus(); return; }

  const colorRadios = document.getElementsByName('calEventColor');
  let color = 'blue';
  for (const r of colorRadios) {
    if (r.checked) { color = r.value; break; }
  }

  if (calendarEditingEventId) {
    updateCalendarEvent(calendarEditingEventId, {
      title, time: timeInput.value.trim(), color, note: noteInput.value.trim()
    });
  } else {
    addCalendarEvent(dateLabel.textContent, title, timeInput.value.trim(), color, noteInput.value.trim());
  }

  renderCalendar();
  closeCalEventModal();
}
