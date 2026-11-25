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

test('library PDF tool shows live progress, survives rebuilding, and cleans up after stopping', async ({ page }) => {
  await page.goto(baseUrl + '/index.html');
  await page.waitForSelector('#section-today.active');
  await page.evaluate(() => {
    switchTab('ai'); createNewConv();
    const conv = getActiveConv();
    window.aiFileLibrary = {
      list: async () => [{ id: 'file_pdf', name: '教材.pdf', kind: 'file', size: 10 }],
      read: async () => new File(['pdf'], '教材.pdf', { type: 'application/pdf' })
    };
    window.isMultimodalModel = () => true;
    window.renderPdfAttachmentPages = async (file, options) => {
      window.pdfProgressOptions = options;
      options.onPage({ done: 0, total: 2 });
      return new Promise(resolve => { window.finishPdfProgress = resolve; });
    };
    window.pdfProgressResult = executeToolCallStructured('read_library_pdf_page',
      { fileId: 'file_pdf', startPage: 4, endPage: 5 }, { conv });
  });
  const progress = page.getByRole('progressbar', { name: 'PDF 页面读取进度' });
  await expect(progress).toHaveAttribute('value', '0');
  await expect(page.locator('#aiPdfSendProgress')).toContainText('第 4–5 页');
  await page.evaluate(() => pdfProgressOptions.onPage({ done: 1, total: 2 }));
  await expect(progress).toHaveAttribute('value', '50');
  await expect(page.locator('#aiPdfSendProgress')).toContainText('教材.pdf · 1/2 页 · 50%');
  await page.evaluate(() => { renderAiMessages(); switchTab('today'); showAiFloat(); });
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute('value', '50');
  const stopped = await page.evaluate(async () => {
    setAiStopRequested(getActiveConv().id, true);
    const aborted = pdfProgressOptions.isAborted();
    finishPdfProgress({ aborted, dataUrls: [] });
    return { aborted, ok: (await pdfProgressResult).ok };
  });
  expect(stopped).toEqual({ aborted: true, ok: false });
  await expect(progress).toHaveCount(0);
});
