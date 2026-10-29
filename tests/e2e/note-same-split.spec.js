const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let app, page, userDataPath;

test.beforeAll(async () => {
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-same-split-'));
  app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
  page = await app.firstWindow();
  await page.waitForFunction(() => document.querySelector('#section-today.active') && !document.querySelector('script[data-app-src]'));
});
test.afterAll(async () => {
  await app?.close();
  if (userDataPath) await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
test.beforeEach(async () => {
  await page.evaluate(() => {
    setNotesImmersiveSplit(false); setNotesImmersive(false);
    switchTab('notes');
    notes = [{ id: 'same-note', type: 'note', title: '同一篇笔记', content: '# 标题\n\n原始正文', parentId: null }];
    activeNoteId = 'same-note'; notesSplitNoteId = ''; notesSplitMode = 'preview';
    noteViewMode = 'preview'; renderNotes();
    notesUndoStack = []; notesRedoStack = [];
    setNotesImmersive(true); setNotesImmersiveSplit(true);
  });
});

test('one note can split, and both dropdowns allow choosing the same note', async () => {
  await expect(page.locator('#section-notes')).toHaveClass(/notes-split/);
  await expect(page.locator('#notesSplitPrimarySelect')).toHaveValue('same-note');
  await expect(page.locator('#notesSplitSecondarySelect')).toHaveValue('same-note');
  await page.evaluate(() => {
    notes.push({ id: 'other-note', type: 'note', title: '其他笔记', content: '独立正文' });
    renderNotesImmersiveSplit();
  });
  await page.locator('#notesSplitSecondarySelect').selectOption('other-note');
  await page.locator('#notesSplitSecondarySelect').selectOption('same-note');
  await page.locator('#notesSplitPrimarySelect').selectOption('other-note');
  await page.locator('#notesSplitPrimarySelect').selectOption('same-note');
  await expect(page.locator('#notesSplitSecondarySelect')).toHaveValue('same-note');
});

for (const secondary of [false, true]) {
  test(`${secondary ? 'right' : 'left'} rich edits update the other reading pane and survive undo/redo`, async () => {
    await page.evaluate(secondary => {
      if (secondary) setNotesSplitSecondaryMode('rich'); else setNotesSplitPrimaryMode('rich');
    }, secondary);
    const editor = page.locator(secondary ? '#notesSplitRichEditor' : '#notesRichEditor');
    const reading = page.locator(secondary ? '#notesPreview' : '#notesSplitPreview');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('新增内容');
    await expect(reading).toContainText('新增内容');
    await expect(editor).toBeFocused();
    await page.keyboard.press('Control+z');
    await expect(reading).not.toContainText('新增内容');
    await page.keyboard.press('Control+y');
    await expect(reading).toContainText('新增内容');
    await expect(reading).toBeVisible();
    await expect(page.locator('#notesStatus')).toHaveText('已保存');
  });
  test(`${secondary ? 'right' : 'left'} source edits render live and keep source mode through history and round trips`, async () => {
    const source = page.locator(secondary ? '#notesSplitTextarea' : '#notesTextarea');
    const reading = page.locator(secondary ? '#notesPreview' : '#notesSplitPreview');
    await page.locator(secondary ? '#notesSplitSecondarySource' : '#notesSplitPrimarySource').click();
    await source.fill('# 新标题\n\n**源码修改**');
    await expect(reading.locator('strong')).toHaveText('源码修改');
    await expect(source).toBeFocused();
    await page.keyboard.press('Control+z');
    await expect(reading).toContainText('原始正文');
    await expect(source).toBeVisible();
    await page.keyboard.press('Control+y');
    await expect(reading.locator('strong')).toHaveText('源码修改');
    await source.press('Control+End');
    await source.press('Tab');
    await expect(source).toHaveValue(/\t$/);
    await source.press('Control+b');
    await expect(source).toHaveValue(/\*\*粗体文字\*\*$/);
    await page.locator(secondary ? '#notesSplitSecondaryEdit' : '#notesSplitPrimaryEdit').click();
    await expect(page.locator(secondary ? '#notesSplitRichEditor' : '#notesRichEditor')).toContainText('源码修改');
    await page.locator(secondary ? '#notesSplitSecondarySource' : '#notesSplitPrimarySource').click();
    await expect(source).toHaveValue(/源码修改/);
    await expect(page.locator('#notesStatus')).toHaveText('已保存');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('study_notes_v2')).find(n => n.id === 'same-note').content)).toContain('源码修改');
  });
}

test('single-pane immersive mode exposes source editing and right source selection persists', async () => {
  await page.evaluate(() => setNotesImmersiveSplit(false));
  await page.locator('#notesSplitPrimarySource').click();
  await expect(page.locator('#notesTextarea')).toBeVisible();
  await page.evaluate(() => { setNotesImmersiveSplit(true); setNotesSplitSecondaryMode('edit'); });
  expect(await page.evaluate(() => localStorage.getItem('study_notes_split_mode'))).toBe('edit');
});

for (const secondary of [false, true]) {
  test(`${secondary ? 'right' : 'left'} blank lines persist after saving and reloading`, async () => {
    await page.evaluate(secondary => {
      if (secondary) setNotesSplitSecondaryMode('rich'); else setNotesSplitPrimaryMode('rich');
    }, secondary);
    const editor = page.locator(secondary ? '#notesSplitRichEditor' : '#notesRichEditor');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('空行后的正文');
    const expected = '# 标题\n\n原始正文\n\n<br>\n\n<br>\n\n空行后的正文';
    const reading = page.locator(secondary ? '#notesPreview' : '#notesSplitPreview');
    await expect(reading.locator('p > br')).toHaveCount(2);
    await expect(page.locator('#notesStatus')).toHaveText('已保存');
    expect(await page.evaluate(() => getActiveNote().content)).toBe(expected);
    await page.reload();
    await page.waitForFunction(() => typeof setNotesSplitSecondaryMode === 'function' && !document.querySelector('script[data-app-src]'));
    await page.evaluate(() => {
      switchTab('notes'); selectNote('same-note'); switchNoteView('rich');
    });
    expect(await page.evaluate(() => getActiveNote().content)).toBe(expected);
    await expect(page.locator('#notesRichEditor > p > br')).toHaveCount(2);
    await page.evaluate(() => switchNoteView('edit'));
    await expect(page.locator('#notesTextarea')).toHaveValue(expected);
  });
}

test('right source heading tools target that note, and durable content survives reload', async () => {
  await page.evaluate(() => {
    notes.push({ id: 'other-note', type: 'note', title: '其他笔记', content: '独立正文' });
    selectNotesSplitNote('other-note'); setNotesSplitSecondaryMode('edit');
  });
  const source = page.locator('#notesSplitTextarea');
  await source.fill('源码标题');
  await source.press('Control+Home');
  await page.mouse.move(400, 2);
  await page.locator('#notesHeadingButton').click();
  await page.evaluate(() => applyNotesHeading(3));
  await expect(source).toHaveValue('### 源码标题');
  expect(await page.evaluate(() => getActiveNote().content)).toBe('# 标题\n\n原始正文');
  await expect(page.locator('#notesSplitStatus')).toHaveText('已保存');
  await page.reload();
  await page.waitForFunction(() => typeof setNotesSplitSecondaryMode === 'function' && !document.querySelector('script[data-app-src]'));
  await page.evaluate(() => {
    switchTab('notes'); selectNote('same-note'); setNotesImmersive(true); setNotesImmersiveSplit(true);
  });
  await expect(source).toHaveValue('### 源码标题');
  await page.locator('#notesSplitSecondarySelect').selectOption('same-note');
  await source.fill('# 同篇源码\n\n**实时预览**');
  await expect(page.locator('#notesPreview strong')).toHaveText('实时预览');
  const sourceButton = await page.locator('#notesSplitSecondarySource').boundingBox();
  const splitButton = await page.locator('#notesImmersiveSplit').boundingBox();
  expect(sourceButton.x + sourceButton.width).toBeLessThanOrEqual(splitButton.x);
  await page.screenshot({ path: '.tmp-same-note-split-source.png' });
});
