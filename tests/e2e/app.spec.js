'use strict';

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let electronApp;
let page;
let userDataPath;

test.beforeAll(async () => {
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-e2e-'));
  electronApp = await electron.launch({
    args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath }
  });
  page = await electronApp.firstWindow();
  page.on('console', message => {
    if (message.type() === 'error') console.error('[renderer]', message.text());
  });
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  if (electronApp) await electronApp.close();
  if (userDataPath) await fs.rm(userDataPath, { recursive: true, force: true });
});

test('application boots with isolated renderer and versioned storage', async () => {
  await expect(page).toHaveTitle(/My Study Table/);
  const state = await page.evaluate(async () => {
    const result = await window.StudyData.initialize();
    return {
      contextHasRequire: typeof window.require !== 'undefined',
      database: window.StudyData.status().database,
      initialized: result.ok
    };
  });
  expect(state).toEqual({
    contextHasRequire: false,
    database: 'my-study-table-data',
    initialized: true
  });
});

test('desktop sidebar opens on the edge and automatically hides', async () => {
  const windowState = await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(840, 800);
    return { minimum: win.getMinimumSize(), bounds: win.getBounds() };
  });
  expect(windowState.minimum[0]).toBe(840);
  // 仍在 Electron 渲染器落入窄屏断点时验证桌面侧边栏入口。
  await page.setViewportSize({ width: 800, height: 700 });
  await page.waitForFunction(() => window.innerWidth <= 800);
  await page.evaluate(() => localStorage.setItem('study_sidebar_open', 'true'));
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => localStorage.getItem('study_sidebar_open') === null);

  const sidebar = page.locator('#sidebar');
  const trigger = page.locator('#sidebarHoverTrigger');
  await expect(trigger).toBeVisible();
  await expect(sidebar).not.toHaveClass(/open/);
  await expect(sidebar).toHaveAttribute('aria-hidden', 'true');
  expect(await sidebar.evaluate(element => element.hasAttribute('inert'))).toBe(false);

  // locator.click 覆盖真实的 mouseenter -> click 事件顺序。
  await trigger.click();
  await expect(sidebar).toHaveClass(/open/);
  await expect(sidebar).toHaveAttribute('aria-hidden', 'false');

  await page.mouse.move(100, 200);
  await page.mouse.move(600, 200);
  await expect(sidebar).not.toHaveClass(/open/, { timeout: 1500 });

  await trigger.click();
  await expect(sidebar).toHaveClass(/open/);
  await sidebar.locator('.sidebar-nav-item').first().click();
  await page.waitForTimeout(600);
  await expect(sidebar).toHaveClass(/open/);
  await page.mouse.move(600, 200);
  await expect(sidebar).not.toHaveClass(/open/, { timeout: 1000 });
});

test('desktop sidebar closes after the pointer skips across the edge trigger', async () => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.mouse.move(600, 200);
  await page.evaluate(() => closeSidebar());
  const sidebar = page.locator('#sidebar');

  // 触发条在侧栏上方：直接跳到内容区不会经过侧栏，也不会触发它的 mouseleave。
  await page.mouse.move(6, 200);
  await expect(sidebar).toHaveClass(/open/);
  await page.mouse.move(600, 200);
  await expect(sidebar).not.toHaveClass(/open/, { timeout: 1500 });
});

test('desktop sidebar stays open when moving between the sidebar and its edge', async () => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.mouse.move(600, 200);
  await page.evaluate(() => closeSidebar());
  const sidebar = page.locator('#sidebar');
  await page.mouse.move(6, 200);
  await expect(sidebar).toHaveClass(/open/);
  await page.waitForTimeout(300);
  await page.mouse.move(100, 200);
  await page.waitForTimeout(500);
  await expect(sidebar).toHaveClass(/open/);
  await page.mouse.move(6, 200);
  await page.waitForTimeout(600);
  await expect(sidebar).toHaveClass(/open/);
  await page.mouse.move(600, 200);
  await page.waitForTimeout(100);
  await page.mouse.move(100, 200);
  await page.waitForTimeout(600);
  await expect(sidebar).toHaveClass(/open/);
  await page.mouse.move(600, 200);
  await expect(sidebar).not.toHaveClass(/open/, { timeout: 1500 });
});

test('opening the Electron sidebar does not leave a mobile overlay or scroll lock', async () => {
  await page.setViewportSize({ width: 800, height: 700 });
  await page.mouse.move(600, 200);
  await page.evaluate(() => openSidebar());
  await expect(page.locator('#sidebar')).toHaveClass(/open/);
  await expect(page.locator('body')).not.toHaveClass(/mobile-drawer-open/);
  await expect(page.locator('#mobileDrawerOverlay')).not.toHaveClass(/open/);
  await page.locator('#nav-todo').click();
  await page.waitForTimeout(600);
  await expect(page.locator('#sidebar')).toHaveClass(/open/);
  await page.mouse.move(600, 200);
  await expect(page.locator('#sidebar')).not.toHaveClass(/open/);
  await page.setViewportSize({ width: 1100, height: 700 });
});

test('wide Electron windows retain the edge sidebar entry without an empty gutter', async () => {
  await page.setViewportSize({ width: 1400, height: 850 });
  await page.mouse.move(600, 200);
  await page.evaluate(() => closeSidebar());
  const sidebar = page.locator('#sidebar');
  const trigger = page.locator('#sidebarHoverTrigger');
  await expect(trigger).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('padding-left', '0px');
  await expect.poll(() => sidebar.evaluate(el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await page.mouse.move(6, 200);
  await expect(sidebar).toHaveClass(/open/);
  await page.waitForTimeout(300);
  await page.mouse.move(100, 200);
  await page.mouse.move(600, 200);
  await expect(sidebar).not.toHaveClass(/open/);
  await expect.poll(() => sidebar.evaluate(el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await page.evaluate(() => openSidebar());
  await expect(sidebar).toHaveClass(/open/);
  await page.locator('.app').click({ position: { x: 700, y: 300 } });
  await expect(sidebar).not.toHaveClass(/open/);
  await page.setViewportSize({ width: 1100, height: 700 });
});

test('todo creation persists across a renderer reload', async () => {
  await page.evaluate(() => window.switchTab('todo'));
  await page.click('#btnTodoToggle');
  await page.fill('#todoInput', 'E2E 持久化待办');
  await page.press('#todoInput', 'Enter');
  await expect(page.locator('.todo-text', { hasText: 'E2E 持久化待办' })).toBeVisible();
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(500);
  await page.evaluate(() => window.switchTab('todo'));
  await expect(page.locator('.todo-text', { hasText: 'E2E 持久化待办' })).toBeVisible();
});

test('credentials leave localStorage after encrypted migration', async () => {
  const result = await page.evaluate(async () => {
    await window.SecretVault.set('study_web_search_key', 'e2e-secret-value');
    return {
      cached: window.SecretVault.get('study_web_search_key'),
      plaintext: localStorage.getItem('study_web_search_key'),
      secure: window.SecretVault.isSecure()
    };
  });
  expect(result.cached).toBe('e2e-secret-value');
  expect(result.plaintext).toBeNull();
  expect(result.secure).toBe(true);
});

test('a stale running timer is parked instead of resurrecting itself', async () => {
  // 模拟「几天前忘了停的计时器」：存档里 running=true、lastActiveAt 在三天前。
  // 直接调用恢复入口（应用启动时走的就是它），避免 page.reload 与应用自身卸载时的落盘互相打架。
  const parked = await page.evaluate(() => {
    localStorage.removeItem('study_timer_records');
    const now = Date.now();
    localStorage.setItem('study_timer_state', JSON.stringify({
      running: true,
      elapsed: 0,
      displayMs: 30 * 60 * 1000,
      sessionStart: now - 3 * 60 * 60 * 1000,
      sessions: [],
      name: 'E2E 陈旧计时',
      linkedTodoId: null,
      linkedGoalId: null,
      savedAt: now - 3 * 24 * 60 * 60 * 1000,
      lastActiveAt: now - 3 * 24 * 60 * 60 * 1000
    }));
    loadAndRestoreTimerState();
    return {
      running: timerRunning,
      elapsed: timerElapsed,
      floatVisible: timerFloatVisible,
      staleNotice: typeof timerStaleNotice === 'string' ? timerStaleNotice : null,
      savedState: localStorage.getItem('study_timer_state')
    };
  });

  // 关键：打开应用时不能凭空出现一个正在走的计时器
  expect(parked.running).toBe(false);
  expect(parked.floatVisible).toBe(false);
  expect(parked.elapsed).toBe(30 * 60 * 1000);        // 找回的时长要保留
  expect(parked.staleNotice).toContain('已找回上次未结束的计时');
  expect(parked.savedState).toBeNull();

  // 界面上：时长找回、有说明、停在「开始」
  await page.evaluate(() => switchTab('timer'));
  await expect(page.locator('.timer-resume-notice')).toContainText('已找回上次未结束的计时');
  expect((await page.locator('#timerDisplay').textContent()).trim()).toBe('30:00');
  expect(await page.locator('.timer-btn-start').count()).toBe(1);

  // 点「开始」可以从找回的时长继续
  await page.evaluate(() => timerStart());
  const resumed = await page.evaluate(() => ({ running: timerRunning, elapsed: timerElapsed }));
  expect(resumed.running).toBe(true);
  expect(resumed.elapsed).toBeGreaterThanOrEqual(30 * 60 * 1000);

  await page.evaluate(() => timerReset());
  await page.waitForTimeout(100);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('study_timer_state'))).toBeNull();
});

test('a timer left running moments ago resumes without counting the gap', async () => {
  const resumed = await page.evaluate(() => {
    localStorage.removeItem('study_timer_records');
    const now = Date.now();
    localStorage.setItem('study_timer_state', JSON.stringify({
      running: true,
      elapsed: 0,
      displayMs: 30 * 60 * 1000,
      sessionStart: now - 60 * 60 * 1000,
      sessions: [],
      name: 'E2E 时长回归',
      linkedTodoId: null,
      linkedGoalId: null,
      // 超过 60 秒：这不是同一渲染器的 Ctrl+R 连续时段，应该走应用重启的恢复路径。
      // 仍在短暂恢复窗口内，因此不会被当作陈旧计时器停放。
      savedAt: now - 61 * 1000,
      lastActiveAt: now - 61 * 1000
    }));
    loadAndRestoreTimerState();
    return {
      running: timerRunning,
      elapsed: timerElapsed,
      sessions: timerSessions.length,
      floatVisible: timerFloatVisible,
      display: (document.getElementById('tfTime') || {}).textContent || ''
    };
  });

  expect(resumed.running).toBe(true);
  expect(resumed.floatVisible).toBe(true);
  // 30 分钟（+ 恢复后刚过的几秒），不是一小时
  expect(resumed.elapsed).toBeGreaterThanOrEqual(30 * 60 * 1000);
  expect(resumed.elapsed).toBeLessThan(30 * 60 * 1000 + 10000);
  expect(resumed.sessions).toBe(1);                  // 重启前那一段被封口保留
  const match = /^(?:(\d+):)?(\d+):(\d+)$/.exec(resumed.display.trim());
  expect(match).not.toBeNull();
  expect(match[1] ? Number(match[1]) : 0).toBe(0);   // 显示的小时位必须是 0
  expect(Number(match[2])).toBe(30);

  // 恢复中的计时器不能留到后面的用例
  await page.evaluate(() => timerReset());
  await page.waitForTimeout(100);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('study_timer_state'))).toBeNull();
});

test('editing a timer record preserves and edits its separate sessions', async () => {
  const recordId = await page.evaluate(() => {
    timerReset();
    const base = new Date(2026, 8, 21, 9, 0, 0, 0).getTime();
    const id = genTimerRecordId();
    saveTimerRecords([{
      id, name: 'E2E 多时段', date: '2026-09-21', totalMs: 60 * 60 * 1000,
      sessions: [
        { start: base, end: base + 30 * 60 * 1000 },
        { start: base + 60 * 60 * 1000, end: base + 90 * 60 * 1000 }
      ],
      affectsFocus: true, manual: false
    }]);
    switchTab('timer');
    editTimerRecord(id);
    return id;
  });

  await expect(page.locator('#manualRecSessions .timer-manual-session-row')).toHaveCount(2);
  await page.evaluate(() => {
    document.querySelectorAll('.manual-rec-session-end')[1].value = '10:45';
    saveManualRecord();
  });

  const record = await page.evaluate(id => loadTimerRecords().find(item => item.id === id), recordId);
  expect(record.sessions).toHaveLength(2);
  expect(record.sessions[0].end).toBeLessThan(record.sessions[1].start);
  expect(record.sessions[1].end - record.sessions[1].start).toBe(45 * 60 * 1000);
  expect(record.totalMs).toBe(75 * 60 * 1000);
});

test('renderer reload keeps a running timer as one continuous session', async () => {
  const originalStart = await page.evaluate(() => {
    timerReset();
    localStorage.removeItem('study_timer_records');
    timerStart();
    timerSessionName = 'E2E 刷新连续计时';
    timerSessionStart = Date.now() - 5 * 60 * 1000;
    saveTimerState();
    return timerSessionStart;
  });

  await page.reload();
  await page.waitForFunction(() => typeof window.timerStop === 'function' && timerRunning === true);
  const restored = await page.evaluate(() => ({ start: timerSessionStart, completedSessions: timerSessions.length }));
  expect(restored.start).toBe(originalStart);
  expect(restored.completedSessions).toBe(0);

  const saved = await page.evaluate(() => {
    timerStop();
    return loadTimerRecords().find(record => record.name === 'E2E 刷新连续计时');
  });
  expect(saved).toBeTruthy();
  expect(saved.sessions).toHaveLength(1);
  expect(saved.sessions[0].start).toBe(originalStart);
});

test('timer records support task binding, merge matching neighbours, and hide empty float metadata', async () => {
  const result = await page.evaluate(() => {
    timerReset();
    const line = tlAddLine({ name: 'E2E 计时章节', type: 'quality' });
    const task = tlAddQuest({ lineId: line.id, title: 'E2E 绑定任务', status: 'active' });
    const base = new Date(2026, 8, 21, 14, 0, 0, 0).getTime();
    saveTimerRecords([
      { id: genTimerRecordId(), name: '同一学习块', date: '2026-09-21', totalMs: 20 * 60000, sessions: [{ start: base, end: base + 20 * 60000 }], todoId: null, goalId: null, taskId: task.id, affectsFocus: true, manual: false },
      { id: genTimerRecordId(), name: '同一学习块', date: '2026-09-21', totalMs: 15 * 60000, sessions: [{ start: base + 30 * 60000, end: base + 45 * 60000 }], todoId: null, goalId: null, taskId: task.id, affectsFocus: true, manual: false }
    ]);
    const records = loadTimerRecords();
    timerSessionName = '';
    timerLinkedTodoId = null;
    timerLinkedGoalId = null;
    timerLinkedTaskId = task.id;
    switchTab('timer');
    renderTimer();
    const floatHtml = timerFloatTargetHtml();
    const mainHasTaskButton = Array.from(document.querySelectorAll('.timer-context-row .timer-link-btn, .timer-context-stack .timer-link-btn')).some(button => button.textContent.includes('关联任务'));
    toggleManualRecordForm();
    return {
      records,
      floatHtml,
      mainHasTaskButton,
      manualTaskOptions: Array.from(document.querySelectorAll('#manualRecTask option')).map(option => option.textContent)
    };
  });

  expect(result.records).toHaveLength(1);
  expect(result.records[0].sessions).toHaveLength(2);
  expect(result.records[0].totalMs).toBe(35 * 60000);
  expect(result.records[0].taskId).toBeTruthy();
  expect(result.floatHtml).toContain('E2E 绑定任务');
  expect(result.floatHtml).not.toContain('未关联待办');
  expect(result.floatHtml).not.toContain('未关联目标');
  expect(result.mainHasTaskButton).toBe(false); // 已绑定后显示任务名称而不是“关联任务”按钮
  expect(result.manualTaskOptions.join(' ')).toContain('E2E 绑定任务');
});

test('AI policy detects secrets and records token usage', async () => {
  // 统计页由内置扩展注册；Windows CI 较慢时不能假定首屏完成后它已就绪。
  await page.waitForFunction(() => !!document.getElementById('section-stats') && !!document.getElementById('nav-stats'));
  const result = await page.evaluate(async () => {
    window.AIClient.clearUsage();
    const matches = window.AIClient.findSensitiveContent([
      { role: 'user', content: 'password: hunter2 and sk-abcdefghijklmnopqrstuvwxyz' }
    ]);
    const usage = window.AIClient.recordUsage('gpt-4o-mini', { prompt_tokens: 1000, completion_tokens: 500 }, { feature: 'chat' });
    window.switchTab('stats');
    window.renderStats();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      matches, usage,
      store: JSON.parse(localStorage.getItem('study_ai_usage_v2') || '{}'),
      panel: document.getElementById('statsAiTotal')?.textContent,
      models: document.getElementById('statsAiModels')?.textContent,
      accuracy: document.getElementById('statsAiAccuracy')?.textContent
    };
  });
  expect(result.matches).toEqual(expect.arrayContaining(['API Key', '密码字段']));
  expect(result.usage.inputTokens).toBe(1000);
  expect(Object.values(result.store.days)[0].requests).toBeGreaterThan(0);
  expect(result.panel).toBe('1.5K');
  expect(result.models).toContain('gpt-4o-mini');
  expect(result.accuracy).toContain('精确 1 次');
});

test('calendar and task-line writes enter the persistent sync queue', async () => {
  const result = await page.evaluate(async () => {
    window.Sync.setEnabled(true);
    window.Sync.setAutoSync(false);
    window.addCalendarEvent('2026-08-25', '同步回归测试', '09:00', 'blue', '');
    window.tlAddLine({ name: '同步测试任务线', type: 'quality' });
    const status = await window.Sync.getStatus();
    return {
      calendar: JSON.parse(localStorage.getItem('study_calendar_events') || '[]'),
      taskLine: JSON.parse(localStorage.getItem('study_taskline_v1') || '{}'),
      dirtyKeys: status.dirtyKeys
    };
  });
  expect(result.calendar.some(item => item.title === '同步回归测试')).toBe(true);
  expect(result.taskLine.lines.some(item => item.name === '同步测试任务线')).toBe(true);
  expect(result.dirtyKeys).toEqual(expect.arrayContaining(['study_calendar_events', 'study_taskline_v1']));
});

test('rendering an unchanged task line does not mark it dirty', async () => {
  const dirtyKeys = await page.evaluate(async () => {
    localStorage.setItem('study_sync_dirty_v1', '{}');
    window.renderTaskLine();
    window.renderTaskLine();
    return (await window.Sync.getStatus()).dirtyKeys;
  });
  expect(dirtyKeys).not.toContain('study_taskline_v1');
});

test('sync conflicts render inside settings without a popup', async () => {
  const result = await page.evaluate(async () => {
    localStorage.setItem('study_sync_pending_conflicts_v1', JSON.stringify({
      study_notes: {
        key: 'study_notes',
        reason: 'both-changed',
        baseTimestamp: '2026-08-25T08:00:00.000Z',
        remoteTimestamp: '2026-08-25T08:05:00.000Z',
        detectedAt: '2026-08-25T08:06:00.000Z'
      },
      study_notes_folders: {
        key: 'study_notes_folders',
        reason: 'cloud-newer-than-base',
        baseTimestamp: '2026-08-25T08:01:00.000Z',
        remoteTimestamp: '2026-08-25T08:07:00.000Z',
        detectedAt: '2026-08-25T08:08:00.000Z'
      }
    }));
    localStorage.setItem('study_sync_logs_conflicts_v2', JSON.stringify({
      'ai_conv/9': {
        kind: 'ai_conv', itemId: '9', name: '云端对话测试', reason: 'both-changed',
        baseTimestamp: '2026-08-25T08:00:00.000Z',
        remoteTimestamp: '2026-08-25T08:05:00.000Z',
        detectedAt: '2026-08-25T08:06:00.000Z'
      }
    }));
    await window.renderSyncPanel();
    await window.SyncLogs.renderPanel();
    const panel = document.getElementById('syncConflictPanel');
    const storagePanel = document.getElementById('storagePanelRoot');
    return {
      legacyPopupCount: document.querySelectorAll('#syncConflictOverlay').length,
      panelDisplay: panel.style.display,
      panelText: panel.textContent,
      actionCount: panel.querySelectorAll('.sync-conflict-btn').length,
      groupCount: panel.querySelectorAll('.sync-conflict-group').length,
      groupActionCount: panel.querySelectorAll('.sync-conflict-group-btn').length,
      groupItemCount: panel.querySelectorAll('.sync-conflict-group-items .sync-conflict-item').length,
      firstGroupOpen: panel.querySelector('.sync-conflict-group').open,
      pendingCount: window.Sync.getPendingConflicts().length,
      storageText: storagePanel.textContent,
      storageConflictActions: storagePanel.querySelectorAll('.sync-conflict-btn').length
    };
  });
  expect(result.legacyPopupCount).toBe(0);
  expect(result.panelDisplay).toBe('block');
  expect(result.panelText).toContain('笔记');
  expect(result.panelText).toContain('统一处理该分类');
  expect(result.panelText).toContain('保留本地并上传');
  expect(result.panelText).toContain('使用云端并覆盖本地');
  expect(result.actionCount).toBe(4);
  expect(result.groupCount).toBe(1);
  expect(result.groupActionCount).toBe(2);
  expect(result.groupItemCount).toBe(2);
  expect(result.firstGroupOpen).toBe(true);
  expect(result.pendingCount).toBe(2);
  await page.locator('#syncConflictPanel .sync-conflict-group > summary').evaluate(el => el.click());
  expect(await page.locator('#syncConflictPanel .sync-conflict-group').evaluate(el => el.open)).toBe(false);
  expect(result.storageText).toContain('对话云存储冲突');
  expect(result.storageText).toContain('云端对话测试');
  expect(result.storageConflictActions).toBe(2);
});

test('third-party plugin runs in an opaque sandbox with declared permissions', async () => {
  const result = await page.evaluate(async () => {
    await window.electronAPI.extWrite({
      id: 'e2e-sandbox',
      files: {
        manifest: { id: 'e2e-sandbox', name: 'E2E Sandbox', type: 'plugin', enabled: false, permissions: ['storage', 'log'] },
        main: `let escaped=false; try { parent.document.body.dataset.compromised='yes'; escaped=true; } catch (_) {}\n` +
          `extAPI.setData('result', { escaped, hasNode: typeof require !== 'undefined' });`
      }
    });
    await window.ExtManager.reload();
    const before = window.ExtManager.get('e2e-sandbox').enabled;
    const mounted = await window.ExtManager.setEnabled('e2e-sandbox', true);
    return {
      mounted,
      before,
      after: window.ExtManager.get('e2e-sandbox').enabled,
      compromised: document.body.dataset.compromised || ''
    };
  });
  expect(result.mounted.ok, JSON.stringify(result)).toBe(true);
  await page.waitForFunction(() => localStorage.getItem('study_ext_e2e-sandbox_result') !== null, null, { timeout: 5000 });
  const sandboxData = await page.evaluate(() => JSON.parse(localStorage.getItem('study_ext_e2e-sandbox_result')));
  expect(result.compromised).toBe('');
  expect(sandboxData).toEqual({ escaped: false, hasNode: false });
});
test('prompt studio edits shared templates and resolves app data at request time', async () => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.evaluate(() => switchTab('prompts'));
  await expect(page.locator('#section-prompts')).toHaveClass(/active/);
  await expect(page.locator('[data-template-id]')).toHaveCount(3);
  await expect(page.locator('#promptTemplateText')).toContainText('你是「我的学习桌面」的内置 AI 助手');
  await page.locator('#promptTemplateText').fill('请结合最新信息：\n');
  await page.locator('[data-insert-token="待办信息"]').click();
  await expect(page.locator('#promptTemplateText')).toHaveValue(/\{\{待办信息\}\}/);
  await expect(page.locator('#promptHighlightLayer .prompt-token-highlight')).toContainText('{{待办信息}}');
  await page.locator('[data-prompt-view="preview"]').click();
  await expect(page.locator('#promptPreviewText')).toBeVisible();
  await expect(page.locator('#promptPreviewText')).not.toContainText('{{待办信息}}');
  await expect(page.locator('.prompt-preview-panel #promptPreviewText')).toHaveCount(0);
  await page.locator('[data-prompt-view="source"]').click();
  const result = await page.evaluate(() => {
    const conv = getActiveConv();
    return { stored: getPromptTemplate('chat'), sent: buildConversationSystemPrompt(conv), perConversation: conv.systemPrompt };
  });
  expect(result.stored).toContain('{{待办信息}}');
  expect(result.sent).not.toContain('{{待办信息}}');
  expect(result.perConversation).toBe('');
  await page.locator('[data-template-id="morning"]').click();
  await expect(page.locator('#promptTemplateText')).toContainText('{{日报数据}}');
  await page.locator('[data-prompt-view="preview"]').click();
  await expect(page.locator('#promptPreviewText')).toContainText('当前完整数据（预览示例）');
  await expect(page.locator('#promptPreviewText')).not.toContainText('（仅在生成日报时插入）');
  await page.locator('[data-prompt-view="data"]').click();
  await expect(page.locator('#promptDataOverview')).toBeVisible();
  await expect(page.locator('#promptDataOverview')).toContainText('晨间日报当前数据');
  await expect(page.locator('#promptDataOverview')).not.toContainText('```json');
  await page.locator('[data-prompt-view="source"]').click();
  await page.locator('[data-template-id="evening"]').click();
  await expect(page.locator('#promptTemplateText')).toContainText('{{日报数据}}');
  const custom = await page.evaluate(() => {
    const saved = loadPromptTemplates();
    saved.customTemplates = [{ id: 'custom-e2e', name: '数学导师' }];
    saved['custom-e2e'] = '你是数学导师。{{待办信息}}';
    saveData('study_prompt_templates_v1', saved);
    const conv = getActiveConv();
    conv.promptTemplateId = 'custom-e2e';
    return buildConversationSystemPrompt(conv);
  });
  expect(custom).toContain('你是数学导师。');
  await page.evaluate(() => openConvSettingsModal());
  await expect(page.locator('#convPromptTemplate')).toHaveValue('custom-e2e');
  await page.evaluate(() => closeConvSettingsModal());
});

test('check-in report prompt releases the app input after submission', async () => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.evaluate(() => {
    localStorage.removeItem('study_checkin');
    localStorage.setItem('study_morning_cfg', JSON.stringify({ enabled: true }));
    switchTab('todo');
    doDailyCheckin();
  });

  await expect(page.locator('#checkinQuoteOverlay')).toHaveClass(/open/);
  await expect(page.locator('#checkinReportOverlay')).not.toHaveClass(/open/);
  await page.locator('.checkin-quote-close').click();
  await expect(page.locator('#checkinQuoteOverlay')).not.toHaveClass(/open/);
  await expect(page.locator('#checkinReportOverlay')).toHaveClass(/open/);
  await page.locator('#checkinReportInput').fill('今天先复习');
  await page.locator('.checkin-report-submit').click();
  await expect(page.locator('#checkinReportOverlay')).not.toHaveClass(/open/);
  await page.locator('#todoSearch').fill('可正常输入');
  await expect(page.locator('#todoSearch')).toHaveValue('可正常输入');
});

test('long-term goals are available to morning and evening report prompts', async () => {
  const result = await page.evaluate(() => {
    localStorage.setItem('study_longterm_goals', JSON.stringify([
      { id: 901, text: '完成毕业设计', done: false, dueDate: '2026-12-31', content: '每周稳定推进核心模块' }
    ]));
    const morning = collectDailyReportData().longTermGoals;
    const evening = collectEveningReportData().longTermGoals;
    return {
      morning,
      evening,
      formatted: formatReportLongTermGoals(morning)
    };
  });
  expect(result.morning).toEqual(result.evening);
  expect(result.morning[0]).toMatchObject({ text: '完成毕业设计', done: false, dueDate: '2026-12-31' });
  expect(result.formatted).toContain('完成毕业设计（截止 2026-12-31）：每周稳定推进核心模块');
});

test('calendar event time range drives automatic timer records', async () => {
  await page.evaluate(() => switchTab('calendar'));
  await page.evaluate(() => {
    localStorage.setItem('study_calendar_events', '[]');
    localStorage.setItem('study_timer_records', '[]');
    openCalEventModal('2026-03-05', null);
    document.getElementById('calEventTitle').value = 'E2E 自动记账事件';
    document.getElementById('calEventStartTime').value = '09:00';
    document.getElementById('calEventEndTime').value = '10:30';
    document.getElementById('calEventAutoRecord').checked = true;
    syncCalEventAutoTimerEnabled();
    document.getElementById('calEventAutoTimer').checked = false;
    submitCalEvent();
  });

  const created = await page.evaluate(() => ({
    events: JSON.parse(localStorage.getItem('study_calendar_events') || '[]'),
    modalOpen: document.getElementById('calEventModal').classList.contains('open')
  }));
  expect(created.modalOpen).toBe(false);
  expect(created.events).toHaveLength(1);
  expect(created.events[0]).toMatchObject({
    title: 'E2E 自动记账事件',
    startTime: '09:00',
    endTime: '10:30',
    autoRecord: true,
    autoTimer: false
  });

  const autoRecord = await page.evaluate(() => {
    const pad = n => String(n).padStart(2, '0');
    // 把事件时段平移到刚刚结束的 90 分钟，立刻触发一次巡检
    const endTs = Date.now() - 60000;
    const startTs = endTs - 90 * 60000;
    const startD = new Date(startTs);
    const endD = new Date(endTs);
    const events = JSON.parse(localStorage.getItem('study_calendar_events') || '[]');
    events[0].date = startD.getFullYear() + '-' + pad(startD.getMonth() + 1) + '-' + pad(startD.getDate());
    events[0].startTime = pad(startD.getHours()) + ':' + pad(startD.getMinutes());
    events[0].time = events[0].startTime;
    events[0].endTime = pad(endD.getHours()) + ':' + pad(endD.getMinutes());
    localStorage.setItem('study_calendar_events', JSON.stringify(events));

    const first = runCalendarAutoRecords(Date.now());
    const second = runCalendarAutoRecords(Date.now());
    return {
      first,
      second,
      records: JSON.parse(localStorage.getItem('study_timer_records') || '[]'),
      events: JSON.parse(localStorage.getItem('study_calendar_events') || '[]')
    };
  });

  expect(autoRecord.first).toBe(1);
  expect(autoRecord.second).toBe(0);
  expect(autoRecord.records).toHaveLength(1);
  expect(autoRecord.records[0].name).toBe('E2E 自动记账事件');
  expect(autoRecord.records[0].auto).toBe(true);
  expect(autoRecord.records[0].affectsFocus).toBe(false);
  expect(autoRecord.records[0].totalMs).toBe(90 * 60000);
  expect(autoRecord.events[0].lastAutoRecordEnd).toBeGreaterThan(0);
});

test('calendar supports multi-day and all-day events', async () => {
  await page.evaluate(() => switchTab('calendar'));
  const result = await page.evaluate(() => {
    localStorage.setItem('study_calendar_events', '[]');
    openCalEventModal('2026-03-05', null);
    document.getElementById('calEventTitle').value = 'E2E 跨天全天事件';
    document.getElementById('calEventEndDate').value = '2026-03-07';
    document.getElementById('calEventAllDay').checked = true;
    syncCalEventAllDayFields();
    submitCalEvent();
    const event = JSON.parse(localStorage.getItem('study_calendar_events') || '[]')[0];
    return {
      event,
      days: ['2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08']
        .map(date => [date, getCalendarEventsOnDate(date).length])
    };
  });

  expect(result.event).toMatchObject({
    date: '2026-03-05', endDate: '2026-03-07', allDay: true,
    startTime: '', endTime: '', autoRecord: false
  });
  expect(result.days).toEqual([
    ['2026-03-04', 0], ['2026-03-05', 1], ['2026-03-06', 1], ['2026-03-07', 1], ['2026-03-08', 0]
  ]);
  await page.evaluate(() => selectCalendarDay('2026-03-06'));
  await expect(page.locator('#calendarTodoList .cal-event-item')).toContainText('全天');
  await expect(page.locator('#calendarTodoList .cal-event-item')).toContainText('E2E 跨天全天事件');
  await page.evaluate(() => {
    calendarCurrentDate = new Date();
    calendarSelectedDate = formatDate(new Date());
    renderCalendar();
  });
});

test('calendar opens on today and a weekly event can drop a single day', async () => {
  await page.evaluate(() => switchTab('calendar'));
  await expect(page.locator('#calendarGrid .cal-day.cal-selected')).toHaveCount(1);

  const today = await page.evaluate(() => formatDate(new Date()));
  expect(await page.evaluate(() => calendarSelectedDate)).toBe(today);

  await page.evaluate(() => {
    localStorage.setItem('study_calendar_events', '[]');
    localStorage.setItem('study_timer_records', '[]');
    const todayStr = formatDate(new Date());
    const todayDay = new Date().getDay();
    const tomorrowDay = (todayDay + 1) % 7;
    openCalEventModal(todayStr, null);
    document.getElementById('calEventTitle').value = 'E2E 每周重复事件';
    document.getElementById('calEventStartTime').value = '09:00';
    document.getElementById('calEventEndTime').value = '10:00';
    const repeat = document.getElementById('calEventRepeat');
    repeat.value = 'weekly';
    syncCalEventRepeatFields();
    // 选「今天 + 明天」两个星期几（跨周边界时也成立）
    for (const box of document.querySelectorAll('#calEventWeekdayRow input[data-weekday]')) {
      box.checked = [todayDay, tomorrowDay].includes(Number(box.dataset.weekday));
    }
    syncCalEventRepeatFields();
    submitCalEvent();
  });

  const created = await page.evaluate(() => JSON.parse(localStorage.getItem('study_calendar_events') || '[]')[0]);
  expect(created).toMatchObject({ repeat: 'weekly', autoRecord: false });
  expect(created.skippedDates).toEqual([]);
  expect([...created.weekdays].sort()).toEqual([new Date().getDay(), (new Date().getDay() + 1) % 7].sort());

  // 今天显示 🔁 标记，明天（也选中了）同样出现，后天不出现
  await expect(page.locator('#calendarTodoList .cal-event-item', { hasText: 'E2E 每周重复事件' })).toHaveCount(1);
  await expect(page.locator('#calendarTodoList .cal-event-repeat')).toHaveCount(1);
  const tomorrow = await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return formatDate(d);
  });
  const afterTomorrow = await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    return formatDate(d);
  });
  await page.evaluate(dateStr => selectCalendarDay(dateStr), tomorrow);
  await expect(page.locator('#calendarTodoList .cal-event-item', { hasText: 'E2E 每周重复事件' })).toHaveCount(1);
  await page.evaluate(dateStr => selectCalendarDay(dateStr), afterTomorrow);
  await expect(page.locator('#calendarTodoList .cal-event-item', { hasText: 'E2E 每周重复事件' })).toHaveCount(0);

  // 回到今天（重新渲染后再右键，避免点到旧节点）
  await page.evaluate(dateStr => selectCalendarDay(dateStr), today);
  await expect(page.locator('#calendarTodoList .cal-event-item', { hasText: 'E2E 每周重复事件' })).toHaveCount(1);

  // 右键 → 仅删除这一天
  await page.locator('#calendarTodoList .cal-event-item', { hasText: 'E2E 每周重复事件' }).first().click({ button: 'right' });
  await expect(page.locator('#calEventContextMenu')).toHaveClass(/visible/);
  await expect(page.locator('#calCtxDeleteOne')).toBeVisible();
  await page.locator('#calCtxDeleteOne').click();

  const skipped = await page.evaluate(() => JSON.parse(localStorage.getItem('study_calendar_events') || '[]')[0]);
  expect(skipped.skippedDates).toEqual([today]);
  await expect(page.locator('#calendarTodoList .cal-event-item', { hasText: 'E2E 每周重复事件' })).toHaveCount(0);
  await expect(page.locator('#calendarTodoList .cal-event-skipped')).toHaveCount(1);

  // 恢复这一天
  await page.locator('#calendarTodoList .cal-event-restore').click();
  const restored = await page.evaluate(() => JSON.parse(localStorage.getItem('study_calendar_events') || '[]')[0]);
  expect(restored.skippedDates).toEqual([]);
  await expect(page.locator('#calendarTodoList .cal-event-item', { hasText: 'E2E 每周重复事件' })).toHaveCount(1);
});

test('calendar event tools expose the schedule to the conversation AI', async () => {
  const result = await page.evaluate(async () => {
    const call = async (action, params) => {
      const res = await executeToolCallStructured(action, params, {});
      return { ok: res.ok, text: res.text, risk: getAiToolMetadata(action, params).risk };
    };
    localStorage.setItem('study_calendar_events', '[]');
    localStorage.setItem('study_timer_records', '[]');

    const created = await call('create_calendar_event', {
      title: 'E2E AI 体育课', date: '2026-03-09', startTime: '09:00', endTime: '10:00',
      weekdays: [1, 3, 5], color: 'green', note: '带泳帽'
    });
    const eventId = (JSON.parse(localStorage.getItem('study_calendar_events'))[0] || {}).id;

    const listedAll = await call('list_calendar_events', {});
    const listedDay = await call('list_calendar_events', { date: '2026-03-11' });
    const listedMiss = await call('list_calendar_events', { date: '2026-03-10' });
    const updated = await call('update_calendar_event', { id: eventId, endTime: '10:30', autoRecord: true });
    const deletedDay = await call('delete_calendar_event', { id: eventId, date: '2026-03-11' });
    const listedSkipped = await call('list_calendar_events', { date: '2026-03-11' });
    const restoredDay = await call('restore_calendar_event_date', { id: eventId, date: '2026-03-11' });
    const listedRestored = await call('list_calendar_events', { date: '2026-03-11' });
    const deletedAll = await call('delete_calendar_event', { id: eventId });

    const invalidWeekday = await call('create_calendar_event', { title: '非法星期', date: '2026-03-09', weekdays: [9] });
    const invalidDate = await call('create_calendar_event', { title: '非法日期', date: '2026-02-30' });
    const missingEvent = await call('delete_calendar_event', { id: 999999 });

    const stored = JSON.parse(localStorage.getItem('study_calendar_events') || '[]');
    return {
      created, listedAll, listedDay, listedMiss, updated, deletedDay, listedSkipped,
      restoredDay, listedRestored, deletedAll, invalidWeekday, invalidDate, missingEvent,
      stored
    };
  });

  expect(result.created.ok).toBe(true);
  expect(result.created.text).toContain('每周一、三、五');
  expect(result.listedAll.text).toContain('[ID:');
  expect(result.listedAll.text).toContain('E2E AI 体育课');
  expect(result.listedDay.text).toContain('每周一、三、五');   // 2026-03-11 是周三
  expect(result.listedMiss.text).toContain('没有安排');
  expect(result.updated.text).toContain('结束时间');

  expect(result.deletedDay.ok).toBe(true);
  expect(result.deletedDay.text).toContain('这一天的场次');
  expect(result.listedSkipped.text).toContain('没有安排');
  expect(result.restoredDay.ok).toBe(true);
  expect(result.listedRestored.text).toContain('E2E AI 体育课');

  expect(result.deletedAll.ok).toBe(true);
  expect(result.deletedAll.risk).toBe('destructive');
  expect(result.stored).toEqual([]);

  expect(result.invalidWeekday.ok).toBe(false);
  expect(result.invalidWeekday.text).toContain('参数校验失败');
  expect(result.invalidDate.ok).toBe(false);
  expect(result.invalidDate.text).toContain('不是有效日期');
  expect(result.missingEvent.ok).toBe(false);
  expect(result.missingEvent.text).toContain('未找到');
});
