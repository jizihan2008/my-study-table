'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadClient(initial = {}) {
  const values = new Map(Object.entries(initial));
  const localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  const window = {};
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'ai-client.js'), 'utf8');
  vm.runInNewContext(code, {
    window, localStorage, fetch: async () => ({}), AbortController, DOMException,
    setTimeout, clearTimeout, console
  });
  return { client: window.AIClient, values };
}

test('usage records exact provider totals by day, model and feature', () => {
  const { client, values } = loadClient();
  const result = client.recordUsage('model-a', { prompt_tokens: 120, completion_tokens: 30 }, {
    feature: 'note_summary', timestamp: '2026-09-14T08:00:00+08:00'
  });
  const store = JSON.parse(values.get('study_ai_usage_v2'));
  const day = store.days['2026-09-14'];
  assert.equal(result.exact, true);
  assert.equal(day.totalTokens, 150);
  assert.equal(day.byModel['model-a'].inputTokens, 120);
  assert.equal(day.byFeature.note_summary.outputTokens, 30);
});

test('missing provider usage is estimated and legacy monthly totals are retained', () => {
  const legacy = JSON.stringify({ '2026-08': { inputTokens: 10, outputTokens: 5, requests: 1 } });
  const { client } = loadClient({ study_ai_usage_v1: legacy });
  const result = client.recordUsage('compatible-model', null, {
    feature: 'chat', input: '你好，帮我总结', output: '好的'
  });
  const store = client.getUsageData();
  const today = Object.values(store.days)[0];
  assert.equal(result.exact, false);
  assert.ok(result.totalTokens > 0);
  assert.equal(today.estimatedRequests, 1);
  assert.equal(store.legacyMonths['2026-08'].requests, 1);
});

test('clearing usage removes both current and migrated legacy totals', () => {
  const legacy = JSON.stringify({ '2026-08': { inputTokens: 10, outputTokens: 5, requests: 1 } });
  const { client, values } = loadClient({ study_ai_usage_v1: legacy });
  client.recordUsage('model-a', { input_tokens: 2, output_tokens: 3 }, { feature: 'chat' });
  client.clearUsage();
  const store = JSON.parse(values.get('study_ai_usage_v2'));
  assert.deepEqual(store.days, {});
  assert.deepEqual(store.legacyMonths, {});
  assert.equal(values.has('study_ai_usage_v1'), false);
});
