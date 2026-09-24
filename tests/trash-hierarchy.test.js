const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup() {
  const data = new Map();
  const context = vm.createContext({
    localStorage: {
      getItem: key => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value)
    },
    document: { getElementById: () => null },
    notes: [
      { id: 1, type: 'folder', title: 'Root', parentId: null },
      { id: 2, type: 'folder', title: 'Child', parentId: 1 },
      { id: 3, type: 'note', title: 'Leaf', parentId: 2 }
    ],
    todos: [], activeNoteId: 3,
    saveData: () => true, renderNotes: () => {}, renderTrash: () => {}, renderArchive: () => {},
    renderTodos: () => {}, console
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/trash.js'), 'utf8'), context);
  return context;
}

test('archived note folders retain descendants and original hierarchy', () => {
  const ctx = setup();
  vm.runInContext("moveToArchive('notes', notes[0])", ctx);
  assert.equal(ctx.notes.length, 0);
  const archived = JSON.parse(ctx.localStorage.getItem('study_notes_archive'));
  assert.equal(archived.length, 3);
  assert.deepEqual(archived.map(item => [item.id, item.parentId]).sort((a, b) => a[0] - b[0]),
    [[1, null], [2, 1], [3, 2]]);
  assert.equal(vm.runInContext('orderedStoredTree(loadArchive("notes")).map(x => x.depth).join(",")', ctx), '0,1,2');
  vm.runInContext("restoreFromArchive('notes', 1)", ctx);
  assert.equal(ctx.notes.length, 3);
  assert.equal(JSON.parse(ctx.localStorage.getItem('study_notes_archive')).length, 0);
});

test('archived todo parent restores its nested children', () => {
  const ctx = setup();
  ctx.localStorage.setItem('study_todos_archive', JSON.stringify([
    { id: 13, parentId: 12, text: 'leaf' },
    { id: 12, parentId: 11, text: 'child' },
    { id: 11, parentId: null, text: 'root' }
  ]));
  vm.runInContext("restoreFromArchive('todos', 11)", ctx);
  assert.deepEqual(ctx.todos.map(item => item.id).sort(), [11, 12, 13]);
  assert.equal(JSON.parse(ctx.localStorage.getItem('study_todos_archive')).length, 0);
});
