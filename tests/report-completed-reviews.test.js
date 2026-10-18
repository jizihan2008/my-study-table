const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(notes = []) {
  const context = vm.createContext({ notes });
  const source = fs.readFileSync('js/settings.js', 'utf8');
  const start = source.indexOf('function collectReportCompletedNoteReviews(');
  const end = source.indexOf('\n}', start);
  vm.runInContext(source.slice(start, end + 2), context);
  vm.runInContext(fs.readFileSync('js/prompts.js', 'utf8'), context);
  return context;
}

test('review completion counts use local day, count repeats and preserve skipped notes', () => {
  const before = new Date(2026, 9, 7, 23, 59).toISOString();
  const after = new Date(2026, 9, 8, 0, 1).toISOString();
  const later = new Date(2026, 9, 8, 22).toISOString();
  const context = load([
    { id: 1, type: 'note', title: '微积分', _skipReview: true, _reviewHistory: [before, after, later, null, '', 'bad date'] },
    { id: 2, type: 'note', title: '', _reviewHistory: [after] },
    { id: 3, type: 'folder', _reviewHistory: [after] },
    { id: 4, type: 'note', _reviewHistory: null }
  ]);
  const yesterday = context.collectReportCompletedNoteReviews('2026-10-07');
  assert.equal(yesterday.completedNoteCount, 1);
  assert.equal(yesterday.completionCount, 1);
  assert.equal(yesterday.completedNotes[0].completedAt[0], before);
  const today = context.collectReportCompletedNoteReviews('2026-10-08');
  assert.equal(today.completedNoteCount, 2);
  assert.equal(today.completionCount, 3);
  assert.equal(today.completedNotes[0].completionCount, 2);
  assert.equal(today.completedNotes[1].title, '未命名');
  assert.match(today.statisticsNote, /本地日期/);
});

test('zero completions are explicitly reported', () => {
  const result = load().collectReportCompletedNoteReviews('2026-10-08');
  assert.equal(result.activityDate, '2026-10-08');
  assert.equal(result.completedNoteCount, 0);
  assert.equal(result.completionCount, 0);
  assert.equal(result.completedNotes.length, 0);
});

test('completed reviews reach preview and resolved report system prompt in both formats', () => {
  const context = load([{ id: 1, type: 'note', title: '微积分', _reviewHistory: [new Date(2026, 9, 8, 12).toISOString()] }]);
  const data = { completedNoteReviews: context.collectReportCompletedNoteReviews('2026-10-08'), reviewDisabled: true };
  for (const type of ['morning', 'evening']) {
    for (const legacy of [undefined, '📊 **日报数据**\n其余数据\n---\n建议']) {
      const reportData = context.reportPromptData(type, data, legacy);
      const systemPrompt = context.resolvePromptTemplate(context.defaultPromptTemplate(type), { reportData });
      assert.match(systemPrompt, /微积分/);
      assert.match(systemPrompt, /"activityDate": "2026-10-08"/);
      assert.match(systemPrompt, /"completedNoteCount": 1/);
      assert.match(systemPrompt, /"completionCount": 1/);
      assert.match(systemPrompt, /"completedAt"/);
      assert.match(systemPrompt, type === 'morning' ? /昨日完成笔记复习/ : /今日完成笔记复习/);
    }
  }
  assert.equal(context.friendlyPromptLabel('completedNoteReviews'), '当日完成笔记复习');
  assert.equal(context.friendlyPromptLabel('completionCount'), '完成复习次数');
});
