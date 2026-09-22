'use strict';

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let app;
let page;
let userDataPath;

test.beforeAll(async () => {
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-skills-'));
  app = await electron.launch({
    args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath }
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => document.querySelector('#section-today')?.classList.contains('active'));
});

test.afterAll(async () => {
  if (app) await app.close();
  if (userDataPath) await fs.rm(userDataPath, { recursive: true, force: true });
});

test('skills can be managed and multiple skill snapshots are inserted into a prompt', async () => {
  await page.evaluate(() => switchTab('skills'));
  await page.locator('#aiSkillName').fill('事实核对');
  await page.locator('#aiSkillContent').fill('先核对事实，再给出结论。');
  await page.getByRole('button', { name: '保存技能' }).click();
  await page.getByRole('button', { name: '新建' }).click();
  await page.locator('#aiSkillName').fill('结构化输出');
  await page.locator('#aiSkillContent').fill('按步骤说明，每一步写明依据。');
  await page.getByRole('button', { name: '保存技能' }).click();
  expect(await page.evaluate(() => loadAiSkills().length)).toBe(2);

  await page.evaluate(() => {
    window.loadApiKeys = () => [{ id: 'test-key', name: 'test' }];
    switchTab('ai');
  });
  await page.locator('#aiInsertSkillBtn').click();
  await page.getByRole('button', { name: /事实核对/ }).last().click();
  await page.getByRole('button', { name: /结构化输出/ }).last().click();
  await page.getByRole('button', { name: '完成' }).click();
  const inserted = await page.evaluate(() => {
    const snapshot = getAiContextInsertSnapshot();
    return { snapshot, prompt: buildAiContextInsertText(snapshot) };
  });
  expect(inserted.snapshot.map(item => item.label)).toEqual(['事实核对', '结构化输出']);
  expect(inserted.prompt).toContain('先核对事实，再给出结论。');
  expect(inserted.prompt).toContain('按步骤说明，每一步写明依据。');

  await page.evaluate(() => switchTab('skills'));
  await page.getByRole('button', { name: /事实核对/ }).first().click();
  await page.locator('#aiSkillContent').fill('只使用可核实的事实。');
  await page.getByRole('button', { name: '保存技能' }).click();
  expect(inserted.snapshot[0].content).toBe('先核对事实，再给出结论。');
  expect((await page.evaluate(() => getAiContextInsertSnapshot()))[0].content).toBe('只使用可核实的事实。');

  page.once('dialog', dialog => dialog.accept());
  await page.locator('.skills-delete-btn').click();
  expect(await page.evaluate(() => loadAiSkills().length)).toBe(1);
  expect(inserted.snapshot[0].content).toBe('先核对事实，再给出结论。');
});

test('AI generation writes a reviewable draft before saving', async () => {
  await page.evaluate(() => {
    localStorage.removeItem('study_ai_skills_v1');
    window.getEffectiveApiConfig = () => ({ apiKey: 'test', baseUrl: 'https://example.test/v1', model: 'test-model' });
    window.callAiApiNonStream = async (messages, config, conv, options) => {
      if (messages[1].content.includes('先确认上下文') && options.disableTools && conv === null) {
        return { cleanText: '先确认上下文，再按优先级给出建议。' };
      }
      throw new Error('unexpected generation request');
    };
    switchTab('skills');
    selectAiSkill(null);
  });
  await page.locator('#aiSkillName').fill('建议准则');
  await page.locator('#aiSkillIdea').fill('先确认上下文，再给建议');
  await page.getByRole('button', { name: 'AI 整理为技能文字' }).click();
  await expect(page.locator('#aiSkillContent')).toHaveValue('先确认上下文，再按优先级给出建议。');
  expect(await page.evaluate(() => loadAiSkills().length)).toBe(0);
  await page.getByRole('button', { name: '保存技能' }).click();
  expect(await page.evaluate(() => loadAiSkills().length)).toBe(1);
});
