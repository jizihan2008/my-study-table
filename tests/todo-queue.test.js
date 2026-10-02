const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function setup() {
  const store = new Map();
  const todos = Array.from({length: 7}, (_, i) => ({id: i+1, text: '任务'+(i+1), done: i===5}));
  const days = {0: {items: [{todoId: 1}]}, 1: {items: []}};
  const context = vm.createContext({localStorage: {getItem: k => store.get(k) ?? null, setItem: (k,v) => store.set(k,v)},
    findTodo: id => todos.find(t => t.id===id), showMiniToast() {}, document: {getElementById: () => null},
    saveData: (k,v) => { store.set(k, JSON.stringify(v)); return true; },
    getFocusDateByOffset: n => n, getFocusItemsForDate: n => JSON.parse(JSON.stringify(days[n])), getMaxFocusCount: () => 3,
    saveFocusData: data => { days[context.selectedFocusDateForTest] = data; return true; }, renderFocusList() {}, selectedFocusDate: 0});
  vm.runInContext(fs.readFileSync('js/todo-queue.js', 'utf8'), context);
  return {context, store, days, todos};
}
test('queue prevents duplicates, removes stale IDs and persists drag order', () => {
  const {context: c, store, todos} = setup();
  c.addTodoToQueue(1); c.addTodoToQueue(2); c.addTodoToQueue(3); c.addTodoToQueue(1);
  assert.equal(store.get('study_todo_queue'), '[1,2,3]');
  c.reorderTodoQueue(3,1,false);
  assert.equal(store.get('study_todo_queue'), '[3,1,2]');
  c.reorderTodoQueue(3,2,true);
  assert.equal(store.get('study_todo_queue'), '[1,2,3]');
  todos.pop(); store.set('study_todo_queue', '[1,7,1,2]');
  assert.equal(JSON.stringify(c.loadTodoQueue()), '[1,2]');
  c.removeTodoFromQueue(1);
  assert.equal(store.get('study_todo_queue'), '[2]');
});
test('fill focus respects order, existing items, completion, capacity and day', () => {
  const {context: c, store, days} = setup();
  store.set('study_todo_queue', '[6,1,4,2,3]');
  c.selectedFocusDateForTest = 0; c.addQueueToFocus(0);
  assert.deepEqual(days[0].items.map(i => i.todoId), [1,4,2]);
  c.selectedFocusDateForTest = 1; c.addQueueToFocus(1,3);
  assert.deepEqual(days[1].items.map(i => i.todoId), [3]);
  assert.equal(store.get('study_todo_queue'), '[6,1,4,2,3]');
});
test('failed queue writes do not report a changed order', () => {
  const {context: c, store} = setup();
  store.set('study_todo_queue', '[1,2]'); c.saveData = () => false;
  assert.equal(c.reorderTodoQueue(2,1,false), false);
  assert.equal(store.get('study_todo_queue'), '[1,2]');
});

test('prompt queue uses full live order, hierarchy, completion and deadlines', () => {
  const {context: c, store, todos} = setup();
  c.getFocusTodoDisplayPath = todo => ({full: '父任务 › ' + todo.text});
  todos[1].dueDate = '2026-10-03';
  store.set('study_todo_queue', '[6,2,1,3,4,5,7]');
  const text = c.buildAiTodoQueueSnapshot();
  assert.match(text, /共 7 项/);
  assert.match(text, /1\. \[ID:6\] 已完成 父任务 › 任务6/);
  assert.match(text, /2\. \[ID:2\] 未完成 父任务 › 任务2（截止 2026-10-03）/);
  assert.match(text, /7\. \[ID:7\]/);
  c.reorderTodoQueue(7,6,false);
  assert.match(c.buildAiTodoQueueSnapshot(), /1\. \[ID:7\]/);
  store.set('study_todo_queue', '[]');
  assert.match(c.buildAiTodoQueueSnapshot(), /暂无待办/);
});
