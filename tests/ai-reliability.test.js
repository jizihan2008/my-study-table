'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function source(name) { return fs.readFileSync(path.join(__dirname, '..', 'js', name + '.js'), 'utf8'); }
function storage() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
}
function harness() {
  let id = 0;
  const loading = new Set();
  const stopped = new Set();
  const ctx = {
    window: { _aiResumeInited: true }, console, localStorage: storage(),
    genId: () => ++id, document: { getElementById: () => null },
    getEffectiveApiConfig: () => ({ apiKey: 'fake', name: 'original', model: 'test', contextLimit: 20 }),
    getActiveConvId: () => 'foreground', getActiveConv: () => ({ id: 'foreground', _webSearchMode: 'native' }),
    isAiLoading: id => loading.has(id), setAiLoading: (id, value) => value ? loading.add(id) : loading.delete(id),
    isAiStopRequested: id => stopped.has(id), setAiStopRequested: (id, value) => value ? stopped.add(id) : stopped.delete(id),
    clearAiStreamingDraft() {}, setAiStreamingDraft() {}, safeSaveAiConvs() {}, sendAiNotification() {},
    renderAiMessages() {}, renderTodos() {}, renderLinks() {}, renderNotes() {}, renderToday() {},
    isDebugMode: () => false, buildDeepThinkParams: () => ({}), getMaxFocusCount: () => 3,
    automations: [], saveData() { return true; }, startAutomationTimer() {},
    setTimeout, clearTimeout
  };
  vm.createContext(ctx);
  for (const file of ['ai-tree', 'ai-attach', 'ai-tools', 'ai-api', 'ai-send']) {
    // aiAttachments 在应用里由 js/settings.js 以 let 声明（全局词法绑定），测试里显式补上，
    // 否则对 ctx.aiAttachments 的赋值只会写到宿主对象上，源码里的 push/读改写都看不到
    vm.runInContext(file === 'ai-attach' ? 'let aiAttachments = [];\n' + source(file) : source(file), ctx);
  }
  // 词法绑定无法从宿主直接读写 → 通过 VM 内代码操作
  ctx.setAiAttachments = list => vm.runInContext('aiAttachments = __list', Object.assign(ctx, { __list: list }));
  ctx.getAiAttachments = () => vm.runInContext('aiAttachments.slice()', ctx);
  ctx.buildToolsSystemPrompt = (conv, cfg) => 'model=' + cfg.model + ';search=' + conv._webSearchMode;
  return ctx;
}
function conversation(ctx) {
  const conv = { id: 'background', systemPrompt: '' };
  ctx.initTreeOnConv(conv);
  ctx.appendMessage(conv, { role: 'user', content: 'question' });
  return conv;
}
const result = (tools = [], text = 'final answer') => ({ toolCalls: tools, cleanText: text, rawReply: text, finishReason: 'stop' });

test('tree normalization repairs stale message cache from the active path', () => {
  const ctx = harness();
  const conv = conversation(ctx);
  ctx.appendMessage(conv, { role: 'assistant', content: 'answer' });
  conv.messages = conv.messages.slice(0, 1);
  ctx.ensureTree(conv);
  assert.deepEqual(Array.from(conv.messages, m => m.content), ['question', 'answer']);
});

test('identical edited user branches merge without dropping either reply chain', () => {
  const ctx = harness();
  const conv = { id: 'duplicates' };
  ctx.initTreeOnConv(conv);
  const firstUser = ctx.appendMessage(conv, { role: 'user', content: 'same question' });
  const firstReply = ctx.appendMessage(conv, { role: 'assistant', content: 'first answer' });
  const duplicateUser = ctx.createBranchFromEdit(conv, firstUser, 'same question');
  const secondReply = ctx.appendMessage(conv, { role: 'assistant', content: 'second answer' });

  ctx.ensureTree(conv);

  const userChildren = conv.tree.root.children.filter(id => conv.tree[id]?.role === 'user');
  assert.equal(userChildren.length, 1);
  const merged = conv.tree[userChildren[0]];
  assert.deepEqual(new Set(merged.children), new Set([firstReply, secondReply]));
  assert.equal(conv.activePath.includes(duplicateUser), true);
  assert.equal(conv.messages.at(-1).content, 'second answer');
});

test('exported missing-message shape reconnects the stopped reply before continue', () => {
  const ctx = harness();
  const conv = { id: 'reported-log' };
  ctx.initTreeOnConv(conv);
  const originalUser = ctx.appendMessage(conv, { role: 'user', content: 'plan linear algebra' });
  ctx.appendMessage(conv, { role: 'assistant', content: 'checking your todos' });
  const toolResult = ctx.appendMessage(conv, { role: 'system', content: 'tool results' });
  const continueUser = ctx.appendMessage(conv, { role: 'user', content: 'continue' });

  const duplicateUser = ctx.createBranchFromEdit(conv, originalUser, 'plan linear algebra');
  const hiddenReply = ctx.appendMessage(conv, { role: 'assistant', content: 'the long stopped reply\n\n> stopped: ⏹️' });
  ctx.switchBranch(conv, continueUser);
  conv.messages = [conv.tree[originalUser]];

  ctx.ensureTree(conv);

  assert.equal(conv.tree.root.children.length, 1);
  const canonicalUser = conv.tree.root.children[0];
  assert.equal(conv.activePath.at(-1), continueUser);
  assert.deepEqual(Array.from(conv.messages, m => m.content), [
    'plan linear algebra', 'checking your todos', 'tool results',
    'the long stopped reply\n\n> stopped: ⏹️', 'continue'
  ]);
  assert.equal([originalUser, duplicateUser].includes(canonicalUser), true);
  assert.equal(conv.tree[hiddenReply].parentId, toolResult);
  assert.equal(conv.tree[continueUser].parentId, hiddenReply);
  assert.equal(conv.tree[canonicalUser].children.length, 1);
});

test('editing a user message without changing its text does not create a branch', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  const userId = conv.activePath.at(-1);
  ctx.getActiveConv = () => conv;
  await ctx.sendEditedMessage(userId, '  question  ');
  assert.equal(conv.tree.root.children.length, 1);
  assert.equal(conv.tree[userId].children.length, 0);
});

test('missing policy settings use 60 seconds, two retries and exponential backoff', async () => {
  const delays = [];
  const window = {};
  let attempts = 0;
  vm.runInNewContext(source('ai-client'), {
    window, localStorage: storage(), AbortController, DOMException,
    setTimeout(fn, ms) { delays.push(ms); if (ms < 60000) queueMicrotask(fn); return 1; }, clearTimeout() {},
    fetch: async () => { attempts++; return { status: 503, headers: { get: () => null } }; }
  });
  await window.AIClient.fetchWithPolicy('/fake');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [60000, 500, 60000, 1000, 60000]);
});

test('stop during retry backoff cancels without sending another request', async () => {
  const window = {};
  let attempts = 0;
  let onBackoff;
  const backoff = new Promise(resolve => { onBackoff = resolve; });
  vm.runInNewContext(source('ai-client'), {
    window, localStorage: storage(), AbortController, DOMException,
    setTimeout(fn, ms) { if (ms === 500) onBackoff(); return setTimeout(fn, ms); }, clearTimeout,
    fetch: async () => { attempts++; return { status: 503, headers: { get: () => null } }; }
  });
  const request = window.AIClient.fetchWithPolicy('/fake', {}, { scope: 'background' });
  await backoff;
  assert.equal(window.AIClient.cancel('background'), 1);
  await assert.rejects(request, /已取消/);
  assert.equal(attempts, 1);
  assert.equal(window.AIClient.cancel('background'), 0);
});

test('JSON body consumption releases request control even on failure', async () => {
  const ctx = harness();
  let released = 0;
  await assert.rejects(ctx.readAiResponseJson({ json: async () => { throw Error('broken body'); }, _aiRequestControl: { release() { released++; }, controller: new AbortController() } }), /broken body/);
  assert.equal(released, 1);
});

test('regeneration saves exactly one final answer after a tool chain', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  const userId = conv.activePath.at(-1);
  let calls = 0;
  ctx.callAiApi = async () => ++calls === 1 ? result([{ action: 'list_todos', params: {} }], 'query') : result();
  ctx.executeToolCall = async () => 'tasks';
  await ctx.regenerateFromUserNode(conv, userId);
  assert.equal(conv.messages.filter(m => m.content === 'final answer').length, 1);
  assert.equal(conv.messages.at(-1).role, 'assistant');
  assert.equal(conv.messages.at(-2).role, 'system');
  assert.equal(conv.messages.at(-1).keyName, 'original');
  assert.equal(ctx.isAiLoading(conv.id), false);
});

test('background request uses its own stop flag and original model across rounds', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  conv._webSearchMode = 'external';
  ctx.setAiStopRequested('foreground', true);
  const seen = [];
  const cfg = { apiKey: 'fake', model: 'original', contextLimit: 20 };
  ctx.callAiApi = async (messages, current) => {
    seen.push({ prompt: messages[0].content, model: current.model });
    cfg.model = 'changed';
    conv._webSearchMode = 'native';
    return seen.length === 1 ? result([{ action: 'list_todos', params: {} }]) : result();
  };
  ctx.executeToolCall = async () => 'tasks';
  const output = await ctx.runToolCallLoop(cfg, conv);
  assert.equal(output.stopped, false);
  assert.equal(seen.length, 2);
  assert.ok(seen.every(row => row.model === 'original' && row.prompt.includes('search=external')));
});

test('background stop prevents its API call', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  ctx.setAiStopRequested(conv.id, true);
  ctx.callAiApi = async () => { throw Error('must not call'); };
  assert.equal((await ctx.runToolCallLoop({}, conv)).stopped, true);
});

test('quest condition tools persist changes to the same task-line store they mutate', async () => {
  const ctx = harness();
  const clone = value => JSON.parse(JSON.stringify(value));
  let persisted = { quests: [{ id: 101, title: 'chapter', conditions: [] }] };
  ctx.loadTaskLineStore = () => clone(persisted);
  ctx.saveTaskLineStore = store => { persisted = clone(store); return true; };
  // Reproduce the old split-read behavior: this returns a different object from
  // the one saveTaskLineStore would receive if the tool loaded the store again.
  ctx.tlGetQuest = id => ctx.loadTaskLineStore().quests.find(q => q.id === id) || null;
  ctx.findTodo = id => id === 201 ? { id, text: 'finish exercises' } : null;
  ctx.notes = [{ id: 301, type: 'note', title: 'chapter notes' }];
  ctx.tlMakeTodoCond = id => ({ type: 'todo', todoId: id, label: 'finish exercises' });
  ctx.tlMakeNoteCond = id => ({ type: 'note', noteId: id, label: 'chapter notes' });
  ctx.tlMakeTimerCond = (id, minutes, targetType) => ({ type: 'timer', targetId: id, minutes, targetType, label: 'focus 30 min' });
  ctx.tlRefreshQuestStatus = () => {};
  ctx.renderTaskLine = () => {};

  assert.match(await ctx.executeToolCall('quest_link_todo', { questId: 101, todoId: 201 }), /^\u2705/);
  assert.match(await ctx.executeToolCall('quest_link_note', { questId: 101, noteId: 301 }), /^\u2705/);
  assert.match(await ctx.executeToolCall('quest_link_timer', { questId: 101, targetId: 201, minutes: 30 }), /^\u2705/);
  assert.match(await ctx.executeToolCall('quest_add_manual_cond', { questId: 101, label: 'manual check' }), /^\u2705/);

  assert.deepEqual(persisted.quests[0].conditions.map(c => c.type), ['todo', 'note', 'timer', 'manual']);
  assert.deepEqual(ctx.loadTaskLineStore().quests[0].conditions.map(c => c.label), [
    'finish exercises', 'chapter notes', 'focus 30 min', 'manual check'
  ]);
});

test('quest condition tools do not report success when persistence fails', async () => {
  const ctx = harness();
  ctx.loadTaskLineStore = () => ({ quests: [{ id: 101, conditions: [] }] });
  ctx.saveTaskLineStore = () => false;
  ctx.renderTaskLine = () => { throw Error('must not render an unsaved condition'); };

  assert.equal(
    await ctx.executeToolCall('quest_add_manual_cond', { questId: 101, label: 'manual check' }),
    '❌ 完成条件保存失败'
  );
});

test('malformed tool protocol detector recognizes DSML, escaped tags and naked known actions', () => {
  const ctx = harness();
  assert.equal(ctx.detectMalformedToolProtocol('<｜DSML｜function_calls><｜DSML｜invoke name="quest_create">').kind, 'dsml');
  assert.equal(ctx.detectMalformedToolProtocol('\\<tool\\_call>{"action":"quest\\_create","params":{}}').kind, 'tool_tag');
  assert.equal(ctx.detectMalformedToolProtocol('{"action":"quest_create","params":{}}').kind, 'bare_json');
  assert.equal(ctx.detectMalformedToolProtocol('DSML 是一种工具调用协议。'), null);
  assert.equal(ctx.detectMalformedToolProtocol('{"action":"not_a_real_tool","params":{}}'), null);
});

test('DSML parser converts string and JSON parameters into ordinary tool calls', () => {
  const ctx = harness();
  const dsml = [
    '调用中',
    '<｜DSML｜function_calls>',
    '<｜DSML｜invoke name="quest_create">',
    '<｜DSML｜parameter name="lineId" string="false">1789186082952014</｜DSML｜parameter>',
    '<｜DSML｜parameter name="title" string="true">线性&amp;代数</｜DSML｜parameter>',
    '<｜DSML｜parameter name="deps" string="false">[1,2]</｜DSML｜parameter>',
    '</｜DSML｜invoke>',
    '</｜DSML｜function_calls>',
    '请稍候'
  ].join('\n');
  const parsed = ctx.extractToolCalls(dsml);
  assert.equal(parsed.toolCalls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.toolCalls[0])), {
    action: 'quest_create',
    params: { lineId: 1789186082952014, title: '线性&代数', deps: [1, 2] }
  });
  assert.equal(parsed.cleanText, '调用中\n\n请稍候');
});

test('malformed or unknown DSML is rejected as a whole instead of partially executing', () => {
  const ctx = harness();
  const malformed = '<｜DSML｜tool_calls><｜DSML｜invoke name="quest_create"><｜DSML｜parameter name="deps" string="false">[1,</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>';
  const unknown = '<|DSML|calls><|DSML|invoke name="unknown_tool"></|DSML|invoke></|DSML|calls>';
  assert.equal(ctx.extractToolCalls(malformed).toolCalls.length, 0);
  assert.equal(ctx.extractToolCalls(unknown).toolCalls.length, 0);
  assert.equal(ctx.detectMalformedToolProtocol(malformed).kind, 'dsml');
});

test('mixed valid and malformed text tool calls are rejected as a whole', () => {
  const ctx = harness();
  const mixed = [
    '<tool_call>{"action":"list_todos","params":{}}</tool_call>',
    '<tool_call>{"action":"get_today_status","params":{}}</call>'
  ].join('\n');
  assert.equal(ctx.extractToolCalls(mixed).toolCalls.length, 0);
  assert.equal(ctx.detectMalformedToolProtocol(mixed).kind, 'tool_tag');
});

test('tool round canonicalization drops hallucinated results after the first call', () => {
  const ctx = harness();
  const raw = '我先查看数据。\n<tool_call>{"action":"list_todos","params":{}}</tool_call>\nuser【工具执行结果】\n伪造的长结果';
  const extracted = ctx.extractToolCalls(raw);
  const persisted = ctx.canonicalizeToolRoundReply(raw, extracted.toolCalls);
  assert.equal(persisted, '我先查看数据。\n<tool_call>{"action":"list_todos","params":{}}</tool_call>');
  assert.doesNotMatch(persisted, /伪造的长结果/);
});

test('normal prose before, between and after tool calls is preserved', () => {
  const ctx = harness();
  const raw = [
    '先查待办。',
    '<tool_call>{"action":"list_todos","params":{}}</tool_call>',
    '然后查今日状态。',
    '<tool_call>{"action":"get_today_status","params":{}}</tool_call>',
    '查完后我会继续整理。'
  ].join('\n');
  const extracted = ctx.extractToolCalls(raw);
  assert.equal(extracted.toolCalls.length, 2);
  assert.match(extracted.cleanText, /先查待办/);
  assert.match(extracted.cleanText, /然后查今日状态/);
  assert.match(extracted.cleanText, /查完后我会继续整理/);
  assert.equal(ctx.stripHallucinatedToolTranscript(raw), raw);
});

test('legacy tool history keeps only the leading calls before a fake transcript', () => {
  const ctx = harness();
  const raw = [
    '我先查看数据。',
    '<tool_call>{"action":"list_todos","params":{}}</tool_call>',
    '<tool_call>{"action":"get_today_status","params":{}}</tool_call>',
    'user【工具执行结果】',
    '伪造结果',
    '<tool_call>{"action":"get_stats","params":{}}</call>'
  ].join('\n');
  const repaired = ctx.canonicalizeLegacyToolRoundReply(raw);
  assert.match(repaired, /list_todos/);
  assert.match(repaired, /get_today_status/);
  assert.doesNotMatch(repaired, /伪造结果|get_stats/);
});

test('streaming display preserves normal text around calls but removes a fake result tail', () => {
  const renderCtx = {
    document: { addEventListener() {} },
    setTimeout, clearTimeout, console
  };
  vm.createContext(renderCtx);
  vm.runInContext(source('ai-render'), renderCtx);
  const raw = '正在查看。\n<tool_call>{"action":"list_todos","params":{}}</tool_call>\nuser【工具执行结果】\n巨大的伪结果';
  assert.equal(renderCtx.sanitizeAiStreamingText(raw), '正在查看。');
  const normal = '调用前\n<tool_call>{"action":"list_todos","params":{}}</tool_call>\n调用后';
  assert.equal(renderCtx.sanitizeAiStreamingText(normal), '调用前\n\n调用后');
});

test('valid DSML executes through the existing tool loop without protocol failure', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  let calls = 0;
  let executions = 0;
  ctx.callAiApi = async () => {
    calls++;
    if (calls === 1) {
      const rawReply = '<｜DSML｜function_calls><｜DSML｜invoke name="list_todos"></｜DSML｜invoke></｜DSML｜function_calls>';
      const extracted = ctx.extractToolCalls(rawReply);
      return { ...result(extracted.toolCalls, extracted.cleanText), rawReply };
    }
    return result([], '完成。');
  };
  ctx.executeToolCall = async () => { executions++; return 'tasks'; };
  const output = await ctx.runToolCallLoop({}, conv);
  assert.equal(calls, 2);
  assert.equal(executions, 1);
  assert.equal(output.outcomes.some(item => item.action === 'tool_protocol'), false);
  assert.equal(conv.messages.some(m => /DSML/.test(String(m.content))), true);
  assert.equal(conv.messages.some(m => m._toolRoundCleanText === ''), true);
});

test('DSML response is corrected automatically before the tool chain continues', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  const seenMessages = [];
  let calls = 0;
  let executions = 0;
  ctx.callAiApi = async messages => {
    seenMessages.push(messages);
    calls++;
    if (calls === 1) {
      const dsml = '<｜DSML｜function_calls><｜DSML｜invoke name="list_todos"></｜DSML｜invoke></｜DSML｜function_calls>';
      return result([], dsml);
    }
    if (calls === 2) return result([{ action: 'list_todos', params: {} }], 'query');
    return result([], '已经查看完成。');
  };
  ctx.executeToolCall = async () => { executions++; return 'tasks'; };

  const output = await ctx.runToolCallLoop({}, conv);

  assert.equal(calls, 3);
  assert.equal(executions, 1);
  assert.match(output.finalCleanText, /^已经查看完成。/);
  assert.match(output.finalCleanText, /成功 1 项，失败 1 项/);
  assert.ok(seenMessages[1].some(m => m.role === 'system' && /工具指令格式错误/.test(m.content)));
  assert.equal(conv.messages.some(m => m._malformedToolProtocol && /DSML/.test(String(m.content))), true);
  assert.equal(output.outcomes[0].action, 'tool_protocol');
  assert.equal(output.outcomes[0].status, 'failed');
});

test('repeated malformed tool output uses the ordinary tool-loop limit', async () => {
  const ctx = harness();
  let calls = 0;
  ctx.callAiApi = async () => {
    calls++;
    return result([], '{"action":"quest_create","params":{}}');
  };
  const output = await ctx.runToolCallLoop({}, conversation(ctx));
  assert.equal(calls, 3);
  assert.match(output.finalCleanText, /已达到工具调用轮次上限/);
  assert.equal(output.outcomes.filter(item => item.action === 'tool_protocol' && item.status === 'failed').length, 3);
});

test('pending requests are isolated and legacy entries migrate without storing credentials', () => {
  const ctx = harness();
  ctx.localStorage.setItem('study_ai_pending', JSON.stringify({ convId: 'a', userNodeId: 1 }));
  ctx.setAiPendingRequest('b', 2, 'key-id');
  ctx.clearAiPendingRequest('a');
  assert.equal(ctx.getAiPendingRequests().b.userNodeId, 2);
  assert.equal(Object.keys(ctx.getAiPendingRequests()).length, 1);
  ctx.clearAiPendingRequest('b');
  assert.equal(ctx.localStorage.getItem('study_ai_pending'), null);
});

test('reordered JSON parameters cannot repeat a write within or across rounds', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  let writes = 0;
  let calls = 0;
  ctx.callAiApi = async () => ++calls <= 2 ? result([
    { action: 'add_todo', params: { text: 'one', tags: 'two' } },
    { action: 'add_todo', params: { tags: 'two', text: 'one' } }
  ]) : result();
  ctx.executeToolCall = async () => { writes++; return '✅ saved'; };
  const output = await ctx.runToolCallLoop({}, conv);
  assert.equal(writes, 1);
  assert.equal(output.outcomes.filter(o => o.status === 'duplicate').length, 3);
});

test('dependent tools run sequentially and exceptions are recorded without hiding later results', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  let created = false;
  let calls = 0;
  ctx.callAiApi = async () => ++calls === 1 ? result([
    { action: 'add_todo', params: { text: 'created' } }, { action: 'update_todo', params: { id: 1 } }, { action: 'list_todos', params: {} }
  ]) : result();
  ctx.executeToolCall = async action => {
    if (action === 'add_todo') { await Promise.resolve(); created = true; return '✅ created'; }
    assert.equal(created, true);
    if (action === 'update_todo') throw Error('write failed');
    return 'tasks';
  };
  const output = await ctx.runToolCallLoop({}, conv);
  assert.match(output.finalCleanText, /失败 2 项/);
  assert.deepEqual(Array.from(output.outcomes, o => o.status), ['rolled_back', 'failed', 'success']);
  assert.ok(output.outcomes.every(o => typeof o.callId === 'string' && o.callId.length > 0));
});

test('tool parameters are rejected before a handler can mutate data', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  let executions = 0;
  let calls = 0;
  ctx.callAiApi = async () => ++calls === 1
    ? result([{ action: 'update_todo', params: { id: 'not-a-number', text: 'unsafe' } }])
    : result();
  ctx.executeToolCall = async () => { executions++; return '✅ changed'; };
  const output = await ctx.runToolCallLoop({}, conv);
  assert.equal(executions, 0);
  assert.equal(output.outcomes[0].status, 'failed');
  assert.match(conv.messages.at(-1).content, /结构化状态/);
});

test('tool validation rejects unknown fields, invalid dates and quest dependency cycles', () => {
  const ctx = harness();
  assert.equal(ctx.validateAiToolCall('add_todo', { text: 'x', surprise: true }).ok, false);
  assert.equal(ctx.validateAiToolCall('add_todo', { text: 'x', dueDate: '2026-02-30' }).ok, false);
  ctx.loadTaskLineStore = () => ({
    lines: [{ id: 10 }],
    quests: [{ id: 1, deps: [] }, { id: 2, deps: [1] }]
  });
  assert.equal(ctx.validateAiToolCall('quest_update', { id: 1, deps: [2] }).ok, false);
  assert.equal(ctx.validateAiToolCall('quest_create', { lineId: 10, title: 'new', deps: [999] }).ok, false);
});

test('destructive tools require explicit deletion intent before execution', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  let calls = 0;
  let executions = 0;
  ctx.callAiApi = async () => ++calls === 1 ? result([{ action: 'delete_todo', params: { id: 1 } }]) : result();
  ctx.executeToolCall = async () => { executions++; return '✅ deleted'; };
  const output = await ctx.runToolCallLoop({}, conv);
  assert.equal(executions, 0);
  assert.equal(output.outcomes[0].status, 'failed');
  assert.match(output.outcomes[0].error, /删除意图/);
});

test('native function tools use strict schemas and native calls preserve call IDs', () => {
  const ctx = harness();
  const conv = conversation(ctx);
  conv.tree[conv.activePath.at(-1)].content = '创建一个待办';
  conv.messages.at(-1).content = '创建一个待办';
  const built = ctx.buildStreamingRequestBody([], {
    model: 'gpt-5', baseUrl: 'https://api.openai.com/v1', temperature: 0.2
  }, conv);
  const addTodo = built.body.tools.find(tool => tool.function?.name === 'add_todo');
  assert.ok(addTodo);
  assert.equal(addTodo.function.parameters.additionalProperties, false);
  assert.ok(addTodo.function.parameters.required.includes('text'));
  assert.equal(built.body.tools.some(tool => tool.function?.name === 'delete_todo'), false);
  assert.equal(built.body.tools.some(tool => tool.function?.name === 'toggle_todo'), false);
  assert.equal(built.body.tools.some(tool => tool.function?.name === 'set_todo_completed'), true);

  const calls = ctx.parseNativeLocalToolCalls([{ id: 'call-123', function: { name: 'add_todo', arguments: '{"text":"read"}' } }]);
  assert.equal(calls[0].action, 'add_todo');
  assert.equal(calls[0].params.text, 'read');
  assert.equal(calls[0].callId, 'call-123');
});

test('tool result budgets cap individual and aggregate context growth', () => {
  const ctx = harness();
  assert.ok(ctx.boundAiToolResult('x'.repeat(20000)).length < 12500);
});

test('consecutive read tools run concurrently while preserving result order', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  ctx.callAiApi = async () => ++calls === 1 ? result([
    { action: 'list_todos', params: {} }, { action: 'list_notes', params: {} }, { action: 'list_links', params: {} }
  ]) : result();
  ctx.executeToolCall = async action => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, action === 'list_todos' ? 12 : 2));
    active--;
    return action;
  };
  await ctx.runToolCallLoop({}, conv);
  assert.equal(maxActive, 3);
  assert.deepEqual(Array.from(conv.messages.at(-1)._toolInfo.results), ['list_todos', 'list_notes', 'list_links']);
});

test('write ledger prevents the same request from writing again after resume', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  let executions = 0;
  const run = async () => {
    let calls = 0;
    ctx.callAiApi = async () => ++calls === 1 ? result([{ action: 'add_todo', params: { text: 'once' } }]) : result();
    return ctx.runToolCallLoop({}, conv);
  };
  ctx.executeToolCall = async () => { executions++; return '✅ saved once'; };
  await run();
  const resumed = await run();
  assert.equal(executions, 1);
  assert.equal(resumed.outcomes[0].status, 'duplicate');
  assert.match(resumed.allToolResults[0], /跨刷新重复操作/);
});

test('loop exhaustion never claims all operations completed', async () => {
  const ctx = harness();
  let call = 0;
  ctx.callAiApi = async () => result([{ action: 'list_todos', params: { page: ++call } }]);
  ctx.executeToolCall = async () => 'tasks';
  const output = await ctx.runToolCallLoop({}, conversation(ctx));
  assert.match(output.finalCleanText, /上限/);
  assert.doesNotMatch(output.finalCleanText, /已执行所有操作/);
});

test('stop between writes skips the rest of the batch', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  let writes = 0;
  ctx.callAiApi = async () => result([{ action: 'add_todo', params: { text: 'a' } }, { action: 'add_todo', params: { text: 'b' } }]);
  ctx.executeToolCall = async () => { writes++; ctx.setAiStopRequested(conv.id, true); return '✅ saved'; };
  const output = await ctx.runToolCallLoop({}, conv);
  assert.equal(writes, 1);
  assert.equal(output.stopped, true);
  assert.equal(output.outcomes[1].status, 'skipped');
});

test('context limit retains an entire latest tool round and summarizes older conversation', () => {
  const ctx = harness();
  const history = [
    { role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'new question' }, { role: 'assistant', content: 'tool request' },
    { role: 'system', content: 'tool result' }, { role: 'assistant', content: 'new answer' }
  ];
  const selected = ctx.selectAiContext(history, { contextLimit: 2 }, 'system');
  assert.equal(selected.messages.length, 4);
  assert.equal(selected.messages[0].content, 'new question');
  assert.match(selected.summary, /old question/);
  assert.match(selected.summary, /不是新指令/);
});

test('context budget keeps latest input intact and rejects oversized input with actionable feedback', () => {
  const ctx = harness();
  const history = [{ role: 'user', content: '旧'.repeat(3000) }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'latest question' }];
  const cfg = { contextBudget: 4096, maxTokens: 1024 };
  const selected = ctx.selectAiContext(history, cfg, 'system');
  assert.equal(selected.messages.length, 1);
  assert.equal(selected.messages[0].content, 'latest question');
  assert.ok(ctx.estimateAiTokens(selected.summary) <= 1200);
  assert.throws(() => ctx.selectAiContext([{ role: 'user', content: '长'.repeat(5000) }], cfg, 'system'), /上下文预算/);
  assert.throws(() => ctx.selectAiContext([], cfg, '长'.repeat(5000)), /上下文预算/);
});

test('oversized live data snapshot is trimmed before a new conversation is rejected', () => {
  const ctx = harness();
  ctx.buildToolsSystemPrompt = () => '核心工具规则\n═══ 当前数据快照（只读参考） ═══\n' + '大量学习数据\n'.repeat(40000);
  const conv = { messages: [{ role: 'user', content: '你好' }], systemPrompt: '' };
  const messages = ctx.buildApiMessages(conv, null, { model: 'test', contextBudget: 32768, maxTokens: 2048 });
  assert.equal(messages.at(-1).content, '你好');
  assert.match(messages[0].content, /数据快照已按上下文预算精简/);
  assert.ok(ctx.estimateAiTokens(messages[0].content) <= 32768 - 2048 - 1536);
});

test('a full conversation system prompt override replaces the built-in prompt', () => {
  const ctx = harness();
  const conv = { messages: [{ role: 'user', content: '你好' }], systemPrompt: '当前对话专属系统提示词', systemPromptMode: 'full' };
  const messages = ctx.buildApiMessages(conv, null, { model: 'test', contextBudget: 32768, maxTokens: 2048 });
  assert.equal(messages[0].content, '当前对话专属系统提示词');
});

test('a legacy custom role is still appended to the built-in prompt', () => {
  const ctx = harness();
  const conv = { messages: [], systemPrompt: '请使用简洁语气', _webSearchMode: 'native' };
  const messages = ctx.buildApiMessages(conv, null, { model: 'test', contextBudget: 32768, maxTokens: 2048 });
  assert.match(messages[0].content, /^model=test;search=native/);
  assert.match(messages[0].content, /【用户自定义角色】请使用简洁语气$/);
});

test('context errors do not incorrectly blame API keys or network', () => {
  const ctx = harness();
  const text = ctx.formatAiRequestError(new Error('当前问题超过上下文预算'));
  assert.match(text, /更多设置/);
  assert.doesNotMatch(text, /API Key|网络连接/);
});

test('regeneration retains completed tool results when a subsequent request fails', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  const userId = conv.activePath.at(-1);
  let calls = 0;
  ctx.callAiApi = async () => {
    if (++calls === 1) return result([{ action: 'add_todo', params: { text: 'saved' } }]);
    throw Error('connection lost');
  };
  ctx.executeToolCall = async () => '✅ saved';
  await ctx.regenerateFromUserNode(conv, userId);
  assert.equal(conv.messages.at(-2).role, 'system');
  assert.match(conv.messages.at(-2).content, /saved/);
  assert.match(conv.messages.at(-1).content, /connection lost/);
});

test('native tool call IDs survive history construction and display names are not sent as API names', () => {
  const ctx = harness();
  const tool = { id: 'call-1', type: 'function', function: { name: '$web_search', arguments: '{}' } };
  const conv = { messages: [{ role: 'user', content: 'search' }, { role: 'assistant', content: '', tool_calls: [tool], keyName: '中文 Key 名称' }, { role: 'tool', content: '{}', tool_call_id: 'call-1' }] };
  const messages = ctx.buildApiMessages(conv, null, { model: 'kimi' });
  assert.equal(messages.at(-1).tool_call_id, 'call-1');
  assert.equal(messages.at(-2).tool_calls[0].id, 'call-1');
  assert.equal(messages.at(-2).name, undefined);
});

test('DeepSeek thinking history echoes reasoning_content for every assistant turn', () => {
  const ctx = harness();
  const conv = {
    messages: [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer', reasoning: 'full first reasoning' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'second answer' }
    ],
    systemPrompt: ''
  };
  const cfg = { model: 'deepseek-flash', deepThink: true, contextBudget: 32768, maxTokens: 2048 };
  const assistants = ctx.buildApiMessages(conv, null, cfg).filter(message => message.role === 'assistant');
  assert.equal(assistants[0].reasoning_content, 'full first reasoning');
  assert.equal(assistants[1].reasoning_content, '');
});

test('reasoning_content is omitted outside DeepSeek thinking mode', () => {
  const ctx = harness();
  const conv = { messages: [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'answer', reasoning: 'private reasoning' }], systemPrompt: '' };
  const disabled = ctx.buildApiMessages(conv, null, { model: 'deepseek-flash', deepThink: false });
  const other = ctx.buildApiMessages(conv, null, { model: 'other-model', deepThink: true });
  assert.equal(Object.hasOwn(disabled.at(-1), 'reasoning_content'), false);
  assert.equal(Object.hasOwn(other.at(-1), 'reasoning_content'), false);
});

test('model capability checks use supplied configuration rather than active selection', () => {
  const ctx = harness();
  ctx.getEffectiveApiConfig = () => ({ model: 'kimi' });
  assert.equal(ctx.isKimiModel({ model: 'other' }), false);
  const { body } = ctx.buildStreamingRequestBody([], { model: 'other', temperature: 0.5 });
  assert.equal(body.temperature, 0.5);
  assert.equal(body.max_tokens, 2048);
});

test('single reminders default to once and roll the next occurrence over local midnight', () => {
  const ctx = harness();
  const schedule = ctx.normalizeAutomationSchedule({ at: '08:00' }, new Date(2026, 8, 11, 23, 0));
  assert.equal(schedule.repeat, 'once');
  assert.equal(schedule.date, '2026-09-12');
});

test('reminders reject invalid times, impossible dates and past dates', () => {
  const ctx = harness();
  const now = new Date(2026, 8, 11, 12, 0);
  for (const params of [{ at: '25:00' }, { at: '12:99' }, { at: '15:00', date: '2026-02-30' }, { at: '08:00', date: '2026-09-11' }]) {
    assert.ok(ctx.normalizeAutomationSchedule(params, now).error);
  }
});

test('future one-time reminders do not fire early and overdue reminders catch up once', () => {
  const ctx = harness();
  const auto = { repeat: 'once', date: '2026-09-12', at: '08:00', enabled: true };
  assert.equal(ctx.isAutomationDue(auto, new Date(2026, 8, 11, 8, 0)), false);
  assert.equal(ctx.isAutomationDue(auto, new Date(2026, 8, 12, 9, 0)), true);
  auto.enabled = false;
  assert.equal(ctx.isAutomationDue(auto, new Date(2026, 8, 13, 9, 0)), false);
});

test('daily reminders respect last run date and legacy one-time schedules remain supported', () => {
  const ctx = harness();
  const now = new Date(2026, 8, 11, 9, 0);
  assert.equal(ctx.isAutomationDue({ repeat: 'daily', at: '08:00', lastRun: '2026-09-11 08:00' }, now), false);
  assert.equal(ctx.isAutomationDue({ repeat: 'once', at: '09:00' }, now), true);
});

test('reminder writes retain origin conversation, date and source and deduplicate across requests', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  const params = { at: '09:00', date: '2099-09-12', prompt: '交作业', reason: '用户要求明天提醒' };
  await ctx.executeToolCall('schedule_automation', params, { conv });
  await ctx.executeToolCall('schedule_automation', params, { conv });
  assert.equal(ctx.automations.length, 1);
  assert.equal(ctx.automations[0].convId, 'background');
  assert.equal(ctx.automations[0].repeat, 'once');
  assert.equal(ctx.automations[0].date, '2099-09-12');
  assert.equal(ctx.automations[0].sourceText, 'question');
});

// ═══════════ 图片（视觉）附件适配 ═══════════

test('PDF attachments are accepted for every model and expose user-selectable local modes', () => {
  const ctx = harness();
  const pdf = { name: '讲义.pdf', type: 'application/pdf', size: 1024 };
  const alerts = [];
  ctx.renderAttachPreview = () => {};
  ctx.alert = message => alerts.push(message);
  ctx.getEffectiveApiConfig = () => ({ apiKey: 'fake', model: 'deepseek-v4-pro' });
  ctx.setAiAttachments([]);
  ctx.addAiAttachmentFiles([pdf]);
  let attach = ctx.getAiAttachments()[0];
  assert.equal(ctx.isPdfFile(pdf), true);
  assert.equal(attach.pdfMode, 'text');

  // 非视觉模型仍可提取文字，但不能误选页面图片。
  ctx.toggleAttachPdfMode(0);
  assert.equal(ctx.getAiAttachments()[0].pdfMode, 'text');
  assert.equal(alerts.length, 1);

  // 切换到视觉模型后，用户可在两种模式之间切换。
  ctx.getEffectiveApiConfig = () => ({ apiKey: 'fake', model: 'deepseek-flash' });
  ctx.toggleAttachPdfMode(0);
  attach = ctx.getAiAttachments()[0];
  assert.equal(attach.pdfMode, 'image');
  ctx.toggleAttachPdfMode(0);
  assert.equal(ctx.getAiAttachments()[0].pdfMode, 'text');
});

test('PDF text mode extracts page-labelled text and reports truncation', async () => {
  const ctx = harness();
  let destroyed = false;
  const pageTexts = [['第一页', ' 内容'], [], ['第三页很长的内容']];
  ctx.openPdfAttachment = async () => ({
    pdf: {
      numPages: pageTexts.length,
      async getPage(pageNo) {
        return { async getTextContent() { return { items: pageTexts[pageNo - 1].map(str => ({ str })) }; } };
      },
      async destroy() { destroyed = true; }
    }
  });
  const full = await ctx.extractPdfAttachmentText({}, { maxChars: 200 });
  assert.match(full.text, /\[第 1 页\]\n第一页 内容/);
  assert.doesNotMatch(full.text, /第 2 页/);
  assert.match(full.text, /\[第 3 页\]/);
  assert.equal(full.textPageCount, 2);
  assert.equal(full.truncated, false);
  assert.equal(destroyed, true);

  const short = await ctx.extractPdfAttachmentText({}, { maxChars: 15 });
  assert.equal(short.truncated, true);
});

test('PDF image mode renders ordered JPEG pages and caps oversized documents', async () => {
  const ctx = harness();
  let destroyed = false;
  const rendered = [];
  ctx.openPdfAttachment = async () => ({
    pdf: {
      numPages: 4,
      async getPage(pageNo) {
        return {
          getViewport({ scale }) { return { width: 800 * scale, height: 1000 * scale }; },
          render() { rendered.push(pageNo); return { promise: Promise.resolve() }; }
        };
      },
      async destroy() { destroyed = true; }
    }
  });
  ctx.document.createElement = () => ({
    width: 0, height: 0,
    getContext: () => ({ fillRect() {} })
  });
  ctx.canvasToBlob = async canvas => ({ width: canvas.width, height: canvas.height });
  let imageNo = 0;
  ctx.blobToDataUrl = async () => `data:image/jpeg;base64,page-${++imageNo}`;
  const output = await ctx.renderPdfAttachmentPages({}, { maxPages: 2, maxWidth: 1600 });
  assert.deepEqual(rendered, [1, 2]);
  assert.equal(output.dataUrls.length, 2);
  assert.equal(output.pageCount, 4);
  assert.equal(output.renderedPages, 2);
  assert.equal(output.truncated, true);
  assert.equal(destroyed, true);
});

test('deepseek-flash counts as an image-capable model while deepseek-v4-pro does not', () => {
  const ctx = harness();
  // 官方文档：deepseek-flash（DeepSeek-V4.1-Flash）图像理解支持；deepseek-v4-pro 不支持
  for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    assert.equal(ctx.modelSupportsVision({ model }), true, model);
    assert.equal(ctx.isMultimodalModel({ model }), true, model);
  }
  // Kimi 走独立分支（文件上传 / OCR），不依赖 vision 关键词
  assert.equal(ctx.modelSupportsVision({ model: 'kimi-k2' }), false);
  assert.equal(ctx.isMultimodalModel({ model: 'kimi-k2' }), true);
  assert.equal(ctx.isKimiModel({ model: 'kimi-k2' }), true);
  for (const model of ['deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner', 'gpt-3.5-turbo', '']) {
    assert.equal(ctx.modelSupportsVision({ model }), false, model);
    assert.equal(ctx.isVisionModel({ model }), false, model);
    assert.equal(ctx.isMultimodalModel({ model }), false, model);
  }
});

test('image attachments are accepted for deepseek-flash and preprocessed to an inline data URL', async () => {
  const ctx = harness();
  const png = { name: 'preprocess-me.png', type: 'image/png', size: 11 };
  const exe = { name: 'reject-me.exe', type: 'application/octet-stream', size: 2 };
  const alerts = [];
  ctx.setAiAttachments([]);
  ctx.renderAttachPreview = () => {};
  ctx.alert = message => alerts.push(message);
  ctx.isDebugMode = () => false;
  ctx.getEffectiveApiConfig = () => ({ apiKey: 'fake', model: 'deepseek-flash' });
  ctx.downscaleImageForApi = async file => ({
    file,
    dataUrl: 'data:image/png;base64,AAAA',
    info: { width: 8, height: 8, format: 'png', converted: false, resized: false, original: true }
  });
  ctx.addAiAttachmentFiles([png, exe]);
  // 视觉模型：图片放行，可执行文件等非文本附件仍被拒
  assert.equal(ctx.isMultimodalModel({ model: 'deepseek-flash' }), true);
  assert.equal(ctx.isTextFile(png), false);
  assert.deepEqual(Array.from(ctx.getAiAttachments(), a => a.name), ['preprocess-me.png']);
  assert.equal(alerts.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  const attach = ctx.getAiAttachments()[0];
  assert.equal(attach.dataUrl, 'data:image/png;base64,AAAA');
  assert.equal(attach.imageProcessing, false);
  assert.equal(attach.imageInfo.format, 'png');
});

test('very tall images are split into ordered API-safe parts without shrinking document text to thumbnail size', async () => {
  const ctx = harness();
  const draws = [];
  let closed = false;
  ctx.decodeImageBitmap = async () => ({
    bitmap: { width: 1782, height: 15888, close() { closed = true; } },
    revoke: false
  });
  ctx.document.createElement = tag => {
    assert.equal(tag, 'canvas');
    return {
      width: 0,
      height: 0,
      getContext: () => ({ fillRect() {}, drawImage: (...args) => draws.push(args) })
    };
  };
  ctx.canvasToBlob = async canvas => ({ width: canvas.width, height: canvas.height });
  ctx.blobToDataUrl = async blob => `data:image/png;base64,${blob.width}x${blob.height}`;

  const output = await ctx.splitTallImageForApi({ name: '教材长图.png' });
  assert.equal(output.dataUrls.length, 8);
  assert.equal(output.info.sourceWidth, 1782);
  assert.equal(output.info.sourceHeight, 15888);
  assert.equal(output.info.width, 1782);
  assert.equal(output.info.parts, 8);
  assert.equal(draws.length, 8);
  assert.equal(draws[0][2], 0); // 第一段从图片顶部开始
  assert.equal(draws[1][2], 2048); // 第二段紧接第一段，保持阅读顺序
  assert.equal(closed, true);
});

test('Kimi image attachments use the same local preprocessing pipeline as other vision models', async () => {
  const ctx = harness();
  let processed = 0;
  ctx.getEffectiveApiConfig = () => ({ apiKey: 'fake', model: 'kimi-k2' });
  ctx.preprocessAiImageAttachment = attach => {
    processed++;
    attach._processPromise = Promise.resolve(attach);
    return attach._processPromise;
  };
  ctx.renderAttachPreview = () => {};
  ctx.addAiAttachmentFiles([{ name: 'long.png', type: 'image/png', size: 1024 }]);
  assert.equal(processed, 1);
});

test('inline images are sent as base64 image_url blocks for the vision model', () => {
  const ctx = harness();
  const conv = { id: 'foreground', messages: [], systemPrompt: '' };
  ctx.initTreeOnConv(conv);
  ctx.appendMessage(conv, {
    role: 'user',
    content: '这张图里有什么？',
    time: '2026-09-13 10:00',
    attachments: [{ name: 'shot.png', size: 12 }],
    visionFiles: [{ type: 'image_url', name: 'shot.png', dataUrl: 'data:image/png;base64,AAAA' }]
  });
  const cfg = { apiKey: 'fake', model: 'deepseek-flash', contextLimit: 20, contextBudget: 32768 };
  const messages = ctx.buildApiMessages(conv, null, cfg);
  const userMessage = messages[messages.length - 1];
  assert.equal(userMessage.role, 'user');
  assert.equal(Array.isArray(userMessage.content), true);
  assert.equal(userMessage.content[0].type, 'text');
  assert.match(userMessage.content[0].text, /^\[当前时间：2026-09-13 10:00\]/);
  // 内容块来自 VM realm，逐字段断言而非 deepEqual
  assert.equal(userMessage.content[1].type, 'image_url');
  assert.equal(userMessage.content[1].image_url.url, 'data:image/png;base64,AAAA');
  // 非视觉模型不携带图片块，只保留文本（避免服务端 400）
  const plain = ctx.buildApiMessages(conv, null, { apiKey: 'fake', model: 'deepseek-v4-pro', contextLimit: 20, contextBudget: 32768 });
  assert.equal(typeof plain[plain.length - 1].content, 'string');
});

test('legacy oversized PNG images are omitted from later requests instead of poisoning the conversation forever', () => {
  const ctx = harness();
  ctx.atob = atob;
  // PNG signature + IHDR length/type + width=1782 + height=15888，后续 CRC/像素无需读取。
  const header = Buffer.from([
    0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, 0,0,0,13, 0x49,0x48,0x44,0x52,
    0,0,0x06,0xf6, 0,0,0x3e,0x10, 8,2,0,0,0
  ]).toString('base64');
  const dataUrl = 'data:image/png;base64,' + header;
  const inspected = ctx.inspectInlineImageForApi(dataUrl);
  assert.equal(inspected.ok, false);
  assert.equal(inspected.width, 1782);
  assert.equal(inspected.height, 15888);

  const conv = { messages: [{ role: 'user', content: '旧图片', visionFiles: [{ type: 'image_url', name: 'old.png', dataUrl }] }], systemPrompt: '' };
  const messages = ctx.buildApiMessages(conv, null, { apiKey: 'fake', model: 'deepseek-flash', contextLimit: 20, contextBudget: 32768 });
  const content = messages.at(-1).content;
  assert.equal(content.some(part => part.type === 'image_url'), false);
  assert.match(content[0].text, /历史图片.+已跳过/);
});

test('a file_id from a previously rejected image message is removed from later conversation history', () => {
  const ctx = harness();
  const conv = {
    messages: [
      {
        role: 'user', content: '分析旧长图',
        visionFiles: [{ type: 'file', fileId: 'file-api-bad-long-image', name: 'old.png', dataUrl: 'data:image/jpeg;base64,AAAA' }]
      },
      { role: 'assistant', content: '❌ 图片发送失败：.messages[1].image[0]: You have uploaded an unsupported image.' },
      { role: 'user', content: '分析这次新上传的图片', visionFiles: [{ type: 'image_url', name: 'new.jpg', dataUrl: 'data:image/jpeg;base64,AAAA' }] }
    ],
    systemPrompt: ''
  };
  const messages = ctx.buildApiMessages(conv, null, { apiKey: 'fake', model: 'deepseek-flash', contextLimit: 20, contextBudget: 32768 });
  const oldMessage = messages.find(message => typeof message.content === 'string' && message.content.includes('分析旧长图'));
  assert.ok(oldMessage);
  assert.match(oldMessage.content, /不再重复发送/);
  assert.equal(JSON.stringify(messages).includes('file-api-bad-long-image'), false);
  const currentMessage = messages.at(-1);
  assert.equal(currentMessage.content.some(part => part.type === 'image_url'), true);
});

test('oversized inline images are dropped from the pending attachments before sending', () => {
  const ctx = harness();
  // Blob.size 只读，用同形状的普通对象模拟 File 即可（代码只读 name/type/size）
  const huge = { name: 'huge.png', type: 'image/png', size: 25 * 1024 * 1024 }; // 内联后约 34MB > 20MB 上限
  const small = { name: 'small.png', type: 'image/png', size: 1024 };
  const pending = [{ name: huge.name, file: huge, size: huge.size }, { name: small.name, file: small, size: small.size }];
  ctx.setAiAttachments(pending.slice());
  ctx.renderAttachPreview = () => {};
  const snapshot = pending.slice();
  const dropped = ctx.pruneOversizedImageAttachments(snapshot, { model: 'deepseek-flash' });
  // 返回被剔除的文件名，并清掉编辑器里的待发附件（sendAiMessage 再按名单过滤自己的快照）
  assert.deepEqual(Array.from(dropped), ['huge.png']);
  assert.deepEqual(Array.from(ctx.getAiAttachments(), a => a.name), ['small.png']);
  const kept = snapshot.filter(a => dropped.indexOf(a.name) < 0);
  assert.deepEqual(Array.from(kept, a => a.name), ['small.png']);
});

test('raw request logs keep a placeholder instead of the whole inline image', () => {
  const ctx = harness();
  const huge = 'data:image/png;base64,' + 'A'.repeat(200000);
  const redacted = ctx.redactInlineImages([
    { type: 'text', text: '这张图里有什么？' },
    { type: 'image_url', image_url: { url: huge } }
  ]);
  assert.equal(redacted[0].text, '这张图里有什么？');
  assert.match(redacted[1].image_url.url, /^<内联图片 image\/png，约 \d+KB>$/);
  assert.ok(redacted[1].image_url.url.length < 60);
  // 纯文本消息原样返回，不产生额外对象
  assert.equal(ctx.redactInlineImages('普通文本'), '普通文本');
});

// ═══════════ DeepSeek Files API：图片上传一次后按 file_id 复用 ═══════════

test('files api strategy applies to deepseek only and by size threshold', () => {
  const ctx = harness();
  const image = size => ({ name: 'photo.jpg', type: 'image/jpeg', size });
  const ds = { apiKey: 'k', keyId: 'key1', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' };
  const other = { apiKey: 'k', model: 'deepseek-flash', baseUrl: 'https://gateway.example.com/v1' };
  assert.equal(ctx.supportsDeepSeekFilesApi(ds), true);
  assert.equal(ctx.supportsDeepSeekFilesApi(other), false); // 非官方端点不保证有 Files API
  assert.equal(ctx.supportsDeepSeekFilesApi({ model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com' }), false);
  // auto（默认）：小图内联、大图上传
  assert.equal(ctx.shouldUploadImageToFiles({ file: image(300 * 1024), size: 300 * 1024 }, ds), false);
  assert.equal(ctx.shouldUploadImageToFiles({ file: image(4 * 1024 * 1024), size: 4 * 1024 * 1024 }, ds), true);
  assert.equal(ctx.shouldUploadImageToFiles({ file: image(4 * 1024 * 1024), size: 4 * 1024 * 1024 }, other), false);
  // 用户设置：always / never
  ctx.setAiImageUploadMode('always');
  assert.equal(ctx.shouldUploadImageToFiles({ file: image(1024), size: 1024 }, ds), true);
  ctx.setAiImageUploadMode('never');
  assert.equal(ctx.shouldUploadImageToFiles({ file: image(4 * 1024 * 1024), size: 4 * 1024 * 1024 }, ds), false);
  ctx.setAiImageUploadMode('auto');
  // 已上传过的附件不重复判定上传；非图片文件一律不走 Files API
  assert.equal(ctx.shouldUploadImageToFiles({ file: image(4 * 1024 * 1024), size: 4 * 1024 * 1024, uploadFileId: 'file-api-x', uploadKeyId: 'key1' }, ds), false);
  assert.equal(ctx.shouldUploadImageToFiles({ file: { name: 'a.txt', type: 'text/plain', size: 4 * 1024 * 1024 }, size: 4 * 1024 * 1024 }, ds), false);
  // 超过 64 MiB 的图片上传也会失败 → 交给内联路径处理
  assert.equal(ctx.shouldUploadImageToFiles({ file: image(70 * 1024 * 1024), size: 70 * 1024 * 1024 }, ds), false);
});

test('uploaded images are reused by file_id within the same api key only', () => {
  const ctx = harness();
  const cfg = { keyId: 'key1', model: 'deepseek-flash' };
  const fingerprint = 'sha256-photo-content';
  ctx.aiConvs = [{
    id: 'c1',
    messages: [
      { role: 'user', content: '看图', attachments: [{ name: 'photo.jpg', size: 10 }], visionFiles: [
        { type: 'file', fileId: 'file-api-abc', uploadKeyId: 'key1', imageFingerprint: fingerprint, name: 'photo.jpg', dataUrl: 'data:image/jpeg;base64,TINY' }
      ] }
    ]
  }];
  const hit = ctx.findReusableUploadedImage({ name: 'photo.jpg', imageFingerprint: fingerprint }, cfg);
  assert.equal(hit.fileId, 'file-api-abc');
  assert.equal(hit.thumb, 'data:image/jpeg;base64,TINY');
  // 同名但内容不同、或旧记录没有指纹，都不得复用。
  assert.equal(ctx.findReusableUploadedImage({ name: 'photo.jpg', imageFingerprint: 'different-content' }, cfg), null);
  assert.equal(ctx.findReusableUploadedImage({ name: 'photo.jpg' }, cfg), null);
  // 换了 API Key → 归属不同，不能复用
  assert.equal(ctx.findReusableUploadedImage({ name: 'photo.jpg', imageFingerprint: fingerprint }, { keyId: 'key2', model: 'deepseek-flash' }), null);
  assert.equal(ctx.collectReferencedFileIds().has('file-api-abc'), true);
});

test('file_id references and tiny thumbnails are sent as separate content blocks', () => {
  const ctx = harness();
  const conv = { id: 'foreground', messages: [], systemPrompt: '' };
  ctx.initTreeOnConv(conv);
  ctx.appendMessage(conv, {
    role: 'user',
    content: '这张图里有什么？',
    time: '2026-09-13 11:00',
    attachments: [{ name: 'photo.jpg', size: 10, displayUrl: 'data:image/jpeg;base64,TINY' }],
    visionFiles: [{ type: 'file', fileId: 'file-api-abc', uploadKeyId: 'key1', name: 'photo.jpg', dataUrl: 'data:image/jpeg;base64,TINY' }]
  });
  const messages = ctx.buildApiMessages(conv, null, { apiKey: 'fake', keyId: 'key1', model: 'deepseek-flash', contextLimit: 20, contextBudget: 32768 });
  const content = messages[messages.length - 1].content;
  assert.equal(Array.isArray(content), true);
  assert.equal(content[0].type, 'text');
  assert.equal(content[1].type, 'file');
  assert.equal(content[1].file_id, 'file-api-abc');
  assert.equal(content[1].file_data, undefined); // file_id 与 file_data 互斥
  assert.equal(content[2].type, 'file');
  assert.equal(content[2].file_data, 'data:image/jpeg;base64,TINY');
  assert.equal(content[2].filename, 'photo.jpg');
});

test('uploaded images are not dropped by the inline size limit', () => {
  const ctx = harness();
  const big = { name: 'big.jpg', type: 'image/jpeg', size: 40 * 1024 * 1024 };
  const bigInline = { name: 'big2.jpg', type: 'image/jpeg', size: 40 * 1024 * 1024 };
  const pending = [
    { name: 'big.jpg', file: big, size: big.size, uploadFileId: 'file-api-x', uploadKeyId: 'key1', imageStrategy: 'file' },
    { name: 'big2.jpg', file: bigInline, size: bigInline.size }
  ];
  ctx.setAiAttachments([]);
  ctx.renderAttachPreview = () => {};
  const dropped = ctx.pruneOversizedImageAttachments(pending.slice(), { model: 'deepseek-flash' });
  assert.deepEqual(Array.from(dropped), ['big2.jpg']); // 只有走内联的那张被剔除
});
