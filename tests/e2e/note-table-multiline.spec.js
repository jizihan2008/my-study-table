const { test, expect } = require('@playwright/test');
const path = require('node:path');

test.use({ channel: process.env.MST_TEST_BROWSER || undefined });

async function setup(page, secondary) {
  const hostId = secondary ? 'notesSplitRichEditor' : 'notesRichEditor';
  await page.setContent(`<div id="${hostId}" contenteditable="true"></div><div id="reading"></div>`);
  for (const file of ['lib/markdown/markdown-it.min.js', 'lib/markdown/purify.min.js', 'js/markdown.js', 'js/note-rich-editor.js']) {
    await page.addScriptTag({ path: path.resolve(file) });
  }
  await page.evaluate(({ hostId, secondary }) => {
    const renderer = StudyMarkdown.createRenderer({ markdownit: window.markdownit, DOMPurify });
    window.formatNoteContent = source => renderer.render(source);
    window.editor = secondary ? createRichNoteEditor({ hostId }) : RichNoteEditor;
    editor.setMarkdown('| 标题 | 相邻列 |\n| --- | --- |\n| 第一行 | 保留 |', 'table-test');
  }, { hostId, secondary });
}

for (const secondary of [false, true]) {
  test(`Enter and Shift+Enter in ${secondary ? 'split' : 'main'} table survive repeated source and reading round trips`, async ({ page }) => {
    await setup(page, secondary);
    await page.locator('td').first().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('第二行');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('第三行');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.insertText('第四行');
    for (let i = 0; i < 3; i++) {
      const source = await page.evaluate(() => editor.getMarkdown());
      expect(source.split('\n')).toHaveLength(3);
      expect(source).toContain('第一行<br>第二行<br><br>第三行<br>第四行');
      await page.evaluate(source => {
        document.querySelector('#reading').innerHTML = formatNoteContent(source);
        editor.setMarkdown(source, 'table-test');
      }, source);
      await expect(page.locator('#reading tbody tr')).toHaveCount(1);
      await expect(page.locator('#reading td').first()).toContainText('第四行');
      await expect(page.locator('[contenteditable] td').nth(1)).toHaveText('保留');
      await expect(page.locator('[contenteditable] td').first().locator('br')).toHaveCount(4);
    }
  });
}

test('native block and BR cell shapes preserve blank lines and formatting', async ({ page }) => {
  await setup(page, false);
  for (const html of [
    '第一行<div><strong>第二行</strong></div><div><br></div><div>第三行</div>',
    '<p>第一行</p><p><strong>第二行</strong></p><p><br></p><p>第三行</p>',
    '第一行<br><strong>第二行</strong><br><br>第三行'
  ]) {
    await page.evaluate(html => document.querySelector('td').innerHTML = html, html);
    const source = await page.evaluate(() => editor.getMarkdown());
    expect(source).toContain('第一行<br>**第二行**<br><br>第三行');
    await page.evaluate(source => editor.setMarkdown(source, 'table-test'), source);
    await expect(page.locator('td strong')).toHaveText('第二行');
    await expect(page.locator('td').first().locator('br')).toHaveCount(3);
  }
});
