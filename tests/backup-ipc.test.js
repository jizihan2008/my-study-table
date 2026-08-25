'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { registerBackupIpc } = require('../electron/register-backup-ipc');

test('backup IPC writes sanitized data and exposes metadata', async t => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-backup-test-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const handlers = new Map();
  registerBackupIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    shell: { openPath: async () => '' },
    userDataPath: tempRoot
  });

  const result = await handlers.get('perform-backup')(null, {
    data: { study_todos_v2: '[]', study_api_keys: '[{"key":"secret"}]' },
    maxFiles: 2
  });
  const saved = JSON.parse(await fs.readFile(result.path, 'utf8'));
  assert.deepEqual(saved, { study_todos_v2: '[]' });

  const list = await handlers.get('list-backups')();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, path.basename(result.path));
});
