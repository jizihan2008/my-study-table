const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('AI note citations select exact UTF-16 source, survive reload and reject stale offsets', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-note-reference-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof getNoteReferenceRevision === 'function' && !document.querySelector('script[data-app-src]'));
    await page.locator('#section-today').waitFor({ state: 'visible' });
    const citation = await page.evaluate(async () => {
      const content = '# 引用测试\n\n' + '较长的正文用于滚动检查。'.repeat(200) + '\n\n:::fold 隐藏内容\n😀目标片段\n:::\n';
      notes.push({ id: 88991, type: 'note', title: '引用测试', content, parentId: null });
      const offset = content.indexOf('😀目标片段');
      const result = await executeToolCallStructured('get_note_detail', { id: 88991, offset, limit: 7 });
      if (!result.ok) throw new Error(result.text);
      await saveDataDurable('study_notes_v2', notes);
      if (typeof StudyData !== 'undefined') await StudyData.flush();
      return { href: result.data.referenceLink, revision: result.data.contentRevision, offset, text: result.data.content };
    });
    expect(citation.text).toBe('😀目标片段\n');
    async function clickCitation() {
      await page.evaluate(href => {
        switchTab('ai');
        document.getElementById('aiMessages').innerHTML = formatAiContent('[查看原文](' + href + ')');
      }, citation.href);
      await page.locator('#aiMessages a[href^="#note="]').click();
    }
    await clickCitation();
    await expect(page.locator('#notesTextarea')).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const ta = document.getElementById('notesTextarea');
      return ta.value.slice(ta.selectionStart, ta.selectionEnd);
    })).toBe(citation.text);
    expect(await page.locator('#notesTextarea').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await page.reload();
    await page.waitForFunction(() => typeof getNoteReferenceRevision === 'function' && !document.querySelector('script[data-app-src]'));
    expect(await page.evaluate(() => getNoteReferenceRevision(notes.find(n => n.id === 88991)))).toBe(citation.revision);
    await clickCitation();
    await expect.poll(() => page.locator('#notesTextarea').evaluate(el => el.selectionStart)).toBe(citation.offset);
    const stale = await page.evaluate(href => {
      notes.find(n => n.id === 88991).content = '新增内容' + notes.find(n => n.id === 88991).content;
      let message = '';
      const original = showMiniToast;
      showMiniToast = text => { message = text; };
      try { followNoteLink(href); } finally { showMiniToast = original; }
      return message;
    }, citation.href);
    expect(stale).toContain('笔记已修改');
    expect(await page.evaluate(() => StudyMarkdown.render('[坏链接](#note=88991&offset=-1)').includes('href='))).toBe(false);
  } finally { if (app) await app.close(); await fs.rm(userDataPath, { recursive: true, force: true }); }
});
