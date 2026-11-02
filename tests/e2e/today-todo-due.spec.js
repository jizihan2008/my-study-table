const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('首页聚焦和队列显示原任务截止日期并响应清除', async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-due-'));
  let app;
  try {
    app = await electron.launch({args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'], env: {...process.env, MST_E2E: '1', MST_USER_DATA_PATH: profile}});
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof renderTodoQueue === 'function' && document.querySelector('#nav-today[aria-current="page"]'));
    await page.evaluate(() => {
      todos = [{id: 501, text: '截止日期任务', parentId: null, done: false, tags: [], dueDate: '2020-01-01'}];
      saveData('study_todos_v2', todos);
      saveData('study_today_focus', {days: {[getTodayStr()]: {items: [{todoId: 501, done: false}]}}});
      saveTodoQueue([501]);
      switchTab('today');
    });
    for (const list of ['#todayFocusList', '#todayTodoQueueList']) {
      await expect(page.locator(list + ' .today-todo-due')).toHaveText('📅 截止 2020-01-01（已逾期）');
      await expect(page.locator(list + ' .today-todo-due')).toHaveClass(/overdue/);
    }
    await page.setViewportSize({width: 390, height: 844});
    expect(await page.locator('.today-todo-due').evaluateAll(els => els.every(el => el.getBoundingClientRect().right <= innerWidth))).toBe(true);
    await page.evaluate(() => { findTodo(501).dueDate = getTodayStr(); renderFocusList(); renderTodoQueue(); });
    await expect(page.locator('.today-todo-due.overdue')).toHaveCount(0);
    await expect(page.locator('.today-todo-due')).toHaveCount(2);
    await page.evaluate(() => { findTodo(501).dueDate = null; renderFocusList(); renderTodoQueue(); });
    await expect(page.locator('.today-todo-due')).toHaveCount(0);
  } finally {
    if (app) await app.close();
    await fs.rm(profile, {recursive: true, force: true});
  }
});
