'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../js/today.js'), 'utf8');

function setup() {
  const store = new Map();
  const notes = [1, 2, 3, 4, 5].map(id => ({id, type: 'note', tags: id % 2 ? ['数学'] : ['英语']}));
  const c = vm.createContext({
    notes, due: notes.slice(),
    localStorage: {getItem: key => store.get(key) ?? null},
    saveData: (key, value) => { store.set(key, JSON.stringify(value)); return true; },
    getReviewSummary: () => ({dueNotes: c.due}), renderReviewCard() {}, showMiniToast() {}
  });
  vm.runInContext("let todayReviewTagFilter = 'all', todayReviewDraggedId = null;" + source.slice(
    source.indexOf('function loadTodayReviewLayout()'), source.indexOf('function getTodayReviewNoteDisplayPath(')), c);
  const ids = () => Array.from(c.getFilteredTodayReviewNotes(c.due), note => note.id);
  return {c, store, ids};
}

test('review pins keep their own order and survive a completed review round', () => {
  const {c, ids} = setup();
  assert.deepEqual(ids(), [1, 2, 3, 4, 5]);
  c.toggleTodayReviewPin(3); c.toggleTodayReviewPin(5);
  assert.deepEqual(ids(), [3, 5, 1, 2, 4]);
  assert.equal(c.reorderTodayReviewNotes(5, 3, false), true);
  assert.deepEqual(ids(), [5, 3, 1, 2, 4]);
  c.due = c.notes.filter(note => note.id !== 5);
  assert.deepEqual(ids(), [3, 1, 2, 4]);
  assert.deepEqual(Array.from(c.loadTodayReviewLayout().pinned), [5, 3]);
  c.due = c.notes.slice();
  assert.deepEqual(ids(), [5, 3, 1, 2, 4]);
  c.toggleTodayReviewPin(5);
  assert.deepEqual(ids(), [3, 1, 2, 4, 5]);
});

test('review ordering under a tag filter preserves other tags and rejects cross-group drops', () => {
  const {c, store, ids} = setup();
  vm.runInContext("todayReviewTagFilter = 'tag:数学'", c);
  c.reorderTodayReviewNotes(5, 1, false);
  assert.deepEqual(ids(), [5, 1, 3]);
  vm.runInContext("todayReviewTagFilter = 'all'", c);
  assert.deepEqual(ids(), [5, 1, 2, 3, 4]);
  c.toggleTodayReviewPin(3);
  const before = store.get('study_today_review_layout');
  assert.equal(c.reorderTodayReviewNotes(5, 3, false), false);
  assert.equal(store.get('study_today_review_layout'), before);
  c.reorderTodayReviewNotes(1, 4, true);
  assert.deepEqual(ids(), [3, 5, 2, 4, 1]);
  c.notes.push({id: 6, type: 'note'}); c.due.push(c.notes.at(-1));
  assert.deepEqual(ids(), [3, 5, 2, 4, 1, 6]);
});

test('review layout tolerates corrupt data and removes deleted or folder IDs', () => {
  const {c, store, ids} = setup();
  store.set('study_today_review_layout', '{broken');
  assert.deepEqual(ids(), [1, 2, 3, 4, 5]);
  c.notes.push({id: 9, type: 'folder'});
  store.set('study_today_review_layout', JSON.stringify({order: [2, 2, 99, 1], pinned: [9, 4, 4, 99]}));
  assert.deepEqual(ids(), [4, 2, 1, 3, 5]);
  c.toggleTodayReviewPin(3);
  assert.deepEqual(JSON.parse(store.get('study_today_review_layout')), {order: [2, 1], pinned: [4, 3]});
});

test('failed review layout saves preserve pin state and manual order', () => {
  const {c, ids, store} = setup();
  let errors = 0;
  c.showMiniToast = () => errors++;
  c.saveData = () => false;
  c.toggleTodayReviewPin(3);
  assert.equal(c.reorderTodayReviewNotes(5, 1, false), false);
  assert.deepEqual(ids(), [1, 2, 3, 4, 5]);
  assert.equal(store.has('study_today_review_layout'), false);
  assert.equal(errors, 2);
});
