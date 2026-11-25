const { test, expect } = require('@playwright/test');
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

test('多层子目标可添加、编辑、折叠、刷新和关联计时，删除覆盖整个分支', async () => {
  test.setTimeout(60000);
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
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => typeof showAddSubGoalInput === 'function' && document.querySelector('#nav-today[aria-current="page"]'));
    await page.evaluate(() => {
      saveGoals([{ id: 901, text: '完成毕业设计', done: false, note: '保留旧备注', content: '旧目标说明' }]);
      window.goalHierarchySyncKeys = [];
      const original = Sync.onLocalChange;
      Sync.onLocalChange = function(key) { window.goalHierarchySyncKeys.push(key); return original.call(this, key); };
      renderGoals();
    });
    const row = id => page.locator(`[data-sync-id="goal-${id}"]`);
    await page.locator('#todayGoalsAddBtn').click();
    await page.locator('#todayGoalInput').fill('另一个顶层目标');
    await page.locator('#todayGoalInput').press('Enter');
    const names = ['研究阶段', '实验 <一>', '结果分析', '论文写作', '章节整理', '图表核对', '最终检查LongUnbrokenGoalName012345678901234567890123456789'];
    const ids = [901];
    for (let index = 0; index < names.length; index++) {
      const parentId = ids[ids.length - 1];
      await row(parentId).getByRole('button', { name: '添加子目标', exact: true }).click();
      const input = page.locator('#todayGoalSubInput-' + parentId);
      await expect(input).toBeFocused();
      await input.fill(names[index]);
      if (index === 0) {
        const draft = await input.evaluate(input => {
          input.setSelectionRange(1, 3);
          renderToday();
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
          return { same: document.getElementById(input.id) === input, start: input.selectionStart, end: input.selectionEnd, count: loadGoals().length };
        });
        expect(draft).toEqual({ same: true, start: 1, end: 3, count: 2 });
        await page.evaluate(() => { window.goalHierarchySaveData = saveData; saveData = () => false; });
        await input.press('Enter');
        await expect(input).toHaveValue(names[index]);
        expect(await page.evaluate(() => loadGoals().length)).toBe(2);
        await page.evaluate(() => { saveData = window.goalHierarchySaveData; });
      }
      if (index % 2) await row(parentId).locator('.today-goals-confirm').click();
      else await input.press('Enter');
      const id = await page.evaluate(text => loadGoals().find(goal => goal.text === text)?.id, names[index]);
      expect(id).toBeTruthy();
      ids.push(id);
      await expect(row(id)).toBeVisible();
      await expect(row(id).locator('..')).toHaveAttribute('data-goal-depth', String(index + 1));
    }
    const leaf = ids[ids.length - 1];
    await row(leaf).locator('.todo-edit').click();
    await page.locator('#editGoalDue').fill('2026-12-31');
    await page.locator('#editGoalContent').fill('每周推进实验与论文');
    await page.locator('#editGoalNote').fill('仔细检查 <备注>');
    await page.locator('#editModal .btn-save-modal').click();
    await expect(row(leaf).locator('.today-goal-note-row')).toHaveText('仔细检查 <备注>');
    await row(leaf).getByRole('checkbox').click();
    await expect(row(leaf).getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
    await expect(row(901).getByRole('checkbox')).toHaveAttribute('aria-checked', 'false');
    await row(901).getByRole('button', { name: '展开/收起子目标', exact: true }).click();
    await expect(row(ids[1])).toHaveCount(0);
    const context = await page.evaluate(leaf => ({
      goals: collectDailyReportData().longTermGoals,
      evening: collectEveningReportData().longTermGoals,
      chat: buildToolsSystemPrompt(null, {}),
      report: formatReportLongTermGoals(collectReportLongTermGoals()),
      manualOptions: buildManualGoalOptions(leaf, 'goal'),
      sync: window.goalHierarchySyncKeys,
    }), leaf);
    expect(context.goals).toEqual(context.evening);
    expect(context.goals.find(goal => goal.id === leaf)).toMatchObject({ parentId: ids[ids.length - 2], note: '仔细检查 <备注>', dueDate: '2026-12-31' });
    expect(context.report).toContain('完成毕业设计 › 研究阶段 › 实验 <一>');
    expect(context.chat).toContain(`（父目标ID:${ids[ids.length - 2]}）`);
    expect(context.manualOptions).toContain('完成毕业设计 › 研究阶段 › 实验 &lt;一&gt;');
    expect(context.sync).toContain('study_longterm_goals');
    await page.evaluate(async () => { await StudyData.flush(); });
    await page.reload();
    await page.waitForFunction(() => typeof getGoalHierarchy === 'function' && typeof renderCheckinCalendar === 'function'
      && document.querySelector('#nav-today[aria-current="page"]'));
    await page.evaluate(() => switchTab('today'));
    await expect(row(ids[1])).toHaveCount(0);
    await row(901).getByRole('button', { name: '展开/收起子目标', exact: true }).click();
    await expect(row(leaf)).toBeVisible();
    await expect(row(leaf).getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
    await expect(row(901).locator('.today-goal-note-row')).toHaveText('保留旧备注');
    await page.evaluate(() => openTimerGoalPicker());
    await page.locator('#timerPickerSearch').fill('研究阶段');
    await expect(page.locator('#timerPickerList .todo-picker-item')).toHaveCount(7);
    await page.locator('#timerPickerList .todo-picker-item').last().click();
    expect(await page.evaluate(() => timerLinkedGoalId)).toBe(leaf);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => applyTheme(theme), theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.locator('#todayGoalsCard').scrollIntoViewIfNeeded();
        expect(await page.locator('#todayGoalsCard').evaluate(card => [...card.querySelectorAll('.today-goal-item')].every(el => el.scrollWidth <= el.clientWidth + 1))).toBe(true);
        await page.locator('#todayGoalsCard').screenshot({ path: `test-results/goal-hierarchy-${theme}-${width}.png` });
        await row(leaf).getByRole('button', { name: '添加子目标', exact: true }).click();
        const input = page.locator('#todayGoalSubInput-' + leaf);
        await input.fill('取消草稿');
        expect(await input.evaluate(el => el.getBoundingClientRect().right <= el.closest('.today-goal-item').getBoundingClientRect().right)).toBe(true);
        await input.press('Escape');
      }
    }
    await row(ids[1]).locator('.todo-delete').click();
    await expect(page.locator('#confirmMsg')).toContainText('全部 6 个子目标');
    await page.locator('#confirmCancel').click();
    await expect(row(leaf)).toBeVisible();
    await row(ids[1]).locator('.todo-delete').click();
    await page.locator('#confirmOk').click();
    await expect(row(ids[1])).toHaveCount(0);
    expect(await page.evaluate(() => loadGoals().map(goal => goal.text))).toEqual(['完成毕业设计', '另一个顶层目标']);
    expect(errors).toEqual([]);
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
