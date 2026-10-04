const { test, expect } = require('@playwright/test');
const path = require('node:path');
test.use({ channel: process.env.MST_TEST_BROWSER || undefined });

async function setup(page, secondary = false) {
  const hostId = secondary ? 'notesSplitRichEditor' : 'notesRichEditor';
  await page.setContent(`<div id="${hostId}" contenteditable="true"><details class="note-fold" open><summary>标题后缀</summary><div class="note-fold-body"><p>原正文</p></div></details></div>`);
  await page.addScriptTag({ path: path.resolve('lib/markdown/purify.min.js') });
  await page.addScriptTag({ path: path.resolve('js/note-rich-editor.js') });
  await page.evaluate(({ hostId, secondary }) => {
    window.editor = secondary ? createRichNoteEditor({ hostId }) : RichNoteEditor;
    editor.init();
    document.getElementById(hostId).focus();
    const range = document.createRange();
    range.setStart(document.querySelector('summary').firstChild, 2);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, { hostId, secondary });
}

for (const secondary of [false, true]) {
  test(`paste stays inside ${secondary ? 'secondary' : 'primary'} fold title`, async ({ page }) => {
    await setup(page, secondary);
    await page.evaluate(() => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/html', '<p><strong>粗体</strong></p><ul><li>第一项</li><li>第二项</li></ul>');
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
    await expect(page.locator('summary strong')).toHaveText('粗体');
    await expect(page.locator('summary')).toContainText('第一项');
    await expect(page.locator('summary')).toContainText('第二项');
    await expect(page.locator('summary p, summary ul, summary li')).toHaveCount(0);
    await expect(page.locator('.note-fold-body')).toHaveText('原正文');
    await page.keyboard.insertText('继续');
    await expect(page.locator('summary')).toContainText('继续后缀');
    const markdown = await page.evaluate(() => editor.getMarkdown());
    expect(markdown.split('\n')[0]).toContain('粗体');
    expect(markdown).toContain('\n原正文\n:::');
  });
}

test('multiline plain text paste replaces the title selection in place', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('summary'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '第一行\n第二行');
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('summary')).toHaveText('第一行 第二行');
  await expect(page.locator('.note-fold-body')).toHaveText('原正文');
});

for (const input of ['Enter', 'beforeinput']) {
  test(`${input} in fold title creates the first body paragraph`, async ({ page }) => {
    await setup(page);
    await page.locator('details').evaluate(fold => { fold.open = false; });
    if (input === 'Enter') await page.keyboard.press('Enter');
    else await page.evaluate(() => document.activeElement.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'insertParagraph', bubbles: true, cancelable: true
    })));
    await expect(page.locator('summary')).toHaveText('标题后缀');
    await expect(page.locator('details')).toHaveAttribute('open', '');
    await expect(page.locator('.note-fold-body > p')).toHaveCount(2);
    await page.keyboard.insertText('新首行');
    await expect(page.locator('.note-fold-body > p')).toHaveText(['新首行', '原正文']);
    expect(await page.evaluate(() => editor.getMarkdown())).toContain(':::fold 标题后缀\n新首行\n\n原正文\n:::');
  });
}
