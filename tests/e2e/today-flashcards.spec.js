'use strict';
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('Today flashcards count due cards, open each deck and refresh after review', async () => {
  test.setTimeout(60000);
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-today-flashcards-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await expect(page.locator('#section-today')).toHaveClass(/active/);
    await expect(page.locator('#todayFlashcardCount')).toHaveText('0 张');
    await expect(page.locator('#todayFlashcardList')).toContainText('还没有收藏生词');
    await page.evaluate(() => {
      const entry = GlobalTranslation.recordResult('due word', { title: 'due word', chineseMeaning: '到期生词' });
      GlobalTranslation.toggleVocabulary(entry.id, true);
      const future = GlobalTranslation.recordResult('future word', { title: 'future word', chineseMeaning: '未来生词' });
      GlobalTranslation.toggleVocabulary(future.id, true);
      GlobalTranslation.gradeReview(future.id, 'good', '2099-01-01T00:00:00Z');
      for (const level of ['cet4', 'cet6']) {
        const card = GlobalTranslation.getCetReviewQueue(level).at(-1);
        GlobalTranslation.gradeCetReview(level, card.id, 'good', '2020-01-01T00:00:00Z');
      }
    });
    await expect(page.locator('#todayFlashcardCount')).toHaveText('3 张');
    await expect(page.locator('#todayFlashcardList')).toContainText('due word');
    await expect(page.locator('#todayFlashcardList')).not.toContainText('future word');
    for (const width of [1100, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => applyTheme(theme), theme);
        const card = page.locator('#todayFlashcardCard');
        await card.scrollIntoViewIfNeeded();
        expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        await card.screenshot({ path: `test-results/today-flashcards-${width}-${theme}.png` });
      }
    }
    for (const group of ['vocabulary', 'cet4', 'cet6']) {
      await page.locator(`[data-flashcard-group="${group}"]`).click();
      await expect(page.locator('#section-translation')).toHaveClass(/active/);
      if (group === 'vocabulary') await expect(page.locator('.translation-flashcard > strong')).toHaveText('due word');
      else await expect(page.locator(`[data-level="${group}"]`)).toHaveAttribute('aria-pressed', 'true');
      await page.locator('.translation-flashcard').click();
      await page.locator('[data-rating="good"]').click();
      await page.evaluate(() => switchTab('today'));
      await expect(page.locator('#todayFlashcardCount')).toHaveText(`${2 - ['vocabulary', 'cet4', 'cet6'].indexOf(group)} 张`);
    }
    await page.reload();
    await expect(page.locator('#section-today')).toHaveClass(/active/);
    await expect(page.locator('#todayFlashcardCount')).toHaveText('0 张');
  } finally {
    if (app) await app.close();
    if (path.dirname(userDataPath) === os.tmpdir() && path.basename(userDataPath).startsWith('mst-today-flashcards-')) {
      await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});
