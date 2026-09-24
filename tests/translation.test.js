'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadTranslation() {
  const values = new Map();
  const window = {
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value))
    }
  };
  const context = {
    window,
    document: { readyState: 'loading', addEventListener() {}, getElementById: () => null },
    console
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'translation.js'), 'utf8'), context);
  return window.GlobalTranslation;
}

test('global translation only claims meaningful English selections', () => {
  const translation = loadTranslation();
  assert.equal(translation.isEnglishSelection('cognitive load theory'), true);
  assert.equal(translation.isEnglishSelection('What does this mean?'), true);
  assert.equal(translation.isEnglishSelection('认知负荷理论'), false);
  assert.equal(translation.isEnglishSelection('第 3 章 chapter'), false);
  assert.equal(translation.isEnglishSelection('12345'), false);
});

test('translation response accepts fenced JSON and requires both languages', () => {
  const translation = loadTranslation();
  const parsed = translation.normalizeResult('```json\n{' +
    '"title":"focus",' +
    '"phonetic":"/ˈfoʊkəs/",' +
    '"partOfSpeech":"noun",' +
    '"englishDefinition":"the main object of attention",' +
    '"englishUsage":"often followed by on",' +
    '"englishExample":"Keep your focus on the task.",' +
    '"chineseMeaning":"注意力；重点",' +
    '"chineseNote":"常与 on 连用"' +
    '}\n```');
  assert.equal(parsed.englishDefinition, 'the main object of attention');
  assert.equal(parsed.chineseMeaning, '注意力；重点');
  assert.throws(() => translation.normalizeResult('{"englishDefinition":"English only"}'), /不完整/);
});

test('history deduplicates lookups and vocabulary membership persists', () => {
  const translation = loadTranslation();
  const result = {
    title: 'focus', phonetic: '/ˈfoʊkəs/', partOfSpeech: 'noun',
    englishDefinition: 'the main object of attention', englishUsage: '', englishExample: '',
    chineseMeaning: '注意力；重点', chineseNote: ''
  };
  const first = translation.recordResult('Focus', result);
  translation.recordResult(' focus ', result);
  assert.equal(translation.getHistory().length, 1);
  assert.equal(translation.getHistory()[0].viewCount, 2);
  assert.equal(translation.toggleVocabulary(first.id, true), true);
  assert.equal(translation.getHistory()[0].inVocabulary, true);
});

test('a saved history result is reused without an AI request', async () => {
  const translation = loadTranslation();
  const result = {
    title: 'focus', phonetic: '/ˈfoʊkəs/', partOfSpeech: 'noun',
    englishDefinition: 'the main object of attention', englishUsage: '', englishExample: '',
    chineseMeaning: '注意力；重点', chineseNote: ''
  };
  translation.recordResult('focus', result);
  const cached = await translation.translate('FOCUS');
  assert.equal(cached.englishDefinition, result.englishDefinition);
  assert.equal(cached.chineseMeaning, result.chineseMeaning);
});

test('vocabulary cards become due immediately and review ratings schedule the next review', () => {
  const translation = loadTranslation();
  const result = {
    title: 'focus', phonetic: '/ˈfoʊkəs/', partOfSpeech: 'noun',
    englishDefinition: 'the main object of attention', englishUsage: '', englishExample: '',
    chineseMeaning: '注意力；重点', chineseNote: ''
  };
  const card = translation.recordResult('focus', result);
  translation.toggleVocabulary(card.id, true);
  assert.equal(translation.getReviewQueue().length, 1);

  const reviewedAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const expectedDueAt = new Date(reviewedAt.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const reviewed = translation.gradeReview(card.id, 'good', reviewedAt.toISOString());
  assert.equal(reviewed.reviewCount, 1);
  assert.equal(reviewed.reviewStage, 1);
  assert.equal(reviewed.reviewDueAt, expectedDueAt);
  assert.equal(translation.getReviewQueue().length, 0);
});

test('forgotten flashcards reset their stage and return after ten minutes', () => {
  const translation = loadTranslation();
  const result = {
    title: 'focus', phonetic: '', partOfSpeech: '', englishDefinition: 'attention',
    englishUsage: '', englishExample: '', chineseMeaning: '注意力', chineseNote: ''
  };
  const card = translation.recordResult('focus', result);
  translation.toggleVocabulary(card.id, true);
  translation.gradeReview(card.id, 'good', '2026-09-20T00:00:00.000Z');
  const forgotten = translation.gradeReview(card.id, 'again', '2026-09-22T00:00:00.000Z');
  assert.equal(forgotten.reviewStage, 0);
  assert.equal(forgotten.reviewLapses, 1);
  assert.equal(forgotten.reviewDueAt, '2026-09-22T00:10:00.000Z');
});
