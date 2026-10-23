const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const settings = fs.readFileSync('js/settings.js', 'utf8');
function load(context, name, async = false) {
  const start = settings.indexOf(`${async ? 'async ' : ''}function ${name}(`);
  const end = settings.indexOf('\n}', start);
  vm.runInContext(settings.slice(start, end + 2), context);
}
function harness() {
  const context = vm.createContext({ window: {}, console, getMaxFocusCount: () => 3 });
  vm.runInContext(fs.readFileSync('js/ai-tools.js', 'utf8'), context);
  load(context, 'buildDailyReportHistory');
  return context;
}
const toolCall = { id: 'call-1', type: 'function', function: { name: 'list_notes', arguments: '{}' } };

test('report context excludes native, orphan and legacy tool traffic without modifying saved history', () => {
  const ctx = harness();
  const conv = { messages: [
    { role: 'tool', tool_call_id: 'orphan', content: 'orphan receipt' },
    { role: 'user', content: '请关注复习安排', id: 1 },
    { role: 'assistant', content: 'UI tool display', _apiContent: '', tool_calls: [toolCall] },
    { role: 'tool', tool_call_id: 'call-1', content: 'native receipt' },
    { role: 'assistant', content: '已核对\n<tool_call>{"action":"list_notes","params":{}}</tool_call>' },
    { role: 'system', content: 'legacy receipt', _toolInfo: { results: ['receipt'] } },
    { role: 'assistant', content: '昨日回顾', reasoning: 'private reasoning', keyName: 'key' }
  ] };
  const saved = JSON.stringify(conv);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.buildDailyReportHistory(conv))), [
    { role: 'user', content: '请关注复习安排' },
    { role: 'assistant', content: '已核对' },
    { role: 'assistant', content: '昨日回顾' }
  ]);
  assert.equal(JSON.stringify(conv), saved);
});

test('report history limits prose turns after removing tool traffic', () => {
  const ctx = harness();
  const messages = Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: `request ${i}` }));
  messages.push({ role: 'assistant', content: '', tool_calls: [toolCall] });
  messages.push(...Array.from({ length: 21 }, () => ({ role: 'tool', tool_call_id: 'call-1', content: 'receipt' })));
  const result = ctx.buildDailyReportHistory({ messages });
  assert.equal(result.length, 20);
  assert.equal(result[0].content, 'request 5');
  assert.equal(result.at(-1).content, 'request 24');
});

for (const [name, feature] of [['generateDailyReport', 'morning_report'], ['generateEveningReport', 'evening_report']]) {
  test(`${feature} sends clean history and persists the generated report`, async () => {
    const ctx = harness();
    const conv = { id: 1, messages: [
      { role: 'assistant', content: '', _apiContent: '', tool_calls: [toolCall] },
      { role: 'tool', content: 'receipt', tool_call_id: 'call-1' },
      ...Array.from({ length: 19 }, (_, i) => ({ role: 'user', content: `preference ${i}` }))
    ] };
    // The old slice starts on a tool result: reproduce the reported rejection.
    assert.equal(conv.messages.slice(-20)[0].role, 'tool');
    const data = { todayStr: '2026-10-20', yesterdayStr: '2026-10-19' };
    for (const key of ['focusItems', 'todayFocusItems', 'tomorrowFocusItems', 'longTermGoals',
      'yesterdayDoneTodos', 'todayDoneTodos', 'overdueTodos', 'todayDueTodos', 'tomorrowDueTodos',
      'ydayCreatedNotes', 'ydayEditedNotes', 'todayCreatedNotes', 'todayEditedNotes',
      'ydayTimerSessions', 'todayTimerSessions', 'reviewDueNotes']) data[key] = [];
    let request, saved = 0, marked = 0;
    Object.assign(ctx, {
      localStorage: { getItem: () => null },
      getEffectiveReportApiConfig: () => ({ apiKey: 'test', baseUrl: 'https://example.test' }),
      getDailyReportConv: () => conv, collectDailyReportData: () => data, collectEveningReportData: () => data,
      formatReportLongTermGoals: () => '', reportCheckinStreakText: () => '', reportHabitLines: () => '',
      getPromptTemplate: id => id, resolvePromptTemplate: (template, values) => template + values.userInstruction,
      reportPromptData: () => '', showMiniToast() {}, callAiApi() {},
      callAiApiForFinalText: async (messages, config, conversation, options) => {
        request = { messages, options };
        assert.equal(messages.some(m => m.role === 'tool' || m.tool_calls || m.tool_call_id), false);
        assert.ok(messages.some(m => m.content === 'preference 18'));
        assert.match(messages[0].content, /关注明天复习/);
        return { cleanText: '完成的日报', finishReason: 'stop' };
      },
      appendMessage: (c, m) => c.messages.push(m), trimConvMessages() {},
      aiConvs: [conv], activeConvId: null, getActiveKeyDisplayName: () => 'test',
      saveData: () => { saved++; }, sendNotification() {}, markEveningReportDone: () => { marked++; }
    });
    load(ctx, name, true);
    const result = name === 'generateDailyReport' ? await ctx[name](true, '关注明天复习') : await ctx[name]('关注明天复习');
    assert.equal(result.ok, true);
    assert.equal(request.options.feature, feature);
    assert.equal(request.options.disableTools, true);
    assert.equal(conv.messages.at(-1).content, '完成的日报');
    assert.equal(saved, 1);
    if (feature === 'evening_report') assert.equal(marked, 1);
  });
}
