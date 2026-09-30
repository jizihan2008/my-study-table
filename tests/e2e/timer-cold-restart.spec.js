'use strict';
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('reset timer cannot resurrect from the repository after a full process restart', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-timer-restart-'));
  let app;
  const launch = async () => {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof StudyData !== 'undefined');
    await page.waitForTimeout(1000);
    return page;
  };
  try {
    let page = await launch();
    await page.evaluate(async () => {
      timerStart();
      // 模拟旧版本启动时迁移进 IndexedDB 的运行中快照。
      const value = localStorage.getItem('study_timer_state');
      await new Promise((resolve, reject) => {
        const request = indexedDB.open(StudyData.DB_NAME, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('records', 'readwrite');
          tx.objectStore('records').put({ key: 'study_timer_state', value, updatedAt: new Date().toISOString(), deletedAt: null });
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      });
      timerReset();
      // 晚到的仓库初始化不能把已清零的计时快照补回缓存。
      sessionStorage.setItem('__study_data_restore_reload', '1');
      await StudyData.initialize();
    });
    expect(await page.evaluate(() => ({ running: timerRunning, elapsed: timerElapsed,
      saved: localStorage.getItem('study_timer_state') }))).toEqual({ running: false, elapsed: 0, saved: null });
    // 结束整个进程，不能使用 page.reload（beforeunload 会补写空状态，掩盖问题）。
    // 退出通知不保证执行，禁用这次补写以验证 reset 本身已经可靠持久化。
    await page.evaluate(() => { saveTimerState = () => {}; });
    await app.close();
    app = null;
    page = await launch();
    await expect.poll(() => page.evaluate(() => timerRunning)).toBe(false);
    // 给异步仓库恢复及其自动 reload 足够时间完成。
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => ({ running: timerRunning, elapsed: timerElapsed,
      float: timerFloatVisible }))).toEqual({ running: false, elapsed: 0, float: false });
    expect(await page.evaluate(() => StudyData.get('study_timer_state'))).toBeNull();
    await page.reload();
    await page.waitForFunction(() => typeof timerRunning !== 'undefined');
    expect(await page.evaluate(() => ({ running: timerRunning, elapsed: timerElapsed })))
      .toEqual({ running: false, elapsed: 0 });
  } finally {
    if (app) await app.close();
    await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

for (const paused of [false, true]) {
  test(`full restart preserves a genuinely ${paused ? 'paused' : 'running'} timer`, async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-timer-session-'));
    let app;
    const launch = async () => {
      app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
        env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
      const page = await app.firstWindow();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForFunction(() => typeof StudyData !== 'undefined');
      await page.waitForTimeout(500);
      return page;
    };
    try {
      let page = await launch();
      await page.evaluate(async paused => {
        timerStart();
        timerSessionStart = Date.now() - 10000;
        if (paused) timerPause();
        else saveTimerState();
        await StudyData.initialize();
      }, paused);
      expect(await page.evaluate(() => StudyData.get('study_timer_state'))).toBeNull();
      await app.close();
      app = null;
      page = await launch();
      expect(await page.evaluate(() => timerRunning)).toBe(!paused);
      expect(await page.evaluate(() => timerElapsed)).toBeGreaterThanOrEqual(10000);
      await page.evaluate(() => timerReset());
    } finally {
      if (app) await app.close();
      await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}
