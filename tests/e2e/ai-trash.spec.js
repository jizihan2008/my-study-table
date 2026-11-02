'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('delete the last AI chat, reload, restore through the trash UI, then permanently delete', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-ai-trash-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.waitForSelector('#section-today.active');
    const id = await page.evaluate(() => {
      aiConvs = [{ id: 7654321, title: '回收站验证对话', systemPrompt: '保留提示词',
        messages: [{ role: 'user', content: '需要恢复的消息' }] }];
      activeConvId = aiConvs[0].id;
      safeSaveAiConvs();
      switchTab('ai');
      renderAiChat();
      deleteConv(activeConvId);
      return activeConvId;
    });
    await page.locator('#confirmOk').click();
    await expect.poll(() => page.evaluate(() => loadTrash('ai').length)).toBe(1);
    await page.evaluate(async () => { await StudyData.flush(); });
    await page.reload();
    await page.waitForSelector('#section-today');
    await page.evaluate(() => switchTab('trash'));
    const row = page.locator('#trashContainer .trash-item').filter({ hasText: '回收站验证对话' });
    await expect(row).toBeVisible();
    await row.getByTitle('恢复', { exact: true }).click();
    await expect(row).toHaveCount(0);
    expect(await page.evaluate(id => {
      const conv = aiConvs.find(c => c.id === id);
      return { prompt: conv.systemPrompt, text: conv.messages[0].content };
    }, id)).toEqual({ prompt: '保留提示词', text: '需要恢复的消息' });
    await page.evaluate(id => { deleteConv(id); }, id);
    await page.locator('#confirmOk').click();
    await page.evaluate(() => renderTrash());
    await row.getByTitle('永久删除', { exact: true }).click();
    await page.locator('#confirmOk').click();
    await expect(row).toHaveCount(0);
    await page.evaluate(async () => { await StudyData.flush(); });
    await page.reload();
    await page.waitForSelector('#section-today');
    expect(await page.evaluate(() => loadTrash('ai').length)).toBe(0);
  } finally {
    if (app) await app.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
});
