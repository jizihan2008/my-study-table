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
    savedKeys: [],
    saveData: (key, value) => {
      data.set(key, JSON.stringify(value));
      context.savedKeys.push(key);
      return true;
    }, renderNotes: () => {}, renderTrash: () => {}, renderArchive: () => {},
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

test('archiving a todo moves the entire subtree and reports archive changes', () => {
  const ctx = setup();
  ctx.todos = [{ id: 11 }, { id: 12, parentId: 11 }, { id: 13, parentId: 12 }, { id: 14 }];
  ctx.expandedTodoIds = new Set([11]);
  ctx.saveExpandedTodoIds = () => {};
  vm.runInContext("moveToArchive('todos', todos[0])", ctx);
  assert.deepEqual(ctx.todos.map(item => item.id), [14]);
  assert.deepEqual(JSON.parse(ctx.localStorage.getItem('study_todos_archive')).map(item => item.id).sort(), [11, 12, 13]);
  assert.ok(ctx.savedKeys.includes('study_todos_archive'));
  vm.runInContext("restoreFromArchive('todos', 11)", ctx);
  assert.equal(ctx.savedKeys.filter(key => key === 'study_todos_archive').length, 2);
  assert.equal(JSON.parse(ctx.localStorage.getItem('study_todos_archive')).length, 0);
});

test('folding hides all descendants, preserves nested folds and isolates views and modules', () => {
  const ctx = setup();
  ctx.localStorage.setItem('study_notes_archive', JSON.stringify([...ctx.notes, { id: 4, title: 'Sibling' }]));
  const ids = (view = 'archive', module = 'notes') => vm.runInContext(
    `visibleStoredTree(loadArchive('notes'), '${view}', '${module}').map(row => row.item.id).join(',')`, ctx);
  assert.equal(ids(), '1,2,3,4');
  vm.runInContext("toggleStoredTree('archive', 'notes', 2); toggleStoredTree('archive', 'notes', 1)", ctx);
  assert.equal(ids(), '1,4');
  assert.equal(ids('trash'), '1,2,3,4');
  assert.equal(ids('archive', 'todos'), '1,2,3,4');
  vm.runInContext("toggleStoredTree('archive', 'notes', 1)", ctx);
  assert.equal(ids(), '1,2,4');
  const reloaded = setup();
  reloaded.localStorage.setItem('study_notes_archive', ctx.localStorage.getItem('study_notes_archive'));
  reloaded.localStorage.setItem('study_stored_tree_collapsed_v1', ctx.localStorage.getItem('study_stored_tree_collapsed_v1'));
  assert.equal(vm.runInContext("visibleStoredTree(loadArchive('notes'), 'archive', 'notes').map(row => row.item.id).join(',')", reloaded), '1,2,4');
  assert.equal(JSON.parse(ctx.localStorage.getItem('study_notes_archive')).length, 4);
});

test('orphaned and cyclic stored trees remain reachable when folding', () => {
  const ctx = setup();
  ctx.localStorage.setItem('study_notes_archive', JSON.stringify([
    { id: 1, parentId: 2 }, { id: 2, parentId: 1 }, { id: 3, parentId: 999 }
  ]));
  assert.equal(vm.runInContext("visibleStoredTree(loadArchive('notes'), 'archive', 'notes').length", ctx), 3);
  vm.runInContext("toggleStoredTree('archive', 'notes', 1)", ctx);
  assert.equal(vm.runInContext("visibleStoredTree(loadArchive('notes'), 'archive', 'notes').map(row => row.item.id).join(',')", ctx), '3,1');
});

test('failed archive persistence leaves the original subtree in place', () => {
  const ctx = setup();
  ctx.saveData = () => false;
  assert.equal(vm.runInContext("moveToArchive('notes', notes[0])", ctx), false);
  assert.equal(ctx.notes.length, 3);
  assert.equal(ctx.localStorage.getItem('study_notes_archive'), null);
});
