'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'todos.js'), 'utf8');
const start = source.indexOf('function buildTodoRenderContext(');
const end = source.indexOf('function renderTodoNode(', start);
assert.ok(start >= 0 && end > start, 'render context function must exist');
test('todo render context aggregates descendants and timer overrides once', () => {
  const todos = [
    { id: 1, parentId: null },
    { id: 2, parentId: 1, _timerManualMs: 5000 },
    { id: 3, parentId: 2 },
    { id: 4, parentId: 1 }
  ];
  const records = [
    { todoId: 1, totalMs: 10000 },
    { todoId: 2, totalMs: 20000 },
    { todoId: 3, totalMs: 30000 },
    { todoId: 4, totalMs: 40000 },
    { todoId: 4, totalMs: 50000, affectsFocus: false }
  ];
  const context = vm.runInNewContext(`
    const todos = inputTodos;
    (${source.slice(start, end).trim()})(inputRecords)
  `, { inputTodos: todos, inputRecords: records });
  assert.deepEqual(Array.from(context.childrenByParent.get(1), todo => todo.id), [2, 4]);
  assert.equal(context.descendantCounts.get(1), 3);
  assert.equal(context.descendantCounts.get(2), 1);
  assert.equal(context.timerTotals.get(1), 85000);
  assert.equal(context.timerTotals.get(2), 35000);
});

test('todo render context terminates on circular parent data', () => {
  const todos = [{ id: 5, parentId: 6 }, { id: 6, parentId: 5 }];
  const context = vm.runInNewContext(`
    const todos = inputTodos;
    (${source.slice(start, end).trim()})([])
  `, { inputTodos: todos });
  assert.equal(context.descendantCounts.has(5), true);
  assert.equal(context.descendantCounts.has(6), true);
});
