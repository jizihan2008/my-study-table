'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadTranslation(values = new Map(), failWrites = false) {
  const window = { localStorage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      if (failWrites) throw new Error('storage full');
      values.set(key, String(value));
    }
  } };
  const context = { window, document: { readyState: 'loading', addEventListener() {}, getElementById: () => null }, console };
  vm.createContext(context);
  for (const file of ['lib/cet/vocabulary.js', 'js/translation.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  }
  return window.GlobalTranslation;
}

test('CET decks are bilingual, deduplicated and independent from notebook and each other', () => {
  const values = new Map();
  let translation = loadTranslation(values);
  const four = translation.getCetReviewQueue('cet4');
  const six = translation.getCetReviewQueue('cet6');
  assert.ok(four.length > 3000);
  assert.ok(six.length > 1000);
  for (const cards of [four, six]) {
    assert.equal(new Set(cards.map(card => card.id)).size, cards.length);
    assert.ok(cards.every(card => card.sourceText && card.result.chineseMeaning));
  }
  const card = four[0];
  const notebook = translation.recordResult(card.sourceText, card.result);
  translation.toggleVocabulary(notebook.id, true);
  const future = new Date(Date.now() + 86400000).toISOString();
  assert.equal(translation.gradeCetReview('cet4', card.id, 'good', future).reviewStage, 1);
  assert.equal(translation.getReviewQueue().length, 1);
  assert.equal(translation.getCetReviewQueue('cet6').length, six.length);
  assert.equal(translation.getHistory().length, 1);
  translation = loadTranslation(values);
  assert.equal(translation.getCetReviewQueue('cet4').length, four.length - 1);
  assert.equal(translation.getCetReviewQueue('cet4', true).find(item => item.id === card.id).reviewCount, 1);
  const stored = JSON.parse(values.get('study_translation_cet4_progress_v1'));
  assert.equal(stored[0].result, undefined);
  assert.equal(stored[0].sourceText, undefined);
  assert.equal(translation.gradeCetReview('invalid', card.id, 'good'), null);
  assert.equal(translation.gradeCetReview('cet6', card.id, 'good'), null);
});

test('CET ratings share the notebook schedule, prioritize due cards and fail atomically', () => {
  const values = new Map();
  const translation = loadTranslation(values);
  const card = translation.getCetReviewQueue('cet6').at(-1);
  const good = translation.gradeCetReview('cet6', card.id, 'good', '2026-01-01T00:00:00Z');
  assert.equal(good.reviewDueAt, '2026-01-02T00:00:00.000Z');
  const hard = translation.gradeCetReview('cet6', card.id, 'hard', '2026-01-02T00:00:00Z');
  assert.equal(hard.reviewDueAt, '2026-01-03T00:00:00.000Z');
  const again = translation.gradeCetReview('cet6', card.id, 'again', '2026-01-03T00:00:00Z');
  assert.equal(again.reviewDueAt, '2026-01-03T00:10:00.000Z');
  assert.equal(again.reviewLapses, 1);
  assert.equal(translation.getCetReviewQueue('cet6')[0].id, card.id);
  const before = values.get('study_translation_cet6_progress_v1');
  assert.equal(loadTranslation(values, true).gradeCetReview('cet6', card.id, 'good'), null);
  assert.equal(values.get('study_translation_cet6_progress_v1'), before);
  assert.equal(loadTranslation(values).getCetReviewQueue('cet6', true).find(item => item.id === card.id).reviewCount, 3);
});

test('a complete CET-6 progress record fits the cloud limit without losing review state', () => {
  const values = new Map();
  const translation = loadTranslation(values);
  const cards = translation.getCetReviewQueue('cet6');
  values.set('study_translation_cet6_progress_v1', JSON.stringify(cards.map(card => ({
    id: card.id, reviewStage: 3, reviewDueAt: '2099-01-01T00:00:00.000Z',
    lastReviewedAt: '2026-01-01T00:00:00.000Z', reviewCount: 10, reviewLapses: 2, lastReviewRating: 'good'
  }))));
  assert.ok(translation.gradeCetReview('cet6', cards[0].id, 'good'));
  assert.ok(values.get('study_translation_cet6_progress_v1').length < 800 * 1024);
  const restored = loadTranslation(values).getCetReviewQueue('cet6', true);
  assert.equal(restored.length, cards.length);
  assert.equal(restored.find(card => card.id === cards[1].id).reviewCount, 10);
  assert.equal(restored.find(card => card.id === cards[1].id).reviewLapses, 2);
});
