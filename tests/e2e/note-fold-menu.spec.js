const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let app, page, userDataPath;
const source = '保留前文\n\n:::fold 待删标题\n待删正文\n\n:::fold 内层标题\n```js\nconst nested = 1;\n```\n:::\n:::\n\n:::fold 后方标题\n保留后方正文\n:::\n\n保留末文';

test.beforeAll(async () => {
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-fold-menu-'));
  app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
  page = await app.firstWindow();
  await page.waitForFunction(() => document.querySelector('#section-today.active') && !document.querySelector('script[data-app-src]'));
});
test.afterAll(async () => {
  await app?.close();
  if (userDataPath) await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function setup(secondary, mode, open = false, same = false) {
  await page.evaluate(({ secondary, mode, source, open, same }) => {
    closeNoteAiExplainMenu(); setNotesImmersiveSplit(false); setNotesImmersive(false); switchTab('notes');
    notes = [{ id: 'fold-main', type: 'note', title: '主栏笔记', content: source },
      { id: 'fold-second', type: 'note', title: '右栏笔记', content: source }];
    activeNoteId = 'fold-main'; notesSplitNoteId = same ? 'fold-main' : 'fold-second';
    noteViewMode = secondary ? 'preview' : mode; notesSplitMode = secondary ? mode : 'preview';
    renderNotes(); setNotesImmersive(true); setNotesImmersiveSplit(true);
    document.querySelectorAll((secondary ? '#notesSplit' : '#notes') + (mode === 'rich' ? 'RichEditor' : 'Preview') + ' details').forEach(fold => fold.open = open);
    notesUndoStack = []; notesRedoStack = [];
    getSelection().removeAllRanges();
  }, { secondary, mode, source, open, same });
  return secondary ? mode === 'rich' ? '#notesSplitRichEditor' : '#notesSplitPreview' : mode === 'rich' ? '#notesRichEditor' : '#notesPreview';
}

for (const secondary of [false, true]) for (const mode of ['preview', 'rich']) {
  for (const open of [false, true]) {
    test(`${secondary ? 'split' : 'main'} ${mode} deletes ${open ? 'open' : 'closed'} fold as one undoable operation`, async () => {
      const host = await setup(secondary, mode, open);
      const original = await page.evaluate(secondary => (secondary ? findNoteByLooseId(notesSplitNoteId) : getActiveNote()).content, secondary);
      await page.locator(host + ' > details > summary').filter({ hasText: /^待删标题$/ }).click({ button: 'right' });
      await expect(page.locator('#noteFoldDelete')).toBeVisible();
      await page.locator('#noteFoldDelete').click();
      const current = () => page.evaluate(secondary => (secondary ? findNoteByLooseId(notesSplitNoteId) : getActiveNote()).content, secondary);
      await expect.poll(current).not.toContain('待删标题');
      const deleted = await current();
      expect(deleted).not.toContain('const nested');
      expect(deleted).toContain('保留前文'); expect(deleted).toContain('保留后方正文'); expect(deleted).toContain('保留末文');
      expect(await page.evaluate(() => notesUndoStack.length)).toBe(1);
      await page.keyboard.press('Control+z');
      expect(await current()).toBe(original);
      await page.keyboard.press('Control+y');
      expect(await current()).toBe(deleted);
      await expect(page.locator(secondary ? '#notesSplitStatus' : '#notesStatus')).not.toHaveText('保存中…');
    });
  }
  test(`${secondary ? 'split' : 'main'} ${mode} deletes the clicked nested fold only`, async () => {
    const host = await setup(secondary, mode, true);
    await page.locator(host + ' summary').filter({ hasText: /^内层标题$/ }).click({ button: 'right' });
    await page.locator('#noteFoldDelete').click();
    const content = await page.evaluate(secondary => (secondary ? findNoteByLooseId(notesSplitNoteId) : getActiveNote()).content, secondary);
    expect(content).not.toContain('内层标题'); expect(content).not.toContain('const nested');
    expect(content).toContain('待删标题'); expect(content).toContain('待删正文'); expect(content).toContain('后方标题');
    await page.evaluate(() => undoNote());
    expect(await page.evaluate(secondary => (secondary ? findNoteByLooseId(notesSplitNoteId) : getActiveNote()).content, secondary)).toBe(source);
  });
}

for (const secondary of [false, true]) {
  test(`${secondary ? 'split' : 'main'} editing before and after deletion remains three separate history steps`, async () => {
    const host = await setup(secondary, 'rich', false);
    const editor = page.locator(host);
    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('删除前修改');
    const current = () => page.evaluate(secondary => (secondary ? findNoteByLooseId(notesSplitNoteId) : getActiveNote()).content, secondary);
    const beforeDelete = await current();
    await page.locator(host + ' > details > summary').filter({ hasText: /^待删标题$/ }).click({ button: 'right' });
    await page.locator('#noteFoldDelete').click();
    const deleted = await current();
    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('删除后修改');
    const afterEdit = await current();
    await page.evaluate(() => undoNote()); expect(await current()).toBe(deleted);
    await page.evaluate(() => undoNote()); expect(await current()).toBe(beforeDelete);
    await page.evaluate(() => redoNote()); expect(await current()).toBe(deleted);
    await page.evaluate(() => redoNote()); expect(await current()).toBe(afterEdit);
  });
  test(`${secondary ? 'split' : 'main'} deleting the only fold leaves an editable note and undo restores its body`, async () => {
    const host = await setup(secondary, 'rich', false);
    await page.evaluate(secondary => {
      const note = secondary ? findNoteByLooseId(notesSplitNoteId) : getActiveNote();
      note.content = ':::fold 唯一折叠\n完整正文\n:::';
      if (secondary) renderNotesImmersiveSplit(); else switchNoteView('rich');
    }, secondary);
    await page.locator(host + ' summary').click({ button: 'right' });
    await page.locator('#noteFoldDelete').click();
    await expect(page.locator(host + ' details')).toHaveCount(0);
    await page.keyboard.insertText('仍可编辑');
    await expect(page.locator(host)).toContainText('仍可编辑');
    await page.evaluate(() => undoNote()); await page.evaluate(() => undoNote());
    await expect(page.locator(host + ' summary')).toHaveText('唯一折叠');
    expect(await page.evaluate(secondary => (secondary ? findNoteByLooseId(notesSplitNoteId) : getActiveNote()).content, secondary)).toContain('完整正文');
  });
}

test('same-note reading deletion updates the editor and persists through undo, redo and reload', async () => {
  await setup(true, 'preview', false, true);
  await page.evaluate(() => setNotesSplitPrimaryMode('rich'));
  await page.locator('#notesSplitPreview > details > summary').filter({ hasText: /^待删标题$/ }).click({ button: 'right' });
  await page.locator('#noteFoldDelete').click();
  await expect(page.locator('#notesRichEditor')).not.toContainText('待删标题');
  await page.evaluate(() => undoNote());
  await expect(page.locator('#notesRichEditor')).toContainText('待删标题');
  await page.evaluate(() => redoNote());
  await expect(page.locator('#notesSplitPreview')).not.toContainText('待删标题');
  await expect(page.locator('#notesStatus')).not.toHaveText('保存中…');
  await page.reload();
  await page.waitForFunction(() => typeof deleteNoteFoldFromMenu === 'function' && !document.querySelector('script[data-app-src]'));
  expect(await page.evaluate(() => findNoteByLooseId('fold-main').content)).not.toContain('待删标题');
});

test('selected text keeps AI and translation actions beside fold deletion, ordinary text hides deletion', async () => {
  await setup(false, 'rich', true);
  await page.evaluate(() => {
    const title = document.querySelector('#notesRichEditor summary'); title.textContent = 'English fold title';
    title.closest('[contenteditable]').dispatchEvent(new Event('input', { bubbles: true }));
    const range = document.createRange(); range.selectNodeContents(title);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  await page.locator('#notesRichEditor summary').first().click({ button: 'right' });
  await expect(page.locator('#noteSelectionExplain')).toBeVisible();
  await expect(page.locator('#noteSelectionTranslate')).toBeVisible();
  await expect(page.locator('#noteFoldDelete')).toBeVisible();
  await page.evaluate(() => {
    const paragraph = document.querySelector('#notesRichEditor > p');
    const range = document.createRange(); range.selectNodeContents(paragraph);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    paragraph.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
  });
  await expect(page.locator('#noteFoldDelete')).toBeHidden();
});
