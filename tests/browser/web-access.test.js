'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
const root = path.join(__dirname, '../..');

test('PWA settings persist, use DeepSeek for search/read, render citations and show fallback failures', { timeout: 60000 }, async () => {
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 820, height: 1180 } });
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://api.deepseek.com/v1/tools/**', async route => {
      requests.push({ url: route.request().url(), body: route.request().postDataJSON(), headers: route.request().headers() });
      const search = route.request().url().endsWith('/search');
      await route.fulfill({ json: search ? { results: [{ title: '参考文档', url: 'https://example.com/docs', summary: '搜索摘要' }] } : { title: '参考文档', content: '# 原文\n\n' + '正文'.repeat(4500) } });
    });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => window.WebAccess && window.SecretVault.isReady() && typeof openSettingsModal === 'function');
    await page.evaluate(() => { openSettingsModal(); switchSettingsTab('api'); });
    await page.locator('#settingsWebSearchEngine').selectOption('deepseek');
    assert.equal(await page.locator('#settingsWebSearchKeyField').isVisible(), false);
    await page.locator('#settingsDeepSeekWebKey').fill('browser-test-key');
    await page.locator('#settingsDeepSeekWebKey').dispatchEvent('change');
    await page.locator('#settingsWebReadMode').selectOption('deepseek');
    await page.reload();
    await page.waitForFunction(() => window.WebAccess && window.SecretVault.isReady() && typeof executeToolCall === 'function');
    await page.evaluate(() => { openSettingsModal(); switchSettingsTab('api'); });
    assert.equal(await page.locator('#settingsWebSearchEngine').inputValue(), 'deepseek');
    assert.equal(await page.locator('#settingsWebReadMode').inputValue(), 'deepseek');
    assert.equal(await page.locator('#settingsDeepSeekWebKey').inputValue(), 'browser-test-key');
    const result = await page.evaluate(async () => {
      const search = await executeToolCall('web_search', { query: '测试搜索', max_results: 2 });
      const first = await WebAccess.read({ url: 'https://example.com/docs', limit: 500 }, 'test-conv');
      const next = await WebAccess.read({ url: 'https://example.com/docs', snapshotId: first.snapshotId, offset: first.nextOffset, limit: 500 }, 'test-conv');
      const target = document.createElement('div'); target.id = 'web-citation-test';
      target.innerHTML = formatMarkdownBase(search); document.body.appendChild(target);
      return { search, first, next, syncsSecret: SettingsSync.isKey('study_deepseek_web_key'), native: !!window.electronAPI?.webRead };
    });
    assert.equal(result.native, false);
    assert.equal(result.syncsSecret, false);
    assert.equal(result.first.ok, true);
    assert.equal(result.next.offset, 500);
    assert.equal(requests.length, 2, 'continuation reuses the fetched document');
    assert.deepEqual(requests[0].body, { query: '测试搜索', count: 2, need_content: false });
    assert.equal(requests[0].headers.authorization, 'Bearer browser-test-key');
    assert.equal(await page.locator('#web-citation-test a').getAttribute('href'), 'https://example.com/docs');
    await page.unroute('https://api.deepseek.com/v1/tools/**');
    await page.route('https://api.deepseek.com/v1/tools/**', route => route.fulfill({ status: 402, json: { error: { message: 'insufficient balance' } } }));
    await page.route('https://api.duckduckgo.com/**', route => route.fulfill({ json: { AbstractText: '回退资料', AbstractURL: 'https://example.com/fallback', Heading: '回退来源' } }));
    const failed = await page.evaluate(async () => ({
      search: await performWebSearch('回退测试', 2),
      read: await executeToolCall('read_webpage', { url: 'https://example.com/failure' })
    }));
    assert.match(failed.search, /余额不足.*已回退 DuckDuckGo/);
    assert.match(failed.search, /https:\/\/example.com\/fallback/);
    assert.match(failed.read, /读取网页失败.*余额不足/);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
