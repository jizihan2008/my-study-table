// ═══════════ Calendar View ═══════════
// Shows a monthly calendar with todo due dates, completion dates, and events

let calendarCurrentDate = new Date(); // The month/year being viewed
let calendarSelectedDate = formatDate(new Date()); // The specific day selected (YYYY-MM-DD)，默认选中今天
let calendarEditingEventId = null; // Track which event is being edited in modal
let calendarCtxEventId = null; // 右键菜单当前指向的事件
let calendarCtxEventDate = null; // 右键菜单当前指向的日期（用于「仅删除这一天」）

// Week day headers
const CALENDAR_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const CALENDAR_STORAGE_KEY = 'study_calendar_events';
const LEGACY_CALENDAR_STORAGE_KEY = 'calendar_events';

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
    const current = localStorage.getItem(CALENDAR_STORAGE_KEY);
    if (current !== null) return JSON.parse(current || '[]');
    const legacy = JSON.parse(localStorage.getItem(LEGACY_CALENDAR_STORAGE_KEY) || '[]');
    if (Array.isArray(legacy) && legacy.length) saveCalendarEvents(legacy);
    return Array.isArray(legacy) ? legacy : [];
  } catch { return []; }
}

function saveCalendarEvents(events) {
  if (typeof saveData === 'function') saveData(CALENDAR_STORAGE_KEY, events);
  else localStorage.setItem(CALENDAR_STORAGE_KEY, JSON.stringify(events));
}

function getCalColor(key) {
  return CAL_EVENT_COLORS.find(c => c.key === key) || CAL_EVENT_COLORS[4]; // default blue
}

function addCalendarEvent(date, title, time, color, note, times, auto) {
  const events = loadCalendarEvents();
  const now = Date.now();
  const startTime = normalizeCalTime((times && times.start) || time);
  const repeat = (times && times.repeat === 'weekly') ? 'weekly' : 'none';
  const weekdays = repeat === 'weekly'
    ? (normalizeCalWeekdays(times && times.weekdays).length > 0
      ? normalizeCalWeekdays(times.weekdays)
      : (() => { const d = parseCalDate(date); return d ? [d.getDay()] : []; })())
    : [];
  const allDay = !!(times && times.allDay);
  const endDate = normalizeCalDate(times && times.endDate) || date;
  events.push({
    id: typeof genId === 'function' ? genId() : now,
    date,
    title: title.trim(),
    time: allDay ? '' : startTime,
    startTime: allDay ? '' : startTime,
    endTime: allDay ? '' : normalizeCalTime(times && times.end),
    endDate: endDate < date ? date : endDate,
    allDay,
    color: color || 'blue',
    note: note || '',
    repeat,
    weekdays,
    skippedDates: [],
    autoRecord: !!(auto && auto.autoRecord),
    autoTimer: auto ? auto.autoTimer !== false : false,
    createdAt: now
  });
  saveCalendarEvents(events);
  return now;
}

function updateCalendarEvent(id, updates) {
  const events = loadCalendarEvents();
  const idx = events.findIndex(e => e.id === id);
  if (idx === -1) return false;
  const ev = events[idx];
  if (updates.title !== undefined) ev.title = updates.title.trim();
  if (updates.color !== undefined) ev.color = updates.color;
  if (updates.note !== undefined) ev.note = updates.note;
  if (updates.allDay !== undefined) {
    ev.allDay = !!updates.allDay;
    if (ev.allDay) { ev.time = ''; ev.startTime = ''; ev.endTime = ''; ev.autoRecord = false; }
  }
  if (updates.endDate !== undefined) {
    const startDate = normalizeCalDate(updates.date) || ev.date;
    const nextEndDate = normalizeCalDate(updates.endDate) || startDate;
    ev.endDate = nextEndDate < startDate ? startDate : nextEndDate;
    ev.lastAutoRecordEnd = 0;
  }
  // 日期变更（重复事件的起点）等同于换了一整个系列，清空跳过列表与记账水位
  if (updates.date !== undefined && updates.date !== ev.date) {
    ev.date = updates.date;
    ev.skippedDates = [];
    ev.lastAutoRecordEnd = 0;
    // 旧数据（没有 weekdays）改日期时，星期几跟着新的日期走
    if (isCalEventRecurring(ev) && normalizeCalWeekdays(ev.weekdays).length === 0) {
      const anchor = parseCalDate(updates.date);
      if (anchor) ev.weekdays = [anchor.getDay()];
    }
  }
  if (updates.repeat !== undefined) {
    const nextRepeat = updates.repeat === 'weekly' ? 'weekly' : 'none';
    if (nextRepeat !== (ev.repeat || 'none')) {
      ev.repeat = nextRepeat;
      ev.skippedDates = [];
      ev.lastAutoRecordEnd = 0;
      if (nextRepeat === 'weekly' && normalizeCalWeekdays(ev.weekdays).length === 0) {
        const anchor = parseCalDate(ev.date);
        ev.weekdays = anchor ? [anchor.getDay()] : [];
      }
      if (nextRepeat !== 'weekly') ev.weekdays = [];
    }
  }
  if (updates.weekdays !== undefined) {
    const nextDays = normalizeCalWeekdays(updates.weekdays);
    const prevDays = normalizeCalWeekdays(ev.weekdays);
    if (nextDays.join(',') !== prevDays.join(',')) {
      ev.weekdays = nextDays;
      // 星期几变了：之前跳过的那些日子不再对应当前的系列
      ev.skippedDates = [];
      ev.lastAutoRecordEnd = 0;
    }
  }
  // 时间点 / 时间段：startTime 是权威字段，time 同步保留以兼容旧数据与旧界面
  if (updates.time !== undefined || updates.startTime !== undefined) {
    const next = normalizeCalTime(updates.startTime !== undefined ? updates.startTime : updates.time);
    if (next !== (ev.startTime || ev.time || '')) ev.lastAutoRecordEnd = 0; // 时段变了 → 允许重新记账
    ev.time = next;
    ev.startTime = next;
  }
  if (updates.endTime !== undefined) {
    const nextEnd = normalizeCalTime(updates.endTime);
    if (nextEnd !== (ev.endTime || '')) ev.lastAutoRecordEnd = 0;
    ev.endTime = nextEnd;
  }
  if (updates.autoRecord !== undefined) ev.autoRecord = !!updates.autoRecord;
  if (updates.autoTimer !== undefined) ev.autoTimer = !!updates.autoTimer;
  // 关掉自动计入后清掉记账水位，重新开启时按当前时段重新判定
  if (ev.allDay) ev.autoRecord = false;
  if (ev.autoRecord !== true) ev.lastAutoRecordEnd = 0;
  saveCalendarEvents(events);
  return true;
}

function deleteCalendarEvent(id) {
  let events = loadCalendarEvents();
  events = events.filter(e => e.id !== id);
  saveCalendarEvents(events);
  // 事件可能已经排过自动记账巡检，删除后重新评估是否需要继续巡检
  if (typeof ensureAutomationTimer === 'function') ensureAutomationTimer();
}

// ── Calendar Event Time Range ──
// 事件时间字段：startTime（权威）+ endTime（可选）。time 为旧字段，读取时由 startTime 兜底。
// 自动记账水位 lastAutoRecordEnd 记录「已经补过账的时段结束时间戳」，避免重复写入计时记录。

function normalizeCalTime(value) {
  const m = /^\s*(\d{1,2}):(\d{2})/.exec(String(value == null ? '' : value));
  if (!m) return '';
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return '';
  return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
}

function normalizeCalDate(value) {
  const text = String(value == null ? '' : value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? text : '';
}

function calDateOffset(dateStr, days) {
  const d = parseCalDate(dateStr);
  if (!d) return '';
  d.setDate(d.getDate() + Number(days || 0));
  return _formatCalAutoDate(d.getTime());
}

function getCalEventDurationDays(ev) {
  const start = parseCalDate(ev && ev.date);
  const end = parseCalDate(ev && ev.endDate);
  if (!start || !end || end < start) return 0;
  return Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
}

function getCalEventStartTime(ev) {
  return normalizeCalTime(ev && (ev.startTime || ev.time));
}

function getCalEventTimeRange(ev) {
  const start = getCalEventStartTime(ev);
  const end = normalizeCalTime(ev && ev.endTime);
  if (!start) return end ? { start: '', end } : null;
  return { start, end: end || '' };
}

function formatCalEventTimeRange(ev, separator) {
  if (ev && ev.allDay) return '全天';
  const range = getCalEventTimeRange(ev);
  if (!range) return '';
  if (!range.end) return range.start;
  return range.start + (separator || '—') + range.end;
}

// ── 每周重复 ──
// 重复事件自己选星期几（weekdays，0=周日 … 6=周六）：命中的星期几每周都会出现。
// 开始日期 date 所在的那一周整周都算起点（例如选 1/4 周日 + 周一，1/5 就会开始出现）。
// 兼容旧数据：只有 repeat:'weekly' 没有 weekdays 时，按 date 的星期几处理。
// skippedDates 记录被单独删掉的那几天（保持幂等，可随时恢复整个系列）。
const CAL_WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function isCalEventRecurring(ev) {
  return !!ev && ev.repeat === 'weekly';
}

function normalizeCalWeekdays(value) {
  if (!Array.isArray(value)) return [];
  const set = new Set();
  for (const item of value) {
    const day = Number(item);
    if (Number.isInteger(day) && day >= 0 && day <= 6) set.add(day);
  }
  return [...set].sort((a, b) => a - b);
}

function getCalEventWeekdays(ev) {
  const explicit = normalizeCalWeekdays(ev && ev.weekdays);
  if (explicit.length > 0) return explicit;
  // 旧数据 / 没有选星期几：退回「开始日期是星期几」
  const anchor = parseCalDate(ev && ev.date);
  return anchor ? [anchor.getDay()] : [];
}

function formatCalWeekdays(weekdays) {
  const days = normalizeCalWeekdays(weekdays);
  if (days.length === 7) return '每天';
  return days.map(day => CAL_WEEKDAY_CN[day]).join('、');
}

// 带「每周」前缀的完整说明（如「每周四、周五」「每周四」「每天」），供提示文案使用
function formatCalRepeatText(weekdays) {
  const days = normalizeCalWeekdays(weekdays);
  if (days.length === 0) return '';
  if (days.length === 7) return '每天';
  const names = days.map(day => CAL_WEEKDAY_CN[day]);
  // 只有一天时直接用「每周四」；多天时后续的「周」可以省略，读起来更自然
  if (names.length === 1) return '每' + names[0];
  return '每' + names[0] + '、' + names.slice(1).map(name => name.slice(1)).join('、');
}

function isCalEventSkippedOn(ev, dateStr) {
  if (!ev || !Array.isArray(ev.skippedDates) || ev.skippedDates.length === 0) return false;
  return ev.skippedDates.indexOf(dateStr) !== -1;
}

// 重复事件在指定日期是否出现（纯判定，便于回归测试）
function isCalEventOnDate(ev, dateStr) {
  if (!ev || !dateStr) return false;
  const durationDays = getCalEventDurationDays(ev);
  if (!isCalEventRecurring(ev)) return dateStr >= ev.date && dateStr <= (ev.endDate || ev.date);
  for (let offset = 0; offset <= durationDays; offset++) {
    const occurrenceDate = calDateOffset(dateStr, -offset);
    if (occurrenceDate && !isCalEventSkippedOn(ev, occurrenceDate) && isCalEventSeriesDate(ev, occurrenceDate)) return true;
  }
  return false;
}

function parseCalDate(dateStr) {
  const parts = String(dateStr || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

// 某一天要显示的事件（重复事件展开）
function getCalendarEventsOnDate(dateStr, events) {
  const list = Array.isArray(events) ? events : loadCalendarEvents();
  return list.filter(ev => isCalEventOnDate(ev, dateStr)).sort((a, b) => {
    const at = getCalEventStartTime(a);
    const bt = getCalEventStartTime(b);
    if (at && bt) return at.localeCompare(bt);
    if (at) return -1;
    if (bt) return 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

// 「每周一、周三、周五」这样的重复说明；非重复事件返回空串
function calEventRepeatLabel(ev) {
  if (!isCalEventRecurring(ev)) return '';
  return formatCalRepeatText(getCalEventWeekdays(ev));
}


// 该日期本来是否属于这个重复系列（不考虑跳过列表），用于区分「跳过的场次」与「本来就没有」
function isCalEventSeriesDate(ev, dateStr) {
  if (!isCalEventRecurring(ev) || !dateStr) return false;
  const weekdays = getCalEventWeekdays(ev);
  if (weekdays.length === 0) return false;
  const target = parseCalDate(dateStr);
  const anchor = parseCalDate(ev.date);
  if (!target || !anchor) return false;
  if (!weekdays.includes(target.getDay())) return false;
  // 起点：开始日期所在那一周的周日（整周都算起点）
  const weekStart = new Date(anchor);
  weekStart.setDate(anchor.getDate() - anchor.getDay());
  return target.getTime() >= weekStart.getTime();
}

// 删除重复事件的某一天：只把这一天加入跳过列表，其余日期保留
function skipCalendarEventDate(eventId, dateStr) {
  const events = loadCalendarEvents();
  const ev = events.find(e => e.id === eventId);
  if (!ev || !isCalEventRecurring(ev)) return false;
  if (!Array.isArray(ev.skippedDates)) ev.skippedDates = [];
  if (ev.skippedDates.indexOf(dateStr) === -1) ev.skippedDates.push(dateStr);
  // 水位只前进不回退：否则会重复补写同一周更早那些已经记过的时段
  saveCalendarEvents(events);
  if (typeof renderCalendar === 'function' && document.getElementById('calendarGrid')) renderCalendar();
  return true;
}

// 恢复被单独删除的那一天（保留整个系列，只撤销这一次跳过）
function restoreCalendarEventDate(eventId, dateStr) {
  const events = loadCalendarEvents();
  const ev = events.find(e => e.id === eventId);
  if (!ev || !Array.isArray(ev.skippedDates)) return false;
  ev.skippedDates = ev.skippedDates.filter(d => d !== dateStr);
  saveCalendarEvents(events);
  if (typeof renderCalendar === 'function' && document.getElementById('calendarGrid')) renderCalendar();
  return true;
}

// 时段跨天时（结束时间早于或等于开始时间）结束时间顺延到次日
function resolveCalEventRange(ev, dateStr) {
  if (ev && ev.allDay) return null;
  const startTime = getCalEventStartTime(ev);
  if (!startTime) return null;
  const parts = String(dateStr || ev.date || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;
  const [sh, sm] = startTime.split(':').map(Number);
  const startTs = new Date(parts[0], parts[1] - 1, parts[2], sh, sm, 0, 0).getTime();
  const endTime = normalizeCalTime(ev.endTime);
  if (!endTime) return { startTs, endTs: startTs, startTime, endTime: '', crossDay: false, hasEnd: false };
  const [eh, em] = endTime.split(':').map(Number);
  const explicitEndDate = normalizeCalDate(ev.endDate);
  const occurrenceEndDate = explicitEndDate ? calDateOffset(dateStr || ev.date, getCalEventDurationDays(ev)) : '';
  const endParts = occurrenceEndDate ? occurrenceEndDate.split('-').map(Number) : parts;
  let endTs = new Date(endParts[0], endParts[1] - 1, endParts[2], eh, em, 0, 0).getTime();
  const crossDay = endParts.join('-') !== parts.join('-') || endTs <= startTs;
  // 兼容旧的“结束时间早于开始时间 = 次日”语义；新表单也会显式保存结束日期。
  if (endTs <= startTs) endTs += 24 * 60 * 60 * 1000;
  return { startTs, endTs, startTime, endTime, crossDay, hasEnd: true };
}

// 事件结束时间晚于水位时，水位向前推进（水位只前进，避免重复补写更早的场次）
function _advanceCalAutoWatermark(ev, endTs) {
  if (endTs > (ev.lastAutoRecordEnd || 0)) ev.lastAutoRecordEnd = endTs;
}

// 生成「需要自动记账」的具体场次；重复事件按所选星期几展开，
// 只补最近 7 天窗口内的场次（不会把很久以前的旧账一次性补出来）
function getCalEventDueOccurrences(ev, now) {
  if (!ev || ev.autoRecord !== true) return [];
  const baseRange = resolveCalEventRange(ev);
  if (!baseRange || !baseRange.hasEnd) return [];
  const ref = Number.isFinite(now) ? now : Date.now();
  const windowMs = 7 * 24 * 60 * 60 * 1000;
  const watermark = ev.lastAutoRecordEnd || 0;

  if (!isCalEventRecurring(ev)) {
    if (baseRange.endTs > ref) return [];
    if (baseRange.endTs <= watermark) return [];
    if (ref - baseRange.endTs > windowMs) return [];
    return [{ dateStr: ev.date, range: baseRange }];
  }

  const due = [];
  const take = (dayStr) => {
    if (isCalEventSkippedOn(ev, dayStr)) return;        // 被单独删掉的那一天
    const range = resolveCalEventRange(ev, dayStr);
    if (!range || !range.hasEnd) return;
    if (range.endTs > ref) return;                       // 还没结束
    if (range.endTs <= watermark) return;                // 已处理过
    due.push({ dateStr: dayStr, range });
  };
  // 回看 7 天（含今天）：多星期几的重复事件会在这里逐天命中
  for (let back = 6; back >= 0; back--) {
    const dayStr = _formatCalAutoDate(ref - back * 24 * 60 * 60 * 1000);
    if (isCalEventOnDate(ev, dayStr)) take(dayStr);
  }
  // 兜底：今天命中但被上面的回看遍历漏掉时（夏令时/跨月边界）再补一次
  const todayStr = _formatCalAutoDate(ref);
  if (isCalEventOnDate(ev, todayStr) && !due.some(item => item.dateStr === todayStr)) take(todayStr);
  return due;
}

// 事件是否需要自动补写一条计时记录（纯判定，不写盘，便于回归测试）
function shouldAutoRecordCalEvent(ev, now) {
  return getCalEventDueOccurrences(ev, now).length > 0;
}

// 是否已经存在这一场的计时记录（按来源事件 + 结束时间判定，天然幂等）
function hasTimerRecordForOccurrence(records, eventId, endTs) {
  if (!Array.isArray(records)) return false;
  return records.some(r => r && r.sourceEventId === eventId && r.sessions &&
    r.sessions.some(s => s && s.end === endTs));
}

// 是否有待补写的自动记账事件（供设置页决定是否启动自动巡检）
function hasPendingCalendarAutoRecords(now) {
  if (typeof loadCalendarEvents !== 'function') return false;
  const ref = Number.isFinite(now) ? now : Date.now();
  try {
    return loadCalendarEvents().some(ev => shouldAutoRecordCalEvent(ev, ref));
  } catch (e) { return false; }
}

function _formatCalAutoDate(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// 事件时段结束后自动补一条计时记录：计入当天累计与日历角标；
// autoTimer 关闭时 affectsFocus = false（不计入专注统计，历史记录显示 ⚡ 徽章）
function runCalendarAutoRecords(now) {
  if (typeof loadCalendarEvents !== 'function' || typeof saveTimerRecords !== 'function') return 0;
  const ref = Number.isFinite(now) ? now : Date.now();
  let events;
  try { events = loadCalendarEvents(); } catch (e) { return 0; }
  if (!Array.isArray(events) || events.length === 0) return 0;
  if (typeof loadTimerRecords !== 'function' || typeof genTimerRecordId !== 'function') return 0;

  const records = loadTimerRecords();
  const created = [];
  let touched = false; // 是否有事件水位前进（含不足 1 分钟不记账的时段）
  for (const ev of events) {
    const due = getCalEventDueOccurrences(ev, ref);
    if (due.length === 0) continue;
    for (const item of due) {
      const totalMs = item.range.endTs - item.range.startTs;
      _advanceCalAutoWatermark(ev, item.range.endTs);
      touched = true;
      // 已经记过（跨刷新幂等）/ 不足 1 分钟：只推进水位，不重复写入
      if (totalMs < 60000) continue;
      if (hasTimerRecordForOccurrence(records, ev.id, item.range.endTs)) continue;
      records.push({
        id: genTimerRecordId(),
        name: String(ev.title || '').slice(0, 80),
        targetId: null,
        targetType: null,
        date: _formatCalAutoDate(item.range.endTs),
        totalMs,
        sessions: [{ start: item.range.startTs, end: item.range.endTs }],
        affectsFocus: ev.autoTimer !== false,
        manual: false,
        auto: true,
        sourceEventId: ev.id,
        sourceEventDate: item.dateStr
      });
      created.push({
        title: String(ev.title || ''),
        dateStr: _formatCalAutoDate(item.range.endTs),
        totalMs,
        eventId: ev.id,
        endTs: item.range.endTs
      });
    }
  }
  if (!touched) return 0;

  if (created.length > 0) saveTimerRecords(records);
  try { saveCalendarEvents(events); } catch (e) { console.warn('[Calendar] 自动记账水位保存失败:', e); }
  if (created.length === 0) return 0;
  if (typeof renderTimer === 'function') { try { renderTimer(); } catch (e) {} }
  if (typeof sendNotification === 'function') {
    for (const item of created) {
      sendNotification(
        '⏱ 日历事件已计入计时',
        `「${item.title}」${item.dateStr} ${formatTimerFull(item.totalMs)}`,
        'cal-auto-' + item.eventId + '-' + item.endTs,
        { tab: 'timer' }
      );
    }
  }
  return created.length;
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

  // Build review date map for this month (notes spaced-repetition)
  const reviewDateMap = (typeof buildReviewDateMap === 'function') ? buildReviewDateMap() : {};

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
  // Load calendar events for this month（每周重复事件按天展开）
  const calEvents = loadCalendarEvents();
  const eventsByDate = {};
  for (let d = 1; d <= totalDays; d++) {
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dayEvents = getCalendarEventsOnDate(dateStr, calEvents);
    if (dayEvents.length === 0) continue;
    eventsByDate[dateStr] = dayEvents;
    if (!todoMap[dateStr]) todoMap[dateStr] = { due: [], completed: [], timerMs: 0, events: [] };
    todoMap[dateStr].events.push(...dayEvents);
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

  // ── Calendar Events ──（每周重复事件按当前选中日期展开）
  const allEvents = loadCalendarEvents();
  const dateEvents = getCalendarEventsOnDate(calendarSelectedDate, allEvents);
  if (dateEvents.length > 0) {
    html += `<div class="cal-events-section">
      <span class="calendar-todo-section-title">📌 事件 (${dateEvents.length})</span>`;
    for (const ev of dateEvents) {
      const c = getCalColor(ev.color);
      const timeLabel = formatCalEventTimeRange(ev, '—');
      const recurring = isCalEventRecurring(ev);
      const autoTitle = ev.autoRecord === true
        ? ' · 结束后自动计入当天计时记录' + (ev.autoTimer === false ? '（不计入专注时间）' : '')
        : '';
      const repeatTitle = recurring ? ' · ' + calEventRepeatLabel(ev) + '重复' : '';
      html += `<div class="cal-event-item" style="border-left-color:${c.dot}" title="${escapeHtml((ev.note || '') + autoTitle + repeatTitle)}"
          oncontextmenu="showCalEventContextMenu(event, ${ev.id}, '${calendarSelectedDate}')">
        <span class="cal-event-bar" style="background:${c.dot}"></span>
        <span class="cal-event-title">${timeLabel ? `<span class="cal-event-time">${escapeHtml(timeLabel)}</span>` : ''}${escapeHtml(ev.title)}${recurring ? `<span class="cal-event-repeat" title="${escapeHtml(calEventRepeatLabel(ev) + '重复')}">🔁</span>` : ''}${ev.autoRecord === true ? '<span class="cal-event-auto" title="结束后自动计入当天计时记录">⏱</span>' : ''}</span>
        <button class="cal-event-btn" onclick="event.stopPropagation();openCalEventModal('${calendarSelectedDate}', ${ev.id})" title="编辑">✎</button>        <button class="cal-event-btn cal-event-del" onclick="event.stopPropagation();deleteCalendarEvent(${ev.id});renderCalendar();" title="${recurring ? '删除整个重复事件' : '删除'}">✕</button>
      </div>`;
    }
    html += `</div>`;
  }

  // 被「仅删除这一天」跳过的场次：给出可撤销入口
  const skippedHere = allEvents.filter(ev => isCalEventSkippedOn(ev, calendarSelectedDate)
    && isCalEventSeriesDate(ev, calendarSelectedDate));
  for (const ev of skippedHere) {
    html += `<div class="cal-event-skipped">
      <span>🔁 已单独删除「${escapeHtml(ev.title)}」的这一天</span>
      <button class="cal-event-restore" onclick="event.stopPropagation();restoreCalendarEventDate(${ev.id}, '${calendarSelectedDate}')">恢复</button>
    </div>`;
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
  const startInput = document.getElementById('calEventStartTime');
  const endInput = document.getElementById('calEventEndTime');
  const autoRecordInput = document.getElementById('calEventAutoRecord');
  const autoTimerInput = document.getElementById('calEventAutoTimer');
  const noteInput = document.getElementById('calEventNote');
  const dateLabel = document.getElementById('calEventDateLabel');
  const startDateInput = document.getElementById('calEventStartDate');
  const endDateInput = document.getElementById('calEventEndDate');
  const allDayInput = document.getElementById('calEventAllDay');
  const modalTitle = document.getElementById('calEventModalTitle');
  const deleteBtn = document.getElementById('calEventDeleteBtn');
  const repeatSelect = document.getElementById('calEventRepeat');

  dateLabel.textContent = dateStr;
  startDateInput.value = dateStr;
  endDateInput.value = dateStr;
  if (eventId) {
    // Edit existing event
    modalTitle.textContent = '编辑事件';
    deleteBtn.style.display = 'inline-flex';
    const events = loadCalendarEvents();
    const ev = events.find(e => e.id === eventId);
    if (ev) {
      titleInput.value = ev.title;
      startDateInput.value = ev.date;
      endDateInput.value = normalizeCalDate(ev.endDate) || ev.date;
      dateLabel.textContent = ev.date;
      allDayInput.checked = ev.allDay === true;
      startInput.value = getCalEventStartTime(ev);
      endInput.value = normalizeCalTime(ev.endTime);
      autoRecordInput.checked = ev.autoRecord === true;
      autoTimerInput.checked = ev.autoTimer !== false;
      noteInput.value = ev.note || '';
      repeatSelect.value = isCalEventRecurring(ev) ? 'weekly' : 'none';
      setCalEventWeekdaySelection(isCalEventRecurring(ev) ? getCalEventWeekdays(ev) : []);
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
    allDayInput.checked = false;
    startInput.value = '';
    endInput.value = '';
    autoRecordInput.checked = false;
    autoTimerInput.checked = true;
    noteInput.value = '';
    repeatSelect.value = 'none';
    // 新建时默认勾选「这一天是星期几」，切到每周重复就直接可用
    const anchor = parseCalDate(dateStr);
    setCalEventWeekdaySelection(anchor ? [anchor.getDay()] : []);
    const colorRadios = document.getElementsByName('calEventColor');
    for (const r of colorRadios) {
      r.checked = r.value === 'blue';
    }
  }

  syncCalEventAllDayFields();
  syncCalEventRepeatFields();
  overlay.classList.add('open');
  setTimeout(() => titleInput.focus(), 100);
}

function syncCalEventDateFields() {
  const startInput = document.getElementById('calEventStartDate');
  const endInput = document.getElementById('calEventEndDate');
  const dateLabel = document.getElementById('calEventDateLabel');
  if (!startInput || !endInput) return;
  if (!normalizeCalDate(startInput.value)) return;
  if (!normalizeCalDate(endInput.value) || endInput.value < startInput.value) endInput.value = startInput.value;
  if (dateLabel) dateLabel.textContent = startInput.value;
  syncCalEventRepeatFields();
}

function syncCalEventAllDayFields() {
  const allDay = !!document.getElementById('calEventAllDay')?.checked;
  const startTime = document.getElementById('calEventStartTime');
  const endTime = document.getElementById('calEventEndTime');
  const autoRecord = document.getElementById('calEventAutoRecord');
  if (startTime) startTime.disabled = allDay;
  if (endTime) endTime.disabled = allDay;
  if (autoRecord) {
    if (allDay) autoRecord.checked = false;
    autoRecord.disabled = allDay;
    const label = autoRecord.closest && autoRecord.closest('label');
    if (label) label.classList.toggle('disabled', allDay);
  }
  syncCalEventAutoTimerEnabled();
}

function setCalEventWeekdaySelection(weekdays) {
  const selected = new Set(normalizeCalWeekdays(weekdays));
  const boxes = document.querySelectorAll('#calEventWeekdayRow input[data-weekday]');
  for (const box of boxes) {
    box.checked = selected.has(Number(box.getAttribute('data-weekday')));
  }
}

function getCalEventWeekdaySelection() {
  const days = [];
  const boxes = document.querySelectorAll('#calEventWeekdayRow input[data-weekday]');
  for (const box of boxes) {
    if (box.checked) days.push(Number(box.getAttribute('data-weekday')));
  }
  return normalizeCalWeekdays(days);
}

// 「星期几」选择器只在每周重复时显示，并给出即时反馈
function syncCalEventRepeatFields() {
  const repeatSelect = document.getElementById('calEventRepeat');
  const row = document.getElementById('calEventWeekdayRow');
  const hint = document.getElementById('calEventRepeatHint');
  if (!repeatSelect || !row) return;
  const weekly = repeatSelect.value === 'weekly';
  row.style.display = weekly ? '' : 'none';
  hintWarn(false);
  if (hint) {
    hint.style.display = weekly ? '' : 'none';
    if (weekly) {
      const days = getCalEventWeekdaySelection();
      const startStr = (document.getElementById('calEventStartDate') || {}).value || '';
      const startText = startStr ? `，从 ${startStr} 那一周开始` : '';
      hint.textContent = days.length === 0
        ? '请至少选择一个星期几'
        : `${formatCalRepeatText(days)}重复${startText}`;
    }
  }
}

function hintWarn(on) {
  const hint = document.getElementById('calEventRepeatHint');
  if (hint) hint.classList.toggle('cal-event-hint-warn', !!on);
}

// 点某个星期几：至少要点一个；取消最后一个时保持勾选并闪一下提示
function toggleCalEventWeekday(event, day) {
  const box = event && event.target ? event.target : null;
  const selected = getCalEventWeekdaySelection();
  if (selected.length === 0) {
    if (box) box.checked = true;
    syncCalEventRepeatFields();
    hintWarn(true);
    return;
  }
  syncCalEventRepeatFields();
}

// 「计入计时器专注时间」依附于「自动计入当天计时记录」：未开启自动计入时置灰
function syncCalEventAutoTimerEnabled() {
  const autoRecordInput = document.getElementById('calEventAutoRecord');
  const autoTimerInput = document.getElementById('calEventAutoTimer');
  if (!autoRecordInput || !autoTimerInput) return;
  const allDay = !!document.getElementById('calEventAllDay')?.checked;
  const on = autoRecordInput.checked && !allDay;
  autoTimerInput.disabled = !on;
  const label = document.getElementById('calEventAutoTimerLabel');
  if (label) label.classList.toggle('disabled', !on);
  const hint = document.getElementById('calEventAutoHint');
  if (hint) {
    const endInput = document.getElementById('calEventEndTime');
    const hasEnd = !!(endInput && endInput.value);
    hint.textContent = !on
      ? '开启后，事件时段结束时自动补记一条计时记录'
      : (hasEnd ? '事件时段结束后自动补记一条计时记录' : '需要填写结束时间才能自动补记（否则按时间点处理）');
  }
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
  const startInput = document.getElementById('calEventStartTime');
  const endInput = document.getElementById('calEventEndTime');
  const autoRecordInput = document.getElementById('calEventAutoRecord');
  const autoTimerInput = document.getElementById('calEventAutoTimer');
  const noteInput = document.getElementById('calEventNote');
  const dateLabel = document.getElementById('calEventDateLabel');
  const startDateInput = document.getElementById('calEventStartDate');
  const endDateInput = document.getElementById('calEventEndDate');
  const allDayInput = document.getElementById('calEventAllDay');

  const title = titleInput.value.trim();
  if (!title) { titleInput.focus(); return; }

  const colorRadios = document.getElementsByName('calEventColor');
  let color = 'blue';
  for (const r of colorRadios) {
    if (r.checked) { color = r.value; break; }
  }

  const allDay = !!(allDayInput && allDayInput.checked);
  const startTime = allDay ? '' : normalizeCalTime(startInput.value);
  let endTime = normalizeCalTime(endInput.value);
  // 结束时间必须依附于开始时间；只有结束时间时按时间点处理
  if (allDay || !startTime) endTime = '';
  const anchorDate = normalizeCalDate(startDateInput && startDateInput.value) || dateLabel.textContent;
  let endDate = normalizeCalDate(endDateInput && endDateInput.value) || anchorDate;
  if (endDate < anchorDate) endDate = anchorDate;
  if (startTime && endTime && endDate === anchorDate && endTime < startTime) endDate = calDateOffset(anchorDate, 1);
  if (startTime && endTime && endTime === startTime && endDate === anchorDate) endTime = '';

  const auto = {
    autoRecord: !allDay && !!(autoRecordInput && autoRecordInput.checked),
    autoTimer: autoTimerInput ? autoTimerInput.checked !== false : true
  };

  const repeatSelect = document.getElementById('calEventRepeat');
  const repeat = repeatSelect && repeatSelect.value === 'weekly' ? 'weekly' : 'none';
  // 事件的开始日期就是日历上那一天；重复时由所选星期几决定还会出现在哪些天
  const weekdays = repeat === 'weekly' ? getCalEventWeekdaySelection() : [];

  if (calendarEditingEventId) {
    updateCalendarEvent(calendarEditingEventId, {
      title, startTime, endTime, endDate, allDay, color, note: noteInput.value.trim(), repeat, weekdays, date: anchorDate, ...auto
    });
  } else {
    addCalendarEvent(anchorDate, title, startTime, color, noteInput.value.trim(),
      { start: startTime, end: endTime, endDate, allDay, repeat, weekdays }, auto);
  }

  // 新增/修改后立刻安排自动巡检，无需等待设置页开关
  if (typeof ensureAutomationTimer === 'function') ensureAutomationTimer();

  renderCalendar();
  closeCalEventModal();
}

// ── Calendar Event Context Menu（右键：编辑 / 仅删除这一天 / 删除整个事件）──
function showCalEventContextMenu(e, eventId, dateStr) {
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
  if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
  const menu = document.getElementById('calEventContextMenu');
  if (!menu) return;
  calendarCtxEventId = eventId;
  calendarCtxEventDate = dateStr;
  const evs = loadCalendarEvents();
  const ev = evs.find(item => item.id === eventId);
  const recurring = isCalEventRecurring(ev);
  const oneItem = document.getElementById('calCtxDeleteOne');
  // 只有「每周重复」的事件才可能出现"只删这一天"
  if (oneItem) oneItem.style.display = recurring ? '' : 'none';
  const seriesLabel = document.getElementById('calCtxDeleteSeriesLabel');
  if (seriesLabel) seriesLabel.textContent = recurring ? '删除整个重复事件' : '删除事件';

  const x = e ? e.clientX : 0;
  const y = e ? e.clientY : 0;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.add('visible');
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  if (rect.right > vw) menu.style.left = Math.max(0, vw - rect.width - 6) + 'px';
  if (rect.bottom > vh) menu.style.top = Math.max(0, vh - rect.height - 6) + 'px';
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}

function closeCalEventContextMenu() {
  const menu = document.getElementById('calEventContextMenu');
  if (menu) menu.classList.remove('visible');
  calendarCtxEventId = null;
  calendarCtxEventDate = null;
}

function calCtxEdit() {
  const id = calendarCtxEventId;
  const dateStr = calendarCtxEventDate || calendarSelectedDate;
  closeCalEventContextMenu();
  if (id !== null) openCalEventModal(dateStr, id);
}

function calCtxDeleteOneDay() {
  const id = calendarCtxEventId;
  const dateStr = calendarCtxEventDate;
  closeCalEventContextMenu();
  if (id === null || !dateStr) return;
  skipCalendarEventDate(id, dateStr);
}

function calCtxDeleteSeries() {
  const id = calendarCtxEventId;
  closeCalEventContextMenu();
  if (id === null) return;
  deleteCalendarEvent(id);
  renderCalendar();
}

document.addEventListener('click', function(e) {
  if (e.target.closest('#calEventContextMenu')) return;
  closeCalEventContextMenu();
});
