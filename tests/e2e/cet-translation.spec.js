'use strict';
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('CET cards flip, save independently, switch levels and continue in batches', async () => {
  test.setTimeout(60000);
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-cet-e2e-'));
  let app;
  try {
    app = await electron.launch({
      args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath }
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#section-today')).toHaveClass(/active/);
    await page.evaluate(() => {
      const entry = GlobalTranslation.recordResult('my personal word', { title: 'my personal word', chineseMeaning: '我的生词', englishDefinition: 'personal vocabulary' });
      GlobalTranslation.toggleVocabulary(entry.id, true);
      switchTab('translation');
    });
    await page.locator('[data-mode="cet"]').click();
    await expect(page.locator('.translation-page-search')).toBeHidden();
    await expect(page.locator('[data-level="cet4"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.translation-review-progress')).toContainText('第 1 / 20 张');
    await expect(page.locator('.translation-flashcard-answer')).toBeHidden();
    await expect(page.locator('.translation-review-ratings')).toBeHidden();
    const word = await page.locator('.translation-flashcard > strong').innerText();
    await page.locator('.translation-flashcard').click();
    await expect(page.locator('.translation-flashcard-answer')).toBeVisible();
    await page.screenshot({ path: path.join('test-results', 'cet-flashcard.png') });
    await page.locator('[data-rating="good"]').click();
    await expect(page.locator('.translation-review-progress')).toContainText('第 2 / 20 张');
    await expect(page.locator('.translation-cet-summary')).toContainText('已练 1');
    expect(await page.evaluate(() => GlobalTranslation.getReviewQueue().length)).toBe(1);
    await page.locator('[data-level="cet6"]').click();
    await expect(page.locator('.translation-cet-summary')).toContainText('已练 0');
    await page.locator('.translation-flashcard').click();
    await page.locator('[data-rating="hard"]').click();
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#section-today')).toHaveClass(/active/);
    await page.evaluate(() => switchTab('translation'));
    await page.locator('[data-mode="cet"]').click();
    await expect(page.locator('.translation-cet-summary')).toContainText('已练 1');
    expect(await page.evaluate(word => GlobalTranslation.getCetReviewQueue('cet4', true).find(card => card.sourceText === word).reviewCount, word)).toBe(1);
    await page.locator('[data-level="cet6"]').click();
    await expect(page.locator('.translation-cet-summary')).toContainText('已练 1');
    for (let i = 0; i < 20; i++) {
      await page.locator('.translation-flashcard').click();
      await page.locator('[data-rating="good"]').click();
    }
    await expect(page.locator('.translation-review-empty')).toContainText('本轮复习完成');
    await page.locator('.translation-review-next').click();
    await expect(page.locator('.translation-review-progress')).toContainText('第 1 / 20 张');
    await page.locator('[data-mode="review"]').click();
    await expect(page.locator('.translation-flashcard')).toContainText('my personal word');
    await expect(page.locator('.translation-cet-toolbar')).toHaveCount(0);
    await page.locator('[data-mode="vocabulary"]').click();
    await expect(page.locator('.translation-history-card')).toHaveCount(1);
    await expect(page.locator('.translation-page-search')).toBeVisible();
  } finally {
    if (app) await app.close();
    // mkdtemp creates this exact test-owned directory under the system temp root.
    if (userDataPath && path.dirname(userDataPath) === os.tmpdir() && path.basename(userDataPath).startsWith('mst-cet-e2e-')) {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  }
});
