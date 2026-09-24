'use strict';

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let app;
let page;
let profile;

test.beforeAll(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-other-test-'));
  app = await electron.launch({
    args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: profile }
  });
  page = await app.firstWindow();
  await page.waitForFunction(() => typeof renderAiMessages === 'function' && typeof loadApiKeys === 'function' && typeof window.StudyData?.initialize === 'function');
  await page.waitForFunction(() => document.getElementById('section-today')?.classList.contains('active') && document.getElementById('todayWelcomeDate')?.textContent.length > 0);
});

test.afterAll(async () => {
  if (app) await app.close();
  if (!profile) return;
  const realProfile = await fs.realpath(profile);
  const realTemp = await fs.realpath(os.tmpdir());
  if (path.dirname(realProfile) !== realTemp || !path.basename(realProfile).startsWith('mst-other-test-')) {
    throw new Error('Refusing to remove an unexpected test profile path');
  }
  await fs.rm(realProfile, { recursive: true, force: true });
});

test('long AI conversations show recent messages and can load older history', async () => {
  await page.evaluate(() => {
    switchTab('ai');
    const messages = Array.from({ length: 300 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `性能消息 ${index}`
    }));
    aiConvs = [{ id: 97531, title: '长对话', messages, systemPrompt: '' }];
    activeConvId = 97531;
    renderAiChat();
  });
  await expect(page.locator('#section-ai')).toHaveClass(/active/);
  await expect(page.locator('#aiMessages .ai-chat-msg')).toHaveCount(80);
  await expect(page.locator('#aiMessages')).toContainText('性能消息 299');
  await expect(page.locator('#aiMessages')).not.toContainText('性能消息 0');
  await expect(page.locator('.ai-history-more')).toContainText('220 条');
  await page.locator('.ai-history-more').click();
  await expect(page.locator('#aiMessages .ai-chat-msg')).toHaveCount(160);
  await expect(page.locator('#aiMessages')).toContainText('性能消息 140');
  await expect(page.locator('.ai-history-more')).toContainText('140 条');
});

test('data initialization batches changed keys and restores missing cache entries', async () => {
  const state = await page.evaluate(async () => {
    localStorage.setItem('perf-test-record', 'study data');
    const first = await StudyData.initialize();
    const initialRecord = await StudyData.getRecord('perf-test-record');
    const warm = await StudyData.initialize();
    const afterWarm = await StudyData.getRecord('perf-test-record');
    localStorage.removeItem('perf-test-record');
    sessionStorage.setItem('__study_data_restore_reload', '1');
    const restored = await StudyData.initialize();
    return {
      firstCopied: first.copied,
      warmCopied: warm.copied,
      stableRevision: initialRecord.revision === afterWarm.revision,
      restored: restored.restored,
      value: localStorage.getItem('perf-test-record'),
      metaRecord: await StudyData.getRecord('__study_data_migrated_v1')
    };
  });
  expect(state.firstCopied).toBeGreaterThanOrEqual(1);
  expect(state.warmCopied).toBe(0);
  expect(state.stableRevision).toBe(true);
  expect(state.restored).toBeGreaterThanOrEqual(1);
  expect(state.value).toBe('study data');
  expect(state.metaRecord).toBeUndefined();
});
