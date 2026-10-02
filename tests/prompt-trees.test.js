const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'js', 'ai-tools.js'), 'utf8');
const helpers = source.slice(source.indexOf('function buildAiHierarchyLines('), source.indexOf('function buildToolsSystemPrompt('));

function context(data) {
  const ctx = vm.createContext(data);
  vm.runInContext(helpers, ctx);
  return ctx;
}

test('full todo snapshot includes all levels and metadata, without a count limit', () => {
  const todos = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, parentId: i ? i : null, text: `task ${i + 1}`, done: i === 119 }));
  Object.assign(todos[119], { dueDate: '2026-10-02', completedAt: '2026-10-01', tags: ['math'] });
  const ctx = context({ todos });
  const output = ctx.buildAiTodoTreeSnapshot();
  assert.equal((output.match(/\[ID:/g) || []).length, 120);
  assert.match(output, /\[1\.1\.1\] \[ID:3\]/);
  assert.match(output, /\[已完成\] task 120；截止 2026-10-02 ✅完成于2026-10-01 🏷️math/);
});

test('note tree includes nested folders, notes and summaries', () => {
  const ctx = context({ notes: [
    { id: 1, parentId: null, type: 'folder', title: 'math' },
    { id: 2, parentId: 1, type: 'folder', title: 'calculus' },
    { id: 3, parentId: 2, type: 'note', title: 'limits', summary: 'summary text' },
  ] });
  assert.match(ctx.buildAiNoteTreeSnapshot(), /\[1\.1\.1\] 📄 \[ID:3\] limits — summary text/);
});

test('orphan nodes and disconnected cycles are included exactly once', () => {
  const ctx = context({ todos: [
    { id: 1, parentId: 99, text: 'orphan' },
    { id: 2, parentId: 3, text: 'cycle a' },
    { id: 3, parentId: 2, text: 'cycle b' },
  ] });
  const output = ctx.buildAiTodoTreeSnapshot();
  for (const id of [1, 2, 3]) assert.equal(output.split(`[ID:${id}]`).length - 1, 1);
});
