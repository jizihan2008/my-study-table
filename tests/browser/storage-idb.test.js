'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.join(__dirname, '../..');

test('IndexedDB migration, large writes, durable failures, reload and usage panel', { timeout: 90000 }, async () => {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (name === '/seed') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Seed</title>'); return; }
    const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/seed');
    await page.evaluate(async () => {
      localStorage.setItem('study_notes_v2', JSON.stringify([{ id: 701, type: 'note', title: '迁移笔记', content: '旧正文'.repeat(300000) }]));
      localStorage.setItem('study_ai_convs', JSON.stringify([{ id: 81, title: '分支', tree: { root: { id: 'root', role: 'root', children: [1] }, 1: { id: 1, role: 'user', parentId: 'root', children: [2, 3], content: '问题' }, 2: { id: 2, role: 'assistant', parentId: 1, children: [], content: '答案A' }, 3: { id: 3, role: 'assistant', parentId: 1, children: [], content: '答案B' } }, activePath: [1, 2], messages: [] }]));
      localStorage.setItem('study_sync_pending_conflicts', JSON.stringify({ x: { key: 'study_notes_v2', local: '保留冲突' } }));
      localStorage.setItem('study_timer_state', JSON.stringify({ mode: 'focus', running: false }));
      localStorage.setItem('study_theme', 'light');
      localStorage.setItem('study_api_keys', '[]');
      // Existing mirror data must not override the latest native value at first migration.
      await new Promise((resolve, reject) => {
        const r = indexedDB.open('my-study-table-data', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('records', { keyPath: 'key' });
        r.onsuccess = () => { const tx = r.result.transaction('records', 'readwrite'); tx.objectStore('records').put({ key: 'study_notes_v2', value: '[]', revision: 1 }); tx.oncomplete = () => { r.result.close(); resolve(); }; };
        r.onerror = () => reject(r.error);
      });
    });
    await page.goto(origin + '/');
    await page.waitForFunction(() => typeof saveDataDurable === 'function' && typeof executeToolCallStructured === 'function' && window.GlobalTranslation);
    await page.waitForFunction(() => window.StudyData?.status().ready);
    assert.deepEqual(errors, [], 'startup should load all modules without exceptions');
    const migrated = await page.evaluate(() => ({ title: notes.find(n => n.id === 701).title, chars: notes.find(n => n.id === 701).content.length,
      native: StudyData.nativeStorage.getItem('study_notes_v2'), conflict: localStorage.getItem('study_sync_pending_conflicts'),
      timerManaged: StudyData.isManaged('study_timer_state'), secretNative: StudyData.nativeStorage.getItem('study_api_keys'),
      branches: JSON.parse(localStorage.getItem('study_ai_convs'))[0].tree['1'].children }));
    assert.equal(migrated.title, '迁移笔记');
    assert.equal(migrated.chars, 900000);
    assert.equal(migrated.native, null);
    assert.match(migrated.conflict, /保留冲突/);
    assert.equal(migrated.timerManaged, false);
    assert.equal(migrated.secretNative, '[]');
    assert.deepEqual(migrated.branches, [2, 3]);

    const large = await page.evaluate(async () => {
      const n = notes.find(n => n.id === 701);
      n.content = '大'.repeat(6000000);
      const success = await saveDataDurable('study_notes_v2', notes);
      return { success, stored: JSON.parse(await StudyData.get('study_notes_v2'))[0].content.length, native: StudyData.nativeStorage.getItem('study_notes_v2') };
    });
    assert.deepEqual(large, { success: true, stored: 6000000, native: null });
    await page.reload();
    await page.waitForFunction(() => typeof executeToolCallStructured === 'function' && window.GlobalTranslation);
    assert.equal(await page.evaluate(() => notes.find(n => n.id === 701).content.length), 6000000);

    // Simulated native quota has no effect on managed notes and AI histories.
    const quotaIndependent = await page.evaluate(async () => {
      const original = Storage.prototype.setItem;
      const attempted = [];
      Storage.prototype.setItem = function(key) { attempted.push(key); throw new DOMException('native quota test: ' + key, 'QuotaExceededError'); };
      try {
        const read = await executeToolCallStructured('get_note_detail', { id: 701, limit: 1 });
        const result = await executeToolCallStructured('append_note', { id: 701, revision: read.data.revision, content: '\n追加成功' });
        const conversations = JSON.parse(localStorage.getItem('study_ai_convs'));
        conversations[0].tree['2'].content = '对话'.repeat(3000000);
        localStorage.setItem('study_ai_convs', JSON.stringify(conversations));
        await StudyData.flush(['study_ai_convs']);
        return { ok: result.ok, error: result.error, native: StudyData.nativeStorage.getItem('study_ai_convs'), length: JSON.parse(await StudyData.get('study_ai_convs'))[0].tree['2'].content.length };
      } finally { Storage.prototype.setItem = original; }
    });
    assert.equal(quotaIndependent.ok, true, quotaIndependent.error);
    assert.equal(quotaIndependent.native, null);
    assert.equal(quotaIndependent.length, 6000000);

    const failure = await page.evaluate(async () => {
      await StudyData.flush();
      const read = await executeToolCallStructured('get_note_detail', { id: 701, limit: 1 });
      const before = notes.find(n => n.id === 701).content;
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function () { if (this.name === 'records' && arguments[0]?.key === 'study_notes_v2') throw new DOMException('IDB quota injected', 'QuotaExceededError'); return original.apply(this, arguments); };
      let result;
      try { result = await executeToolCallStructured('append_note', { id: 701, revision: read.data.revision, content: '不应保留' }); }
      finally { IDBObjectStore.prototype.put = original; }
      return { ok: result.ok, code: result.code, error: result.error, same: notes.find(n => n.id === 701).content === before, durableSame: JSON.parse(await StudyData.get('study_notes_v2')).find(n => n.id === 701).content === before };
    });
    assert.equal(failure.ok, false);
    assert.equal(failure.code, 'SAVE_FAILED');
    assert.match(failure.error, /存储空间不足/);
    assert.match(failure.error, /QuotaExceededError：IDB quota injected/);
    assert.equal(failure.same, true);
    assert.equal(failure.durableSame, true);

    await page.evaluate(async () => { await StudyData.flush(); openSettingsModal(); switchSettingsTab('data'); });
    await page.waitForFunction(() => /用量已更新|仍有数据/.test(document.getElementById('storageUsageStatus').textContent));
    assert.match(await page.locator('#localStorageUsage').textContent(), /MiB/);
    assert.match(await page.locator('#indexedDbUsage').textContent(), /[KMGT]?i?B.*估算/);
    for (const [theme, width] of [['light', 1024], ['dark', 390]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(theme => applyTheme(theme), theme);
      assert.equal(await page.locator('#storageUsageRefresh').isVisible(), true);
      const bounds = await page.locator('#indexedDbUsage').boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    }
    await page.screenshot({ path: path.join(root, '.tmp-idb-storage-dark.png') });
    // Tombstones prevent a leftover native copy from resurrecting deleted data.
    await page.evaluate(async () => {
      localStorage.removeItem('study_sync_pending_conflicts');
      await StudyData.flush(['study_sync_pending_conflicts']);
      StudyData.nativeStorage.setItem('study_sync_pending_conflicts', '{"stale":true}');
    });
    await page.reload();
    await page.waitForFunction(() => window.StudyData?.status().ready && typeof executeToolCallStructured === 'function');
    assert.equal(await page.evaluate(() => localStorage.getItem('study_sync_pending_conflicts')), null);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('study_ai_convs'))[0].tree['3'].content), '答案B');

    const blockedContext = await browser.newContext({ serviceWorkers: 'block' });
    const blockedPage = await blockedContext.newPage();
    await blockedPage.goto(origin + '/seed');
    await blockedPage.evaluate(() => localStorage.setItem('study_notes_v2', '[{"id":9,"content":"迁移失败时保留原件"}]'));
    await blockedPage.addInitScript(() => {
      IDBObjectStore.prototype.put = function () { throw new DOMException('migration failed', 'QuotaExceededError'); };
    });
    await blockedPage.goto(origin + '/');
    await blockedPage.getByRole('alert').filter({ hasText: '应用已暂停启动' }).waitFor();
    assert.equal(await blockedPage.evaluate(() => localStorage.getItem('study_notes_v2')), '[{"id":9,"content":"迁移失败时保留原件"}]');
    assert.equal(await blockedPage.evaluate(() => typeof saveData), 'undefined', 'business modules cannot initialize with an empty snapshot');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
