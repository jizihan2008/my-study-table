'use strict';

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let electronApp;
let page;
let userDataPath;

const navConfig = () => page.evaluate(() => JSON.parse(localStorage.getItem('study_nav_config') || '{}'));
const chip = tabId => page.locator(`.nav-sort-key[data-shortcut-for="${tabId}"]`);

test.beforeAll(async () => {
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-navtouch-e2e-'));
  electronApp = await electron.launch({
    args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath }
  });
  page = await electronApp.firstWindow();
  await page.waitForFunction(() => document.readyState !== 'loading'
    && typeof window.startNavShortcutCapture === 'function'
    && document.querySelector('#nav-today[aria-current="page"]'));
});

test.afterAll(async () => {
  if (electronApp) await electronApp.close();
  if (userDataPath) await fs.rm(userDataPath, { recursive: true, force: true });
});


async function touch(target, type, y, x = 20) {
  await page.evaluate(({ target, type, y, x }) => {
    const el = document.querySelector(target);
    const t = new Touch({ identifier: 17, target: el, clientX: x, clientY: y });
    const ended = type === 'touchend' || type === 'touchcancel';
    el.dispatchEvent(new TouchEvent(type, {
      bubbles: true, cancelable: true,
      touches: ended ? [] : [t], changedTouches: [t], targetTouches: ended ? [] : [t]
    }));
  }, { target, type, y, x });
}
const order = list => page.locator(list).evaluate(el => Array.from(el.children).map(row => row.dataset.id));

for (const list of ['#navSortList', '#navBottomSortList']) {
  test(`${list} 触摸拖动只移动到目标位置，并支持向上拖回及保存`, async () => {
    await page.evaluate(() => openNavSettings());
    const initial = await order(list);
    expect(initial.length).toBeGreaterThanOrEqual(3);
    const target = `${list} [data-id="${initial[0]}"] .nav-sort-grip`;
    const box = await page.locator(target).boundingBox();
    await touch(target, 'touchstart', box.y + box.height / 2);
    await touch(target, 'touchmove', box.y + box.height / 2 + 1);
    expect(await order(list)).toEqual(initial);
    const third = await page.locator(`${list} > [data-id="${initial[2]}"]`).boundingBox();
    await touch(target, 'touchmove', third.y + third.height / 2 - 2);
    expect(await order(list)).toEqual([initial[1], initial[0], ...initial.slice(2)]);
    await touch(target, 'touchmove', box.y + box.height / 2);
    expect(await order(list)).toEqual(initial);
    await touch(target, 'touchmove', third.y + third.height + 2);
    const final = [initial[1], initial[2], initial[0], ...initial.slice(3)];
    expect(await order(list)).toEqual(final);
    await touch(target, 'touchend', third.y + third.height + 2);
    const cfg = await navConfig();
    expect(list === '#navSortList' ? cfg.order : cfg.bottomTabs).toEqual(final);
    await page.evaluate(() => openNavSettings());
    expect(await order(list)).toEqual(final);
  });

  test(`${list} 长按静止、滚动和取消不会意外排序`, async () => {
    await page.evaluate(() => openNavSettings());
    const initial = await order(list);
    const target = `${list} [data-id="${initial[0]}"]`;
    const box = await page.locator(target).boundingBox();
    const y = box.y + box.height / 2;
    await touch(target, 'touchstart', y);
    await expect(page.locator(target)).toHaveClass(/touch-dragging/);
    await touch(target, 'touchmove', y + 1);
    expect(await order(list)).toEqual(initial);
    await touch(target, 'touchend', y + 1);
    await expect(page.locator(target)).not.toHaveClass(/touch-dragging/);
    await touch(target, 'touchstart', y);
    await touch(target, 'touchmove', y + 20);
    await page.waitForTimeout(300);
    await expect(page.locator(target)).not.toHaveClass(/touch-dragging/);
    await touch(target, 'touchend', y + 20);
    expect(await order(list)).toEqual(initial);
    await touch(`${target} .nav-sort-grip`, 'touchstart', y);
    await touch(target, 'touchmove', y + 1000);
    expect(await order(list)).not.toEqual(initial);
    await touch(target, 'touchcancel', y + 1000);
    expect(await order(list)).toEqual(initial);
  });
}

test('快捷键、显示开关和移除按钮不启动触摸排序', async () => {
  await page.evaluate(() => openNavSettings());
  for (const selector of ['.nav-sort-key', '.nav-sort-toggle', '.nav-bottom-remove']) {
    await touch(selector, 'touchstart', 50);
    await page.waitForTimeout(300);
    await expect(page.locator('.touch-dragging')).toHaveCount(0);
    await touch(selector, 'touchend', 50);
  }
});

test('浏览器真实触摸事件可从手柄拖动，且列表不被滚动抢走', async () => {
  await page.evaluate(() => openNavSettings());
  const initial = await order('#navSortList');
  const grip = await page.locator(`#navSortList [data-id="${initial[0]}"] .nav-sort-grip`).boundingBox();
  const third = await page.locator(`#navSortList [data-id="${initial[2]}"]`).boundingBox();
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const x = grip.x + grip.width / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: grip.y + grip.height / 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: third.y + third.height / 2 - 2 }] });
    await expect.poll(() => order('#navSortList')).toEqual([initial[1], initial[0], ...initial.slice(2)]);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('.touch-dragging')).toHaveCount(0);
  } finally {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await cdp.detach();
  }
});

for (const method of ['touch', 'mouse']) {
  test(`${method} 排序立即保存，勾选/取消勾选和快捷键重绘保留顺序`, async () => {
    await page.evaluate(() => openNavSettings());
    const initial = await order('#navSortList');
    const row = id => `#navSortList [data-id="${id}"]`;
    if (method === 'touch') {
      const grip = `${row(initial[0])} .nav-sort-grip`;
      const start = await page.locator(grip).boundingBox();
      const third = await page.locator(row(initial[2])).boundingBox();
      await touch(grip, 'touchstart', start.y + start.height / 2);
      await touch(grip, 'touchmove', third.y + third.height + 2);
      await touch(grip, 'touchend', third.y + third.height + 2);
    } else {
      await page.locator(`${row(initial[0])} .nav-sort-grip`).dragTo(page.locator(row(initial[2])));
    }
    const reordered = await order('#navSortList');
    expect(reordered).not.toEqual(initial);
    expect((await navConfig()).order).toEqual(reordered);
    const checkbox = page.locator(`${row(initial[1])} input[type="checkbox"]`);
    const wasChecked = await checkbox.isChecked();
    await page.locator(`${row(initial[1])} .nav-sort-toggle`).click();
    expect(await checkbox.isChecked()).toBe(!wasChecked);
    expect(await order('#navSortList')).toEqual(reordered);
    expect((await navConfig()).order).toEqual(reordered);
    await page.locator(`${row(initial[1])} .nav-sort-toggle`).click();
    expect(await checkbox.isChecked()).toBe(wasChecked);
    expect(await order('#navSortList')).toEqual(reordered);
    await page.locator(`${row(initial[1])} .nav-sort-key`).click();
    await page.keyboard.press('Escape');
    expect(await order('#navSortList')).toEqual(reordered);
    await page.evaluate(() => { closeEditModal(); openNavSettings(); });
    expect(await order('#navSortList')).toEqual(reordered);
  });
}
