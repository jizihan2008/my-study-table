const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('聚焦和队列共享进度状态、自定义选项并持久化原待办', async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-quick-status-'));
  let app;
  try {
    app = await electron.launch({args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'], env: {...process.env, MST_E2E: '1', MST_USER_DATA_PATH: profile}});
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof renderTodoQueue === 'function' && document.querySelector('#nav-today[aria-current="page"]'));
    await page.evaluate(() => {
      todos = [{id: 501, text: '进度任务', parentId: null, done: false, tags: []}];
      saveData('study_todos_v2', todos);
      saveData('study_today_focus', {days: {[getTodayStr()]: {items: [{todoId: 501, text: '进度任务', done: false}]}}});
      saveTodoQueue([501]);
      switchTab('today');
    });
    const focus = page.locator('#todayFocusList').getByLabel('待办状态');
    const queue = page.locator('#todayTodoQueueList').getByLabel('待办状态');
    await expect(focus).toHaveValue('');
    await focus.selectOption('刚开始');
    await expect(queue).toHaveValue('刚开始');
    await queue.selectOption('还未开始');
    await expect(focus).toHaveValue('还未开始');
    await queue.selectOption('已完成');
    await expect(focus).toHaveValue('已完成');
    expect(await page.evaluate(() => ({done: findTodo(501).done, completedAt: findTodo(501).completedAt}))).toEqual({done: false, completedAt: undefined});
    await page.evaluate(() => {
      localStorage.setItem('study_todo_statuses', JSON.stringify([{name: '等待反馈', color: '#123456'}]));
      invalidateStatusOptionsCache();
      renderFocusList(); renderTodoQueue();
    });
    await expect(focus.locator('option:checked')).toContainText('已完成');
    await focus.selectOption('等待反馈');
    await expect(queue).toHaveValue('等待反馈');
    await page.evaluate(async () => { await window.StudyData?.flush(); });
    await page.reload();
    await page.waitForFunction(() => typeof renderTodoQueue === 'function');
    await page.evaluate(() => switchTab('today'));
    await expect(focus).toHaveValue('等待反馈');
    await expect(queue).toHaveValue('等待反馈');
    await queue.selectOption('');
    await expect(focus).toHaveValue('');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('study_todos_v2'))[0].status)).toBeNull();
    await page.setViewportSize({width: 390, height: 844});
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    expect(await focus.evaluate(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth; })).toBe(true);
  } finally {
    if (app) await app.close();
    await fs.rm(profile, {recursive: true, force: true});
  }
});
