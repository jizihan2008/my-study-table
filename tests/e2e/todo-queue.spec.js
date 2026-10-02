const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
test('待办右键入队、折叠、拖拽和跨日聚焦', async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-queue-'));
  let app;
  try {
    app = await electron.launch({args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'], env: {...process.env, MST_E2E: '1', MST_USER_DATA_PATH: profile}});
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof renderTodoQueue === 'function' && document.querySelector('#nav-today[aria-current="page"]'));
    await page.evaluate(() => {
      todos = Array.from({length: 7}, (_,i) => ({id: i+101, text: '队列任务 '+(i+1), parentId:null, done:false, tags:[], createdAt:Date.now()}));
      saveData('study_todos_v2', todos); saveData('study_today_focus', {days:{}});
      for(const t of todos) { showTodoContextMenu(200,200,t.id); todoCtxAddQueue(); }
      switchTab('today');
    });
    await expect(page.locator('.today-right-column #todayTodoQueueCard')).toHaveCount(1);
    await expect(page.locator('.todo-queue-item')).toHaveCount(5);
    await expect(page.locator('#todayTodoQueueCount')).toHaveText('7 项');
    await page.locator('#todayTodoQueueToggle').click();
    await expect(page.locator('.todo-queue-item')).toHaveCount(7);
    await page.locator('.todo-queue-grip').nth(6).dragTo(page.locator('.todo-queue-grip').nth(0));
    const ids = await page.evaluate(() => loadTodoQueue());
    expect(ids.indexOf(107)).toBeLessThan(2);
    await page.locator('[data-queue-fill]').nth(0).click();
    expect(await page.evaluate(() => getTodayFocusItems().items.map(i=>i.todoId))).toEqual(ids.slice(0,3));
    await page.locator('.todo-queue-actions button').nth(1).click();
    expect(await page.evaluate(() => getFocusItemsForDate(getFocusDateByOffset(1)).items.length)).toBe(1);
    await page.locator('#todayTodoQueueToggle').click();
    await expect(page.locator('.todo-queue-item')).toHaveCount(5);
    await page.screenshot({path:'test-results/todo-queue.png', fullPage:true});
    await page.reload();
    await page.waitForFunction(() => typeof renderTodoQueue === 'function');
    await page.evaluate(() => switchTab('today'));
    await expect(page.locator('.todo-queue-item')).toHaveCount(5);
    expect(await page.evaluate(() => loadTodoQueue())).toEqual(ids);
    await expect(page.locator('#todayTodoQueueToggleLabel')).toHaveText('展开');
    await page.locator('#todayTodoQueueCard .today-focus-add-btn').click();
    await page.locator('#queueTodoPickerSearch').fill('队列任务 6');
    await expect(page.locator('#queueTodoPickerList .todo-picker-item')).toHaveCount(1);
    await expect(page.locator('#queueTodoPickerList .todo-picker-item')).toHaveClass(/selected/);
    await page.locator('#queueTodoPickerList .todo-picker-item').click();
    expect(await page.evaluate(() => loadTodoQueue().includes(106))).toBe(false);
    await page.locator('#queueTodoPickerList .todo-picker-item').click();
    expect(await page.evaluate(() => loadTodoQueue().includes(106))).toBe(true);
    await page.locator('#queueTodoPicker .todo-picker-close').click();
    await expect(page.locator('#queueTodoPicker')).toBeHidden();
    await page.screenshot({path:'test-results/todo-queue-picker.png', fullPage:true});

  } finally {
    if(app) await app.close();
    await fs.rm(profile, {recursive:true, force:true});
  }
});
