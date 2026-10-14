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

const boundaryCases = [
  { name: 'quote', html: '<blockquote><p id="edge">引用正文</p><p>下一行</p></blockquote>' },
  { name: 'direct quote text', html: '<blockquote id="edge">引用正文</blockquote>' },
  { name: 'nested quote', html: '<blockquote><blockquote><p id="edge"><strong>引用正文</strong></p></blockquote></blockquote>', selector: '#edge strong' },
  { name: 'paragraph', html: '<p id="edge">普通正文</p>' },
  { name: 'heading', html: '<h2 id="edge">标题正文</h2>' },
  { name: 'list', html: '<ul><li id="edge">列表正文</li><li>第二项</li></ul>' },
  { name: 'code', html: '<pre><code id="edge">代码正文</code></pre>' },
  { name: 'table', html: '<table><tbody><tr><td id="edge">表格正文</td></tr></tbody></table>' },
  { name: 'following fold title', html: '<details class="note-fold"><summary id="edge">下一标题</summary><div class="note-fold-body"><p>下一正文</p></div></details>' },
  { name: 'nested fold body', html: '<blockquote><details class="note-fold"><summary>内层</summary><div class="note-fold-body"><p>隐藏正文</p></div></details><p id="edge">引用正文</p></blockquote>', nested: true }
];

for (const secondary of [false, true]) {
  for (const input of ['keyboard', 'beforeinput']) {
    for (const scenario of boundaryCases) {
      test(`${secondary ? 'split' : 'primary'} ${scenario.name} Backspace via ${input} preserves hidden body`, async ({ page }) => {
        await setup(page, secondary);
        await page.evaluate(scenario => {
          const host = document.activeElement;
          host.querySelector('#gap').remove();
          host.querySelector('details:last-child').remove();
          if (scenario.nested) host.innerHTML = scenario.html;
          else host.insertAdjacentHTML('beforeend', scenario.html);
          const range = document.createRange();
          range.selectNodeContents(host.querySelector(scenario.selector || '#edge'));
          range.collapse(true);
          getSelection().removeAllRanges();
          getSelection().addRange(range);
        }, scenario);
        const before = await page.locator('details').evaluateAll(folds => folds.map(fold => fold.outerHTML));
        const text = await page.locator('#edge').textContent();
        if (input === 'keyboard') await page.keyboard.press('Backspace');
        else await page.evaluate(() => document.activeElement.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'deleteContentBackward', bubbles: true, cancelable: true
        })));
        expect(await page.locator('details').evaluateAll(folds => folds.map(fold => fold.outerHTML))).toEqual(before);
        await expect(page.locator('#edge')).toHaveText(text);
        expect(await page.evaluate(() => editor.getMarkdown())).toContain(scenario.nested ? '隐藏正文' : '**第一正文**');
      });
    }
  }
}

for (const secondary of [false, true]) {
  for (const input of ['keyboard', 'beforeinput']) {
    for (const inTitle of [false, true]) {
      test(`${secondary ? 'split' : 'primary'} Delete ${inTitle ? 'at closed title end' : 'before closed fold'} via ${input} preserves hidden body`, async ({ page }) => {
        await setup(page, secondary);
        await page.evaluate(inTitle => {
          const host = document.activeElement;
          if (!inTitle) host.insertAdjacentHTML('afterbegin', '<blockquote><p id="edge">引用正文</p></blockquote>');
          const range = document.createRange();
          range.selectNodeContents(host.querySelector(inTitle ? 'summary' : '#edge'));
          range.collapse(false);
          getSelection().removeAllRanges();
          getSelection().addRange(range);
        }, inTitle);
        const before = await page.locator('details').evaluateAll(folds => folds.map(fold => fold.outerHTML));
        if (input === 'keyboard') await page.keyboard.press('Delete');
        else await page.evaluate(() => document.activeElement.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'deleteContentForward', bubbles: true, cancelable: true
        })));
        expect(await page.locator('details').evaluateAll(folds => folds.map(fold => fold.outerHTML))).toEqual(before);
        if (!inTitle) await expect(page.locator('#edge')).toHaveText('引用正文');
      });
    }
  }
}

for (const scenario of [
  { name: 'Backspace inside quote', key: 'Backspace', offset: 2, expected: '引正文' },
  { name: 'Delete inside quote', key: 'Delete', offset: 1, expected: '引正文' },
  { name: 'selected quote text', key: 'Backspace', offset: 1, end: 3, expected: '引文' },
  { name: 'later quote paragraph', key: 'Backspace', offset: 0, later: true, expected: '引用正文' }
]) {
  test(`${scenario.name} retains normal text editing beside a closed fold`, async ({ page }) => {
    await setup(page, false);
    await page.evaluate(scenario => {
      const host = document.activeElement;
      host.querySelector('#gap').outerHTML = '<blockquote><p>引用正文</p>' + (scenario.later ? '<p id="edge">下一行</p>' : '') + '</blockquote>';
      const text = host.querySelector(scenario.later ? '#edge' : 'blockquote p').firstChild;
      const range = document.createRange();
      range.setStart(text, scenario.offset);
      range.setEnd(text, scenario.end ?? scenario.offset);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }, scenario);
    const before = await page.locator('details').evaluateAll(folds => folds.map(fold => fold.outerHTML));
    await page.keyboard.press(scenario.key);
    expect(await page.locator('details').evaluateAll(folds => folds.map(fold => fold.outerHTML))).toEqual(before);
    await expect(page.locator('blockquote')).toHaveText(scenario.expected + (scenario.later ? '下一行' : ''));
  });
}

test('word Backspace at the quote boundary is protected through beforeinput', async ({ page }) => {
  await setup(page, false);
  await page.evaluate(() => {
    const host = document.activeElement;
    host.querySelector('#gap').outerHTML = '<blockquote><p>引用正文</p></blockquote>';
    const range = document.createRange();
    range.setStart(host.querySelector('blockquote p').firstChild, 0);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  const before = await page.locator('details').evaluateAll(folds => folds.map(fold => fold.outerHTML));
  await page.keyboard.press('Control+Backspace');
  expect(await page.locator('details').evaluateAll(folds => folds.map(fold => fold.outerHTML))).toEqual(before);
  await expect(page.locator('blockquote')).toHaveText('引用正文');
});
