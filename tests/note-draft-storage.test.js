'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('note editing state stays local and legacy cloud flags cannot block body refresh', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'core.js'), 'utf8');
  const storage = new Map();
  const context = vm.createContext({ localStorage: {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value)
  }, window: {}, console });
  vm.runInContext(source.slice(0, source.indexOf('// ═══════════', source.indexOf('function saveData'))), context);
  const note = { id: 1, content: '正文', summary: '摘要', _dirtyContent: true };
  assert.equal(context.saveData('study_notes_v2', [note]), true);
  const saved = JSON.parse(storage.get('study_notes_v2'))[0];
  assert.equal(saved.content, '正文');
  assert.equal(saved.summary, '摘要');
  assert.equal('_dirtyContent' in saved, false);
  assert.equal(note._dirtyContent, true, 'saving must retain the actual local draft state');
  storage.set('study_notes_v2', JSON.stringify([note]));
  assert.equal('_dirtyContent' in context.loadData('study_notes_v2')[0], false);
});

for (const dirty of [false, true]) {
  test(`sync refresh ${dirty ? 'preserves an actual draft' : 'updates a clean focused empty note'}`, () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'sync.js'), 'utf8');
    const refresh = source.slice(source.indexOf('  function _refreshUI()'), source.indexOf('// ── 状态通知'));
    const textarea = { value: dirty ? '本地草稿' : '', selectionStart: 0, selectionEnd: 0 };
    let rendered = 0;
    const context = vm.createContext({
      notes: [{ id: 1, content: textarea.value, _dirtyContent: dirty }],
      document: { activeElement: textarea, getElementById: id => id === 'notesTextarea' ? textarea : null },
      loadData: () => [{ id: 1, content: '云端正文' }],
      window: { renderNotes: () => rendered++ }, global: {}, setTimeout: () => {}
    });
    vm.runInContext('function getActiveNote() { return notes[0]; }\n' + refresh + '\n_refreshUI();', context);
    assert.equal(rendered, dirty ? 0 : 1);
    assert.equal(context.notes[0].content, dirty ? '本地草稿' : '云端正文');
  });
}
