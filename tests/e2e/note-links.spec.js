const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('note jump blocks persist and navigate to headings, folds and the beginning across panes', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-note-links-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof openNoteLinkDialog === 'function' && !document.querySelector('script[data-app-src]'));
    await page.locator('#section-today').waitFor({ state: 'visible' });
    await page.evaluate(() => {
      notes.push({ id: 88001, type: 'note', title: '来源', content: '保留正文', parentId: null },
        { id: 88002, type: 'note', title: '目标 [特殊] *文字*', content: '# 开头\n\n' + Array.from({ length: 85 }, (_, i) => '段落 ' + i + '\n\n').join('')
          + ':::fold 隐藏章节\n## 内部标题\n\n内部正文\n:::\n\n' + '末尾正文\n\n'.repeat(20), parentId: null },
        { id: 88003, type: 'note', title: '分屏来源', content: '分屏正文', parentId: null });
      switchTab('notes'); selectNote(88001); switchNoteView('edit');
      const ta = document.getElementById('notesTextarea'); ta.setSelectionRange(ta.value.length, ta.value.length);
    });
    await page.getByRole('button', { name: '插入笔记跳转块', exact: true }).click();
    await page.locator('#noteLinkSearch').fill('目标');
    await expect(page.locator('#noteLinkTarget option')).toHaveCount(1);
    await page.locator('#noteLinkPosition').selectOption({ label: '内部标题' });
    await page.screenshot({ path: '.tmp-note-links-dialog.png' });
    await page.locator('#noteLinkInsert').click();
    const source = await page.evaluate(() => getActiveNote().content);
    expect(source).toContain('#note=88002&heading=');
    expect(source).toContain('保留正文');
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => switchNoteView('rich'));
      await expect(page.locator('#notesRichEditor .note-jump-block')).toHaveText('↗ 目标 [特殊] *文字* › 内部标题');
      await page.evaluate(() => {
        const host = document.getElementById('notesRichEditor');
        host.dispatchEvent(new Event('input', { bubbles: true }));
        switchNoteView('edit'); switchNoteView('preview');
      });
      await expect(page.locator('#notesPreview .note-jump-block')).toHaveCount(1);
    }
    await page.screenshot({ path: '.tmp-note-links-block.png' });
    await page.locator('#notesPreview .note-jump-block').click();
    await expect.poll(() => page.evaluate(() => activeNoteId)).toBe(88002);
    await expect(page.locator('#notesPreview details')).toHaveAttribute('open', '');
    await expect.poll(() => page.evaluate(() => {
      const host = document.getElementById('notesPreview');
      return Math.abs(host.querySelector('h2').getBoundingClientRect().top - host.getBoundingClientRect().top - 12);
    })).toBeLessThan(5);
    // Insert at a saved rich-editor caret after the modal takes focus.
    await page.evaluate(() => {
      selectNote(88001); switchNoteView('rich');
      const host = document.getElementById('notesRichEditor');
      const range = document.createRange(); range.selectNodeContents(host); range.collapse(false);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    await page.getByRole('button', { name: '插入笔记跳转块', exact: true }).click();
    await page.locator('#noteLinkTarget').selectOption('88002');
    await expect(page.locator('#noteLinkPosition')).toHaveValue('');
    await page.locator('#noteLinkInsert').click();
    await expect(page.locator('#notesRichEditor .note-jump-block')).toHaveCount(2);
    expect(await page.evaluate(() => getActiveNote().content)).toContain('](#note=88002)');
    await page.locator('#notesRichEditor .note-jump-block').last().click();
    await expect.poll(() => page.evaluate(() => document.getElementById('notesPreview').scrollTop)).toBe(0);
    // Insert a fold-title link from the secondary editor and follow it there.
    await page.evaluate(() => {
      selectNote(88001); setNotesImmersive(true); setNotesImmersiveSplit(true);
      selectNotesSplitNote(88003); setNotesSplitSecondaryMode('rich');
      const host = document.getElementById('notesSplitRichEditor');
      const range = document.createRange(); range.selectNodeContents(host); range.collapse(false);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      formatText('note-jump');
    });
    await page.locator('#noteLinkTarget').selectOption('88002');
    await page.locator('#noteLinkPosition').selectOption({ label: '折叠块：隐藏章节' });
    await page.locator('#noteLinkInsert').click();
    await expect(page.locator('#notesSplitRichEditor .note-jump-block')).toHaveCount(1);
    await page.locator('#notesSplitRichEditor .note-jump-block').click();
    await expect.poll(() => page.evaluate(() => notesSplitNoteId)).toBe('88002');
    expect(await page.evaluate(() => activeNoteId)).toBe(88001);
    await expect(page.locator('#notesSplitPreview details')).toHaveAttribute('open', '');
    // Invalid/deleted targets are handled without changing the current note.
    await page.evaluate(() => followNoteLink('#note=deleted'));
    expect(await page.evaluate(() => activeNoteId)).toBe(88001);
    await page.evaluate(async () => {
      setNotesImmersive(false);
      await saveDataDurable('study_notes_v2', notes);
      if (typeof StudyData !== 'undefined') await StudyData.flush();
    });
    await page.reload();
    await page.waitForFunction(() => typeof openNoteLinkDialog === 'function' && !document.querySelector('script[data-app-src]'));
    await page.evaluate(() => { switchTab('notes'); selectNote(88001); switchNoteView('preview'); });
    await expect(page.locator('#notesPreview .note-jump-block')).toHaveCount(2);
    // Renaming and moving the target do not break ID-based links.
    await page.evaluate(() => { findNoteByLooseId(88002).title = '已改名'; });
    await page.locator('#notesPreview .note-jump-block').first().click();
    await expect.poll(() => page.evaluate(() => activeNoteId)).toBe(88002);
    await expect(page.locator('#notesPreview h2')).toHaveText('内部标题');
    await page.evaluate(() => {
      // Footnotes use eager rendering; the same fold position must still work.
      const note = findNoteByLooseId(88002);
      note.content += '\n\n脚注[^1]\n\n[^1]: 说明';
      followNoteLink('#note=88002&heading=note-fold-title-0');
    });
    await expect(page.locator('#notesPreview details')).toHaveAttribute('open', '');
    await page.evaluate(() => followNoteLink('#note=88002&heading=removed'));
    await expect.poll(() => page.evaluate(() => document.getElementById('notesPreview').scrollTop)).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { switchNoteView('edit'); formatText('note-jump'); });
    await expect(page.locator('#noteLinkInsert')).toBeInViewport();
    await page.locator('#noteLinkSearch').fill('没有这种笔记');
    await expect(page.locator('#noteLinkInsert')).toBeDisabled();
    await page.screenshot({ path: '.tmp-note-links-mobile.png' });
    await page.keyboard.press('Escape');
    await expect(page.locator('#noteLinkOverlay')).toHaveCount(0);
  } finally {
    if (app) await app.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
});
