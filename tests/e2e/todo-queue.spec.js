const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
test('队列拖拽允许左右偏离、经过空隙和移出后返回，取消时不改排序', async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-queue-drag-'));
  let app;
  try {
    app = await electron.launch({args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'], env: {...process.env, MST_E2E: '1', MST_USER_DATA_PATH: profile}});
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof renderTodoQueue === 'function' && document.querySelector('#nav-today[aria-current="page"]'));
    await page.evaluate(() => {
      todos = Array.from({length: 4}, (_, i) => ({id: i + 301, text: '拖拽任务 ' + (i + 1), parentId: null, done: false, tags: [], createdAt: Date.now()}));
      saveData('study_todos_v2', todos);
      saveTodoQueue(todos.map(todo => todo.id));
      switchTab('today');
    });
    for (const side of ['left', 'right']) {
      await page.evaluate(() => { saveTodoQueue([301, 302, 303, 304]); renderTodoQueue(); });
      const rows = page.locator('.todo-queue-item');
      await rows.last().scrollIntoViewIfNeeded();
      // 给右侧留出真实的鼠标活动空间。
      await page.setViewportSize({width: 1600, height: 1000});
      const start = await page.locator('.todo-queue-grip').last().boundingBox();
      const a = await rows.first().boundingBox();
      const b = await rows.nth(1).boundingBox();
      const dropX = side === 'left' ? a.x - 96 : a.x + a.width + 96;
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
      await page.mouse.down();
      await page.mouse.move(start.x + start.width / 2, start.y - 12, {steps: 5});
      await expect(rows.last()).toHaveClass(/dragging/);
      await page.mouse.move(dropX, (a.y + a.height + b.y) / 2, {steps: 10});
      await page.mouse.move(dropX, (a.y + a.height + b.y) / 2);
      await expect(rows.nth(1)).toHaveClass(/drop-before/);
      await page.mouse.move(dropX, a.y - 30);
      await page.mouse.move(dropX, a.y - 30);
      await expect(page.locator('.todo-queue-item.drop-before, .todo-queue-item.drop-after')).toHaveCount(0);
      await page.mouse.move(dropX, a.y + 5, {steps: 5});
      await page.mouse.move(dropX, a.y + 5);
      await expect(rows.first()).toHaveClass(/drop-before/);
      await page.mouse.up();
      expect(await page.evaluate(() => loadTodoQueue())).toEqual([304, 301, 302, 303]);
    }
    const last = await page.locator('.todo-queue-item').last().boundingBox();
    await page.locator('.todo-queue-grip').first().dragTo(page.locator('.todo-queue-item').last(), {
      targetPosition: {x: last.width / 2, y: last.height - 4}
    });
    expect(await page.evaluate(() => loadTodoQueue())).toEqual([301, 302, 303, 304]);
    const grip = await page.locator('.todo-queue-grip').last().boundingBox();
    await page.mouse.move(grip.x + 8, grip.y + 8);
    await page.mouse.down();
    await page.mouse.move(grip.x + 8, grip.y - 20, {steps: 5});
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(page.locator('.todo-queue-item.dragging')).toHaveCount(0);
    expect(await page.evaluate(() => loadTodoQueue())).toEqual([301, 302, 303, 304]);
  } finally {
    if (app) await app.close();
    await fs.rm(profile, {recursive: true, force: true});
  }
});

test('队列隐藏已完成：筛选后折叠、排序、持久化与完成状态更新', async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-queue-filter-'));
  let app;
  try {
    app = await electron.launch({args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'], env: {...process.env, MST_E2E: '1', MST_USER_DATA_PATH: profile}});
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof renderTodoQueue === 'function' && typeof renderCheckinCalendar === 'function' && document.querySelector('#nav-today[aria-current="page"]'));
    await page.evaluate(() => {
      todos = Array.from({length: 8}, (_, i) => ({id: i + 201, text: '筛选任务 ' + (i + 1), parentId: null, done: i < 2, tags: [], createdAt: Date.now()}));
      saveData('study_todos_v2', todos);
      saveTodoQueue(todos.map(todo => todo.id));
      switchTab('today');
    });
    const filter = page.locator('#todayTodoQueueHideDone');
    await expect(filter).toHaveAttribute('aria-pressed', 'false');
    await expect(filter).toHaveText('隐藏已完成');
    await filter.click();
    await expect(filter).toHaveAttribute('aria-pressed', 'true');
    await expect(filter).toHaveText('显示已完成');
    await expect(page.locator('.todo-queue-item')).toHaveCount(5);
    await expect(page.locator('.todo-queue-item.completed')).toHaveCount(0);
    await expect(page.locator('.todo-queue-item .focus-title')).toHaveText(['筛选任务 3', '筛选任务 4', '筛选任务 5', '筛选任务 6', '筛选任务 7']);
    await expect(page.locator('#todayTodoQueueCount')).toHaveText('6 / 8 项');
    await page.locator('#todayTodoQueueToggle').click();
    await expect(page.locator('.todo-queue-item')).toHaveCount(6);
    await page.locator('.todo-queue-grip').last().dragTo(page.locator('.todo-queue-grip').first());
    const order = await page.evaluate(() => loadTodoQueue());
    expect(order).toHaveLength(8);
    expect(order.slice(0, 2)).toEqual([201, 202]);
    expect(order.indexOf(208)).toBeLessThan(order.indexOf(203));
    await page.reload();
    await page.waitForFunction(() => typeof renderTodoQueue === 'function');
    await page.evaluate(() => switchTab('today'));
    await expect(filter).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.todo-queue-item')).toHaveCount(6);
    expect(await page.evaluate(() => loadTodoQueue())).toEqual(order);
    await page.evaluate(() => toggleTodo(208));
    await expect(page.locator('.todo-queue-item')).toHaveCount(5);
    await expect(page.locator('#todayTodoQueueToggle')).toBeHidden();
    await page.evaluate(() => toggleTodo(208));
    await expect(page.locator('.todo-queue-item')).toHaveCount(6);
    await page.evaluate(() => {
      todos.forEach(todo => { todo.done = true; });
      saveData('study_todos_v2', todos);
      renderTodos();
    });
    await expect(page.locator('.todo-queue-item')).toHaveCount(0);
    await expect(page.locator('.todo-queue-empty')).toContainText('均已完成');
    await expect(page.locator('[data-queue-fill]').first()).toBeDisabled();
    await filter.click();
    await expect(page.locator('.todo-queue-item.completed')).toHaveCount(8);
    expect(await page.evaluate(() => loadTodoQueue())).toEqual(order);
    await page.evaluate(() => { saveTodoQueue([]); renderTodoQueue(); });
    await filter.click();
    await expect(page.locator('.todo-queue-empty')).toContainText('加入待办队列');
  } finally {
    if (app) await app.close();
    await fs.rm(profile, {recursive: true, force: true});
  }
});

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
