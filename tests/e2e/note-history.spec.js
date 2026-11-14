const { test, expect } = require('@playwright/test');
const path = require('node:path');

test.use({ channel: process.env.MST_TEST_BROWSER || undefined });

async function loadNotes(page) {
  await page.evaluate(() => {
    window.notes = JSON.parse(localStorage.getItem('test-notes') || '[{"id":1,"type":"note","title":"原标题","content":"旧正文"}]');
    window.activeNoteId = 1;
    window.notesUndoStack = [];
    window.notesRedoStack = [];
    window.loadData = () => [];
    window.saveData = () => {
      localStorage.setItem('test-notes', JSON.stringify(notes));
      return true;
    };
    window.saveDataDurable = async () => saveData();
  });
  for (const file of ['note-history', 'notes', 'ai-tools']) {
    await page.addScriptTag({ path: path.resolve('js', file + '.js') });
  }
  await page.evaluate(() => {
    window.renderNotes = () => {};
    window.renderNoteList = () => {};
  });
}

test.beforeEach(async ({ page }) => {
  const url = 'http://localhost:12345/note-history-test';
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<input id="noteTitleInput"><div id="notesStatus"></div>' }));
  await page.goto(url);
});

test('manual and AI note snapshots remain readable after reload', async ({ page }) => {
  await loadNotes(page);
  const original = await page.evaluate(async () => {
    document.getElementById('noteTitleInput').value = '手动改标题';
    await commitNoteTitleChange();
    await executeToolCallStructured('update_note', { id: 1, content: 'AI 改正文' });
    return (await executeToolCallStructured('list_note_history', { id: 1 })).data.items;
  });
  expect(original).toHaveLength(2);
  expect(original.every(item => item.stack === 'undo')).toBe(true);

  await page.reload();
  await loadNotes(page);
  const after = await page.evaluate(async () => {
    const result = await executeToolCallStructured('list_note_history', { id: 1 });
    const snapshots = await Promise.all(result.data.items.map(({ snapshotId }) =>
      executeToolCallStructured('get_note_history', { id: 1, snapshotId })));
    return {
      current: notes[0],
      undoCount: notesUndoStack.length,
      items: result.data.items,
      snapshots: snapshots.map(result => result.data)
    };
  });
  expect(after.current).toMatchObject({ title: '手动改标题', content: 'AI 改正文' });
  expect(after.undoCount).toBe(0);
  expect(after.items).toEqual(original.map(item => ({ ...item, stack: 'history' })));
  expect(after.snapshots).toMatchObject([
    { title: '手动改标题', content: '旧正文', action: 'update_note' },
    { title: '原标题', content: '旧正文', action: null }
  ]);
});

test('local history enforces age, per-note and storage limits', async ({ page }) => {
  await page.addScriptTag({ path: path.resolve('js/note-history.js') });
  const result = await page.evaluate(async () => {
    const now = Date.now();
    const record = (noteId, content, timestamp) => {
      const snapshot = { noteId, content, title: '标题', timestamp };
      return NoteHistory.record(snapshot).then(() => snapshot.snapshotId);
    };
    const expired = await record(1, '已过期', now - 8 * 86400000);
    const first = await record(1, '第一条', now - 100);
    for (let i = 0; i < 10; i++) await record(1, '正文', now + i);
    const count = (await NoteHistory.list(1)).length;
    const evicted = await NoteHistory.get(1, first);
    const old = await NoteHistory.get(1, expired);
    const large = 'x'.repeat(11 * 1024 * 1024);
    await record(2, large, now + 10);
    await record(3, large, now + 11);
    const sizes = await Promise.all([2, 3].map(id => NoteHistory.list(id).then(items => items.length)));
    localStorage.setItem('study_sync_account_id_v1', 'another-account');
    const otherAccount = (await NoteHistory.list(3)).length;
    return { count, evicted: Boolean(evicted), expired: Boolean(old), sizes, otherAccount };
  });
  expect(result).toEqual({ count: 10, evicted: false, expired: false, sizes: [0, 1], otherAccount: 0 });
});
