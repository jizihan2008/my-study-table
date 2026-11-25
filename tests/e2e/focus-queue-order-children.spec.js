const { test, expect } = require('@playwright/test');
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

test('聚焦跨日期拖拽保存顺序，队列展开多级子任务并同步完成状态', async () => {
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
        { id: 902, text: '子任务', parentId: 901, done: false, tags: [] },
        { id: 903, text: '孙任务', parentId: 902, done: false, tags: [] },
        { id: 904, text: '另一任务', parentId: null, done: false, tags: [] },
      ];
      saveData('study_todos_v2', todos);
      saveFocusData({ days: Object.fromEntries([0, 1].map(offset => [getFocusDateByOffset(offset), { items: [901, 904].map(todoId => ({ todoId, done: false })) }])) });
      saveTodoQueue([901, 904]);
      switchTab('today');
    });
    const order = () => page.evaluate(() => getSelectedFocusItems().items.map(item => item.todoId));
    const grips = page.locator('#todayFocusList .focus-sort-grip');
    await grips.nth(1).dragTo(grips.nth(0));
    expect(await order()).toEqual([904, 901]);
    await page.evaluate(() => selectFocusDay(1));
    expect(await order()).toEqual([901, 904]);
    await grips.nth(1).dragTo(grips.nth(0));
    expect(await order()).toEqual([904, 901]);
    await page.evaluate(() => selectFocusDay(0));
    const parent = page.locator('.todo-queue-item[data-todo-id="901"]');
    await parent.getByRole('button', { name: '展开/折叠子任务' }).click();
    const child = page.locator('[data-queue-child-id="902"]');
    await expect(child).toBeVisible();
    await child.getByRole('button', { name: '展开/折叠子任务' }).click();
    const grandchild = page.locator('[data-queue-child-id="903"]');
    await expect(grandchild).toBeVisible();
    await grandchild.getByRole('checkbox').click();
    expect(await page.evaluate(() => findTodo(903).done)).toBe(true);
    await page.locator('#todayTodoQueueHideDone').click();
    await expect(grandchild).toHaveCount(0);
    await page.locator('#todayTodoQueueHideDone').click();
    await expect(grandchild.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
    await expect(grandchild.getByTitle('添加到今日聚焦')).toBeDisabled();
    await expect(grandchild.getByTitle('添加到明日聚焦')).toBeDisabled();
    await child.getByTitle('添加到今日聚焦').click();
    expect(await order()).toEqual([904, 901, 902]);
    await child.getByTitle('添加到今日聚焦').click();
    expect(await order()).toEqual([904, 901, 902]);
    await child.getByTitle('添加到明日聚焦').click();
    expect(await order()).toEqual([904, 901, 902]);
    expect(await page.evaluate(() => selectedFocusDate === getFocusDateByOffset(1))).toBe(true);
    await page.locator('.todo-queue-item[data-todo-id="904"] .todo-queue-grip').dragTo(parent.locator('.todo-queue-grip'));
    expect(await page.evaluate(() => loadTodoQueue())).toEqual([904, 901]);
    await expect(child).toBeVisible();
    await page.evaluate(async () => { if (window.StudyData?.flush) await window.StudyData.flush(); });
    await page.reload();
    await page.waitForFunction(() => typeof renderTodoQueue === 'function');
    await page.evaluate(() => switchTab('today'));
    expect(await order()).toEqual([904, 901, 902]);
    await page.evaluate(() => selectFocusDay(1));
    expect(await order()).toEqual([904, 901, 902]);
    expect(await page.evaluate(() => loadTodoQueue())).toEqual([904, 901]);
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
