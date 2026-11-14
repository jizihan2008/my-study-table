const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test.use({
  channel: process.env.MST_TEST_BROWSER || undefined,
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block'
});

test('immersive notes preserve the visible text without focusing the editor', async ({ page }) => {
  const root = path.resolve(__dirname, '../..');
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'study-table.test') return route.abort();
    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404 });
    return route.fulfill({ path: file });
  });
  await page.goto('http://study-table.test/');
  await page.waitForSelector('#section-today.active');
  await page.evaluate(() => {
    switchTab('notes');
    notesGoMain();
    const note = getActiveNote();
    note.content = Array.from({ length: 120 }, (_, i) =>
      `第 ${i} 段。这一段足够长，可以在字号和可用宽度改变后重新折行，仍然能用正文内容找回原来的位置。`
    ).join('\n\n');
    renderNotes();
    setNotesImmersiveZoom(140);
  });

  for (const [mode, id] of Object.entries({ preview: 'notesPreview', edit: 'notesTextarea', rich: 'notesRichEditor' })) {
    await page.evaluate(mode => switchNoteView(mode), mode);
    const view = page.locator('#' + id);
    const anchorAt = fraction => view.evaluate(async (element, fraction) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) * fraction;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const note = getActiveNote();
      return NoteViewPosition.capture(element, note.content, note.id).line;
    }, fraction);
    const checkPosition = async line => {
      const actual = await view.evaluate(async element => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const note = getActiveNote();
        // Measure the current viewport independently of the anchor cached by restore().
        element.scrollTop += 2;
        return NoteViewPosition.capture(element, note.content, note.id)?.line;
      });
      expect(Math.abs(actual - line), `${mode} expected source line ${line}, found ${actual}`).toBeLessThanOrEqual(2);
      await expect(view).not.toBeFocused();
    };

    const beforeEntry = await anchorAt(0.4);
    await page.locator('.notes-mv-fab').tap();
    await page.locator('#notesMobileImmersiveBtn').tap();
    await expect(page.locator('#section-notes')).toHaveClass(/notes-immersive/);
    await checkPosition(beforeEntry);

    const beforeExit = await anchorAt(0.65);
    await page.locator('#notesImmersiveExit').tap();
    await expect(page.locator('#section-notes')).not.toHaveClass(/notes-immersive/);
    await checkPosition(beforeExit);
  }
});
