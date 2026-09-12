'use strict';

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let electronApp;
let page;
let userDataPath;

test.beforeAll(async () => {
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-taskline-e2e-'));
  electronApp = await electron.launch({
    args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath }
  });
  page = await electronApp.firstWindow();
  await page.waitForFunction(() => document.readyState !== 'loading' && typeof window.tlAddQuest === 'function');
  await page.waitForFunction(() => document.querySelector('#nav-today[aria-current="page"]'));
});

test.afterAll(async () => {
  if (electronApp) await electronApp.close();
  if (userDataPath) await fs.rm(userDataPath, { recursive: true, force: true });
});

test('manual task creation skips draft, AI tasks retain confirmation, dependencies remain locked', async () => {
  const result = await page.evaluate(() => {
    const line = tlAddLine({ name: '状态展示', type: 'quality' });
    switchTab('taskline');
    tlOpenQuestForm(line.id);
    document.getElementById('tlQuestTitle').value = '手动创建的任务';
    tlSubmitQuestForm(line.id);
    const manual = tlGetQuests().find(q => q.title === '手动创建的任务');
    tlOpenQuestDetail(manual.id);
    const detail = document.getElementById('editModalBody').textContent;
    closeEditModal();
    const draft = tlAddQuest({ lineId: line.id, title: 'AI 规划待确认' });
    const locked = tlAddQuest({ lineId: line.id, title: '等待前置任务', status: 'active', deps: [manual.id] });
    tlRefreshAll();
    return { manual: manual.status, draft: draft.status, locked: tlGetQuest(locked.id).status, detail };
  });
  expect(result).toMatchObject({ manual: 'active', draft: 'draft', locked: 'locked' });
  expect(result.detail).toContain('完成任务');
  expect(result.detail).not.toContain('确认任务');
});

test('manual task in a locked chapter stays locked after refresh', async () => {
  const result = await page.evaluate(() => {
    const first = tlAddLine({ name: '第一阶段', type: 'main' });
    tlAddQuest({ lineId: first.id, title: '前一阶段未完成', status: 'active' });
    const next = tlAddLine({ name: '第二阶段', type: 'main' });
    const task = tlAddQuest({ lineId: next.id, title: '后续阶段', status: 'active' });
    tlRefreshAll();
    return tlGetQuest(task.id).status;
  });
  expect(result).toBe('locked');
});

test('all states have distinct labeled icons and readable cards in both themes', async ({}, testInfo) => {
  await page.evaluate(() => {
    const line = tlGetLines()[0];
    const done = tlAddQuest({ lineId: line.id, title: '完成一轮知识复盘', kind: 'main' });
    tlUpdateQuest(done.id, { status: 'done' });
    const skipped = tlAddQuest({ lineId: line.id, title: '已调整计划的选修内容' });
    tlUpdateQuest(skipped.id, { status: 'skipped' });
    switchTab('taskline');
    renderTaskLine();
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => window.applyTheme(value), theme);
    for (const [status, label] of Object.entries({ draft: '待确认', locked: '待解锁', active: '进行中', done: '已完成', skipped: '已跳过' })) {
      const card = page.locator('.tl-node-' + status).first();
      await expect(card.locator('.tl-status-badge')).toContainText(label);
      await expect(card.locator('.tl-status-badge svg')).toBeVisible();
      expect(await card.evaluate(el => getComputedStyle(el).opacity)).toBe('1');
    }
    const statusColors = await page.locator('.tl-status-badge').evaluateAll(badges => badges.slice(0, 5).map(badge => getComputedStyle(badge).color));
    expect(new Set(statusColors).size).toBe(5);
    const statusCards = await page.locator('.tl-node:not(.tl-node-ext)').evaluateAll(nodes => nodes.map(node => ({
      status: ['draft', 'locked', 'active', 'done', 'skipped'].find(status => node.classList.contains('tl-node-' + status)),
      border: getComputedStyle(node).borderTopColor,
      background: getComputedStyle(node).backgroundImage
    })));
    expect(new Set(statusCards.map(item => item.border)).size).toBe(5);
    expect(new Set(statusCards.map(item => item.background)).size).toBe(5);
    const kinds = await page.locator('.tl-node:not(.tl-node-ext)').evaluateAll(nodes => nodes.map(node => ({
      kind: node.classList.contains('tl-node-main') ? 'main' : 'side',
      border: getComputedStyle(node).borderLeftColor,
      height: parseFloat(getComputedStyle(node).height),
      width: parseFloat(getComputedStyle(node).width)
    })));
    expect(new Set(kinds.map(item => item.border)).size).toBe(2);
    expect(Math.max(...kinds.map(item => item.height))).toBeLessThanOrEqual(66);
    expect(Math.max(...kinds.map(item => item.width))).toBeLessThanOrEqual(196);
    await page.screenshot({ path: testInfo.outputPath('taskline-' + theme + '.png') });
  }
});
