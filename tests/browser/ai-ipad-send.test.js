'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { webkit, devices } = require('playwright');
const root = path.resolve(__dirname, '../..');

test('iPad send checks local credentials, preserves drafts and sends after selecting a usable key', { timeout: 90000 }, async () => {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await webkit.launch({ headless: true });
    const context = await browser.newContext({ ...devices['iPad Pro 11'], serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => document.querySelector('#section-today') && typeof sendAiMessage === 'function' && typeof switchActiveKey === 'function');
    await page.evaluate(async () => {
      await saveApiKeys([
        { id: 'local', name: '本机 Key', key: 'dummy-test-credential', model: 'test-model' },
        { id: 'remote', name: '同步 Key', key: '', model: 'test-model' }
      ], { sync: false });
      localStorage.setItem('study_active_api_key_id', 'local');
      switchTab('ai'); createNewConv();
      generateConvTitle = () => {};
      window.testSent = [];
      runToolCallLoop = async (cfg, conv) => {
        window.testSent.push({ keyId: cfg.keyId, text: conv.messages.filter(m => m.role === 'user').at(-1).content });
        return { finalCleanText: '测试回复完成', finalRawReply: '测试回复完成', finishReason: 'stop' };
      };
    });
    await page.locator('#aiInput').fill('保留这条草稿');
    await page.evaluate(() => switchActiveKey('remote'));
    assert.equal(await page.locator('#aiInput').inputValue(), '保留这条草稿');
    assert.equal(await page.locator('#aiSendBtn').isDisabled(), true);
    assert.match(await page.locator('.ai-no-key-banner').innerText(), /不包含密钥/);
    await page.evaluate(() => { updateAiSendButton(); });
    assert.equal(await page.locator('#aiSendBtn').isDisabled(), true);
    await page.evaluate(() => sendAiMessage());
    assert.equal(await page.locator('#settingsModal').evaluate(el => el.classList.contains('open')), false);
    assert.equal(await page.locator('#aiInput').inputValue(), '保留这条草稿');
    assert.equal(await page.evaluate(() => window.testSent.length), 0);
    await page.locator('#aiToolbarKeySelect').selectOption('local');
    assert.equal(await page.locator('#aiInput').isDisabled(), false);
    assert.equal(await page.locator('#aiInput').inputValue(), '保留这条草稿');
    await page.locator('#aiSendBtn').tap();
    await page.waitForFunction(() => window.testSent.length === 1 && !isAiLoading(getActiveConvId()));
    assert.deepEqual(await page.evaluate(() => window.testSent), [{ keyId: 'local', text: '保留这条草稿' }]);
    assert.match(await page.locator('#aiMessages').innerText(), /测试回复完成/);
    assert.equal(await page.locator('#settingsModal').evaluate(el => el.classList.contains('open')), false);
    // A stale UI after a synced selection change must preserve its draft too.
    await page.evaluate(() => {
      document.getElementById('aiInput').value = '同步期间的草稿';
      localStorage.setItem('study_active_api_key_id', 'missing');
      return sendAiMessage();
    });
    assert.equal(await page.locator('#aiInput').inputValue(), '同步期间的草稿');
    assert.equal(await page.locator('#settingsModal').evaluate(el => el.classList.contains('open')), false);
    await page.evaluate(() => { setAiLoading(getActiveConvId(), true); updateAiSendButton(); });
    assert.equal(await page.locator('#aiSendBtn').isDisabled(), false, 'stop remains available without credentials');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
