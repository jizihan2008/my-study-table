const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(conversations, summaries = []) {
  const context = vm.createContext({
    aiConvs: conversations, window: {},
    localStorage: { getItem: () => JSON.stringify({ convSummaries: summaries }) }
  });
  vm.runInContext(fs.readFileSync('js/memory.js', 'utf8'), context);
  return context;
}
const ts = day => new Date(2026, 9, day, 12).getTime();
const msg = (day, content, role = 'user') => ({ timestamp: ts(day), content, role });

test('reports filter actual message dates and include every conversation and inactive branch', () => {
  const context = load([
    { id: 1, title: '跨日讨论', messages: [msg(7, '昨天问题'), msg(8, '今天问题')] },
    { id: 2, title: '多分支', messages: [msg(8, '采用回复', 'assistant')], tree: {
      root: { role: 'root' }, a: msg(8, '采用回复', 'assistant'), b: msg(8, '另一回复', 'assistant')
    } },
    ...Array.from({ length: 21 }, (_, i) => ({ id: i + 10, messages: [msg(8, '其他聊天')] }))
  ], [{ convId: 1, summary: '混入其他日期的摘要', messageCount: 2, extractedAt: ts(8) }]);
  const yesterday = context.collectReportAiConversations('2026-10-07');
  assert.equal(yesterday.length, 1);
  assert.match(yesterday[0].excerpts, /昨天问题/);
  assert.doesNotMatch(yesterday[0].excerpts, /今天问题/);
  assert.equal(yesterday[0].summary, '');
  const today = context.collectReportAiConversations('2026-10-08');
  assert.equal(today.length, 23);
  assert.match(today[1].excerpts, /采用回复[\s\S]*另一回复/);
});

test('reuse a complete single-day memory, but include fresh messages when it is stale', () => {
  const conversation = { id: 1, messages: [msg(7, '提问'), msg(7, '结论', 'assistant')] };
  const context = load([conversation], [{ convId: 1, summary: '讨论数学并解决问题', messageCount: 2, extractedAt: ts(8) }]);
  assert.equal(context.collectReportAiConversations('2026-10-07')[0].summary, '讨论数学并解决问题');
  conversation.messages.push(msg(7, '新问题'));
  const result = context.collectReportAiConversations('2026-10-07')[0];
  assert.equal(result.summary, '');
  assert.match(result.excerpts, /新问题/);
});

test('old tree IDs remain readable and unknown migrated dates are not attributed to today', () => {
  const context = load([{ id: 1, messages: [
    { id: ts(7) * 1000 + 1, time: '12:00', role: 'user', content: '旧树消息' },
    { id: ts(8) * 1000 + 1, timestamp: null, time: '12:00', role: 'user', content: '日期未知' }
  ] }]);
  assert.match(context.collectReportAiConversations('2026-10-07')[0].excerpts, /旧树消息/);
  assert.equal(context.collectReportAiConversations('2026-10-08').length, 0);
  assert.match(context.formatReportAiConversations([], '2026-10-08'), /无可确认/);
});

test('preview and the actual legacy prompt both carry the conversation data', () => {
  const context = load([{ id: 1, title: '数学讨论', messages: [msg(8, '学习积分')] }]);
  vm.runInContext(fs.readFileSync('js/prompts.js', 'utf8'), context);
  const data = { aiConversationSummaries: context.collectReportAiConversations('2026-10-08') };
  const block = context.formatReportAiConversations(data.aiConversationSummaries, '2026-10-08');
  assert.match(context.reportPromptData('evening', data), /学习积分/);
  assert.match(context.reportPromptData('evening', data, '📊 **日报数据**\n' + block + '\n---\n建议'), /学习积分/);
});

test('morning and evening collectors pass yesterday and today into report prompt data', () => {
  const context = load([{ id: 1, messages: [msg(7, '昨日讨论'), msg(8, '今日讨论')] }]);
  Object.assign(context, {
    todos: [], notes: [], getTodayStr: () => '2026-10-08', getPastDateStr: () => '2026-10-07',
    loadCheckinData: () => ({ dates: [] }), getFocusItemsForDate: () => ({ items: [] }),
    getTodayFocusItems: () => ({ items: [] }), collectReportLongTermGoals: () => [],
    getDailyReportConv: () => null, buildAiCalendarSnapshot: () => '',
    buildAiTodoTreeSnapshot: () => '', buildAiNoteTreeSnapshot: () => ''
  });
  const settings = fs.readFileSync('js/settings.js', 'utf8');
  for (const name of ['collectDailyReportData', 'collectEveningReportData']) {
    const start = settings.indexOf('function ' + name + '(');
    const end = settings.indexOf('\n}', start);
    vm.runInContext(settings.slice(start, end + 2), context);
  }
  const morning = context.collectDailyReportData().aiConversationSummaries;
  const evening = context.collectEveningReportData().aiConversationSummaries;
  assert.equal(morning[0].date, '2026-10-07');
  assert.match(morning[0].excerpts, /昨日讨论/);
  assert.doesNotMatch(morning[0].excerpts, /今日讨论/);
  assert.equal(evening[0].date, '2026-10-08');
  assert.match(evening[0].excerpts, /今日讨论/);
  assert.doesNotMatch(evening[0].excerpts, /昨日讨论/);
});

test('tree writes date new messages and preserves dates through trimming and migration', () => {
  const context = vm.createContext({ window: {}, genId: (() => { let id = 0; return () => ++id; })() });
  vm.runInContext(fs.readFileSync('js/ai-tree.js', 'utf8'), context);
  const conv = { messages: [] };
  context.appendMessage(conv, msg(7, '昨日'));
  context.appendMessage(conv, msg(8, '今日'));
  const beforeAppend = Date.now();
  context.appendMessage(conv, { role: 'assistant', content: '新回复' });
  assert.ok(conv.messages[2].timestamp >= beforeAppend);
  context.trimConvMessages(conv, 2);
  assert.equal(conv.messages[0].timestamp, ts(8));
  const old = { messages: [{ role: 'user', time: '12:00', content: '日期未知' }] };
  context.ensureTree(old);
  assert.equal(old.messages[0].timestamp, null);
});
