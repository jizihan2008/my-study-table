const { test, expect } = require('@playwright/test');
const path = require('node:path');
test.use({ channel: process.env.MST_TEST_BROWSER || undefined });

for (const scenario of [
  { name: 'middle of quote', html: '<blockquote><p>XXX文字块</p></blockquote><p>后文</p>', offset: 2 },
  { name: 'end of quote', html: '<blockquote><p>XXX文字块</p></blockquote>', offset: 6 },
  { name: 'nested quote in secondary editor', html: '<blockquote><blockquote><p>XXX文字块</p></blockquote></blockquote><p>后文</p>', offset: 2, secondary: true }
]) {
  test(`Ctrl+Enter exits ${scenario.name}`, async ({ page }) => {
    const hostId = scenario.secondary ? 'notesSplitRichEditor' : 'notesRichEditor';
    await page.setContent(`<div id="${hostId}" contenteditable="true">${scenario.html}</div>`);
    await page.addScriptTag({ path: path.resolve('js/note-rich-editor.js') });
    await page.evaluate(({ hostId, offset, secondary }) => {
      const editor = secondary ? createRichNoteEditor({ hostId }) : RichNoteEditor;
      editor.init();
      window.testEditor = editor;
      const host = document.getElementById(hostId);
      host.focus();
      const range = document.createRange();
      range.setStart(host.querySelector('blockquote p').firstChild, offset);
      range.collapse(true);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    }, { hostId, offset: scenario.offset, secondary: scenario.secondary });
    await page.keyboard.press('Control+Enter');
    const position = await page.evaluate(() => {
      const node = getSelection().anchorNode;
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      return { inQuote: !!element.closest('blockquote'), tag: element.tagName };
    });
    expect(position).toEqual({ inQuote: false, tag: 'P' });
    await page.keyboard.insertText('新行');
    await expect(page.locator(`#${hostId} > blockquote`)).toHaveText('XXX文字块');
    await expect(page.locator(`#${hostId} > blockquote + p`)).toHaveText('新行');
    expect(await page.evaluate(() => testEditor.getMarkdown())).toContain('\n\n新行');
    if (scenario.html.includes('后文')) await expect(page.locator(`#${hostId} > p`).last()).toHaveText('后文');
  });
}
