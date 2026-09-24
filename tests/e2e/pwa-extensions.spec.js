'use strict';

const { test, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
let server;
let baseUrl;

// Use the system Chrome channel locally; GitHub's Windows runners also provide it.
test.use({ channel: 'chrome' });

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/__pwa_ext_test__.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><body>
        <script>window.renderSidebarNav = function () {};</script>
        <script src="/js/env.js"></script>
        <script src="/js/ext-api.js"></script>
        <script src="/js/ext-sandbox.js"></script>
        <script src="/js/patch-engine.js"></script>
        <script>window.BUILTIN_EXTENSIONS = [];</script>
        <script src="/js/extension-repository.js"></script>
        <script src="/js/ext-manager.js"></script>
      </body></html>`);
      return;
    }
    const target = path.resolve(root, '.' + pathname);
    if (!target.startsWith(root) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      response.writeHead(404); response.end('not found'); return;
    }
    response.writeHead(200, { 'Content-Type': target.endsWith('.js') ? 'application/javascript' : 'text/plain' });
    fs.createReadStream(target).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

test('PWA extension repository persists, mounts and trashes sandbox plugins', async ({ page }) => {
  await page.goto(baseUrl + '/__pwa_ext_test__.html');
  const installed = await page.evaluate(async () => {
    await ExtensionRepository.write({
      id: 'pwa-smoke',
      files: {
        manifest: { id: 'pwa-smoke', name: 'PWA Smoke', type: 'plugin', version: '1.0.0', enabled: true },
        main: `extAPI.registerSection({ id: 'pwa-smoke-panel', html: '<p>PWA works</p>' });`
      }
    });
    await ExtManager.reload();
    return {
      kind: ExtensionRepository.kind,
      listed: (await ExtensionRepository.list()).map(item => item.id),
      nav: ExtManager.get('pwa-smoke').sections.map(item => item.id)
    };
  });
  expect(installed).toEqual({ kind: 'indexeddb', listed: ['pwa-smoke'], nav: ['pwa-smoke-panel'] });

  await page.reload();
  const persisted = await page.evaluate(async () => {
    await ExtManager.reload();
    const code = await ExtensionRepository.read({ id: 'pwa-smoke', file: 'main.js' });
    const removed = await ExtManager.remove('pwa-smoke');
    return { code, removed, active: await ExtensionRepository.list(), trash: await ExtensionRepository.trashList() };
  });
  expect(persisted.code).toContain('pwa-smoke-panel');
  expect(persisted.removed.trashed).toBe(true);
  expect(persisted.active).toEqual([]);
  expect(persisted.trash).toHaveLength(1);
});
