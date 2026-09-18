const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 计时记录展示：待办显示完整父级路径；已命名的记录不再补「自由计时」。
const timerSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'timer.js'), 'utf8')
  .split('// Restore timer state on page load')[0];

const settingsSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'settings.js'), 'utf8');
const dailyReportHelpers = settingsSource.slice(
  settingsSource.indexOf('function formatDailyReportFocusPath'),
  settingsSource.indexOf('function collectDailyReportData')
);

const todos = [
  { id: 1, text: '数学', parentId: null },
  { id: 2, text: '第一章', parentId: 1 },
  { id: 3, text: '习题', parentId: 2 },
];

function localDateStr(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

function findTodo(id) {
  return todos.find(t => t.id === id) || null;
}

function getAncestorPath(id) {
  const result = [];
  const seen = new Set();
  let current = findTodo(id);
  while (current && current.parentId !== null) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    current = findTodo(current.parentId);
    if (current) result.unshift({ id: current.id, text: current.text });
  }
  return result;
}

function baseContext(extra) {
  return vm.createContext({
    todos,
    Date, Set, Map, JSON, String, Number, Math, Array, Object, parseInt, isNaN,
    findTodo,
    getAncestorPath,
    loadGoals: () => [],
    formatDate: localDateStr,
    escapeHtml: value => String(value),
    escapeAttr: value => String(value),
    saveData: () => true,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    window: { addEventListener: () => {}, removeEventListener: () => {} },
    ...extra,
  });
}

function renderHistory(records) {
  const context = baseContext();
  vm.runInContext(timerSource, context);
  return context.renderTimerHistory(records);
}

test('timer history shows the todo full ancestor path', () => {
  const html = renderHistory([{ id: 1, date: localDateStr(new Date()), totalMs: 60000, targetId: 3, targetType: 'todo' }]);
  assert.match(html, /数学 › 第一章 › 习题/);
});

test('named timer record without a linked todo never falls back to 自由计时', () => {
  const html = renderHistory([{ id: 2, date: localDateStr(new Date()), totalMs: 60000, name: '晨读英语' }]);
  assert.match(html, /⏱ 晨读英语/);
  assert.equal(html.includes('自由计时'), false);
});

test('named timer record still shows its linked todo full path', () => {
  const html = renderHistory([{ id: 3, date: localDateStr(new Date()), totalMs: 60000, name: '刷题', targetId: 3, targetType: 'todo' }]);
  assert.match(html, /⏱ 刷题 · 数学 › 第一章 › 习题/);
});

test('unnamed timer record without a linked todo keeps 自由计时', () => {
  const html = renderHistory([{ id: 4, date: localDateStr(new Date()), totalMs: 60000 }]);
  assert.match(html, /⏱ 自由计时/);
});

function reportLabel(record) {
  const context = baseContext();
  vm.runInContext(dailyReportHelpers, context);
  return context.formatDailyReportTimerLabel(record);
}

test('daily report timer label uses the linked todo full path', () => {
  assert.equal(reportLabel({ name: '刷题', targetId: 3, targetType: 'todo' }), '⏱ 刷题 · 📋 数学 > 第一章 > 习题');
  assert.equal(reportLabel({ targetId: 3, targetType: 'todo' }), '📋 数学 > 第一章 > 习题');
});

test('daily report timer label falls back to 自由计时 only when nothing is known', () => {
  assert.equal(reportLabel({ name: '晨读英语' }), '⏱ 晨读英语');
  assert.equal(reportLabel({}), '自由计时');
});
