'use strict';

const { test, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
let server;
let baseUrl;

test.use({ channel: 'chrome', viewport: { width: 390, height: 844 } });

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const target = path.resolve(root, '.' + pathname);
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      response.writeHead(404); response.end('not found'); return;
    }
    const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json' }[path.extname(target)] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(target).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

test('mobile file library opens and keeps imported files after reload', async ({ page }) => {
  await page.goto(baseUrl + '/index.html');
  await page.evaluate(() => switchTab('files'));
  await expect(page.locator('#section-files')).toHaveClass(/active/);
  await expect(page.locator('#fileLibraryList')).toContainText('文件库还是空的');

  await page.locator('#fileLibraryInput').setInputFiles({ name: 'study.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.locator('#fileLibraryList')).toContainText('study.txt');

  await page.reload();
  await page.evaluate(() => switchTab('files'));
  await expect(page.locator('#fileLibraryList')).toContainText('study.txt');
  await page.locator('#fileLibrarySearch').fill('missing');
  await expect(page.locator('#fileLibraryList')).toContainText('没有匹配的文件');
});

test('file library browses nested folders and keeps imported directory paths', async ({ page }) => {
  await page.goto(baseUrl + '/index.html');
  await page.evaluate(() => switchTab('files'));
  await expect(page.getByRole('button', { name: '导入文件夹' })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建文件夹' })).toBeVisible();
  page.once('dialog', dialog => dialog.accept('课程'));
  await page.getByRole('button', { name: '新建文件夹' }).click();
  await page.locator('#fileLibraryList').getByRole('button', { name: '课程' }).click();

  const source = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mst-e2e-folder-'));
  try {
    fs.mkdirSync(path.join(source, 'chapter'));
    fs.writeFileSync(path.join(source, 'chapter', 'lesson.txt'), 'lesson');
    await page.locator('#fileLibraryFolderInput').setInputFiles(source);
    await expect(page.locator('#fileLibraryList')).toContainText(path.basename(source));
    await page.locator('#fileLibraryList').getByRole('button', { name: path.basename(source) }).click();
    await page.locator('#fileLibraryList').getByRole('button', { name: 'chapter' }).click();
    await expect(page.locator('#fileLibraryList')).toContainText('lesson.txt');
    await page.reload();
    await page.evaluate(() => switchTab('files'));
    await page.locator('#fileLibrarySearch').fill('lesson.txt');
    await expect(page.locator('#fileLibraryList')).toContainText('lesson.txt');
    await page.evaluate(() => openFileLibraryPicker());
    await expect(page.locator('#fileLibraryPicker')).toContainText(`课程 / ${path.basename(source)} / chapter`);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
});
