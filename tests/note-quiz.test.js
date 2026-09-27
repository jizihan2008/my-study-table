'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'notes.js'), 'utf8');

function loadFunction(name, nextMarker) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(nextMarker, start + 1);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const context = {};
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context[name];
}

test('note quiz parser accepts the same text/explain schema used by textbook quizzes', () => {
  const parse = loadFunction('parseNoteQuizJson', 'async function generateNoteQuiz');
  const questions = parse('```json\n{"questions":[{"type":"choice","text":"2+2=?","options":["A. 3","B. 4","C. 5","D. 6"],"answer":"B","explain":"基础加法"}]}\n```');
  assert.equal(questions.length, 1);
  assert.equal(questions[0].question, '2+2=?');
  assert.equal(questions[0].explanation, '基础加法');
  assert.equal(questions[0].answer, 'B');
});

test('note quiz implements textbook-style answering, grading and history', () => {
  for (const name of ['selectNoteQuizChoice', 'inputNoteQuizShort', 'clearNoteQuizAnswers', 'submitNoteQuiz', 'renderNoteQuizHistory']) {
    assert.match(source, new RegExp(`function ${name}\\b`));
  }
  assert.match(source, /note_quiz_grade/);
  assert.match(source, /提交批改/);
  assert.match(source, /这篇笔记的测验记录/);
});
