'use strict';

const { test, expect } = require('@playwright/test');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
let server, baseUrl;
test.use({ channel: 'chrome' });
test.beforeAll(async () => {
  server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html lang="zh-CN"><body><h2>归档</h2><div id="archiveContainer"></div><h2>回收站</h2><div id="trashContainer"></div></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

async function mount(page) {
  await page.addStyleTag({ path: path.join(root, 'css/style.css') });
  await page.addScriptTag({ path: path.join(root, 'lib/lucide/lucide.min.js') });
  await page.evaluate(() => {
    window.escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    window.formatDate = date => date.toLocaleDateString();
    window.saveData = (key, value) => { localStorage.setItem(key, JSON.stringify(value)); return true; };
    document.documentElement.style.cssText = '--card:#fff;--text:#222;--text-secondary:#667085;--input-bg:#eee;--hover-bg:#e8eef9;--primary:#4f6ef7;--border:#ddd';
    document.body.style.cssText = 'padding:24px;max-width:900px;margin:auto;background:#f5f7fb';
  });
  await page.addScriptTag({ path: path.join(root, 'js/trash.js') });
  await page.evaluate(() => { renderArchive(); renderTrash(); });
}

test('archive and trash trees fold independently and preserve nested folds after reload', async ({ page }) => {
  await page.goto(baseUrl);
  await page.evaluate(() => {
    const notes = [
      { id: 1, title: '根文件夹', type: 'folder' },
      { id: 2, title: '子文件夹', type: 'folder', parentId: 1 },
      { id: 3, title: '深层笔记', type: 'note', parentId: 2 },
      { id: 4, title: '独立笔记', type: 'note' }
    ].map(item => ({ ...item, archivedAt: '2026-10-10', deletedAt: '2026-10-10' }));
    localStorage.setItem('study_notes_archive', JSON.stringify(notes));
    localStorage.setItem('study_notes_trash', JSON.stringify(notes));
    localStorage.setItem('study_todos_archive', JSON.stringify([
      { id: 1, text: '父待办', archivedAt: '2026-10-10' },
      { id: 2, text: '子待办', parentId: 1, archivedAt: '2026-10-10' }
    ]));
  });
  await mount(page);
  const archiveNotes = page.locator('#archiveContainer .trash-module-section').filter({ hasText: '根文件夹' });
  const trashNotes = page.locator('#trashContainer .trash-module-section');
  const archiveTodos = page.locator('#archiveContainer .trash-module-section').filter({ hasText: '父待办' });
  await expect(archiveNotes.locator('.trash-item')).toHaveCount(4);
  await archiveNotes.locator('.stored-tree-toggle').nth(1).click();
  await expect(archiveNotes.locator('.trash-item')).toHaveCount(3);
  await archiveNotes.locator('.stored-tree-toggle').first().click();
  await expect(archiveNotes.locator('.trash-item')).toHaveCount(2);
  await expect(archiveNotes.locator('.stored-tree-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(trashNotes.locator('.trash-item')).toHaveCount(4);
  await expect(archiveTodos.locator('.trash-item')).toHaveCount(2);
  await archiveTodos.locator('.stored-tree-toggle').click();
  await expect(archiveTodos.locator('.trash-item')).toHaveCount(1);
  // Native button keyboard support must work alongside pointer interaction.
  await trashNotes.locator('.stored-tree-toggle').first().focus();
  await page.keyboard.press('Enter');
  await expect(trashNotes.locator('.trash-item')).toHaveCount(2);
  await page.reload();
  await mount(page);
  await expect(archiveNotes.locator('.trash-item')).toHaveCount(2);
  await archiveNotes.locator('.stored-tree-toggle').first().click();
  await expect(archiveNotes.locator('.trash-item')).toHaveCount(3);
  await expect(archiveNotes).not.toContainText('深层笔记');
  await expect(trashNotes.locator('.trash-item')).toHaveCount(2);
  await page.screenshot({ path: path.join(root, 'test-results/archive-trash-folding.png'), fullPage: true });
});
