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
  test(`serialization retains an orphan title in the ${secondary ? 'secondary' : 'primary'} editor`, async ({ page }) => {
    await setup(page, secondary);
    await page.evaluate(() => document.querySelector('summary').replaceWith(document.createTextNode('分析')));
    expect(await page.evaluate(() => editor.getMarkdown())).toBe(':::fold 分析\n原正文\n:::');
  });
  for (const method of ['selection', 'last-character', 'composition-recovery']) {
    test(`${method} clearing and retyping preserves the ${secondary ? 'secondary' : 'primary'} fold title`, async ({ page }) => {
      await setup(page, secondary);
      await page.evaluate(method => {
        const summary = document.querySelector('summary');
        const range = document.createRange();
        if (method === 'last-character') {
          summary.textContent = '题'; range.selectNodeContents(summary); range.collapse(false);
        } else range.selectNodeContents(summary);
        getSelection().removeAllRanges(); getSelection().addRange(range);
      }, method);
      if (method === 'composition-recovery') {
        // Model the WebKit mutation shown in the report: summary disappears and
        // the first composing character becomes a sibling of the body.
        await page.evaluate(() => {
          const host = document.querySelector('[contenteditable]');
          host.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
          host.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertCompositionText', isComposing: true, data: '分', bubbles: true, cancelable: false }));
          const summary = document.querySelector('summary');
          summary.replaceWith(document.createTextNode('分'));
          host.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', isComposing: true, data: '分', bubbles: true }));
          host.dispatchEvent(new CompositionEvent('compositionend', { data: '分', bubbles: true }));
        });
      } else {
        await page.keyboard.press('Backspace');
        await expect(page.locator('summary')).toHaveCount(1);
        await page.keyboard.insertText('分');
      }
      await expect(page.locator('summary')).toHaveText('分');
      await expect(page.locator('.note-fold-body')).toHaveText('原正文');
      expect(await page.evaluate(() => editor.getMarkdown())).toBe(':::fold 分\n原正文\n:::');
      await page.addScriptTag({ path: path.resolve('lib/markdown/markdown-it.min.js') });
      await page.addScriptTag({ path: path.resolve('js/markdown.js') });
      await page.evaluate(() => {
        const renderer = StudyMarkdown.createRenderer({ markdownit: window.markdownit });
        window.formatNoteContent = source => renderer.render(source);
        editor.setMarkdown(editor.getMarkdown(), 'round-trip');
      });
      await expect(page.locator('summary')).toHaveText('分');
      await expect(page.locator('.note-fold-body')).toHaveText('原正文');
    });
  }
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

test('pasted inline math has the same spacing in a fold title as in body text', async ({ page }) => {
  await setup(page);
  await page.addStyleTag({ path: path.resolve('css/style.css') });
  await page.addStyleTag({ path: path.resolve('lib/katex/katex.min.css') });
  await page.addScriptTag({ path: path.resolve('lib/katex/katex.min.js') });
  await page.evaluate(() => {
    const formula = katex.renderToString('f(x)', { output: 'htmlAndMathml' });
    const html = `<p><span>若函数</span>${formula}<span>在点处连续</span></p>`;
    const body = document.querySelector('.note-fold-body');
    body.innerHTML = html;
    body.style.fontWeight = '600';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('summary'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/html', html);
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  const spacing = await page.evaluate(async () => {
    await document.fonts.ready;
    const measure = parent => {
      const math = parent.querySelector('.katex');
      const text = Array.from(parent.children).filter(node => !node.classList.contains('katex'));
      return [math.getBoundingClientRect().left - text[0].getBoundingClientRect().right,
        text[1].getBoundingClientRect().left - math.getBoundingClientRect().right];
    };
    return { title: measure(document.querySelector('summary')), body: measure(document.querySelector('.note-fold-body p')) };
  });
  spacing.title.forEach((gap, index) => expect(Math.abs(gap - spacing.body[index])).toBeLessThan(1));
  await expect(page.locator('summary .katex')).toHaveAttribute('data-latex', 'f(x)');
  expect(await page.evaluate(() => editor.getMarkdown())).toContain(':::fold 若函数$f(x)$在点处连续');
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
