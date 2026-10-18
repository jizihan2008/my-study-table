'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const source = name => fs.readFileSync(require.resolve('../js/' + name), 'utf8');
function harness(initial = {}) {
  const values = new Map(Object.entries({ study_deepseek_web_key: 'deepseek-secret', ...initial }));
  const requests = [];
  const ctx = vm.createContext({ URL, AbortController, AbortSignal, setTimeout, clearTimeout, console,
    crypto: { randomUUID }, localStorage: { getItem: key => values.get(key) ?? null },
    document: { getElementById: () => null }, getMaxFocusCount: () => 3 });
  ctx.window = ctx;
  ctx.fetch = async (url, init) => { requests.push({ url, init }); return { ok: true, json: async () => ({ title: '原文', content: '正文'.repeat(6000) }) }; };
  for (const file of ['web-access.js', 'ai-search.js', 'ai-tools.js']) vm.runInContext(source(file), ctx);
  return { ctx, values, requests };
}
const url = 'https://example.com/article';

test('PWA reads Markdown with isolated credentials; continuation and keyword search never refetch', async () => {
  const { ctx, requests } = harness();
  const first = await ctx.WebAccess.read({ url, limit: 500 }, 'a');
  assert.equal(first.ok, true);
  assert.equal(first.nextOffset, 500);
  assert.equal(first.provider, 'DeepSeek Fetch');
  assert.equal(requests[0].url, 'https://api.deepseek.com/v1/tools/fetch');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer deepseek-secret');
  assert.equal(requests[0].init.credentials, 'omit');
  assert.equal(requests[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(requests[0].init.body), { url });
  const next = await ctx.WebAccess.read({ url, snapshotId: first.snapshotId, offset: first.nextOffset, limit: 500 }, 'a');
  assert.equal(next.offset, 500);
  assert.equal(next.fetchedAt, first.fetchedAt);
  const matches = await ctx.WebAccess.read({ url, snapshotId: first.snapshotId, query: '正文', limit: 500 }, 'a');
  assert.match(matches.text, /匹配位置 0/);
  assert.equal(requests.length, 1);
  for (const payload of [{ url, snapshotId: first.snapshotId }, { url: 'https://example.com/other', snapshotId: first.snapshotId }]) {
    assert.equal((await ctx.WebAccess.read(payload, 'other')).ok, false);
  }
});

test('cloud snapshots expire and cannot switch backends during continuation', async () => {
  const { ctx, requests } = harness();
  const first = await ctx.WebAccess.read({ url }, 'a');
  vm.runInContext('Date.now = () => ' + (Date.now() + 11 * 60 * 1000), ctx);
  const expired = await ctx.WebAccess.read({ url, snapshotId: first.snapshotId, offset: first.nextOffset }, 'a');
  assert.equal(expired.ok, false);
  assert.match(expired.error, /过期/);
  assert.equal(requests.length, 1);
});

test('desktop auto mode preserves native reading and transparently falls back with provenance', async () => {
  const { ctx, requests } = harness();
  ctx.electronAPI = { webRead: async () => ({ ok: true, text: '本地正文', snapshotId: 'native-id', warnings: [] }) };
  assert.equal((await ctx.WebAccess.read({ url })).provider, '桌面本地渲染');
  assert.equal(requests.length, 0);
  ctx.electronAPI.webRead = async () => ({ ok: false, error: '页面加载超时' });
  const fallback = await ctx.WebAccess.read({ url });
  assert.equal(fallback.ok, true);
  assert.match(fallback.warnings.join(), /本地读取.*超时/);
  const resume = await ctx.WebAccess.read({ url, snapshotId: 'native-id', offset: 500 });
  assert.equal(resume.ok, false);
  assert.equal(requests.length, 1, 'failed native continuation must not fetch a new cloud page');
});

test('cloud errors fall back to desktop; local-only never sends a cloud request', async () => {
  const { ctx, values, requests } = harness({ study_web_read_mode: 'deepseek' });
  ctx.fetch = async () => ({ ok: false, status: 402 });
  ctx.electronAPI = { webRead: async () => ({ ok: true, text: '本地正文', warnings: [] }) };
  const result = await ctx.WebAccess.read({ url });
  assert.equal(result.ok, true);
  assert.match(result.warnings.join(), /余额不足/);
  values.set('study_web_read_mode', 'local');
  ctx.electronAPI.webRead = async () => ({ ok: false, error: '本地失败' });
  assert.match((await ctx.WebAccess.read({ url })).error, /本地失败/);
  assert.equal(requests.length, 0);
});

test('PWA reports missing Key, HTTP and network failures without exposing credentials', async () => {
  const { ctx, values } = harness();
  for (const [status, hint] of [[401, 'Key 无效'], [402, '余额不足'], [403, '安全策略'], [404, '正文'], [429, '频繁'], [504, '暂时不可用']]) {
    let calls = 0;
    ctx.fetch = async () => { calls++; return { ok: false, status }; };
    const result = await ctx.WebAccess.read({ url });
    assert.equal(result.ok, false);
    assert.match(result.error, new RegExp(hint));
    assert.doesNotMatch(result.error, /deepseek-secret/);
    assert.equal(calls, 1);
  }
  values.delete('study_deepseek_web_key');
  assert.match((await ctx.WebAccess.read({ url })).error, /填写 DeepSeek API Key/);
});

test('invalid URLs and pagination options are rejected before any provider call', async () => {
  const { ctx, requests } = harness();
  for (const value of ['http://127.1', 'http://2130706433', 'http://localhost.', 'http://printer.local', 'http://10.0.0.1', 'http://[::ffff:127.0.0.1]', 'file:///etc/passwd', 'https://user:pass@example.com']) {
    assert.equal((await ctx.WebAccess.read({ url: value })).ok, false, value);
  }
  for (const params of [{ limit: 499 }, { offset: 1 }, { limit: NaN }, { query: {} }, { snapshotId: [] }]) {
    assert.equal((await ctx.WebAccess.read({ url, ...params })).ok, false);
  }
  assert.equal(ctx.WebAccess.publicUrl('https://[2606:4700:4700::1111]/'), 'https://[2606:4700:4700::1111]/');
  assert.equal(ctx.WebAccess.publicUrl('https://10.example.com/'), 'https://10.example.com/');
  assert.equal(requests.length, 0);
});

test('DeepSeek search uses documented fields, bounds results and produces actual source citations', async () => {
  const { ctx, requests } = harness({ study_web_search_engine: 'deepseek' });
  ctx.fetch = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, json: async () => ({ results: [{ title: '文档', url, summary: '结论', date: '2026-10-16' }, { title: 'bad', url: 'javascript:alert(1)' }] }) };
  };
  const output = await ctx.executeToolCall('web_search', { query: '测试', max_results: 3 });
  assert.deepEqual(JSON.parse(requests[0].init.body), { query: '测试', count: 3, need_content: false });
  assert.match(output, /\[文档\]\(https:\/\/api.deepseek.com\/v1\/tools\/search\)/);
  assert.match(output, /不可信外部资料/);
  assert.match(output, /非已核对全文/);
  assert.doesNotMatch(output, /javascript:/);
});

test('DeepSeek failure and empty search results fall back to DuckDuckGo with cited URLs and no leaked Key', async () => {
  for (const failed of [true, false]) {
    const { ctx } = harness({ study_web_search_engine: 'deepseek' });
    const calls = [];
    ctx.fetch = async (url, init = {}) => {
      calls.push({ url, init });
      if (url.includes('deepseek')) return { ok: !failed, status: 429, json: async () => ({ results: [] }) };
      return { ok: true, json: async () => ({ AbstractText: '定义', AbstractURL: 'https://example.com/definition', Heading: '百科' }) };
    };
    const output = await ctx.performWebSearch('测试', 5);
    assert.match(output, /已回退 DuckDuckGo/);
    assert.match(output, /\[百科\]\(https:\/\/example.com\/definition\)/);
    assert.equal(calls[1].init.headers, undefined);
  }
});

test('webpage tool output retains source, warning and bounded metadata in PWA', async () => {
  const { ctx } = harness();
  const output = await ctx.executeToolCall('read_webpage', { url, limit: 8000 }, { conv: { id: 'a' } });
  assert.match(output, /\[原文\]\(https:\/\/example.com\/article\)/);
  assert.match(output, /DeepSeek Fetch/);
  assert.match(output, /"nextOffset":8000/);
  assert.match(output, /不可信外部资料/);
  assert.ok(output.length < 12000);
});

test('network and timeout errors remain actionable and a complete search failure is marked failed', async () => {
  const { ctx } = harness({ study_web_search_engine: 'deepseek' });
  vm.runInContext('fetch = async () => { throw new TypeError("Failed to fetch"); }', ctx);
  assert.match((await ctx.WebAccess.read({ url })).error, /网络连接失败/);
  const failure = await ctx.executeToolCallStructured('web_search', { query: '测试', max_results: 3 });
  assert.equal(failure.ok, false);
  assert.match(failure.error, /回退也未获得结果/);
  ctx.setTimeout = fn => setTimeout(fn, 1);
  ctx.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'AbortError' })), { once: true });
  });
  assert.match((await ctx.WebAccess.read({ url })).error, /超时/);
});

test('oversized documents are explicitly capped and source lists retain complete links within the tool budget', async () => {
  const { ctx } = harness();
  ctx.fetch = async () => ({ ok: true, json: async () => ({ content: 'a'.repeat(500001) }) });
  const result = await ctx.WebAccess.read({ url });
  assert.equal(result.totalChars, 500000);
  assert.equal(result.sourceTruncated, true);
  assert.match(result.warnings.join(), /超过提取上限/);
  const sources = ctx.WebAccess.formatSources(Array.from({ length: 10 }, (_, i) => ({ title: '标题'.repeat(200), url: url + '?' + 'x'.repeat(1900) + i, summary: '摘要'.repeat(700) })), 10);
  assert.ok(sources.length < 9500);
  assert.match(sources, /\)\n摘要/);
});

test('existing providers also return bounded cited sources and visibly fall back on failure', async () => {
  const fixtures = {
    brave: { web: { results: [{ title: 'Brave文档', url, description: '摘要' }] } },
    tavily: { results: [{ title: 'Tavily文档', url, content: '摘要' }] },
    exa: { results: [{ title: 'Exa文档', url, text: '摘要' }] },
    searchapi: { organic_results: [{ title: 'SearchAPI文档', link: url, snippet: '摘要' }] }
  };
  for (const [engine, fixture] of Object.entries(fixtures)) {
    const { ctx } = harness({ study_web_search_engine: engine, study_web_search_key: 'legacy-secret' });
    ctx.fetch = async () => ({ ok: true, json: async () => fixture });
    assert.match(await ctx.performWebSearch('测试', 5), /\[.*文档\]\(https:\/\/example.com\/article\)/);
    ctx.fetch = async requestUrl => requestUrl.includes('duckduckgo')
      ? { ok: true, json: async () => ({ AbstractText: '摘要', AbstractURL: url }) } : { ok: false, status: 500 };
    assert.match(await ctx.performWebSearch('测试', 5), /已回退 DuckDuckGo/);
  }
});
