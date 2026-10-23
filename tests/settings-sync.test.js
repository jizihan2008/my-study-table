'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const policy = require('../js/sync-policy');
const read = name => fs.readFileSync(require.resolve('../js/' + name), 'utf8');
const probe = fs.readFileSync(require.resolve('./probe/multidevice-sync.js'), 'utf8');
// Reuse the existing deterministic server, including conditional writes and server timestamps.
const cloud = vm.runInNewContext('(function () { const copy = value => JSON.parse(JSON.stringify(value)); ' +
  probe.slice(probe.indexOf('function cloud()'), probe.indexOf('function device(')) + '; return cloud; })()');
const metadata = (model = 'model-a') => ({ id: 'key_shared', name: '常用', model, baseUrl: 'https://example.test/v1',
  temperature: 0.4, contextBudget: 64000, deepThink: true, maxTokens: 8000, contextLimit: 12, titleContextCount: 3 });
const plain = value => JSON.parse(JSON.stringify(value));
async function device(db, initial = {}, keys = []) {
  const values = new Map(Object.entries({ study_sync_config: JSON.stringify({ enabled: true, autoSync: false }), ...initial }));
  const disk = { getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const state = { userId: 'u1' };
  const context = vm.createContext({ localStorage: disk, SyncPolicy: policy,
    getSupabaseClient: () => db.client(state), console: { warn() {}, error() {}, log() {} },
    setTimeout: () => 1, clearTimeout() {},
    document: { getElementById: () => null, querySelector: () => null },
    saveData: (key, value) => { disk.setItem(key, JSON.stringify(value)); return true; } });
  context.window = context;
  vm.runInContext(read('secrets.js'), context); await context.SecretVault.initialize();
  vm.runInContext(read('settings-sync.js'), context);
  const settings = read('settings.js');
  vm.runInContext(settings.slice(settings.indexOf('function loadApiKeys()'), settings.indexOf('function getActiveApiKeyId()')), context);
  if (keys.length) await context.saveApiKeys(keys);
  vm.runInContext(read('sync.js'), context); context.Sync.init();
  return { context, disk, values, sync: context.Sync, prefs: context.SettingsSync,
    async upload() { await context.Sync.getStatus(); return context.Sync.uploadAll({ moduleId: 'settings' }); },
    async pull() { await context.Sync.getStatus(); return context.Sync.manualSync({ moduleId: 'settings' }); } };
}

test('approved preferences synchronize with exact local encodings; device settings and secrets stay local', async () => {
  const db = cloud(), a = await device(db), b = await device(db, {
    study_theme: 'dark', study_reminder_checkin_enabled: 'false', study_web_search_key: 'local-search-secret', study_deepseek_web_key: 'local-deepseek-secret',
    study_backup_interval: '120', study_codex_cli_path: 'local-cli', study_automations: '[{"id":1}]'
  });
  const prefs = {
    study_max_focus_count: '4', study_todo_statuses: '[{"id":"custom","name":"待检查","color":"#123456"}]',
    study_review_mode: 'custom', study_review_custom_intervals: '2,5,12', study_auto_summary: 'false',
    study_morning_cfg: '{"enabled":false}', study_evening_report_cfg: '{"enabled":true,"time":"22:30"}',
    study_auto_title_enabled: 'false', study_memory_dedup_mode: 'ai', study_memory_dedup_threshold: '40',
    study_books_kb_truncate: '12000', study_bk_explain_ctx_rounds: '8',
    study_reminder_checkin_time: '08:45', study_reminder_focus_after_min: '45', study_reminder_idle_after_min: '90',
    study_reminder_idle_exempt_ranges: '[{"start":"12:00","end":"14:00"}]',
    study_reminder_idle_exempt_enabled: 'true', study_reminder_idle_max_count: '5', study_reminder_idle_unlimited: 'false',
    study_reminder_idle_skip_calendar: 'true',
    study_web_search_engine: 'deepseek', study_web_read_mode: 'deepseek', study_ai_library_pdf_max_mib: '0', study_ai_image_upload: 'never',
    study_active_api_key_id: 'key_shared', study_dayreport_key_id: 'key_shared',
    study_summary_ai_key_id: 'key_shared', study_auto_title_ai_key_id: 'key_shared'
  };
  for (const [key, value] of Object.entries(prefs)) a.prefs.setItem(key, value);
  for (const key of ['study_theme', 'study_ui_zoom', 'study_reminder_checkin_enabled', 'study_reminder_focus_enabled',
    'study_reminder_idle_enabled', 'study_api_keys', 'study_web_search_key', 'study_deepseek_web_key', 'study_backup_interval',
    'study_codex_cli_path', 'study_debug_mode', 'study_developer_mode', 'study_automations', 'study_sync_config']) {
    assert.equal(a.sync.isSyncKey(key), false, key);
    if (key !== 'study_sync_config') a.disk.setItem(key, 'device-specific');
  }
  await a.upload(); await b.pull();
  for (const [key, raw] of Object.entries(prefs)) assert.deepEqual(plain(b.prefs.decode(key, b.disk.getItem(key))), plain(a.prefs.decode(key, raw)), key);
  assert.equal(b.disk.getItem('study_review_mode'), 'custom');
  assert.equal(b.disk.getItem('study_auto_title_enabled'), 'false');
  assert.equal(b.disk.getItem('study_theme'), 'dark');
  assert.equal(b.disk.getItem('study_web_search_key'), 'local-search-secret');
  assert.equal(b.disk.getItem('study_deepseek_web_key'), 'local-deepseek-secret');
  assert.equal(b.disk.getItem('study_automations'), '[{"id":1}]');
  assert.equal(b.disk.getItem('study_reminder_checkin_enabled'), 'false');
  assert.equal((await b.sync.getStatus()).pendingCount, 0, 'remote writes must not echo as local edits');
  b.prefs.setItem('study_review_mode', 'off'); b.prefs.setItem('study_review_custom_intervals', '');
  await b.pull(); await a.pull();
  assert.equal(a.disk.getItem('study_review_mode'), 'off'); assert.equal(a.disk.getItem('study_review_custom_intervals'), '');
  assert.ok(a.sync.getModules().some(m => m.id === 'settings'));
});

test('API metadata crosses devices without a secret, preserves each local secret and refreshes AI selection', async () => {
  const db = cloud(), a = await device(db, {}, [{ ...metadata(), key: 'sk-device-a', unknownCredential: 'never-upload' }]);
  const b = await device(db), c = await device(db, {}, [{ ...metadata(), key: 'sk-device-c' }]);
  a.prefs.setItem('study_active_api_key_id', 'key_shared'); await a.upload(); await b.pull(); await c.pull();
  const remote = db.raw('u1', a.prefs.API_KEY);
  assert.deepEqual(plain(remote), [metadata()]); assert.ok(!JSON.stringify([...db.rows.values()]).includes('sk-device'));
  assert.equal(b.context.loadApiKeys()[0].key, ''); assert.equal(c.context.loadApiKeys()[0].key, 'sk-device-c');
  assert.equal(b.disk.getItem('study_active_api_key_id'), 'key_shared');
  await a.context.saveApiKeys([{ ...metadata('model-new'), key: 'sk-device-a-updated' }]);
  await a.pull(); await b.pull(); await c.pull();
  assert.equal(c.context.loadApiKeys()[0].model, 'model-new'); assert.equal(c.context.loadApiKeys()[0].key, 'sk-device-c');
  await b.context.saveApiKeys([{ ...b.context.loadApiKeys()[0], key: 'sk-device-b' }]);
  assert.equal((await b.sync.getStatus()).pendingCount, 0, 'filling a local secret alone is not a config change');
  assert.ok(!JSON.stringify([...db.rows.values()]).includes('sk-'));
  // A tampered mirror is sanitized again at the cloud boundary, including forced batch uploads.
  a.disk.setItem(a.prefs.API_KEY, JSON.stringify([{ ...metadata(), key: 'sk-injected', extra: { secret: 'nested' } }]));
  await a.upload(); assert.ok(!JSON.stringify([...db.rows.values()]).includes('sk-injected'));
});

test('real preference edits conflict; equal settings and credential-only changes do not', async () => {
  const db = cloud(), a = await device(db), b = await device(db);
  a.prefs.setItem('study_max_focus_count', '3'); await a.upload(); await b.pull();
  a.prefs.setItem('study_max_focus_count', '4'); b.prefs.setItem('study_max_focus_count', '5');
  await a.pull(); const status = await b.pull(); assert.equal(status.pendingConflictCount, 1);
  const diff = await b.sync.getConflictDifferences('study_max_focus_count');
  assert.equal(diff.local, '5'); assert.equal(diff.remote, '4');
  await b.sync.resolveConflict('study_max_focus_count', 'remote'); assert.equal(b.disk.getItem('study_max_focus_count'), '4');
  b.prefs.setItem('study_max_focus_count', '4'); assert.equal((await b.sync.getStatus()).pendingCount, 0);
});

test('failed remote credential persistence keeps local metadata and credentials intact', async () => {
  const db = cloud(), a = await device(db, {}, [{ ...metadata(), key: 'sk-local' }]);
  const before = a.disk.getItem(a.prefs.API_KEY);
  const save = a.context.saveApiKeys; a.context.saveApiKeys = async () => { throw new Error('vault unavailable'); };
  await assert.rejects(a.prefs.apply(a.prefs.API_KEY, [metadata('new')]), /vault unavailable/);
  assert.equal(a.disk.getItem(a.prefs.API_KEY), before); assert.equal(a.context.loadApiKeys()[0].key, 'sk-local');
  a.context.saveApiKeys = save;
  await a.prefs.apply(a.prefs.API_KEY, [{ ...metadata('safe'), key: 'sk-remote-forbidden' }]);
  assert.equal(a.context.loadApiKeys()[0].key, 'sk-local');
});
