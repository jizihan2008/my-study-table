const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'today.js'), 'utf8')
  .split('// ═══════════ Today: Review Card ═══════════')[0];

function focusContext(initial) {
  const values = new Map();
  if (initial) values.set('study_today_focus', JSON.stringify(initial));
  const todos = [
    { id: 1, text: '甲', done: false, parentId: null },
    { id: 2, text: '乙', done: false, parentId: null },
  ];
  const context = vm.createContext({
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
    },
    saveData: (key, data) => { values.set(key, JSON.stringify(data)); return true; },
    todos,
    document: { getElementById: () => null, querySelectorAll: () => [] },
    Date, Set, JSON, String, parseInt, isNaN,
  });
  vm.runInContext(source, context);
  return { context, values, todos };
}

test('legacy focus keeps its dated list and edits to another day preserve it', () => {
  const { context, values } = focusContext();
  const yesterday = context.getFocusDateByOffset(-1);
  values.set('study_today_focus', JSON.stringify({ _date: yesterday, items: [{ todoId: 1, text: '甲', done: true, note: '旧备注' }] }));
  const today = context.getTodayStr();
  assert.equal(context.getFocusItemsForDate(yesterday).items[0].note, '旧备注');
  const current = context.getFocusItemsForDate(today);
  current.items.push({ todoId: 2, text: '乙', done: false });
  assert.equal(context.saveFocusData(current), true);
  const saved = JSON.parse(values.get('study_today_focus'));
  assert.equal(saved.days[yesterday].items[0].note, '旧备注');
  assert.equal(saved.days[today].items[0].todoId, 2);
});

test('yesterday completion stays independent from the current todo', () => {
  const { context, todos } = focusContext();
  const yesterday = context.getFocusDateByOffset(-1);
  context.saveFocusData({ _date: yesterday, items: [{ todoId: 1, text: '甲', done: true }] });
  todos[0].done = false;
  assert.equal(context.getFocusItemsForDate(yesterday).items[0].done, true);
  context.saveFocusData({ _date: context.getFocusDateByOffset(1), items: [{ todoId: 2, text: '乙', done: false }] });
  assert.equal(context.getFocusItemsForDate(yesterday).items[0].done, true);
});
