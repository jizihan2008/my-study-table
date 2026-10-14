'use strict';
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('today manual record shares timer form and updates records and reports', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-today-manual-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof renderTodayTimerRecords === 'function' && document.readyState !== 'loading');
    await page.evaluate(() => { saveTimerRecords([]); switchTab('today'); });
    const button = page.locator('#todayTimerManual');
    const form = page.locator('#todayTimerManualForm');
    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#section-today')).toHaveClass(/active/);
    await expect(page.locator('#manualRecName')).toHaveCount(1);
    await page.locator('#manualRecName').fill('手动补记测试');
    const today = await page.evaluate(() => getTodayStr());
    const rows = form.locator('.timer-manual-session-row');
    await rows.first().locator('.manual-rec-session-date').fill(today);
    await rows.first().locator('.manual-rec-session-start').fill('09:00');
    await rows.first().locator('.manual-rec-session-end').fill('09:25');
    await form.getByRole('button', { name: '＋ 添加时段' }).click();
    await rows.nth(1).locator('.manual-rec-session-start').fill('10:00');
    await rows.nth(1).locator('.manual-rec-session-end').fill('10:15');
    await page.locator('#manualRecActivityType').selectOption('rest');
    // Today redraws and timer redraws must preserve the open Today draft.
    await page.evaluate(() => { renderToday(); renderTimer(); });
    await expect(page.locator('#manualRecName')).toHaveValue('手动补记测试');
    await expect(rows).toHaveCount(2);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => applyTheme(theme), theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await form.scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await form.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        for (const input of await form.locator('input[type="time"]').all()) {
          expect((await input.boundingBox()).width).toBeGreaterThan(90);
        }
        await page.locator('.today-timer-card').screenshot({ path: `test-results/today-manual-${theme}-${width}.png` });
      }
    }
    await form.getByRole('button', { name: '添加记录', exact: false }).click();
    await expect(form.locator('.timer-manual-form')).toHaveCount(0);
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#todayTimerRecords')).toContainText('手动补记测试');
    const saved = await page.evaluate(() => ({ records: loadTimerRecords(), report: collectEveningReportData() }));
    expect(saved.records).toHaveLength(1);
    expect(saved.records[0]).toMatchObject({ manual: true, name: '手动补记测试', activityType: 'rest', affectsFocus: false, totalMs: 2400000 });
    expect(saved.records[0].sessions).toHaveLength(2);
    expect(saved.report.todayTimerTypeTotals.find(item => item.activityType === 'rest').totalMs).toBe(2400000);
    // Cancel must discard the draft without adding a second record.
    await button.click();
    await page.locator('#manualRecName').fill('取消的草稿');
    await form.getByRole('button', { name: '取消', exact: true }).click();
    await expect(form.locator('.timer-manual-form')).toHaveCount(0);
    expect(await page.evaluate(() => loadTimerRecords().length)).toBe(1);
    // Switching form entry points must never leave duplicate IDs in hidden tabs.
    await button.click();
    await page.evaluate(() => switchTab('timer'));
    await page.locator('#section-timer .timer-btn-manual').click();
    await expect(page.locator('#manualRecName')).toHaveCount(1);
    await expect(form.locator('.timer-manual-form')).toHaveCount(0);
    await page.locator('#section-timer .timer-btn-manual').click();
    await page.evaluate(() => switchTab('today'));
    await button.click();
    await expect(page.locator('#manualRecName')).toHaveCount(1);
    await button.click();
  } finally {
    if (app) await app.close();
    await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
