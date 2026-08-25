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
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-e2e-'));
  electronApp = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath }
  });
  page = await electronApp.firstWindow();
  page.on('console', message => {
    if (message.type() === 'error') console.error('[renderer]', message.text());
  });
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  if (electronApp) await electronApp.close();
  if (userDataPath) await fs.rm(userDataPath, { recursive: true, force: true });
});

test('application boots with isolated renderer and versioned storage', async () => {
  await expect(page).toHaveTitle(/My Study Table/);
  const state = await page.evaluate(async () => {
    const result = await window.StudyData.initialize();
    return {
      contextHasRequire: typeof window.require !== 'undefined',
      database: window.StudyData.status().database,
      initialized: result.ok
    };
  });
  expect(state).toEqual({
    contextHasRequire: false,
    database: 'my-study-table-data',
    initialized: true
  });
});

test('todo creation persists across a renderer reload', async () => {
  await page.evaluate(() => window.switchTab('todo'));
  await page.click('#btnTodoToggle');
  await page.fill('#todoInput', 'E2E 持久化待办');
  await page.press('#todoInput', 'Enter');
  await expect(page.locator('.todo-text', { hasText: 'E2E 持久化待办' })).toBeVisible();
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(500);
  await page.evaluate(() => window.switchTab('todo'));
  await expect(page.locator('.todo-text', { hasText: 'E2E 持久化待办' })).toBeVisible();
});

test('credentials leave localStorage after encrypted migration', async () => {
  const result = await page.evaluate(async () => {
    await window.SecretVault.set('study_web_search_key', 'e2e-secret-value');
    return {
      cached: window.SecretVault.get('study_web_search_key'),
      plaintext: localStorage.getItem('study_web_search_key'),
      secure: window.SecretVault.isSecure()
    };
  });
  expect(result.cached).toBe('e2e-secret-value');
  expect(result.plaintext).toBeNull();
  expect(result.secure).toBe(true);
});

test('AI policy detects secrets and records token usage', async () => {
  const result = await page.evaluate(() => {
    const matches = window.AIClient.findSensitiveContent([
      { role: 'user', content: 'password: hunter2 and sk-abcdefghijklmnopqrstuvwxyz' }
    ]);
    const usage = window.AIClient.recordUsage('gpt-4o-mini', { prompt_tokens: 1000, completion_tokens: 500 });
    return { matches, usage, store: JSON.parse(localStorage.getItem('study_ai_usage_v1') || '{}') };
  });
  expect(result.matches).toEqual(expect.arrayContaining(['API Key', '密码字段']));
  expect(result.usage.inputTokens).toBe(1000);
  expect(Object.values(result.store)[0].requests).toBeGreaterThan(0);
});

test('third-party plugin runs in an opaque sandbox with declared permissions', async () => {
  const result = await page.evaluate(async () => {
    await window.electronAPI.extWrite({
      id: 'e2e-sandbox',
      files: {
        manifest: { id: 'e2e-sandbox', name: 'E2E Sandbox', type: 'plugin', enabled: false, permissions: ['storage', 'log'] },
        main: `let escaped=false; try { parent.document.body.dataset.compromised='yes'; escaped=true; } catch (_) {}\n` +
          `extAPI.setData('result', { escaped, hasNode: typeof require !== 'undefined' });`
      }
    });
    await window.ExtManager.reload();
    const before = window.ExtManager.get('e2e-sandbox').enabled;
    const mounted = await window.ExtManager.setEnabled('e2e-sandbox', true);
    return {
      mounted,
      before,
      after: window.ExtManager.get('e2e-sandbox').enabled,
      compromised: document.body.dataset.compromised || ''
    };
  });
  expect(result.mounted.ok, JSON.stringify(result)).toBe(true);
  await page.waitForFunction(() => localStorage.getItem('study_ext_e2e-sandbox_result') !== null, null, { timeout: 5000 });
  const sandboxData = await page.evaluate(() => JSON.parse(localStorage.getItem('study_ext_e2e-sandbox_result')));
  expect(result.compromised).toBe('');
  expect(sandboxData).toEqual({ escaped: false, hasNode: false });
});
