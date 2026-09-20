'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const text = require('../js/habit-status-text');

const habit = (over = {}) => Object.assign({
  name: '跑步', emoji: '🏃', dailyTarget: 1, dayCount: 0, dayMet: false,
  todayCount: 0, todayMet: false, streak: 0, streakThroughYesterday: 0, bestStreak: 0,
  weekDone: 0
}, over);

test('口径说明明确「连续达标 N 天」不是未完成天数', () => {
  assert.match(text.STREAK_MEANING, /连续 N 天完成了该习惯/);
  assert.match(text.STREAK_MEANING, /不是未完成天数/);
});

test('早间日报：昨日达标时给出截至昨日的连续达标天数', () => {
  const line = text.morningLine(habit({ dayCount: 1, dayMet: true, streak: 5, streakThroughYesterday: 5 }));
  assert.match(line, /昨日已达标\(1\/1\)/);
  assert.match(line, /截至昨日已连续达标 5 天/);
});

test('早间日报：昨日未达标但今日已达标时说明重新起算，不出现「连续 N 天」歧义', () => {
  const line = text.morningLine(habit({ todayMet: true, bestStreak: 12 }));
  assert.match(line, /昨日未达标\(0\/1\)/);
  assert.match(line, /今日已达标，连续天数从今日重新起算/);
  assert.ok(!/连续 12 天|连续达标 12 天/.test(line));
});

test('早间日报：连续中断时只把数字挂在「历史最佳」上', () => {
  const line = text.morningLine(habit({ bestStreak: 12 }));
  assert.match(line, /连续达标记录已中断（历史最佳 12 天）/);
});

test('早间日报：从未达标时给出无记录表述', () => {
  assert.match(text.morningLine(habit()), /暂无连续达标记录/);
});

test('晚间日报：今日达标时给出截至今日的连续达标天数', () => {
  const line = text.eveningLine(habit({ todayCount: 2, dailyTarget: 3, todayMet: true, streak: 5, streakThroughYesterday: 4 }));
  assert.match(line, /今日已达标\(2\/3\)/);
  assert.match(line, /截至今日已连续达标 5 天/);
});

test('晚间日报：今日未完成时连续天数标注为截至昨日（关键回归点）', () => {
  const line = text.eveningLine(habit({ todayCount: 0, streak: 4, streakThroughYesterday: 4 }));
  assert.match(line, /今日未完成\(0\/1\)/);
  assert.match(line, /截至昨日已连续达标 4 天（今日达标则延续为 5 天）/);
  assert.ok(!/未完成[^；]*连续 4 天/.test(line), '不得出现「未完成，连续 4 天」的歧义写法');
});

test('晚间日报：今日未完成且昨日之前就中断时标注历史最佳', () => {
  const line = text.eveningLine(habit({ bestStreak: 3 }));
  assert.match(line, /连续达标记录已中断（历史最佳 3 天）/);
});

test('晚间日报：无任何记录时的表述', () => {
  assert.match(text.eveningLine(habit()), /暂无连续达标记录/);
});

test('打卡连续天数标注统计截止日', () => {
  assert.equal(text.checkinText({ streak: 6, todayChecked: true }), '连续打卡 6 天（含今日，今日已打卡）');
  assert.equal(text.checkinText({ streak: 6, lastDate: '2026-09-18', yesterdayStr: '2026-09-18' }), '连续打卡 6 天（截至昨日，今日尚未打卡）');
  assert.equal(text.checkinText({ streak: 6, lastDate: '2026-09-10' }), '连续打卡 6 天（截至2026-09-10，今日尚未打卡）');
  assert.equal(text.checkinText({ streak: 0 }), '连续打卡 0 天（今日尚未打卡，暂无连续记录）');
  assert.equal(text.checkinText({ streak: 3 }), '连续打卡 3 天（今日尚未打卡）');
});

test('get_habits_status 工具块包含今日 / 连续达标 / 本周三行', () => {
  const block = text.habitStatusBlock(habit({ todayCount: 1, dailyTarget: 2, streak: 4, streakThroughYesterday: 4, weekDone: 3 }));
  const lines = block.split('\n');
  assert.match(lines[0], /🔄 🏃 跑步/);
  assert.match(lines[1], /今日：1\/2  进行中/);
  assert.match(lines[2], /连续达标 4 天（截至昨日；今日达标则延续为 5 天）  \|  本周达标：3\/7 天/);
  assert.ok(!/连续：/.test(block), '不得再使用裸的「连续：N 天」');
});

test('任何一行都不会出现「，连续 N 天」这种可被读反的写法', () => {
  const samples = [
    text.morningLine(habit({ dayCount: 1, dayMet: true, streak: 5, streakThroughYesterday: 5 })),
    text.morningLine(habit({ todayMet: true, bestStreak: 12 })),
    text.morningLine(habit({ bestStreak: 12 })),
    text.morningLine(habit()),
    text.eveningLine(habit({ todayMet: true, streak: 5 })),
    text.eveningLine(habit({ streak: 4, streakThroughYesterday: 4 })),
    text.eveningLine(habit({ bestStreak: 3 })),
    text.eveningLine(habit()),
    text.habitStatusBlock(habit({ streak: 2, streakThroughYesterday: 2, weekDone: 1 }))
  ].join('\n');
  assert.ok(!/，连续 \d+ 天/.test(samples));
});

test('日报与工具源码不再拼装歧义的连续天数文案', () => {
  const root = path.join(__dirname, '..');
  for (const file of ['js/settings.js', 'js/ai-tools.js', 'js/memory.js', 'js/today.js', 'js/stats.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(!/，连续 \$\{/.test(source), `${file} 仍有「，连续 \${…}」模板`);
    assert.ok(!/连续 \$\{checkinData\.streak\}/.test(source), `${file} 仍有裸的打卡连续天数模板`);
    assert.ok(!/连续打卡: \$\{ov\.streak\}天/.test(source), `${file} 仍有裸的打卡连续天数模板`);
  }
});
