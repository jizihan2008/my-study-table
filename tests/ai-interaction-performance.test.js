'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(...scripts) {
  const values = new Map();
  const ctx = vm.createContext({ console, File, Blob, URL, AbortController, setTimeout, clearTimeout,
    window: { addEventListener() {} }, document: { getElementById: () => null, addEventListener() {} },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    getEffectiveApiConfig: () => ({ model: 'deepseek-flash' }), isDebugMode: () => false,
    getActiveConvId: () => 1, getActiveConv: () => ({ id: 1 }), isAiStopRequested: () => false
  });
  vm.runInContext('let aiAttachments = [];', ctx);
  for (const name of scripts) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', name + '.js'), 'utf8'), ctx);
  return { ctx, values };
}

test('normal image normalization decodes once and reads only the format header', async () => {
  const { ctx } = harness('ai-attach');
  let decodes = 0, closes = 0;
  const reads = [];
  ctx.decodeImageBitmap = async () => {
    decodes++;
    return { bitmap: { width: 100, height: 100, close() { closes++; } } };
  };
  const file = new File([new Uint8Array(2 * 1024 * 1024)], 'photo.png', { type: 'image/png' });
  ctx.readFileAsArrayBuffer = async part => { reads.push(part.size); return part.arrayBuffer(); };
  ctx.readFileAsDataURL = async () => 'data:image/png;base64,original';
  const processed = await ctx.normalizeAiImageForApi(file);
  assert.equal(processed.file, file);
  assert.equal(processed.dataUrl, 'data:image/png;base64,original');
  assert.equal(decodes, 1);
  assert.equal(closes, 1);
  assert.deepEqual(reads, [16]);
});

test('shared decoded image is released when conversion fails', async () => {
  const { ctx } = harness('ai-attach');
  let closes = 0;
  ctx.decodeImageBitmap = async () => ({ bitmap: { width: 3000, height: 3000, close() { closes++; } } });
  ctx.downscaleImageForApi = async () => { throw new Error('encoder failed'); };
  await assert.rejects(ctx.normalizeAiImageForApi(new File(['image'], 'image.png')), /encoder failed/);
  assert.equal(closes, 1);
});

test('normalization runs while fingerprinting and repeated images skip the upload request', async () => {
  const { ctx } = harness('ai-attach');
  let finishFingerprint, normalized = false, uploads = 0;
  const file = new File(['image'], 'photo.png', { type: 'image/png' });
  ctx.fingerprintImageFile = () => new Promise(resolve => { finishFingerprint = resolve; });
  ctx.normalizeAiImageForApi = async () => {
    normalized = true;
    return { file, dataUrl: 'data:image/png;base64,full', info: { width: 100, height: 100 } };
  };
  ctx.shouldUploadImageToFiles = () => true;
  ctx.aiConvs = [{ messages: [{ visionFiles: [{ type: 'file', fileId: 'existing-file',
    imageFingerprint: 'same-content', uploadKeyId: 'key', dataUrl: 'data:image/png;base64,thumb' }] }] }];
  ctx.uploadImageToDeepSeek = async () => { uploads++; return 'duplicate-file'; };
  const attach = { file, name: file.name, size: file.size };
  const pending = ctx.preprocessAiImageAttachment(attach, { keyId: 'key' });
  assert.equal(normalized, true, 'decoding must start before the checksum finishes');
  finishFingerprint('same-content');
  await pending;
  assert.equal(uploads, 0);
  assert.equal(attach.uploadFileId, 'existing-file');
  assert.equal(attach.dataUrl, 'data:image/png;base64,thumb');
  assert.equal(attach.imageProcessing, false);
  await ctx.preprocessAiImageAttachment(attach, { keyId: 'key' });
  assert.equal(uploads, 0);
});

test('auto upload uses normalized size instead of the larger original', () => {
  const { ctx } = harness('ai-attach');
  const cfg = { model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' };
  assert.equal(ctx.shouldUploadImageToFiles({ size: 10 * 1024 * 1024,
    file: new File(['small'], 'photo.jpg', { type: 'image/jpeg' }) }, cfg), false);
});

test('PDF conversion starts before original storage completes but sending waits for both', async () => {
  const { ctx } = harness('ai-attach', 'ai-send');
  let finishStorage, finishConversion, converted = false, done = false;
  const file = new File(['pdf'], 'book.pdf', { type: 'application/pdf' });
  const attach = { name: file.name, file, pdfMode: 'image' };
  ctx.retainAiAttachmentFile = a => new Promise(resolve => { finishStorage = () => {
    a.originalFileId = 'original'; resolve({ originalFileId: 'original', localOnly: false });
  }; });
  ctx.renderPdfAttachmentPages = () => {
    converted = true;
    return new Promise(resolve => { finishConversion = () => resolve({ dataUrls: ['data:image/jpeg;base64,page'],
      pageNumbers: [2], pageCount: 3, renderedPages: 1 }); });
  };
  ctx.setAiPdfSendProgress = () => {};
  const pending = ctx.prepareAiMessageAttachments([attach], { model: 'deepseek-flash' }, { id: 1 })
    .then(result => { done = true; return result; });
  assert.equal(converted, true);
  finishConversion();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false, 'original must still be saved before the prepared message is returned');
  finishStorage();
  const result = await pending;
  assert.equal(result.displayAttachments[0].originalFileId, 'original');
  assert.equal(result.visionFiles[0].originalFileId, 'original');
  assert.equal(result.visionFiles[0].pdfPage, 2);
});

test('PDF text extraction reports empty pages and stops immediately after cancellation', async () => {
  const { ctx } = harness('ai-attach');
  const read = [], progress = [];
  let stopped = false, cleaned = 0, destroyed = 0;
  ctx.openPdfAttachment = async () => ({ pdf: { numPages: 100,
    getPage: async pageNo => {
      read.push(pageNo);
      return { getTextContent: async () => ({ items: [] }), cleanup() { cleaned++; } };
    }, destroy: async () => { destroyed++; }
  } });
  const result = await ctx.extractPdfAttachmentText({}, { isAborted: () => stopped,
    onPage: info => { progress.push(info.done); if (info.done === 2) stopped = true; } });
  assert.equal(result.aborted, true);
  assert.deepEqual(read, [1, 2]);
  assert.deepEqual(progress, [0, 1, 2]);
  assert.equal(cleaned, 2);
  assert.equal(destroyed, 1);
});

test('unchanged drafts avoid writes while their attachment snapshot stays current', () => {
  const { ctx, values } = harness('ai-conv');
  let writes = 0;
  values.set('study_ai_drafts', JSON.stringify({ 1: 'draft' }));
  ctx.document.getElementById = () => ({ value: 'draft' });
  ctx.localStorage.setItem = () => { writes++; };
  vm.runInContext('aiAttachments = [{ name: "new attachment" }]', ctx);
  ctx.saveAiDraft();
  assert.equal(writes, 0);
  assert.equal(vm.runInContext('_aiAttachmentDrafts.get(1)[0].name', ctx), 'new attachment');
});
