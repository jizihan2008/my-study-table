'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test.use({ channel: 'chrome', serviceWorkers: 'block' });

test('today and calendar can record the selected occurrence early without skipping or duplicating other occurrences', async ({ page }) => {
  const root = path.resolve(__dirname, '../..');
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'study-table.test') return route.abort();
    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404 });
    return route.fulfill({ path: file });
  });
  await page.clock.setFixedTime(new Date(2026, 10, 10, 8));
  await page.goto('http://study-table.test/');
  await page.waitForSelector('#section-today.active');
  await page.evaluate(() => {
    const date = getTodayStr();
    saveCalendarEvents([
      { id: 1, date, title: '日历练习', startTime: '09:00', endTime: '10:00', repeat: 'weekly',
        weekdays: [2, 3, 4], autoRecord: true, autoActivityType: 'rest' },
      { id: 2, date, title: '日历练习', startTime: '10:00', endTime: '11:00',
        autoRecord: true, autoActivityType: 'rest' },
      { id: 3, date, title: '普通事件', startTime: '09:00', endTime: '10:00' }
    ]);
    renderTodaySchedule();
  });

  const action = page.locator('#calCtxRecordEarly');
  const todayEvent = page.locator('.today-schedule-event').filter({ hasText: '09:00—10:00' }).filter({ hasText: '日历练习' }).first();
  const tomorrowEvent = page.locator('.today-schedule-day').filter({ hasText: '明天' }).locator('.today-schedule-event');
  await page.locator('.today-schedule-event').filter({ hasText: '普通事件' }).click({ button: 'right' });
  await expect(action).toBeHidden();
  await tomorrowEvent.click({ button: 'right' });
  await action.click();
  await todayEvent.click({ button: 'right' });
  await action.click();
  await expect(page.locator('#todayTimerRecords')).toContainText('日历练习');
  await expect(page.locator('#todayTimerOtherTotal')).toHaveText('1:00:00');
  await todayEvent.click({ button: 'right' });
  await expect(action).toBeHidden();
  await page.keyboard.press('Escape');

  await page.evaluate(() => {
    switchTab('calendar');
    if (calendarSelectedDate !== getTodayStr()) selectCalendarDay(getTodayStr());
  });
  await page.locator('.cal-event-item').filter({ hasText: '10:00—11:00' }).click({ button: 'right' });
  await action.click();
  await expect(page.locator('#calendarTimerRecords .timer-history-item')).toHaveCount(2);

  const record = page.locator('#calendarTimerRecords .timer-history-sessions-wrap').filter({ hasText: /10:00\s*—\s*11:00/ });
  const menu = page.locator('#timerRecordContextMenu');
  const calendarForm = page.locator('#calendarTimerManualForm');
  await record.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await record.click({ button: 'right' });
  await menu.getByText('编辑计时记录').click();
  const name = calendarForm.locator('#manualRecName');
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('日历练习');
  await name.fill('日历修改的计时');
  await calendarForm.locator('.manual-rec-session-end').fill('11:15');
  await page.evaluate(() => renderCalendar());
  await expect(name).toHaveValue('日历修改的计时');
  await calendarForm.getByRole('button', { name: /保存修改/ }).click();
  await expect(page.locator('#section-calendar')).toHaveClass(/active/);
  await expect(calendarForm.locator('.timer-manual-form')).toHaveCount(0);
  await expect(page.locator('#calendarTimerRecords')).toContainText('日历修改的计时');
  await expect(page.locator('#calendarTodoList .today-timer-totals')).toContainText('2:15:00');

  await page.evaluate(() => switchTab('today'));
  await page.locator('#todayTimerRecords .timer-history-item').filter({ hasText: '日历修改的计时' }).click({ button: 'right' });
  await menu.getByText('编辑计时记录').click();
  const todayForm = page.locator('#todayTimerManualForm');
  await expect(todayForm.locator('#manualRecName')).toHaveValue('日历修改的计时');
  await todayForm.getByRole('button', { name: '取消', exact: true }).click();

  const result = await page.evaluate(() => {
    const added = runCalendarAutoRecords(new Date(2026, 10, 12, 11).getTime());
    const records = loadTimerRecords().map(({ sourceEventId, sourceEventDate, activityType, affectsFocus, totalMs }) =>
      ({ sourceEventId, sourceEventDate, activityType, affectsFocus, totalMs }));
    return { added, records };
  });
  expect(result.added).toBe(1);
  expect(result.records).toEqual([
    { sourceEventId: 1, sourceEventDate: '2026-11-11', activityType: 'rest', affectsFocus: false, totalMs: 3600000 },
    { sourceEventId: 1, sourceEventDate: '2026-11-10', activityType: 'rest', affectsFocus: false, totalMs: 3600000 },
    { sourceEventId: 2, sourceEventDate: '2026-11-10', activityType: 'rest', affectsFocus: false, totalMs: 4500000 },
    { sourceEventId: 1, sourceEventDate: '2026-11-12', activityType: 'rest', affectsFocus: false, totalMs: 3600000 }
  ]);
});
