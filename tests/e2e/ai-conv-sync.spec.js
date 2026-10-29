'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('tab title context menu toggles only its conversation and survives reload', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-conv-sync-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.waitForSelector('#section-today.active');
    const ids = await page.evaluate(() => {
      createNewConv();
      const first = activeConvId;
      getActiveConv().title = '同步测试甲';
      createNewConv();
      const second = activeConvId;
      getActiveConv().title = '同步测试乙';
      safeSaveAiConvs();
      switchTab('ai');
      renderAiChat();
      SyncLogs.setItemEnabled('ai_conv', first, false);
      return { first, second };
    });
    const title = page.locator(`[data-conv-id="${ids.first}"] .ai-conv-tab-name`);
    const menu = page.locator('#aiConvTabContextMenu');
    await title.click({ button: 'right' });
    await expect(menu.getByRole('menuitem')).toHaveText('开启本对话同步');
    await menu.getByRole('menuitem').click();
    expect(await page.evaluate(() => activeConvId)).toBe(ids.second);
    expect(await page.evaluate(id => SyncLogs.isItemEnabled('ai_conv', id), ids.first)).toBe(true);
    await title.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: '关闭本对话同步' }).click();
    expect(await page.evaluate(id => SyncLogs.isItemEnabled('ai_conv', id), ids.first)).toBe(false);
    expect(await page.evaluate(id => SyncLogs.isItemEnabled('ai_conv', id), ids.second)).toBe(true);
    await page.evaluate(async () => { if (window.StudyData) await StudyData.flush(); });
    await page.reload();
    await page.waitForSelector('#section-today');
    await page.evaluate(() => switchTab('ai'));
    await title.click({ button: 'right' });
    await expect(menu.getByRole('menuitem')).toHaveText('开启本对话同步');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await page.locator('#aiMessages').click({ button: 'right', position: { x: 10, y: 10 } });
    await expect(menu).toHaveCount(0);
  } finally {
    if (app) await app.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
});
