'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test.use({ channel: 'chrome', viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });

test('the next steps card moves with edits and replacements on its own branch', async ({ page }) => {
  const root = path.resolve(__dirname, '../..');
  const requests = [];
  let reply = '';
  const withCard = (text, update) => text + '\n<study_next_steps>\n' + JSON.stringify(update) + '\n</study_next_steps>';
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'study-table.test') return route.abort();
    if (url.pathname === '/mock/v1/chat/completions') {
      requests.push(route.request().postDataJSON());
      return route.fulfill({ json: { choices: [{ message: { content: reply }, finish_reason: 'stop' }] } });
    }
    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404 });
    return route.fulfill({ path: file });
  });
  await page.goto('http://study-table.test/');
  await page.waitForSelector('#section-today.active');
  await page.evaluate(async () => {
    await saveApiKeys([{ id: 'local', name: '测试', key: 'fake', model: 'test-model', baseUrl: 'http://study-table.test/mock/v1' }], { sync: false });
    localStorage.setItem('study_active_api_key_id', 'local');
    isAutoTitleEnabled = () => false;
    switchTab('ai');
    createNewConv();
  });

  const input = page.locator('#aiInput');
  const card = page.locator('.ai-next-steps');
  const owner = card.locator('..').locator('.ai-chat-bubble');
  const run = card.getByRole('button', { name: /执行所选/ });
  const send = async text => {
    await input.fill(text);
    await page.evaluate(() => sendAiMessage());
  };

  reply = withCard('第一条回复', { op: 'create', items: [
    { id: 'outline', text: '生成提纲' },
    { id: 'quiz', text: '出五道题' },
    { id: 'todo', text: '安排明晚八点的复习待办' }
  ] });
  await send('下一步怎么学？');
  await expect(card).toHaveCount(1);
  await expect(owner).toContainText('第一条回复');
  await expect(run).toBeDisabled();
  expect(await page.evaluate(() => sanitizeAiStreamingText('正文\n<study_next_steps>\n{"op":'))).toBe('正文');
  const id = await page.evaluate(() => getAiNextStepsMessage(getActiveConv().messages)._nextSteps.id);
  await card.getByLabel('生成提纲').check();
  await card.getByLabel('出五道题').check();

  reply = withCard('第二条回复', { op: 'edit', id, items: [{ id: 'quiz', text: '出三道计算题' }] });
  await send('改一下自测题');
  await expect(card).toHaveCount(1);
  await expect(owner).toContainText('第二条回复');
  await expect(card.getByLabel('生成提纲')).toBeChecked();
  await expect(card.getByLabel('出三道计算题')).not.toBeChecked();
  expect(requests[1].messages.some(message => message.role === 'system' && message.content.includes(id))).toBe(true);

  await input.fill('保留我的草稿');
  await card.getByLabel('出三道计算题').check();
  reply = '第三条回复，卡片保持原样';
  await run.click();
  await expect(page.locator('#aiMessages')).toContainText(reply);
  await expect(owner).toContainText('第二条回复');
  await expect(input).toHaveValue('保留我的草稿');
  expect(requests[2].messages.at(-1).content).toContain('1. 生成提纲\n2. 出三道计算题');
  expect(requests[2].messages.at(-1).content).not.toContain('安排明晚');
  expect(requests[2].messages.at(-1).content).not.toContain('保留我的草稿');

  reply = withCard('第三条回复的新候选', { op: 'replace', id, items: [{ id: 'summary', text: '整理错题' }] });
  await page.getByRole('button', { name: '换一条' }).last().click();
  await expect(owner).toContainText('第三条回复的新候选');
  await expect(card.getByLabel('整理错题')).not.toBeChecked();
  await expect(card.getByLabel('生成提纲')).toHaveCount(0);
  await page.locator('.ai-exchange-footer .ai-msg-cand-nav').first().click();
  await expect(owner).toContainText('第二条回复');
  await expect(card.getByLabel('生成提纲')).toBeVisible();
  await expect(page.locator('#aiMessages')).not.toContainText('study_next_steps');
  const convId = await page.evaluate(() => getActiveConvId());
  await page.reload();
  await page.waitForSelector('#section-today.active');
  await page.evaluate(convId => {
    switchTab('ai');
    switchConv(convId);
  }, convId);
  await expect(owner).toContainText('第二条回复');
  await expect(card.getByLabel('出三道计算题')).toBeVisible();
});
