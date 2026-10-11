'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  let activeId = 1;
  const rows = new Map();
  const alerts = [];
  const context = vm.createContext({ console, File, Blob, globalThis: {}, window: { addEventListener() {} },
    document: { getElementById: () => null, addEventListener() {} },
    alert: message => alerts.push(message),
    getActiveConvId: () => activeId, getEffectiveApiConfig: () => ({ model: 'deepseek-flash' }),
    isKimiModel: () => false, isMultimodalModel: () => true, showAiToast() {},
    formatFileSize: size => String(size)
  });
  vm.runInContext('let aiAttachments = [];\n' + fs.readFileSync(path.join(__dirname, '../js/ai-attach.js'), 'utf8'), context);
  context.aiAttachmentStore = async (mode, action) => action({
    put: row => { rows.set(row.id, row); return { result: row.id }; },
    get: id => ({ result: rows.get(id) })
  }).result;
  context.preprocessAiImageAttachment = () => {};
  return { context, rows, alerts, switchTo: id => { activeId = id; } };
}

test('original image bytes survive preprocessing and repeated reuse keeps one stored file', async () => {
  const { context: ctx, rows } = harness();
  const original = new File(['original-image'], 'scan.png', { type: 'image/png' });
  const attach = { name: original.name, size: original.size, originalFile: original,
    file: new File(['thumbnail'], original.name, { type: 'image/png' }) };
  const reference = await ctx.retainAiAttachmentFile(attach, 1);
  assert.equal(await rows.get(reference.originalFileId).blob.text(), 'original-image');
  assert.equal(await ctx.reinsertAiAttachment(reference, 1), true);
  const restored = ctx.getAiAttachments()[0];
  assert.equal(await restored.file.text(), 'original-image');
  assert.equal(restored.originalFileId, reference.originalFileId);
  await ctx.retainAiAttachmentFile(restored, 1);
  assert.equal(rows.size, 1);
  assert.equal(await ctx.reinsertAiAttachment(reference, 1), true);
  assert.equal(ctx.getAiAttachments().length, 1);
});

test('same filenames remain distinct and history includes attachments on inactive branches', async () => {
  const { context: ctx, rows } = harness();
  const refs = [];
  for (const text of ['first', 'second']) {
    const file = new File([text], 'notes.txt');
    refs.push({ name: file.name, ...await ctx.retainAiAttachmentFile({ name: file.name, file }, 1) });
  }
  assert.notEqual(refs[0].originalFileId, refs[1].originalFileId);
  const conv = { tree: { a: { id: 'a', role: 'user', attachments: [refs[0]] },
    b: { id: 'b', role: 'user', attachments: [refs[1], refs[0]] } }, messages: [] };
  assert.equal(ctx.getAiConversationAttachments(conv).length, 2);
  assert.equal(rows.size, 2);
});

test('PDF reuse restores range and processing mode and adapts to a text-only model', async () => {
  const { context: ctx } = harness();
  const file = new File(['pdf bytes'], 'book.pdf', { type: 'application/pdf' });
  const reference = await ctx.retainAiAttachmentFile({ name: file.name, file,
    pdfMode: 'image', pdfStartPage: 2, pdfEndPage: 4 }, 1);
  await ctx.reinsertAiAttachment(reference, 1);
  assert.equal(ctx.getAiAttachments()[0].pdfMode, 'image');
  assert.equal(ctx.getAiAttachments()[0].pdfStartPage, 2);
  assert.equal(ctx.getAiAttachments()[0].pdfEndPage, 4);
  ctx.removeAttachment(0);
  ctx.isMultimodalModel = () => false;
  await ctx.reinsertAiAttachment(reference, 1);
  assert.equal(ctx.getAiAttachments()[0].pdfMode, 'text');
});

test('missing local files and unsupported images cannot be silently reused', async () => {
  const { context: ctx, alerts } = harness();
  assert.equal(await ctx.reinsertAiAttachment({ name: 'legacy.pdf' }, 1), false);
  assert.match(alerts[0], /重新上传/);
  const file = new File(['image'], 'pic.png', { type: 'image/png' });
  const reference = await ctx.retainAiAttachmentFile({ name: file.name, file }, 1);
  ctx.isMultimodalModel = () => false;
  assert.equal(await ctx.reinsertAiAttachment(reference, 1), false);
  assert.equal(ctx.getAiAttachments().length, 0);
  assert.match(alerts[1], /不支持/);
});

test('async reads cannot insert into another conversation, and ownership is checked', async () => {
  const { context: ctx, rows, switchTo } = harness();
  const file = new File(['notes'], 'notes.txt');
  const reference = await ctx.retainAiAttachmentFile({ name: file.name, file }, 1);
  let complete;
  ctx.aiAttachmentStore = () => new Promise(resolve => { complete = resolve; });
  const pending = ctx.reinsertAiAttachment(reference, 1);
  switchTo(2);
  complete(rows.get(reference.originalFileId));
  assert.equal(await pending, false);
  assert.equal(ctx.getAiAttachments().length, 0);
  ctx.aiAttachmentStore = async () => rows.get(reference.originalFileId);
  assert.equal(await ctx.reinsertAiAttachment(reference, 2), false);
});

test('storage failure preserves session reuse and marks it as temporary', async () => {
  const { context: ctx } = harness();
  ctx.aiAttachmentStore = async () => { throw new Error('quota'); };
  const file = new File(['complete text'], 'notes.txt');
  const reference = await ctx.retainAiAttachmentFile({ name: file.name, file }, 1);
  assert.equal(reference.localOnly, true);
  assert.equal(await ctx.reinsertAiAttachment(reference, 1), true);
  assert.equal(await ctx.getAiAttachments()[0].file.text(), 'complete text');
});
