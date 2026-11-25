const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup() {
  const values = new Map();
  const released = [];
  const ctx = vm.createContext({
    console, window: {}, escapeHtml: s => s,
    localStorage: {
      getItem: k => values.get(k) ?? null,
      setItem: (k, v) => values.set(k, String(v))
    },
    document: { getElementById: () => null, querySelector: () => null },
    aiConvs: [{ id: 1, title: '保留完整分支', systemPrompt: 'prompt',
      messages: [{ role: 'user', content: 'hello' }],
      tree: { root: { content: 'hello' }, branch: { content: '另一分支', attachments: [{ originalFileId: 'original' }] } }, activePath: ['root'] }],
    activeConvId: 1, automations: [{ id: 3, convId: 1, enabled: true }],
    _aiAttachmentDrafts: new Map(), genId: () => 2,
    showCustomConfirm: async () => true,
    saveData: (k, v) => { values.set(k, JSON.stringify(v)); return true; },
    renderAiChat() {}, restoreAiDraft() {},
    releaseAiConversationFiles: id => released.push(id)
  });
  for (const file of ['ai-utils', 'trash', 'ai-conv']) {
    // Use the deterministic confirmation stub instead of the DOM dialog.
    if (file === 'ai-utils') {
      const source = fs.readFileSync(path.join(__dirname, '../js/ai-utils.js'), 'utf8');
      vm.runInContext(source.slice(0, source.indexOf('// ═══════════ Custom Confirm')), ctx);
    } else vm.runInContext(fs.readFileSync(path.join(__dirname, `../js/${file}.js`), 'utf8'), ctx);
  }
  return { ctx, values, released };
}

test('last conversation is persisted in trash, survives reload and restores branches, draft and paused automations', async () => {
  const { ctx, values, released } = setup();
  const original = JSON.stringify(ctx.aiConvs[0]);
  values.set('study_ai_convs', JSON.stringify(ctx.aiConvs));
  values.set('study_ai_drafts', JSON.stringify({ 1: 'unfinished draft' }));
  await ctx.deleteConv(1);
  assert.equal(ctx.aiConvs[0].id, 2);
  assert.equal(ctx.activeConvId, 2);
  assert.equal(ctx.automations.length, 0);
  assert.deepEqual(released, []);
  // Reconstruct state from durable storage rather than retained object references.
  ctx.aiConvs = JSON.parse(values.get('study_ai_convs'));
  ctx.restoreFromTrash('ai', 1);
  assert.equal(JSON.stringify(ctx.aiConvs.find(c => c.id === 1)), original);
  assert.equal(ctx.automations[0].enabled, false);
  assert.equal(JSON.parse(values.get('study_ai_drafts'))[1], 'unfinished draft');
  assert.equal(JSON.parse(values.get('study_ai_convs_trash')).length, 0);
  assert.deepEqual(released, []);
});

test('failed trash write leaves the conversation and automations intact', async () => {
  const { ctx, released } = setup();
  ctx.localStorage.setItem = () => { throw new Error('quota'); };
  await ctx.deleteConv(1);
  assert.equal(ctx.aiConvs[0].id, 1);
  assert.equal(ctx.aiConvs[0].messages[0].content, 'hello');
  assert.equal(ctx.automations.length, 1);
  assert.deepEqual(released, []);
});

test('large tree chats store PDF images once in trash and restore every branch and draft', async () => {
  const { ctx, values } = setup();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ai-tree.js'), 'utf8'), ctx);
  const image = 'data:image/jpeg;base64,' + 'A'.repeat(1024 * 1024);
  const root = { id: 'root', role: 'root', children: ['question'] };
  const question = { id: 'question', parentId: 'root', role: 'user', content: '阅读 PDF', children: ['answer', 'branch'],
    attachments: [{ name: '教材.pdf', originalFileId: 'pdf-original' }],
    visionFiles: [{ type: 'image_url', pdfPage: 2, dataUrl: image, originalFileId: 'pdf-original' }] };
  const answer = { id: 'answer', parentId: 'question', role: 'assistant', content: '当前回复', children: [] };
  const branch = { id: 'branch', parentId: 'question', role: 'assistant', content: '另一个分支', children: [] };
  const conv = { id: 1, title: '大型 PDF 对话', tree: { root, question, answer, branch }, activePath: ['root', 'question', 'answer'],
    messages: [question, answer] };
  ctx.aiConvs = [conv];
  values.set('study_ai_drafts', JSON.stringify({ 1: '保留草稿' }));
  const fullSize = JSON.stringify(conv).length;
  await ctx.deleteConv(1);
  const raw = values.get('study_ai_convs_trash');
  assert.ok(raw.length < fullSize * 0.6, 'the PDF page must not be duplicated in messages and tree');
  assert.equal(JSON.parse(raw)[0].messages, undefined);
  ctx.restoreFromTrash('ai', 1);
  const restored = ctx.aiConvs.find(c => c.id === 1);
  assert.equal(restored.messages[0].visionFiles[0].dataUrl, image);
  assert.equal(restored.tree.branch.content, '另一个分支');
  assert.deepEqual(Array.from(restored.activePath), ['root', 'question', 'answer']);
  assert.equal(JSON.parse(values.get('study_ai_drafts'))[1], '保留草稿');
});

test('failed conversation-list save keeps the original chat and its attachment references', async () => {
  const { ctx, values } = setup();
  values.set('study_ai_convs', JSON.stringify(ctx.aiConvs));
  const setItem = ctx.localStorage.setItem;
  ctx.localStorage.setItem = (key, value) => {
    if (key === 'study_ai_convs') throw new Error('quota');
    setItem(key, value);
  };
  await ctx.deleteConv(1);
  assert.equal(ctx.aiConvs[0].id, 1);
  assert.equal(ctx.aiConvs[0].tree.branch.attachments[0].originalFileId, 'original');
  assert.equal(ctx.activeConvId, 1);
  assert.equal(ctx.automations.length, 1);
});

test('permanent deletion and empty trash release original attachments', async () => {
  const { ctx, values, released } = setup();
  await ctx.deleteConv(1);
  ctx.permanentlyDelete('ai', 1);
  await Promise.resolve();
  assert.deepEqual(released, [1]);
  assert.equal(JSON.parse(values.get('study_ai_convs_trash')).length, 0);
  values.set('study_ai_convs_trash', JSON.stringify([{ id: 9 }]));
  ctx.emptyTrash();
  await Promise.resolve();
  assert.deepEqual(released, [1, 9]);
});
