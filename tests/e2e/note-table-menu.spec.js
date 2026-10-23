const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let app, page, userDataPath;
const source = '前文\n\n| 首表 |\n| --- |\n| 不改动 |\n\n| 标题 A | 标题 B |\n| --- | --- |\n| **甲**<br>乙 | 保留 |\n| 丙 | 丁 |\n\n后文';
test.beforeAll(async () => {
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-table-menu-'));
  app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
  page = await app.firstWindow();
  await page.waitForFunction(() => document.querySelector('#section-today.active') && !document.querySelector('script[data-app-src]'));
});
test.afterAll(async () => {
  await app?.close();
  if (userDataPath) await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
async function setup(secondary, mode, content = source, same = false) {
  await page.evaluate(({ secondary, mode, content, same }) => {
    closeNoteAiExplainMenu(); setNotesImmersiveSplit(false); setNotesImmersive(false); switchTab('notes');
    notes = [{ id: 'table-main', type: 'note', title: '主栏', content }, { id: 'table-second', type: 'note', title: '右栏', content }];
    activeNoteId = 'table-main'; notesSplitNoteId = same ? 'table-main' : 'table-second';
    noteViewMode = secondary ? 'preview' : mode; notesSplitMode = secondary ? mode : 'preview';
    renderNotes(); setNotesImmersive(true); setNotesImmersiveSplit(true);
    notesUndoStack = []; notesRedoStack = []; getSelection().removeAllRanges();
  }, { secondary, mode, content, same });
  return secondary ? mode === 'rich' ? '#notesSplitRichEditor' : '#notesSplitPreview' : mode === 'rich' ? '#notesRichEditor' : '#notesPreview';
}
const current = secondary => page.evaluate(secondary => (secondary ? findNoteByLooseId(notesSplitNoteId) : getActiveNote()).content, secondary);

for (const secondary of [false, true]) for (const mode of ['preview', 'rich']) {
  test(`${secondary ? 'split' : 'main'} ${mode} right-click row and column actions target the clicked table and support undo/redo`, async () => {
    for (const action of ['row-before', 'row-after', 'column-before', 'column-after', 'delete-row', 'delete-column']) {
      const host = await setup(secondary, mode);
      // The previously focused cell belongs to a different table.
      await page.locator(host + ' table').first().locator('td').click();
      await expect(page.locator('.note-table-toolbar')).toHaveCount(0);
      await page.locator(host + ' table').last().locator('td').filter({ hasText: /^丁$/ }).click({ button: 'right' });
      const item = page.locator('#noteTableMenuActions [data-table-action="' + action + '"]');
      await expect(item).toBeVisible();
      await item.click();
      const table = page.locator(host + ' table').last();
      await expect(table.locator('tr')).toHaveCount(action.startsWith('row-') ? 4 : action === 'delete-row' ? 2 : 3);
      await expect(table.locator('th')).toHaveCount(action.startsWith('column-') ? 3 : action === 'delete-column' ? 1 : 2);
      await expect(page.locator(host + ' table').first().locator('td')).toHaveText('不改动');
      const changed = await current(secondary);
      expect(changed).toContain('**甲**<br>乙'); expect(changed).toContain('前文'); expect(changed).toContain('后文');
      expect(await page.evaluate(secondary => findNoteByLooseId(secondary ? 'table-main' : 'table-second').content, secondary)).toBe(source);
      expect(await page.evaluate(() => notesUndoStack.length)).toBe(1);
      await page.keyboard.press('Control+z'); expect(await current(secondary)).toBe(source);
      await page.keyboard.press('Control+y'); expect(await current(secondary)).toBe(changed);
    }
  });
  test(`${secondary ? 'split' : 'main'} ${mode} table inside a fold keeps fold deletion beside table actions`, async () => {
    const host = await setup(secondary, mode, ':::fold 表格折叠\n| A | B |\n| --- | --- |\n| 内容 | 留下 |\n:::');
    await page.locator(host + ' details').evaluate(fold => { fold.open = true; });
    await page.locator(host + ' td').first().click({ button: 'right' });
    await expect(page.locator('#noteFoldDelete')).toBeVisible();
    await page.locator('#noteTableMenuActions [data-table-action="row-after"]').click();
    await expect(page.locator(host + ' tbody tr')).toHaveCount(2);
    expect(await current(secondary)).toContain(':::fold 表格折叠');
    await page.keyboard.press('Control+z');
    expect(await current(secondary)).toContain('| 内容 | 留下 |');
  });
}

test('same-note split reading actions update the rich editor and saved content survives reload', async () => {
  await setup(true, 'preview', source, true);
  await page.evaluate(() => setNotesSplitPrimaryMode('rich'));
  await page.locator('#notesSplitPreview table').last().locator('th').first().click({ button: 'right' });
  await page.locator('#noteTableMenuActions [data-table-action="column-before"]').click();
  await expect(page.locator('#notesRichEditor table').last().locator('th')).toHaveCount(3);
  await expect(page.locator('#notesStatus')).toHaveText('已保存');
  const changed = await current(true);
  await page.reload();
  await page.waitForFunction(() => typeof editNoteTableFromMenu === 'function' && !document.querySelector('script[data-app-src]'));
  expect(await page.evaluate(() => findNoteByLooseId('table-main').content)).toBe(changed);
});

test('deleting the only column removes the table and ordinary text hides table actions', async () => {
  const host = await setup(false, 'rich', '| 唯一列 |\n| --- |\n| 内容 |');
  await page.locator(host + ' td').click({ button: 'right' });
  await page.locator('#noteTableMenuActions [data-table-action="delete-column"]').click();
  await expect(page.locator(host + ' table')).toHaveCount(0);
  await page.keyboard.press('Control+z'); await expect(page.locator(host + ' table')).toHaveCount(1);
  await setup(false, 'rich');
  await page.locator('#notesRichEditor > p').first().evaluate(paragraph => {
    const range = document.createRange(); range.selectNodeContents(paragraph); getSelection().removeAllRanges(); getSelection().addRange(range);
    paragraph.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
  });
  await expect(page.locator('#noteTableMenuActions')).toBeHidden();
});
