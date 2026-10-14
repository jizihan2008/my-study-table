'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const secrets = fs.readFileSync(require.resolve('../js/secrets.js'), 'utf8');
const settings = fs.readFileSync(require.resolve('../js/settings.js'), 'utf8');

function vault(storage, options = {}) {
  const window = { ...options };
  const context = vm.createContext({ window, localStorage: storage });
  vm.runInContext(secrets, context);
  return window.SecretVault;
}
function storage() {
  const values = new Map();
  return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
}
const keys = [{ id: 'test', name: 'test', key: 'dummy-test-credential' }];

test('web credentials survive a fresh runtime', async () => {
  const disk = storage();
  const first = vault(disk);
  await first.initialize();
  await first.setJson('study_api_keys', keys);
  const restarted = vault(disk);
  await restarted.initialize();
  assert.equal(JSON.stringify(restarted.getJson('study_api_keys', [])), JSON.stringify(keys));
});

for (const name of ['QuotaExceededError', 'SecurityError']) {
  test(`${name} preserves previously saved credentials in memory and on disk`, async () => {
    const disk = storage();
    const live = vault(disk);
    await live.setJson('study_api_keys', keys);
    disk.setItem = () => { throw Object.assign(new Error('storage failed'), { name }); };
    await assert.rejects(live.setJson('study_api_keys', []), { name });
    assert.equal(JSON.stringify(live.getJson('study_api_keys', [])), JSON.stringify(keys));
    assert.equal(JSON.stringify(vault(disk).getJson('study_api_keys', [])), JSON.stringify(keys));
  });
}

test('quota recovery retries once and commits only after persistence', async () => {
  const disk = storage();
  const write = disk.setItem;
  let writes = 0;
  let recoveries = 0;
  disk.setItem = (k, v) => {
    if (++writes === 1) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    write(k, v);
  };
  const live = vault(disk, { isStorageQuotaError: e => e.name === 'QuotaExceededError', recoverStorageSpace: () => ++recoveries });
  await live.setJson('study_api_keys', keys);
  assert.equal(writes, 2);
  assert.equal(recoveries, 1);
  assert.equal(JSON.stringify(vault(disk).getJson('study_api_keys', [])), JSON.stringify(keys));
});

test('desktop rejected writes restore the previous cache', async () => {
  const disk = storage();
  disk.setItem('study_api_keys', JSON.stringify(keys));
  const live = vault(disk, { electronAPI: { secretSet: async () => ({ ok: false }) } });
  await assert.rejects(live.setJson('study_api_keys', []));
  assert.equal(JSON.stringify(live.getJson('study_api_keys', [])), JSON.stringify(keys));
});

function formContext(save) {
  const fields = { apiKeyFormName: 'test', apiKeyFormKey: 'dummy-test-credential' };
  const elements = {};
  for (const id of ['apiKeyFormEditId', 'apiKeyFormName', 'apiKeyFormKey', 'apiKeyFormBaseUrl', 'apiKeyFormModel', 'apiKeyFormTemp', 'apiKeyFormMaxTokens', 'apiKeyFormContextLimit', 'apiKeyFormContextBudget', 'apiKeyFormTitleContext', 'apiKeyFormSave', 'apiKeyFormStatus', 'apiKeyForm']) {
    elements[id] = { value: fields[id] || '', style: { display: 'block' }, textContent: '', disabled: false };
  }
  const messages = [];
  let renders = 0;
  const context = vm.createContext({
    document: { getElementById: id => elements[id] },
    loadApiKeys: () => [], saveApiKeys: save, genId: () => 1,
    getActiveApiKeyId: () => '', switchActiveKey: () => {},
    renderApiKeyList: () => renders++, showSettingsStatus: (msg, error) => messages.push({ msg, error })
  });
  vm.runInContext(settings.slice(settings.indexOf('let apiKeyFormSaving'), settings.indexOf('function setActiveApiKey')), context);
  return { context, elements, messages, renders: () => renders };
}

test('form keeps inputs and displays quota failure without success or rendering', async () => {
  const state = formContext(async () => { throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }); });
  await state.context.submitApiKeyForm();
  assert.equal(state.elements.apiKeyForm.style.display, 'block');
  assert.equal(state.elements.apiKeyFormKey.value, 'dummy-test-credential');
  assert.match(state.elements.apiKeyFormStatus.textContent, /本地存储空间不足/);
  assert.equal(state.messages[0].error, true);
  assert.equal(state.renders(), 0);
  assert.equal(state.elements.apiKeyFormSave.disabled, false);
});

test('form waits for persistence and prevents duplicate taps', async () => {
  let resolve;
  let saves = 0;
  const state = formContext(() => { saves++; return new Promise(r => { resolve = r; }); });
  const pending = state.context.submitApiKeyForm();
  await state.context.submitApiKeyForm();
  assert.equal(saves, 1);
  assert.equal(state.elements.apiKeyFormSave.disabled, true);
  assert.equal(state.elements.apiKeyForm.style.display, 'block');
  assert.equal(state.messages.length, 0);
  resolve({ ok: true });
  await pending;
  assert.equal(state.elements.apiKeyForm.style.display, 'none');
  assert.equal(state.renders(), 1);
  assert.equal(state.messages.length, 1);
});
