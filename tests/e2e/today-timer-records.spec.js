'use strict';
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('today timer expands and filters; both reports include types and totals', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-today-timer-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof renderTodayTimerRecords === 'function' && document.readyState !== 'loading');
    await page.waitForFunction(() => document.querySelector('#section-today.active'));
    const reports = await page.evaluate(() => {
      const today = getTodayStr(), yesterday = getPastDateStr(1);
      const records = [today, yesterday].flatMap((date, day) => Array.from({ length: 12 }, (_, i) => {
        const start = new Date(date + 'T08:00:00').getTime() + i * 1800000;
        const record = { id: day * 100 + i + 1, date, name: `记录 ${i}`, totalMs: 600000,
          sessions: [{ start, end: start + 300000 }, { start: start + 360000, end: start + 660000 }] };
        // Old focus/non-focus records must be classified using the same fallback as the timer.
        if (i % 3 === 1) Object.assign(record, { activityType: 'rest', affectsFocus: false });
        if (i % 3 === 2) record.affectsFocus = false;
        return record;
      }));
      saveTimerRecords(records);
      switchTab('today');
      const morning = collectDailyReportData(), evening = collectEveningReportData();
      return [
        { data: morning, prefix: 'yday', json: reportPromptData('morning', morning), preview: friendlyPromptDataHtml('', 'morning', { previewData: morning }) },
        { data: evening, prefix: 'today', json: reportPromptData('evening', evening), preview: friendlyPromptDataHtml('', 'evening', { previewData: evening }) }
      ];
    });
    for (const { data, prefix, json, preview } of reports) {
      expect(data[prefix + 'TimerSessions']).toHaveLength(24);
      expect(data[prefix + 'TimerTypeTotals'].map(t => t.totalMs)).toEqual([2400000, 2400000, 2400000]);
      expect(data[prefix + 'TimerTypeTotals'].map(t => t.duration)).toEqual(['40 分钟', '40 分钟', '40 分钟']);
      expect(new Set(data[prefix + 'TimerSessions'].map(s => s.activityLabel))).toEqual(new Set(['专注', '休息', '其它']));
      expect(data[prefix + 'TimerStr']).toBe('2 小时 0 分钟');
      for (const label of ['专注', '休息', '其它']) { expect(json).toContain(label); expect(preview).toContain(label); }
      expect(preview).toContain('各类型时长');
    }
    // Evaluate the exact timer portion of both legacy prompt templates.
    const source = await fs.readFile('js/settings.js', 'utf8');
    for (const { data, prefix } of reports) {
      const start = source.indexOf(prefix === 'yday' ? '【昨日计时】' : '【今日计时】');
      const end = source.indexOf('\n【', source.indexOf('TimerSessions.map', start));
      const template = source.slice(start, end);
      const text = new Function('data', 'return `' + template + '`;')(data);
      expect(text).toContain('专注：40 分钟；休息：40 分钟；其它：40 分钟');
      for (const label of ['专注', '休息', '其它']) expect(text).toContain(`[${label}]`);
    }
    const list = page.locator('#todayTimerRecords');
    const focusTotal = page.locator('#todayTimerFocusTotal');
    const otherTotal = page.locator('#todayTimerOtherTotal');
    await expect(focusTotal).toHaveText('40:00');
    await expect(otherTotal).toHaveText('1:20:00');
    await expect(list.locator('.timer-history-item')).toHaveCount(12);
    expect(await list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await page.locator('#todayTimerExpand').click();
    await expect(page.locator('#todayTimerExpand')).toHaveAttribute('aria-expanded', 'true');
    expect(await list.evaluate(el => getComputedStyle(el).maxHeight)).toBe('none');
    expect(await list.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    for (const type of ['focus', 'rest', 'other']) {
      await page.locator('#todayTimerTypeFilter').selectOption(type);
      await expect(list.locator('.timer-history-item')).toHaveCount(4);
      await page.evaluate(() => renderToday());
      await expect(page.locator('#todayTimerTypeFilter')).toHaveValue(type);
      await expect(page.locator('#todayTimerExpand')).toHaveAttribute('aria-expanded', 'true');
      await expect(focusTotal).toHaveText('40:00');
      await expect(otherTotal).toHaveText('1:20:00');
    }
    await page.locator('#todayTimerTypeFilter').selectOption('all');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => applyTheme(theme), theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.locator('.today-timer-card').scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await list.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        await page.locator('.today-timer-card').screenshot({ path: `test-results/today-timer-${theme}-${width}.png` });
      }
    }
    await page.locator('#todayTimerExpand').click();
    expect(await list.evaluate(el => getComputedStyle(el).maxHeight)).toBe('320px');
    await page.evaluate(() => saveTimerRecords([]));
    await expect(focusTotal).toHaveText('0:00');
    await expect(otherTotal).toHaveText('0:00');
    await page.locator('#todayTimerTypeFilter').selectOption('rest');
    await expect(list).toContainText('今天还没有此类型的计时记录');
    await page.locator('#todayTimerTypeFilter').selectOption('all');
    await expect(list).toContainText('今天还没有计时记录');
    const zero = await page.evaluate(() => collectEveningReportData().todayTimerTypeTotals);
    expect(zero.map(t => t.duration)).toEqual(['0 分钟', '0 分钟', '0 分钟']);
    const unionReports = await page.evaluate(() => {
      const records = [getTodayStr(), getPastDateStr(1)].flatMap((date, day) =>
        [['focus', 9, 10], ['focus', 9.5, 11], ['rest', 10, 12], ['other', 11, 12]].map(([activityType, start, end], index) => {
          const midnight = new Date(date + 'T00:00:00').getTime();
          return { id: day * 10 + index + 1, date, name: `重叠记录${index}`, activityType,
            affectsFocus: activityType === 'focus', totalMs: (end - start) * 3600000,
            sessions: [{ start: midnight + start * 3600000, end: midnight + end * 3600000 }] };
        }));
      saveTimerRecords(records);
      return [collectDailyReportData(), collectEveningReportData()];
    });
    for (const [index, prefix] of ['yday', 'today'].entries()) {
      expect(unionReports[index][prefix + 'TimerStr']).toBe('3 小时 0 分钟');
      expect(unionReports[index][prefix + 'TimerTypeTotals'].map(t => t.totalMs)).toEqual([7200000, 7200000, 3600000]);
    }
    await expect(list.locator('.timer-history-date-total')).toHaveText('共 3:00:00');
    await expect(focusTotal).toHaveText('2:00:00');
    await expect(otherTotal).toHaveText('2:00:00');
    await page.locator('#todayTimerTypeFilter').selectOption('focus');
    await expect(list.locator('.timer-history-date-total')).toHaveText('共 2:00:00');
    // Union across different custom types in each group, with overlaps between groups too.
    await page.evaluate(() => {
      saveTimerActivityTypes([...loadTimerActivityTypes(),
        { id: 'reading', label: '阅读', affectsFocus: true, disabled: true },
        { id: 'travel', label: '通勤', affectsFocus: false }]);
      const date = getTodayStr(), hour = 3600000;
      const midnight = new Date(date + 'T00:00:00').getTime();
      saveTimerRecords([
        ['focus', true, 9, 11], ['reading', true, 10, 12],
        ['rest', false, 10, 12], ['travel', false, 11, 13],
        // Preserve a historical record's own flag even if its type now counts towards focus.
        ['reading', false, 12, 13]
      ].map(([activityType, affectsFocus, start, end], index) => ({
        id: 100 + index, date, name: `分组重叠${index}`, activityType, affectsFocus,
        totalMs: (end - start) * hour,
        sessions: [{ start: midnight + start * hour, end: midnight + end * hour }]
      })));
    });
    await expect(focusTotal).toHaveText('3:00:00');
    await expect(otherTotal).toHaveText('3:00:00');
    await page.locator('#todayTimerTypeFilter').selectOption('all');
    await expect(list.locator('.timer-history-date-total')).toHaveText('共 4:00:00');
    // Missing timestamps retain the application's legacy duration fallback; edits refresh totals.
    await page.evaluate(() => {
      const records = loadTimerRecords();
      records.push({ id: 200, date: getTodayStr(), name: '旧记录', activityType: 'other', affectsFocus: false, totalMs: 60000, sessions: [] });
      saveTimerRecords(records);
    });
    await expect(otherTotal).toHaveText('3:01:00');
    await page.evaluate(() => saveTimerRecords(loadTimerRecords().filter(record => record.activityType !== 'reading')));
    await expect(focusTotal).toHaveText('2:00:00');
  } finally {
    if (app) await app.close();
    await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
