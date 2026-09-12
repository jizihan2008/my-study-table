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
    automations: [], saveData() {}, startAutomationTimer() {},
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
    { action: 'add_todo', params: {} }, { action: 'update_todo', params: {} }, { action: 'list_todos', params: {} }
  ]) : result();
  ctx.executeToolCall = async action => {
    if (action === 'add_todo') { await Promise.resolve(); created = true; return '✅ created'; }
    assert.equal(created, true);
    if (action === 'update_todo') throw Error('write failed');
    return 'tasks';
  };
  const output = await ctx.runToolCallLoop({}, conv);
  assert.match(output.finalCleanText, /失败 1 项/);
  assert.deepEqual(Array.from(output.outcomes, o => o.status), ['success', 'failed', 'success']);
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
    if (++calls === 1) return result([{ action: 'add_todo', params: {} }]);
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
  ctx.aiConvs = [{
    id: 'c1',
    messages: [
      { role: 'user', content: '看图', attachments: [{ name: 'photo.jpg', size: 10 }], visionFiles: [
        { type: 'file', fileId: 'file-api-abc', uploadKeyId: 'key1', name: 'photo.jpg', dataUrl: 'data:image/jpeg;base64,TINY' }
      ] }
    ]
  }];
  const hit = ctx.findReusableUploadedImage('photo.jpg', cfg);
  assert.equal(hit.fileId, 'file-api-abc');
  assert.equal(hit.thumb, 'data:image/jpeg;base64,TINY');
  assert.equal(ctx.findReusableUploadedImage('other.jpg', cfg), null);
  // 换了 API Key → 归属不同，不能复用
  assert.equal(ctx.findReusableUploadedImage('photo.jpg', { keyId: 'key2', model: 'deepseek-flash' }), null);
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
