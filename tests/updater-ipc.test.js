'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { registerUpdaterIpc } = require('../electron/register-updater-ipc');

function setup({ packaged = false, active = false } = {}) {
  const handlers = new Map();
  const sent = [];
  const updater = new EventEmitter();
  updater.isUpdaterActive = () => active;
  updater.checkForUpdates = async () => {};
  updater.downloadUpdate = async () => {};
  updater.quitAndInstall = () => {};
  const service = registerUpdaterIpc({
    app: { isPackaged: packaged, getVersion: () => '1.2.3' },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } }),
    loadUpdater: () => updater
  });
  return { handlers, sent, service, updater };
}

test('updater reports unsupported state in development builds', async () => {
  const { handlers, sent, service } = setup();
  service.init();
  assert.deepEqual(await handlers.get('update:get-state')(), {
    supported: false,
    currentVersion: '1.2.3',
    checking: false
  });
  assert.equal(sent[0][1].type, 'unsupported');
  assert.deepEqual(await handlers.get('update:check')(), { ok: false, reason: 'unsupported' });
});

test('updater forwards lifecycle events without auto downloading', async () => {
  const { handlers, sent, service, updater } = setup({ packaged: true, active: true });
  service.init();
  assert.equal(updater.autoDownload, false);
  updater.emit('checking-for-update');
  assert.equal((await handlers.get('update:get-state')()).checking, true);
  updater.emit('update-available', { version: '2.0.0' });
  assert.equal((await handlers.get('update:get-state')()).checking, false);
  assert.equal(sent.at(-1)[1].type, 'available');
  assert.deepEqual(await handlers.get('update:download')(), { ok: true });
});
