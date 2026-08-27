'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPlatform(initial = {}) {
  const values = new Map(Object.entries(initial));
  const localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  const window = {};
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'platform.js'), 'utf8');
  vm.runInNewContext(code, { window, localStorage, console: { log() {}, warn() {}, error() {} } });
  return { platform: window.StudyPlatform, values };
}

test('renderer storage returns typed fallbacks for invalid JSON', () => {
  const { platform } = loadPlatform({ broken: '{' });
  assert.deepEqual(Array.from(platform.storage.getJson('broken', [])), []);
  assert.equal(JSON.stringify(platform.storage.getJson('missing', { enabled: true })), '{"enabled":true}');
});

test('renderer storage skips byte-identical writes', () => {
  const { platform, values } = loadPlatform({ same: '{"value":1}' });
  const unchanged = platform.storage.setJson('same', { value: 1 });
  const changed = platform.storage.setJson('same', { value: 2 });
  assert.equal(unchanged.changed, false);
  assert.equal(changed.changed, true);
  assert.equal(values.get('same'), '{"value":2}');
});

test('renderer initialization is ordered and isolates failures', async () => {
  const { platform } = loadPlatform();
  const order = [];
  platform.registerInitializer('late', () => order.push('late'), 20);
  platform.registerInitializer('broken', () => { throw new Error('boom'); }, 10);
  platform.registerInitializer('early', () => order.push('early'), 5);
  const results = await platform.initialize();
  assert.deepEqual(order, ['early', 'late']);
  assert.equal(results.find(item => item.name === 'broken').ok, false);
});

test('renderer event bus supports unsubscribe and failure isolation', () => {
  const { platform } = loadPlatform();
  const received = [];
  platform.events.on('change', () => { throw new Error('isolated'); });
  const unsubscribe = platform.events.on('change', value => received.push(value));
  assert.equal(platform.events.emit('change', 1), 2);
  unsubscribe();
  assert.equal(platform.events.emit('change', 2), 1);
  assert.deepEqual(received, [1]);
});
