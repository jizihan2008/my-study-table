'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), vm = require('node:vm');
const { chromium } = require('playwright');
const root = path.join(__dirname, '../..');
const probe = fs.readFileSync(path.join(root, 'tests/probe/multidevice-sync.js'), 'utf8');
const cloud = vm.runInNewContext('(function () { const copy = value => JSON.parse(JSON.stringify(value)); ' +
  probe.slice(probe.indexOf('function cloud()'), probe.indexOf('function device(')) + '; return cloud; })()');

test('settings UI saves and receives account preferences while retaining local secrets, theme and drafts', { timeout: 90000 }, async () => {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const db = cloud(), errors = [];
    async function page(name) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(e.message));
      await page.exposeFunction('settingsTestQuery', async calls => {
        let builder = db.client({ userId: 'u1', name }).from('user_data');
        for (const [method, args] of calls) builder = builder[method](...args);
        return await builder;
      });
      await page.goto('http://127.0.0.1:' + server.address().port);
      await page.waitForFunction(() => window.SettingsSync && window.Sync && window.SecretVault.isReady());
      await page.evaluate(() => {
        getSupabaseClient = () => ({
          auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }),
            getUser: async () => ({ data: { user: null }, error: null }) },
          from() {
            const calls = [], builder = {};
            for (const method of ['select', 'eq', 'in', 'gte', 'update', 'insert', 'upsert']) builder[method] = (...args) => { calls.push([method, args]); return builder; };
            for (const method of ['single', 'maybeSingle']) builder[method] = (...args) => settingsTestQuery([...calls, [method, args]]);
            builder.then = (resolve, reject) => settingsTestQuery(calls).then(resolve, reject);
            return builder;
          }
        });
        Sync.setAutoSync(false);
        openSettingsModal(); switchSettingsTab('notes');
      });
      return page;
    }
    const a = await page('A'), b = await page('B');
    await a.locator('#settingsMaxFocusCount').fill('5'); await a.locator('#settingsMaxFocusCount').dispatchEvent('change');
    await a.locator('#settingsReviewMode').selectOption('relaxed');
    await a.evaluate(async () => {
      await saveApiKeys([{ id: 'key_shared', name: '同步测试', key: 'sk-only-a', baseUrl: 'https://example.test/v1', model: 'model-a', contextBudget: 64000 }]);
      switchActiveKey('key_shared');
      saveAutoTitleSetting();
      await Sync.uploadAll({ moduleId: 'settings' });
    });
    await b.evaluate(async () => { applyTheme('dark'); await Sync.manualSync({ moduleId: 'settings' }); });
    assert.equal(await b.locator('#settingsMaxFocusCount').inputValue(), '5');
    assert.equal(await b.locator('#settingsReviewMode').inputValue(), 'relaxed');
    assert.equal(await b.evaluate(() => getEffectiveApiConfig().apiKey), '');
    assert.equal(await b.evaluate(() => localStorage.getItem('study_theme')), 'dark');
    await b.evaluate(() => switchSettingsTab('api'));
    assert.match(await b.locator('#apiKeyList').innerText(), /需在此设备填写密钥/);
    // A remote preference must leave an open API form's text intact.
    await b.evaluate(() => editApiKey('key_shared'));
    await b.locator('#apiKeyFormModel').fill('draft-model');
    await a.evaluate(async () => { setSyncedSetting('study_max_focus_count', '4'); await Sync.manualSync({ moduleId: 'settings' }); });
    await b.evaluate(async () => { await Sync.manualSync({ moduleId: 'settings' }); });
    assert.equal(await b.locator('#apiKeyFormModel').inputValue(), 'draft-model');
    // A synced configuration can be edited before the device's own secret is filled.
    await b.locator('#apiKeyFormSave').click();
    await b.waitForFunction(() => document.getElementById('apiKeyForm').style.display === 'none');
    await b.evaluate(async () => { await Sync.manualSync({ moduleId: 'settings' }); });
    await a.evaluate(async () => { await Sync.manualSync({ moduleId: 'settings' }); });
    assert.equal(await a.evaluate(() => getEffectiveApiConfig().model), 'draft-model');
    assert.equal(await a.evaluate(() => getEffectiveApiConfig().apiKey), 'sk-only-a');
    assert.ok(!JSON.stringify([...db.rows.values()]).includes('sk-only-a'));
    // Retry repeats the failed module even if the module picker has since changed.
    await a.evaluate(async () => {
      openSettingsModal(); switchSettingsTab('sync');
      const getStatus = Sync.getStatus, manualSync = Sync.manualSync;
      window.retryTest = { calls: [], error: '', mode: 'failure', restore() { Sync.getStatus = getStatus; Sync.manualSync = manualSync; } };
      Sync.getStatus = async () => ({ ...await getStatus(), lastError: retryTest.error });
      Sync.manualSync = async options => {
        retryTest.calls.push(options.moduleId);
        if (retryTest.mode === 'failure') retryTest.error = '上一次同步仍未完成，请稍后重试';
        else if (retryTest.mode === 'throw') throw new Error('网络超时，请稍后重试');
        else {
          await new Promise(resolve => { retryTest.finish = resolve; });
          retryTest.error = '';
        }
        return { lastError: retryTest.error, pendingConflictCount: 0 };
      };
      await renderSyncPanel();
    });
    assert.equal(await a.locator('#syncRetryButton').isVisible(), false);
    await a.locator('#syncModuleSelect').selectOption('notes'); await a.locator('#syncManualButton').click();
    await a.waitForFunction(() => !document.getElementById('syncRetryButton').hidden && !document.getElementById('syncRetryButton').disabled);
    assert.match(await a.locator('#syncStatus').innerText(), /请稍后重试/);
    await a.locator('#syncModuleSelect').selectOption('settings');
    await a.evaluate(() => { retryTest.mode = 'pending'; }); await a.locator('#syncRetryButton').click();
    await a.waitForFunction(() => typeof retryTest.finish === 'function');
    assert.equal(await a.locator('#syncRetryButton').isDisabled(), true);
    assert.equal(await a.locator('#syncRetryButton').innerText(), '重试中…');
    await a.evaluate(async () => { await syncRetryNow(); });
    assert.deepEqual(await a.evaluate(() => retryTest.calls), ['notes', 'notes']);
    await a.evaluate(() => { retryTest.finish(); });
    await a.waitForFunction(() => document.getElementById('syncRetryButton').hidden);
    assert.match(await a.locator('#syncStatus').innerText(), /同步完成/);
    await a.evaluate(async () => { retryTest.mode = 'throw'; await syncManualSync(); });
    assert.equal(await a.locator('#syncRetryButton').isVisible(), true);
    assert.match(await a.locator('#syncStatus').getAttribute('class'), /error/);
    await a.evaluate(() => { retryTest.restore(); });
    await b.evaluate(async () => { await saveApiKeys(loadApiKeys().map(k => ({ ...k, key: 'sk-only-b' }))); });
    await b.reload(); await b.waitForFunction(() => window.SecretVault.isReady() && typeof loadApiKeys === 'function');
    assert.equal(await b.evaluate(() => getEffectiveApiConfig().apiKey), 'sk-only-b');
    assert.equal(await b.evaluate(() => localStorage.getItem('study_max_focus_count')), '4');
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); await new Promise(r => server.close(r)); }
});
