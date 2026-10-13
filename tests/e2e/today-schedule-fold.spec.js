'use strict';
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('collapsed schedule shows only today and preserves state through rendering', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-schedule-fold-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof toggleTodayScheduleCollapsed === 'function' && document.readyState !== 'loading');
    await page.evaluate(() => {
      const events = Array.from({ length: 6 }, (_, offset) => {
        const date = new Date(); date.setDate(date.getDate() + offset);
        return { id: offset + 1, date: formatDate(date), title: `第${offset}天安排`, time: '10:00', color: 'blue' };
      });
      saveCalendarEvents(events);
      switchTab('today');
      renderTodaySchedule();
    });
    const list = page.locator('#todayScheduleList');
    const toggle = page.locator('#todayScheduleToggle');
    await expect(list.locator('.today-schedule-day')).toHaveCount(5);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(list.locator('.today-schedule-day')).toHaveCount(1);
    await expect(list).toContainText('第0天安排');
    await expect(list).not.toContainText('第1天安排');
    await page.evaluate(() => renderToday());
    await expect(toggle).toHaveText('展开');
    await expect(list.locator('.today-schedule-day')).toHaveCount(1);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => applyTheme(theme), theme);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#todayScheduleCard').scrollIntoViewIfNeeded();
      expect(await page.locator('#todayScheduleCard').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.locator('#todayScheduleCard').screenshot({ path: `test-results/today-schedule-fold-${theme}.png` });
    }
    await page.evaluate(() => {
      saveCalendarEvents(loadCalendarEvents().filter(ev => ev.date !== getTodayStr()));
      renderTodaySchedule();
    });
    await expect(list).toContainText('今天还没有日程');
    await toggle.click();
    await expect(list.locator('.today-schedule-day')).toHaveCount(4);
    await expect(list).toContainText('第1天安排');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.evaluate(() => { saveCalendarEvents([]); renderTodaySchedule(); });
    await expect(list).toContainText('未来 5 天还没有日程');
  } finally {
    if (app) await app.close();
    await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
