const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZkAAAAASUVORK5CYII=';
let app, page, userDataPath;

test.beforeAll(async () => {
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-image-paste-'));
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
    setNotesImmersiveSplit(false); setNotesImmersive(false); switchTab('notes');
    notes = [{ id: 'image-note', type: 'note', title: '图片笔记', content: '前文后文', parentId: null }];
    activeNoteId = 'image-note'; notesSplitNoteId = ''; notesSplitMode = 'preview';
    noteViewMode = 'preview'; renderNotes();
    notesUndoStack = []; notesRedoStack = [];
    setNotesImmersive(true); setNotesImmersiveSplit(true);
  });
});

async function paste(id, { count = 1, filesOnly = false } = {}) {
  await page.evaluate(({ id, png, count, filesOnly }) => {
    const host = document.getElementById(id);
    host.focus();
    if (host.matches('textarea')) host.setSelectionRange(2, 2);
    else {
      const range = document.createRange();
      range.setStart(host.querySelector('p').firstChild, 2); range.collapse(true);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    }
    const data = new DataTransfer();
    for (let i = 0; i < count; i++) data.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], `paste${i}.png`, { type: 'image/png' }));
    // Screenshot clipboards can also contain HTML pointing at a temporary file.
    data.setData('text/html', '<img src="file:///temporary.png">');
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    if (filesOnly) Object.defineProperty(event, 'clipboardData', { value: { files: data.files, items: [], getData: () => '' } });
    host.dispatchEvent(event);
  }, { id, png, count, filesOnly });
}

for (const secondary of [false, true]) for (const mode of ['rich', 'edit']) {
  test(`${secondary ? 'split' : 'primary'} ${mode} image paste saves, mirrors, undoes and survives reload`, async () => {
    await page.evaluate(({ secondary, mode }) => {
      if (secondary) setNotesSplitSecondaryMode(mode); else setNotesSplitPrimaryMode(mode);
    }, { secondary, mode });
    const id = secondary ? (mode === 'rich' ? 'notesSplitRichEditor' : 'notesSplitTextarea')
      : (mode === 'rich' ? 'notesRichEditor' : 'notesTextarea');
    await paste(id, { filesOnly: secondary });
    const expected = `前文![图片](data:image/png;base64,${png})后文`;
    await expect.poll(() => page.evaluate(() => getActiveNote().content)).toBe(expected);
    const mirror = page.locator(secondary ? '#notesPreview' : '#notesSplitPreview');
    await expect(mirror.locator('img')).toHaveCount(1);
    await expect.poll(() => mirror.locator('img').evaluate(img => img.complete && img.naturalWidth)).toBe(1);
    await page.locator(`#${id}`).press('Control+z');
    await expect.poll(() => page.evaluate(() => getActiveNote().content)).toBe('前文后文');
    await page.locator(`#${id}`).press('Control+y');
    await expect.poll(() => page.evaluate(() => getActiveNote().content)).toBe(expected);
    await expect(page.locator('#notesStatus')).toHaveText('已保存');
    await page.reload();
    await page.waitForFunction(() => typeof switchNoteView === 'function' && !document.querySelector('script[data-app-src]'));
    await page.evaluate(() => { switchTab('notes'); selectNote('image-note'); switchNoteView('rich'); });
    await expect(page.locator('#notesRichEditor img')).toHaveAttribute('src', `data:image/png;base64,${png}`);
    await page.evaluate(() => switchNoteView('edit'));
    await expect(page.locator('#notesTextarea')).toHaveValue(expected);
    await page.evaluate(() => switchNoteView('preview'));
    await expect.poll(() => page.locator('#notesPreview img').evaluate(img => img.complete && img.naturalWidth)).toBe(1);
  });
}

test('multiple images keep order and allow typing after paste', async () => {
  await page.evaluate(() => setNotesSplitPrimaryMode('rich'));
  await paste('notesRichEditor', { count: 2 });
  await expect(page.locator('#notesRichEditor img')).toHaveCount(2);
  await page.keyboard.insertText('接着写');
  expect(await page.evaluate(() => getActiveNote().content)).toBe(`前文![图片](data:image/png;base64,${png})![图片](data:image/png;base64,${png})接着写后文`);
});

test('switching notes while reading an image does not change either note', async () => {
  await page.evaluate(() => {
    setNotesSplitPrimaryMode('rich');
    window.originalImageRead = NoteImageClipboard.read;
    NoteImageClipboard.read = () => new Promise(resolve => { window.finishImageRead = resolve; });
  });
  await paste('notesRichEditor');
  await page.evaluate(png => {
    notes.push({ id: 'other-image-note', type: 'note', title: '另一篇', content: '独立正文' });
    selectNote('other-image-note');
    finishImageRead([`data:image/png;base64,${png}`]);
    NoteImageClipboard.read = originalImageRead;
  }, png);
  await expect(page.locator('#notesRichEditor')).toContainText('独立正文');
  expect(await page.evaluate(() => notes.map(n => n.content))).toEqual(['前文后文', '独立正文']);
});
