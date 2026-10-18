const { test, expect } = require('@playwright/test');
const path = require('node:path');

test.use({ channel: process.env.MST_TEST_BROWSER || undefined });
const source = '前文\n\n| 标题 A | 标题 B |\n| --- | --- |\n| **甲**<br>乙 | 保留 |\n| 丙 | 丁 |\n\n后文';

async function setup(page, secondary) {
  const hostId = secondary ? 'notesSplitRichEditor' : 'notesRichEditor';
  await page.setContent(`<div id="${hostId}" contenteditable="true"></div><div id="reading"></div>`);
  await page.addStyleTag({ path: path.resolve('css/workspace.css') });
  for (const file of ['lib/markdown/markdown-it.min.js', 'lib/markdown/purify.min.js', 'js/markdown.js', 'js/note-rich-editor.js']) {
    await page.addScriptTag({ path: path.resolve(file) });
  }
  await page.evaluate(({ hostId, secondary, source }) => {
    const renderer = StudyMarkdown.createRenderer({ markdownit: window.markdownit, DOMPurify });
    window.formatNoteContent = text => renderer.render(text);
    window.changes = [];
    const onChange = (markdown, previous, noteId, change) => changes.push({ markdown, previous, noteId, change });
    window.onRichNotesChange = (markdown, previous, change) => onChange(markdown, previous, 'table-test', change);
    window.editor = secondary ? createRichNoteEditor({ hostId, onChange }) : RichNoteEditor;
    editor.setMarkdown(source, 'table-test');
  }, { hostId, secondary, source });
  return page.locator(`#${hostId}`);
}

for (const secondary of [false, true]) {
  test(`${secondary ? 'split' : 'main'} table actions preserve content and serialize header changes`, async ({ page }) => {
    const host = await setup(page, secondary);
    const toolbar = page.getByRole('group', { name: '表格行列操作' });
    const act = async name => toolbar.getByRole('button', { name, exact: true }).click();
    await host.locator('td').first().click();
    await expect(toolbar).toBeVisible();
    await act('上方插入行');
    await expect(host.locator('tbody tr')).toHaveCount(3);
    await act('下方插入行');
    await expect(host.locator('tbody tr')).toHaveCount(4);
    await act('删除行');
    await expect(host.locator('tbody tr')).toHaveCount(3);
    await host.locator('td').filter({ hasText: '保留' }).click();
    await act('左侧插入列');
    await expect(host.locator('th')).toHaveCount(3);
    await act('右侧插入列');
    await expect(host.locator('th')).toHaveCount(4);
    await act('删除列');
    await expect(host.locator('th')).toHaveCount(3);
    await host.locator('th').first().click();
    await act('上方插入行');
    await expect(host.locator('thead tr')).toHaveCount(1);
    await expect(host.locator('tbody th')).toHaveCount(0);
    await expect(host.locator('tbody tr').first()).toContainText('标题 A');
    await act('删除行');
    await expect(host.locator('th').first()).toHaveText('标题 A');
    const markdown = await page.evaluate(() => editor.getMarkdown());
    expect(markdown).toContain('**甲**<br>乙');
    expect(markdown).toContain('保留');
    expect(markdown).toContain('前文');
    expect(markdown).toContain('后文');
    const changes = await page.evaluate(() => window.changes);
    expect(changes).toHaveLength(8);
    expect(changes.every(entry => entry.change.historyBoundary && entry.noteId === 'table-test')).toBe(true);
    expect(changes[0].previous).toBe(source);
    for (let i = 0; i < 2; i++) {
      await page.evaluate(markdown => {
        editor.setMarkdown(markdown, 'table-test');
        document.querySelector('#reading').innerHTML = formatNoteContent(markdown);
      }, markdown);
      expect(await page.evaluate(() => editor.getMarkdown())).toBe(markdown);
      await expect(host.locator('th')).toHaveCount(3);
      await expect(host.locator('td strong')).toHaveText('甲');
    }
    await expect(toolbar).toBeHidden();
  });
}

test('deleting a header promotes the next row; deleting the last row or column removes the table', async ({ page }) => {
  const host = await setup(page, false);
  const toolbar = page.getByRole('group', { name: '表格行列操作' });
  await host.locator('th').first().click();
  await toolbar.getByRole('button', { name: '删除行', exact: true }).click();
  await expect(host.locator('th strong')).toHaveText('甲');
  await expect(host.locator('tbody tr')).toHaveCount(1);
  await toolbar.getByRole('button', { name: '删除行', exact: true }).click();
  await expect(host.locator('tbody tr')).toHaveCount(0);
  await toolbar.getByRole('button', { name: '删除行', exact: true }).click();
  await expect(host.locator('table')).toHaveCount(0);
  await expect(toolbar).toBeHidden();
  expect(await page.evaluate(() => editor.getMarkdown())).toBe('前文\n\n后文');
  await page.evaluate(() => editor.setMarkdown('| 唯一列 |\n| --- |\n| 内容 |', 'table-test'));
  await host.locator('td').click();
  await toolbar.getByRole('button', { name: '删除列', exact: true }).click();
  await expect(host.locator('table')).toHaveCount(0);
  await page.keyboard.insertText('继续编辑');
  expect(await page.evaluate(() => editor.getMarkdown())).toBe('继续编辑');
});

test('table controls support keyboard activation and fit narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  const host = await setup(page, false);
  await host.locator('td').first().click();
  const toolbar = page.getByRole('group', { name: '表格行列操作' });
  await expect(toolbar).toBeVisible();
  const box = await toolbar.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  await toolbar.getByRole('button', { name: '下方插入行' }).focus();
  await page.keyboard.press('Enter');
  await expect(host.locator('tbody tr')).toHaveCount(3);
  await toolbar.getByRole('button', { name: '右侧插入列' }).focus();
  await page.keyboard.press('Space');
  await expect(host.locator('th')).toHaveCount(3);
  await host.locator('p').last().click();
  await expect(toolbar).toBeHidden();
});
