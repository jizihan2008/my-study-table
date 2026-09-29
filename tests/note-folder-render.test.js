'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'notes.js'), 'utf8');

test('an empty nested note folder is not filtered out in the normal tree', () => {
  const renderBlock = source.slice(
    source.indexOf('function renderNoteList()'),
    source.indexOf('// 文件夹展开状态持久化')
  );
  assert.match(renderBlock, /const filtering = !!\(notesSearchQuery \|\| notesTagFilter\)/);
  assert.match(renderBlock, /if \(!filtering\) return true/);
});

test('creating a nested note folder expands its parent and starts rename mode', () => {
  const createBlock = source.slice(
    source.indexOf('function createNoteFolder'),
    source.indexOf('function deleteNote')
  );
  assert.match(createBlock, /expanded\.set\(Number\(folder\.parentId\), true\)/);
  assert.match(createBlock, /renamingFolderId = folder\.id/);
  assert.match(createBlock, /if \(saveData\('study_notes_v2', notes\) !== true\)/);
});

test('summary request state is repaired on startup and never persisted again', () => {
  const migrationBlock = source.slice(
    source.indexOf('(function migrateNoteData()'),
    source.indexOf('// Computed')
  );
  const summaryBlock = source.slice(
    source.indexOf('async function generateNoteSummary'),
    source.indexOf('function formatNoteSummaryError')
  );

  assert.match(migrationBlock, /hasOwnProperty\.call\(n, '_summaryUpdating'\)/);
  assert.match(migrationBlock, /delete n\._summaryUpdating/);
  assert.match(migrationBlock, /n\._summaryFailed = true/);
  assert.match(migrationBlock, /saveData\('study_notes_v2', notes\)/);
  assert.match(summaryBlock, /Object\.defineProperty\(note,'_summaryUpdating'.*enumerable:false/);
  assert.doesNotMatch(summaryBlock, /note\._summaryUpdating=true/);
});
