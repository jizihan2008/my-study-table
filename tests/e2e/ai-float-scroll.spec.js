'use strict';
const { test, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
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
      '.css': 'text/css' }[path.extname(target)] || 'application/octet-stream');
    fs.createReadStream(target).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

test('float retains history position when closed, updated while hidden, reopened and rebuilt', async ({ page }) => {
  await page.goto(baseUrl + '/index.html');
  await page.waitForSelector('#section-today.active');
  await page.evaluate(() => {
    window.getEffectiveApiConfig = () => ({ apiKey: 'fake', model: 'test' });
    switchTab('ai'); createNewConv();
    for (let i = 0; i < 35; i++) appendMessage(getActiveConv(), {
      role: i % 2 ? 'assistant' : 'user', content: `第 ${i} 条消息\n\n` + '阅读历史内容。\n\n'.repeat(5)
    });
    renderAiChat(); switchTab('today'); showAiFloat();
  });
  await page.waitForTimeout(200);
  const top = await page.locator('#aiMessages').evaluate(el => { el.scrollTop = 650; return el.scrollTop; });
  expect(top).toBeGreaterThan(0);
  await page.evaluate(() => closeAiFloat());
  await page.waitForTimeout(50);
  await page.evaluate(() => { renderAiMessages(); showAiFloat(); });
  await expect.poll(() => page.locator('#aiMessages').evaluate(el => el.scrollTop)).toBeCloseTo(top, 0);
  await page.evaluate(() => renderAiChat());
  await page.waitForTimeout(200);
  expect(await page.locator('#aiMessages').evaluate(el => el.scrollTop)).toBeCloseTo(top, 0);
  await page.evaluate(() => { closeAiFloat(); showAiFloat(); });
  await expect.poll(() => page.locator('#aiMessages').evaluate(el => el.scrollTop)).toBeCloseTo(top, 0);
  await page.evaluate(() => {
    setAiLoading(getActiveConv().id, true);
    setAiStreamingDraft(getActiveConv().id, { content: '新增的流式回复。'.repeat(150) });
    renderAiMessages();
  });
  expect(await page.locator('#aiMessages').evaluate(el => el.scrollTop)).toBeCloseTo(top, 0);
  await page.evaluate(() => expandAiFloat());
  await expect(page.locator('#section-ai')).toHaveClass(/active/);
  expect(await page.locator('#aiMessages').evaluate(el => el.scrollTop)).toBeCloseTo(top, 0);
  await page.evaluate(() => {
    showAiFloat();
    const messages = document.getElementById('aiMessages');
    messages.scrollTop = messages.scrollHeight;
    closeAiFloat(); switchTab('today');
    setAiStreamingDraft(getActiveConv().id, { content: '后台继续新增的回复。'.repeat(300) });
    renderAiMessages(); showAiFloat();
  });
  expect(await page.locator('#aiMessages').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
  // A small upward wheel gesture must pause following immediately, even inside
  // the old 120px near-bottom region. Exercise the incremental paint path.
  await page.locator('#aiMessages').hover();
  await page.mouse.wheel(0, -60);
  await expect.poll(() => page.locator('#aiMessages').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(20);
  const readingTop = await page.locator('#aiMessages').evaluate(el => el.scrollTop);
  await page.evaluate(() => {
    setAiStreamingDraft(getActiveConv().id, { content: '后台继续新增的回复。'.repeat(320) });
    paintAiStreamingDraft(String(getActiveConv().id));
  });
  expect(await page.locator('#aiMessages').evaluate(el => el.scrollTop)).toBeCloseTo(readingTop, 0);
  await page.evaluate(() => renderAiMessages());
  expect(await page.locator('#aiMessages').evaluate(el => el.scrollTop)).toBeCloseTo(readingTop, 0);
});
