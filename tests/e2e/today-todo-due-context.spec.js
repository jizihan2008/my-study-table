const { test, expect } = require('@playwright/test');
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

test('今天页面右键修改截止日期并持久化', async () => {
  const root = path.resolve('.');
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      const data = await fs.readFile(file);
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ serviceWorkers: 'block' });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => typeof renderTodoQueue === 'function' && document.querySelector('#nav-today[aria-current="page"]'));
    await page.evaluate(() => {
      todos = [
        { id: 901, text: '父任务', parentId: null, done: false, tags: [] },
        { id: 902, text: '子任务', parentId: 901, done: false, tags: [], dueDate: '2030-01-01' },
      ];
      saveData('study_todos_v2', todos);
      saveFocusData({ days: { [getTodayStr()]: { items: [{ todoId: 901, done: false }] } } });
      saveTodoQueue([901]);
      switchTab('today');
    });
    const menu = page.locator('#todayTodoContextMenu');
    const input = page.locator('#todayTodoDueDate');
    const save = page.locator('#editModalBody .btn-save-modal');
    const queue = page.locator('.todo-queue-item[data-todo-id="901"]');
    const focus = page.locator('#todayFocusList [data-focus-id="901"] > .today-focus-item');
    await queue.click({ button: 'right' });
    await menu.getByText('设置截止日期').click();
    await expect(input).toHaveValue('');
    await input.fill('2031-02-03');
    await save.click();
    for (const row of [queue, focus]) await expect(row.locator('.today-todo-due')).toContainText('2031-02-03');
    await focus.click({ button: 'right' });
    await menu.getByText('设置截止日期').click();
    await expect(input).toHaveValue('2031-02-03');
    await input.fill('2032-03-04');
    await input.press('Enter');
    await expect(queue.locator('.today-todo-due')).toContainText('2032-03-04');
    await queue.getByRole('button', { name: '展开/折叠子任务' }).click();
    const child = page.locator('[data-queue-child-id="902"]');
    await child.click({ button: 'right' });
    await menu.getByText('设置截止日期').click();
    await expect(input).toHaveValue('2030-01-01');
    await input.fill('2033-04-05');
    await save.click();
    expect(await page.evaluate(() => findTodo(901).dueDate)).toBe('2032-03-04');
    await focus.getByTitle('展开/折叠', { exact: true }).click();
    const focusChild = page.locator('#todayFocusList [data-sync-id="focus-902"] > .today-focus-item');
    await expect(focusChild.locator('.today-todo-due')).toContainText('2033-04-05');
    await focusChild.click({ button: 'right' });
    await menu.getByText('设置截止日期').click();
    await input.fill('');
    await save.click();
    await expect(child.locator('.today-todo-due')).toHaveCount(0);
    await expect(focusChild.locator('.today-todo-due')).toHaveCount(0);
    await queue.click({ button: 'right' });
    await page.keyboard.press('Escape');
    await expect(menu).not.toHaveClass(/visible/);
    await page.evaluate(async () => { if (window.StudyData?.flush) await window.StudyData.flush(); });
    await page.reload();
    await page.waitForFunction(() => typeof renderTodoQueue === 'function');
    expect(await page.evaluate(() => todos.map(todo => todo.dueDate))).toEqual(['2032-03-04', null]);
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
