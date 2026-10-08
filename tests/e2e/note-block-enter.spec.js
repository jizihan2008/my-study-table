const { test, expect } = require('@playwright/test');
const path = require('node:path');
test.use({ channel: process.env.MST_TEST_BROWSER || undefined });

async function setup(page, html, selector, offset = 0) {
  await page.setContent(`<div id="notesRichEditor" contenteditable="true">${html}</div>`);
  await page.addScriptTag({ path: path.resolve('js/note-rich-editor.js') });
  await page.evaluate(({ selector, offset }) => {
    RichNoteEditor.init();
    const host = document.getElementById('notesRichEditor');
    host.focus();
    const target = host.querySelector(selector);
    const range = document.createRange();
    range.setStart(target.firstChild?.nodeType === Node.TEXT_NODE ? target.firstChild : target, offset);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, { selector, offset });
}

test('saving ordered lists preserves numbering across intervening paragraphs and folds', async ({ page }) => {
  await setup(page, '<ol><li>第一项</li></ol><p>说明</p><ol start="2"><li>第二项</li><li>第三项</li></ol>'
    + '<details class="note-fold" open><summary>标题</summary><div class="note-fold-body"><ol start="4"><li>第四项</li></ol></div></details>', 'li');
  await page.addScriptTag({ path: path.resolve('lib/markdown/markdown-it.min.js') });
  await page.addScriptTag({ path: path.resolve('lib/markdown/purify.min.js') });
  await page.addScriptTag({ path: path.resolve('js/markdown.js') });
  const result = await page.evaluate(() => {
    const markdown = RichNoteEditor.getMarkdown();
    const rendered = document.createElement('div');
    rendered.innerHTML = StudyMarkdown.render(markdown);
    return { markdown, starts: Array.from(rendered.querySelectorAll('ol'), list => list.start) };
  });
  expect(result.markdown).toContain('2. 第二项\n3. 第三项');
  expect(result.markdown).toContain('4. 第四项');
  expect(result.starts).toEqual([1, 2, 4]);
});

for (const [name, html, selector, outer] of [
  ['code', '<pre><code>abcdef</code></pre>', 'code', 'pre'],
  ['list', '<ul><li>abcdef</li><li>second</li></ul>', 'li', 'ul'],
  ['nested list', '<ol><li>first<ul><li>abcdef</li></ul></li></ol>', 'ul li', 'ol'],
  ['task', '<ul><li><input type="checkbox" checked>abcdef</li></ul>', 'li', 'ul'],
  ['table', '<table><tbody><tr><td>abcdef</td></tr></tbody></table>', 'td', 'table'],
  ['fold body', '<details class="note-fold" open><summary>title</summary><div class="note-fold-body"><p>abcdef</p><p>second</p></div></details>', '.note-fold-body p', 'details'],
  ['fold title', '<details class="note-fold" open><summary>title</summary><div class="note-fold-body"><p>abcdef</p></div></details>', 'summary', 'details']
]) {
  test(`Ctrl+Enter leaves ${name} intact`, async ({ page }) => {
    await setup(page, html + '<p>after</p>', selector);
    const before = await page.locator(`#notesRichEditor > ${outer}`).innerHTML();
    await page.keyboard.press('Control+Enter');
    await page.keyboard.insertText('new paragraph');
    await expect(page.locator(`#notesRichEditor > ${outer} + p`)).toHaveText('new paragraph');
    expect(await page.locator(`#notesRichEditor > ${outer}`).innerHTML()).toBe(before);
    await expect(page.locator('#notesRichEditor > p').last()).toHaveText('after');
  });
}

for (const [name, html, selector, following] of [
  ['list', '<ul><li>before</li><li><br></li><li>after</li></ul>', 'li:nth-child(2)', 'ul'],
  ['ordered list', '<ol><li><br></li></ol>', 'li', null],
  ['task list', '<ul><li><input type="checkbox" checked><br></li></ul>', 'li', null],
  ['quote', '<blockquote><p>before</p><p><br></p><p>after</p></blockquote>', 'blockquote p:nth-child(2)', 'blockquote']
]) {
  test(`Enter exits empty ${name} without losing following content`, async ({ page }) => {
    await setup(page, html, selector);
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('outside');
    await expect(page.locator('#notesRichEditor > p')).toHaveText('outside');
    if (following) {
      await expect(page.locator(`#notesRichEditor > ${following}`).first()).toHaveText('before');
      await expect(page.locator(`#notesRichEditor > p + ${following}`)).toHaveText('after');
    }
  });
}

test('Enter splits a completed task into an unchecked task', async ({ page }) => {
  await setup(page, '<ul class="markdown-task-list"><li class="markdown-task-item"><input type="checkbox" checked><span>abcdef</span></li></ul>', 'li span', 3);
  await page.keyboard.press('Enter');
  await expect(page.locator('li')).toHaveCount(2);
  await expect(page.locator('li').first()).toHaveText('abc');
  await expect(page.locator('li').last()).toHaveText(' def');
  await expect(page.locator('li').first().locator('input')).toBeChecked();
  await expect(page.locator('li').last().locator('input')).not.toBeChecked();
  await page.keyboard.insertText('new');
  expect(await page.evaluate(() => RichNoteEditor.getMarkdown())).toContain('- [ ] newdef');
});

test('Shift+Enter keeps a task on the same item', async ({ page }) => {
  await setup(page, '<ul><li><input type="checkbox" checked><span>abcdef</span></li></ul>', 'li span', 3);
  await page.keyboard.press('Shift+Enter');
  await expect(page.locator('li')).toHaveCount(1);
  await expect(page.locator('input')).toBeChecked();
});

for (const offset of [0, 6]) {
  test(`Enter in a task at offset ${offset} creates an unchecked next item`, async ({ page }) => {
    await setup(page, '<ul><li><input type="checkbox" checked><span>abcdef</span></li></ul>', 'li span', offset);
    await page.keyboard.press('Enter');
    await expect(page.locator('li')).toHaveCount(2);
    await expect(page.locator('li').last().locator('input')).toHaveCount(1);
    await expect(page.locator('li').last().locator('input')).not.toBeChecked();
    await page.keyboard.insertText('new');
    expect(await page.evaluate(() => RichNoteEditor.getMarkdown())).toContain('- [ ] new');
  });
}

for (const key of ['Backspace', 'Delete', 'beforeinput']) {
  test(`${key} removes a quote containing only one empty line`, async ({ page }) => {
    await setup(page, '<p>before</p><blockquote><p><br></p></blockquote><p>after</p>', 'blockquote p');
    if (key === 'beforeinput') await page.locator('#notesRichEditor').evaluate(host => {
      host.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));
    });
    else await page.keyboard.press(key);
    await expect(page.locator('blockquote')).toHaveCount(0);
    await page.keyboard.insertText('outside');
    await expect(page.locator('#notesRichEditor > p')).toHaveText(['before', 'outside', 'after']);
    expect(await page.evaluate(() => RichNoteEditor.getMarkdown())).toBe('before\n\noutside\n\nafter');
  });
}

test('empty quote removal does not apply to multiple empty lines or media', async ({ page }) => {
  for (const html of ['<p><br></p><p><br></p>', '<p><br><br></p>', '<p><img src="https://example.com/image.png"><br></p>']) {
    await setup(page, `<blockquote>${html}</blockquote>`, 'blockquote p');
    const result = await page.locator('#notesRichEditor').evaluate(host => {
      const event = new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true });
      host.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(result).toBe(false);
    await expect(page.locator('blockquote')).toHaveCount(1);
  }
});
