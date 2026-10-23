'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = name => fs.readFileSync(require.resolve('../js/' + name), 'utf8');
const ts = (day, time) => new Date(day + 'T' + time + ':00').getTime();

function setup(events, now = ts('2026-10-20', '10:00')) {
  const values = new Map();
  const notices = [];
  const elements = new Map();
  const context = vm.createContext({
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) },
    loadCalendarEvents: () => events,
    loadTimerRecords: () => [{ sessions: [{ start: now - 7200000, end: now - 3600000 }] }],
    sendNotification: (...args) => notices.push(args),
    document: { getElementById: id => elements.get(id) || null },
    setSyncedSetting: (key, value) => values.set(key, String(value)),
    ensureAutomationTimer() {},
  });
  const calendar = read('calendar.js');
  vm.runInContext(calendar.slice(calendar.indexOf('function normalizeCalTime('), calendar.indexOf('// 事件结束时间晚于水位时')), context);
  vm.runInContext(calendar.slice(calendar.indexOf('function _formatCalAutoDate('), calendar.indexOf('// 事件时段结束后自动补一条计时记录')), context);
  const settings = read('settings.js');
  vm.runInContext(settings.slice(settings.indexOf('const ENCOURAGEMENTS_CHECKIN'), settings.indexOf('// ═══════════ End Reminder System')), context);
  values.set('study_reminder_idle_skip_calendar', 'true');
  return { context, values, notices, elements };
}

test('idle calendar exemption includes the start and excludes the end; opt-in only', () => {
  const { context: c, values } = setup([{ date: '2026-10-20', startTime: '09:00', endTime: '11:00' }]);
  assert.equal(c._isInIdleCalendarRange(ts('2026-10-20', '08:59')), false);
  assert.equal(c._isInIdleCalendarRange(ts('2026-10-20', '09:00')), true);
  assert.equal(c._isInIdleCalendarRange(ts('2026-10-20', '11:00')), false);
  values.delete('study_reminder_idle_skip_calendar');
  assert.equal(c._isInIdleCalendarRange(ts('2026-10-20', '10:00')), false);
});

test('weekly, skipped, overnight, legacy time and multi-day occurrences follow calendar rules', () => {
  const event = { date: '2026-10-19', repeat: 'weekly', weekdays: [1], time: '23:00', endTime: '02:00' };
  const { context: c } = setup([event]);
  assert.equal(c._isInIdleCalendarRange(ts('2026-10-20', '01:00')), true);
  assert.equal(c._isInIdleCalendarRange(ts('2026-10-21', '01:00')), false);
  event.skippedDates = ['2026-10-19'];
  assert.equal(c._isInIdleCalendarRange(ts('2026-10-20', '01:00')), false);
  event.skippedDates = [];
  event.endDate = '2026-10-22';
  assert.equal(c._isInIdleCalendarRange(ts('2026-10-22', '01:00')), true);
  assert.equal(c._isInIdleCalendarRange(ts('2026-10-22', '02:00')), false);
  delete event.repeat;
  assert.equal(c._isInIdleCalendarRange(ts('2026-10-21', '12:00')), true);
});

test('all-day, point-only and unrelated dated events do not suppress reminders', () => {
  const { context: c } = setup([
    { date: '2026-10-20', allDay: true, startTime: '00:00', endTime: '23:59' },
    { date: '2026-10-20', startTime: '10:00' },
    { date: '2026-10-19', startTime: '09:00', endTime: '11:00' },
  ]);
  assert.equal(c._isInIdleCalendarRange(), false);
});

test('scheduled period suppresses actual notification without consuming daily count or cooldown', () => {
  const { context: c, values, notices } = setup([{ date: '2026-10-20', startTime: '09:00', endTime: '11:00' }]);
  Object.entries({ study_reminder_idle_enabled: 'true', study_reminder_idle_day: '2026-10-20',
    study_reminder_idle_accum: '3600000', study_reminder_idle_count_day: '2026-10-20' }).forEach(([k, v]) => values.set(k, v));
  c._checkIdleReminder();
  assert.equal(notices.length, 0);
  assert.equal(values.has('study_reminder_idle_last_ts'), false);
  assert.equal(values.has('study_reminder_idle_count_today'), false);
  values.set('study_reminder_idle_skip_calendar', 'false');
  c._checkIdleReminder();
  assert.equal(notices.length, 1);
  assert.equal(values.get('study_reminder_idle_count_today'), '1');
});

test('calendar exemption checkbox saves and reloads its value', () => {
  const { context: c, values, elements } = setup([]);
  const checkbox = { checked: false };
  elements.set('reminderIdleSkipCalendar', checkbox);
  c.loadReminderSettings();
  assert.equal(checkbox.checked, true);
  checkbox.checked = false;
  c.saveReminderSettings();
  assert.equal(values.get('study_reminder_idle_skip_calendar'), 'false');
  checkbox.checked = true;
  c.loadReminderSettings();
  assert.equal(checkbox.checked, false);
});
