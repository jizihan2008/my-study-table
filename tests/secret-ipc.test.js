'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { registerSecretIpc } = require('../electron/register-secret-ipc');

test('secret vault encrypts allowed values at rest and rejects arbitrary keys', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-secret-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const handlers = new Map();
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from('encrypted:' + value, 'utf8'),
    decryptString: buffer => buffer.toString('utf8').replace(/^encrypted:/, '')
  };
  const service = registerSecretIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    safeStorage,
    userDataPath: root
  });
  await Promise.all([
    handlers.get('secret:set')(null, { key: 'study_api_keys', value: '[{"key":"sk-test"}]' }),
    handlers.get('secret:set')(null, { key: 'study_codebuddy_api_key', value: 'codebuddy-secret' })
  ]);
  const disk = await fs.readFile(service.vaultPath, 'utf8');
  assert.equal(disk.includes('sk-test'), false);
  assert.deepEqual((await handlers.get('secret:load-all')()).values, {
    study_api_keys: '[{"key":"sk-test"}]',
    study_codebuddy_api_key: 'codebuddy-secret'
  });
  await assert.rejects(
    handlers.get('secret:set')(null, { key: 'arbitrary', value: 'x' }),
    /不允许访问/
  );
});
