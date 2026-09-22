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
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-translation-e2e-'));
  electronApp = await electron.launch({
    args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath }
  });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  if (electronApp) await electronApp.close();
  if (userDataPath) await fs.rm(userDataPath, { recursive: true, force: true });
});

test('selected English opens an English-first translation with a Chinese switch', async () => {
  await page.evaluate(() => {
    window.getEffectiveApiConfig = () => ({ apiKey: 'test-key', model: 'test-model' });
    window.callAiApi = async () => ({
      cleanText: JSON.stringify({
        title: 'cognitive load',
        phonetic: '/ˈkɒɡnətɪv loʊd/',
        partOfSpeech: 'noun phrase',
        englishDefinition: 'the amount of mental effort used by working memory',
        englishUsage: 'Common in learning science.',
        englishExample: 'Clear instructions reduce cognitive load.',
        chineseMeaning: '认知负荷；工作记忆正在使用的心理努力量',
        chineseNote: '常用于学习科学和用户体验领域。'
      })
    });
    const sample = document.createElement('p');
    sample.id = 'translationE2eSample';
    sample.textContent = 'cognitive load';
    sample.style.cssText = 'position:fixed;left:300px;top:180px;z-index:12000;background:white;color:black;padding:12px;';
    document.body.appendChild(sample);
    const range = document.createRange();
    range.selectNodeContents(sample);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    sample.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 210 }));
  });

  await expect(page.locator('#globalTranslateMenu')).toHaveClass(/visible/);
  await page.locator('#globalTranslateAction').click();
  await expect(page.locator('#globalTranslatePanel')).toBeVisible();
  await expect(page.locator('#globalTranslateEnglishTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#globalTranslateEnglish')).toContainText('the amount of mental effort');
  await expect(page.locator('#globalTranslateChinese')).toBeHidden();

  await page.locator('#globalTranslateChineseTab').click();
  await expect(page.locator('#globalTranslateChineseTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#globalTranslateChinese')).toContainText('认知负荷');

  await page.locator('#globalTranslateVocabulary').click();
  await expect(page.locator('#globalTranslateVocabulary')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#globalTranslateHistoryLink').click();
  await expect(page.locator('#section-translation')).toHaveClass(/active/);
  await expect(page.locator('#translationHistoryList .translation-history-card')).toHaveCount(1);
  await expect(page.locator('.translation-history-word')).toContainText('cognitive load');
  await expect(page.locator('.translation-history-vocab')).toHaveAttribute('aria-pressed', 'true');

  await page.locator('.translation-page-tab[data-mode="vocabulary"]').click();
  await expect(page.locator('#translationHistoryList .translation-history-card')).toHaveCount(1);

  await page.locator('.translation-page-tab[data-mode="review"]').click();
  await expect(page.locator('.translation-flashcard')).toContainText('cognitive load');
  await expect(page.locator('.translation-flashcard-answer')).toBeHidden();
  await page.locator('.translation-flashcard').click();
  await expect(page.locator('.translation-flashcard-answer')).toContainText('认知负荷');
  await page.locator('.translation-review-ratings [data-rating="good"]').click();
  await expect(page.locator('.translation-review-empty')).toContainText('本轮复习完成');

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const sample = document.createElement('p');
    sample.id = 'translationE2eSample';
    sample.textContent = 'cognitive load';
    sample.style.cssText = 'position:fixed;left:300px;top:180px;z-index:12000;background:white;color:black;padding:12px;';
    document.body.appendChild(sample);
    const range = document.createRange();
    range.selectNodeContents(sample);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    sample.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 210 }));
  });
  await page.locator('#globalTranslateAction').click();
  await expect(page.locator('#globalTranslateEnglish')).toContainText('the amount of mental effort');
  expect(await page.evaluate(() => GlobalTranslation.getHistory()[0].viewCount)).toBe(2);
  await page.locator('#globalTranslateHistoryLink').click();
  await expect(page.locator('#section-translation')).toHaveClass(/active/);
  await expect(page.locator('#translationHistoryList .translation-history-card')).toHaveCount(1);
  await page.locator('.translation-page-tab[data-mode="vocabulary"]').click();
  await expect(page.locator('#translationHistoryList .translation-history-card')).toHaveCount(1);
});

test('Chinese-only selections keep the app context menu behavior untouched', async () => {
  const visible = await page.evaluate(() => {
    const sample = document.getElementById('translationE2eSample') || document.body.appendChild(document.createElement('p'));
    sample.id = 'translationE2eSample';
    sample.textContent = '认知负荷';
    const range = document.createRange();
    range.selectNodeContents(sample);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 210 });
    sample.dispatchEvent(event);
    return document.getElementById('globalTranslateMenu').classList.contains('visible');
  });
  expect(visible).toBe(false);
});
