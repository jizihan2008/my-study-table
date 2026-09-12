'use strict';

// 回归测试：教材「学习」tab 的 PDF 阅读器全屏按钮。
//
// 背景：Electron 把元素全屏（requestFullscreen）也当成一种权限。主窗口的权限处理器
// 一旦无条件拒绝，渲染进程里的 requestFullscreen() 返回的 Promise 会永久挂起
// （既不 resolve 也不 reject，见 electron#37719），于是按钮点了完全没反应——
// 既进不了原生全屏，也走不到「类全屏」兜底分支。
//
// 说明：原生全屏会触发 OS 窗口过渡，过渡期间的点击/状态读取在自动化环境里不稳定
// （窗口几何、焦点、单实例锁都会互相干扰），因此这里只断言「点一下就一定有明确结果」：
// 要么进入原生全屏，要么落到类全屏兜底。主进程放行 fullscreen 权限这件事由
// tests/fullscreen-permission.test.js 静态锁定，那条用例是确定性的。

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { openStudyTab } = require('../fixtures/books-pdf');

let electronApp;
let page;
let userDataPath;

test.beforeAll(async () => {
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-books-fullscreen-'));
  electronApp = await electron.launch({
    args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath }
  });
  page = await electronApp.firstWindow();
  page.on('pageerror', error => console.error('[books-fullscreen] 渲染错误:', error.message));
  await page.waitForLoadState('domcontentloaded');
  await openStudyTab(page);
});

test.afterAll(async () => {
  // 应用可能已经退出；close() 直接 reject 会掩盖真正的失败原因
  if (electronApp) await electronApp.close().catch(() => {});
  if (userDataPath) {
    await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

function readFsState() {
  return page.evaluate(() => {
    const root = document.getElementById('bkStudyRoot');
    const rect = root.getBoundingClientRect();
    const button = document.getElementById('bkStudyFullscreenBtn');
    return {
      nativeId: document.fullscreenElement ? (document.fullscreenElement.id || document.fullscreenElement.tagName) : null,
      fakeFullscreen: typeof _stFakeFs === 'undefined' ? null : _stFakeFs,
      rect: { width: Math.round(rect.width), height: Math.round(rect.height) },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      buttonTitle: button ? button.title : null
    };
  });
}

// 点击全屏按钮。
// 用 locator.click 而不是 page.mouse.click：进入全屏后视口尺寸变化，mouse.click 的旧坐标会点空。
async function clickFullscreenButton() {
  await page.evaluate(() => {
    const toolbar = document.getElementById('bkStudyTop');
    if (toolbar) toolbar.classList.remove('hidden');
  });
  const button = page.locator('#bkStudyFullscreenBtn');
  await expect(button, '全屏按钮应可见可点').toBeVisible();
  await button.click();
}

// 全屏切换是异步的：等待「原生全屏就位」或「类全屏兜底生效」二者之一。
async function waitForAnyFullscreen(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await readFsState();
    if (state.nativeId || state.fakeFullscreen) return state;
    if (Date.now() > deadline) {
      throw new Error('全屏切换没有任何结果（既未进入原生全屏，也未落到类全屏）: ' + JSON.stringify(state));
    }
    await page.waitForTimeout(100);
  }
}

test('fullscreen button always produces a fullscreen state', async () => {
  const initial = await readFsState();
  expect(initial.nativeId).toBeNull();
  expect(initial.fakeFullscreen).toBe(false);
  expect(initial.buttonTitle).toBe('全屏');
  expect(initial.rect.width).toBeLessThan(initial.viewport.width);

  await clickFullscreenButton();
  const entered = await waitForAnyFullscreen();

  // 关键点：按钮必须真的生效，不能「点了没反应」——这正是权限处理器无条件拒绝时的表现
  expect(entered.nativeId === 'bkStudyRoot' || entered.fakeFullscreen === true).toBe(true);
  expect(entered.buttonTitle).toBe('退出全屏');
  // 进入后必须铺满视口
  expect(entered.rect.width).toBeGreaterThan(entered.viewport.width - 2);
  expect(entered.rect.height).toBeGreaterThan(entered.viewport.height - 2);

  // 退出：全屏状态与按钮标题都要还原
  await clickFullscreenButton();
  await page.waitForFunction(() => {
    const button = document.getElementById('bkStudyFullscreenBtn');
    return !!button && button.title === '全屏';
  }, null, { timeout: 10000 });

  const left = await readFsState();
  expect(left.nativeId).toBeNull();
  expect(left.fakeFullscreen).toBe(false);
  expect(left.rect.width).toBeLessThan(left.viewport.width);
});
