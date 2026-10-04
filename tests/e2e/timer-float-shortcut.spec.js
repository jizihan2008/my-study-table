'use strict';
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('timer float shortcut opens from editing without changing focus or timer state', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-timer-shortcut-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof showTimerFloat === 'function' && document.readyState !== 'loading');
    await page.evaluate(() => {
      switchTab('notes');
      const note = getActiveNote();
      note.content = '正在编辑的文字';
      note._dirtyContent = true;
      renderNotes();
      switchNoteView('rich');
      closeTimerFloat();
    });
    const editor = page.locator('#notesRichEditor');
    await editor.click();
    await page.keyboard.press('Control+End');
    const selection = await page.evaluate(() => ({ text: getActiveNote().content,
      offset: getSelection().anchorOffset, anchor: getSelection().anchorNode.textContent }));
    await page.keyboard.press('Control+Shift+T');
    await expect(page.locator('#timerFloat')).toBeVisible();
    expect(await page.evaluate(() => ({ text: getActiveNote().content,
      offset: getSelection().anchorOffset, anchor: getSelection().anchorNode.textContent }))).toEqual(selection);
    await expect(editor).toBeFocused();
    expect(await page.evaluate(() => ({ running: timerRunning, elapsed: timerElapsed })))
      .toEqual({ running: false, elapsed: 0 });

    await page.evaluate(() => { window.__originalTimerFloat = document.getElementById('timerFloat'); });
    await page.keyboard.press('Control+Shift+T');
    expect(await page.evaluate(() => document.getElementById('timerFloat') === window.__originalTimerFloat)).toBe(true);
    await expect(page.locator('#timerFloat')).toHaveCount(1);
    await page.locator('#timerFloat .tf-close').click();
    await expect(page.locator('#timerFloat')).toHaveCount(0);
    await page.keyboard.press('Control+T');
    await expect(page.locator('#timerFloat')).toHaveCount(0);
    await page.keyboard.press('Control+Alt+Shift+T');
    await expect(page.locator('#timerFloat')).toHaveCount(0);

    await page.evaluate(() => {
      timerStart();
      closeTimerFloat();
      window.__timerSessionStart = timerSessionStart;
    });
    await page.keyboard.press('Control+Shift+T');
    await expect(page.locator('#timerFloat .tf-pause')).toBeVisible();
    expect(await page.evaluate(() => timerRunning && timerSessionStart === window.__timerSessionStart)).toBe(true);
    await page.evaluate(() => { timerPause(); closeTimerFloat(); });
    const elapsed = await page.evaluate(() => timerElapsed);
    await page.keyboard.press('Control+Shift+T');
    await expect(page.locator('#timerFloat .tf-start')).toBeVisible();
    expect(await page.evaluate(() => ({ running: timerRunning, elapsed: timerElapsed })))
      .toEqual({ running: false, elapsed });

    await page.evaluate(() => { closeTimerFloat(); switchTab('timer'); });
    await page.getByRole('button', { name: '浮窗 Ctrl+Shift+T', exact: true }).click();
    await expect(page.locator('#timerFloat')).toBeVisible();
    await page.evaluate(() => timerReset());
  } finally {
    if (app) await app.close();
    await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
