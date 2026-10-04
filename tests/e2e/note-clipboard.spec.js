const { test, expect } = require('@playwright/test');
const path = require('node:path');
test.use({ channel: process.env.MST_TEST_BROWSER || undefined });

test('rich note paste retains note structures and removes unsafe content', async ({ page }) => {
  await page.setContent('<div id="notesRichEditor" contenteditable="true"></div>');
  await page.addScriptTag({ path: path.resolve('lib/markdown/purify.min.js') });
  await page.addScriptTag({ path: path.resolve('js/note-rich-editor.js') });
  const result = await page.evaluate(() => {
    RichNoteEditor.init();
    const host = document.getElementById('notesRichEditor');
    host.focus();
    const data = new DataTransfer();
    data.setData('text/html', '<p><span style="font-weight:700;font-style:italic">重点</span> <span class="katex" data-latex="x^2"><span>x²</span></span><img src="https://example.com/a.png" alt="图" onerror="alert(1)"></p><ul><li><input type="checkbox" checked>完成</li></ul><pre><code class="language-js">const x = 1;</code></pre><script>alert(1)</script><input type="text"><a href="javascript:alert(1)">危险链接</a>');
    host.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return { markdown: RichNoteEditor.getMarkdown(), html: host.innerHTML };
  });
  expect(result.markdown).toContain('***重点***');
  expect(result.markdown).toContain('$x^2$');
  expect(result.markdown).toContain('![图](https://example.com/a.png)');
  expect(result.markdown).toContain('- [x] 完成');
  expect(result.markdown).toContain('```js\nconst x = 1;\n```');
  expect(result.html).not.toMatch(/onerror|<script|javascript:|type="text"/);
});

for (const surface of ['quote', 'list', 'fold']) {
  test(`pasted math inherits ${surface} background and retains authored colors`, async ({ page }) => {
    await page.setContent('<div id="notesRichEditor" contenteditable="true"></div>');
    await page.addStyleTag({ path: path.resolve('lib/katex/katex.min.css') });
    await page.addStyleTag({ content: '#notesRichEditor { background:#141c29;color:#dce2eb;padding:20px } blockquote, li, .note-fold-body { background:#293445;padding:15px }' });
    await page.addScriptTag({ path: path.resolve('lib/markdown/purify.min.js') });
    await page.addScriptTag({ path: path.resolve('lib/katex/katex.min.js') });
    await page.addScriptTag({ path: path.resolve('js/note-rich-editor.js') });
    const result = await page.evaluate(surface => {
      RichNoteEditor.init();
      const host = document.getElementById('notesRichEditor');
      const markup = {
        quote: '<blockquote><p>引用：</p></blockquote>',
        list: '<ul><li><p>列表：</p></li></ul>',
        fold: '<details class="note-fold" open><summary>标题</summary><div class="note-fold-body"><p>正文：</p></div></details>'
      };
      host.innerHTML = markup[surface];
      host.focus();
      const range = document.createRange();
      range.selectNodeContents(host.querySelector('p'));
      range.collapse(false);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      const latex = String.raw`\frac{x}{2}\neq y`;
      const authored = String.raw`\colorbox{yellow}{$x$}`;
      const clipboard = document.createElement('div');
      clipboard.innerHTML = katex.renderToString(latex) + ' ' + katex.renderToString(authored);
      clipboard.querySelectorAll('.katex, .katex *').forEach(node => {
        node.style.backgroundColor = '#141c29';
        node.style.color = '#dce2eb';
      });
      const data = new DataTransfer();
      data.setData('text/html', clipboard.innerHTML);
      host.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      const formulas = host.querySelectorAll('.katex');
      return {
        markdown: RichNoteEditor.getMarkdown(),
        count: formulas.length,
        sources: Array.from(formulas, node => node.dataset.latex),
        backgrounds: Array.from(formulas[0].querySelectorAll('*'), node => getComputedStyle(node).backgroundColor),
        rootBackground: getComputedStyle(formulas[0]).backgroundColor,
        formulaColor: getComputedStyle(formulas[0]).color,
        textColor: getComputedStyle(host.querySelector('p')).color,
        hasFractionLayout: !!formulas[0].querySelector('.vlist [style*="top:"]'),
        authoredBackground: Array.from(formulas[1].querySelectorAll('*')).some(node => getComputedStyle(node).backgroundColor === 'rgb(255, 255, 0)'),
        inSurface: !!formulas[0].closest(surface === 'quote' ? 'blockquote' : surface === 'list' ? 'li' : '.note-fold-body')
      };
    }, surface);
    if (surface === 'quote') await page.locator('#notesRichEditor').screenshot({ path: test.info().outputPath('pasted-quote-math.png') });
    expect(result.count).toBe(2);
    expect(result.sources).toEqual([String.raw`\frac{x}{2}\neq y`, String.raw`\colorbox{yellow}{$x$}`]);
    expect(result.markdown).toContain(String.raw`$\frac{x}{2}\neq y$`);
    expect(result.rootBackground).toBe('rgba(0, 0, 0, 0)');
    expect(result.backgrounds.every(color => color === 'rgba(0, 0, 0, 0)')).toBe(true);
    expect(result.formulaColor).toBe(result.textColor);
    expect(result.hasFractionLayout).toBe(true);
    expect(result.authoredBackground).toBe(true);
    expect(result.inSurface).toBe(true);
  });
}

test('pasted math without a renderer discards background but preserves layout', async ({ page }) => {
  await page.setContent('<div id="notesRichEditor" contenteditable="true"><blockquote><p>引用：</p></blockquote></div>');
  await page.addScriptTag({ path: path.resolve('lib/markdown/purify.min.js') });
  await page.addScriptTag({ path: path.resolve('js/note-rich-editor.js') });
  const result = await page.evaluate(() => {
    RichNoteEditor.init();
    const host = document.getElementById('notesRichEditor');
    host.focus();
    const range = document.createRange();
    range.selectNodeContents(host.querySelector('p'));
    range.collapse(false);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    const data = new DataTransfer();
    data.setData('text/html', '<span class="katex" style="background:#141c29"><span style="background-color:#141c29;top:-2em;vertical-align:-1em">x²</span></span>');
    host.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    const math = host.querySelector('.katex');
    return { background: math.style.background, childBackground: math.firstChild.style.backgroundColor, top: math.firstChild.style.top, verticalAlign: math.firstChild.style.verticalAlign };
  });
  expect(result).toEqual({ background: '', childBackground: '', top: '-2em', verticalAlign: '-1em' });
});

test('pasted display math retains its TeX and display layout inside a quote', async ({ page }) => {
  await page.setContent('<div id="notesRichEditor" contenteditable="true"><blockquote><p>引用：</p></blockquote></div>');
  await page.addScriptTag({ path: path.resolve('lib/markdown/purify.min.js') });
  await page.addScriptTag({ path: path.resolve('lib/katex/katex.min.js') });
  await page.addScriptTag({ path: path.resolve('js/note-rich-editor.js') });
  const result = await page.evaluate(() => {
    RichNoteEditor.init();
    const host = document.getElementById('notesRichEditor');
    host.focus();
    const range = document.createRange();
    range.selectNodeContents(host.querySelector('p'));
    range.collapse(false);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    const clipboard = document.createElement('div');
    clipboard.innerHTML = katex.renderToString(String.raw`\lim_{x\to a}f(x)=\infty`, { displayMode: true });
    clipboard.querySelectorAll('span').forEach(node => node.style.backgroundColor = '#141c29');
    const data = new DataTransfer();
    data.setData('text/html', clipboard.innerHTML);
    host.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    const math = host.querySelector('blockquote .katex-display .katex');
    return {
      markdown: RichNoteEditor.getMarkdown(),
      displayStyle: !!math?.querySelector('.mop.op-limits'),
      hasCopiedBackground: !!host.querySelector('[style*="background"]')
    };
  });
  expect(result.markdown).toContain('> $$\n> ' + String.raw`\lim_{x\to a}f(x)=\infty` + '\n> $$');
  expect(result.displayStyle).toBe(true);
  expect(result.hasCopiedBackground).toBe(false);
});
