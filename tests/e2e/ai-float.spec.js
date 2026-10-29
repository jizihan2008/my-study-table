'use strict';
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('AI float shares the chat, draft and streaming surface across shortcuts and navigation', async () => {
  test.setTimeout(60000);
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-ai-float-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.waitForSelector('#section-today.active');
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.evaluate(() => {
      switchTab('ai'); createNewConv();
      appendMessage(getActiveConv(), { role: 'user', content: '浮窗里的问题' });
      renderAiChat();
      window.__chatSurface = document.getElementById('aiChatLayout');
      switchTab('today');
    });
    await page.keyboard.press('Control+Shift+A');
    await expect(page.getByRole('dialog', { name: 'AI 对话浮窗' })).toBeVisible();
    await expect(page.locator('#section-today')).toHaveClass(/active/);
    await expect(page.locator('#aiFloat #aiMessages')).toContainText('浮窗里的问题');
    const panel = page.locator('#aiFloat');
    async function drag(locator, dx, dy) {
      const box = await locator.boundingBox();
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 8 });
      await page.mouse.up();
    }
    const original = await panel.boundingBox();
    await drag(page.locator('.ai-float-header strong'), -120, -80);
    let moved = await panel.boundingBox();
    expect(moved.x).toBeCloseTo(original.x - 120, 0);
    expect(moved.y).toBeCloseTo(original.y - 80, 0);
    await drag(page.locator('.ai-float-resize-se'), -70, -80);
    let resized = await panel.boundingBox();
    expect(resized.width).toBeCloseTo(original.width - 70, 0);
    expect(resized.height).toBeCloseTo(original.height - 80, 0);
    await drag(page.locator('.ai-float-resize-nw'), -30, -30);
    resized = await panel.boundingBox();
    expect(resized.width).toBeCloseTo(original.width - 40, 0);
    expect(resized.height).toBeCloseTo(original.height - 50, 0);
    await page.keyboard.press('Control+Shift+A');
    await page.keyboard.press('Control+Shift+A');
    expect(await panel.boundingBox()).toEqual(resized);
    for (const material of ['frosted', 'liquid']) {
      await page.evaluate(material => updateAppearance({ material, glassQuality: 'high', glassMotion: true }), material);
      await expect(page.locator('html')).toHaveAttribute('data-material', material);
      await expect.poll(() => panel.evaluate(el => getComputedStyle(el).backdropFilter)).toContain('blur');
      if (material === 'liquid') {
        await expect(page.locator('html')).toHaveAttribute('data-glass-renderer', 'liquid');
        await expect.poll(() => panel.evaluate(el => getComputedStyle(el).backdropFilter)).toContain('liquid-glass-filter');
        await page.mouse.move(resized.x + 50, resized.y + 20);
        await expect.poll(() => panel.evaluate(el => el.style.getPropertyValue('--glass-pointer-active'))).toBe('1');
      }
      expect(await page.locator('#aiChatLayout').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
      await drag(page.locator('.ai-float-header strong'), -20, 10);
      await drag(page.locator('.ai-float-resize-e'), 20, 0);
      await page.screenshot({ path: test.info().outputPath('ai-float-' + material + '.png') });
    }
    await drag(page.locator('.ai-float-resize-se'), -1000, -1000);
    expect((await panel.boundingBox()).width).toBe(320);
    expect((await panel.boundingBox()).height).toBe(360);
    const toolbar = page.locator('#aiToolbar');
    expect((await toolbar.boundingBox()).height).toBeLessThanOrEqual(85);
    await expect(page.locator('#aiToolbarTreeBtn')).toBeVisible();
    await expect(page.locator('#aiToolbarTreeBtn span')).toBeHidden();
    await page.getByRole('button', { name: '收起工具', exact: true }).click();
    await expect(page.getByRole('button', { name: '展开工具', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#aiToolbarToggles')).toBeHidden();
    await expect(page.locator('#aiToolbarQuick')).toBeHidden();
    await expect(page.locator('#aiToolbarKeySelect')).toBeVisible();
    expect((await toolbar.boundingBox()).height).toBeLessThanOrEqual(45);
    await page.evaluate(() => renderAiChat());
    await expect(page.locator('#aiToolbarToggles')).toBeHidden();
    await page.screenshot({ path: test.info().outputPath('ai-float-toolbar-collapsed.png') });
    await page.getByRole('button', { name: '展开工具', exact: true }).click();
    await expect(page.locator('#aiToolbarToggles')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('ai-float-toolbar-compact.png') });
    await page.getByRole('button', { name: '收起工具', exact: true }).click();
    await expect(page.locator('#aiSendBtn')).toBeAttached();
    await page.locator('#aiSendBtn').scrollIntoViewIfNeeded();
    await expect(page.locator('#aiSendBtn')).toBeInViewport();
    await drag(page.locator('.ai-float-resize-se'), 100, 220);
    await page.evaluate(() => {
      document.getElementById('aiInput').value = '保留的草稿';
      setAiLoading(getActiveConv().id, true);
      setAiStreamingDraft(getActiveConv().id, { content: '浮窗流式回复' });
      renderAiMessages();
    });
    await expect(page.locator('#aiFloat #aiMessages')).toContainText('浮窗流式回复');
    await page.keyboard.press('Control+Shift+A');
    await expect(page.locator('#aiFloat')).toHaveCount(0);
    await page.keyboard.press('Control+Shift+A');
    await expect(page.locator('#aiInput')).toHaveValue('保留的草稿');
    await page.getByRole('button', { name: '展开到 AI 页面', exact: true }).click();
    await expect(page.locator('#aiFloat')).toHaveCount(0);
    await expect(page.locator('#section-ai #aiInput')).toHaveValue('保留的草稿');
    await expect(page.locator('#section-ai #aiToolbarToggles')).toBeVisible();
    await expect(page.locator('#section-ai .ai-float-toolbar-toggle')).toBeHidden();
    expect(await page.evaluate(() => document.getElementById('aiChatLayout') === window.__chatSurface)).toBe(true);
    await page.getByRole('button', { name: 'AI 浮窗 Ctrl+Shift+A' }).click();
    await page.evaluate(() => switchTab('ai'));
    await expect(page.locator('#aiFloat')).toHaveCount(0);
    await page.keyboard.press('Control+Alt+Shift+A');
    await expect(page.locator('#aiFloat')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 720 });
    await page.keyboard.press('Control+Shift+A');
    const bounds = await page.locator('#aiFloat').boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await page.keyboard.press('Escape');
    await expect(page.locator('#aiFloat')).toHaveCount(0);
    await page.evaluate(() => {
      clearAiStreamingDraft(getActiveConv().id, false);
      setAiLoading(getActiveConv().id, false);
      window.loadApiKeys = () => [{ id: 'test', apiKey: 'fake', model: 'test', name: '测试' }];
      window.getEffectiveApiConfig = () => ({ apiKey: 'fake', model: 'test', name: '测试' });
      window.isAutoTitleEnabled = () => false;
      window.runToolCallLoop = async () => ({ finalCleanText: '浮窗发送成功', finalRawReply: '浮窗发送成功', finishReason: 'stop' });
    });
    await page.keyboard.press('Control+Shift+A');
    await expect(page.locator('#aiInput')).toBeFocused();
    await page.locator('#aiFileInput').setInputFiles({ name: '资料.txt', mimeType: 'text/plain', buffer: Buffer.from('附件内容') });
    await page.locator('#aiInput').fill('请阅读附件');
    await page.keyboard.press('Control+Shift+A');
    await page.keyboard.press('Control+Shift+A');
    await expect(page.locator('#aiAttachPreview')).toContainText('资料.txt');
    await page.keyboard.press('Enter');
    await expect(page.locator('#aiMessages')).toContainText('浮窗发送成功');
    await page.getByRole('button', { name: '展开到 AI 页面', exact: true }).click();
    await expect(page.locator('#section-ai #aiMessages')).toContainText('浮窗发送成功');
    const savedGeometry = await page.evaluate(() => JSON.parse(localStorage.getItem('study_ai_float_geometry')));
    await page.reload();
    await page.waitForSelector('#section-today.active');
    await page.keyboard.press('Control+Shift+A');
    const restored = await panel.boundingBox();
    expect(restored.x).toBeCloseTo(savedGeometry.x, 0);
    expect(restored.y).toBeCloseTo(savedGeometry.y, 0);
    expect(restored.width).toBeCloseTo(savedGeometry.width, 0);
    expect(restored.height).toBeCloseTo(savedGeometry.height, 0);
    await expect(page.getByRole('button', { name: '展开工具', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#aiToolbarToggles')).toBeHidden();
    await page.getByRole('button', { name: '展开工具', exact: true }).click();
    await expect(page.locator('#aiToolbarTreeBtn')).toBeVisible();
  } finally {
    if (app) await app.close();
    await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
