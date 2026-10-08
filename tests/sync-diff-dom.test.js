'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');

test('conflict details load on demand, escape content, refresh and fit light/dark narrow layouts', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ ...(process.platform === 'win32' ? { channel: 'msedge' } : {}), headless: true });
  } catch (error) {
    if (/Executable doesn't exist|distribution.*not found/.test(error.message)) { t.skip('Browser runtime unavailable'); return; }
    throw error;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 850 } });
    await page.setContent('<main class="preview-shell"></main>');
    await page.addStyleTag({ path: path.join(__dirname, '../css/style.css') });
    await page.addStyleTag({ content: 'body {background:var(--bg);padding:16px;} .preview-shell {max-width:720px;margin:auto;background:var(--card);padding:16px;border-radius:12px;}' });
    for (const file of ['sync-policy.js', 'sync-diff.js']) await page.addScriptTag({ path: path.join(__dirname, '../js', file) });
    const settings = fs.readFileSync(path.join(__dirname, '../js/settings.js'), 'utf8');
    const itemSource = settings.slice(settings.indexOf('function _renderSyncConflictItem('), settings.indexOf('function renderSyncConflicts('));
    await page.addScriptTag({ content: itemSource });
    await page.evaluate(() => {
      window.escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
      window._syncConflictReasonText = () => '本地和云端都发生了修改，请查看具体差异后选择保留的版本。';
      window._formatSyncConflictTime = (_, fallback) => fallback;
      window.previewReads = 0;
      window.failPreview = false;
      window.Sync = { async getConflictDifferences() {
        window.previewReads++;
        if (window.failPreview) throw new Error('网络暂时不可用');
        return { ok: true,
          local: { title: '课程复习笔记', content: '共同内容\n'.repeat(60) + '本地版本：明天复习第三章。', tags: ['数学'], completed: false },
          remote: { title: '课程复习笔记（更新）', content: '共同内容\n'.repeat(60) + '云端版本：今天复习第四章。<img src=x onerror="window.injected=true">', tags: ['数学', '重点'], completed: true }
        };
      } };
      document.querySelector('.preview-shell').innerHTML = _renderSyncConflictItem({ key: 'mst:item:v1:study_notes_v2:1', label: '笔记：课程复习笔记', reason: 'both-changed' }, true, false);
    });
    assert.equal(await page.locator('.sync-conflict-diff').isVisible(), false);
    assert.equal(await page.evaluate(() => window.previewReads), 0);
    await page.getByRole('button', { name: '查看具体差异' }).click();
    await page.locator('.sync-diff-entry').first().waitFor();
    assert.equal(await page.locator('.sync-diff-entry').count(), 4);
    assert.match(await page.locator('.sync-conflict-diff').innerText(), /第 61 行/);
    assert.equal(await page.locator('.sync-conflict-diff img').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await page.evaluate(() => window.previewReads), 1);
    const wideColumns = await page.locator('.sync-diff-columns').first().evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length);
    assert.equal(wideColumns, 2);
    if (process.env.MST_SYNC_DIFF_SCREENSHOT) await page.screenshot({ path: process.env.MST_SYNC_DIFF_SCREENSHOT, fullPage: true });
    await page.setViewportSize({ width: 375, height: 850 });
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    assert.equal(await page.locator('.sync-diff-columns').first().evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.MST_SYNC_DIFF_SCREENSHOT) await page.screenshot({ path: process.env.MST_SYNC_DIFF_SCREENSHOT + '.dark.png', fullPage: true });
    await page.evaluate(() => window.failPreview = true);
    await page.getByRole('button', { name: '刷新具体差异' }).click();
    await page.getByText('无法查看差异：网络暂时不可用').waitFor();
    assert.equal(await page.getByRole('button', { name: '刷新具体差异' }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: '保留本地并上传' }).isEnabled(), true);
  } finally { await browser.close(); }
});
