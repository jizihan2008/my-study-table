const { test, expect } = require('@playwright/test');
const path = require('node:path');

test.use({ browserName: process.env.MST_TEST_BROWSER ? 'chromium' : 'webkit',
  channel: process.env.MST_TEST_BROWSER || undefined,
  hasTouch: true, viewport: { width: 820, height: 600 } });

async function setup(page, secondary) {
  const hostId = secondary ? 'notesSplitRichEditor' : 'notesRichEditor';
  await page.setContent(`<div id="${hostId}" class="notes-rich-editor active" contenteditable="true"><p>前一段文字</p><details class="note-fold" open><summary>标题后缀</summary><div class="note-fold-body"><p>原正文</p></div></details></div>`);
  await page.addStyleTag({ path: path.resolve('css/style.css') });
  await page.addScriptTag({ path: path.resolve('js/note-rich-editor.js') });
  await page.evaluate(({ hostId, secondary }) => {
    window.editor = secondary ? createRichNoteEditor({ hostId }) : RichNoteEditor;
    editor.init();
    document.getElementById(hostId).focus();
    const range = document.createRange();
    range.setStart(document.querySelector('[contenteditable] > p').firstChild, 2);
    range.collapse(true);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  }, { hostId, secondary });
}

for (const secondary of [false, true]) {
  test(`${secondary ? 'split' : 'main'} touch title preserves native caret after keyboard viewport movement`, async ({ page }) => {
    await setup(page, secondary);
    // Model native touch placement followed by a click whose coordinates now
    // resolve elsewhere after the keyboard scrolls the viewport.
    await page.evaluate(() => {
      const title = document.querySelector('summary');
      const rect = title.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, pointerType: 'touch',
        clientX: rect.right - 5, clientY: rect.top + rect.height / 2, detail: 1 };
      title.dispatchEvent(new PointerEvent('pointerdown', init));
      const range = document.createRange(); range.setStart(title.firstChild, 2); range.collapse(true);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      window.hitTests = 0;
      document.caretPositionFromPoint = () => { window.hitTests++; return null; };
      document.caretRangeFromPoint = () => { window.hitTests++; return null; };
      // Safari versions emitting a MouseEvent for click must use pointerdown's type.
      title.dispatchEvent(new MouseEvent('click', init));
    });
    expect(await page.evaluate(() => window.hitTests)).toBe(0);
    await page.keyboard.insertText('插入');
    await expect(page.locator('summary')).toHaveText('标题插入后缀');
    await expect(page.locator('details')).toHaveAttribute('open', '');
    expect(await page.evaluate(() => editor.getMarkdown())).toContain(':::fold 标题插入后缀\n原正文\n:::');
  });

  test(`${secondary ? 'split' : 'main'} native tap edits title and marker still toggles`, async ({ page }) => {
    await setup(page, secondary);
    const title = page.locator('summary');
    const point = await title.evaluate(el => {
      const range = document.createRange(); range.setStart(el.firstChild, 2); range.setEnd(el.firstChild, 3);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 1, y: rect.top + rect.height / 2 };
    });
    await page.touchscreen.tap(point.x, point.y);
    expect(await page.evaluate(() => document.querySelector('summary').contains(getSelection().anchorNode))).toBe(true);
    await page.keyboard.insertText('新');
    await expect(title).toContainText('新');
    await expect(page.locator('.note-fold-body')).toHaveText('原正文');
    const rect = await title.boundingBox();
    await page.touchscreen.tap(rect.x + 12, rect.y + rect.height / 2);
    await expect(page.locator('details')).not.toHaveAttribute('open', '');
  });
}
