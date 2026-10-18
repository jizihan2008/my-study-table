'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('cloud conversation manager deletes a remote-only conversation and keeps local history at narrow widths', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-cloud-manager-e2e-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.waitForSelector('#section-today.active');
    const harness = await fs.readFile(path.resolve('tests/sync-logs.test.js'), 'utf8');
    const mockSource = harness.slice(harness.indexOf('function cloudManagementClient('), harness.indexOf("test('cloud manager lists"));
    await page.evaluate(`(() => {
      ${mockSource}
      window.cloudManagerTest = cloudManagementClient(remoteConversationRows());
      window.getSupabaseClient = () => cloudManagerTest.client;
      window.Sync.canSyncAccount = () => true;
      createNewConv();
      getActiveConv().title = '必须保留的本地记录';
      appendMessage(getActiveConv(), { role: 'user', content: '本地历史' });
      safeSaveAiConvs();
      openSettingsModal(); switchSettingsTab('sync');
      return SyncLogs.renderPanel();
    })()`);
    const manager = page.locator('[data-cloud-conversations]');
    await manager.getByRole('button', { name: '查看 / 刷新云端对话' }).click();
    await expect(manager).toContainText('云端独有对话');
    await expect(manager).toContainText('保留的对话');
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await manager.evaluate(root => root.scrollWidth > root.clientWidth + 1);
    expect(overflow).toBe(false);
    const target = manager.locator('.storage-item').filter({ hasText: '云端独有对话' });
    page.once('dialog', dialog => dialog.accept());
    await target.getByRole('button', { name: '从云端删除' }).click();
    await expect(manager).not.toContainText('云端独有对话');
    await expect(manager).toContainText('保留的对话');
    await expect(page.locator('#storageStatus')).toContainText('本地记录保留');
    const state = await page.evaluate(() => ({
      local: aiConvs.some(conv => conv.title === '必须保留的本地记录'),
      shards: cloudManagerTest.rows().filter(row => row.item_id === '7_p0' || row.item_id === '7_p1').length,
      paused: JSON.parse(localStorage.getItem('study_sync_logs_marks'))['ai_conv/7'] === false
    }));
    expect(state).toEqual({ local: true, shards: 0, paused: true });
  } finally {
    if (app) await app.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
});
