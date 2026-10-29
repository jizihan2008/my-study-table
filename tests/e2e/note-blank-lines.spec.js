const { test, expect } = require('@playwright/test');
const path = require('node:path');

test.use({ channel: process.env.MST_TEST_BROWSER || undefined });

async function setup(page, secondary = false) {
  const id = secondary ? 'notesSplitRichEditor' : 'notesRichEditor';
  await page.setContent(`<div id="${id}" contenteditable="true"></div>`);
  for (const file of ['lib/markdown/markdown-it.min.js', 'lib/markdown/purify.min.js', 'js/markdown.js', 'js/note-rich-editor.js']) {
    await page.addScriptTag({ path: path.resolve(file) });
  }
  await page.evaluate(({ id, secondary }) => {
    window.formatNoteContent = source => StudyMarkdown.render(source);
    window.editor = secondary ? createRichNoteEditor({ hostId: id }) : RichNoteEditor;
    editor.init();
    editor.setMarkdown('前文', 'blank-test');
  }, { id, secondary });
  return page.locator(`#${id}`);
}

for (const secondary of [false, true]) {
  test(`${secondary ? 'split' : 'primary'} keeps typed blank lines through source and reading round trips`, async ({ page }) => {
    const host = await setup(page, secondary);
    await host.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('后文');
    const markdown = await page.evaluate(() => editor.getMarkdown());
    expect(markdown).toBe('前文\n\n<br>\n\n<br>\n\n后文');
    for (let round = 0; round < 3; round++) {
      await page.evaluate(markdown => editor.setMarkdown(markdown, 'blank-test'), markdown);
      await expect(host.locator(':scope > p')).toHaveCount(4);
      await expect(host.locator(':scope > p > br')).toHaveCount(2);
      expect(await page.evaluate(() => editor.getMarkdown())).toBe(markdown);
    }
    const reading = await page.evaluate(markdown => {
      const plan = StudyMarkdown.createReadingPlan(markdown);
      return plan.blocks.map((_, index) => plan.renderBlock(index)).join('');
    }, markdown);
    expect((reading.match(/<br>/g) || []).length).toBe(2);
  });
}

test('leading, trailing and nested blank paragraphs survive serialization', async ({ page }) => {
  const host = await setup(page);
  await host.evaluate(host => {
    host.innerHTML = '<p><br></p><p>正文</p><div><br></div>'
      + '<blockquote><p>引用</p><p><br></p><p>后文</p></blockquote>'
      + '<details class="note-fold" open><summary>折叠</summary><div class="note-fold-body"><p><br></p><p>正文</p><p><br></p></div></details><p><br></p>';
  });
  const markdown = await page.evaluate(() => editor.getMarkdown());
  expect(markdown).toMatch(/^<br>\n\n正文\n\n<br>/);
  expect(markdown).toContain('> 引用\n> \n> <br>\n> \n> 后文');
  expect(markdown).toContain(':::fold 折叠\n<br>\n\n正文\n\n<br>\n:::');
  expect(markdown).toMatch(/\n\n<br>$/);
  await page.evaluate(markdown => editor.setMarkdown(markdown, 'blank-test'), markdown);
  expect(await page.evaluate(() => editor.getMarkdown())).toBe(markdown);
});

test('blank lines in fenced code are preserved verbatim', async ({ page }) => {
  await setup(page);
  const source = '```text\nfirst\n\n\nlast\n```';
  await page.evaluate(source => editor.setMarkdown(source, 'code-test'), source);
  expect(await page.evaluate(() => editor.getMarkdown())).toBe(source);
});
