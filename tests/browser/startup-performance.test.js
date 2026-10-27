'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');

test('parallel startup preserves hydration and dependency order; warm PWA survives a stalled network', { timeout: 90000 }, async () => {
  // Disable preload hints to reproduce the serial download baseline.
  const oldLoader = fs.readFileSync(path.join(root, 'js/app-loader.js'), 'utf8')
    .replace("link.rel = 'preload'", "link.rel = 'study-baseline-no-preload'");
  let baseline = false;
  let stall = false;
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (stall) return;
    const name = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    const data = baseline && name === '/js/app-loader.js' ? oldLoader : fs.readFileSync(file);
    res.setHeader('Content-Type', /\.(m?js)$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    setTimeout(() => res.end(data), 80);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const times = [];
    for (const old of [true, false]) {
      baseline = old;
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        window.addEventListener('study:ready', () => { window.startupDuration = performance.now(); });
      });
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.startupDuration && document.querySelector('#section-today')?.innerHTML.length > 0);
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => StudyData.status().ready && !!GlobalTranslation && typeof executeToolCallStructured === 'function'), true);
      times.push(await page.evaluate(() => startupDuration));
      await context.close();
    }
    console.log('80 ms/request cold startup: baseline=' + Math.round(times[0]) + ' ms, optimized=' + Math.round(times[1]) + ' ms');
    assert.ok(times[1] < times[0] * 0.7, 'parallel preloads should remove the serial network waterfall');
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.reload();
    await page.waitForFunction(() => !!window.GlobalTranslation && document.querySelector('#section-today')?.innerHTML.length > 0);
    // Ensure runtime assets (including fonts) have reached the cache.
    await page.evaluate(() => document.fonts.ready);
    stall = true;
    const start = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(() => !!window.GlobalTranslation && document.querySelector('#section-today')?.innerHTML.length > 0, { timeout: 15000 });
    const duration = Date.now() - start;
    console.log('Warm startup with stalled network=' + duration + ' ms');
    assert.ok(duration < 10000);
    assert.equal(await page.evaluate(() => StudyData.status().ready), true);
    await context.close();
  } finally {
    if (browser) await browser.close();
    sockets.forEach(socket => socket.destroy());
    await new Promise(resolve => server.close(resolve));
  }
});
