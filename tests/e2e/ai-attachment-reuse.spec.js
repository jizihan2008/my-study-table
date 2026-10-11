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
