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

test('touch tap opens quest detail and a two-finger gesture zooms the canvas', async () => {
  const result = await page.evaluate(() => {
    const line = tlAddLine({ name: '移动端手势回归', type: 'quality' });
    const quest = tlAddQuest({ lineId: line.id, title: '轻触查看详情', status: 'active' });
    tlSwitchLine(line.id);
    const canvas = document.querySelector('#tlGraphWrap .tl-graph-canvas');
    const node = canvas.querySelector('.tl-node[data-qid="' + quest.id + '"]');
    const makeTouch = (id, x, y, target) => new Touch({
      identifier: id, target, clientX: x, clientY: y, pageX: x, pageY: y,
      screenX: x, screenY: y, radiusX: 2, radiusY: 2, force: 1
    });

    const nr = node.getBoundingClientRect();
    const tap = makeTouch(1, nr.left + 10, nr.top + 10, node);
    tlNodeDragTouchStart({ preventDefault() {}, currentTarget: node, touches: [tap] }, quest.id);
    document.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [tap] }));
    const detailOpened = document.getElementById('editModalBody').textContent.includes('轻触查看详情');
    closeEditModal();

    const cr = canvas.getBoundingClientRect();
    const a = makeTouch(2, cr.left + 120, cr.top + 150, canvas);
    const b = makeTouch(3, cr.left + 220, cr.top + 150, canvas);
    canvas.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [a, b], targetTouches: [a, b], changedTouches: [a, b] }));
    const a2 = makeTouch(2, cr.left + 80, cr.top + 150, canvas);
    const b2 = makeTouch(3, cr.left + 260, cr.top + 150, canvas);
    document.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [a2, b2], targetTouches: [a2, b2], changedTouches: [a2, b2] }));
    const scale = tlGraphView.scale;
    const indicator = document.getElementById('tlZoomIndicator').textContent;
    document.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [a2, b2] }));
    return { detailOpened, scale, indicator };
  });
  expect(result.detailOpened).toBe(true);
  expect(result.scale).toBeGreaterThan(1.5);
  expect(result.indicator).toBe(Math.round(result.scale * 100) + '%');
});

test('right-edge swipe opens the taskline sidebar and a right swipe closes it', async () => {
  const result = await page.evaluate(() => {
    switchTab('taskline');
    renderTaskLine();
    // Electron 的测试窗口可能不报告触点；直接初始化仍应复用生产手势入口。
    if (!tlSidebarSwipeInitialized) {
      Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 });
      initTlSidebarSwipe();
    }
    const sidebar = document.getElementById('tlSidebar');
    closeTlSidebar();
    const makeTouch = (id, x, y, target) => new Touch({
      identifier: id, target, clientX: x, clientY: y, pageX: x, pageY: y,
      screenX: x, screenY: y, radiusX: 2, radiusY: 2, force: 1
    });
    const dispatch = (type, touch) => document.dispatchEvent(new TouchEvent(type, {
      bubbles: true, cancelable: true,
      touches: type === 'touchend' ? [] : [touch],
      targetTouches: type === 'touchend' ? [] : [touch],
      changedTouches: [touch]
    }));

    const openStart = makeTouch(10, window.innerWidth - 8, 180, document.body);
    const openEnd = makeTouch(10, window.innerWidth - 100, 184, document.body);
    dispatch('touchstart', openStart);
    dispatch('touchmove', openEnd);
    const opened = sidebar.classList.contains('open');
    dispatch('touchend', openEnd);

    const rect = sidebar.getBoundingClientRect();
    const closeStart = makeTouch(11, rect.left + 24, 180, sidebar);
    const closeEnd = makeTouch(11, rect.left + 116, 184, sidebar);
    dispatch('touchstart', closeStart);
    dispatch('touchmove', closeEnd);
    const closed = !sidebar.classList.contains('open');
    dispatch('touchend', closeEnd);
    return { opened, closed };
  });
  expect(result).toEqual({ opened: true, closed: true });
});

test('context menu can pick a prerequisite with a snapping arrow without opening details', async () => {
  const ids = await page.evaluate(() => {
    closeEditModal();
    switchTab('taskline');
    tlGraphView = { scale: 1, left: 0, top: 0 };
    const line = tlAddLine({ name: '鼠标设置前置任务', type: 'quality' });
    const dependent = tlAddQuest({ lineId: line.id, title: '需要前置的任务', status: 'active', pos: { x: 300, y: 120 } });
    const prerequisite = tlAddQuest({ lineId: line.id, title: '候选前置任务', status: 'active', pos: { x: 40, y: 120 } });
    tlSwitchLine(line.id);
    return { dependent: dependent.id, prerequisite: prerequisite.id };
  });

  const dependent = page.locator(`.tl-node[data-qid="${ids.dependent}"]`);
  const prerequisite = page.locator(`.tl-node[data-qid="${ids.prerequisite}"]`);
  await dependent.click({ button: 'right' });
  await page.locator('#tlQuestContextMenu').getByText('设置前置任务').click();
  await prerequisite.hover();

  await expect(page.locator('#tlPrerequisitePreview')).not.toHaveAttribute('style', /display:\s*none/);
  await expect(prerequisite).toHaveClass(/tl-prerequisite-target/);
  const previewPath = await page.locator('#tlPrerequisitePreview').getAttribute('d');
  expect(previewPath).toContain(' C ');

  await prerequisite.click();
  const result = await page.evaluate(({ dependent, prerequisite }) => ({
    deps: tlGetQuest(dependent).deps,
    status: tlGetQuest(dependent).status,
    detailOpen: document.getElementById('editModal').classList.contains('open'),
    picking: !!tlPrerequisitePick
  }), ids);
  expect(result.deps).toContain(ids.prerequisite);
  expect(result.status).toBe('locked');
  expect(result.detailOpen).toBe(false);
  expect(result.picking).toBe(false);
});
