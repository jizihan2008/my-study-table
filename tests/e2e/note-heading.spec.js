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

test('table row and column edits support undo, view switches and durable reload', async () => {
  const initial = '| 标题 | 相邻列 |\n| --- | --- |\n| 第一行 | 保留 |';
  await setup('rich', initial);
  await page.locator('#notesRichEditor td').first().click();
  const toolbar = page.locator('.note-table-toolbar[data-editor="notesRichEditor"]');
  await toolbar.getByRole('button', { name: '下方插入行' }).click();
  await page.keyboard.insertText('新增行');
  await toolbar.getByRole('button', { name: '右侧插入列' }).click();
  const changed = await page.evaluate(() => getActiveNote().content);
  expect(changed).toContain('新增行');
  await page.evaluate(() => undoNote());
  await expect(page.locator('#notesRichEditor th')).toHaveCount(2);
  await page.evaluate(() => redoNote());
  await expect(page.locator('#notesRichEditor th')).toHaveCount(3);
  await page.evaluate(() => switchNoteView('edit'));
  await expect(page.locator('#notesTextarea')).toHaveValue(changed);
  await page.evaluate(() => switchNoteView('preview'));
  await expect(page.locator('#notesPreview th')).toHaveCount(3);
  await expect(page.locator('#notesPreview')).toContainText('新增行');
  await expect(page.locator('#notesStatus')).toHaveText('已保存');
  const noteId = await page.evaluate(async () => {
    await StudyData.flush();
    return getActiveNote().id;
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#section-today.active') && typeof escapeHtml === 'function');
  expect(await page.evaluate(id => notes.find(note => note.id === id)?.content, noteId)).toBe(changed);
});

test('multiline table survives actual source, reading and editor view switches', async () => {
  await setup('rich', '| 标题 | 相邻列 |\n| --- | --- |\n| 第一行 | 保留 |');
  await page.locator('#notesRichEditor td').first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('第二行');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('第三行');
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => switchNoteView('edit'));
    await expect(page.locator('#notesTextarea')).toHaveValue('| 标题 | 相邻列 |\n| --- | --- |\n| 第一行<br>第二行<br><br>第三行 | 保留 |');
    await page.evaluate(() => switchNoteView('preview'));
    await expect(page.locator('#notesPreview td').first().locator('br')).toHaveCount(3);
    await page.evaluate(() => switchNoteView('rich'));
    await expect(page.locator('#notesRichEditor tbody tr')).toHaveCount(1);
    await expect(page.locator('#notesRichEditor td').first().locator('br')).toHaveCount(3);
    await expect(page.locator('#notesRichEditor td').nth(1)).toHaveText('保留');
  }
});

test('retyping a cleared fold title survives source, reading and editor view switches', async () => {
  await setup('rich', ':::fold 旧标题\n保留正文\n:::');
  await page.evaluate(() => {
    const summary = document.querySelector('#notesRichEditor summary');
    summary.parentElement.open = true;
    document.getElementById('notesRichEditor').focus();
    const range = document.createRange(); range.selectNodeContents(summary);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('分析');
  await expect(page.locator('#notesRichEditor summary')).toHaveText('分析');
  await page.evaluate(() => switchNoteView('edit'));
  await expect(page.locator('#notesTextarea')).toHaveValue(':::fold 分析\n保留正文\n:::');
  await page.evaluate(() => switchNoteView('preview'));
  await expect(page.locator('#notesPreview summary')).toHaveText('分析');
  await page.evaluate(() => switchNoteView('rich'));
  await expect(page.locator('#notesRichEditor summary')).toHaveText('分析');
  await expect(page.locator('#notesRichEditor .note-fold-body')).toHaveText('保留正文');
});

for (const mode of ['rich', 'preview']) {
  test(`${mode} TOC lists fold titles at the final level and reveals nested targets`, async () => {
    const content = ['# 章节', '', '###### 最深标题', '',
      ...Array.from({ length: 70 }, (_, index) => '正文段落 ' + index + '\n'),
      ':::fold **外层标题**', '外层正文', '', ':::fold 内层标题', '内部正文', ':::', ':::', '',
      ':::fold 外层标题', '第二块正文', ':::'].join('\n');
    await setup(mode, content);
    await page.evaluate(() => toggleNoteToc(true));
    const items = page.locator('#notesTocList .notes-toc-item');
    await expect(items).toHaveText(['章节', '最深标题', '外层标题', '内层标题', '外层标题']);
    const indents = await items.evaluateAll(items => items.map(item => item.style.getPropertyValue('--toc-indent')));
    expect(indents).toEqual(['0px', '60px', '72px', '72px', '72px']);
    const targets = await items.evaluateAll(items => items.map(item => item.dataset.target));
    expect(new Set(targets).size).toBe(5);
    if (mode === 'preview') {
      expect(await page.locator('#notesPreview').getAttribute('data-reading-virtual')).toBe('true');
      await expect(page.locator('#notesPreview summary').filter({ hasText: '内层标题' })).toHaveCount(0);
    }
    await items.nth(3).click();
    const host = page.locator(mode === 'rich' ? '#notesRichEditor' : '#notesPreview');
    await expect(host.locator('summary').filter({ hasText: '内层标题' })).toBeVisible();
    expect(await host.locator('summary').filter({ hasText: '内层标题' }).evaluate(summary => {
      return summary.parentElement.open && summary.parentElement.parentElement.closest('details').open;
    })).toBe(true);
    await expect(items.nth(3)).toHaveAttribute('aria-current', 'location');
    expect(await page.evaluate(() => getActiveNote().content)).toBe(content);
    if (mode === 'rich') expect(await page.evaluate(() => RichNoteEditor.getMarkdown())).toBe(content);
    await setup(mode, ':::fold 独立折叠块\n正文\n:::');
    await expect(items).toHaveText(['独立折叠块']);
    expect(await items.first().evaluate(item => item.style.getPropertyValue('--toc-indent'))).toBe('0px');
  });
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
