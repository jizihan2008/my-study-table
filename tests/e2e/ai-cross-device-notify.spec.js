'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('notification preference persists and successful AI generation survives storage compaction', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-completion-e2e-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.waitForSelector('#section-today.active');
    await page.evaluate(() => { openSettingsModal(); switchSettingsTab('automation'); });
    const toggle = page.locator('#aiCrossDeviceNotify');
    await expect(toggle).toBeChecked();
    await page.locator('label.toggle-switch:has(#aiCrossDeviceNotify) .toggle-slider').click();
    await page.evaluate(() => { closeSettingsModal(); openSettingsModal(); switchSettingsTab('automation'); });
    await expect(toggle).not.toBeChecked();
    await page.locator('label.toggle-switch:has(#aiCrossDeviceNotify) .toggle-slider').click();
    await page.evaluate(() => closeSettingsModal());

    await page.route('https://completion-test.invalid/v1/chat/completions', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: '学习任务已完成。' }, finish_reason: 'stop' }] })
    }));
    const result = await page.evaluate(async () => {
      switchTab('ai'); createNewConv();
      const conv = getActiveConv();
      const node = appendMessage(conv, { role: 'user', content: '整理任务' });
      await regenerateFromUserNode(conv, node, { apiKey: 'fake', name: '测试模型', model: 'test', baseUrl: 'https://completion-test.invalid/v1' });
      if (window.StudyData) await StudyData.flush();
      const stored = JSON.parse(localStorage.getItem('study_ai_convs')).find(c => c.id === conv.id);
      const notifications = [];
      const originalNotify = window.sendNotification;
      window.sendNotification = (...args) => notifications.push(args);
      try {
        const remote = { ...conv.aiCompletions[0], id: 'remote-task', deviceId: 'another-device' };
        receiveAiTaskCompletions(conv, [remote]);
        receiveAiTaskCompletions(conv, [remote]);
        return { storedEvents: stored.aiCompletions.length, preview: stored.aiCompletions[0].preview,
          notifications: notifications.length, target: notifications[0][3].convId, id: conv.id };
      } finally { window.sendNotification = originalNotify; }
    });
    expect(result.storedEvents).toBe(1);
    expect(result.preview).toBe('学习任务已完成。');
    expect(result.notifications).toBe(1);
    expect(result.target).toBe(result.id);
    await expect(page.locator('body')).toContainText('其它设备的 AI 任务已完成');
    const incompleteCounts = await page.evaluate(async () => {
      const originalLoop = window.runToolCallLoop;
      const counts = [];
      try {
        for (const failure of [{ stopped: true }, { streamError: 'network interrupted' },
          { incompleteReason: 'tool chain incomplete' }, { finishReason: 'content_filter' }]) {
          createNewConv();
          const conv = getActiveConv();
          const node = appendMessage(conv, { role: 'user', content: '未完成的任务' });
          window.runToolCallLoop = async () => ({ finalCleanText: '部分内容', finishReason: 'stop', ...failure });
          await regenerateFromUserNode(conv, node, { apiKey: 'fake', name: '测试模型', model: 'test' });
          counts.push((conv.aiCompletions || []).length);
        }
      } finally { window.runToolCallLoop = originalLoop; }
      return counts;
    });
    expect(incompleteCounts).toEqual([0, 0, 0, 0]);
  } finally {
    if (app) await app.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
});
