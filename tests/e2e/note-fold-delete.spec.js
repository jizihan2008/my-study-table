const { test, expect } = require('@playwright/test');
const path = require('node:path');
test.use({ channel: process.env.MST_TEST_BROWSER || undefined });

async function setup(page, secondary, firstOpen = false) {
  const hostId = secondary ? 'notesSplitRichEditor' : 'notesRichEditor';
  await page.setContent('<div id="' + hostId + '" contenteditable="true">'
    + '<details class="note-fold"' + (firstOpen ? ' open' : '') + '><summary>第一块</summary><div class="note-fold-body"><p><strong>第一正文</strong></p><ul><li>项目</li></ul></div></details>'
    + '<p id="gap"><br></p><details class="note-fold"><summary>第二块</summary><div class="note-fold-body"><p>第二正文</p></div></details></div>');
  await page.addScriptTag({ path: path.resolve('lib/markdown/markdown-it.min.js') });
  await page.addScriptTag({ path: path.resolve('lib/markdown/purify.min.js') });
  await page.addScriptTag({ path: path.resolve('js/markdown.js') });
  await page.addScriptTag({ path: path.resolve('js/note-rich-editor.js') });
  await page.evaluate(({ hostId, secondary }) => {
    window.formatNoteContent = value => StudyMarkdown.render(value);
    window.changes = [];
    window.onRichNotesChange = markdown => changes.push(markdown);
    window.editor = secondary ? createRichNoteEditor({ hostId, onChange: markdown => changes.push(markdown) }) : RichNoteEditor;
    editor.init();
    document.getElementById(hostId).focus();
    const range = document.createRange();
    range.setStart(document.getElementById('gap'), 0);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, { hostId, secondary });
}

for (const secondary of [false, true]) {
  for (const backward of [true, false]) {
    for (const input of ['keyboard', 'beforeinput']) {
      test((secondary ? 'split' : 'primary') + ' empty line ' + (backward ? 'Backspace' : 'Delete') + ' via ' + input + ' preserves closed folds', async ({ page }) => {
        await setup(page, secondary);
        const before = await page.locator('details').evaluateAll(folds => folds.map(fold => fold.outerHTML));
        if (input === 'keyboard') await page.keyboard.press(backward ? 'Backspace' : 'Delete');
        else await page.evaluate(backward => document.activeElement.dispatchEvent(new InputEvent('beforeinput', {
          inputType: backward ? 'deleteContentBackward' : 'deleteContentForward', bubbles: true, cancelable: true
        })), backward);
        await expect(page.locator('#gap')).toHaveCount(0);
        expect(await page.locator('details').evaluateAll(folds => folds.map(fold => fold.outerHTML))).toEqual(before);
        expect(await page.evaluate(() => changes.length)).toBe(1);
        expect(await page.evaluate(() => getSelection().anchorNode.parentElement.closest('summary')?.textContent || getSelection().anchorNode.textContent)).toBe(backward ? '第一块' : '第二块');
        // Click the disclosure markers, then round-trip through the same
        // Markdown rendering path used when switching source/rich modes.
        for (const fold of await page.locator('details').all()) {
          await fold.locator('summary').click({ position: { x: 2, y: 8 } });
          await expect(fold).toHaveAttribute('open', '');
        }
        await expect(page.locator('.note-fold-body')).toHaveText(['第一正文项目', '第二正文']);
        const markdown = await page.evaluate(() => editor.getMarkdown());
        expect(markdown).toContain('**第一正文**');
        expect(markdown).toContain('- 项目');
        expect(markdown).toContain('第二正文');
        await page.evaluate(markdown => editor.setMarkdown(markdown, 'test'), markdown);
        await expect(page.locator('details')).toHaveCount(2);
        await expect(page.locator('.note-fold-body strong')).toHaveText('第一正文');
        await expect(page.locator('.note-fold-body li')).toHaveText('项目');
        await expect(page.locator('.note-fold-body').last().locator('p')).toHaveText('第二正文');
        expect(await page.evaluate(() => editor.getMarkdown())).toBe(markdown);
      });
    }
  }
}

test('ordinary empty paragraph Backspace still merges into preceding text', async ({ page }) => {
  await setup(page, false);
  await page.evaluate(() => document.querySelector('details').outerHTML = '<p>普通正文</p>');
  await page.keyboard.press('Backspace');
  await expect(page.locator('#gap')).toHaveCount(0);
  await expect(page.locator('#notesRichEditor > p')).toHaveText('普通正文');
  await expect(page.locator('.note-fold-body')).toHaveText('第二正文');
});
