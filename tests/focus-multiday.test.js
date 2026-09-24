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

test('ordinary AI prompt includes yesterday, today and tomorrow focus, and the report chat is identical', () => {
  const { context, todos } = focusContext();
  const yesterday = context.getFocusDateByOffset(-1);
  const today = context.getTodayStr();
  const tomorrow = context.getFocusDateByOffset(1);
  context.saveFocusData({ _date: yesterday, items: [{ todoId: 1, text: '甲', done: true }] });
  context.saveFocusData({ _date: today, items: [{ todoId: 2, text: '乙', done: false }] });
  context.saveFocusData({ _date: tomorrow, items: [{ todoId: 1, text: '甲', done: false, note: '提前准备' }] });
  Object.assign(context, {
    notes: [], links: [], automations: [], window: {},
    loadTodoCompletedLog: () => [], getAllDescendantIds: id => [id], getChildren: () => [], getTodoTimerStr: () => '',
    loadGoals: () => [{ id: 9, text: '完成毕业设计', done: false, dueDate: '2026-12-31', content: '每周稳定推进核心模块' }],
    loadCheckinData: () => ({ streak: 0, dates: [] }), getSettings: () => ({ developerMode: false }),
    getEffectiveApiConfig: () => ({ name: 'test', model: 'test' }), getActiveConv: () => null
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'ai-tools.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'ai-api.js'), 'utf8'), context);
  const config = { name: 'test', model: 'test', conversationSettings: { id: 1, _webSearchMode: null } };
  const ordinary = { id: 1, messages: [{ role: 'user', content: '查看我的聚焦' }] };
  const prompt = context.buildConversationSystemPrompt(ordinary, config);
  assert.match(prompt, new RegExp(`昨日聚焦（${yesterday}）`));
  assert.match(prompt, new RegExp(`今日聚焦（${today}）`));
  assert.match(prompt, new RegExp(`明日聚焦（${tomorrow}）`));
  assert.match(prompt, /✅ \[ID:1\] 甲/);
  assert.match(prompt, /备注：提前准备/);
  assert.match(prompt, /长期目标：共 1 个，已完成 0 个/);
  assert.match(prompt, /\[ID:9\] ⬜ 完成毕业设计 📅2026-12-31｜说明：每周稳定推进核心模块/);
  assert.equal(prompt.includes('昨日聚焦：未设置'), false);
  assert.equal(todos[0].done, false);

  // 「每日日报」对话与普通对话共用同一份系统提示词（逐字一致）
  const reportChat = { ...ordinary, id: 2, _dailyReport: true, title: '📋 每日日报' };
  const report = context.buildConversationSystemPrompt(reportChat, config);
  assert.equal(report, prompt);
  assert.match(report, new RegExp(`昨日聚焦（${yesterday}）`));
  assert.match(report, new RegExp(`明日聚焦（${tomorrow}）`));
});

test('todo context menu can add a task directly to tomorrow focus', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /onclick="todoCtxAddTomorrowFocus\(\)"[^>]*>.*添加到明日聚焦/);

  const todoSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'todos.js'), 'utf8');
  const start = todoSource.indexOf('function todoCtxAddFocusForDate');
  const end = todoSource.indexOf('function todoCtxSort', start);
  assert.ok(start >= 0 && end > start);

  const saved = [];
  const notices = [];
  const tomorrow = '2026-09-23';
  const context = vm.createContext({
    todoCtxTargetId: 2,
    closeTodoContextMenu: () => {},
    findTodo: id => ({ id, text: '乙', done: false }),
    getFocusItemsForDate: date => ({ _date: date, items: [] }),
    getMaxFocusCount: () => 3,
    saveFocusData: data => saved.push(data),
    sendNotification: (...args) => notices.push(args),
    renderToday: () => {}, renderTodos: () => {},
    getTodayStr: () => '2026-09-22',
    getFocusDateByOffset: offset => offset === 1 ? tomorrow : 'unexpected',
  });
  vm.runInContext(todoSource.slice(start, end), context);
  context.todoCtxAddTomorrowFocus();

  assert.equal(saved.length, 1);
  assert.equal(saved[0]._date, tomorrow);
  assert.deepEqual(JSON.parse(JSON.stringify(saved[0].items)), [{ todoId: 2, text: '乙', done: false }]);
  assert.equal(notices[0][0], '已添加到明日聚焦');
});
