'use strict';
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test.use({ channel: process.env.MST_TEST_BROWSER || 'chrome', serviceWorkers: 'block',
  viewport: { width: 1200, height: 900 } });

test.beforeEach(async ({ page }) => {
  const root = path.resolve(__dirname, '../..');
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'study-table.test') return route.abort();
    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404 });
    return route.fulfill({ path: file });
  });
  await page.goto('http://study-table.test/');
  await page.waitForSelector('#section-today.active');
  await page.evaluate(() => {
    window.getEffectiveApiConfig = () => ({ apiKey: 'fake', model: 'test', name: '测试' });
    notes.push({ id: 88992, type: 'note', title: '浮窗引用', parentId: null,
      content: '# 原文标题\n\n原文 **重点**' });
    switchTab('ai');
    createNewConv();
    appendMessage(getActiveConv(), { role: 'user', content: '请解释这篇笔记' });
    appendMessage(getActiveConv(), { role: 'assistant', content: '# 回复总览\n\n'
      + '浮窗正文及公式 $x^2$。\n\n'.repeat(30) + '## 详细解释\n\n详细内容\n\n'
      + '[查看笔记原文](#note=88992&offset=8&endOffset=10)' });
    renderAiChat();
    switchTab('notes');
    selectNote(88992);
    switchNoteView('preview');
    setNotesImmersive(true);
    showAiFloat();
    window.__floatLayout = document.getElementById('aiChatLayout');
  });
});

test('reply reading fills the float with working zoom, TOC and Esc, preserving the page and draft', async ({ page }) => {
  const panel = page.locator('#aiFloat');
  const opener = panel.locator('.ai-msg-immersive');
  await page.locator('#aiInput').fill('保留草稿');
  const original = await panel.boundingBox();
  const bubbleHtml = await panel.locator('.assistant .ai-chat-bubble').innerHTML();
  await opener.click();
  const reader = panel.locator('#aiMessageImmersive');
  await expect(reader).toBeVisible();
  await expect(reader).toHaveAttribute('aria-modal', 'false');
  const bounds = await reader.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(original.x);
  expect(bounds.y).toBeGreaterThan(original.y);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(original.x + original.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(original.y + original.height);
  await expect(panel.getByRole('button', { name: '收起 AI 浮窗', exact: true })).toBeVisible();
  await expect(reader.locator('.katex').first()).toBeVisible();
  await expect(page.locator('#aiMessageImmersiveToc')).toBeHidden();
  await page.locator('#aiMessageImmersiveTocToggle').click();
  await expect(page.locator('#aiMessageImmersiveToc')).toBeVisible();
  await page.locator('#aiMessageImmersiveTocList button').last().click();
  await expect.poll(() => page.locator('#aiMessageImmersiveArticle').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.locator('#aiMessageImmersiveTocToggle').click();
  await page.keyboard.press('Control+Equal');
  await expect(page.locator('#aiMessageImmersiveZoomValue')).toHaveText('110%');
  expect(await page.evaluate(() => notesImmersiveZoom)).toBe(100);
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(opener).toBeFocused();
  await expect(page.locator('#section-notes')).toHaveClass(/notes-immersive/);
  await expect(panel.locator('.assistant .ai-chat-bubble')).toHaveJSProperty('innerHTML', bubbleHtml);
  await expect(page.locator('#aiInput')).toHaveValue('保留草稿');
  expect(await panel.boundingBox()).toEqual(original);

  // The same controls fit in the minimum-width floating surface.
  await page.setViewportSize({ width: 390, height: 720 });
  await page.evaluate(() => { document.getElementById('aiFloat').style.width = '320px'; });
  await opener.click();
  const narrow = await reader.boundingBox();
  for (const button of await reader.locator('.ai-message-immersive-header button').all()) {
    await expect(button).toBeInViewport();
    const box = await button.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(narrow.x);
    expect(box.x + box.width).toBeLessThanOrEqual(narrow.x + narrow.width);
  }
  await page.screenshot({ path: test.info().outputPath('ai-float-contained-reader.png') });
  await page.keyboard.press('Control+Shift+A');
  await expect(panel).toHaveCount(0);
  await expect(page.locator('#aiMessageImmersive')).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveClass(/ai-message-immersive-open/);
  await page.keyboard.press('Control+Shift+A');
  await expect(page.locator('#aiInput')).toHaveValue('保留草稿');
  expect(await page.evaluate(() => document.getElementById('aiChatLayout') === window.__floatLayout)).toBe(true);

  // The full AI page keeps its existing window-filling reader.
  await panel.getByRole('button', { name: '展开到 AI 页面', exact: true }).click();
  await page.locator('#section-ai .ai-msg-immersive').click();
  await expect(page.locator('body > #aiMessageImmersive')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/ai-message-immersive-open/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#aiMessageImmersive')).toHaveCount(0);
});

test('note links from the floating reply reader open the formatted note reading page', async ({ page }) => {
  await page.locator('#aiFloat .ai-msg-immersive').click();
  await page.locator('#aiMessageImmersive a[href^="#note="]').click();
  await expect(page.locator('#aiMessageImmersive')).toHaveCount(0);
  await expect(page.locator('#section-notes')).toHaveClass(/active/);
  await expect(page.locator('#notesPreview')).toBeVisible();
  await expect(page.locator('#notesPreview strong')).toHaveText('重点');
  await expect(page.locator('#notesTextarea')).toBeHidden();
  await expect(page.locator('#aiFloat')).toBeVisible();
  expect(await page.evaluate(() => noteViewMode)).toBe('preview');
});
