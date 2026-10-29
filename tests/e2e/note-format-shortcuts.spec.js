'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let app, page, userDataPath;

test.beforeAll(async () => {
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-format-shortcuts-'));
  app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
  page = await app.firstWindow();
  await page.waitForFunction(() => document.querySelector('#section-today.active') && !document.querySelector('script[data-app-src]'));
});
test.afterAll(async () => {
  await app?.close();
  if (userDataPath) await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function setup(mode, secondary, content = '正文') {
  await page.evaluate(({ mode, secondary, content }) => {
    setNotesImmersiveSplit(false); setNotesImmersive(false); switchTab('notes');
    notes = [
      { id: 'shortcut-main', type: 'note', title: '主笔记', content: secondary ? '正文' : content, parentId: null },
      { id: 'shortcut-side', type: 'note', title: '副笔记', content, parentId: null }
    ];
    activeNoteId = 'shortcut-main'; notesSplitNoteId = 'shortcut-side';
    noteViewMode = secondary ? 'preview' : mode; notesSplitMode = mode;
    renderNotes();
    if (secondary) { setNotesImmersive(true); setNotesImmersiveSplit(true); }
    else switchNoteView(mode);
  }, { mode, secondary, content });
  const selector = '#' + (secondary ? (mode === 'edit' ? 'notesSplitTextarea' : 'notesSplitRichEditor') : (mode === 'edit' ? 'notesTextarea' : 'notesRichEditor'));
  await page.locator(selector).focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Control+a');
  return selector;
}

async function completeCommand(mode, action) {
  if (mode !== 'rich') return;
  if (action === 'link' || action === 'image') {
    await expect(page.locator('#promptOverlay')).toHaveClass(/open/);
    await page.locator('#promptInput').fill('https://example.com/test.png');
    await page.locator('#promptOk').click();
  } else if (action === 'latex') {
    await page.getByLabel('LaTeX 源码').fill('x^2');
    await page.locator('.note-math-save').click();
  } else if (action === 'footnote') {
    await expect.poll(() => page.evaluate(() => notes.some(n => n.content.includes('[^1]')))).toBe(true);
  }
}

for (const secondary of [false, true]) for (const mode of ['edit', 'rich']) {
  test(`${secondary ? 'split' : 'main'} ${mode}: every format shortcut matches its toolbar action`, async () => {
    test.setTimeout(90000);
    const entries = await page.evaluate(() => NOTES_FORMAT_SHORTCUTS.filter(([action]) => action !== 'note-jump'));
    for (const [action, chord] of entries) {
      const initial = action === 'paragraph' ? '# 正文' : '正文';
      await setup(mode, secondary, initial);
      await page.keyboard.press('Control+' + chord);
      await completeCommand(mode, action);
      const actual = await page.evaluate(secondary => notes.find(n => n.id === (secondary ? 'shortcut-side' : 'shortcut-main')).content, secondary);
      expect(actual, action + ' must change content').not.toBe(initial);
      if (secondary) expect(await page.evaluate(() => getActiveNote().content)).toBe('正文');
      await setup(mode, secondary, initial);
      await page.evaluate(action => formatText(action), action);
      await completeCommand(mode, action);
      const expected = await page.evaluate(secondary => notes.find(n => n.id === (secondary ? 'shortcut-side' : 'shortcut-main')).content, secondary);
      expect(actual, action).toBe(expected);
    }
    await setup(mode, secondary);
    await page.keyboard.press('Control+Alt+K');
    await expect(page.locator('#noteLinkSearch')).toBeVisible();
    await page.keyboard.press('Escape');
  });
}

test('selection formatting supports undo, redo, view changes and durable reload', async () => {
  await setup('rich', false);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+b');
  await expect(page.locator('#notesRichEditor b, #notesRichEditor strong')).toHaveText('正文');
  await page.keyboard.press('Control+z');
  await expect(page.locator('#notesRichEditor b, #notesRichEditor strong')).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect(page.locator('#notesRichEditor b, #notesRichEditor strong')).toHaveText('正文');
  await page.evaluate(() => switchNoteView('edit'));
  await expect(page.locator('#notesTextarea')).toHaveValue('**正文**');
  await page.evaluate(() => switchNoteView('preview'));
  await expect(page.locator('#notesPreview strong')).toHaveText('正文');
  await expect(page.locator('#notesStatus')).toHaveText('已保存');
  await page.evaluate(() => StudyData.flush());
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#section-today.active') && !document.querySelector('script[data-app-src]'));
  expect(await page.evaluate(() => notes.find(n => n.id === 'shortcut-main').content)).toBe('**正文**');
});

test('tooltips expose shortcuts; title, reading, IME and extra modifiers do not format', async () => {
  await setup('edit', false);
  await expect(page.locator('#notesFormatToolbar [onclick="formatText(\'table\')"]')).toHaveAttribute('title', /Ctrl\+Alt\+T/);
  await expect(page.locator('#notesHeadingMenu [data-heading="2"]')).toHaveAttribute('aria-keyshortcuts', /Control\+Alt\+2/);
  await page.locator('#noteTitleInput').focus();
  await page.keyboard.press('Control+b');
  expect(await page.evaluate(() => getActiveNote().content)).toBe('正文');
  await page.locator('#notesTextarea').focus();
  const results = await page.evaluate(() => {
    const host = document.getElementById('notesTextarea');
    return [{ key: 'b', ctrlKey: true, isComposing: true },
      { key: 'b', ctrlKey: true, shiftKey: true },
      { key: 'b', ctrlKey: true, altKey: true }].map(options => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options });
      host.dispatchEvent(event); return event.defaultPrevented;
    });
  });
  expect(results).toEqual([false, false, false]);
  expect(await page.evaluate(() => getActiveNote().content)).toBe('正文');
  await page.evaluate(() => switchNoteView('preview'));
  await page.locator('#notesPreview').click();
  await page.keyboard.press('Control+b');
  expect(await page.evaluate(() => getActiveNote().content)).toBe('正文');
});
