'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=';
const config = { apiKey: 'fake', model: 'deepseek-flash', baseUrl: 'https://example.test/v1', contextBudget: 32768, contextLimit: 20 };

function harness() {
  const values = new Map();
  const ctx = vm.createContext({ console, File, Blob, atob, Uint8Array, setTimeout, clearTimeout,
    window: { addEventListener() {} }, document: { getElementById: () => null, addEventListener() {} },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    getMaxFocusCount: () => 3, getEffectiveApiConfig: () => config, getActiveConvId: () => 'other',
    isAiStopRequested: () => false, isDebugMode: () => false, safeSaveAiConvs() {},
    renderAiMessages() {}, renderTodos() {}, renderLinks() {}, renderNotes() {}, renderToday() {},
    genId: (() => { let id = 100; return () => ++id; })()
  });
  for (const file of ['ai-tree','ai-attach','ai-tools','ai-api']) {
    vm.runInContext((file === 'ai-attach' ? 'let aiAttachments = [];\n' : '')
      + fs.readFileSync(path.join(__dirname, '../js', file + '.js'), 'utf8'), ctx);
  }
  ctx.buildConversationSystemPrompt = () => 'Read the supplied material.';
  return ctx;
}

function visualConversation(ctx, count = 12) {
  const conv = { id: 'origin', messages: [], _toolGroups: [] };
  ctx.initTreeOnConv(conv);
  ctx.appendMessage(conv, { role: 'user', content: '解释教材', attachments: [{ name: '教材.pdf', pdfMode: 'image' }],
    visionFiles: Array.from({ length: count }, (_, i) => ({ type: 'image_url', dataUrl: png,
      name: `教材.pdf（PDF 第 ${i + 1}/${count} 页）`, pdfPage: i + 1, pageCount: count })) });
  return conv;
}
function urls(messages) {
  return messages.flatMap(message => Array.isArray(message.content)
    ? message.content.filter(part => part.type === 'image_url').map(part => part.image_url.url) : []);
}

test('token eviction names every image-PDF page and exposes only same-conversation read tools', () => {
  const ctx = harness(), conv = visualConversation(ctx);
  assert.equal(urls(ctx.buildApiMessages(conv, null, config)).length, 12);
  ctx.appendMessage(conv, { role: 'assistant', content: '分析'.repeat(4000) });
  ctx.appendMessage(conv, { role: 'user', content: '第3页是什么？' });
  const messages = ctx.buildApiMessages(conv, null, config);
  assert.equal(urls(messages).length, 0);
  const notice = messages.find(message => typeof message.content === 'string' && message.content.startsWith('【历史视觉资料'));
  assert.ok(notice);
  assert.match(notice.content, /12 张/);
  assert.match(notice.content, /read_conversation_image/);
  assert.match(notice.content, /"pdfPage":3/);
  assert.equal(notice.content.includes('data:image'), false);
  const tools = ctx.selectAiToolsForConversation(conv, false, false, config);
  assert.deepEqual([...tools].sort(), ['list_conversation_images', 'read_conversation_image']);
  assert.equal(ctx.selectAiToolsForConversation({ messages: [], _toolGroups: [] }, false, false, config).size, 0);
});

test('old visual resources survive the excerpt window, have distinct IDs, and support paginated search', async () => {
  const ctx = harness(), conv = visualConversation(ctx, 2);
  ctx.appendMessage(conv, { role: 'user', content: '另一张同名图', visionFiles: [{ type: 'image_url', name: '教材.pdf（PDF 第 1/2 页）', dataUrl: png }] });
  for (let i = 0; i < 30; i++) {
    ctx.appendMessage(conv, { role: 'assistant', content: 'answer' });
    ctx.appendMessage(conv, { role: 'user', content: 'question ' + i });
  }
  const messages = ctx.buildApiMessages(conv, null, { ...config, contextLimit: 2 });
  assert.ok(messages.some(message => String(message.content).includes('历史视觉资料')));
  const first = await ctx.executeToolCallStructured('list_conversation_images', { search: '教材', pageSize: 1 }, { conv, apiCfg: config });
  assert.equal(first.data.total, 3);
  assert.equal(first.data.items.length, 1);
  const second = await ctx.executeToolCallStructured('list_conversation_images', { pageSize: 1, page: 2 }, { conv, apiCfg: config });
  assert.notEqual(first.data.items[0].imageId, second.data.items[0].imageId);
  assert.equal(JSON.stringify(first.data).includes('data:image'), false);
});

test('reading a cropped PDF page returns full cached image data separately from text', async () => {
  const ctx = harness(), conv = visualConversation(ctx, 3);
  const source = ctx.getAiConversationVisualResources(conv)[1];
  const result = await ctx.executeToolCallStructured('read_conversation_image', { imageId: source.imageId }, { conv, apiCfg: config });
  assert.equal(result.ok, true);
  assert.equal(result.data.pdfPage, 2);
  assert.equal(result.visionFiles[0].dataUrl, png);
  assert.equal(result.visionFiles[0].conversationImageId, source.imageId);
  assert.equal(result.text.includes('data:image'), false);
  ctx.appendMessage(conv, { role: 'user', content: '资料', visionFiles: result.visionFiles, _toolInfo: { pageImages: true } });
  assert.equal(ctx.getAiConversationVisualResources(conv).length, 3, '重新读取不能创建重复来源');
});

test('unknown IDs, other branches, unsupported models and invalid params fail explicitly', async () => {
  const ctx = harness(), conv = visualConversation(ctx, 1);
  const imageId = ctx.getAiConversationVisualResources(conv)[0].imageId;
  const other = { id: 'other', messages: [] };
  assert.equal((await ctx.executeToolCallStructured('read_conversation_image', { imageId }, { conv: other, apiCfg: config })).ok, false);
  assert.equal((await ctx.executeToolCallStructured('read_conversation_image', { imageId }, { conv, apiCfg: { model: 'deepseek-v4-pro' } })).ok, false);
  for (const params of [{ imageId: '../secret' }, { imageId, unwanted: true }, { imageId: 1 }]) {
    assert.equal(ctx.validateAiToolCall('read_conversation_image', params).ok, false);
  }
  assert.equal(ctx.validateAiToolCall('list_conversation_images', { page: 1.5 }).ok, false);
  assert.equal(ctx.getAiToolMetadata('read_conversation_image').effect, 'read');
  assert.equal(ctx.beginAiToolTransaction('read_conversation_image'), null);
  assert.equal(ctx.getAiToolJsonSchema('list_conversation_images').properties.page.type, 'integer');
});

test('uploaded-file thumbnails are never returned as readable originals when local bytes are missing', async () => {
  const ctx = harness();
  const conv = { id: 'origin', messages: [{ id: 5, role: 'user', content: '',
    visionFiles: [{ name: 'photo.png', type: 'file', fileId: 'server-id', dataUrl: png }] }] };
  const resource = ctx.getAiConversationVisualResources(conv)[0];
  const result = await ctx.executeToolCallStructured('read_conversation_image', { imageId: resource.imageId }, { conv, apiCfg: config });
  assert.equal(result.ok, false);
  assert.match(result.text, /重新上传原文件/);
  assert.equal(result.visionFiles, undefined);
});

test('notice respects the reserved token budget and retrieved images no longer count as omitted', () => {
  const ctx = harness(), conv = visualConversation(ctx, 80);
  const resources = ctx.getAiConversationVisualResources(conv);
  const notice = ctx.buildAiOmittedVisionNotice(resources, { messages: [] }, config, 600);
  assert.ok(ctx.estimateAiTokens(notice) <= 600);
  assert.match(notice, /list_conversation_images/);
  const selected = { messages: [{ visionFiles: [{ conversationImageId: resources[0].imageId }] }] };
  assert.equal(ctx.getAiOmittedVisualResources(resources, selected).length, 79);
});

for (const native of [false, true]) test(`tool loop restores cropped images to the next API request (${native ? 'native' : 'tag'} protocol)`, async () => {
  const ctx = harness(), conv = visualConversation(ctx, 2);
  ctx.appendMessage(conv, { role: 'assistant', content: 'first answer' });
  ctx.appendMessage(conv, { role: 'user', content: '读第2页' });
  const resource = ctx.getAiConversationVisualResources(conv)[1];
  const cfg = { ...config, contextLimit: 1, baseUrl: native ? 'https://api.deepseek.com/v1' : config.baseUrl };
  const requests = [];
  ctx.callAiApi = async messages => {
    requests.push(messages);
    const calls = requests.length === 1 ? [{ action: 'read_conversation_image', params: { imageId: resource.imageId }, ...(native ? { native: true, callId: 'vision-read' } : {}) }] : [];
    return { toolCalls: calls, cleanText: '已读取', rawReply: '已读取', finishReason: 'stop' };
  };
  const result = await ctx.runToolCallLoop(cfg, conv);
  assert.equal(result.finalCleanText, '已读取');
  assert.equal(requests.length, 2);
  assert.equal(urls(requests[0]).length, 0);
  assert.deepEqual(Array.from(urls(requests[1])), [png]);
  assert.ok(requests[1].some(message => message.role === (native ? 'tool' : 'system')));
  assert.equal(ctx.getAiConversationVisualResources(conv).length, 2);
});
