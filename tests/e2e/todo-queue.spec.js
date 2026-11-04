const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('待办右键批量操作使用勾选集合，父子同时选中时只移动一次', async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-todo-batch-'));
  let app;
  try {
    app = await electron.launch({args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'], env: {...process.env, MST_E2E: '1', MST_USER_DATA_PATH: profile}});
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof showTodoContextMenu === 'function' && document.querySelector('#nav-today[aria-current="page"]'));
    await page.evaluate(() => {
      todos = [501, 502, 503, 504, 505].map(id => ({
        id, text: '测试待办 ' + id, parentId: id === 502 ? 501 : null, done: false, tags: [],
      }));
      expandedTodoIds.add(501);
      saveData('study_todos_v2', todos);
      saveTodoQueue([501]);
      saveFocusData({_date: getTodayStr(), items: [{todoId: 505}, {todoId: 501}]});
      switchTab('todo');
      renderTodos();
    });
    const row = id => page.locator(`#todoTree li[data-id="${id}"] > .todo-item`);
    const select = id => row(id).locator('.todo-multi-check').click();
    const menu = page.locator('#todoContextMenu');
    const openMenu = id => row(id).locator('.todo-text').click({button: 'right'});
    const act = label => menu.getByText(label, {exact: true}).click();

    await page.locator('#todoSelectBtn').click();
    for (const id of [501, 502, 503]) await select(id);
    await openMenu(504);
    await expect(menu.getByText('添加子任务')).toBeHidden();
    await act('批量加入待办队列');
    expect(await page.evaluate(() => loadTodoQueue())).toEqual([501, 502, 503]);

    await openMenu(501);
    await expect(menu.locator('#todoCtxSortItems')).toBeHidden();
    await act('批量添加到今日聚焦');
    expect(await page.evaluate(() => getTodayFocusItems().items.map(item => item.todoId))).toEqual([505, 501, 502]);
    await expect(page.getByText('另有 1 项因已达上限未添加', {exact: false})).toBeVisible();
    await openMenu(501);
    await act('批量添加到明日聚焦');
    expect(await page.evaluate(() => getFocusItemsForDate(getFocusDateByOffset(1)).items.map(item => item.todoId))).toEqual([501, 502, 503]);

    await openMenu(501);
    await act('批量编辑');
    const status = await page.locator('#batchEditStatus option').nth(2).getAttribute('value');
    await page.locator('#batchEditStatus').selectOption(status);
    await page.locator('#editModal .btn-save-modal').click();
    expect(await page.evaluate(() => todos.map(todo => todo.status ?? null)))
      .toEqual([status.slice(7), status.slice(7), status.slice(7), null, null]);

    await page.locator('#todoSelectBtn').click();
    for (const id of [502, 501, 503]) await select(id);
    await openMenu(504);
    await act('批量归档');
    await expect(page.locator('#confirmMsg')).toContainText('选中的 3 个待办');
    await page.locator('#confirmCancel').click();
    await expect(row(501)).toBeVisible();
    await openMenu(504);
    await act('批量归档');
    await page.locator('#confirmOk').click();
    expect(await page.evaluate(() => loadArchive('todos').map(todo => todo.id).sort())).toEqual([501, 502, 503]);
    await expect(row(504)).toBeVisible();

    await page.locator('#todoSelectBtn').click();
    for (const id of [504, 505]) await select(id);
    await openMenu(504);
    await act('批量删除');
    await page.locator('#confirmOk').click();
    expect(await page.evaluate(() => loadTrash('todos').map(todo => todo.id).sort())).toEqual([504, 505]);
  } finally {
    if (app) await app.close();
    await fs.rm(profile, {recursive: true, force: true});
  }
});

test('队列点击和键盘勾选同步原待办、子待办及今日聚焦，并持久化完成状态', async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-queue-complete-'));
  let app;
  try {
    app = await electron.launch({args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'], env: {...process.env, MST_E2E: '1', MST_USER_DATA_PATH: profile}});
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof renderTodoQueue === 'function' && document.querySelector('#nav-today[aria-current="page"]'));
    await page.evaluate(() => {
      todos = [
        {id: 401, text: '队列父任务', parentId: null, done: false, tags: [], createdAt: Date.now()},
        {id: 402, text: '队列子任务', parentId: 401, done: false, tags: [], createdAt: Date.now()}
      ];
      saveData('study_todos_v2', todos);
      saveData('study_today_focus', {days: {[getTodayStr()]: {items: [{todoId: 401, text: '队列父任务', done: false}]}}});
      saveTodoQueue([401, 402]);
      switchTab('today');
    });
    const parentCheck = page.locator('.todo-queue-item[data-todo-id="401"] [role="checkbox"]');
    await expect(parentCheck).toHaveAttribute('aria-checked', 'false');
    await parentCheck.click();
    await expect(parentCheck).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.todo-queue-item.completed')).toHaveCount(2);
    await expect(page.locator('#todayFocusCount')).toHaveText('1/1');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('study_todos_v2')).every(todo => todo.done && todo.completedAt === getTodayStr()))).toBe(true);
    expect(await page.evaluate(() => loadTodoQueue())).toEqual([401, 402]);
    await page.evaluate(async () => { if (window.StudyData?.flush) await window.StudyData.flush(); });
    await page.reload();
    await page.waitForFunction(() => typeof renderTodoQueue === 'function');
    await page.evaluate(() => switchTab('today'));
    await expect(parentCheck).toHaveAttribute('aria-checked', 'true');
    const focusCheck = page.locator('#todayFocusList [data-sync-id="focus-401"] > .today-focus-item [role="checkbox"]');
    await expect(focusCheck).toHaveAccessibleName('取消完成');
    await focusCheck.click();
    await expect(parentCheck).toHaveAttribute('aria-checked', 'false');
    await expect(focusCheck).toHaveAccessibleName('标记完成');
    await focusCheck.press('Space');
    await expect(parentCheck).toHaveAttribute('aria-checked', 'true');
    await focusCheck.press('Enter');
    await expect(parentCheck).toHaveAttribute('aria-checked', 'false');
    await focusCheck.click();
    await expect(focusCheck).toHaveAttribute('aria-checked', 'true');
    await page.evaluate(async () => { if (window.StudyData?.flush) await window.StudyData.flush(); });
    await page.reload();
    await page.waitForFunction(() => typeof renderTodoQueue === 'function');
    await page.evaluate(() => switchTab('today'));
    await expect(focusCheck).toHaveAttribute('aria-checked', 'true');
    await expect(parentCheck).toHaveAttribute('aria-checked', 'true');
    await parentCheck.focus();
    await parentCheck.press('Space');
    await expect(parentCheck).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#todayFocusCount')).toHaveText('0/1');
    expect(await page.evaluate(() => findTodo(402).done)).toBe(true);
    expect(await page.evaluate(() => findTodo(401).completedAt)).toBeUndefined();
    await page.locator('#todayTodoQueueHideDone').click();
    await expect(page.locator('.todo-queue-item')).toHaveCount(1);
    await parentCheck.focus();
    await parentCheck.press('Enter');
    await expect(page.locator('.todo-queue-item')).toHaveCount(0);
    await expect(page.locator('#todayTodoQueueCount')).toHaveText('0 / 2 项');
    await expect(page.locator('.todo-queue-empty')).toContainText('均已完成');
    expect(await page.evaluate(() => loadTodoQueue())).toEqual([401, 402]);
  } finally {
    if (app) await app.close();
    await fs.rm(profile, {recursive: true, force: true});
  }
});

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
    await page.waitForFunction(() => typeof renderTodoQueue === 'function' && document.getElementById('todoContextMenu') && document.querySelector('#nav-today[aria-current="page"]'));
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
