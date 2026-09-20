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

test('completed quests can be reopened and downstream quests are locked again', async () => {
  const result = await page.evaluate(() => {
    const line = tlAddLine({ name: '取消完成回归', type: 'quality' });
    const first = tlAddQuest({ lineId: line.id, title: '已完成的前置任务', status: 'active' });
    const next = tlAddQuest({ lineId: line.id, title: '依赖前置的任务', status: 'active', deps: [first.id] });
    tlCompleteQuest(first.id);
    const unlockedStatus = tlGetQuest(next.id).status;
    const response = tlUncompleteQuest(first.id);
    const reopened = tlGetQuest(first.id);
    tlOpenQuestDetail(first.id);
    const detail = document.getElementById('editModalBody').textContent;
    closeEditModal();
    return {
      ok: response.ok,
      unlockedStatus,
      reopenedStatus: reopened.status,
      completedAt: reopened.completedAt,
      downstreamStatus: tlGetQuest(next.id).status,
      detail
    };
  });
  expect(result).toMatchObject({
    ok: true,
    unlockedStatus: 'active',
    reopenedStatus: 'active',
    downstreamStatus: 'locked'
  });
  expect(result.completedAt).toBeUndefined();
  expect(result.detail).toContain('完成任务');
});

test('reopened quest with satisfied conditions does not immediately auto-complete', async () => {
  const result = await page.evaluate(() => {
    const line = tlAddLine({ name: '自动完成取消回归', type: 'quality' });
    const quest = tlAddQuest({
      lineId: line.id,
      title: '条件仍满足的任务',
      status: 'active',
      conditions: [{ type: 'manual', label: '已达成', done: true }]
    });
    tlRefreshAll();
    const completedStatus = tlGetQuest(quest.id).status;
    tlUncompleteQuest(quest.id);
    renderTaskLine();
    const reopened = tlGetQuest(quest.id);
    return { completedStatus, reopenedStatus: reopened.status, suppressed: reopened.autoCompleteSuppressed };
  });
  expect(result).toEqual({ completedStatus: 'done', reopenedStatus: 'active', suppressed: true });
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

// 回归：「右键 → 添加任务」新建的任务必须落在鼠标位置。
// 曾经的 bug：双击/右键位置只按 inner 的 rect 换算，漏掉了渲染时为容纳负坐标/最小坐标
// 给 .tl-graph-nodes 加的 shift，导致落点整体偏移 layout.minX/minY（常见 100px）。
test('a quest created from the canvas lands exactly under the mouse at any zoom and pan', async () => {
  const result = await page.evaluate(() => {
    const withNegativeCoords = tlAddLine({ name: '落点回归-负坐标', type: 'quality' });
    tlAddQuest({ lineId: withNegativeCoords.id, title: '负坐标锚点', status: 'active', pos: { x: -120, y: -60 } });
    tlAddQuest({ lineId: withNegativeCoords.id, title: '正坐标锚点', status: 'active', pos: { x: 300, y: 160 } });
    tlRefreshAll();
    tlSwitchLine(withNegativeCoords.id);
    const wrap = document.getElementById('tlGraphWrap');
    const canvas = wrap.querySelector('.tl-graph-canvas');
    const cRect = canvas.getBoundingClientRect();
    const wantX = cRect.left + cRect.width * 0.55;
    const wantY = cRect.top + cRect.height * 0.45;
    // 走生产代码的换算入口（右键菜单用的就是它）
    const ctxPos = tlScreenToCanvasPos(wantX, wantY);
    tlOpenQuestForm(withNegativeCoords.id, ctxPos);
    document.getElementById('tlQuestTitle').value = '落点回归任务';
    tlSubmitQuestForm(withNegativeCoords.id);
    const quest = tlGetQuests().find(q => q.title === '落点回归任务');
    const node = document.querySelector('.tl-node[data-qid="' + quest.id + '"]');
    const nRect = node.getBoundingClientRect();
    // 不变量：节点在画布中的布局位置 = TL_PAD + 落点坐标（两种换算入口语义必须一致）
    const nodePosInCanvas = tlNodeClientToQuestPos(node, 0);
    return {
      deltaX: Math.abs(nRect.left - wantX),
      deltaY: Math.abs(nRect.top - wantY),
      posMatchesCanvas: nodePosInCanvas.x === Math.round(ctxPos.x) && nodePosInCanvas.y === Math.round(ctxPos.y),
      // 参考：该场景 layout.minX/minY = -120/-60，没有 nodesShift 时落点恰好会差 120/60
      ctxPos: { x: Math.round(ctxPos.x), y: Math.round(ctxPos.y) },
      questPos: quest.pos
    };
  });
  expect(result.deltaX).toBeLessThanOrEqual(1.5);
  expect(result.deltaY).toBeLessThanOrEqual(1.5);
  expect(result.posMatchesCanvas).toBe(true);

  // 缩放 + 平移下同样成立
  const zoomedDelta = await page.evaluate(() => {
    const line = tlGetLines().find(l => l.name === '落点回归-负坐标');
    tlSwitchLine(line.id);
    tlGraphView.scale = 1.5;
    tlGraphView.left = -60;
    tlGraphView.top = -40;
    tlApplyGraphView();
    const canvas = document.querySelector('#tlGraphWrap .tl-graph-canvas');
    const cRect = canvas.getBoundingClientRect();
    const wantX = cRect.left + cRect.width * 0.6;
    const wantY = cRect.top + cRect.height * 0.4;
    const ctxPos = tlScreenToCanvasPos(wantX, wantY);
    tlOpenQuestForm(line.id, ctxPos);
    document.getElementById('tlQuestTitle').value = '落点回归任务-缩放';
    tlSubmitQuestForm(line.id);
    const quest = tlGetQuests().find(q => q.title === '落点回归任务-缩放');
    const nRect = document.querySelector('.tl-node[data-qid="' + quest.id + '"]').getBoundingClientRect();
    return { deltaX: Math.abs(nRect.left - wantX), deltaY: Math.abs(nRect.top - wantY) };
  });
  expect(zoomedDelta.deltaX).toBeLessThanOrEqual(1.5);
  expect(zoomedDelta.deltaY).toBeLessThanOrEqual(1.5);
});
