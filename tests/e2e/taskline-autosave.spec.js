'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test.use({ channel: 'chrome', serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  const root = path.resolve(__dirname, '../..');
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'study-table.test') return route.abort();
    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404 });
    return route.fulfill({ path: file });
  });
});

async function openQuestEditor(page) {
  await page.goto('http://study-table.test/');
  await page.waitForFunction(() => typeof tlSaveQuestEdit === 'function' && document.querySelector('#nav-today[aria-current="page"]'));
  return page.evaluate(() => {
    const line = tlAddLine({ name: '即时编辑回归', type: 'quality' });
    const quest = tlAddQuest({ lineId: line.id, title: '原任务', desc: '原描述', status: 'active' });
    switchTab('taskline');
    tlSwitchLine(line.id);
    tlEditQuestForm(quest.id);
    return { lineId: line.id, questId: quest.id };
  });
}

test('task fields save during input, preserve focus, and survive closing and reloading', async ({ page }) => {
  const { questId } = await openQuestEditor(page);
  const title = page.locator('#tlQuestTitle');
  const desc = page.locator('#tlQuestDesc');
  await title.fill('新任务');
  await title.press('End');
  await title.pressSequentially(' +');
  await expect(title).toBeFocused();
  expect(await title.evaluate(el => el.selectionStart)).toBe(5);
  expect(await page.evaluate(id => tlGetQuest(id).title, questId)).toBe('新任务 +');
  await desc.fill('第一段\n\n第二段 ');
  await expect(desc).toBeFocused();
  expect(await page.evaluate(id => tlGetQuest(id).desc, questId)).toBe('第一段\n\n第二段 ');
  await page.locator('#tlQuestKind').selectOption('main');
  expect(await page.evaluate(id => tlGetQuest(id).kind, questId)).toBe('main');
  await expect(page.locator(`.tl-node[data-qid="${questId}"]`)).toHaveClass(/tl-node-main/);
  await expect(page.locator(`.tl-node[data-qid="${questId}"]`)).toContainText('新任务 +');
  await expect(page.locator('#editModal').getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  await expect(page.locator('#editModal').getByRole('button', { name: '取消', exact: true })).toHaveCount(0);
  await page.locator('#editModal .modal-close').click();
  await page.evaluate(async () => { if (window.StudyData) await StudyData.flush(); });
  await page.reload();
  await page.waitForFunction(() => typeof tlGetQuest === 'function' && document.querySelector('#nav-today[aria-current="page"]'));
  expect(await page.evaluate(id => tlGetQuest(id), questId)).toMatchObject({ title: '新任务 +', desc: '第一段\n\n第二段 ', kind: 'main' });
  await page.evaluate(id => tlEditQuestForm(id), questId);
  await expect(desc).toHaveValue('第一段\n\n第二段 ');
  await desc.fill('');
  expect(await page.evaluate(id => tlGetQuest(id).desc, questId)).toBe('');
  await page.locator('#editModal').getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.locator('#editModal')).not.toHaveClass(/open/);
});

test('empty titles retain the last valid title while dependencies and conditions take effect immediately', async ({ page }) => {
  const { lineId, questId } = await openQuestEditor(page);
  const prerequisite = await page.evaluate(({ lineId, questId }) => {
    const prerequisite = tlAddQuest({ lineId, title: '前置任务', status: 'active' });
    tlEditQuestForm(questId);
    return prerequisite.id;
  }, { lineId, questId });
  await page.locator('#tlQuestTitle').fill(' ');
  await page.locator('#tlQuestDesc').fill('标题暂空时的描述');
  await expect(page.locator('#tlQuestTitle')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#tlQuestSaveStatus')).toContainText('任务标题不能为空');
  expect(await page.evaluate(id => tlGetQuest(id), questId)).toMatchObject({ title: '原任务', desc: '标题暂空时的描述' });
  await page.locator('#tlDepSel').selectOption(String(prerequisite));
  await page.locator('#tlDepSel').locator('..').getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.locator(`.tl-node[data-qid="${questId}"]`)).toHaveClass(/tl-node-locked/);
  await page.locator('#tlCondType').selectOption('manual');
  await page.locator('#tlCondManualLabel').fill('完成一次练习');
  await page.locator('#tlCondType').locator('..').getByRole('button', { name: '添加', exact: true }).click();
  expect(await page.evaluate(id => tlGetQuest(id).conditions, questId)).toEqual([{ type: 'manual', label: '完成一次练习', done: false }]);
  await expect(page.locator(`.tl-node[data-qid="${questId}"]`)).toContainText('条件 0/1');
  await page.locator('#tlEditDepList').getByTitle('移除依赖').click();
  await expect(page.locator(`.tl-node[data-qid="${questId}"]`)).toHaveClass(/tl-node-active/);
  await page.locator('#tlEditCondList').getByTitle('移除条件').click();
  expect(await page.evaluate(id => tlGetQuest(id).conditions, questId)).toEqual([]);
  await page.locator('#tlQuestTitle').fill('有效新标题');
  await expect(page.locator('#tlQuestTitle')).toHaveAttribute('aria-invalid', 'false');
  expect(await page.evaluate(id => tlGetQuest(id).title, questId)).toBe('有效新标题');
});

test('failed autosaves show an error and retain persisted data until a retry succeeds', async ({ page }) => {
  const { questId } = await openQuestEditor(page);
  await page.evaluate(() => {
    window.__originalSaveData = saveData;
    saveData = (key, ...args) => key === 'study_taskline_v1' ? false : window.__originalSaveData(key, ...args);
  });
  await page.locator('#tlQuestDesc').fill('保存失败后的新描述');
  await expect(page.locator('#tlQuestSaveStatus')).toContainText('保存失败');
  expect(await page.evaluate(id => tlGetQuest(id).desc, questId)).toBe('原描述');
  await page.locator('#editModal').getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.locator('#editModal')).toHaveClass(/open/);
  await page.evaluate(() => { saveData = window.__originalSaveData; });
  await page.locator('#tlQuestDesc').press('End');
  await page.locator('#tlQuestDesc').pressSequentially('!');
  await expect(page.locator('#tlQuestSaveStatus')).toContainText('修改已保存');
  expect(await page.evaluate(id => tlGetQuest(id).desc, questId)).toBe('保存失败后的新描述!');
});

test('AI descriptions autosave and late AI responses cannot overwrite another task', async ({ page }) => {
  const { lineId, questId } = await openQuestEditor(page);
  await page.locator('#tlQuestTitle').fill('最新标题');
  await page.evaluate(() => {
    getEffectiveApiConfig = () => ({ apiKey: 'test-key' });
    callAiApi = async messages => {
      window.__questPrompt = messages.at(-1).content;
      return { cleanText: 'AI 生成的任务介绍' };
    };
  });
  await page.locator('#tlAiGenBtn').click();
  await expect(page.locator('#tlQuestDesc')).toHaveValue('AI 生成的任务介绍');
  expect(await page.evaluate(id => tlGetQuest(id).desc, questId)).toBe('AI 生成的任务介绍');
  expect(await page.evaluate(() => window.__questPrompt)).toContain('【任务标题】最新标题');
  const otherId = await page.evaluate(({ lineId, questId }) => {
    callAiApi = () => new Promise(resolve => { window.__resolveQuestAi = resolve; });
    window.__questAiPending = tlAiGenerateDesc(questId);
    const other = tlAddQuest({ lineId, title: '另一个任务', desc: '另一个任务的描述', status: 'active' });
    tlEditQuestForm(other.id);
    return other.id;
  }, { lineId, questId });
  await page.evaluate(async () => {
    window.__resolveQuestAi({ cleanText: '迟到的介绍' });
    await window.__questAiPending;
  });
  await expect(page.locator('#tlQuestDesc')).toHaveValue('另一个任务的描述');
  expect(await page.evaluate(id => tlGetQuest(id).desc, otherId)).toBe('另一个任务的描述');
  expect(await page.evaluate(id => tlGetQuest(id).desc, questId)).toBe('AI 生成的任务介绍');
});
