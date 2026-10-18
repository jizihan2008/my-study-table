'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../js/ai-search.js'), 'utf8');

function device(seed = {}) {
  const values = new Map(Object.entries(seed));
  const notifications = [], toasts = [];
  const context = vm.createContext({
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) },
    document: { getElementById: () => null },
    safeSaveAiConvs: () => true,
    sendNotification: (...args) => notifications.push(args),
    showMiniToast: text => toasts.push(text),
    requestNotificationPermission() { context.permissionRequested = true; }
  });
  context.window = context;
  vm.runInContext(source, context);
  return { context, values, notifications, toasts };
}

test('completion reaches another device once, survives reload receipts, and targets its local conversation', () => {
  const a = device(), b = device();
  const conv = { id: 42, title: '学习计划' };
  a.context.recordAiTaskCompletion(conv, '<b>任务已完成</b>', '模型');
  const events = JSON.parse(JSON.stringify(conv.aiCompletions));
  a.context.receiveAiTaskCompletions(conv, events);
  assert.equal(a.notifications.length, 0);
  const local = { id: 99, title: '本地日报' };
  b.context.receiveAiTaskCompletions(local, events);
  b.context.receiveAiTaskCompletions(local, events);
  assert.equal(b.notifications.length, 1);
  assert.equal(b.toasts.length, 1);
  assert.equal(local._hasUnread, true);
  assert.equal(b.notifications[0][3].convId, 99);
  assert.match(b.notifications[0][1], /任务已完成/);
  const reloaded = device(Object.fromEntries(b.values));
  reloaded.context.receiveAiTaskCompletions(local, events);
  assert.equal(reloaded.notifications.length, 0);
  a.context.recordAiTaskCompletion(conv, '第二次完成', '模型');
  b.context.receiveAiTaskCompletions(local, conv.aiCompletions);
  assert.equal(b.notifications.length, 2);
});

test('disabled notifications consume events, and old results or missing completion metadata stay silent', () => {
  const a = device(), b = device({ study_ai_cross_device_notify: 'false' });
  const conv = { id: 1 };
  a.context.recordAiTaskCompletion(conv, '完成', 'AI');
  b.context.receiveAiTaskCompletions(conv, conv.aiCompletions);
  b.context.saveAiCrossDeviceNotificationSetting(true);
  assert.equal(b.context.permissionRequested, true);
  b.context.receiveAiTaskCompletions(conv, conv.aiCompletions);
  b.context.receiveAiTaskCompletions(conv, [{ ...conv.aiCompletions[0], id: 'old', at: Date.now() - 25 * 3600000 }]);
  b.context.receiveAiTaskCompletions(conv, undefined);
  assert.equal(b.notifications.length, 0);
  assert.equal(b.toasts.length, 0);
});

test('empty output does not record completion and event storage stays bounded', () => {
  const a = device(), conv = {};
  a.context.recordAiTaskCompletion(conv, '  ');
  assert.equal(conv.aiCompletions, undefined);
  for (let i = 0; i < 30; i++) a.context.recordAiTaskCompletion(conv, 'done ' + i);
  assert.equal(conv.aiCompletions.length, 20);
  assert.equal(conv.aiCompletions[19].preview, 'done 29');
});
