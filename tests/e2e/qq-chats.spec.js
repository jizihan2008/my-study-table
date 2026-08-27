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
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-qq-e2e-'));
  electronApp = await electron.launch({
    args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath }
  });
  page = await electronApp.firstWindow();
  await page.waitForFunction(() => document.readyState !== 'loading' && !!window.QQChats);
});

test.afterAll(async () => {
  if (electronApp) await electronApp.close();
  if (userDataPath) await fs.rm(userDataPath, { recursive: true, force: true });
});

test('chunked QQ import is staged, chronological and merge-safe', async () => {
  const result = await page.evaluate(async () => {
    const manifest = {
      chatInfo: { type: 'group', name: '测试群', peerUin: '778899', selfUin: '10001' },
      statistics: { totalMessages: 3 }
    };
    const raw = (id, timestamp, sender, text) => ({
      id, timestamp, time: new Date(timestamp).toISOString(),
      sender: { uin: sender, name: sender === '10001' ? '我' : '同学' },
      content: { text }, type: 'text'
    });
    const first = await window.QQChats.beginChunkedImport(manifest, {});
    await window.QQChats.appendChunkedImport(first.sessionId, [
      raw('b', Date.UTC(2026, 7, 26, 10), '20002', 'topic 较新'),
      raw('a', Date.UTC(2026, 7, 26, 9), '10001', 'topic 较早')
    ]);
    const beforeCommit = await window.QQChats.getStats();
    await window.QQChats.appendChunkedImport(first.sessionId, [
      raw('c', Date.UTC(2026, 7, 27, 9), '20002', '第二天消息')
    ]);
    const committed = await window.QQChats.finishChunkedImport(first.sessionId);
    const ordered = await window.QQChats.getMessages(committed.chatId, 0, 20);
    await window.QQChats.setDailyReport(committed.chatId, '2026-08-26', { report: '- 旧日报 (m0)', items: [{ text: '旧日报', order: 0 }] });

    const merge = await window.QQChats.beginChunkedImport(manifest, { merge: true });
    await window.QQChats.appendChunkedImport(merge.sessionId, [
      raw('a', Date.UTC(2026, 7, 26, 9), '10001', 'topic 较早'),
      raw('d', Date.UTC(2026, 7, 26, 8), '20002', 'topic 补导历史')
    ]);
    const merged = await window.QQChats.finishChunkedImport(merge.sessionId);
    const afterMerge = await window.QQChats.getMessages(committed.chatId, 0, 20);
    const chats = await window.QQChats.listChats();
    const position = await window.QQChats.getMessagePosition(committed.chatId, afterMerge[0].order);
    const search = await window.QQChats.searchMessages('topic', committed.chatId, 10, { sender: '同学', dateFrom: '2026-08-26', dateTo: '2026-08-26' });
    return {
      beforeCommit,
      committedTotal: committed.chat.total,
      firstOrder: ordered.map(item => item.id),
      mergedAdded: merged.added,
      mergedSkipped: merged.existingCount,
      afterMergeOrder: afterMerge.map(item => item.id),
      stale: chats[0].dailyReports[0].stale,
      preservedReport: chats[0].dailyReports[0].report,
      position,
      search: search.map(item => item.id || item.text)
    };
  });

  expect(result.beforeCommit).toEqual({ chats: 0, messages: 0 });
  expect(result.committedTotal).toBe(3);
  expect(result.firstOrder).toEqual(['a', 'b', 'c']);
  expect(result.mergedAdded).toBe(1);
  expect(result.mergedSkipped).toBe(1);
  expect(result.afterMergeOrder).toEqual(['d', 'a', 'b', 'c']);
  expect(result.stale).toBe(true);
  expect(result.preservedReport).toContain('旧日报');
  expect(result.position).toBe(0);
  expect(result.search).toEqual(['topic 较新', 'topic 补导历史']);
});

test('QQ backup restores chats, messages and reports', async () => {
  const result = await page.evaluate(async () => {
    const backup = await window.QQChats.exportDatabase();
    const chatId = backup.chats[0].chatId;
    await window.QQChats.deleteChat(chatId);
    const empty = await window.QQChats.getStats();
    const restored = await window.QQChats.restoreDatabase(backup);
    const stats = await window.QQChats.getStats();
    const chats = await window.QQChats.listChats();
    return { empty, restored, stats, report: chats[0].dailyReports[0].report };
  });
  expect(result.empty).toEqual({ chats: 0, messages: 0 });
  expect(result.restored).toEqual({ chats: 1, messages: 4 });
  expect(result.stats).toEqual({ chats: 1, messages: 4 });
  expect(result.report).toContain('旧日报');
});

test('QQ search UI uses delegated events and opens the matching message', async () => {
  await page.evaluate(() => {
    window.switchTab('inbox');
    window.Inbox.openChatList();
  });
  await expect(page.locator('#inboxQQSearchQuery')).toBeVisible();
  await page.fill('#inboxQQSearchQuery', '补导历史');
  await page.click('[data-qq-action="search"]');
  await expect(page.locator('.chat-search-result')).toHaveCount(1);
  await expect(page.locator('.chat-search-result mark')).toHaveText('补导历史');
  await page.click('.chat-search-result');
  await expect(page.locator('.chat-view')).toBeVisible();
  await expect(page.locator('.chat-text', { hasText: 'topic 补导历史' })).toBeVisible();
});
