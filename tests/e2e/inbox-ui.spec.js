'use strict';
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let app, page, profile;
test.beforeAll(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-inbox-ui-'));
  app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'], env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: profile } });
  page = await app.firstWindow();
  await page.waitForFunction(() => !!window.Inbox && !!window.switchTab);
  await expect(page.locator('#section-today')).toBeVisible();
  await page.evaluate(() => window.switchTab('inbox'));
  await expect(page.locator('.inbox-workspace-head')).toBeVisible();
});
test.afterAll(async () => {
  if (app) await app.close();
  if (profile) await fs.rm(profile, { recursive: true, force: true });
});
test('collection, live search and source navigation stay connected', async () => {
  await expect(page.locator('.inbox-status-row')).toBeHidden();
  await page.getByRole('button', { name: '收集文本', exact: true }).click();
  await page.locator('#inboxPasteBody').fill('周五学习计划：整理物理错题');
  await page.getByRole('button', { name: /导入并概括/ }).click();
  await expect(page.locator('.inbox-msg-card')).toHaveCount(1);
  await expect(page.locator('[data-inbox-count="all"]')).toHaveText('1');
  const search = page.getByRole('searchbox', { name: '搜索收件箱消息' });
  await search.fill('找不到的关键词');
  await expect(page.locator('.inbox-empty')).toContainText('没有找到相关消息');
  await expect(search).toBeFocused();
  await search.fill('物理');
  await expect(page.locator('.inbox-msg-card')).toHaveCount(1);
  await page.locator('[data-inbox-source="mail"]').click();
  await expect(page.locator('#inboxViewTitle')).toHaveCount(0);
  await expect(page.locator('#inboxMailCard')).toBeHidden();
  await expect(page.locator('#inboxWatchCard')).toBeHidden();
  await expect(page.locator('[data-inbox-source="mail"]')).toHaveAttribute('aria-pressed', 'true');
  await search.fill('');
  await page.locator('[data-inbox-source="qq"]').click();
  await expect(page.locator('#inboxViewMeta')).toHaveCount(0);
  await expect(page.locator('#inboxQQSearchQuery')).toBeVisible();
  await expect(search).toBeHidden();
  await page.locator('[data-inbox-source="all"]').click();
  await expect(search).toBeVisible();
  await expect(page.locator('.inbox-msg-card')).toHaveCount(1);
  await page.locator('.inbox-tools summary').click();
  await expect(page.getByRole('button', { name: '恢复 QQ', exact: true })).toBeVisible();
  await page.locator('.inbox-tools summary').click();
});
test('desktop, dark and mobile layouts fit the inbox', async () => {
  await fs.mkdir('test-results/inbox-redesign', { recursive: true });
  for (const view of [{ width: 1440, height: 1050, theme: 'light' }, { width: 1440, height: 1050, theme: 'dark' }, { width: 390, height: 844, theme: 'light' }]) {
    await page.setViewportSize({ width: view.width, height: view.height });
    await page.evaluate(theme => window.applyTheme(theme), view.theme);
    await expect(page.locator('.inbox-workspace-head')).toBeVisible();

    const overflow = await page.locator('#inboxApp').evaluate(el => {
      const bounds = el.getBoundingClientRect();
      return [...el.querySelectorAll('*')].filter(child => child.getBoundingClientRect().width > 0 && child.getBoundingClientRect().right > bounds.right + 2).map(child => child.className);
    });
    expect(overflow).toEqual([]);
    if (view.width < 650) {
      await page.locator('.inbox-msg-card').scrollIntoViewIfNeeded();
      expect(await page.locator('#inboxApp').evaluate(el => el.scrollHeight <= el.clientHeight || el.scrollTop > 0)).toBe(true);
      await page.locator('.inbox-workspace-head').scrollIntoViewIfNeeded();
    }
    await page.locator('#inboxApp').screenshot({ path: `test-results/inbox-redesign/${view.width}-${view.theme}.png` });
  }
});
