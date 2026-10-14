'use strict';
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('today and timer history order records and sessions by start ascending, end descending', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-timer-order-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof renderTodayTimerRecords === 'function' && document.readyState !== 'loading');
    const saved = await page.evaluate(() => {
      const date = getTodayStr();
      const time = hour => new Date(date + 'T00:00:00').getTime() + hour * 3600000;
      const record = (id, name, ranges) => ({ id, name, date, totalMs: 3600000,
        sessions: ranges.map(([start, end]) => ({ start: time(start), end: time(end) })) });
      const records = [
        record(1, '晚间', [[18, 19]]),
        record(2, '同起短时段', [[9, 10]]),
        record(3, '无时段旧记录', []),
        record(4, '多时段', [[12, 13], [8, 8.5], [8, 9]]),
        record(5, '同起长时段', [[9, 11]])
      ];
      saveTimerRecords(records);
      switchTab('today');
      return localStorage.getItem('study_timer_records');
    });
    const labels = ['⏱ 多时段', '⏱ 同起长时段', '⏱ 同起短时段', '⏱ 晚间', '⏱ 无时段旧记录'];
    const sessions = ['08:00 — 09:00 (1:00:00)', '08:00 — 08:30 (30:00)', '12:00 — 13:00 (1:00:00)',
      '09:00 — 11:00 (2:00:00)', '09:00 — 10:00 (1:00:00)', '18:00 — 19:00 (1:00:00)'];
    const today = page.locator('#todayTimerRecords');
    await expect(today.locator('.timer-history-label')).toHaveText(labels);
    await expect(today.locator('.timer-history-session')).toHaveText(sessions);
    await page.locator('#todayTimerExpand').click();
    await expect(today.locator('.timer-history-label')).toHaveText(labels);
    await page.locator('#todayTimerTypeFilter').selectOption('focus');
    await expect(today.locator('.timer-history-label')).toHaveText(labels);
    await page.evaluate(() => switchTab('timer'));
    const history = page.locator('#timerHistory');
    await expect(history.locator('.timer-history-label')).toHaveText(labels);
    await expect(history.locator('.timer-history-session')).toHaveText(sessions);
    expect(await page.evaluate(() => localStorage.getItem('study_timer_records'))).toBe(saved);
  } finally {
    if (app) await app.close();
    await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
