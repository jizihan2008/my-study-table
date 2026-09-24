'use strict';

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('startup renders the selected page and defers hidden views', async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-startup-'));
  let app;
  try {
    app = await electron.launch({
      args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: profile }
    });
    const page = await app.firstWindow();
    await expect(page.locator('#section-today')).toHaveClass(/active/);
    await page.waitForFunction(() => document.getElementById('todayWelcomeDate').textContent.length > 0);
    expect(await page.evaluate(() => notes.length)).toBe(0);
    await page.evaluate(() => switchTab('notes'));
    await expect.poll(() => page.evaluate(() => notes.length)).toBe(1);

    await page.evaluate(() => {
      localStorage.setItem('study_nav_config', JSON.stringify({ order: [], hidden: [], homeTab: 'todo' }));
      saveData('study_todos_v2', [{ id: 101, text: '启动页任务', parentId: null, done: false }]);
    });
    await page.reload();
    await expect(page.locator('#section-todo')).toHaveClass(/active/);
    await expect(page.locator('#todoTree')).toContainText('启动页任务');
  } finally {
    if (app) await app.close();
    const realProfile = await fs.realpath(profile);
    const realTemp = await fs.realpath(os.tmpdir());
    if (path.dirname(realProfile) !== realTemp || !path.basename(realProfile).startsWith('mst-startup-')) {
      throw new Error('Refusing to remove an unexpected test profile path');
    }
    await fs.rm(realProfile, { recursive: true, force: true });
  }
});
