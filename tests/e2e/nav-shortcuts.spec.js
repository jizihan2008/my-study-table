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
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-navkeys-e2e-'));
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

test('默认 Ctrl+1~9 仍按可见顺序切换栏目', async () => {
  await page.keyboard.press('Control+1');
  await expect(page.locator('#section-todo')).toHaveClass(/active/);
  await expect(page.locator('#nav-todo')).toHaveAttribute('aria-current', 'page');
  expect((await page.locator('#nav-todo .nav-key-hint').textContent()).trim()).toBe('Ctrl+1');
  expect(!!(await navConfig()).shortcutsCustom).toBe(false);
});

test('可在「编辑界面栏」把栏目快捷键改成任意 Ctrl+按键', async () => {
  await page.evaluate(() => openNavSettings());
  await chip('notes').click();
  await expect(chip('notes')).toHaveClass(/is-capturing/);
  await page.keyboard.press('Control+k');
  await expect(chip('notes')).toHaveText('Ctrl+K');

  const saved = await navConfig();
  expect(saved.shortcutsCustom).toBe(true);
  expect(saved.shortcuts.notes).toBe('k');

  await page.evaluate(() => closeEditModal());
  await page.keyboard.press('Control+k');
  await expect(page.locator('#section-notes')).toHaveClass(/active/);
  await expect(page.locator('#nav-notes .nav-key-hint')).toHaveText('Ctrl+K');
});

test('绑定已被占用的按键会从原栏目移除并提示', async () => {
  await page.evaluate(() => openNavSettings());
  await chip('calendar').click();
  await page.keyboard.press('Control+1');

  await expect(chip('calendar')).toHaveText('Ctrl+1');
  await expect(chip('todo')).toHaveText('未设置');
  const saved = await navConfig();
  expect(saved.shortcuts.calendar).toBe('1');
  expect(saved.shortcuts.todo).toBe('');
  await expect(page.locator('#appMiniToast')).toContainText('已从 待办 移除');
});

test('Backspace 清除单个栏目的绑定', async () => {
  await page.evaluate(() => openNavSettings());
  await chip('notes').click();
  await page.keyboard.press('Backspace');
  await expect(chip('notes')).toHaveText('未设置');
  expect((await navConfig()).shortcuts.notes).toBe('');
});

test('「恢复默认」重新按可见顺序分配 Ctrl+1~9', async () => {
  await page.locator('.nav-shortcut-reset').click();
  await expect(chip('todo')).toHaveText('Ctrl+1');
  await expect(chip('notes')).toHaveText('Ctrl+3');
  const saved = await navConfig();
  expect(saved.shortcutsCustom).toBe(false);

  await page.evaluate(() => closeEditModal());
  await page.keyboard.press('Control+3');
  await expect(page.locator('#section-notes')).toHaveClass(/active/);
});
