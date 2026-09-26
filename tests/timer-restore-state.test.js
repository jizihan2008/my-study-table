'use strict';
// 计时器「重启后显示超长时长」的回归测试。
// 关键不变量：应用被关掉期间的时间不计入 已计时长 / 保存的记录。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const timerSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'timer.js'), 'utf8')
  .split('// Restore timer state on page load')[0];

const HOUR = 60 * 60 * 1000;

function localDateStr(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function makeElement(id) {
  const el = {
    id,
    style: {},
    innerHTML: '',
    textContent: '',
    className: '',
    children: [],
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    addEventListener: () => {},
    appendChild: () => {},
    remove: () => {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 })
  };
  return el;
}

function createContext(options) {
  const opts = options || {};
  let records = [];
  const store = new Map();
  if (opts.savedState) store.set('study_timer_state', JSON.stringify(opts.savedState));

  const elements = new Map();
  const documentStub = {
    getElementById: id => {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    createElement: id => makeElement(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    body: makeElement('body')
  };

  const context = vm.createContext({
    console,
    Date, JSON, String, Number, Math, Array, Object, RegExp, parseInt, parseFloat, isNaN, Boolean, Set, Map,
    setTimeout: () => 0,
    setInterval: () => 1,
    clearInterval: () => {},
    performance: opts.navigationType ? { getEntriesByType: type => type === 'navigation' ? [{ type: opts.navigationType }] : [] } : undefined,
    formatDate: d => localDateStr(d.getTime()),
    saveData: (key, value) => {
      if (key === 'study_timer_records') records = JSON.parse(JSON.stringify(value));
      return true;
    },
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
      removeItem: key => { store.delete(key); }
    },
    loadTimerRecords: () => records,
    saveTimerRecords: value => { records = JSON.parse(JSON.stringify(value)); return true; },
    genTimerRecordId: (() => { let n = 5000; return () => ++n; })(),
    sendNotification: () => {},
    renderTimer: () => {},
    updateTimerFloat: () => {},
    createTimerFloat: () => makeElement('timerFloat'),
    makeTimerFloatDraggable: () => {},
    showCustomConfirm: () => Promise.resolve(true),
    document: documentStub,
    window: { addEventListener: () => {}, innerWidth: 1200, innerHeight: 800 },
    lucide: { createIcons: () => {} },
    todos: [],
    getChildren: () => [],
    getAllDescendantIds: () => [],
    getAncestorPath: () => [],
    escapeAttr: v => String(v),
    escapeHtml: v => String(v),
    findTodo: () => null,
    loadGoals: () => [],
    loadTimerRecordsRaw: () => records
  });
  vm.runInContext(timerSource, context);
  return {
    ctx: context,
    getRecords: () => records,
    state: () => (store.has('study_timer_state') ? JSON.parse(store.get('study_timer_state')) : null)
  };
}

// 运行在「刚重启」这一刻的恢复逻辑
function restore(options) {
  const harness = createContext(options);
  vm.runInContext('loadAndRestoreTimerState();', harness.ctx);
  return harness;
}

// 读取计时器模块里的 let 变量（模块内部状态不在 context 对象上）
function timerState(harness) {
  return vm.runInContext(`({
    running: timerRunning,
    elapsed: timerElapsed,
    sessionStart: timerSessionStart,
    sessions: timerSessions,
    resumed: timerResumedFromRestart,
    staleNotice: timerStaleNotice
  })`, harness.ctx);
}

// ── 重启后的显示时长 ──

test('刚关掉就重开（半小时内）：自动接着计时，且不含离线空白', () => {
  const now = Date.now();
  const sessionStart = now - HOUR;               // 一小时前点的开始
  const lastActiveAt = now - 30 * 60 * 1000;     // 跑了 30 分钟后关掉
  const harness = restore({
    savedState: {
      running: true,
      elapsed: 0,
      displayMs: 30 * 60 * 1000,   // 关掉那一刻界面上显示 30 分钟
      sessionStart,
      sessions: [],
      name: '线性代数',
      linkedTodoId: null,
      linkedGoalId: null,
      savedAt: lastActiveAt,
      lastActiveAt
    }
  });

  const state = timerState(harness);
  // 已计时长 = 关掉前累计的时长，重启后从这一刻继续
  assert.equal(state.elapsed, 30 * 60 * 1000);
  assert.equal(state.running, true);
  assert.equal(state.resumed, true);
  assert.equal(state.staleNotice, null);
  // 新一段从「现在」开始，而不是一小时前
  assert.ok(Math.abs(state.sessionStart - now) < 5000);
  const displayed = state.elapsed + (Date.now() - state.sessionStart);
  assert.ok(displayed < 31 * 60 * 1000, '显示时长不应包含离线空白，实际：' + Math.round(displayed / 60000) + ' 分钟');
  // 上一段被封口在最后一刻仍在跑的时间点上
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].start, sessionStart);
  assert.equal(state.sessions[0].end, lastActiveAt);
});

test('Ctrl+Shift+R 刷新继续同一个时段，不在刷新点切成两段', () => {
  const now = Date.now();
  const sessionStart = now - 20 * 60 * 1000;
  const harness = restore({
    navigationType: 'reload',
    savedState: {
      running: true,
      elapsed: 0,
      displayMs: 20 * 60 * 1000,
      sessionStart,
      sessions: [],
      name: '连续阅读',
      linkedTodoId: null,
      linkedGoalId: null,
      savedAt: now - 500,
      lastActiveAt: now - 500
    }
  });
  const state = timerState(harness);
  assert.equal(state.running, true);
  assert.equal(state.sessions.length, 0);
  assert.equal(state.sessionStart, sessionStart);
  assert.ok(state.elapsed + Date.now() - state.sessionStart >= 20 * 60 * 1000);
});

test('很久以前忘了停的计时器：只找回时长，不会自己跑起来', () => {
  const now = Date.now();
  const lastActiveAt = now - 3 * 24 * HOUR;      // 三天前关的应用
  const sessionStart = lastActiveAt - 25 * 60 * 1000;
  const harness = restore({
    savedState: {
      running: true, elapsed: 0, displayMs: 25 * 60 * 1000,
      sessionStart, sessions: [], name: '英语听力',
      linkedTodoId: null, linkedGoalId: null,
      savedAt: lastActiveAt, lastActiveAt
    }
  });

  const state = timerState(harness);
  assert.equal(state.running, false);            // 关键：不会凭空出现一个正在走的计时器
  assert.equal(state.resumed, false);
  assert.equal(state.elapsed, 25 * 60 * 1000);   // 时长没丢
  assert.match(state.staleNotice, /已找回上次未结束的计时/);
  assert.ok(state.sessions.length >= 1);
});

test('恢复计时提示可以关闭，且关闭后状态不会在重绘时恢复', () => {
  const now = Date.now();
  const harness = restore({
    savedState: {
      running: true, elapsed: 0, displayMs: 5 * 60 * 1000,
      sessionStart: now - 5 * 60 * 1000, sessions: [], name: '',
      linkedTodoId: null, linkedGoalId: null, savedAt: now - 1000, lastActiveAt: now - 1000
    }
  });
  assert.equal(timerState(harness).resumed, true);
  vm.runInContext('dismissTimerResumeNotice();', harness.ctx);
  const state = timerState(harness);
  assert.equal(state.resumed, false);
  assert.equal(state.staleNotice, null);
});

test('今日累计包含当天所有记录，不受当前关联项影响', () => {
  const { ctx } = createContext();
  const total = vm.runInContext(`getTodayTimerTotalMs([
    { date: '2026-09-24', totalMs: 60000, todoId: 1 },
    { date: '2026-09-24', totalMs: 120000, todoId: 2 },
    { date: '2026-09-23', totalMs: 999000, todoId: 1 }
  ], '2026-09-24')`, ctx);
  assert.equal(total, 180000);
});

test('找回的陈旧时长可以继续计时（点开始后正常累加）', () => {
  const now = Date.now();
  const lastActiveAt = now - 3 * 24 * HOUR;
  const harness = restore({
    savedState: {
      running: true, elapsed: 0, displayMs: 25 * 60 * 1000,
      sessionStart: lastActiveAt - 25 * 60 * 1000, sessions: [],
      name: '', linkedTodoId: null, linkedGoalId: null,
      savedAt: lastActiveAt, lastActiveAt
    }
  });
  vm.runInContext('timerStart();', harness.ctx);
  const state = timerState(harness);
  assert.equal(state.running, true);
  assert.equal(state.staleNotice, null);
  assert.ok(state.elapsed >= 25 * 60 * 1000);
});

test('找回的陈旧时长可以保存成记录', () => {
  const now = Date.now();
  const lastActiveAt = now - 3 * 24 * HOUR;
  const harness = restore({
    savedState: {
      running: true, elapsed: 0, displayMs: 25 * 60 * 1000,
      sessionStart: lastActiveAt - 25 * 60 * 1000, sessions: [],
      name: '听力', linkedTodoId: null, linkedGoalId: null,
      savedAt: lastActiveAt, lastActiveAt
    }
  });
  // 用户点「保存」（不是「停止并保存」，所以走 timerSave 分支）
  vm.runInContext('timerElapsed = 25 * 60 * 1000; timerSave();', harness.ctx);
  const records = harness.getRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].name, '听力');
  assert.ok(records[0].totalMs >= 25 * 60 * 1000);
});

test('重启后继续计时的时长会正常累加（刚关掉就重开）', () => {
  const now = Date.now();
  const harness = restore({
    savedState: {
      running: true, elapsed: 5 * 60 * 1000, displayMs: 5 * 60 * 1000,
      sessionStart: now - 5 * 60 * 1000,
      sessions: [], name: '', linkedTodoId: null, linkedGoalId: null,
      savedAt: now - 30000, lastActiveAt: now - 30000
    }
  });
  assert.equal(timerState(harness).elapsed, 5 * 60 * 1000);
  assert.equal(timerState(harness).running, true);
  // 模拟恢复后过了 10 秒
  vm.runInContext('timerSessionStart = Date.now() - 10000;', harness.ctx);
  const total = timerState(harness).elapsed + (Date.now() - timerState(harness).sessionStart);
  assert.ok(total >= 5 * 60 * 1000 + 9000 && total < 5 * 60 * 1000 + 20000);
});

test('暂停后又点继续再重启：显示时长不会因为刷新而变少', () => {
  const now = Date.now();
  // 第一段跑了 20 分钟（已封口），第二段跑了 30 秒后被关掉
  const firstStart = now - HOUR;
  const firstEnd = firstStart + 20 * 60 * 1000;
  const secondStart = now - 2 * 60 * 1000;
  const displayMs = 20 * 60 * 1000 + 30 * 1000;
  const harness = restore({
    savedState: {
      running: true, elapsed: 20 * 60 * 1000, displayMs,
      sessionStart: secondStart,
      sessions: [{ start: firstStart, end: firstEnd }],
      name: '', linkedTodoId: null, linkedGoalId: null,
      savedAt: secondStart + 30 * 1000, lastActiveAt: secondStart + 30 * 1000
    }
  });
  const state = timerState(harness);
  const displayed = state.elapsed + (Date.now() - state.sessionStart);
  assert.ok(displayed >= displayMs && displayed < displayMs + 3000, '显示时长应保持 ' + displayMs + '，实际 ' + displayed);
  // 两段都要保留（第一段 + 重启前的第二段）
  assert.equal(state.sessions.length, 2);
  assert.ok(state.elapsed >= 20 * 60 * 1000);
});

test('旧版本存档（没有 lastActiveAt）用 savedAt 兜底，同样不补离线空白', () => {
  const now = Date.now();
  const savedAt = now - 4 * HOUR;
  const harness = restore({
    savedState: {
      running: true, elapsed: 12 * 60 * 1000, displayMs: 12 * 60 * 1000,
      sessionStart: savedAt - 12 * 60 * 1000,
      sessions: [], name: '', linkedTodoId: null, linkedGoalId: null, savedAt
    }
  });
  const state = timerState(harness);
  assert.equal(state.elapsed, 12 * 60 * 1000);
  const displayed = state.elapsed + (Date.now() - state.sessionStart);
  assert.ok(displayed < 13 * 60 * 1000);
  assert.equal(state.sessions[0].end, savedAt);
});

test('暂停中的计时器恢复后不会自己跑起来', () => {
  const now = Date.now();
  const harness = restore({
    savedState: {
      running: false, elapsed: 20 * 60 * 1000, sessionStart: now - HOUR,
      sessions: [{ start: now - HOUR, end: now - 40 * 60 * 1000 }],
      name: '', linkedTodoId: null, linkedGoalId: null, savedAt: now - 40 * 60 * 1000, lastActiveAt: now - 40 * 60 * 1000
    }
  });
  const state = timerState(harness);
  assert.equal(state.running, false);
  assert.equal(state.elapsed, 20 * 60 * 1000);
});

// ── 保存记录时的兜底 ──

test('保存记录时把超出实际时长的尾巴剪掉', () => {
  const now = Date.now();
  const savedAt = now - 3 * HOUR;
  const harness = restore({
    savedState: {
      running: true, elapsed: 0, displayMs: 30 * 60 * 1000,
      sessionStart: savedAt - 30 * 60 * 1000,
      sessions: [], name: '刷题', linkedTodoId: null, linkedGoalId: null,
      savedAt, lastActiveAt: savedAt
    }
  });
  const ctx = harness.ctx;
  // 模拟用户在恢复后立刻点「停止并保存」（重启前那一段的跨度是 30 分钟 + 3 小时空白）
  ctx.timerStop();
  const records = harness.getRecords();
  assert.equal(records.length, 1);
  const totalMs = records[0].totalMs;
  assert.ok(totalMs >= 30 * 60 * 1000 && totalMs < 31 * 60 * 1000, '实际时长：' + totalMs);
  const span = records[0].sessions.reduce((acc, s) => acc + (s.end - s.start), 0);
  assert.ok(span <= totalMs + 1000, '时段跨度不应超过实际时长：' + span);
  // 记录里不应出现覆盖三小时离线空白的时段
  for (const s of records[0].sessions) {
    assert.ok(s.end - s.start <= totalMs, '单个时段跨度过大：' + (s.end - s.start));
  }
});

test('normalizeTimerSessionsForRecord 保持正常数据原样、按时长等比例裁剪超长数据', () => {
  const { ctx } = createContext();
  const normal = [{ start: 1000, end: 61000 }];
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.normalizeTimerSessionsForRecord(normal, 60000))), normal);

  const inflated = [
    { start: 0, end: 3 * HOUR },
    { start: 3 * HOUR, end: 3 * HOUR + 60000 }
  ];
  const trimmed = JSON.parse(JSON.stringify(ctx.normalizeTimerSessionsForRecord(inflated, 10 * 60 * 1000)));
  const span = trimmed.reduce((acc, s) => acc + (s.end - s.start), 0);
  assert.equal(span, 10 * 60 * 1000);
  assert.equal(trimmed[0].start, 0);
  assert.equal(trimmed.length, 1);
  for (const s of trimmed) assert.ok(s.end > s.start);
});

test('首尾时间完全相接的时段会自动合并，真实暂停间隔会保留', () => {
  const { ctx } = createContext();
  const merged = JSON.parse(JSON.stringify(ctx.mergeContiguousTimerSessions([
    { start: 1000, end: 2000 },
    { start: 2000, end: 3500 },
    { start: 4000, end: 5000 }
  ])));
  assert.deepEqual(merged, [
    { start: 1000, end: 3500 },
    { start: 4000, end: 5000 }
  ]);
});

test('相邻且标题与全部绑定相同的计时记录合并，任务绑定不同则不合并', () => {
  const { ctx } = createContext();
  const records = [
    { id: 1, name: '复习', date: '2026-09-21', totalMs: 1000, sessions: [{ start: 1000, end: 2000 }], todoId: 11, goalId: 22, taskId: 33, affectsFocus: true },
    { id: 2, name: '复习', date: '2026-09-21', totalMs: 1000, sessions: [{ start: 3000, end: 4000 }], todoId: 11, goalId: 22, taskId: 33, affectsFocus: true },
    { id: 3, name: '复习', date: '2026-09-21', totalMs: 1000, sessions: [{ start: 5000, end: 6000 }], todoId: 11, goalId: 22, taskId: 44, affectsFocus: true }
  ];
  const merged = JSON.parse(JSON.stringify(ctx.mergeAdjacentTimerRecords(records)));
  assert.equal(merged.length, 2);
  assert.equal(merged[0].totalMs, 2000);
  assert.deepEqual(merged[0].sessions, [{ start: 1000, end: 2000 }, { start: 3000, end: 4000 }]);
  assert.equal(merged[0].taskId, 33);
  assert.equal(merged[1].taskId, 44);
});

test('时间轴中插入了其他计时记录时，前后相同记录也不会合并', () => {
  const { ctx } = createContext();
  // 存储数组故意把两条 A 放在一起；真实时间轴是 A → B → A。
  const records = [
    { id: 1, name: 'A', date: '2026-09-21', totalMs: 1000, sessions: [{ start: 1000, end: 2000 }], taskId: 33, affectsFocus: true },
    { id: 2, name: 'A', date: '2026-09-21', totalMs: 1000, sessions: [{ start: 5000, end: 6000 }], taskId: 33, affectsFocus: true },
    { id: 3, name: 'B', date: '2026-09-21', totalMs: 1000, sessions: [{ start: 3000, end: 4000 }], taskId: 44, affectsFocus: true }
  ];
  const merged = JSON.parse(JSON.stringify(ctx.mergeAdjacentTimerRecords(records)));
  assert.equal(merged.length, 3);
  assert.equal(merged.filter(record => record.name === 'A').length, 2);
});
