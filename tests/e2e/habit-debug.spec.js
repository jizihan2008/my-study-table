'use strict';
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let app, page, userDataPath, dates;

test.beforeAll(async () => {
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-habit-debug-'));
  app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
  page = await app.firstWindow();
  await page.waitForFunction(() => document.querySelector('#section-today.active') && typeof openEditHabitModal === 'function');
});
test.afterAll(async () => {
  if (app) await app.close();
  if (userDataPath) await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
test.beforeEach(async () => {
  dates = await page.evaluate(async () => {
    closeEditModal();
    localStorage.setItem('study_debug_mode', 'true');
    const today = getTodayDateStr(), yesterday = getYesterdayDateStr();
    await saveDataDurable('study_habits_v2', [{ id: 123, name: '阅读', emoji: '📖', color: '#4f6ef7',
      createdAt: new Date().toISOString(), dailyTarget: 2, weeklyTarget: 7, checkins: { [yesterday]: 2 }, notes: '' }]);
    switchTab('habits');
    renderHabits();
    return { today, yesterday };
  });
});

test('debug edits multiple dates, recalculates statistics, and persists after reload', async () => {
  await page.locator('.habit-card-title').click();
  await expect(page.getByLabel('打卡日期（调试模式）')).toHaveValue(dates.today);
  await page.getByLabel('当天打卡次数').fill('3');
  await page.getByLabel('打卡日期（调试模式）').fill(dates.yesterday);
  await expect(page.getByLabel('当天打卡次数')).toHaveValue('2');
  await page.getByLabel('当天打卡次数').fill('4');
  await page.getByLabel('打卡日期（调试模式）').fill(dates.today);
  await expect(page.getByLabel('当天打卡次数')).toHaveValue('3');
  // Draft changes must not leak into reports or storage before saving.
  expect(await page.evaluate(() => getDayCount(loadHabits()[0], getTodayDateStr()))).toBe(0);
  await page.locator('#editHabitSave').click();
  await expect(page.locator('#editModal')).not.toHaveClass(/open/);
  await expect(page.locator('.habit-daily-progress-text')).toHaveText('今日 3/2 次');
  const status = await page.evaluate(() => ({ streak: calcStreak(loadHabits()[0]), week: calcWeekProgress(loadHabits()[0]) }));
  expect(status.streak).toMatchObject({ streak: 2, bestStreak: 2, todayCount: 3 });
  expect(status.week.totalCount).toBeGreaterThanOrEqual(3);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#section-today.active'));
  const stored = await page.evaluate(() => loadHabits()[0].checkins);
  expect(stored).toEqual({ [dates.today]: 3, [dates.yesterday]: 4 });
});

test('zero removes a date; invalid counts and cancellation preserve the original data', async () => {
  await page.locator('.habit-card-title').click();
  for (const invalid of ['-1', '1.5', '']) {
    await page.getByLabel('当天打卡次数').fill(invalid);
    await page.locator('#editHabitSave').click();
    await expect(page.locator('#editModal')).toHaveClass(/open/);
    expect(await page.evaluate(() => getDayCount(loadHabits()[0], getTodayDateStr()))).toBe(0);
  }
  await page.getByLabel('当天打卡次数').fill('7');
  await page.evaluate(() => closeEditModal());
  await page.locator('.habit-card-title').click();
  await expect(page.getByLabel('当天打卡次数')).toHaveValue('0');
  await page.getByLabel('打卡日期（调试模式）').fill(dates.yesterday);
  await page.getByLabel('当天打卡次数').fill('0');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#editHabitSave').scrollIntoViewIfNeeded();
  expect(await page.locator('#editModalBody').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.locator('#editModal').screenshot({ path: test.info().outputPath('habit-debug-mobile.png') });
  await page.locator('#editHabitSave').click();
  await expect(page.locator('#editModal')).not.toHaveClass(/open/);
  expect(await page.evaluate(() => loadHabits()[0].checkins)).toEqual({});
  await page.setViewportSize({ width: 1186, height: 800 });
});

test('debug fields follow the global switch and failed saves retain the draft', async () => {
  await page.evaluate(() => localStorage.setItem('study_debug_mode', 'false'));
  await page.locator('.habit-card-title').click();
  await expect(page.locator('#editHabitDebugDate')).toHaveCount(0);
  await page.locator('#editHabitName').fill('正常编辑');
  await page.locator('#editHabitSave').click();
  await expect(page.locator('.habit-card-name')).toHaveText('正常编辑');
  expect(await page.evaluate(() => getDayCount(loadHabits()[0], getYesterdayDateStr()))).toBe(2);
  await page.evaluate(() => localStorage.setItem('study_debug_mode', 'true'));
  await page.locator('.habit-card-title').click();
  await page.getByLabel('当天打卡次数').fill('6');
  await page.evaluate(() => { window.originalHabitDurableSave = saveDataDurable; saveDataDurable = async () => false; });
  try {
    await page.locator('#editHabitSave').click();
    await expect(page.locator('#editHabitSaveError')).toHaveText('保存失败，请重试。');
    await expect(page.getByLabel('当天打卡次数')).toHaveValue('6');
    expect(await page.evaluate(() => getDayCount(habits[0], getTodayDateStr()))).toBe(0);
  } finally {
    await page.evaluate(() => { saveDataDurable = window.originalHabitDurableSave; delete window.originalHabitDurableSave; });
  }
  await page.locator('#editHabitSave').click();
  await expect(page.locator('.habit-daily-progress-text')).toHaveText('今日 6/2 次');
});
