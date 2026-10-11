'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/skills.js'), 'utf8');

test('skill saves and deletions notify sync only after changed content is persisted', () => {
  const values = new Map(), changes = [];
  const context = { window: { Sync: { onLocalChange(key) { changes.push([key, values.get(key)]); } } },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } };
  vm.createContext(context);
  vm.runInContext(source, context);
  const skills = [{ id: '1', name: 'test', content: 'one' }];
  context.saveAiSkills(skills);
  context.saveAiSkills(skills);
  context.saveAiSkills([]);
  assert.equal(changes.length, 2);
  assert.equal(changes[0][0], 'study_ai_skills_v1');
  assert.deepEqual(JSON.parse(changes[0][1]), skills);
  assert.equal(changes[1][1], '[]');
});

test('failed skill persistence does not notify sync; sync failure cannot undo a successful save', () => {
  let notifications = 0;
  const context = { window: { Sync: { onLocalChange() { notifications++; throw new Error('sync offline'); } } },
    localStorage: { getItem: () => null, setItem() { throw new Error('quota'); } } };
  vm.createContext(context);
  vm.runInContext(source, context);
  assert.throws(() => context.saveAiSkills([]), /quota/);
  assert.equal(notifications, 0);
  context.localStorage.setItem = () => {};
  assert.doesNotThrow(() => context.saveAiSkills([]));
  assert.equal(notifications, 1);
});
