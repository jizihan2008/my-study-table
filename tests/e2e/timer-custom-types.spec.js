'use strict';
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('custom types cover timer, manual records, calendar auto recording, reports and persistence', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-custom-types-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof openTimerTypeManager === 'function' && document.readyState !== 'loading');
    await page.evaluate(() => { saveTimerRecords([]); saveCalendarEvents([]); switchTab('timer'); });
    await page.locator('#timerContainer').getByRole('button', { name: '管理类型', exact: true }).click();
    await page.locator('#newTimerTypeName').fill('阅读 <学习>');
    await page.locator('#newTimerTypeFocus').check();
    await page.getByRole('button', { name: '创建类型', exact: true }).click();
    await expect(page.locator('#timerTypeManagerStatus')).toHaveText('类型已创建');
    await page.locator('#newTimerTypeName').fill('通勤');
    await page.getByRole('button', { name: '创建类型', exact: true }).click();
    const types = await page.evaluate(() => loadTimerActivityTypes());
    const reading = types.find(t => t.label === '阅读 <学习>'), commute = types.find(t => t.label === '通勤');
    expect(reading.affectsFocus).toBe(true);
    expect(commute.affectsFocus).toBe(false);
    await page.getByRole('button', { name: '关闭计时类型管理' }).click();
    await page.locator('#timerActivityType').selectOption(reading.id);
    await page.locator('#timerSessionName').fill('阅读计时');
    await page.locator('#timerContainer .timer-btn-start').click();
    await expect(page.locator('#tfTitle')).toHaveText('阅读 <学习>计时');
    expect(await page.locator('#tfTitle').locator('*').count()).toBe(0);
    await page.evaluate(() => { timerSessionStart -= 60000; saveTimerState(); });
    await page.reload();
    await page.waitForFunction(() => typeof setTimerActivityType === 'function');
    await page.evaluate(() => switchTab('timer'));
    await expect(page.locator('#timerActivityType')).toHaveValue(reading.id);
    await page.locator('#timerContainer .timer-btn-stop').click();
    const timed = await page.evaluate(() => loadTimerRecords().find(r => r.name === '阅读计时'));
    expect(timed.activityType).toBe(reading.id);
    expect(timed.affectsFocus).toBe(true);
    await page.locator('#timerContainer .timer-btn-manual').click();
    await page.locator('#manualRecActivityType').selectOption(commute.id);
    await page.locator('#manualRecName').fill('通勤补记');
    const today = await page.evaluate(() => getTodayStr());
    await page.locator('.manual-rec-session-date').fill(today);
    await page.locator('.manual-rec-session-start').fill('08:00');
    await page.locator('.manual-rec-session-end').fill('08:30');
    await page.getByRole('button', { name: '添加记录', exact: false }).click();
    await page.evaluate(() => { switchTab('calendar'); openCalEventModal(getTodayStr()); });
    await page.locator('#calEventTitle').fill('通勤自动录入');
    await page.locator('#calEventStartTime').fill('08:15');
    await page.locator('#calEventEndTime').fill('08:45');
    await expect(page.locator('#calEventActivityType')).toBeDisabled();
    await page.locator('#calEventAutoRecord').check();
    await page.locator('#calEventActivityType').selectOption(commute.id);
    await page.locator('.cal-event-save-btn').click();
    const event = await page.evaluate(() => loadCalendarEvents().find(e => e.title === '通勤自动录入'));
    expect(event.autoActivityType).toBe(commute.id);
    expect(event.autoTimer).toBe(false);
    const result = await page.evaluate(() => {
      runCalendarAutoRecords(new Date(getTodayStr() + 'T12:00:00').getTime());
      const report = collectEveningReportData();
      return { auto: loadTimerRecords().find(r => r.name === '通勤自动录入'),
        totals: report.todayTimerTypeTotals, sessions: report.todayTimerSessions,
        json: reportPromptData('evening', report), chat: buildToolsSystemPrompt(null, {}) };
    });
    expect(result.auto.activityType).toBe(commute.id);
    expect(result.auto.affectsFocus).toBe(false);
    expect(result.totals.find(t => t.activityType === commute.id)).toMatchObject({ activityLabel: '通勤', totalMs: 45 * 60000 });
    expect(result.sessions.find(s => s.targetName.includes('通勤自动录入')).activityLabel).toBe('通勤');
    expect(result.json).toContain('通勤'); expect(result.chat).toContain(commute.id);
    await page.evaluate(id => openCalEventModal(getTodayStr(), id), event.id);
    await expect(page.locator('#calEventActivityType')).toHaveValue(commute.id);
    await page.evaluate(() => closeCalEventModal());
    await page.evaluate(() => { switchTab('today'); renderTodayTimerRecords(); });
    await page.locator('#todayTimerTypeFilter').selectOption(commute.id);
    await expect(page.locator('#todayTimerRecords .timer-history-item')).toHaveCount(2);
    await expect(page.locator('#todayTimerRecords .timer-history-date-total')).toHaveText('共 45:00');
    await page.evaluate(() => openTimerTypeManager());
    const row = page.locator(`#timerTypeManager [data-type-id="${commute.id}"]`);
    await row.locator('.timer-type-name').fill('出行');
    await row.locator('.timer-type-focus').check();
    await row.getByRole('button', { name: '保存', exact: true }).click();
    expect(await page.evaluate(id => loadTimerRecords().filter(r => r.activityType === id).every(r => r.affectsFocus === false), commute.id)).toBe(true);
    await page.getByRole('button', { name: '关闭计时类型管理' }).click();
    const manualId = await page.evaluate(id => loadTimerRecords().find(r => r.activityType === id && r.manual).id, commute.id);
    await page.evaluate(id => { switchTab('timer'); editTimerRecord(id); }, manualId);
    await page.locator('#manualRecName').fill('出行补记');
    await page.getByRole('button', { name: '保存修改', exact: false }).click();
    expect(await page.evaluate(id => loadTimerRecords().find(r => r.id === id).affectsFocus, manualId)).toBe(false);
    await page.evaluate(() => { switchTab('today'); renderTodayTimerRecords(); openTimerTypeManager(); });
    await row.locator('.timer-type-enabled').uncheck();
    await row.getByRole('button', { name: '保存', exact: true }).click();
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => applyTheme(theme), theme);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('.timer-type-manager').screenshot({ path: `test-results/custom-types-${theme}.png` });
      expect(await page.locator('.timer-type-manager').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    await page.getByRole('button', { name: '关闭计时类型管理' }).click();
    await expect(page.locator('#todayTimerTypeFilter')).toHaveValue(commute.id);
    await expect(page.locator('#todayTimerRecords')).toContainText('出行');
    await page.reload();
    await page.waitForFunction(() => typeof loadTimerActivityTypes === 'function');
    expect(await page.evaluate(id => loadTimerActivityTypes().find(t => t.id === id).label, commute.id)).toBe('出行');
    await page.evaluate(() => { switchTab('timer'); renderTimer(); });
    expect(await page.locator(`#timerActivityType option[value="${commute.id}"]`).count()).toBe(0);
  } finally {
    if (app) await app.close();
    await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
