'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webkit, devices } = require('playwright');
const root = path.resolve(__dirname, '../..');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

test('mobile WebKit keeps chat controls usable across credential and attachment failures', { timeout: 90000 }, async () => {
  let browser;
  try {
    browser = await webkit.launch({ headless: true });
    const device = process.env.MST_WEBKIT_DEVICE || 'iPad Pro 11';
    const context = await browser.newContext({ ...devices[device], serviceWorkers: 'block' });
    const page = await context.newPage();
    const requests = [];
    const sendScriptUrls = new Set();
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/js/ai-send.js') sendScriptUrls.add(url.pathname + url.search);
      if (url.href === 'http://study-table.test/mock/v1/chat/completions') {
        requests.push(route.request().postDataJSON());
        return route.fulfill({ json: { choices: [{ message: { content: '测试回复完成' }, finish_reason: 'stop' }] } });
      }
      if (url.href === 'http://study-table.test/stalled/v1/files') return;
      if (url.hostname !== 'study-table.test') return route.abort();
      const pathname = decodeURIComponent(url.pathname);
      const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404 });
      return route.fulfill({ path: file });
    });
    await page.goto('http://study-table.test/');
    await page.waitForSelector('#section-today.active');
    await page.evaluate(async () => {
      await saveApiKeys([
        { id: 'local', name: '本机 Key', key: 'dummy-test-credential', model: 'test-vision-model', baseUrl: 'http://study-table.test/mock/v1' },
        { id: 'remote', name: '同步 Key', key: '', model: 'test-model' }
      ], { sync: false });
      localStorage.setItem('study_active_api_key_id', 'local');
      switchTab('ai'); createNewConv();
      generateConvTitle = () => {};
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
    assert.equal(requests.length, 0);
    await page.locator('#aiToolbarKeySelect').selectOption('local');
    assert.equal(await page.locator('#aiInput').isDisabled(), false);
    assert.equal(await page.locator('#aiInput').inputValue(), '保留这条草稿');
    await page.locator('#aiSendBtn').tap();
    await page.waitForFunction(() => !isAiLoading(getActiveConvId()) && document.getElementById('aiMessages').textContent.includes('测试回复完成'));
    assert.equal(requests.length, 1);
    assert.match(requests[0].messages.at(-1).content, /保留这条草稿/);
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

    await page.evaluate(async () => {
      setAiLoading(getActiveConvId(), false);
      switchActiveKey('local');
      createNewConv();
      const conv = getActiveConv();
      appendMessage(conv, { role: 'user', content: '历史图片消息', attachments: [null] });
      appendMessage(conv, { role: 'user', content: '上次未收到回复' });
      renderAiChat();
    });
    assert.equal(await page.locator('#aiToolbarKeySelect').inputValue(), 'local');
    assert.equal(await page.locator('#aiToolbarDeepThinkBtn svg').isVisible(), true);
    assert.match(await page.locator('#aiMessages').innerText(), /历史图片消息/);
    await page.getByRole('button', { name: '重试回复' }).tap();
    await page.waitForFunction(() => !isAiLoading(getActiveConvId()) && document.getElementById('aiMessages').textContent.includes('测试回复完成'));
    assert.equal(requests.length, 2);

    await page.locator('#aiFileInput').setInputFiles({
      name: 'photo.png',
      mimeType: 'image/png',
      buffer: png,
    });

    await page.locator('#aiInput').fill('重发图文');
    await page.evaluate(async () => {
      const prepare = prepareAiMessageAttachments;
      prepareAiMessageAttachments = async () => { throw new Error('test attachment failure'); };
      try { await sendAiMessage(); }
      finally { prepareAiMessageAttachments = prepare; }
    });
    assert.equal(await page.locator('#aiInput').inputValue(), '重发图文');
    assert.match(await page.locator('#aiAttachPreview').innerText(), /photo\.png/);
    assert.equal(await page.locator('#aiSendBtn').getAttribute('title'), '发送');
    await page.locator('#aiSendBtn').tap();
    await page.waitForFunction(() => !isAiLoading(getActiveConvId()) && document.querySelectorAll('.ai-chat-msg.assistant').length === 2);
    assert.equal(requests.length, 3);
    const parts = requests[2].messages.at(-1).content;
    assert.ok(parts.some(part => part.type === 'text' && part.text.includes('重发图文')));
    assert.ok(parts.some(part => part.type === 'image_url' && part.image_url.url.startsWith('data:image/png;base64,')));
    assert.equal(await page.locator('#aiMessages img[alt="photo.png"]').isVisible(), true);
    assert.equal(await page.locator('#aiToolbarDeepThinkBtn svg').isVisible(), true);

    // The first image triggers a full chat rebuild as it sets the new conversation title.
    // Its renderer must receive a version of ai-send.js that exports splitAiEditContent.
    await page.evaluate(() => createNewConv());
    await page.locator('#aiFileInput').setInputFiles({
      name: 'first-photo.png',
      mimeType: 'image/png',
      buffer: png,
    });
    await page.locator('#aiInput').fill('第一条图文消息');
    await page.locator('#aiSendBtn').tap();
    await page.waitForFunction(() => !isAiLoading(getActiveConvId()) && document.getElementById('aiMessages').textContent.includes('测试回复完成'));
    assert.equal(requests.length, 4);
    assert.equal(await page.locator('#aiToolbarKeySelect').inputValue(), 'local');
    assert.equal(await page.locator('#aiToolbarDeepThinkBtn svg').isVisible(), true);
    assert.equal(sendScriptUrls.size, 1);
    const [sendScriptUrl] = sendScriptUrls;
    assert.notEqual(sendScriptUrl, '/js/ai-send.js?v=20261019-ipad-send-r1');
    assert.ok(fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8').includes(JSON.stringify('.' + sendScriptUrl)));

    await assert.rejects(page.evaluate(() => uploadImageToDeepSeek(new File(['data'], 'photo.png'), {
      baseUrl: '/stalled/v1', apiKey: 'dummy-test-credential', timeoutMs: 100,
    })), /请求超时/);
  } finally {
    if (browser) await browser.close();
  }
});
