'use strict';
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let app, page, userDataPath;

test.beforeAll(async () => {
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-headings-'));
  app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
  page = await app.firstWindow();
  await page.waitForFunction(() => document.readyState !== 'loading' && typeof RichNoteEditor !== 'undefined');
  await page.waitForFunction(() => document.querySelector('#section-today.active'));
});

test.afterAll(async () => {
  if (app) await app.close();
  if (userDataPath) await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function setup(mode, content = '标题 **重点**\n\n后续正文') {
  await page.evaluate(({ mode, content }) => {
    switchTab('notes');
    setNotesImmersiveSplit(false);
    setNotesImmersive(false);
    const note = getActiveNote();
    note.content = content;
    note._dirtyContent = false;
    renderNotes();
    switchNoteView(mode);
  }, { mode, content });
}

async function choose(level) {
  await page.locator('#notesHeadingButton').click();
  await page.locator(`#notesHeadingMenu [data-heading="${level}"]`).click();
  await expect(page.locator('#notesHeadingMenu')).not.toBeVisible();
}

async function selectRich(hostId = 'notesRichEditor') {
  await page.evaluate(hostId => {
    const host = document.getElementById(hostId);
    host.focus();
    const range = document.createRange();
    range.selectNodeContents(host.firstElementChild);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, hostId);
}

test('heading menu switches all six levels and restores body text without losing formatting', async () => {
  await setup('rich');
  for (let level = 1; level <= 6; level++) {
    await selectRich();
    await choose(level);
    await expect(page.locator(`#notesRichEditor > h${level}`)).toHaveText('标题 重点');
    await expect(page.locator(`#notesRichEditor > h${level} strong`)).toHaveText('重点');
    expect(await page.evaluate(() => RichNoteEditor.getMarkdown())).toBe('#'.repeat(level) + ' 标题 **重点**\n\n后续正文');
  }
  await selectRich();
  await choose(0);
  await expect(page.locator('#notesRichEditor > p').first()).toHaveText('标题 重点');
  await expect(page.locator('#notesRichEditor > p').last()).toHaveText('后续正文');
  await expect(page.locator('#notesRichEditor').locator('h1,h2,h3,h4,h5,h6')).toHaveCount(0);
});

test('source heading menu changes entire selected lines and replaces existing markers', async () => {
  await setup('edit', '## 一级内容\n### 二级内容\n\n后续正文');
  for (let level = 1; level <= 6; level++) {
    await page.locator('#notesTextarea').evaluate(textarea => {
      textarea.focus();
      textarea.setSelectionRange(0, textarea.value.indexOf('\n\n'));
    });
    await choose(level);
    const prefix = '#'.repeat(level) + ' ';
    await expect(page.locator('#notesTextarea')).toHaveValue(prefix + '一级内容\n' + prefix + '二级内容\n\n后续正文');
  }
  await choose(0);
  await expect(page.locator('#notesTextarea')).toHaveValue('一级内容\n二级内容\n\n后续正文');
  await page.locator('#notesTextarea').evaluate(textarea => { textarea.focus(); textarea.setSelectionRange(2, 2); });
  await choose(3);
  await expect(page.locator('#notesTextarea')).toHaveValue('### 一级内容\n二级内容\n\n后续正文');
  expect(await page.locator('#notesTextarea').evaluate(textarea => textarea.selectionStart)).toBe(6);
});

test('keyboard heading menu preserves selection and supports Escape', async () => {
  await setup('rich', '键盘标题\n\n正文');
  await selectRich();
  await page.locator('#notesHeadingButton').focus();
  await page.keyboard.press('Enter');
  await page.screenshot({ path: path.resolve('test-results/note-heading-menu.png') });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#notesRichEditor h2')).toHaveText('键盘标题');
  await page.locator('#notesHeadingButton').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#notesHeadingMenu')).not.toBeVisible();
  await expect(page.locator('#notesRichEditor h2')).toHaveText('键盘标题');
});

test('shared heading menu formats the secondary split editor', async () => {
  await setup('rich', '主栏正文');
  await page.evaluate(() => {
    notes.push({ id: 'heading-secondary', type: 'note', title: '副栏', content: '副栏标题', updatedAt: new Date().toISOString() });
    setNotesImmersive(true);
    setNotesImmersiveSplit(true);
    selectNotesSplitNote('heading-secondary');
    setNotesSplitSecondaryMode('rich');
  });
  await selectRich('notesSplitRichEditor');
  await page.mouse.move(400, 2);
  await expect(page.locator('#section-notes')).toHaveClass(/show-top-controls/);
  await choose(4);
  await expect(page.locator('#notesSplitRichEditor h4')).toHaveText('副栏标题');
  await expect(page.locator('#notesRichEditor')).toHaveText('主栏正文');
});
