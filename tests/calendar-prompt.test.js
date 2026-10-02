const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('js/ai-tools.js', 'utf8');
const snapshot = source.slice(source.indexOf('function buildAiCalendarSnapshot('), source.indexOf('function normalizeAiToolResult'));
const calendar = fs.readFileSync('js/calendar.js', 'utf8');

test('calendar prompts expand weekly, skipped, spanning and all-day events for requested days', () => {
  const events = [
    { id: 1, date: '2026-09-28', repeat: 'weekly', weekdays: [3, 4, 5], skippedDates: ['2026-10-01'], title: '取消的课', startTime: '09:00', endTime: '10:00' },
    { id: 2, date: '2026-09-30', endDate: '2026-10-02', allDay: true, title: '跨天活动', note: '带书' },
    { id: 3, date: '2026-10-02', title: '明天会议', startTime: '14:00', endTime: '15:00' }
  ];
  const context = vm.createContext({ console, formatDate: () => '2026-10-01', localStorage: { getItem: () => JSON.stringify(events) }, document: { addEventListener() {} }, getTodayStr: () => '2026-10-01' });
  vm.runInContext(calendar, context);
  vm.runInContext(snapshot, context);
  const today = context.buildAiCalendarSnapshot();
  assert.match(today, /今天\(2026-10-01\)/);
  assert.match(today, /全天 跨天活动.*备注：带书/);
  assert.doesNotMatch(today, /取消的课|明天会议/);
  const morning = context.buildAiCalendarSnapshot([{ date: '2026-09-30', label: '昨天' }, { date: '2026-10-01', label: '今天' }]);
  assert.match(morning, /昨天\(2026-09-30\).*\n  - 09:00-10:00 取消的课/);
  const evening = context.buildAiCalendarSnapshot([{ date: '2026-10-01', label: '今天' }, { date: '2026-10-02', label: '明天' }]);
  assert.match(evening, /明天\(2026-10-02\)/);
  assert.match(evening, /14:00-15:00 明天会议/);
});

test('empty calendar explicitly reports no events', () => {
  const context = vm.createContext({ loadCalendarEvents: () => [], getCalendarEventsOnDate: () => [], getTodayStr: () => '2026-10-01' });
  vm.runInContext(snapshot, context);
  assert.match(context.buildAiCalendarSnapshot(), /今天\(2026-10-01\)：无日程/);
});

