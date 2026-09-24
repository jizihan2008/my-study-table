'use strict';
// 日历事件的「时间段 + 自动计入计时记录」逻辑回归。
// 只加载 calendar.js 的纯函数与自动记账引擎，使用桩替代 DOM / 存储。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const calendarSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'calendar.js'), 'utf8');

function localDateStr(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function createContext(options) {
  const opts = options || {};
  let events = opts.events || [];
  let timerRecords = opts.timerRecords || [];
  const notifications = [];
  let recordId = 1000;

  const makeEl = id => ({
    id,
    innerHTML: '', textContent: '', value: '', style: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    getBoundingClientRect: () => ({ right: 0, bottom: 0, width: 0, height: 0 }),
    focus: () => {},
    closest: () => null
  });
  const elements = new Map();
  const documentStub = {
    getElementById: id => {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    },
    getElementsByName: () => [],
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    body: makeEl('body')
  };

  const context = vm.createContext({
    console,
    Date, JSON, String, Number, Math, Array, Object, RegExp, parseInt, parseFloat, isNaN, Boolean, Set, Map,
    setTimeout: fn => 0, clearTimeout: () => {},
    formatDate: d => localDateStr(d.getTime()),
    saveData: (key, value) => {
      if (key === 'study_calendar_events') events = JSON.parse(JSON.stringify(value));
      if (key === 'study_timer_records') timerRecords = JSON.parse(JSON.stringify(value));
      return true;
    },
    localStorage: {
      getItem: key => {
        if (key === 'study_calendar_events' || key === 'calendar_events') return JSON.stringify(events);
        if (key === 'study_timer_records') return JSON.stringify(timerRecords);
        return null;
      },
      setItem: () => {},
      removeItem: () => {}
    },
    loadTimerRecords: () => timerRecords,
    saveTimerRecords: records => { timerRecords = records; return true; },
    genTimerRecordId: () => ++recordId,
    sendNotification: (title, body, tag, target) => { notifications.push({ title, body, tag, target }); },
    renderTimer: () => {},
    renderCalendar: () => {},
    loadTodoCompletedLog: () => [],
    buildReviewDateMap: () => ({}),
    escapeHtml: value => String(value == null ? '' : value),
    lucide: { createIcons: () => {} },
    todos: [],
    document: documentStub,
    window: { addEventListener: () => {}, innerWidth: 1200, innerHeight: 800 }
  });
  vm.runInContext(calendarSource, context);

  return {
    ctx: context,
    notifications,
    elements,
    getEvents: () => events,
    getRecords: () => timerRecords
  };
}

function eventAt(date, start, end, extra) {
  return Object.assign({
    id: 1,
    date,
    title: '线性代数复习',
    time: start || '',
    startTime: start || '',
    endTime: end || '',
    color: 'blue',
    note: '',
    repeat: 'none',
    skippedDates: [],
    autoRecord: true,
    autoTimer: true,
    createdAt: 1
  }, extra || {});
}

// ── 时间段解析 ──

test('resolveCalEventRange 解析同一天的时间段', () => {
  const { ctx } = createContext();
  const range = ctx.resolveCalEventRange(eventAt('2026-03-05', '09:00', '10:30'));
  assert.equal(range.hasEnd, true);
  assert.equal(range.crossDay, false);
  assert.equal(range.startTs, new Date(2026, 2, 5, 9, 0, 0, 0).getTime());
  assert.equal(range.endTs, new Date(2026, 2, 5, 10, 30, 0, 0).getTime());
  assert.equal(range.endTs - range.startTs, 90 * 60 * 1000);
});

test('resolveCalEventRange 结束时间早于开始时间时顺延到次日', () => {
  const { ctx } = createContext();
  const range = ctx.resolveCalEventRange(eventAt('2026-03-05', '23:00', '00:30'));
  assert.equal(range.crossDay, true);
  assert.equal(range.endTs, new Date(2026, 2, 6, 0, 30, 0, 0).getTime());
  assert.equal(range.endTs - range.startTs, 90 * 60 * 1000);
});

test('resolveCalEventRange 支持显式跨多天的结束日期', () => {
  const { ctx } = createContext();
  const ev = eventAt('2026-03-05', '23:00', '08:30', { endDate: '2026-03-08' });
  const range = ctx.resolveCalEventRange(ev);
  assert.equal(range.crossDay, true);
  assert.equal(range.endTs, new Date(2026, 2, 8, 8, 30, 0, 0).getTime());
  assert.equal(range.endTs - range.startTs, (57.5 * 60 * 60 * 1000));
});

test('跨天事件会出现在覆盖到的每个日期', () => {
  const { ctx } = createContext();
  const ev = eventAt('2026-03-05', '09:00', '10:00', { endDate: '2026-03-07' });
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-04'), false);
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-05'), true);
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-06'), true);
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-07'), true);
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-08'), false);
});

test('全天事件无时间范围且不会自动记账', () => {
  const { ctx } = createContext();
  const ev = eventAt('2026-03-05', '', '', { endDate: '2026-03-06', allDay: true, autoRecord: true });
  assert.equal(ctx.formatCalEventTimeRange(ev), '全天');
  assert.equal(ctx.resolveCalEventRange(ev), null);
  assert.equal(ctx.shouldAutoRecordCalEvent(ev, new Date(2026, 2, 7).getTime()), false);
});

test('只有时间点（没有结束时间）的事件不产生可自动记账的时段', () => {
  const { ctx } = createContext();
  const range = ctx.resolveCalEventRange(eventAt('2026-03-05', '09:00', ''));
  assert.equal(range.hasEnd, false);
  assert.equal(ctx.shouldAutoRecordCalEvent(eventAt('2026-03-05', '09:00', ''), Date.now()), false);
});

test('旧数据（只有 time 字段）仍能读取开始时间', () => {
  const { ctx } = createContext();
  const legacy = { id: 9, date: '2026-03-05', title: '旧事件', time: '14:05', createdAt: 1 };
  assert.equal(ctx.getCalEventStartTime(legacy), '14:05');
  assert.equal(ctx.formatCalEventTimeRange(legacy), '14:05');
  assert.equal(ctx.formatCalEventTimeRange(eventAt('2026-03-05', '09:00', '10:30')), '09:00—10:30');
});

test('normalizeCalTime 兼容补零与非法输入', () => {
  const { ctx } = createContext();
  assert.equal(ctx.normalizeCalTime('9:5'), '');
  assert.equal(ctx.normalizeCalTime('9:05'), '09:05');
  assert.equal(ctx.normalizeCalTime('24:00'), '');
  assert.equal(ctx.normalizeCalTime('12:60'), '');
  assert.equal(ctx.normalizeCalTime(''), '');
  assert.equal(ctx.normalizeCalTime(null), '');
});

// ── 自动记账判定 ──

test('未勾选「自动计入当天计时记录」的事件永不记账', () => {
  const { ctx } = createContext();
  const ev = eventAt('2026-03-05', '09:00', '10:00', { autoRecord: false });
  assert.equal(ctx.shouldAutoRecordCalEvent(ev, new Date(2026, 2, 5, 12, 0).getTime()), false);
});

test('时段尚未结束时不计账，结束后立即计账', () => {
  const { ctx } = createContext();
  const ev = eventAt('2026-03-05', '09:00', '10:00');
  const endTs = new Date(2026, 2, 5, 10, 0, 0, 0).getTime();
  assert.equal(ctx.shouldAutoRecordCalEvent(ev, endTs - 60000), false);
  assert.equal(ctx.shouldAutoRecordCalEvent(ev, endTs), true);
});

test('同一场时段不会重复记账', () => {
  const { ctx } = createContext();
  const ev = eventAt('2026-03-05', '09:00', '10:00');
  const endTs = new Date(2026, 2, 5, 10, 0, 0, 0).getTime();
  ev.lastAutoRecordEnd = endTs;
  assert.equal(ctx.shouldAutoRecordCalEvent(ev, endTs + 3600000), false);
});

test('超过一周的陈旧时段不补账', () => {
  const { ctx } = createContext();
  const ev = eventAt('2026-02-20', '09:00', '10:00');
  const endTs = new Date(2026, 1, 20, 10, 0, 0, 0).getTime();
  const now = new Date(2026, 2, 5, 12, 0, 0, 0).getTime(); // 13 天后
  assert.equal(ctx.shouldAutoRecordCalEvent(ev, now), false);
  assert.equal(ctx.shouldAutoRecordCalEvent(ev, endTs + 60000), true); // 结束后不久仍会补
});

// ── 自动记账落盘 ──

test('runCalendarAutoRecords 写入计时记录并只写一次', () => {
  const endTs = new Date(2026, 2, 5, 10, 0, 0, 0).getTime();
  const { ctx, notifications, getEvents, getRecords } = createContext({
    events: [eventAt('2026-03-05', '09:00', '10:00')]
  });

  assert.equal(ctx.runCalendarAutoRecords(endTs + 1000), 1);
  const records = getRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].name, '线性代数复习');
  assert.equal(records[0].date, '2026-03-05');
  assert.equal(records[0].totalMs, 60 * 60 * 1000);
  assert.equal(records[0].affectsFocus, true);
  assert.equal(records[0].auto, true);
  assert.equal(records[0].sourceEventId, 1);
  assert.equal(records[0].sessions[0].start, new Date(2026, 2, 5, 9, 0, 0, 0).getTime());
  assert.equal(records[0].sessions[0].end, endTs);
  assert.equal(notifications.length, 1);

  // 第二次巡检不应重复写入
  assert.equal(ctx.runCalendarAutoRecords(endTs + 120000), 0);
  assert.equal(getRecords().length, 1);
  assert.equal(getEvents()[0].lastAutoRecordEnd, endTs);
});

test('取消「计入计时器专注时间」时记录 affectsFocus=false', () => {
  const endTs = new Date(2026, 2, 5, 10, 0, 0, 0).getTime();
  const { ctx, getRecords } = createContext({
    events: [eventAt('2026-03-05', '09:00', '10:00', { autoTimer: false })]
  });
  ctx.runCalendarAutoRecords(endTs + 1000);
  assert.equal(getRecords()[0].affectsFocus, false);
});

test('跨天时段按结束时刻归属日期', () => {
  const endTs = new Date(2026, 2, 6, 0, 30, 0, 0).getTime();
  const { ctx, getRecords } = createContext({
    events: [eventAt('2026-03-05', '23:00', '00:30')]
  });
  ctx.runCalendarAutoRecords(endTs + 1000);
  assert.equal(getRecords()[0].date, '2026-03-06');
  assert.equal(getRecords()[0].totalMs, 90 * 60 * 1000);
});

test('不足一分钟的时段不记账但仍标记为已处理', () => {
  // 界面不会产生不足 1 分钟的时段，但数据层要能兜住：在 vm 内覆盖时段解析，喂一个 30 秒区间
  const endTs = new Date(2026, 2, 5, 9, 0, 30, 0).getTime();
  const store = createContext({ events: [eventAt('2026-03-05', '09:00', '09:01')] });
  store.ctx.__forcedEndTs = endTs;
  vm.runInContext(
    'const _origResolveCalEventRange = resolveCalEventRange;' +
    'resolveCalEventRange = function (ev) {' +
    '  const range = _origResolveCalEventRange(ev);' +
    '  return range ? Object.assign({}, range, { endTs: __forcedEndTs }) : range;' +
    '};',
    store.ctx
  );

  assert.equal(store.ctx.runCalendarAutoRecords(endTs + 1000), 0);
  assert.equal(store.getRecords().length, 0);
  assert.equal(store.getEvents()[0].lastAutoRecordEnd, endTs);

  // 第二次巡检不会重复判定
  assert.equal(store.ctx.runCalendarAutoRecords(endTs + 3600000), 0);
});

test('hasPendingCalendarAutoRecords 正确判断待补账事件', () => {
  const endTs = new Date(2026, 2, 5, 10, 0, 0, 0).getTime();
  const pending = createContext({ events: [eventAt('2026-03-05', '09:00', '10:00')] });
  assert.equal(pending.ctx.hasPendingCalendarAutoRecords(endTs + 1000), true);
  assert.equal(pending.ctx.hasPendingCalendarAutoRecords(endTs - 60000), false);

  const plain = createContext({ events: [eventAt('2026-03-05', '09:00', '10:00', { autoRecord: false })] });
  assert.equal(plain.ctx.hasPendingCalendarAutoRecords(endTs + 1000), false);
});

// ── 事件编辑 ──

test('修改时段后允许重新记账，关掉自动计入时清空记账水位', () => {
  const { ctx, getEvents } = createContext({
    events: [eventAt('2026-03-05', '09:00', '10:00', { lastAutoRecordEnd: new Date(2026, 2, 5, 10, 0).getTime() })]
  });
  ctx.updateCalendarEvent(1, { endTime: '11:00' });
  assert.equal(getEvents()[0].lastAutoRecordEnd, 0);
  assert.equal(getEvents()[0].endTime, '11:00');

  ctx.updateCalendarEvent(1, { autoRecord: false });
  assert.equal(getEvents()[0].autoRecord, false);
  assert.equal(getEvents()[0].lastAutoRecordEnd, 0);
});

test('updateCalendarEvent 同步 time 字段以兼容旧界面', () => {
  const { ctx, getEvents } = createContext({ events: [eventAt('2026-03-05', '09:00', '10:00')] });
  ctx.updateCalendarEvent(1, { startTime: '08:15' });
  assert.equal(getEvents()[0].startTime, '08:15');
  assert.equal(getEvents()[0].time, '08:15');

  // 只传 time（旧调用方式）也应落到 startTime
  ctx.updateCalendarEvent(1, { time: '07:45' });
  assert.equal(getEvents()[0].startTime, '07:45');
  assert.equal(getEvents()[0].time, '07:45');
});

test('addCalendarEvent 保存时间段与自动计入开关', () => {
  const { ctx, getEvents } = createContext();
  const id = ctx.addCalendarEvent('2026-03-05', '  英语听力  ', '09:00', 'green', 'note',
    { start: '09:00', end: '10:00' }, { autoRecord: true, autoTimer: false });
  assert.equal(typeof id, 'number');
  const ev = getEvents()[0];
  assert.equal(ev.title, '英语听力');
  assert.equal(ev.startTime, '09:00');
  assert.equal(ev.endTime, '10:00');
  assert.equal(ev.autoRecord, true);
  assert.equal(ev.autoTimer, false);
  assert.equal(ev.color, 'green');
});

test('addCalendarEvent 兼容旧调用签名（单时间点、无自动计入）', () => {
  const { ctx, getEvents } = createContext();
  ctx.addCalendarEvent('2026-03-05', '旧调用', '09:00', 'blue', '');
  const ev = getEvents()[0];
  assert.equal(ev.time, '09:00');
  assert.equal(ev.startTime, '09:00');
  assert.equal(ev.endTime, '');
  assert.equal(ev.autoRecord, false);
  assert.equal(ev.autoTimer, false);
  assert.equal(ev.repeat, 'none');
});

// ── 每周重复 ──
// 2026-03-05 是周四

test('每周重复事件只在所选星期几出现，且不早于开始那一周', () => {
  const { ctx } = createContext();
  const ev = eventAt('2026-03-05', '09:00', '10:00', { repeat: 'weekly' });
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-05'), true);   // 开始日（周四）
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-12'), true);   // 下周四
  assert.equal(ctx.isCalEventOnDate(ev, '2026-04-02'), true);   // 再下下周四
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-06'), false);  // 周五
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-04'), false);  // 开始那一周之前的周三
  assert.equal(ctx.isCalEventOnDate(ev, '2026-02-26'), false);  // 更早的周四也不出现
});

test('不重复的事件只出现在自己那一天', () => {
  const { ctx } = createContext();
  const ev = eventAt('2026-03-05', '09:00', '10:00');
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-05'), true);
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-12'), false);
});

test('getCalendarEventsOnDate 展开重复事件并按开始时间排序', () => {
  const { ctx } = createContext();
  const weekly = eventAt('2026-03-05', '14:00', '15:00', { repeat: 'weekly', id: 1, title: '每周复盘' });
  const single = eventAt('2026-03-12', '09:00', '10:00', { id: 2, title: '单次事件' });
  const list = ctx.getCalendarEventsOnDate('2026-03-12', [weekly, single]);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map(e => e.title), ['单次事件', '每周复盘']);
  assert.equal(ctx.getCalendarEventsOnDate('2026-03-19', [weekly, single]).length, 1);
});

test('calEventRepeatLabel 给出「每周几」，支持多选与全选', () => {
  const { ctx } = createContext();
  assert.equal(ctx.calEventRepeatLabel(eventAt('2026-03-05', '09:00', '10:00', { repeat: 'weekly' })), '每周四');
  assert.equal(ctx.calEventRepeatLabel(eventAt('2026-03-05', '09:00', '10:00', { repeat: 'weekly', weekdays: [1, 3, 5] })), '每周一、三、五');
  assert.equal(ctx.calEventRepeatLabel(eventAt('2026-03-05', '09:00', '10:00', { repeat: 'weekly', weekdays: [0, 1, 2, 3, 4, 5, 6] })), '每天');
  assert.equal(ctx.calEventRepeatLabel(eventAt('2026-03-05', '09:00', '10:00')), '');
});

test('重复说明不会出现「每周周」这种重复', () => {
  const { ctx } = createContext();
  assert.equal(ctx.formatCalRepeatText([4, 5]), '每周四、五');
  assert.equal(ctx.formatCalRepeatText([4, 5]).includes('每周周'), false);
  assert.equal(ctx.formatCalRepeatText([1]), '每周一');
  assert.equal(ctx.formatCalRepeatText([]), '');
});

test('isCalEventSeriesDate 只判断星期几，不含跳过列表', () => {
  const { ctx } = createContext();
  const ev = eventAt('2026-03-05', '09:00', '10:00', { repeat: 'weekly', skippedDates: ['2026-03-12'] });
  assert.equal(ctx.isCalEventSeriesDate(ev, '2026-03-12'), true);  // 星期几对得上
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-12'), false);     // 但被跳过
  assert.equal(ctx.isCalEventSeriesDate(ev, '2026-02-26'), false); // 开始那一周之前
  assert.equal(ctx.isCalEventSeriesDate(ev, '2026-03-06'), false); // 星期五
  assert.equal(ctx.isCalEventSeriesDate(eventAt('2026-03-05', '09:00', '10:00'), '2026-03-05'), false);
});

// ── 自选星期几 ──

test('每周重复可按所选星期几出现（多选）', () => {
  const { ctx } = createContext();
  // 开始日 2026-03-05 是周四，选周一/周三/周五
  const ev = eventAt('2026-03-05', '09:00', '10:00', { repeat: 'weekly', weekdays: [1, 3, 5] });
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-06'), true);   // 周五（同周）
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-09'), true);   // 下周一
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-11'), true);   // 下周三
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-05'), false);  // 周四没选
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-07'), false);  // 周六没选
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-01'), false);  // 开始那一周之前（周日）
});

test('开始日期所在那一周整周都算起点', () => {
  const { ctx } = createContext();
  // 2026-03-01 是周日，选周一/周三：3/02、3/04 就应该出现
  const ev = eventAt('2026-03-01', '09:00', '10:00', { repeat: 'weekly', weekdays: [1, 3] });
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-02'), true);
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-04'), true);
  assert.equal(ctx.isCalEventOnDate(ev, '2026-02-25'), false);  // 上一周的周三
});

test('没有 weekdays 的旧数据按开始日期的星期几重复', () => {
  const { ctx } = createContext();
  const legacy = eventAt('2026-03-05', '09:00', '10:00', { repeat: 'weekly', weekdays: [] });
  assert.deepEqual([...ctx.getCalEventWeekdays(legacy)], [4]);   // 周四
  assert.equal(ctx.isCalEventOnDate(legacy, '2026-03-12'), true);
  assert.equal(ctx.isCalEventOnDate(legacy, '2026-03-13'), false);
});

test('addCalendarEvent 用所选星期几，未选则用开始日期的星期几', () => {
  const { ctx, getEvents } = createContext();
  ctx.addCalendarEvent('2026-03-05', '晨读', '07:00', 'blue', '', { start: '07:00', end: '07:30', repeat: 'weekly', weekdays: [1, 5] }, {});
  assert.deepEqual([...getEvents()[0].weekdays], [1, 5]);
  ctx.addCalendarEvent('2026-03-05', '例会', '20:00', 'purple', '', { start: '20:00', end: '21:00', repeat: 'weekly' }, {});
  assert.deepEqual([...getEvents()[1].weekdays], [4]);
  ctx.addCalendarEvent('2026-03-05', '单次', '09:00', 'blue', '');
  assert.deepEqual([...getEvents()[2].weekdays], []);
  assert.equal(getEvents()[2].repeat, 'none');
});

test('修改星期几会清空跳过列表与记账水位；改回不重复也一样', () => {
  const { ctx, getEvents } = createContext({
    events: [eventAt('2026-03-05', '09:00', '10:00', {
      repeat: 'weekly',
      weekdays: [4],
      skippedDates: ['2026-03-12'],
      lastAutoRecordEnd: new Date(2026, 2, 5, 10, 0).getTime()
    })]
  });
  ctx.updateCalendarEvent(1, { weekdays: [1, 3], repeat: 'weekly' });
  assert.deepEqual([...getEvents()[0].weekdays], [1, 3]);
  assert.deepEqual(getEvents()[0].skippedDates, []);
  assert.equal(getEvents()[0].lastAutoRecordEnd, 0);

  // 传空数组 = 取消重复
  ctx.updateCalendarEvent(1, { weekdays: [], repeat: 'none' });
  assert.deepEqual([...getEvents()[0].weekdays], []);
  assert.equal(getEvents()[0].repeat, 'none');
});

test('按星期几重复的事件每个命中日各记一次账', () => {
  const { ctx, getRecords } = createContext({
    events: [eventAt('2026-03-02', '09:00', '10:00', { repeat: 'weekly', weekdays: [1, 3] })]
  });
  // 周三 3/04 结束后：只补这一场（周一的 3/02 也在窗口内）
  assert.equal(ctx.runCalendarAutoRecords(new Date(2026, 2, 4, 10, 30).getTime()), 2);
  const dates = getRecords().map(r => r.date).sort();
  assert.deepEqual(dates, ['2026-03-02', '2026-03-04']);

  // 同一批场次不会重复补
  assert.equal(ctx.runCalendarAutoRecords(new Date(2026, 2, 4, 11, 0).getTime()), 0);

  // 下周一再记一次
  assert.equal(ctx.runCalendarAutoRecords(new Date(2026, 2, 9, 10, 30).getTime()), 1);
  assert.equal(getRecords().length, 3);
  assert.equal(getRecords()[2].date, '2026-03-09');
});

test('删除单独一天只跳过那一天，整个系列仍然保留', () => {
  const { ctx, getEvents } = createContext({
    events: [eventAt('2026-03-05', '09:00', '10:00', { repeat: 'weekly' })]
  });
  assert.equal(ctx.skipCalendarEventDate(1, '2026-03-12'), true);
  const ev = getEvents()[0];
  assert.deepEqual(ev.skippedDates, ['2026-03-12']);
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-12'), false); // 被删掉的那一天
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-05'), true);  // 其它天不受影响
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-19'), true);

  // 重复跳过同一天不会写入两条
  ctx.skipCalendarEventDate(1, '2026-03-12');
  assert.deepEqual(getEvents()[0].skippedDates, ['2026-03-12']);

  // 恢复后该天重新出现
  assert.equal(ctx.restoreCalendarEventDate(1, '2026-03-12'), true);
  assert.deepEqual(getEvents()[0].skippedDates, []);
  assert.equal(ctx.isCalEventOnDate(getEvents()[0], '2026-03-12'), true);
});

test('非重复事件不支持「仅删除这一天」', () => {
  const { ctx, getEvents } = createContext({ events: [eventAt('2026-03-05', '09:00', '10:00')] });
  assert.equal(ctx.skipCalendarEventDate(1, '2026-03-05'), false);
  assert.deepEqual(getEvents()[0].skippedDates, []);
});

test('每周重复事件在时段结束后逐周自动记账，且不重复补写', () => {
  const { ctx, getRecords, getEvents } = createContext({
    events: [eventAt('2026-03-05', '09:00', '10:00', { repeat: 'weekly' })]
  });
  // 第一次巡检：3/05 这一场已结束
  assert.equal(ctx.runCalendarAutoRecords(new Date(2026, 2, 5, 10, 30).getTime()), 1);
  assert.equal(getRecords()[0].date, '2026-03-05');

  // 同一场再巡检不重复
  assert.equal(ctx.runCalendarAutoRecords(new Date(2026, 2, 5, 11, 0).getTime()), 0);
  assert.equal(getRecords().length, 1);

  // 下一周（3/12）结束后再记账一次
  assert.equal(ctx.runCalendarAutoRecords(new Date(2026, 2, 12, 10, 30).getTime()), 1);
  assert.equal(getRecords().length, 2);
  assert.equal(getRecords()[1].date, '2026-03-12');
  assert.equal(getRecords()[1].sourceEventId, 1);
  assert.equal(getRecords()[1].totalMs, 60 * 60 * 1000);
  assert.equal(getEvents()[0].lastAutoRecordEnd, new Date(2026, 2, 12, 10, 0).getTime());
});

test('单次删除的重复场次不会被自动记账', () => {
  const { ctx, getRecords } = createContext({
    events: [eventAt('2026-03-05', '09:00', '10:00', { repeat: 'weekly', skippedDates: ['2026-03-12'] })]
  });
  // 3/05 已结束后记账
  assert.equal(ctx.runCalendarAutoRecords(new Date(2026, 2, 5, 10, 30).getTime()), 1);
  // 3/12 被单独删掉 → 不记账
  assert.equal(ctx.runCalendarAutoRecords(new Date(2026, 2, 12, 10, 30).getTime()), 0);
  assert.equal(getRecords().length, 1);
  // 3/19 照常记账
  assert.equal(ctx.runCalendarAutoRecords(new Date(2026, 2, 19, 10, 30).getTime()), 1);
  assert.equal(getRecords().length, 2);
});

test('重复事件不会回溯补写很久以前的场次', () => {
  const { ctx } = createContext({
    events: [eventAt('2026-01-01', '09:00', '10:00', { repeat: 'weekly' })]
  });
  const now = new Date(2026, 2, 5, 12, 0).getTime(); // 两个月后
  const due = ctx.getCalEventDueOccurrences({ ...ctx.loadCalendarEvents()[0] }, now);
  // 只补最近这个窗口内的场次（按星期几对齐，最多回溯约 8 天），不会把两个月的旧账全部补出来
  assert.ok(due.length <= 2, '实际补账场次：' + due.length);
  for (const item of due) {
    assert.ok(now - item.range.endTs <= 8 * 24 * 60 * 60 * 1000);
  }
});

test('切换重复开关或开始日期会清空跳过列表与记账水位', () => {
  const { ctx, getEvents } = createContext({
    events: [eventAt('2026-03-05', '09:00', '10:00', {
      repeat: 'weekly',
      skippedDates: ['2026-03-12'],
      lastAutoRecordEnd: new Date(2026, 2, 5, 10, 0).getTime()
    })]
  });
  ctx.updateCalendarEvent(1, { repeat: 'none' });
  assert.equal(getEvents()[0].repeat, 'none');
  assert.deepEqual(getEvents()[0].skippedDates, []);
  assert.equal(getEvents()[0].lastAutoRecordEnd, 0);

  ctx.updateCalendarEvent(1, { repeat: 'weekly', date: '2026-03-10' });
  assert.equal(getEvents()[0].date, '2026-03-10');
  assert.deepEqual(getEvents()[0].skippedDates, []);
  assert.equal(getEvents()[0].lastAutoRecordEnd, 0);
});

test('addCalendarEvent 支持每周重复', () => {
  const { ctx, getEvents } = createContext();
  ctx.addCalendarEvent('2026-03-05', '每周例会', '20:00', 'purple', '',
    { start: '20:00', end: '21:00', repeat: 'weekly' }, { autoRecord: true });
  const ev = getEvents()[0];
  assert.equal(ev.repeat, 'weekly');
  assert.deepEqual(ev.skippedDates, []);
  assert.equal(ctx.isCalEventOnDate(ev, '2026-03-12'), true);
});
