const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const today = fs.readFileSync('js/today.js', 'utf8');
const source = today.slice(today.indexOf('// ═══════════ Today: Long-term Goals'), today.indexOf('function renderTodayFlashcards('));
function harness(goals) {
  const values = new Map([['study_longterm_goals', JSON.stringify(goals)]]);
  const elements = new Map();
  let nextId = 100;
  const context = vm.createContext({
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    saveData: (key, data) => { values.set(key, JSON.stringify(data)); return true; },
    document: { activeElement: null, getElementById: id => elements.get(id) || null },
    genId: () => ++nextId, showMiniToast() {}, requestAnimationFrame() {},
    showCustomConfirm: async () => true, escapeHtml: String,
  });
  vm.runInContext(source, context);
  return { context, values, elements };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('legacy roots and out-of-order descendants form a stable hierarchy without changing storage', () => {
  const goals = [{ id: 3, parentId: 2, text: '实验' }, { id: 1, text: '毕业设计', note: '旧备注' },
    { id: 2, parentId: 1, text: '研究' }, { id: 4, parentId: null, text: '另一目标' }];
  const { context: c } = harness(goals);
  assert.deepEqual(plain(c.getGoalHierarchy().map(({ goal, parentId, depth, path }) => [goal.id, parentId, depth, path])),
    [[1, null, 0, '毕业设计'], [2, 1, 1, '毕业设计 › 研究'], [3, 2, 2, '毕业设计 › 研究 › 实验'], [4, null, 0, '另一目标']]);
  assert.deepEqual(plain(c.loadGoals()), goals);
  assert.deepEqual([...c.getGoalDescendantIds(2)], [2, 3]);
});

test('deep nesting, missing parents and cyclic imports remain visible and terminate', () => {
  const goals = Array.from({ length: 80 }, (_, i) => ({ id: i + 1, parentId: i || null, text: String(i + 1) }));
  goals.push({ id: 81, parentId: 999, text: '孤立' }, { id: 82, parentId: 83, text: '环甲' },
    { id: 83, parentId: 82, text: '环乙' }, { id: 84, parentId: 84, text: '自身' });
  const { context: c } = harness(goals);
  const entries = c.getGoalHierarchy();
  assert.equal(entries.length, goals.length);
  assert.equal(entries[79].depth, 79);
  assert.equal(new Set(entries.map(entry => entry.goal.id)).size, goals.length);
  assert.equal(c.getGoalDescendantIds(82).size, 2);
});

test('nested creation preserves drafts on failure and keeps the parent and siblings intact', () => {
  const { context: c, elements } = harness([{ id: 1, text: '父目标', collapsed: true, done: true }, { id: 2, text: '其他' }]);
  elements.set('todayGoalSubInput-1', { value: '新子目标' });
  const save = c.saveData;
  c.saveData = () => false;
  c.addSubGoal(1);
  assert.equal(c.loadGoals().length, 2);
  assert.equal(elements.get('todayGoalSubInput-1').value, '新子目标');
  c.saveData = save;
  c.addSubGoal(1);
  const child = c.loadGoals().find(goal => goal.parentId === 1);
  assert.equal(child.text, '新子目标');
  assert.equal(c.loadGoals()[0].collapsed, false);
  c.toggleGoal(child.id);
  assert.equal(c.loadGoals()[0].done, true);
  assert.equal(c.loadGoals()[2].done, true);
});

test('deleting a subtree confirms, re-reads synced descendants and preserves unrelated goals', async () => {
  const { context: c } = harness([{ id: 1, text: '父' }, { id: 2, parentId: 1, text: '子' },
    { id: 3, parentId: 2, text: '孙' }, { id: 4, text: '保留' }]);
  c.showCustomConfirm = async () => false;
  await c.deleteGoal(1);
  assert.equal(c.loadGoals().length, 4);
  c.showCustomConfirm = async () => {
    c.saveGoals([...c.loadGoals(), { id: 5, parentId: 3, text: '同步到达' }]);
    return true;
  };
  await c.deleteGoal(1);
  assert.deepEqual(plain(c.loadGoals()), [{ id: 4, text: '保留' }]);
});

test('reports preserve ancestry even when a parent is collapsed', () => {
  const { context: c } = harness([{ id: 1, text: '父', collapsed: true }, { id: 2, parentId: 1, text: '子', note: '备注' }]);
  const settings = fs.readFileSync('js/settings.js', 'utf8');
  vm.runInContext(settings.slice(settings.indexOf('function collectReportLongTermGoals('), settings.indexOf('// ── Helper: collect yesterday')), c);
  assert.deepEqual(plain(c.collectReportLongTermGoals()[1]),
    { id: 2, parentId: 1, path: '父 › 子', text: '子', done: false, dueDate: null, note: '备注', content: '' });
  assert.match(c.formatReportLongTermGoals(c.collectReportLongTermGoals()), /父 › 子｜备注：备注/);
});
