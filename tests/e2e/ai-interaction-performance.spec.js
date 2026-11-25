'use strict';
const { test, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { buildTestPdf } = require('../fixtures/books-pdf');
const root = path.resolve(__dirname, '../..');
let server, baseUrl;
test.use({ channel: 'chrome', serviceWorkers: 'block' });
test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const target = path.resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      response.writeHead(404); response.end(); return;
    }
    response.setHeader('Content-Type', { '.html': 'text/html', '.js': 'application/javascript',
      '.mjs': 'application/javascript', '.css': 'text/css' }[path.extname(target)] || 'application/octet-stream');
    fs.createReadStream(target).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

async function setup(page) {
  await page.goto(baseUrl + '/index.html');
  await page.waitForSelector('#section-today.active');
  await page.evaluate(base => {
    window.__MST_FILE_API_TEST_HOSTS__ = ['127.0.0.1'];
    const config = { apiKey: 'fake', keyId: 'test', model: 'deepseek-flash', name: '性能测试', baseUrl: base + '/mock/v1' };
    window.loadApiKeys = () => [{ ...config, id: 'test' }];
    window.getEffectiveApiConfig = () => ({ ...config });
    window.isAutoTitleEnabled = () => false;
    window.__originalConfirm = showCustomConfirm;
    window.showCustomConfirm = async () => true;
    window.runToolCallLoop = async () => ({ finalCleanText: '已读取', finalRawReply: '已读取', finishReason: 'stop' });
    switchTab('ai'); createNewConv();
  }, baseUrl);
}

test('closing another conversation preserves the active messages, selection and attachments', async ({ page }) => {
  await setup(page);
  const inactiveId = await page.evaluate(() => {
    const id = getActiveConvId();
    createNewConv();
    appendMessage(getActiveConv(), { role: 'assistant', content: '保留当前回复\n\n' + '$$x^2+y^2=z^2$$\n\n'.repeat(40) });
    renderAiChat();
    return id;
  });
  await page.locator('#aiFileInput').setInputFiles({ name: '草稿.txt', mimeType: 'text/plain', buffer: Buffer.from('pending') });
  await page.locator('#aiInput').fill('保留尚未发送的草稿');
  const result = await page.evaluate(async id => {
    const input = document.getElementById('aiInput');
    const messages = document.getElementById('aiMessages');
    input.focus(); input.setSelectionRange(2, 5);
    const started = performance.now();
    await deleteConv(id);
    return { sameInput: input === document.getElementById('aiInput'), sameMessages: messages === document.getElementById('aiMessages'),
      focused: document.activeElement === input, selection: [input.selectionStart, input.selectionEnd],
      indexes: [...document.querySelectorAll('.ai-conv-tab')].map(tab => Number(tab.dataset.convIndex)),
      ms: performance.now() - started };
  }, inactiveId);
  expect(result.sameInput).toBe(true);
  expect(result.sameMessages).toBe(true);
  expect(result.focused).toBe(true);
  expect(result.selection).toEqual([2, 5]);
  expect(result.indexes).toEqual(result.indexes.map((_, index) => index));
  await expect(page.locator('#aiInput')).toHaveValue('保留尚未发送的草稿');
  await expect(page.locator('#aiAttachPreview')).toContainText('草稿.txt');
  console.log('Close inactive conversation: ' + result.ms.toFixed(1) + ' ms; active DOM retained');
});

test('repeated images make one upload and PDF range pages retain their original references', async ({ page }) => {
  await setup(page);
  let uploads = 0;
  await page.route(baseUrl + '/mock/v1/files', async route => {
    uploads++;
    await route.fulfill({ json: { id: 'file-api-once' } });
  });
  await page.evaluate(() => setAiImageUploadMode('always'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=', 'base64');
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator('#aiFileInput').setInputFiles({ name: '同一图片.png', mimeType: 'image/png', buffer: png });
    await page.evaluate(() => Promise.all(getAiAttachments().map(attachment => attachment._processPromise)));
    await expect(page.locator('#aiAttachPreview')).toContainText('已上传');
    await page.evaluate(() => sendAiMessage());
  }
  expect(uploads).toBe(1);
  expect(await page.evaluate(() => getActiveConv().messages.filter(message => message.role === 'user')
    .map(message => message.visionFiles[0].fileId))).toEqual(['file-api-once', 'file-api-once']);
  await page.locator('#aiFileInput').setInputFiles({ name: '教材.pdf', mimeType: 'application/pdf', buffer: buildTestPdf(4) });
  await page.getByRole('spinbutton', { name: 'PDF 起始页' }).fill('2');
  await page.getByRole('spinbutton', { name: 'PDF 起始页' }).press('Tab');
  await page.getByRole('spinbutton', { name: 'PDF 结束页' }).fill('3');
  await page.getByRole('spinbutton', { name: 'PDF 结束页' }).press('Tab');
  await page.getByRole('button', { name: '📄 提取文字', exact: true }).click();
  await page.evaluate(() => sendAiMessage());
  const pdf = await page.evaluate(async () => {
    const message = getActiveConv().messages.filter(message => message.role === 'user').at(-1);
    const id = message.attachments[0].originalFileId;
    const row = await aiAttachmentStore('readonly', store => store.get(id));
    return { pages: message.visionFiles.map(file => file.pdfPage),
      refs: message.visionFiles.every(file => file.originalFileId === id), size: row.blob.size };
  });
  expect(pdf.pages).toEqual([2, 3]);
  expect(pdf.refs).toBe(true);
  expect(pdf.size).toBeGreaterThan(0);
  const convId = await page.evaluate(() => {
    const conv = getActiveConv(); conv.title = '性能回收站测试';
    safeSaveAiConvs(); renderAiConvTabs();
    window.showCustomConfirm = window.__originalConfirm;
    return conv.id;
  });
  await page.locator('.ai-conv-tab.active .ai-conv-tab-delete').click();
  await page.locator('#confirmOk').click();
  await expect.poll(() => page.evaluate(() => loadTrash('ai').length)).toBe(1);
  expect(await page.evaluate(() => Object.hasOwn(loadTrash('ai')[0], 'messages'))).toBe(false);
  await page.evaluate(() => StudyData.flush());
  await page.reload();
  await page.waitForSelector('#section-today.active');
  await page.evaluate(() => switchTab('trash'));
  const row = page.locator('#trashContainer .trash-item').filter({ hasText: '性能回收站测试' });
  await row.getByTitle('恢复', { exact: true }).click();
  await expect(row).toHaveCount(0);
  const restored = await page.evaluate(async id => {
    const conv = aiConvs.find(conv => conv.id === id);
    const message = conv.messages.filter(message => message.role === 'user').at(-1);
    const original = await aiAttachmentStore('readonly', store => store.get(message.attachments[0].originalFileId));
    return { pages: message.visionFiles.map(file => file.pdfPage), size: original.blob.size };
  }, convId);
  expect(restored.pages).toEqual([2, 3]);
  expect(restored.size).toBe(pdf.size);
});

test('normal images decode once', async ({ page }) => {
  await setup(page);
  const image = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 3000; canvas.height = 1600;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#333'; context.font = '40px sans-serif'; context.fillText('Study image', 100, 100);
    const file = new File([await canvasToBlob(canvas, 'image/png')], 'image.png', { type: 'image/png' });
    let decodes = 0;
    const decode = decodeImageBitmap;
    decodeImageBitmap = async file => { decodes++; return decode(file); };
    const started = performance.now();
    try {
      const output = await normalizeAiImageForApi(file);
      return { decodes, width: output.info.width, ms: performance.now() - started, valid: output.dataUrl.startsWith('data:image/') };
    } finally { decodeImageBitmap = decode; }
  });
  expect(image.decodes).toBe(1);
  expect(image.width).toBe(2048);
  expect(image.valid).toBe(true);
  console.log(`3000px image: ${image.ms.toFixed(1)} ms, ${image.decodes} decode`);
});
