const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadReset(overrides = {}) {
  const deletedDatabases = [];
  const cleared = [];
  const context = {
    Promise,
    Object,
    Array,
    Set,
    String,
    Number,
    Math,
    setTimeout,
    clearTimeout,
    localStorage: { clear: () => cleared.push('local') },
    sessionStorage: { clear: () => cleared.push('session') },
    document: { cookie: '' },
    location: { hostname: 'study.example.test' },
    indexedDB: {
      databases: async () => [{ name: 'future-mst-store' }],
      deleteDatabase(name) {
        deletedDatabases.push(name);
        const request = {};
        setTimeout(() => request.onsuccess?.(), 0);
        return request;
      }
    },
    caches: { keys: async () => ['mst-v1-static'], delete: async () => true },
    navigator: { serviceWorker: { getRegistrations: async () => [{ scope: '/', unregister: async () => true }] } },
    ...overrides
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'site-data-reset.js'), 'utf8'), context);
  return { context, deletedDatabases, cleared };
}

test('site reset clears browser storage and every known or discovered database', async () => {
  const { context, deletedDatabases, cleared } = loadReset();
  const report = await context.SiteDataReset.run({ timeoutMs: 1000 });

  assert.equal(report.ok, true);
  assert.deepEqual(cleared, ['local', 'session']);
  assert.ok(deletedDatabases.includes('my-study-table-data'));
  assert.ok(deletedDatabases.includes('mst-sync-logs'));
  assert.ok(deletedDatabases.includes('future-mst-store'));
  assert.equal(report.caches[0].ok, true);
  assert.equal(report.serviceWorkers[0].ok, true);
});

test('site reset reports a database held open by another tab', async () => {
  const { context } = loadReset({
    indexedDB: {
      databases: async () => [],
      deleteDatabase(name) {
        const request = {};
        setTimeout(() => request.onblocked?.(), 0);
        return request;
      }
    }
  });
  const report = await context.SiteDataReset.run({ timeoutMs: 1000 });

  assert.equal(report.ok, false);
  assert.ok(report.databases.every(item => item.blocked));
});
