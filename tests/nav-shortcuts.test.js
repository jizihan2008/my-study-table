'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const nav = require('../js/nav-shortcuts');

test('normalize accepts letters, digits, F-keys and safe punctuation', () => {
  assert.equal(nav.normalize('K'), 'k');
  assert.equal(nav.normalize(' k '), 'k');
  assert.equal(nav.normalize('7'), '7');
  assert.equal(nav.normalize('f12'), 'F12');
  assert.equal(nav.normalize('F13'), '');
  assert.equal(nav.normalize('/'), '/');
  assert.equal(nav.normalize('Escape'), '');
  assert.equal(nav.normalize(''), '');
  assert.equal(nav.normalize(null), '');
});

test('defaults hand out Ctrl+1..9 by visible order and leave extras unbound', () => {
  const ids = ['todo', 'notes', 'calendar', 'ai', 'timer', 'habits', 'stats', 'music', 'books', 'trash'];
  const map = nav.defaults(ids);
  assert.equal(map.todo, '1');
  assert.equal(map.books, '9');
  assert.equal(map.trash, '');
  assert.deepEqual(Object.keys(map), ids);
});

test('resolve keeps hidden tab bindings and drops duplicated keys', () => {
  const stored = { todo: 'k', notes: 'K', calendar: 'F2', timer: 'F2' };
  const map = nav.resolve(stored, ['todo', 'notes', 'calendar', 'timer', 'habits']);
  assert.equal(map.todo, 'k');
  assert.equal(map.notes, '');       // 重复的 k 被丢弃（先到先得）
  assert.equal(map.calendar, 'F2');
  assert.equal(map.timer, '');       // 重复的 F2 被丢弃
  assert.equal(map.habits, '');      // 未绑定
});

test('assign steals a key from the tab that already owned it', () => {
  const before = { todo: '1', notes: '2', calendar: '3' };
  const res = nav.assign(before, 'calendar', 'n', ['todo', 'notes', 'calendar']);
  assert.equal(res.map.calendar, 'n');
  assert.deepEqual(res.displaced, []);
  const stolen = nav.assign(res.map, 'todo', 'n', ['todo', 'notes', 'calendar']);
  assert.equal(stolen.map.todo, 'n');
  assert.equal(stolen.map.calendar, '');
  assert.deepEqual(stolen.displaced, ['calendar']);
  assert.equal(before.calendar, '3');  // 不改动入参
});

test('assign keeps bindings of hidden tabs that are not in the id list', () => {
  const res = nav.assign({ todo: '1', trash: 't' }, 'notes', 'n', ['todo', 'notes']);
  assert.equal(res.map.trash, 't');
  assert.equal(res.map.notes, 'n');
});

test('clear only unbinds the requested tab', () => {
  const map = nav.clear({ todo: '1', notes: 'n' }, 'todo');
  assert.equal(map.todo, '');
  assert.equal(map.notes, 'n');
});

test('match fires only for visible tabs', () => {
  const map = { todo: '1', trash: 't' };
  assert.equal(nav.match(map, '1', ['todo', 'notes']), 'todo');
  assert.equal(nav.match(map, 'T', ['todo', 'notes']), '');
  assert.equal(nav.match(map, 't', ['todo', 'notes']), '');  // 隐藏栏目不触发
  assert.equal(nav.match(map, 't', ['todo', 'trash']), 'trash');
});

test('match ignores keys that are not bound', () => {
  assert.equal(nav.match({ todo: '' }, '1', ['todo']), '');
  assert.equal(nav.match(null, '1', ['todo']), '');
});

test('fromEvent requires Ctrl (or Cmd) and ignores Ctrl+Shift combos', () => {
  assert.equal(nav.fromEvent({ key: 'k', ctrlKey: true }), 'k');
  assert.equal(nav.fromEvent({ key: 'K', metaKey: true }), 'k');
  assert.equal(nav.fromEvent({ key: 'k' }), '');                                   // 未按 Ctrl
  assert.equal(nav.fromEvent({ key: 'k', ctrlKey: true, shiftKey: true }), '');    // Ctrl+Shift+K 不参与
  assert.equal(nav.fromEvent({ key: 'k', ctrlKey: true, altKey: true }), '');
  assert.equal(nav.fromEvent({ key: 'Control', ctrlKey: true }), '');
  assert.equal(nav.fromEvent({ key: 'F4', ctrlKey: true }), 'F4');
  assert.equal(nav.fromEvent({ key: 'k' }, { requireCtrl: false }), 'k');          // 录制时允许只按基础键
});

test('label and isReserved describe the stored key', () => {
  assert.equal(nav.label('k'), 'Ctrl+K');
  assert.equal(nav.label('1'), 'Ctrl+1');
  assert.equal(nav.label('f5'), 'Ctrl+F5');
  assert.equal(nav.label(''), '');
  assert.equal(nav.isReserved('Z'), true);
  assert.equal(nav.isReserved('q'), false);
});
