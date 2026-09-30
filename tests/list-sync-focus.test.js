'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const [file, render, prefix, bodyStart] of [
  ['todos.js', 'renderTodos', 'subInput-', "  const tree ="],
  ['today.js', 'renderFocusList', 'todayFocusNoteInput-', "  const list ="]
]) {
  test(`${render} preserves the active draft and coalesces refreshes until blur`, () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8');
    const start = source.indexOf(`function ${render}() {`);
    const end = source.indexOf(bodyStart, start);
    assert.ok(start >= 0 && end > start);
    const listeners = [];
    const scheduled = [];
    const input = {
      id: prefix + '123', value: '未提交的草稿', selectionStart: 2, selectionEnd: 4,
      addEventListener(event, callback, options) {
        assert.equal(event, 'blur');
        assert.equal(options.once, true);
        listeners.push(callback);
      }
    };
    const context = vm.createContext({
      document: { activeElement: input }, window: {}, draws: 0,
      activeSubInputId: 123, focusNoteEditingId: 123,
      setTimeout(callback) { scheduled.push(callback); }
    });
    vm.runInContext(source.slice(start, end) + 'draws++; }', context);
    for (let i = 0; i < 3; i++) vm.runInContext(`${render}()`, context);
    assert.equal(context.draws, 0);
    assert.equal(listeners.length, 1);
    assert.equal(input.value, '未提交的草稿');
    assert.equal(input.selectionStart, 2);
    assert.equal(input.selectionEnd, 4);
    context.document.activeElement = null;
    listeners[0]();
    assert.equal(context.draws, 0, 'wait for blur handlers to save/submit first');
    scheduled.shift()();
    assert.equal(context.draws, 1);
    vm.runInContext(`${render}()`, context);
    assert.equal(context.draws, 2, 'ordinary refreshes continue after editing');
    context.document.activeElement = input;
    context.activeSubInputId = null;
    context.focusNoteEditingId = null;
    vm.runInContext(`${render}()`, context);
    assert.equal(context.draws, 3, 'explicit submit/cancel can close the focused editor');
  });
}
