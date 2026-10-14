'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadFunctions(context, file, names) {
  const source = fs.readFileSync(file, 'utf8');
  for (const name of names) {
    const start = source.indexOf('function ' + name + '(');
    const end = source.indexOf('\n}', start);
    assert.ok(start >= 0 && end > start);
    vm.runInContext(source.slice(start, end + 2), context);
  }
}
function load() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync('js/timer-types.js', 'utf8'), context);
  loadFunctions(context, 'js/timer.js', ['getTimerIntervalUnionMs', 'getTimerRecordsDurationSummary', 'getTodayTimerTotalMs']);
  return context;
}
const day = '2026-10-12';
const hour = 3600000;
const at = (h, date = day) => new Date(date + 'T00:00:00').getTime() + h * hour;
const record = (type, start, end, date = day) => ({ date, activityType: type, totalMs: (end - start) * hour,
  sessions: [{ start: at(start, date), end: at(end, date) }] });
const plain = x => JSON.parse(JSON.stringify(x));

test('union handles duplicates, nesting, unsorted intervals, touching edges and gaps without mutation', () => {
  const context = load();
  const intervals = [{ start: 9, end: 12 }, { start: 1, end: 3 }, { start: 2, end: 4 },
    { start: 1, end: 3 }, { start: 2, end: 3 }, { start: 4, end: 5 },
    { start: 20, end: 20 }, { start: 30, end: 29 }, { start: NaN, end: 40 }, null];
  const before = plain(intervals);
  assert.equal(context.getTimerIntervalUnionMs(intervals), 7);
  assert.deepEqual(plain(intervals), before);
  assert.equal(context.getTimerIntervalUnionMs([]), 0);
});

test('types deduplicate independently while overall total deduplicates across types', () => {
  const context = load();
  const records = [record('focus', 9, 10), record('focus', 9.5, 11), record('rest', 10, 12),
    record('other', 11, 12), record('other', 11, 12), record('rest', 8, 20, '2026-10-11')];
  const before = plain(records);
  const result = context.getTimerRecordsDurationSummary(records, day);
  assert.deepEqual(plain(result), { totalMs: 3 * hour, typeMs: { focus: 2 * hour, rest: 2 * hour, other: hour }, unlocatedMs: 0 });
  assert.equal(context.getTodayTimerTotalMs(records, day), 3 * hour);
  assert.deepEqual(plain(records), before);
});

test('clip intervals to the selected local day; keep unlocated durations separate', () => {
  const context = load();
  const records = [record('focus', -1, 1), record('rest', 23, 25), record('focus', 25, 26),
    { date: day, totalMs: 60000, sessions: [] },
    { date: day, affectsFocus: false, totalMs: 120000, sessions: [{ start: 8, end: 7 }] },
    { date: day, totalMs: Infinity }, { date: day, totalMs: -1 }, null];
  assert.deepEqual(plain(context.getTimerRecordsDurationSummary(records, day)), {
    totalMs: 2 * hour + 180000,
    typeMs: { focus: hour + 60000, rest: hour, other: 120000 }, unlocatedMs: 180000
  });
});

test('both report collectors, JSON and legacy prompt templates use union totals', () => {
  const context = load();
  const records = [day, '2026-10-11'].flatMap(date => [record('focus', 9, 10, date), record('focus', 9.5, 11, date),
    record('rest', 10, 12, date), record('other', 11, 12, date)]);
  Object.assign(context, {
    localStorage: { getItem: key => key === 'study_timer_records' ? JSON.stringify(records) : null },
    todos: [], notes: [], getTodayStr: () => day, getPastDateStr: () => '2026-10-11',
    loadCheckinData: () => ({ dates: [] }), getFocusItemsForDate: () => ({ items: [] }),
    getTodayFocusItems: () => ({ items: [] }), collectReportLongTermGoals: () => [],
    getDailyReportConv: () => null, buildAiCalendarSnapshot: () => '', buildAiTodoTreeSnapshot: () => '', buildAiNoteTreeSnapshot: () => ''
  });
  loadFunctions(context, 'js/settings.js', ['formatDailyReportTimerLabel', 'collectDailyReportData', 'collectEveningReportData']);
  vm.runInContext(fs.readFileSync('js/prompts.js', 'utf8'), context);
  const settings = fs.readFileSync('js/settings.js', 'utf8');
  for (const [type, prefix, collect] of [['morning', 'yday', 'collectDailyReportData'], ['evening', 'today', 'collectEveningReportData']]) {
    const data = context[collect]();
    assert.equal(data[prefix + 'TimerStr'], '3 小时 0 分钟');
    assert.deepEqual(plain(data[prefix + 'TimerTypeTotals'].map(t => t.totalMs)), [2 * hour, 2 * hour, hour]);
    assert.equal(data[prefix + 'TimerSessions'].length, 4, 'retain individual records');
    assert.match(data[prefix + 'TimerStatisticsNote'], /并集/);
    assert.doesNotMatch(data[prefix + 'TimerStatisticsNote'], /缺少有效/);
    assert.match(context.reportPromptData(type, data), /3 小时 0 分钟/);
    const start = settings.indexOf(prefix === 'yday' ? '【昨日计时】' : '【今日计时】');
    const end = settings.indexOf('\n【', settings.indexOf('TimerSessions.map', start));
    const text = new Function('data', 'return `' + settings.slice(start, end) + '`;')(data);
    assert.match(text, /专注：2 小时 0 分钟；休息：2 小时 0 分钟；其它：1 小时 0 分钟/);
    assert.match(text, /并集/);
  }
  records.push({ date: day, totalMs: 60000, sessions: [] });
  assert.match(context.collectEveningReportData().todayTimerStatisticsNote, /缺少有效起止时间/);
});
