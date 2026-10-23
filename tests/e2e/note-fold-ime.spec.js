const { test, expect } = require('@playwright/test');
const path = require('node:path');
test.use({ channel: process.env.MST_TEST_BROWSER || 'msedge' });

const endings = {
  code: '```js\nconst untouched = 42;\n```',
  quote: '> 引用末行',
  'quote-code': '> ```js\n> const untouched = 42;\n> ```',
  list: '- 最后项目\n  - 子项目',
  table: '| 标题 |\n| --- |\n| 单元格 |',
  paragraph: '普通末行',
  heading: '### 上方末尾小标题',
  'nested-fold': ':::fold 内层标题\n```js\nconst nested = 1;\n```\n:::',
};

async function setup(page, secondary, ending) {
  const hostId = secondary ? 'notesSplitRichEditor' : 'notesRichEditor';
  await page.setContent(`<div id="${hostId}" class="notes-rich-editor active" contenteditable="true"></div>`);
  await page.addStyleTag({ path: path.resolve('css/style.css') });
  for (const file of ['lib/markdown/markdown-it.min.js', 'lib/markdown/purify.min.js', 'js/markdown.js', 'js/note-rich-editor.js']) {
    await page.addScriptTag({ path: path.resolve(file) });
  }
  await page.evaluate(({ hostId, secondary, ending }) => {
    window.formatNoteContent = source => StudyMarkdown.render(source);
    window.editor = secondary ? createRichNoteEditor({ hostId }) : RichNoteEditor;
    editor.setMarkdown(':::fold 上方标题\n' + ending + '\n:::\n\n:::fold 下方标题\n下方正文\n:::', 'ime');
    document.querySelectorAll('details').forEach(fold => { fold.open = true; });
    const host = document.getElementById(hostId);
    host.focus();
    const range = document.createRange();
    range.setStart(host.querySelectorAll(':scope > details.note-fold > summary')[1].firstChild, 0);
    range.collapse(true);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  }, { hostId, secondary, ending });
}

for (const secondary of [false, true]) {
  for (const [name, ending] of Object.entries(endings)) {
    test(`${secondary ? 'split' : 'main'} native IME at title start after ${name} preserves both folds`, async ({ page }) => {
      await setup(page, secondary, ending);
      const body = await page.locator('.note-fold-body').first().innerHTML();
      const cdp = await page.context().newCDPSession(page);
      for (const text of ['n', 'ni', '你']) {
        await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
        await expect(page.locator('[contenteditable] > details.note-fold')).toHaveCount(2);
        await expect(page.locator('[contenteditable] > details.note-fold > summary').nth(1)).toHaveText(text + '下方标题');
        expect(await page.locator('.note-fold-body').first().innerHTML()).toBe(body);
      }
      await cdp.send('Input.insertText', { text: '你' });
      await expect(page.locator('[contenteditable] > details.note-fold > summary').nth(1)).toHaveText('你下方标题');
      await page.keyboard.insertText('继续');
      await expect(page.locator('[contenteditable] > details.note-fold > summary').nth(1)).toHaveText('你继续下方标题');
      expect(await page.locator('.note-fold-body').first().innerHTML()).toBe(body);
      const markdown = await page.evaluate(() => editor.getMarkdown());
      expect(markdown).toContain(':::fold 你继续下方标题\n下方正文\n:::');
      expect(markdown).not.toContain('\u200b');
      await page.evaluate(markdown => editor.setMarkdown(markdown, 'ime'), markdown);
      await expect(page.locator('[contenteditable] > details.note-fold > summary').nth(1)).toHaveText('你继续下方标题');
    });
  }
  test(`${secondary ? 'split' : 'main'} cancelled and repeated composition keeps the title and code intact`, async ({ page }) => {
    await setup(page, secondary, endings.code);
    const body = await page.locator('.note-fold-body').first().innerHTML();
    const cdp = await page.context().newCDPSession(page);
    const title = page.locator('[contenteditable] > details.note-fold > summary').nth(1);
    await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await expect(title).toHaveText('下方标题');
    for (let i = 0; i < 2; i++) {
      await title.evaluate(summary => {
        const range = document.createRange(); range.selectNodeContents(summary); range.collapse(true);
        getSelection().removeAllRanges(); getSelection().addRange(range);
      });
      await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
      await cdp.send('Input.insertText', { text: '你' });
    }
    await expect(title).toHaveText('你你下方标题');
    expect(await page.locator('.note-fold-body').first().innerHTML()).toBe(body);
    expect(await page.evaluate(() => editor.getMarkdown())).not.toContain('\u200b');
  });
}

test('native IME in a same-note immersive split keeps the opposite reading pane and saved Markdown correct', async () => {
  const { _electron: electron } = require('@playwright/test');
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-fold-ime-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.querySelector('#section-today.active') && !document.querySelector('script[data-app-src]'));
    await page.evaluate(() => {
      switchTab('notes');
      notes = [{ id: 'ime-fold', type: 'note', title: '输入法验证', content: ':::fold 上方\n```js\nconst kept = 1;\n```\n:::\n\n:::fold 下方标题\n保留正文\n:::' }];
      activeNoteId = 'ime-fold'; notesSplitNoteId = 'ime-fold';
      noteViewMode = 'preview'; notesSplitMode = 'rich'; renderNotes();
      setNotesImmersive(true); setNotesImmersiveSplit(true);
      document.querySelectorAll('#notesSplitRichEditor details').forEach(fold => fold.open = true);
      const host = document.getElementById('notesSplitRichEditor'); host.focus();
      const range = document.createRange(); range.setStart(host.querySelectorAll('summary')[1].firstChild, 0); range.collapse(true);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    await cdp.send('Input.insertText', { text: '中文' });
    await expect(page.locator('#notesSplitRichEditor summary').nth(1)).toHaveText('中文下方标题');
    await expect(page.locator('#notesPreview summary').nth(1)).toHaveText('中文下方标题');
    await expect(page.locator('#notesSplitRichEditor pre code')).toHaveText('const kept = 1;');
    await expect(page.locator('#notesStatus')).toHaveText('已保存');
    const content = await page.evaluate(() => JSON.parse(localStorage.getItem('study_notes_v2')).find(note => note.id === 'ime-fold').content);
    expect(content).toContain(':::fold 中文下方标题\n保留正文\n:::');
    expect(content).not.toContain('\u200b');
    await page.keyboard.press('Control+z');
    await expect(page.locator('#notesSplitRichEditor summary').nth(1)).toHaveText('下方标题');
    await page.keyboard.press('Control+y');
    await expect(page.locator('#notesSplitRichEditor summary').nth(1)).toHaveText('中文下方标题');
  } finally {
    await app?.close();
    await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
