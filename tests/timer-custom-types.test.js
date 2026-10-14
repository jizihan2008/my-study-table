'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function load() {
  const values = new Map();
  const keys = [];
  const context = vm.createContext({
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    saveData: (key, value) => { keys.push(key); values.set(key, JSON.stringify(value)); return true; },
    escapeAttr: value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;'),
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  });
  vm.runInContext(fs.readFileSync('js/timer-types.js', 'utf8'), context);
  return { context, values, keys };
}
test('custom IDs survive missing definitions and old focus flags retain their fallback', () => {
  const { context, values } = load();
  assert.equal(context.getTimerActivityType({ activityType: 'type-unknown', affectsFocus: false }), 'type-unknown');
  assert.equal(context.getTimerActivityType({ affectsFocus: false }), 'other');
  assert.equal(context.getTimerActivityType({}), 'focus');
  values.set('study_timer_activity_types', '{broken');
  assert.equal(context.loadTimerActivityTypes().length, 3);
});
test('types persist through the normal save path, escape labels and preserve archived selections', () => {
  const { context, keys } = load();
  const types = context.loadTimerActivityTypes();
  types.push({ id: 'type-reading', label: '阅读 <学习>', affectsFocus: true, disabled: false });
  types.push({ id: 'type-travel', label: '出行', affectsFocus: false, disabled: true });
  assert.equal(context.saveTimerActivityTypes(types), true);
  assert.deepEqual(keys, ['study_timer_activity_types']);
  assert.equal(context.getTimerActivityAffectsFocus('type-reading'), true);
  assert.equal(context.getTimerActivityAffectsFocus('type-travel'), false);
  assert.match(context.renderTimerActivityOptions('focus'), /阅读 &lt;学习&gt;/);
  assert.doesNotMatch(context.renderTimerActivityOptions('focus'), /出行/);
  assert.match(context.renderTimerActivityOptions('type-travel'), /出行（已停用）/);
  assert.equal(context.getTimerActivityLabel('type-travel'), '出行');
  context.saveData = () => false;
  assert.equal(context.saveTimerActivityTypes([]), false);
  assert.equal(context.getTimerActivityLabel('type-reading'), '阅读 <学习>');
});
test('calendar types override the old flag and legacy calendar events remain compatible', () => {
  const { context } = load();
  assert.equal(context.getCalendarTimerActivityType({ autoActivityType: 'type-work', autoTimer: false }), 'type-work');
  assert.equal(context.getCalendarTimerActivityType({ autoTimer: false }), 'other');
  assert.equal(context.getCalendarTimerActivityType({ autoTimer: true }), 'focus');
});
