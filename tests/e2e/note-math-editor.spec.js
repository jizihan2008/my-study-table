'use strict';
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let app, page, userDataPath;
test.beforeAll(async () => {
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-math-edit-'));
  app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
  page = await app.firstWindow();
  await page.waitForFunction(() => document.readyState !== 'loading' && typeof RichNoteEditor !== 'undefined');
  await page.waitForFunction(() => document.querySelector('#section-today.active'));
});
test.afterAll(async () => {
  if (app) await app.close();
  if (userDataPath) await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
async function setup(source) {
  await page.evaluate(source => {
    switchTab('notes');
    setNotesImmersiveSplit(false);
    setNotesImmersive(false);
    const note = getActiveNote();
    note.content = source;
    note._dirtyContent = false;
    note._foldStates = {};
    renderNotes();
    switchNoteView('rich');
    notesUndoStack = [];
    notesRedoStack = [];
    document.querySelectorAll('#notesRichEditor details').forEach(fold => fold.open = true);
  }, source);
}

test('LaTeX toolbar inserts an editable inline formula at the selected text', async () => {
  await setup('前文 x^2 后文');
  await page.evaluate(() => {
    const host = document.getElementById('notesRichEditor');
    host.focus();
    const text = host.querySelector('p').firstChild;
    const range = document.createRange();
    range.setStart(text, 3);
    range.setEnd(text, 6);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.locator('#notesFormatToolbar button[title="LaTeX 公式 (∑)"]').click();
  await expect(page.locator('.note-math-dialog')).toBeVisible();
  await expect(page.getByLabel('LaTeX 源码')).toHaveValue('x^2');
  await page.getByLabel('LaTeX 源码').fill(String.raw`\frac{x}{2}`);
  await page.getByLabel('LaTeX 源码').press('Control+Enter');
  await expect(page.locator('.note-math-dialog')).toHaveCount(0);
  await expect(page.locator('#notesRichEditor .katex')).toHaveAttribute('data-latex', String.raw`\frac{x}{2}`);
  expect(await page.evaluate(() => getActiveNote().content)).toBe(String.raw`前文 $\frac{x}{2}$ 后文`);
  expect(await page.evaluate(() => noteViewMode)).toBe('rich');
  await page.evaluate(() => undoNote());
  expect(await page.evaluate(() => getActiveNote().content)).toBe('前文 x^2 后文');
  await page.evaluate(() => redoNote());
  await expect(page.locator('#notesRichEditor .katex')).toHaveAttribute('data-latex', String.raw`\frac{x}{2}`);
});

for (const [name, source, selector] of [
  ['quote', '> 前文 x^2 后文', 'blockquote p'],
  ['fold title', ':::fold 标题 x^2 后文\n正文\n:::', 'summary'],
  ['fold body', ':::fold 标题\n前文 x^2 后文\n:::', '.note-fold-body p']
]) {
  test(`LaTeX insertion preserves its ${name}`, async () => {
    await setup(source);
    await page.evaluate(selector => {
      const host = document.getElementById('notesRichEditor');
      host.focus();
      const text = host.querySelector(selector).firstChild;
      const start = text.textContent.indexOf('x^2');
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + 3);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }, selector);
    await page.locator('#notesFormatToolbar button[title="LaTeX 公式 (∑)"]').click();
    await page.locator('.note-math-save').click();
    await expect(page.locator(`#notesRichEditor ${selector} .katex`)).toHaveAttribute('data-latex', 'x^2');
    expect(await page.evaluate(() => getActiveNote().content)).toBe(source.replace('x^2', '$x^2$'));
  });
}

test('invalid or cancelled LaTeX insertion keeps the original note and caret', async () => {
  const source = '前文后文';
  await setup(source);
  await page.evaluate(() => {
    const host = document.getElementById('notesRichEditor');
    host.focus();
    const range = document.createRange();
    range.setStart(host.querySelector('p').firstChild, 2);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.locator('#notesFormatToolbar button[title="LaTeX 公式 (∑)"]').click();
  await page.getByLabel('LaTeX 源码').fill(String.raw`\frac{`);
  await expect(page.locator('.note-math-save')).toBeDisabled();
  await page.getByLabel('LaTeX 源码').press('Control+Enter');
  expect(await page.evaluate(() => getActiveNote().content)).toBe(source);
  await page.getByLabel('LaTeX 源码').press('Escape');
  expect(await page.evaluate(() => notesUndoStack.length)).toBe(0);
  await page.keyboard.insertText('中间');
  expect(await page.evaluate(() => getActiveNote().content)).toBe('前文中间后文');
});

test('LaTeX toolbar inserts only into the secondary editor without switching panes', async () => {
  await setup('左侧正文');
  const ids = await page.evaluate(() => {
    const left = getActiveNote();
    createNewNote();
    const right = getActiveNote();
    right.content = '右侧正文';
    right._dirtyContent = true;
    selectNote(left.id);
    setNotesImmersive(true);
    setNotesImmersiveSplit(true);
    selectNotesSplitNote(right.id);
    setNotesSplitSecondaryMode('rich');
    return { left: left.id, right: right.id };
  });
  await page.locator('#notesSplitRichEditor').evaluate(host => {
    host.focus();
    const range = document.createRange();
    range.setStart(host.querySelector('p').firstChild, 2);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.mouse.move(400, 2);
  await expect(page.locator('#section-notes')).toHaveClass(/show-top-controls/);
  await page.locator('#notesFormatToolbar button[title="LaTeX 公式 (∑)"]').click();
  await page.getByLabel('LaTeX 源码').fill('x^2');
  await page.locator('.note-math-save').click();
  await expect(page.locator('#notesSplitRichEditor .katex')).toHaveAttribute('data-latex', 'x^2');
  expect(await page.evaluate(() => getActiveNote().content)).toBe('左侧正文');
  expect(await page.evaluate(id => findNoteByLooseId(id).content, ids.right)).toBe('右侧$x^2$正文');
  expect(await page.evaluate(() => noteViewMode)).toBe('rich');
  await page.keyboard.press('Control+Z');
  await expect(page.locator('#notesSplitRichEditor .katex')).toHaveCount(0);
  expect(await page.evaluate(() => activeNoteId)).toBe(ids.left);
});

test('pasted inline formula remains in its paragraph when switching to source and back', async () => {
  await setup('待替换');
  await page.evaluate(() => {
    const host = document.getElementById('notesRichEditor');
    host.focus();
    const range = document.createRange();
    range.selectNodeContents(host.firstElementChild);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const data = new DataTransfer();
    data.setData('text/html', '<p>若函数\n' + katex.renderToString('f(x)') + '\n在点处连续。</p>');
    host.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#notesRichEditor .katex')).toHaveCount(1);
  await page.evaluate(() => switchNoteView('edit'));
  await expect(page.locator('#notesTextarea')).toHaveValue('若函数 $f(x)$ 在点处连续。');
  await page.evaluate(() => switchNoteView('rich'));
  await expect(page.locator('#notesRichEditor > p')).toHaveCount(1);
  await expect(page.locator('#notesRichEditor br, #notesRichEditor .katex-display')).toHaveCount(0);
  await expect(page.locator('#notesRichEditor .katex')).toHaveAttribute('data-latex', 'f(x)');
});

async function doubleClickMath(selector = '#notesRichEditor .katex') {
  const formula = page.locator(selector);
  await expect(formula).toBeVisible();
  await formula.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const rect = await formula.evaluate(element => (element.querySelector('.katex-html .mathnormal') || element).getBoundingClientRect().toJSON());
  await page.mouse.dblclick(rect.x + rect.width / 2, rect.y + rect.height / 2);
}

for (const immersive of [false, true]) {
  test(`math dialog stays centered in ${immersive ? 'immersive' : 'normal'} view and after resizing`, async () => {
    await setup('# 标题\n\n前文 $x^2$ 后文');
    await page.evaluate(immersive => setNotesImmersive(immersive), immersive);
    await doubleClickMath();
    const measure = () => page.locator('.note-math-dialog').evaluate(dialog => {
      const rect = dialog.getBoundingClientRect();
      return { x: rect.left + rect.width / 2 - innerWidth / 2,
        y: rect.top + rect.height / 2 - innerHeight / 2,
        left: rect.left, right: innerWidth - rect.right, top: rect.top, bottom: innerHeight - rect.bottom };
    });
    let position = await measure();
    expect(Math.abs(position.x)).toBeLessThan(2);
    expect(Math.abs(position.y)).toBeLessThan(2);
    await page.screenshot({ path: test.info().outputPath('math-dialog-centered.png') });
    await page.setViewportSize({ width: 390, height: 740 });
    position = await measure();
    expect(Math.abs(position.x)).toBeLessThan(2);
    expect(Math.abs(position.y)).toBeLessThan(2);
    for (const edge of ['left', 'right', 'top', 'bottom']) expect(position[edge]).toBeGreaterThanOrEqual(0);
    await page.getByLabel('LaTeX 源码').press('Escape');
    await page.setViewportSize({ width: 1186, height: 800 });
  });
}

test('double-click edits inline math with live preview and a separate undo step', async () => {
  await setup('前文 $x^2$ 后文');
  await page.evaluate(() => {
    const host = document.getElementById('notesRichEditor');
    host.querySelector('p').appendChild(document.createTextNode('，已输入的文字'));
    host.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
  const before = await page.evaluate(() => getActiveNote().content);
  await doubleClickMath();
  await expect(page.locator('.note-math-dialog')).toBeVisible();
  await expect(page.getByLabel('LaTeX 源码')).toHaveValue('x^2');
  await page.getByLabel('LaTeX 源码').fill(String.raw`\frac{x}{2}\neq y`);
  await expect(page.locator('.note-math-preview .mfrac')).toBeVisible();
  expect(await page.evaluate(() => getActiveNote().content)).toBe(before);
  await page.locator('.note-math-dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.note-math-dialog')).toHaveCount(0);
  await expect(page.locator('#notesRichEditor .katex')).toHaveAttribute('data-latex', String.raw`\frac{x}{2}\neq y`);
  const after = await page.evaluate(() => getActiveNote().content);
  expect(after).toContain(String.raw`$\frac{x}{2}\neq y$`);
  await page.keyboard.insertText('后续输入');
  await page.keyboard.press('Control+Z');
  expect(await page.evaluate(() => getActiveNote().content)).toBe(after);
  await page.keyboard.press('Control+Z');
  expect(await page.evaluate(() => getActiveNote().content)).toBe(before);
  await page.keyboard.press('Control+Y');
  expect(await page.evaluate(() => getActiveNote().content)).toBe(after);
});

for (const [name, source, display] of [
  ['quoted display', '> 前文\n>\n> $$\n> x^2\n> $$\n>\n> 后文', true],
  ['fold title', ':::fold 标题 $x^2$\n正文内容\n:::', false],
  ['nested fold body', ':::fold 外层\n:::fold 内层\n> 前文 $x^2$ 后文\n:::\n:::', false]
]) {
  test(`math editor preserves ${name} structure`, async () => {
    await setup(source);
    await doubleClickMath();
    await page.getByLabel('LaTeX 源码').fill(String.raw`\lim_{x\to a}f(x)=\infty`);
    await page.getByLabel('LaTeX 源码').press('Control+Enter');
    await expect(page.locator('.note-math-dialog')).toHaveCount(0);
    const result = await page.evaluate(() => ({
      content: getActiveNote().content,
      display: !!document.querySelector('#notesRichEditor .katex-display'),
      source: document.querySelector('#notesRichEditor .katex').dataset.latex
    }));
    expect(result.display).toBe(display);
    expect(result.source).toBe(String.raw`\lim_{x\to a}f(x)=\infty`);
    if (name === 'fold title') expect(result.content).toContain(':::fold 标题 $');
    if (name === 'nested fold body') expect((result.content.match(/:::fold/g) || []).length).toBe(2);
    await page.evaluate(() => undoNote());
    expect(await page.evaluate(() => getActiveNote().content)).toBe(source);
    await page.evaluate(() => redoNote());
    expect(await page.evaluate(() => getActiveNote().content)).toBe(result.content);
  });
}

test('invalid drafts, cancel and unchanged saves do not modify notes or history', async () => {
  const source = '# 标题\n\n前文 $x^2$ 后文';
  await setup(source);
  await page.evaluate(() => setNotesImmersive(true));
  await doubleClickMath();
  await page.locator('.note-math-dialog').screenshot({ path: test.info().outputPath('math-editor-immersive.png') });
  await page.getByLabel('LaTeX 源码').fill(String.raw`\frac{`);
  await expect(page.locator('.note-math-error')).not.toBeEmpty();
  await expect(page.locator('.note-math-dialog').getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await page.getByLabel('LaTeX 源码').press('Control+Enter');
  await expect(page.locator('.note-math-dialog')).toBeVisible();
  await page.getByLabel('LaTeX 源码').press('Control+Z');
  expect(await page.evaluate(() => getActiveNote().content)).toBe(source);
  await page.getByLabel('LaTeX 源码').press('Escape');
  await expect(page.locator('.note-math-dialog')).toHaveCount(0);
  expect(await page.evaluate(() => notesImmersive)).toBe(true);
  expect(await page.evaluate(() => notesUndoStack.length)).toBe(0);
  await doubleClickMath();
  await page.locator('.note-math-dialog').getByRole('button', { name: '保存', exact: true }).click();
  expect(await page.evaluate(() => notesUndoStack.length)).toBe(0);
  await doubleClickMath();
  await page.getByLabel('LaTeX 源码').fill('x^3');
  await page.locator('.note-math-dialog').getByRole('button', { name: '取消', exact: true }).click();
  expect(await page.evaluate(() => getActiveNote().content)).toBe(source);
  expect(await page.evaluate(() => notesUndoStack.length)).toBe(0);
});

test('secondary formula edits and history remain in the secondary pane', async () => {
  await setup('左侧 $a$');
  const ids = await page.evaluate(() => {
    const left = getActiveNote();
    createNewNote();
    const right = getActiveNote();
    right.content = '右侧 $x^2$';
    right._dirtyContent = true;
    selectNote(left.id);
    setNotesImmersive(true);
    setNotesImmersiveSplit(true);
    selectNotesSplitNote(right.id);
    setNotesSplitSecondaryMode('rich');
    notesUndoStack = [];
    notesRedoStack = [];
    return { left: left.id, right: right.id };
  });
  await doubleClickMath('#notesSplitRichEditor .katex');
  await page.getByLabel('LaTeX 源码').fill('x^3');
  await page.locator('.note-math-dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#notesSplitRichEditor .katex')).toHaveAttribute('data-latex', 'x^3');
  await page.keyboard.press('Control+Z');
  await expect(page.locator('#notesSplitRichEditor .katex')).toHaveAttribute('data-latex', 'x^2');
  await expect(page.locator('#notesRichEditor .katex')).toHaveAttribute('data-latex', 'a');
  expect(await page.evaluate(() => activeNoteId)).toBe(ids.left);
  await page.keyboard.press('Control+Y');
  await expect(page.locator('#notesSplitRichEditor .katex')).toHaveAttribute('data-latex', 'x^3');
  expect(await page.evaluate(id => findNoteByLooseId(id).content, ids.left)).toBe('左侧 $a$');
});
