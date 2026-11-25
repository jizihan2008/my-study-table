const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test.use({ channel: process.env.MST_TEST_BROWSER || 'chrome', serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  const root = path.resolve(__dirname, '../..');
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'study-table.test') return route.abort();
    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404 });
    return route.fulfill({ path: file });
  });
  await page.goto('http://study-table.test/');
});

test('AI note citations open reading mode, reveal the cited fold, survive reload and reject stale offsets', async ({ page }) => {
  await page.waitForFunction(() => typeof getNoteReferenceRevision === 'function' && !document.querySelector('script[data-app-src]'));
  await page.locator('#section-today').waitFor({ state: 'visible' });
  const citation = await page.evaluate(async () => {
    const content = '# 引用测试\n\n' + '较长的正文用于滚动检查。\n\n'.repeat(90)
      + ':::fold 隐藏内容\n:::fold 嵌套内容\n😀目标片段 **重点** $x^2$\n:::\n:::\n\n' + '末尾正文\n\n'.repeat(20);
    notes.push({ id: 88991, type: 'note', title: '引用测试', content, parentId: null });
    const offset = content.indexOf('😀目标片段');
    const result = await executeToolCallStructured('get_note_detail', { id: 88991, offset, limit: 7 });
    if (!result.ok) throw new Error(result.text);
    await saveDataDurable('study_notes_v2', notes);
    if (typeof StudyData !== 'undefined') await StudyData.flush();
    return { href: result.data.referenceLink, revision: result.data.contentRevision, offset, text: result.data.content };
  });
  expect(citation.text).toBe('😀目标片段 ');
  async function clickCitation(label) {
    await page.evaluate(({ href, label }) => {
      switchTab('ai');
      document.getElementById('aiMessages').innerHTML = formatAiContent('见 [' + label + '](' + href + ')。');
    }, { href: citation.href, label });
    const link = page.locator('#aiMessages p').getByRole('link', { name: label, exact: true });
    await expect(link).toHaveAttribute('href', citation.href);
    await expect(link).toHaveCSS('display', 'inline-block');
    await link.click();
  }
  await clickCitation('目标片段中的公式');
  const target = page.locator('#notesPreview p').filter({ hasText: '😀目标片段' });
  async function expectReadingTarget() {
    await expect(page.locator('#notesPreview')).toBeVisible();
    await expect(page.locator('#notesTextarea')).toBeHidden();
    await expect(target).toBeInViewport();
    await expect(target.locator('strong')).toHaveText('重点');
    await expect(target.locator('.katex')).toBeVisible();
    expect(await page.locator('#notesPreview').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => noteViewMode)).toBe('preview');
    await expect(page.locator('#notesPreview details[open]')).toHaveCount(2);
  }
  await expectReadingTarget();
  await page.reload();
  await page.waitForFunction(() => typeof getNoteReferenceRevision === 'function' && !document.querySelector('script[data-app-src]'));
  expect(await page.evaluate(() => getNoteReferenceRevision(notes.find(n => n.id === 88991)))).toBe(citation.revision);
  await clickCitation('查看原文');
  await expectReadingTarget();
  // Eager rendering (footnotes/annotations) uses the same reading navigation.
  await page.evaluate(() => {
    const note = notes.find(n => n.id === 88991);
    note.content += '\n\n脚注[^1]\n\n[^1]: 说明';
    const start = note.content.indexOf('😀目标片段');
    followNoteLink('#note=88991&offset=' + start + '&endOffset=' + (start + 7));
  });
  await expectReadingTarget();
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
});
