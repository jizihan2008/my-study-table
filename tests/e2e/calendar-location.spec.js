'use strict';
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('calendar location persists, appears on Today, and can be edited or cleared', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-calendar-location-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.locator('#section-today').waitFor({ state: 'visible' });
    await page.evaluate(() => {
      switchTab('calendar');
      openCalEventModal(formatDate(new Date()), null);
    });
    await page.locator('#calEventTitle').fill('地点测试');
    await page.locator('#calEventStartTime').fill('10:00');
    await page.locator('#calEventRepeat').selectOption('weekly');
    await page.locator('#calEventLocation').fill('  图书馆 <A区> & 301  ');
    await page.locator('#calEventLocation').press('Enter');
    await expect(page.locator('#calEventModal')).not.toHaveClass(/open/);
    await page.evaluate(async () => { if (window.StudyData) await StudyData.flush(); });
    await page.reload();
    await page.locator('#section-today').waitFor({ state: 'visible' });
    await page.evaluate(() => { switchTab('today'); renderTodaySchedule(); });
    const event = page.locator('.today-schedule-event').filter({ hasText: '地点测试' }).first();
    await expect(event.locator('.today-schedule-location')).toHaveText('地点：图书馆 <A区> & 301');
    await event.click();
    await expect(page.locator('#calEventLocation')).toHaveValue('图书馆 <A区> & 301');
    const longLocation = '教学楼三层东侧研讨教室'.repeat(12);
    await page.locator('#calEventLocation').fill(longLocation);
    await page.locator('#calEventLocation').press('Enter');
    await page.evaluate(() => switchTab('today'));
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(event.locator('.today-schedule-location')).toHaveText('地点：' + longLocation);
    expect(await page.locator('#todayScheduleCard').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await event.click();
    await page.locator('#calEventLocation').fill('');
    await page.locator('#calEventLocation').press('Enter');
    await page.evaluate(() => switchTab('today'));
    await expect(event.locator('.today-schedule-location')).toHaveCount(0);
    expect(await page.evaluate(() => loadCalendarEvents().find(ev => ev.title === '地点测试').location)).toBe('');
    await page.evaluate(() => {
      switchTab('calendar');
      openCalEventModal(formatDate(new Date()), null);
    });
    await expect(page.locator('#calEventLocation')).toHaveValue('');
  } finally {
    if (app) await app.close();
    await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
