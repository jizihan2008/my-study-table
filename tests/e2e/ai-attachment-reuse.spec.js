'use strict';
const { test, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { buildTestPdf } = require('../fixtures/books-pdf');
const root = path.resolve(__dirname, '../..');
let server, baseUrl;
test.use({ channel: 'chrome', viewport: { width: 390, height: 844 } });
test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const target = path.resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      response.writeHead(404); response.end(); return;
    }
    const type = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css' }[path.extname(target)] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type }); fs.createReadStream(target).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

async function setup(page) {
  await page.evaluate(() => {
    window.loadApiKeys = () => [{ id: 'test', apiKey: 'fake', model: 'deepseek-flash', name: '附件测试' }];
    window.getEffectiveApiConfig = () => ({ apiKey: 'fake', model: 'deepseek-flash', name: '附件测试' });
    window.isAutoTitleEnabled = () => false;
    window.runToolCallLoop = async () => ({ finalCleanText: '已读取', finalRawReply: '已读取', finishReason: 'stop' });
    switchTab('ai');
  });
}

test('text originals remain readable after sending, reload and context compression', async ({ page }) => {
  await page.goto(baseUrl + '/index.html');
  await setup(page);
  await page.evaluate(() => createNewConv());
  const convId = await page.evaluate(() => getActiveConvId());
  const text = '完整文字资料\n'.repeat(2000) + '全文最后一行';
  await page.locator('#aiFileInput').setInputFiles({ name: '全文资料.txt', mimeType: 'text/plain', buffer: Buffer.from(text) });
  await page.locator('#aiInput').fill('阅读附件');
  await page.evaluate(() => sendAiMessage());
  await page.reload();
  await setup(page);
  const result = await page.evaluate(async id => {
    switchConv(id);
    const conv = getActiveConv();
    const attachment = conv.messages.find(message => message.attachments?.length).attachments[0];
    for (let i = 0; i < 25; i++) {
      appendMessage(conv, { role: 'user', content: '后续问题 ' + i });
      appendMessage(conv, { role: 'assistant', content: '后续回答' });
    }
    appendMessage(conv, { role: 'user', content: '重新读取文字文件' });
    const cfg = { model: 'deepseek-flash', contextLimit: 2, contextBudget: 32768 };
    const messages = buildApiMessages(conv, null, cfg);
    const list = await executeToolCallStructured('list_conversation_files', { search: '全文资料' }, { conv });
    const fileId = list.data.items[0].fileId;
    let recovered = '', offset = 0;
    do {
      const part = await executeToolCallStructured('read_conversation_file', { fileId, offset, limit: 3000 }, { conv });
      if (!part.ok) throw new Error(part.text);
      recovered += part.data.content;
      offset = part.data.nextOffset;
    } while (offset !== null);
    return { recovered, preview: attachment.content,
      notice: messages.find(message => String(message.content).startsWith('【历史文字附件清单'))?.content,
      fileId, storedId: attachment.originalFileId };
  }, convId);
  expect(result.preview).toContain('已截断');
  expect(result.storedId).toBeTruthy();
  expect(result.recovered).toBe(text);
  expect(result.notice).toContain('全文资料.txt');
  expect(result.notice).toContain(result.fileId);
});

test('conversation attachment group appears in settings and controls all four tool entries', async ({ page }) => {
  await page.goto(baseUrl + '/index.html');
  await setup(page);
  await page.evaluate(() => createNewConv());
  await page.evaluate(() => openAiToolSettingsModal());
  const group = page.locator('#aiToolSettingsGroups .ai-tool-group-item').filter({ hasText: '对话附件' });
  await expect(group).toBeVisible();
  await expect(group.locator('.ai-tool-group-count')).toHaveText('4');
  const checkbox = group.locator('input');
  await checkbox.check();
  const available = () => page.evaluate(() => [...selectAiToolsForConversation(getActiveConv(), false, false, getEffectiveApiConfig())]
    .filter(name => /^(list|read)_conversation_(files?|images?)$/.test(name)).sort());
  expect(await available()).toEqual(['list_conversation_files', 'list_conversation_images', 'read_conversation_file', 'read_conversation_image']);
  await checkbox.uncheck();
  expect(await available()).toEqual([]);
  await page.reload();
  await setup(page);
  await page.evaluate(() => openAiToolSettingsModal());
  await expect(checkbox).not.toBeChecked();
  expect(await available()).toEqual([]);
});

test('sent PDF and image can be inserted after reload, while drafts stay in their conversation', async ({ page }) => {
  await page.goto(baseUrl + '/index.html');
  await setup(page);
  await page.evaluate(() => createNewConv());
  const convId = await page.evaluate(() => getActiveConvId());
  const pdf = buildTestPdf(3);
  await page.locator('#aiFileInput').setInputFiles({ name: '教材.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.getByRole('spinbutton', { name: 'PDF 起始页' }).fill('2');
  await page.getByRole('spinbutton', { name: 'PDF 起始页' }).press('Tab');
  await page.getByRole('spinbutton', { name: 'PDF 结束页' }).fill('3');
  await page.getByRole('spinbutton', { name: 'PDF 结束页' }).press('Tab');
  await page.locator('#aiInput').fill('解释资料');
  await page.evaluate(() => sendAiMessage());
  await expect(page.getByRole('button', { name: '再次插入 教材.pdf', exact: true })).toBeVisible();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=', 'base64');
  await page.locator('#aiFileInput').setInputFiles({ name: '截图.png', mimeType: 'image/png', buffer: png });
  await page.evaluate(() => sendAiMessage());
  await page.reload();
  await setup(page);
  await page.evaluate(id => switchConv(id), convId);
  await page.getByRole('button', { name: '本对话文件', exact: true }).click();
  await expect(page.locator('#aiConversationFilesPicker')).toContainText('教材.pdf');
  await expect(page.locator('#aiConversationFilesPicker')).toContainText('截图.png');
  await page.screenshot({ path: test.info().outputPath('conversation-files.png') });
  await page.getByRole('searchbox', { name: '搜索本对话文件' }).fill('教材');
  await expect(page.locator('#aiConversationFilesPicker .file-library-picker-list > button')).toHaveCount(1);
  await page.locator('#aiConversationFilesPicker .file-library-picker-list > button').click();
  await expect(page.getByRole('spinbutton', { name: 'PDF 起始页' })).toHaveValue('2');
  await expect(page.getByRole('spinbutton', { name: 'PDF 结束页' })).toHaveValue('3');
  expect(await page.evaluate(async () => Array.from(new Uint8Array(await getAiAttachments()[0].file.arrayBuffer())))).toEqual(Array.from(pdf));
  await page.evaluate(() => createNewConv());
  await expect(page.locator('#aiAttachPreview')).toBeHidden();
  await page.getByRole('button', { name: '本对话文件', exact: true }).click();
  await expect(page.locator('#aiConversationFilesPicker')).toContainText('本对话还没有发送文件');
  await page.evaluate(id => switchConv(id), convId);
  await expect(page.locator('#aiConversationFilesPicker')).toHaveCount(0);
  await expect(page.locator('#aiAttachPreview')).toContainText('教材.pdf');
  await page.getByRole('button', { name: '再次插入 截图.png', exact: true }).click();
  await expect(page.locator('#aiAttachPreview')).toContainText('截图.png');
  expect(await page.evaluate(async () => {
    const file = getAiAttachments().find(a => a.name === '截图.png').originalFile;
    return Array.from(new Uint8Array(await file.arrayBuffer()));
  })).toEqual(Array.from(png));
  expect(await page.locator('#aiInput').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(280);
  await expect(page.locator('#aiSendBtn')).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('reinserted-attachments.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator('#aiConversationFilesBtn')).toBeInViewport();
  await expect(page.locator('#aiSendBtn')).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('desktop-reinserted-attachments.png') });
  await page.evaluate(() => { window.showCustomConfirm = async () => true; clearConvMessages(); });
  await expect.poll(() => page.evaluate(async () => {
    const db = await openAiAttachmentDb();
    return new Promise(resolve => {
      const request = db.transaction('files').objectStore('files').count();
      request.onsuccess = () => { db.close(); resolve(request.result); };
    });
  })).toBe(0);
});

test('legacy messages explain that the original file needs uploading', async ({ page }) => {
  await page.goto(baseUrl + '/index.html');
  await setup(page);
  await page.evaluate(() => {
    createNewConv();
    appendMessage(getActiveConv(), { role: 'user', content: '旧资料', attachments: [{ name: '旧教材.pdf', size: 20, content: '摘录' }] });
    renderAiMessages();
  });
  let alertMessage;
  page.once('dialog', async dialog => { alertMessage = dialog.message(); await dialog.accept(); });
  await page.getByRole('button', { name: '再次插入 旧教材.pdf', exact: true }).click();
  expect(alertMessage).toContain('重新上传原文件');
  await expect(page.locator('#aiAttachPreview')).toBeHidden();
});

test('after reload and context eviction the AI can read a PDF page and original uploaded image through native tools', async ({ page }) => {
  await page.goto(baseUrl + '/index.html');
  await setup(page);
  await page.evaluate(() => createNewConv());
  await page.locator('#aiFileInput').setInputFiles({ name: '视觉教材.pdf', mimeType: 'application/pdf', buffer: buildTestPdf(3) });
  await page.evaluate(() => { toggleAttachPdfMode(0); return sendAiMessage(); });
  await page.evaluate(async () => {
    // 建立一张可辨识的原图，上传路径历史只留小缩略图和 file_id。
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 600;
    const context = canvas.getContext('2d'); context.fillStyle = 'red'; context.fillRect(0, 0, 800, 600);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const file = new File([blob], '红色图.png', { type: 'image/png' });
    const reference = await retainAiAttachmentFile({ name: file.name, file }, getActiveConvId());
    const thumb = await downscaleImageForApi(file, { maxEdge: 32 });
    appendMessage(getActiveConv(), { role: 'user', content: '这张图', attachments: [{ name: file.name, ...reference }],
      visionFiles: [{ name: file.name, type: 'file', fileId: 'old-provider-id', dataUrl: thumb.dataUrl, originalFileId: reference.originalFileId }] });
    appendMessage(getActiveConv(), { role: 'assistant', content: '第一轮回复' });
    safeSaveAiConvs();
  });
  await page.reload();
  const result = await page.evaluate(async () => {
    const cfg = { apiKey: 'fake', model: 'deepseek-flash', name: '视觉测试', baseUrl: 'https://api.deepseek.com/v1', contextLimit: 1, contextBudget: 32768 };
    window.getEffectiveApiConfig = () => cfg;
    window.buildConversationSystemPrompt = () => 'Read visual material before answering.';
    const conv = getActiveConv();
    conv._toolGroups = [];
    appendMessage(conv, { role: 'user', content: '重新看红色图和教材第2页' });
    const resources = getAiConversationVisualResources(conv);
    const targets = [resources.find(resource => resource.name === '红色图.png'), resources.find(resource => resource.pdfPage === 2)];
    const requests = [];
    window.callAiApi = async messages => {
      requests.push(messages);
      return requests.length === 1
        ? { cleanText: '', rawReply: '', finishReason: 'tool_calls', toolCalls: targets.map((resource, index) => ({ action: 'read_conversation_image', params: { imageId: resource.imageId }, native: true, callId: 'read-image-' + index })) }
        : { cleanText: '重新看到了图片和第2页', rawReply: '重新看到了图片和第2页', toolCalls: [], finishReason: 'stop' };
    };
    const output = await runToolCallLoop(cfg, conv);
    const pictureParts = messages => messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []);
    const images = pictureParts(requests[1]);
    const sizes = await Promise.all(images.map(async part => {
      const image = new Image(); image.src = part.image_url.url; await image.decode(); return [image.width, image.height];
    }));
    return { answer: output.finalCleanText, calls: requests.length, firstPictures: pictureParts(requests[0]).length,
      notice: requests[0].find(message => String(message.content).startsWith('【历史视觉资料'))?.content,
      sizes, toolReplies: requests[1].filter(message => message.role === 'tool').length,
      finalResources: getAiConversationVisualResources(conv).length };
  });
  expect(result.calls).toBe(2);
  expect(result.firstPictures).toBe(0);
  expect(result.notice).toContain('视觉教材.pdf');
  expect(result.notice).toContain('红色图.png');
  expect(result.notice).toContain('read_conversation_image');
  expect(result.toolReplies).toBe(2);
  expect(result.sizes).toHaveLength(2);
  expect(result.sizes[0]).toEqual([800, 600]);
  expect(result.sizes[1][0]).toBeGreaterThan(500);
  expect(result.finalResources).toBe(4);
  expect(result.answer).toBe('重新看到了图片和第2页');
});
