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

const closedFold = '<details class="note-fold"><summary>标题</summary><div class="note-fold-body"><p>隐藏正文</p></div></details>';

for (const scenario of [
  { name: 'between the fold and a paragraph', html: closedFold + '\n<p>后文</p>', position: 'afterFold', key: 'Backspace' },
  { name: 'before the fold', html: '<p>前文</p>\n' + closedFold, position: 'beforeFold', key: 'Delete' },
  { name: 'after a quote ending with a fold', html: '<blockquote>' + closedFold + '</blockquote>\n<p>后文</p>', position: 'nextTextStart', key: 'Backspace' },
  { name: 'before a quote starting with a fold', html: '<p>前文</p>\n<blockquote>' + closedFold + '</blockquote>', position: 'previousTextEnd', key: 'Delete' },
  { name: 'from the title into the next paragraph', html: closedFold + '<p>后文</p>', position: 'fromTitle', key: 'Backspace' },
  { name: 'to replace text from the title into the next paragraph', html: closedFold + '<p>后文</p>', position: 'fromTitle', key: 'x' },
  { name: 'to paste over text from the title into the next paragraph', html: closedFold + '<p>后文</p>', position: 'fromTitle', key: 'paste' },
  { name: 'from the title to the fold end', html: closedFold + '<p>后文</p>', position: 'titleToAfterFold', key: 'Control+x' },
  { name: 'from a paragraph into the title', html: '<p>前文</p>' + closedFold, position: 'intoTitle', key: 'Delete' },
  { name: 'to replace a whole fold', html: '<p>前文</p>' + closedFold + '<p>后文</p>', position: 'wholeFold', key: 'x' },
  { name: 'to cut a whole fold', html: '<p>前文</p>' + closedFold + '<p>后文</p>', position: 'wholeFold', key: 'Control+x' },
  { name: 'across a whole fold', html: '<p>前文</p>' + closedFold + '<p>后文</p>', position: 'wholeFold', key: 'Backspace' }
]) {
  test(`closed fold boundary: ${scenario.key} ${scenario.name}`, async ({ page }) => {
    await setup(page, false);
    const host = page.locator('#notesRichEditor');
    await host.evaluate((host, scenario) => {
      host.innerHTML = scenario.html;
      const fold = host.querySelector('details');
      const title = fold.querySelector('summary').firstChild;
      const range = document.createRange();
      switch (scenario.position) {
        case 'afterFold': range.setStartAfter(fold); break;
        case 'beforeFold': range.setStartBefore(fold); break;
        case 'nextTextStart': range.setStart(host.lastElementChild.firstChild, 0); break;
        case 'previousTextEnd': range.setStart(host.firstElementChild.firstChild, 2); break;
        case 'fromTitle':
          range.setStart(title, 1);
          range.setEnd(host.lastElementChild.firstChild, 1);
          break;
        case 'titleToAfterFold':
          range.setStart(title, 1);
          range.setEndAfter(fold);
          break;
        case 'intoTitle':
          range.setStart(host.firstElementChild.firstChild, 1);
          range.setEnd(title, 1);
          break;
        case 'wholeFold': range.selectNode(fold); break;
      }
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }, scenario);
    if (scenario.key === 'paste') {
      await host.evaluate(host => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', '替换');
        window.NoteImageClipboard = { getFiles: () => [] };
        host.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      });
    } else await page.keyboard.press(scenario.key);
    if (scenario.position === 'wholeFold' && scenario.key === 'Backspace') {
      await expect(host.locator('details')).toHaveCount(0);
      await expect(host.locator('p')).toHaveText(['前文', '后文']);
      expect(await page.evaluate(() => changes)).toEqual(['前文\n\n后文']);
    } else {
      expect(await host.evaluate(host => host.innerHTML)).toBe(scenario.html);
      expect(await page.evaluate(() => changes)).toEqual([]);
    }
  });
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

for (const secondary of [false, true]) {
  for (const input of ['keyboard', 'beforeinput']) {
    test(`${secondary ? 'split' : 'primary'} removes a divider after a closed fold via ${input}`, async ({ page }) => {
      await setup(page, secondary);
      const markdown = ':::fold 标题\n**隐藏正文**\n\n- 保留列表\n:::\n\n---'
        + (input === 'keyboard' ? '\n\n后续正文' : '');
      await page.evaluate(markdown => editor.setMarkdown(markdown, 'test'), markdown);
      const fold = page.locator('details');
      const rule = page.locator('hr');
      const before = await fold.evaluate(node => node.outerHTML);
      if (input === 'keyboard') {
        await rule.click();
        await page.keyboard.press('Backspace');
      } else {
        await rule.evaluate(rule => {
          const host = rule.parentElement;
          host.focus();
          const range = document.createRange();
          range.setStartBefore(rule);
          range.collapse(true);
          getSelection().removeAllRanges();
          getSelection().addRange(range);
          host.dispatchEvent(new InputEvent('beforeinput', {
            inputType: 'deleteContentBackward', bubbles: true, cancelable: true
          }));
        });
      }
      await expect(rule).toHaveCount(0);
      expect(await fold.evaluate(node => node.outerHTML)).toBe(before);
      const saved = markdown.replace(/\n\n---/, '');
      expect(await page.evaluate(() => changes)).toEqual([saved]);
      await page.evaluate(saved => editor.setMarkdown(saved, 'test'), saved);
      await fold.locator('summary').click({ position: { x: 2, y: 8 } });
      await expect(fold.locator('strong')).toBeVisible();
      await expect(fold.locator('li')).toHaveText('保留列表');
    });
  }
}
