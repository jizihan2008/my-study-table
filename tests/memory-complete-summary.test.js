const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(responses, initial = {}) {
  const requests = [], usage = [];
  let saved = initial;
  const context = vm.createContext({
    window: {}, console, isDebugMode: () => false,
    localStorage: { getItem: key => key === 'study_ai_memory' ? JSON.stringify(saved) : null },
    getEffectiveApiConfig: () => ({ baseUrl: 'https://example.test', model: 'test', apiKey: 'test' }),
    AIClient: { recordUsage: (...args) => usage.push(args) },
    fetch: async (url, options) => {
      requests.push(JSON.parse(options.body));
      const response = responses.shift();
      assert.ok(response, 'unexpected API request');
      return { ok: true, json: async () => response };
    }
  });
  vm.runInContext(fs.readFileSync('js/memory.js', 'utf8'), context);
  context.saveAiMemory = memory => { saved = JSON.parse(JSON.stringify(memory)); };
  return { context, requests, usage, saved: () => saved };
}
const reply = (content, finish_reason = 'stop') => ({ choices: [{ message: { content }, finish_reason }], usage: { total_tokens: 20 } });
const options = { body: JSON.stringify({ model: 'test', max_tokens: 300, messages: [{ role: 'user', content: '生成完整摘要' }] }) };

test('truncated text is regenerated with more room, including reasoning-only responses', async () => {
  const env = load([reply('半截', 'length'), reply('', 'length'), reply('完整摘要。')]);
  assert.equal(await env.context.requestCompleteMemoryText('/api', options, 'memory_daily_summary', 'context'), '完整摘要。');
  assert.deepEqual(env.requests.map(r => r.max_tokens), [2048, 4096, 8192]);
  assert.deepEqual(env.requests[0].messages, env.requests[2].messages);
  assert.equal(env.usage.length, 3);
});

test('daily integration saves only the complete retry and complete profile', async () => {
  const env = load([reply('近期用户关注了半截', 'length'), reply('近期用户关注了学习，并完成复习。'), reply('用户正在持续学习并按计划完成每日复习。')]);
  await env.context.runDailyMemoryIntegration();
  assert.equal(env.saved().dailySummary, '近期用户关注了学习，并完成复习。');
  assert.equal(env.saved().profileText, '用户正在持续学习并按计划完成每日复习。');
});

test('failed truncation retries preserve previous summary, date, profile and source summaries', async () => {
  const initial = { dailySummary: '原有完整摘要。', dailySummaryDate: '2026-09-01', profileText: '原画像', convSummaries: [{ convId: 1, summary: '旧对话', extractedAt: 1 }] };
  const env = load([reply('半截', 'length'), reply('半截', 'length'), reply('半截', 'length')], initial);
  await env.context.runDailyMemoryIntegration();
  assert.equal(env.saved().dailySummary, initial.dailySummary);
  assert.equal(env.saved().dailySummaryDate, initial.dailySummaryDate);
  assert.equal(env.saved().profileText, initial.profileText);
  assert.deepEqual(env.saved().convSummaries, initial.convSummaries);
});

test('empty and filtered responses cannot replace memory text', async () => {
  for (const response of [reply(''), reply('部分内容', 'content_filter')]) {
    const env = load([response]);
    await assert.rejects(env.context.requestCompleteMemoryText('/api', options, 'memory_daily_summary', ''), /完整文本/);
    assert.equal(env.requests.length, 1);
  }
});

test('compatible providers without finish_reason still return their nonempty text', async () => {
  const response = reply('完整摘要。');
  delete response.choices[0].finish_reason;
  const env = load([response]);
  assert.equal(await env.context.requestCompleteMemoryText('/api', options, 'memory_daily_summary', ''), '完整摘要。');
});
