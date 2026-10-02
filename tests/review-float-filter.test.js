'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../js/today.js'), 'utf8');
test('float filters all due notes and keeps an exhausted tag available', () => {
  const select = {};
  const context = vm.createContext({
    document: { getElementById: () => select },
    getReviewSummary: () => ({ dueNotes: context.due }),
    escapeAttr: value => value, escapeHtml: value => value,
    due: [{id: 1, tags: ['数学']}, {id: 2, tags: ['英语']}, {id: 3, tags: []}]
  });
  vm.runInContext("let reviewFloatTagFilter = 'all', reviewFloatNotes = [], reviewFloatIndex = 0;" +
    source.slice(source.indexOf('function syncReviewFloatFilter()'), source.indexOf('function renderReviewFloat()')), context);
  const ids = () => vm.runInContext('reviewFloatNotes.map(n => n.id).join()', context);
  vm.runInContext("reviewFloatTagFilter = 'tag:数学'; syncReviewFloatFilter();", context);
  assert.equal(ids(), '1');
  context.due = context.due.slice(1);
  vm.runInContext('syncReviewFloatFilter()', context);
  assert.equal(ids(), '');
  assert.match(select.innerHTML, /tag:数学/);
  assert.equal(select.disabled, false);
  vm.runInContext("reviewFloatTagFilter = 'all'; syncReviewFloatFilter();", context);
  assert.equal(ids(), '2,3');
  vm.runInContext("reviewFloatTagFilter = 'untagged'; syncReviewFloatFilter();", context);
  assert.equal(ids(), '3');
});
