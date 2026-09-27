'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const syncSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'sync.js'), 'utf8');

test('sync refresh restores only the note field that was focused before refresh', () => {
  assert.match(syncSource, /focusField:\s*focusT\s*\?\s*'title'/);
  assert.match(syncSource, /editSnap\.focusField === 'source'/);
  assert.match(syncSource, /editSnap\.focusField === 'rich'/);
  assert.doesNotMatch(syncSource, /if\s*\(t\)\s*t\.focus\(\)/);
});

test('sync refresh keeps an in-progress title as a draft instead of mutating note data', () => {
  const restoreBlock = syncSource.slice(
    syncSource.indexOf('// 编辑器 DOM 未被重绘'),
    syncSource.indexOf('// ── 状态通知')
  );
  assert.ok(restoreBlock.length > 0);
  assert.doesNotMatch(restoreBlock, /n\.title\s*=\s*editSnap\.title/);
  assert.match(syncSource, /fn === 'renderNotes' && editSnap/);
});

test('sync refresh merges a body draft before rendering and does not redraw its editor', () => {
  const mergeDraftAt = syncSource.indexOf('n.content = editSnap.content');
  const renderLoopAt = syncSource.indexOf("const calls = [", mergeDraftAt);
  const skipRenderAt = syncSource.indexOf("fn === 'renderNotes' && editSnap", renderLoopAt);
  assert.ok(mergeDraftAt > 0);
  assert.ok(renderLoopAt > mergeDraftAt);
  assert.ok(skipRenderAt > renderLoopAt);
  assert.doesNotMatch(syncSource.slice(skipRenderAt), /RichNoteEditor\.setMarkdown\(editSnap\.content/);
});
