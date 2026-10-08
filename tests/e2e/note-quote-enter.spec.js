const { test, expect } = require('@playwright/test');
const path = require('node:path');
test.use({ channel: process.env.MST_TEST_BROWSER || undefined });

for (const scenario of [
  { name: 'middle', html: '<blockquote><p>前文后文</p></blockquote><p>外部正文</p>', offset: 2 },
  { name: 'end', html: '<blockquote><p>前文</p></blockquote><p>外部正文</p>', offset: 2 },
  { name: 'formatted text', html: '<blockquote><p><strong>前文后文</strong></p></blockquote><p>外部正文</p>', offset: 2, selector: 'strong' },
  { name: 'direct text', html: '<blockquote>前文后文</blockquote><p>外部正文</p>', offset: 2, selector: 'blockquote' },
  { name: 'nested secondary quote', html: '<blockquote><blockquote><p>前文后文</p></blockquote></blockquote><p>外部正文</p>', offset: 2, secondary: true },
  { name: 'beforeinput', html: '<blockquote><p>前文后文</p></blockquote><p>外部正文</p>', offset: 2, beforeinput: true }
]) {
  test(`Enter adds a line inside the same quote at ${scenario.name}`, async ({ page }) => {
    const hostId = scenario.secondary ? 'notesSplitRichEditor' : 'notesRichEditor';
    await page.setContent(`<div id="${hostId}" contenteditable="true">${scenario.html}</div>`);
    await page.addScriptTag({ path: path.resolve('lib/markdown/markdown-it.min.js') });
    await page.addScriptTag({ path: path.resolve('lib/markdown/purify.min.js') });
    await page.addScriptTag({ path: path.resolve('js/markdown.js') });
    await page.addScriptTag({ path: path.resolve('js/note-rich-editor.js') });
    await page.evaluate(({ hostId, scenario }) => {
      window.formatNoteContent = value => StudyMarkdown.render(value);
      window.testEditor = scenario.secondary ? createRichNoteEditor({ hostId }) : RichNoteEditor;
      testEditor.init();
      const host = document.getElementById(hostId);
      host.focus();
      const range = document.createRange();
      range.setStart(host.querySelector(scenario.selector || 'blockquote p').firstChild, scenario.offset);
      range.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }, { hostId, scenario });
    if (scenario.beforeinput) await page.evaluate(() => document.activeElement.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'insertParagraph', bubbles: true, cancelable: true
    })));
    else await page.keyboard.press('Enter');
    await page.keyboard.insertText('新行');
    await expect(page.locator(`#${hostId} > blockquote`)).toHaveCount(1);
    await expect(page.locator(`#${hostId} blockquote`)).toHaveCount(scenario.secondary ? 2 : 1);
    await expect(page.locator(`#${hostId} > p`)).toHaveText('外部正文');
    const markdown = await page.evaluate(() => testEditor.getMarkdown());
    expect(markdown.replace(/\*\*/g, '')).toContain((scenario.secondary ? '> > ' : '> ') + '前文\n' + (scenario.secondary ? '> > ' : '> ') + '新行');
    if (scenario.selector === 'strong') await expect(page.locator(`#${hostId} strong`)).toContainText('后文');
    await page.evaluate(markdown => testEditor.setMarkdown(markdown, 'quote-enter'), markdown);
    await expect(page.locator(`#${hostId} > blockquote`)).toHaveCount(1);
    await expect(page.locator(`#${hostId} blockquote br`)).toHaveCount(1);
    if (scenario.selector === 'strong') await expect(page.locator(`#${hostId} strong`)).toHaveText(/前文\s*新行后文/);
  });
}

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
