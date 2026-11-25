'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test.use({ channel: 'chrome', viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });

test('copies the screenshot card as a PNG through Electron', async () => {
  const profile = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mst-screenshot-copy-'));
  let app;
  try {
    app = await electron.launch({
      args: [path.resolve(__dirname, '../..'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: profile }
    });
    await app.evaluate(({ clipboard, nativeImage }) => {
      clipboard.write = async ([item]) => {
        const png = await item.getType('image/png');
        const image = nativeImage.createFromBuffer(Buffer.from(await png.arrayBuffer()));
        globalThis.testScreenshot = { type: png.type, size: image.getSize() };
      };
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof loadAiScreenshotCards === 'function' && typeof showAiToast === 'function');
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 12;
      canvas.height = 8;
      canvas.getContext('2d').fillRect(0, 0, 12, 8);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const fileId = 'clipboard-screenshot';
      const conv = { id: 'clipboard-conversation' };
      _aiOriginalFileFallback.set(fileId, { convId: conv.id, blob });
      const container = document.createElement('div');
      container.innerHTML = renderAiScreenshotCards({
        visionFiles: [{ name: 'screenshot.png', screenshot: { fileId, label: '截图' } }]
      });
      document.body.prepend(container);
      loadAiScreenshotCards(container, conv);
    });

    await page.getByRole('button', { name: '复制截图' }).click();
    await expect(page.locator('#aiToast')).toHaveText('截图已复制');
    expect(await app.evaluate(() => globalThis.testScreenshot)).toEqual({
      type: 'image/png', size: { width: 12, height: 8 }
    });
  } finally {
    try {
      await app?.close();
    } finally {
      await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});

function scannedPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [5 0 R 8 0 R 11 0 R 14 0 R] /Count 4 >>'
  ];
  for (let index = 0; index < 4; index++) {
    const colors = ['0000ff', index === 3 ? '00ff00' : 'ff0000'];
    const raster = (colors[0] + colors[1]).repeat(2) + '>';
    const paint = 'q 100 0 0 100 0 0 cm /Im0 Do Q';
    const imageId = 3 + index * 3;
    objects.push(
      '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 '
        + '/Filter /ASCIIHexDecode /Length ' + raster.length + ' >>\nstream\n' + raster + '\nendstream',
      '<< /Length ' + paint.length + ' >>\nstream\n' + paint + '\nendstream',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im0 '
        + imageId + ' 0 R >> >> /Contents ' + (imageId + 1) + ' 0 R >>'
    );
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  });
  const xref = pdf.length;
  pdf += 'xref\n0 ' + offsets.length + '\n0000000000 65535 f \n'
    + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
    + 'trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(pdf);
}

test('folds unselected PDF crops and replaces the sent screenshot on the same chat card', async ({ page }) => {
  test.setTimeout(45000);
  const root = path.resolve(__dirname, '../..');
  const batches = [];
  let sourceId;
  const rect = { left: 0.6, top: 0.2, right: 0.95, bottom: 0.8 };
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'localhost') return route.abort();
    if (url.pathname === '/mock/v1/chat/completions') {
      const body = route.request().postDataJSON();
      let content;
      if (Array.isArray(body.messages[0].content) && body.messages[0].content[0].text.startsWith('在接下来的 PDF')) {
        const pages = body.messages[0].content.filter(part => part.type === 'text').slice(1).map(part => Number(part.text.match(/\d+/)[0]));
        batches.push({ pages, tools: body.tools });
        content = JSON.stringify({ page: pages.includes(4) ? 4 : null });
      } else {
        const last = body.messages.at(-1).content;
        const text = Array.isArray(last) ? last.find(part => part.type === 'text')?.text : last;
        let tool;
        if (text?.includes('帮我在整本扫描 PDF 里找绿色图形并截图')) {
          tool = { action: 'find_pdf_screenshot_region', params: { sourceId, query: '绿色图形' } };
        } else if (text?.includes('"action":"find_pdf_screenshot_region"')) {
          tool = { action: 'preview_screenshot_source', params: { sourceId, pdfPage: 4 } };
        } else if (text?.includes('scan.pdf 第 4 页')) {
          const crops = [
            { action: 'crop_screenshot', params: { sourceId, pdfPage: 3, rect } },
            { action: 'crop_screenshot', params: { sourceId, pdfPage: 4, rect } }
          ];
          content = crops.map(crop => '<tool_call>' + JSON.stringify(crop) + '</tool_call>').join('\n');
        } else if (text?.includes('scan.pdf-第4页-截图.png') && Array.isArray(last)) {
          const results = body.messages.at(-2).content;
          const screenshotId = [...results.matchAll(/"screenshotId":"([^"]+)"/g)].at(-1)?.[1];
          tool = { action: 'send_screenshot', params: { screenshotId } };
        }
        content ??= tool ? '<tool_call>' + JSON.stringify(tool) + '</tool_call>' : '已截取绿色图形。';
      }
      return route.fulfill({ json: { choices: [{ message: { content }, finish_reason: 'stop' }] } });
    }
    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404 });
    return route.fulfill({ path: file });
  });
  await page.goto('http://localhost/');
  await page.waitForSelector('#section-today.active');
  await page.evaluate(async () => {
    await saveApiKeys([{ id: 'local', name: '视觉测试', key: 'fake', model: 'deepseek-flash', baseUrl: 'http://localhost/mock/v1' }], { sync: false });
    localStorage.setItem('study_active_api_key_id', 'local');
    localStorage.setItem('study_ai_streaming', 'false');
    isAutoTitleEnabled = () => false;
    scheduleMemoryExtract = () => {};
    switchTab('files');
  });
  await page.locator('#fileLibraryInput').setInputFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: scannedPdf() });
  await expect(page.locator('#fileLibraryList')).toContainText('scan.pdf');
  sourceId = await page.evaluate(async () => (await window.aiFileLibrary.list()).find(file => file.name === 'scan.pdf').id);
  await page.evaluate(() => { switchTab('ai'); createNewConv(); });
  await page.locator('#aiInput').fill('帮我在整本扫描 PDF 里找绿色图形并截图');
  await page.evaluate(() => { void sendAiMessage(); });
  const cards = page.locator('.ai-screenshot-card');
  const card = cards.filter({ hasNotText: 'PDF 第 3 页' });
  await expect(card).toContainText('PDF 第 4 页', { timeout: 15000 });
  await expect(page.locator('#aiMessages')).toContainText('已截取绿色图形');
  await expect(cards).toHaveCount(1);
  const fold = page.locator('.ai-reply-chain-toggle');
  await fold.click();
  await expect(page.locator('.ai-reply-chain-history .ai-screenshot-card')).toHaveText(/PDF 第 3 页/);
  await expect(cards).toHaveCount(2);
  await fold.click();
  await expect(cards).toHaveCount(1);
  expect(batches).toEqual([{ pages: [1, 2, 3], tools: undefined }, { pages: [4], tools: undefined }]);
  await expect(card.locator('img')).toBeVisible();
  expect(await card.locator('img').evaluate(async img => {
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return [...ctx.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data];
  })).toEqual([0, 255, 0, 255]);
  await expect(card.getByRole('link', { name: '下载 PNG' })).toHaveAttribute('download', /第4页-截图\.png$/);

  await page.reload();
  await page.waitForSelector('#section-today.active, #section-ai.active');
  await page.evaluate(() => switchTab('ai'));
  await expect(card).toHaveCount(1);
  const originalFile = await card.getAttribute('data-screenshot-file');
  const originalNode = await card.getByRole('button', { name: '调整选区' }).getAttribute('data-node-id');
  await page.evaluate(() => applyTheme('dark'));
  await card.getByRole('button', { name: '调整选区' }).click();
  const editor = page.getByRole('dialog', { name: '框选截图' });
  await expect(editor.getByLabel('PDF 页码')).toHaveValue('4');
  await expect(editor.getByLabel('左', { exact: true })).toHaveValue('60');
  const cropBox = await editor.locator('.ai-screenshot-stage img').boundingBox();
  const leftHandle = await editor.locator('[data-edge="w"]').boundingBox();
  const oldTop = await editor.getByLabel('上', { exact: true }).inputValue();
  await page.mouse.move(leftHandle.x + leftHandle.width / 2, leftHandle.y + leftHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(cropBox.x + cropBox.width * 0.4, leftHandle.y + leftHandle.height / 2);
  await page.mouse.up();
  expect(Number(await editor.getByLabel('左', { exact: true }).inputValue())).toBeCloseTo(40, 0);
  await expect(editor.getByLabel('上', { exact: true })).toHaveValue(oldTop);
  expect(await editor.evaluate(dialog => dialog.querySelector('.ai-screenshot-footer').getBoundingClientRect().top
    - dialog.querySelector('[data-coordinates]').getBoundingClientRect().bottom)).toBeLessThan(28);
  await editor.getByLabel('PDF 页码').fill('2');
  await editor.getByRole('button', { name: '跳转' }).click();
  await expect(editor).toContainText('第 2 页 / 共 4 页');
  await editor.getByLabel('左', { exact: true }).fill('60');
  await page.evaluate(() => {
    const save = safeSaveAiConvs;
    safeSaveAiConvs = () => { safeSaveAiConvs = save; return false; };
  });
  const overwrite = editor.getByRole('button', { name: '保存并覆盖' });
  await overwrite.click();
  await expect(editor.getByRole('status')).toContainText('聊天保存失败');
  await expect(card).toHaveAttribute('data-screenshot-file', originalFile);
  expect(await page.evaluate(id => getActiveConv().tree[id].visionFiles.find(file => file.screenshot.page === 4).screenshot.page, originalNode)).toBe(4);
  await overwrite.click();
  await expect(editor).toBeHidden();
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('PDF 第 2 页');
  await expect(card).not.toHaveAttribute('data-screenshot-file', originalFile);
  await expect(card.getByRole('button', { name: '调整选区' })).toHaveAttribute('data-node-id', originalNode);
  await expect(card.getByRole('link', { name: '下载 PNG' })).toHaveAttribute('download', /第2页-截图\.png$/);
  await expect.poll(() => page.evaluate(async id => !!await aiAttachmentStore('readonly', store => store.get(id)), originalFile)).toBe(false);
  await page.reload();
  await page.waitForSelector('#section-today.active, #section-ai.active');
  await page.evaluate(() => switchTab('ai'));
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('PDF 第 2 页');
  await expect(card.locator('img')).toBeVisible();

  const imageBytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 40;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, 40, 40);
    ctx.fillStyle = 'blue';
    ctx.fillRect(40, 0, 40, 40);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await page.locator('#aiFileInput').setInputFiles({ name: 'figure.png', mimeType: 'image/png', buffer: Buffer.from(imageBytes) });
  await page.locator('#aiInput').fill('这是另一张原图');
  await page.evaluate(() => sendAiMessage());
  await expect(page.locator('#aiMessages')).toContainText('这是另一张原图');
  const direct = await page.evaluate(async () => {
    const conv = getActiveConv();
    const context = { conv, apiCfg: getEffectiveApiConfig() };
    const listing = await executeToolCallStructured('list_screenshot_attachments', { search: 'figure.png' }, context);
    const sourceId = listing.data.items[0].sourceId;
    const crop = await executeToolCallStructured('crop_screenshot', {
      sourceId, rect: { left: 0.5, top: 0, right: 1, bottom: 1 }
    }, context);
    const row = await aiAttachmentStore('readonly', store => store.get(crop.visionFiles[0].screenshot.fileId));
    const bitmap = await createImageBitmap(row.blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixel = [...ctx.getImageData(20, 20, 1, 1).data];
    return { width: canvas.width, height: canvas.height, pixel };
  });
  expect(direct).toEqual({ width: 40, height: 40, pixel: [0, 0, 255, 255] });
  await page.locator('.msg-attachment-item').getByRole('button', { name: '截图', exact: true }).click();
  await expect(editor.getByRole('img', { name: '截图来源预览' })).toBeVisible();
  await expect(editor.getByLabel('PDF 页码')).toBeHidden();
  await editor.getByRole('button', { name: '保存到当前聊天' }).click();
  await expect(card).toHaveCount(2);
});
