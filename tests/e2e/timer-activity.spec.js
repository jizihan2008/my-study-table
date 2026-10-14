'use strict';
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('rest and other records persist, can be edited, and do not advance focus statistics', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-timer-activity-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.locator('#todayTimerManual').waitFor({ state: 'visible' });
    await page.evaluate(() => {
      saveTimerRecords([]);
      switchTab('timer');
    });
    await page.getByRole('combobox', { name: '时段类型', exact: true }).selectOption('rest');
    await page.locator('#timerSessionName').fill('午休');
    await page.locator('#timerContainer .timer-btn-start').click();
    await expect(page.locator('#tfTitle')).toHaveText('休息计时');
    // 快进时段以验证保存，无需实际等一分钟。
    await page.evaluate(() => { timerSessionStart -= 60000; saveTimerState(); });
    await page.reload();
    await page.locator('#todayTimerManual').waitFor({ state: 'visible' });
    await page.evaluate(() => switchTab('timer'));
    await expect(page.locator('#tfTitle')).toHaveText('休息计时');
    expect(await page.evaluate(() => timerRunning)).toBe(true);
    await page.locator('#timerContainer .timer-btn-stop').click();
    await expect(page.locator('#timerContainer .timer-history-item')).toContainText('午休');
    await expect(page.locator('#timerContainer .timer-no-focus-badge')).toHaveText('休息');
    let records = await page.evaluate(() => loadTimerRecords());
    expect(records).toHaveLength(1);
    expect(records[0].activityType).toBe('rest');
    expect(records[0].affectsFocus).toBe(false);

    await page.locator('#timerContainer .timer-btn-manual').click();
    await page.locator('#manualRecActivityType').selectOption('other');
    await page.locator('#manualRecName').fill('通勤');
    await page.locator('.manual-rec-session-date').fill('2026-10-12');
    await page.locator('.manual-rec-session-start').fill('08:00');
    await page.locator('.manual-rec-session-end').fill('08:30');
    await page.getByRole('button', { name: '添加记录', exact: false }).click();
    records = await page.evaluate(() => loadTimerRecords());
    const commute = records.find(r => r.name === '通勤');
    expect(commute.activityType).toBe('other');
    expect(commute.affectsFocus).toBe(false);
    expect(commute.totalMs).toBe(30 * 60000);
    await page.evaluate(id => editTimerRecord(id), commute.id);
    await expect(page.locator('#manualRecActivityType')).toHaveValue('other');
    await page.locator('#manualRecActivityType').selectOption('rest');
    await page.getByRole('button', { name: '保存修改', exact: false }).click();
    expect(await page.evaluate(id => loadTimerRecords().find(r => r.id === id).activityType, commute.id)).toBe('rest');

    const stats = await page.evaluate(() => {
      const today = formatDate(new Date());
      saveTimerRecords([...loadTimerRecords(), {
        id: genTimerRecordId(), date: today, name: '学习', todoId: 123,
        totalMs: 10 * 60000, sessions: [], affectsFocus: true
      }]);
      todos.push({ id: 124, text: '休息测试', parentId: null });
      saveTimerRecords([...loadTimerRecords(), { id: genTimerRecordId(), date: today,
        totalMs: 20 * 60000, sessions: [], activityType: 'rest', affectsFocus: false, todoId: 124 }]);
      const records = loadTimerRecords();
      return {
        focusMinutes: collectTimerStats(1).dailyMinutes[today],
        focusSessions: collectOverallStats().totalSessions,
        totalMinutes: collectOverallStats().totalMin,
        recordedMs: getTodayTimerTotalMs(records, today),
        restCondition: tlCheckCondition({ type: 'timer', targetId: 124, minutes: 1 }),
        restProgress: tlTimerProgress({ targetId: 124, minutes: 1 }).curMs,
        focusCondition: tlCheckCondition({ type: 'timer', targetId: 123, minutes: 10 }),
        aiRestTime: getTodoTimerStr(124)
      };
    });
    expect(stats.focusMinutes).toBe(10);
    expect(stats.focusSessions).toBe(1);
    expect(stats.totalMinutes).toBe(10);
    expect(stats.recordedMs).toBeGreaterThan(10 * 60000);
    expect(stats.restCondition).toBe(false);
    expect(stats.restProgress).toBe(0);
    expect(stats.focusCondition).toBe(true);
    expect(stats.aiRestTime).toBe('');

    await page.getByRole('combobox', { name: '时段类型', exact: true }).selectOption('other');
    await page.reload();
    await page.locator('#todayTimerManual').waitFor({ state: 'visible' });
    await page.evaluate(() => switchTab('timer'));
    await expect(page.getByRole('combobox', { name: '时段类型', exact: true })).toHaveValue('other');
    expect(await page.evaluate(() => loadTimerRecords().find(r => r.name === '午休').activityType)).toBe('rest');
    await page.screenshot({ path: path.join(__dirname, '../../test-results/timer-activity-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator('#timerContainer .timer-history-label').filter({ hasText: '通勤' }).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: path.join(__dirname, '../../test-results/timer-activity-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.locator('#timerContainer .timer-no-focus-badge').evaluateAll(badges => badges.every(badge => {
      const parent = badge.parentElement.getBoundingClientRect();
      const rect = badge.getBoundingClientRect();
      return rect.right <= parent.right + 1;
    }))).toBe(true);
  } finally {
    if (app) await app.close();
    await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
