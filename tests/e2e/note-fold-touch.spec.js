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
  for (const delayedClick of ['zero-detail', 'shifted-coordinates']) {
    test(`${secondary ? 'split' : 'main'} arrow consumes ${delayedClick} compatibility click without moving caret`, async ({ page }) => {
      await setup(page, secondary);
      const result = await page.evaluate(delayedClick => {
        const title = document.querySelector('summary');
        const fold = title.parentElement;
        fold.open = false;
        const rect = title.getBoundingClientRect();
        const init = { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 7,
          clientX: rect.left + 12, clientY: rect.top + rect.height / 2 };
        title.dispatchEvent(new PointerEvent('pointerdown', init));
        title.dispatchEvent(new PointerEvent('pointerup', init));
        const openedOnRelease = fold.open;
        const mouseDown = new MouseEvent('mousedown', { ...init, clientX: rect.right - 5 });
        title.dispatchEvent(mouseDown);
        const click = new MouseEvent('click', { ...init,
          detail: delayedClick === 'zero-detail' ? 0 : 1,
          clientX: delayedClick === 'zero-detail' ? init.clientX : rect.right - 5 });
        title.dispatchEvent(click);
        return { openedOnRelease, openAfterClick: fold.open, clickPrevented: click.defaultPrevented,
          mouseDownPrevented: mouseDown.defaultPrevented,
          caretInOriginalParagraph: document.querySelector('[contenteditable] > p').contains(getSelection().anchorNode) };
      }, delayedClick);
      expect(result).toEqual({ openedOnRelease: true, openAfterClick: true,
        clickPrevented: true, mouseDownPrevented: true, caretInOriginalParagraph: true });
      await page.keyboard.insertText('继续');
      await expect(page.locator('[contenteditable] > p')).toHaveText('前一继续段文字');
      await expect(page.locator('summary')).toHaveText('标题后缀');
    });
  }

  test(`${secondary ? 'split' : 'main'} arrow touchstart prevents native text selection`, async ({ page }) => {
    await setup(page, secondary);
    expect(await page.evaluate(() => {
      const title = document.querySelector('summary');
      const rect = title.getBoundingClientRect();
      const event = new Event('touchstart', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: [{ clientX: rect.left + 12, clientY: rect.top + rect.height / 2 }] });
      title.dispatchEvent(event);
      return event.defaultPrevented;
    })).toBe(true);
  });

  test(`${secondary ? 'split' : 'main'} repeated native arrow taps keep the editing caret outside the fold`, async ({ page }) => {
    await setup(page, secondary);
    const title = page.locator('summary');
    for (const open of [false, true, false, true]) {
      const rect = await title.boundingBox();
      await page.touchscreen.tap(rect.x + 12, rect.y + rect.height / 2);
      expect(await page.locator('details').evaluate(el => el.open)).toBe(open);
      expect(await page.evaluate(() => document.querySelector('[contenteditable] > p').contains(getSelection().anchorNode))).toBe(true);
    }
    await page.keyboard.insertText('继续');
    await expect(page.locator('[contenteditable] > p')).toHaveText('前一继续段文字');
    await expect(title).toHaveText('标题后缀');
    // A later mouse gesture must not be swallowed as a delayed touch click.
    const rect = await title.boundingBox();
    await page.mouse.click(rect.x + 12, rect.y + rect.height / 2);
    await expect(page.locator('details')).not.toHaveAttribute('open', '');
    // Accessibility activation has no pointer sequence and uses detail=0.
    await title.evaluate(el => el.click());
    await expect(page.locator('details')).toHaveAttribute('open', '');
  });

  test(`${secondary ? 'split' : 'main'} cancelled or dragged arrow gestures do not toggle`, async ({ page }) => {
    await setup(page, secondary);
    for (const ending of ['pointercancel', 'pointerup']) {
      const result = await page.evaluate(ending => {
        const title = document.querySelector('summary');
        const rect = title.getBoundingClientRect();
        const init = { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 11,
          clientX: rect.left + 12, clientY: rect.top + rect.height / 2 };
        title.dispatchEvent(new PointerEvent('pointerdown', init));
        title.dispatchEvent(new PointerEvent(ending, { ...init, clientY: init.clientY + 40 }));
        title.dispatchEvent(new MouseEvent('click', { ...init, detail: 0 }));
        return title.parentElement.open;
      }, ending);
      expect(result).toBe(true);
    }
  });

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
