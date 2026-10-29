'use strict';
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('timer sync setting persists and cloud data updates timer, float and Today without navigation', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-timer-sync-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.locator('#section-today').waitFor({ state: 'visible' });
    await page.evaluate(() => { Sync.setAutoSync(false); openSettingsModal(); switchSettingsTab('sync'); });
    const toggle = page.locator('#syncTimerStateEnabled');
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(toggle).toBeChecked();
    await page.reload();
    await page.locator('#section-today').waitFor({ state: 'visible' });
    await page.evaluate(() => { openSettingsModal(); switchSettingsTab('sync'); });
    await expect(toggle).toBeChecked();
    await page.evaluate(() => { closeSettingsModal(); switchTab('timer'); });
    const result = await page.evaluate(async () => {
      const today = formatDate(new Date());
      const record = { id: 987654321, date: today, name: '同步测试记录', totalMs: 60000,
        sessions: [], activityType: 'focus', affectsFocus: true };
      let row = { key: 'study_timer_records', value: [record], updated_at: new Date().toISOString() };
      // Exercise the real remote apply and redraw path with a local test cloud.
      const client = { auth: { getSession: () => ({ data: { session: { user: { id: 'timer-sync-test' } } } }) },
        from: () => ({ select() { return this; }, eq() { return this; },
          maybeSingle: async () => ({ data: row, error: null }) }) };
      getSupabaseClient = () => client;
      const apply = async () => {
        localStorage.setItem('study_sync_pending_conflicts_v1', JSON.stringify({ [row.key]: { key: row.key } }));
        const result = await Sync.resolveConflict(row.key, 'remote');
        if (!result.ok) throw new Error(result.reason);
      };
      await apply();
      const refreshed = {
        timer: document.getElementById('timerContainer').textContent.includes('同步测试记录'),
        today: document.getElementById('todayTimerRecords').textContent.includes('同步测试记录'),
        total: document.getElementById('todayTimerFocusTotal').textContent
      };
      row = { key: 'study_timer_live_state', value: { running: true, elapsed: 0,
        sessionStart: Date.now() - 10000, sessions: [], name: '远端正在计时', activityType: 'focus' },
        updated_at: new Date().toISOString() };
      await apply();
      refreshed.started = timerRunning && document.querySelector('#timerContainer .timer-btn-stop') !== null;
      refreshed.float = document.getElementById('timerFloat').textContent.includes('远端正在计时');
      row = { ...row, value: { ...row.value, running: false, elapsed: 0, name: '' } };
      await apply();
      refreshed.stopped = !timerRunning && document.querySelector('#timerContainer .timer-btn-start') !== null;
      refreshed.records = loadTimerRecords().length;
      return refreshed;
    });
    expect(result).toEqual({ timer: true, today: true, total: '1:00', started: true, float: true, stopped: true, records: 1 });
  } finally {
    if (app) await app.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
});
