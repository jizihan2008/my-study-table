'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('important inline and block labels edit, round-trip, undo and persist in both panes', async () => {
  test.setTimeout(90000);
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-important-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.querySelector('#section-today.active') && !document.querySelector('script[data-app-src]'));
    await page.evaluate(() => {
      notes = [{ id: 'important-main', type: 'note', title: '重点', content: '前文 后文', parentId: null },
        { id: 'important-side', type: 'note', title: '副笔记', content: '副正文', parentId: null }];
      switchTab('notes'); selectNote('important-main'); switchNoteView('rich');
    });
    for (const secondary of [false, true]) {
      if (secondary) await page.evaluate(() => { setNotesImmersive(true); setNotesImmersiveSplit(true); selectNotesSplitNote('important-side'); setNotesSplitSecondaryMode('rich'); });
      const host = secondary ? '#notesSplitRichEditor' : '#notesRichEditor';
      await page.locator(host).focus();
      await page.keyboard.press('Control+End');
      await page.evaluate(() => formatText('important-inline'));
      await expect(page.locator(host + ' .note-important-inline')).toHaveCount(1);
      const label = page.locator(host + ' .note-important-inline > .note-important-title');
      await label.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(range); });
      await page.keyboard.insertText('易错点');
      await expect(label).toHaveText('易错点');
      await page.locator(host).focus(); await page.keyboard.press('Control+End');
      await page.evaluate(() => formatText('important-block'));
      await expect(page.locator(host + ' .note-important-block')).toHaveCount(1);
      await page.keyboard.press('Control+z');
      await expect(page.locator(host + ' .note-important-block')).toHaveCount(0);
      await page.keyboard.press('Control+y');
      await expect(page.locator(host + ' .note-important-block')).toHaveCount(1);
      const blockLabel = page.locator(host + ' .note-important-block > .note-important-title');
      await blockLabel.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(range); });
      await page.keyboard.insertText('关键结论');
      await expect(blockLabel).toHaveText('关键结论');
      await page.keyboard.press('Enter');
      expect(await page.evaluate(host => { const node = getSelection().anchorNode; return !!(node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement).closest(host + ' .note-important-body'); }, host)).toBe(true);
      await page.keyboard.press('Control+Enter');
      expect(await page.evaluate(() => !!getSelection().anchorNode.parentElement.closest('.note-important-block'))).toBe(false);
      for (let round = 0; round < 2; round++) {
        await page.evaluate(secondary => { if (secondary) { setNotesSplitSecondaryMode('edit'); setNotesSplitSecondaryMode('rich'); } else { switchNoteView('edit'); switchNoteView('rich'); } }, secondary);
        await expect(page.locator(host + ' .note-important-title')).toHaveText(['易错点', '关键结论']);
      }
      const content = await page.evaluate(secondary => notes.find(n => n.id === (secondary ? 'important-side' : 'important-main')).content, secondary);
      expect(content).toContain('=={易错点}重点内容==');
      expect(content).toContain(':::important 关键结论');
      // Source insertion wraps a real selection in each pane as well.
      await page.evaluate(secondary => {
        if (secondary) setNotesSplitSecondaryMode('edit'); else switchNoteView('edit');
        const ta = document.getElementById(secondary ? 'notesSplitTextarea' : 'notesTextarea');
        ta.focus(); ta.setSelectionRange(0, 2); formatText('important-inline');
        if (secondary) setNotesSplitSecondaryMode('preview'); else switchNoteView('preview');
      }, secondary);
      await expect(page.locator((secondary ? '#notesSplitPreview' : '#notesPreview') + ' .note-important-inline')).toHaveCount(2);
    }
    await page.evaluate(async () => { setNotesImmersive(false); await saveDataDurable('study_notes_v2', notes); await StudyData.flush(); });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#section-today') && !document.querySelector('script[data-app-src]'));
    await page.evaluate(() => { switchTab('notes'); selectNote('important-main'); switchNoteView('preview'); });
    await expect(page.locator('#notesPreview .note-important-inline')).toHaveCount(2);
    await expect(page.locator('#notesPreview .note-important-block > .note-important-title')).toHaveText('关键结论');
    await page.screenshot({ path: '.tmp-note-important-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { notesGoMain(); toggleNoteToc(false); });
    await expect(page.locator('#notesPreview .note-important-block')).toBeVisible();
    await page.screenshot({ path: '.tmp-note-important-mobile.png' });
    // Real selected rich text must keep surrounding text and inline formatting.
    await page.evaluate(() => { setNotesImmersive(false); notes.push({ id: 'important-selection', type: 'note', title: '选区', content: '前文 **选中内容** 后文', parentId: null }); selectNote('important-selection'); switchNoteView('rich'); });
    for (const kind of ['inline', 'block']) {
      await page.evaluate(kind => {
        RichNoteEditor.setMarkdown('前文 **选中内容** 后文', 'important-selection');
        const strong = document.querySelector('#notesRichEditor strong');
        const range = document.createRange(); range.selectNode(strong); getSelection().removeAllRanges(); getSelection().addRange(range);
        formatText('important-' + kind);
      }, kind);
      await expect(page.locator('#notesRichEditor .note-important-body strong')).toHaveText('选中内容');
      await page.evaluate(() => { switchNoteView('edit'); switchNoteView('rich'); });
      await expect(page.locator('#notesRichEditor .note-important-body strong')).toHaveText('选中内容');
      await expect(page.locator('#notesRichEditor')).toContainText('前文');
      await expect(page.locator('#notesRichEditor')).toContainText('后文');
    }
    await page.evaluate(() => { switchNoteView('edit'); const ta = document.getElementById('notesTextarea'); ta.value = '第一行\n第二行'; ta.focus(); ta.select(); formatText('important-inline'); switchNoteView('rich'); });
    await expect(page.locator('#notesRichEditor .note-important-inline .note-important-body br')).toHaveCount(1);
    await page.evaluate(() => { document.getElementById('notesRichEditor').dispatchEvent(new Event('input', { bubbles: true })); switchNoteView('edit'); switchNoteView('rich'); });
    await expect(page.locator('#notesRichEditor .note-important-inline .note-important-body br')).toHaveCount(1);
  } finally {
    await app?.close();
    await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
