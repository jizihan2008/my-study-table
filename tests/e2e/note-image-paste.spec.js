const { test, expect, _electron: electron, chromium } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZkAAAAASUVORK5CYII=';
let app, browser, page, userDataPath;

test.beforeAll(async () => {
  if (process.env.MST_IMAGE_TEST_URL) {
    browser = await chromium.launch({ channel: 'chrome' });
    page = await browser.newPage();
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== new URL(process.env.MST_IMAGE_TEST_URL).origin) return route.abort();
      const root = path.resolve('.');
      const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(root + path.sep)) return route.abort();
      try { await route.fulfill({ path: file }); }
      catch (_) { await route.fulfill({ status: 404, body: '' }); }
    });
    await page.goto(process.env.MST_IMAGE_TEST_URL);
    await page.waitForFunction(() => document.querySelector('#section-today.active') && !document.querySelector('script[data-app-src]'));
    return;
  }
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-image-paste-'));
  app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
  page = await app.firstWindow();
  await page.waitForFunction(() => document.querySelector('#section-today.active') && !document.querySelector('script[data-app-src]'));
});
test.afterAll(async () => {
  await app?.close();
  await browser?.close();
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


test('note images crop, resize and align, survive reload and support undo', async () => {
  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 100; canvas.height = 80;
    const context = canvas.getContext('2d');
    context.fillStyle = 'red'; context.fillRect(0, 0, 100, 80);
    context.fillStyle = 'blue'; context.fillRect(50, 0, 50, 80);
    getActiveNote().content = '前文\n\n![截图](' + canvas.toDataURL() + ')\n\n后文';
    renderNotes(); setNotesSplitPrimaryMode('rich');
  });
  const image = page.locator('#notesRichEditor img');
  await image.click();
  const dialog = page.getByRole('dialog', { name: '编辑图片' });
  await dialog.locator('[name=left]').fill('50');
  await dialog.locator('[name=width]').fill('50');
  await dialog.locator('[name=align]').selectOption('right');
  await dialog.getByRole('button', { name: '保存图片' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => image.evaluate(img => img.naturalWidth)).toBe(50);
  await expect.poll(() => image.evaluate(img => img.naturalHeight)).toBe(80);
  expect(await image.evaluate(img => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d'); context.drawImage(img, 0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  })).toEqual([0, 0, 255, 255]);
  await expect(image).toHaveAttribute('data-note-width', '50');
  await expect(image).toHaveAttribute('data-note-align', 'right');
  const content = await page.evaluate(() => getActiveNote().content);
  expect(content).toContain('mst-image:50:right');
  expect(content).toContain('前文'); expect(content).toContain('后文');
  for (const align of ['left', 'center']) {
    await image.click();
    await dialog.locator('[name=align]').selectOption(align);
    await dialog.getByRole('button', { name: '保存图片' }).click();
    await expect(image).toHaveAttribute('data-note-align', align);
  }
  await page.locator('#notesRichEditor').press('Control+z');
  await expect(image).toHaveAttribute('data-note-align', 'left');
  await page.locator('#notesRichEditor').press('Control+y');
  await expect(image).toHaveAttribute('data-note-align', 'center');
  await expect(page.locator('#notesStatus')).toHaveText('已保存');
  await page.reload();
  await page.waitForFunction(() => typeof switchNoteView === 'function' && !document.querySelector('script[data-app-src]'));
  await page.evaluate(() => { switchTab('notes'); selectNote('image-note'); switchNoteView('rich'); });
  await expect(image).toHaveAttribute('data-note-align', 'center');
  await expect(image).toHaveAttribute('data-note-width', '50');
  await expect.poll(() => image.evaluate(img => img.naturalWidth)).toBe(50);
  expect(await image.evaluate(img => img.getBoundingClientRect().width / img.parentElement.clientWidth)).toBeCloseTo(0.5, 1);
  await page.evaluate(() => switchNoteView('preview'));
  await expect(page.locator('#notesPreview img')).toHaveAttribute('data-note-align', 'center');
});


test('split editor supports drag cropping and mirrors image layout into the reading pane', async () => {
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 100;
    canvas.getContext('2d').fillRect(0, 0, 200, 100);
    getActiveNote().content = '![图](' + canvas.toDataURL() + ')';
    renderNotes(); setNotesSplitSecondaryMode('rich');
  });
  const image = page.locator('#notesSplitRichEditor img');
  await image.click();
  const dialog = page.getByRole('dialog', { name: '编辑图片' });
  const stage = dialog.locator('.note-image-stage');
  await expect.poll(() => stage.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(0);
  const bounds = await stage.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width, bounds.y + bounds.height * 0.9);
  await page.mouse.up();
  const corner = await dialog.locator('[data-edge="nw"]').boundingBox();
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + bounds.height * 0.3);
  await page.mouse.up();
  expect(Number(await dialog.locator('[name=left]').inputValue())).toBeCloseTo(60, 0);
  expect(Number(await dialog.locator('[name=top]').inputValue())).toBeCloseTo(30, 0);
  await expect(dialog.locator('[name=right]')).toHaveValue('100.0');
  await dialog.locator('[name=left]').fill('50');
  await dialog.locator('[name=top]').fill('10');
  await dialog.locator('[name=width]').fill('75');
  await dialog.locator('[name=align]').selectOption('left');
  await dialog.getByRole('button', { name: '保存图片' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => image.evaluate(img => img.naturalWidth)).toBe(100);
  await expect.poll(() => image.evaluate(img => img.naturalHeight)).toBe(80);
  await expect(image).toHaveAttribute('data-note-width', '75');
  await expect(page.locator('#notesPreview img')).toHaveAttribute('data-note-align', 'left');
});


test('immersive display zoom scales ordinary and resized note images in both panes without changing content', async () => {
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 100;
    const source = canvas.toDataURL();
    getActiveNote().content = '![原图](' + source + ')\n\n![缩放图](' + source + ' "mst-image:50:right")';
    renderNotes(); setNotesSplitPrimaryMode('rich'); setNotesImmersiveZoom(100);
  });
  const images = page.locator('#notesRichEditor img');
  await expect(images).toHaveCount(2);
  const original = await page.evaluate(() => getActiveNote().content);
  const sizes = () => images.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
  const before = await sizes();
  await page.evaluate(() => setNotesImmersiveZoom(150));
  const after = await sizes();
  expect(after[0] / before[0]).toBeCloseTo(1.5, 1);
  expect(after[1] / before[1]).toBeCloseTo(1.5, 1);
  const mirror = page.locator('#notesSplitPreview img');
  await expect(mirror).toHaveCount(2);
  const mirrorZoomed = await mirror.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
  await page.evaluate(() => setNotesImmersiveZoom(100));
  const mirrorDefault = await mirror.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
  expect(mirrorZoomed[0] / mirrorDefault[0]).toBeCloseTo(1.5, 1);
  expect(mirrorZoomed[1] / mirrorDefault[1]).toBeCloseTo(1.5, 1);
  expect(await sizes()).toEqual(before);
  expect(await page.evaluate(() => getActiveNote().content)).toBe(original);
});
