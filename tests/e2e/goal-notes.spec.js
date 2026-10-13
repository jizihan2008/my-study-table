'use strict';
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('goal notes save, cancel, preserve drafts, sync and reach AI reports', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-goal-notes-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof editTodayGoalNote === 'function' && document.readyState !== 'loading');
    await page.evaluate(() => {
      saveGoals([{ id: 901, text: '完成毕业设计', content: '每周推进核心模块', dueDate: '2026-12-31', done: false },
        { id: 902, text: '第二个目标', content: '', done: false }]);
      window.goalSyncKeys = [];
      const onLocalChange = window.Sync.onLocalChange;
      window.Sync.onLocalChange = function(key) { window.goalSyncKeys.push(key); return onLocalChange.call(this, key); };
      switchTab('today');
      renderGoals();
    });
    const goal = page.locator('[data-sync-id="goal-901"]');
    const input = page.locator('#todayGoalNoteInput-901');
    const note = '先写实验设计 <提醒> "坚持"';
    await goal.getByRole('button', { name: '添加备注', exact: true }).click();
    await input.fill(note);
    const preserved = await page.evaluate(() => {
      const input = document.getElementById('todayGoalNoteInput-901');
      input.setSelectionRange(2, 4);
      renderGoals(); renderToday();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
      return { same: document.getElementById(input.id) === input, start: input.selectionStart, end: input.selectionEnd, saved: loadGoals()[0].note };
    });
    expect(preserved).toEqual({ same: true, start: 2, end: 4, saved: undefined });
    await input.press('Enter');
    await expect(goal.locator('.today-goal-note-row')).toHaveText(note);
    const snapshots = await page.evaluate(() => ({
      goal: loadGoals()[0], keys: window.goalSyncKeys,
      chat: buildToolsSystemPrompt(null, {}),
      morning: collectDailyReportData().longTermGoals,
      evening: collectEveningReportData().longTermGoals,
      legacy: formatReportLongTermGoals(collectReportLongTermGoals()),
      json: reportPromptData('morning', collectDailyReportData()),
      preview: friendlyPromptDataHtml('', 'morning', { previewData: collectDailyReportData() })
    }));
    expect(snapshots.goal).toMatchObject({ note, content: '每周推进核心模块', dueDate: '2026-12-31' });
    expect(snapshots.keys).toContain('study_longterm_goals');
    expect(snapshots.morning[0].note).toBe(note);
    expect(snapshots.evening[0].note).toBe(note);
    for (const text of [snapshots.chat, snapshots.legacy, snapshots.json]) expect(text).toContain('先写实验设计');
    expect(snapshots.preview).toContain('备注');
    await goal.locator('.today-goal-note-row').click();
    await input.fill('取消的草稿');
    await input.press('Escape');
    await expect(goal.locator('.today-goal-note-row')).toHaveText(note);
    await goal.locator('.today-goal-note-row').click();
    await input.fill('失焦保存');
    await page.locator('.today-goals-header .today-section-title').click();
    await expect(goal.locator('.today-goal-note-row')).toHaveText('失焦保存');
    await page.reload();
    await page.waitForFunction(() => typeof renderGoals === 'function');
    await page.evaluate(() => { switchTab('today'); renderGoals(); });
    await expect(goal.locator('.today-goal-note-row')).toHaveText('失焦保存');
    await goal.locator('.todo-edit').click();
    await expect(page.locator('#editGoalNote')).toHaveValue('失焦保存');
    await page.locator('#editGoalNote').fill('弹窗备注');
    await page.locator('#editModal .btn-save-modal').click();
    await expect(goal.locator('.today-goal-note-row')).toHaveText('弹窗备注');
    await goal.locator('.today-goal-note-row').click();
    await input.fill('保存失败的草稿');
    await page.evaluate(() => { window.originalGoalSaveData = saveData; saveData = () => false; });
    await input.press('Enter');
    await expect(input).toHaveValue('保存失败的草稿');
    expect(await page.evaluate(() => loadGoals()[0].note)).toBe('弹窗备注');
    await page.evaluate(() => { saveData = window.originalGoalSaveData; });
    await input.focus();
    await input.press('Escape');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => applyTheme(theme), theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.locator('.today-goals-card').scrollIntoViewIfNeeded();
        expect(await goal.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        await page.locator('.today-goals-card').screenshot({ path: `test-results/goal-notes-${theme}-${width}.png` });
        await goal.locator('.today-goal-note-row').click();
        await expect(input).toBeFocused();
        expect(await input.evaluate(el => el.getBoundingClientRect().right <= el.closest('.today-goal-item').getBoundingClientRect().right)).toBe(true);
        await page.locator('.today-goals-card').screenshot({ path: `test-results/goal-notes-editing-${theme}-${width}.png` });
        await input.press('Escape');
      }
    }
    await goal.locator('.today-goal-note-row').click();
    await input.fill('');
    await input.press('Enter');
    await expect(goal.locator('.today-goal-note-row')).toHaveCount(0);
    expect(await page.evaluate(() => loadGoals()[0].note)).toBe('');
    expect(await page.evaluate(() => loadGoals()[0].content)).toBe('每周推进核心模块');
  } finally {
    if (app) await app.close();
    await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
