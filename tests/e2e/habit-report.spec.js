'use strict';

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let electronApp;
let page;
let userDataPath;

const dateStr = daysAgo => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

// 播下「昨日及之前连续 4 天达标」的习惯；todayMet 决定今日是否已达标
async function seedHabit(todayMet) {
  return page.evaluate(({ todayMet }) => {
    const ds = daysAgo => {
      const d = new Date();
      d.setDate(d.getDate() - daysAgo);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    };
    const checkins = {};
    [1, 2, 3, 4].forEach(n => { checkins[ds(n)] = 1; });
    if (todayMet) checkins[ds(0)] = 1;
    localStorage.setItem('study_habits_v2', JSON.stringify([
      { id: 991, name: '跑步', emoji: '🏃', dailyTarget: 1, weeklyTarget: 7, checkins, createdAt: Date.now() }
    ]));
    loadHabits();
  }, { todayMet });
}

test.beforeAll(async () => {
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-habit-report-e2e-'));
  electronApp = await electron.launch({
    args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath }
  });
  page = await electronApp.firstWindow();
  await page.waitForFunction(() => typeof window.collectDailyReportData === 'function'
    && typeof window.collectEveningReportData === 'function'
    && typeof window.HabitStatusText !== 'undefined'
    && typeof window.loadHabits === 'function'
    && typeof window.calcStreak === 'function');
});

test.afterAll(async () => {
  if (electronApp) await electronApp.close();
  if (userDataPath) await fs.rm(userDataPath, { recursive: true, force: true });
});

test('今日未完成的习惯不会写出「未完成，连续 N 天」', async () => {
  await seedHabit(false);
  const out = await page.evaluate(async () => ({
    streak: calcStreak(loadHabits()[0]),
    morning: reportHabitLines(collectDailyReportData().habitsOverview, 'morning'),
    evening: reportHabitLines(collectEveningReportData().habitsOverview, 'evening'),
    tool: await executeToolCall('get_habits_status', {})
  }));

  expect(out.streak).toMatchObject({ streak: 4, streakThroughYesterday: 4, streakThroughToday: 0, todayMet: false });
  expect(out.morning).toContain('昨日已达标(1/1)；截至昨日已连续达标 4 天');
  expect(out.evening).toContain('今日未完成(0/1)；截至昨日已连续达标 4 天（今日达标则延续为 5 天）');
  expect(out.morning + out.evening).not.toMatch(/，连续 4 天/);
  expect(out.morning).toContain('不是未完成天数');   // 口径说明随数据一起给到 AI

  expect(out.tool).toContain('连续达标 4 天（截至昨日；今日达标则延续为 5 天）');
  expect(out.tool).not.toContain('连续：4 天');
});

test('今日已达标时连续天数含今日', async () => {
  await seedHabit(true);
  const out = await page.evaluate(async () => ({
    streak: calcStreak(loadHabits()[0]),
    evening: reportHabitLines(collectEveningReportData().habitsOverview, 'evening'),
    tool: await executeToolCall('get_habits_status', {})
  }));

  expect(out.streak).toMatchObject({ streak: 5, streakThroughYesterday: 4, streakThroughToday: 5, todayMet: true });
  expect(out.evening).toContain('今日已达标(1/1)；截至今日已连续达标 5 天');
  expect(out.tool).toContain('连续达标 5 天（含今日）');
});

test('学习打卡连续天数标注统计截止日', async () => {
  const text = await page.evaluate(() => {
    const today = getTodayStr();
    const d = new Date(); d.setDate(d.getDate() - 1);
    const yesterday = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    localStorage.setItem('study_checkin', JSON.stringify({ dates: [yesterday], streak: 2, lastDate: yesterday, checkinTimes: {} }));
    const before = formatCheckinStreakText(loadCheckinData());
    const reportLine = reportCheckinStreakText(collectDailyReportData());
    localStorage.setItem('study_checkin', JSON.stringify({ dates: [yesterday, today], streak: 3, lastDate: today, checkinTimes: {} }));
    const after = formatCheckinStreakText(loadCheckinData());
    return { before, reportLine, after };
  });

  expect(text.before).toBe('连续打卡 2 天（截至昨日，今日尚未打卡）');
  expect(text.reportLine).toBe('连续打卡 2 天（截至昨日，今日尚未打卡）');
  expect(text.after).toBe('连续打卡 3 天（含今日，今日已打卡）');
});
