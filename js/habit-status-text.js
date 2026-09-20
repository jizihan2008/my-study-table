/* Pure text formatters for habit / check-in status shown to the AI.
 * 目的：把「连续 N 天」明确标注为「连续达标 N 天 + 统计截止日」，
 * 避免 AI 把「未完成，连续 12 天」误读成「连续 12 天没完成」。
 * 与 DOM、localStorage 无关，便于单元测试（tests/habit-status-text.test.js）。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HabitStatusText = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // 放在数据区块标题里的口径说明，直接告诉 AI 该怎么读这个数字
  const STREAK_MEANING = '「连续达标 N 天」＝ 连续 N 天完成了该习惯（达标天数，不是未完成天数）；今日尚未达标时，N 统计截至昨日。';

  function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function target(h) { return Math.max(1, num(h && h.dailyTarget, 1)); }

  function who(h) {
    const emoji = (h && h.emoji) ? String(h.emoji) + ' ' : '';
    return emoji + ((h && h.name) ? String(h.name) : '未命名习惯');
  }

  // 早间日报：回顾昨天（昨日是否达标 + 截至昨日的连续达标天数）
  function morningLine(h) {
    const t = target(h);
    const count = num(h.dayCount, 0);
    const through = num(h.streakThroughYesterday, 0);
    const best = num(h.bestStreak, 0);
    let detail;
    if (h.dayMet) {
      detail = `昨日已达标(${count}/${t})；截至昨日已连续达标 ${through} 天`;
    } else if (h.todayMet) {
      detail = `昨日未达标(${count}/${t})；今日已达标，连续天数从今日重新起算`;
    } else if (best > 0) {
      detail = `昨日未达标(${count}/${t})；连续达标记录已中断（历史最佳 ${best} 天）`;
    } else {
      detail = `昨日未达标(${count}/${t})；暂无连续达标记录`;
    }
    return `  - ${h.dayMet ? '✓' : '○'} ${who(h)} — ${detail}`;
  }

  // 晚间日报：回顾今天（今日是否达标 + 截至今日/昨日的连续达标天数）
  function eveningLine(h) {
    const t = target(h);
    const count = num(h.todayCount, 0);
    const streak = num(h.streak, 0);
    const through = num(h.streakThroughYesterday, 0);
    const best = num(h.bestStreak, 0);
    let detail;
    if (h.todayMet) {
      detail = `今日已达标(${count}/${t})；截至今日已连续达标 ${streak} 天`;
    } else if (through > 0) {
      detail = `今日未完成(${count}/${t})；截至昨日已连续达标 ${through} 天（今日达标则延续为 ${through + 1} 天）`;
    } else if (best > 0) {
      detail = `今日未完成(${count}/${t})；连续达标记录已中断（历史最佳 ${best} 天）`;
    } else {
      detail = `今日未完成(${count}/${t})；暂无连续达标记录`;
    }
    return `  - ${h.todayMet ? '✓' : '○'} ${who(h)} — ${detail}`;
  }

  // 学习打卡（非习惯）连续天数：同样标注统计截止日
  function checkinText(status) {
    const s = status || {};
    const streak = num(s.streak, 0);
    const lastDate = s.lastDate ? String(s.lastDate) : '';
    if (s.todayChecked) return `连续打卡 ${streak} 天（含今日，今日已打卡）`;
    if (streak > 0) {
      if (!lastDate) return `连续打卡 ${streak} 天（今日尚未打卡）`;
      const anchor = (s.yesterdayStr && lastDate === s.yesterdayStr) ? '昨日' : lastDate;
      return `连续打卡 ${streak} 天（截至${anchor}，今日尚未打卡）`;
    }
    return '连续打卡 0 天（今日尚未打卡，暂无连续记录）';
  }

  // get_habits_status 工具输出：单个习惯的今日 / 连续达标 / 本周达标 三行
  function habitStatusBlock(h) {
    const t = target(h);
    const count = num(h.todayCount, 0);
    const streak = num(h.streak, 0);
    const through = num(h.streakThroughYesterday, 0);
    const best = num(h.bestStreak, 0);
    const icon = h.todayMet ? '✅' : (count > 0 ? '🔄' : '⬜');
    let streakText;
    if (h.todayMet) streakText = `连续达标 ${streak} 天（含今日）`;
    else if (through > 0) streakText = `连续达标 ${through} 天（截至昨日；今日达标则延续为 ${through + 1} 天）`;
    else streakText = `连续达标 0 天（无连续记录${best > 0 ? `，历史最佳 ${best} 天` : ''}）`;
    return [
      `${icon} ${who(h)}`,
      `   今日：${count}/${t}  ${h.todayMet ? '✓已达标' : (count > 0 ? '进行中' : '未开始')}`,
      `   ${streakText}  |  本周达标：${num(h.weekDone, 0)}/7 天`
    ].join('\n');
  }

  return {
    STREAK_MEANING: STREAK_MEANING,
    morningLine: morningLine,
    eveningLine: eveningLine,
    checkinText: checkinText,
    habitStatusBlock: habitStatusBlock
  };
});
