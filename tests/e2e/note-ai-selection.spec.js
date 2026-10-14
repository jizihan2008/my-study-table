const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('note explanation captures source offsets in reading, rich editing, source and split panes', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-note-selection-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof aiExplainSelection === 'function' && typeof getTodayStr === 'function' && typeof sendAiMessage === 'function' && typeof escapeHtml === 'function' && !document.querySelector('script[data-app-src]'));
    await page.evaluate(() => {
      const content = '# 标题\n\n重复 **文字**，😀第二段。\n\n重复 **文字**，😀第二段。';
      notes.push({ id: 99001, type: 'note', title: '选区测试', content, parentId: null },
        { id: 99002, type: 'note', title: '分屏选区', content, parentId: null });
      switchTab('notes'); selectNote(99001);
      window.sentExplanations = [];
      window.sendAiMessage = () => sentExplanations.push(document.getElementById('aiInput').value);
    });
    for (const surface of ['notesPreview', 'notesRichEditor', 'notesSplitPreview', 'notesSplitRichEditor']) {
      const result = await page.evaluate(surface => {
        const host = document.getElementById(surface);
        const secondary = surface.startsWith('notesSplit');
        notesSplitNoteId = '99002';
        const note = notes.find(n => n.id === (secondary ? 99002 : 99001));
        host.innerHTML = formatNoteContent(note.content);
        const p = host.querySelectorAll('p')[1];
        const range = document.createRange();
        // Element boundaries must work, including selections crossing Markdown formatting.
        range.setStart(p, 0); range.setEnd(p, 2);
        getSelection().removeAllRanges(); getSelection().addRange(range);
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 });
        p.dispatchEvent(event);
        const menu = document.getElementById('noteAiExplainMenu');
        const result = { prevented: event.defaultPrevented, text: menu.dataset.text,
          start: Number(menu.dataset.srcStart), end: Number(menu.dataset.srcEnd), noteId: menu.dataset.noteId,
          expectedStart: note.content.lastIndexOf('重复'), expectedEnd: note.content.lastIndexOf('文字') + 2 };
        return result;
      }, surface);
      expect(result.prevented).toBe(true);
      expect(result.text).toBe('重复 文字');
      expect(result.start).toBe(result.expectedStart);
      expect(result.end).toBe(result.expectedEnd);
      await page.locator('#noteAiExplainMenu .context-menu-item').first().dispatchEvent('click');
      await expect.poll(() => page.evaluate(() => sentExplanations.length)).toBe(['notesPreview', 'notesRichEditor', 'notesSplitPreview', 'notesSplitRichEditor'].indexOf(surface) + 1);
      const prompt = await page.evaluate(() => sentExplanations.at(-1));
      expect(prompt).toContain('offset=' + result.start + '，endOffset=' + result.end);
      expect(prompt).toContain('笔记ID：' + result.noteId);
      expect(prompt).toContain('⟪⟫重复 文字⟪⟫');
    }
    const edited = await page.evaluate(() => {
      switchTab('notes'); switchNoteView('rich');
      const host = document.getElementById('notesRichEditor');
      host.querySelector('p').prepend(document.createTextNode('新编辑😀'));
      host.dispatchEvent(new Event('input', { bubbles: true }));
      const note = getActiveNote();
      const p = host.querySelectorAll('p')[1];
      const range = document.createRange(); range.selectNodeContents(p.querySelector('strong'));
      getSelection().removeAllRanges(); getSelection().addRange(range);
      p.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      const menu = document.getElementById('noteAiExplainMenu');
      return { start: Number(menu.dataset.srcStart), expected: note.content.lastIndexOf('文字'), content: note.content };
    });
    expect(edited.content).toContain('新编辑😀');
    expect(edited.start).toBe(edited.expected);
    const mathOffset = await page.evaluate(() => {
      const note = getActiveNote(); note.content = '$x$ x';
      RichNoteEditor.setMarkdown(note.content, note.id);
      const host = document.getElementById('notesRichEditor');
      const p = host.querySelector('p');
      const node = Array.from(p.childNodes).findLast(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
      const range = document.createRange(); range.setStart(node, node.textContent.lastIndexOf('x')); range.setEnd(node, node.textContent.lastIndexOf('x') + 1);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      p.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      const menu = document.getElementById('noteAiExplainMenu');
      return { text: menu.dataset.text, start: Number(menu.dataset.srcStart), end: Number(menu.dataset.srcEnd) };
    });
    expect(mathOffset).toEqual({ text: 'x', start: 4, end: 5 });
    const unsupported = await page.evaluate(() => {
      const note = getActiveNote(); note.content = 'A &amp; B';
      RichNoteEditor.setMarkdown(note.content, note.id);
      const host = document.getElementById('notesRichEditor');
      const range = document.createRange(); range.selectNodeContents(host.querySelector('p'));
      getSelection().removeAllRanges(); getSelection().addRange(range);
      host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      return Number(document.getElementById('noteAiExplainMenu').dataset.srcStart);
    });
    expect(unsupported).toBe(-1);
    const source = await page.evaluate(() => {
      const ta = document.getElementById('notesTextarea');
      ta.value = '😀前文  选中文字  后文';
      ta.setSelectionRange(4, 12);
      ta.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      const menu = document.getElementById('noteAiExplainMenu');
      return { text: menu.dataset.text, start: Number(menu.dataset.srcStart), end: Number(menu.dataset.srcEnd) };
    });
    expect(source).toEqual({ text: '选中文字', start: 6, end: 10 });
    const outside = await page.evaluate(() => {
      closeNoteAiExplainMenu();
      const host = document.getElementById('notesRichEditor');
      const range = document.createRange(); range.selectNodeContents(document.body);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      host.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(outside).toBe(false);
  } finally {
    await app?.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
});
