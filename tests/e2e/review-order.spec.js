const {test, expect} = require('@playwright/test');
const {_electron: electron} = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('待复习笔记支持普通排序、置顶排序、标签筛选和刷新恢复', async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-review-order-'));
  let app;
  try {
    app = await electron.launch({args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'], env: {...process.env, MST_E2E: '1', MST_USER_DATA_PATH: profile}});
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof renderCheckinCalendar === 'function' && document.querySelector('#nav-today[aria-current="page"]'));
    await page.evaluate(() => {
      const oldDate = new Date(Date.now() - 10 * 86400000).toISOString();
      notes = Array.from({length: 5}, (_, i) => ({id: i + 501, type: 'note', parentId: null, title: '复习排序笔记 ' + (i + 1), content: '正文', summary: '摘要', tags: i % 2 ? ['英语'] : ['数学'], createdAt: oldDate, updatedAt: oldDate}));
      saveData('study_notes_v2', notes);
      switchTab('today');
    });
    const rows = page.locator('#todayReviewList .review-item');
    const row = id => page.locator(`[data-review-note-id="${id}"]`);
    const ids = () => rows.evaluateAll(items => items.map(item => Number(item.dataset.reviewNoteId)));
    await expect(rows).toHaveCount(5);
    await row(505).locator('.review-item-grip').dragTo(row(501).locator('.review-item-grip'));
    expect(await ids()).toEqual([505, 501, 502, 503, 504]);
    await row(503).locator('.review-btn-pin').click();
    await row(504).locator('.review-btn-pin').click();
    expect(await ids()).toEqual([503, 504, 505, 501, 502]);
    await row(504).locator('.review-item-grip').dragTo(row(503).locator('.review-item-grip'));
    expect(await ids()).toEqual([504, 503, 505, 501, 502]);
    await expect(row(504).locator('.review-btn-pin')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#todayReviewTagFilter').selectOption('tag:数学');
    expect(await ids()).toEqual([503, 505, 501]);
    await row(501).locator('.review-item-grip').dragTo(row(505).locator('.review-item-grip'));
    expect(await ids()).toEqual([503, 501, 505]);
    await page.locator('#todayReviewTagFilter').selectOption('all');
    expect(await ids()).toEqual([504, 503, 501, 505, 502]);
    await page.locator('#todayReviewToggle').click();
    await expect(row(505)).toBeHidden();
    await page.locator('#todayReviewToggle').click();
    await page.screenshot({path: 'test-results/review-order.png', fullPage: true});
    await page.reload();
    await page.waitForFunction(() => typeof renderReviewCard === 'function');
    await page.evaluate(() => switchTab('today'));
    expect(await ids()).toEqual([504, 503, 501, 505, 502]);
    await row(504).locator('.review-btn-pin').click();
    expect(await ids()).toEqual([503, 501, 505, 502, 504]);
    await row(503).locator('.review-btn-done').click();
    await expect(row(503)).toHaveCount(0);
    expect(await page.evaluate(() => loadTodayReviewLayout().pinned)).toEqual([503]);
    await row(501).locator('.review-btn-review').click();
    expect(await page.evaluate(() => { syncReviewFloatFilter(); return reviewFloatNotes.map(note => note.id); })).toEqual([501, 505, 502, 504]);
  } finally {
    if (app) await app.close();
    await fs.rm(profile, {recursive: true, force: true});
  }
});
