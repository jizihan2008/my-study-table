'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { registerExtensionIpc } = require('../electron/register-extension-ipc');

async function createHarness(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-extension-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const handlers = new Map();
  const service = registerExtensionIpc({
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    shell: { openPath: async () => '' },
    userDataPath: root,
    getMainWindow: () => null
  });
  return { handlers, root, service };
}

test('extension handlers write, list and read a valid extension', async t => {
  const { handlers } = await createHarness(t);
  const manifest = { id: 'focus-tools', name: 'Focus Tools', enabled: true };
  const result = await handlers.get('ext:write')(null, {
    id: 'focus-tools',
    files: { manifest, main: 'module.exports = {};' }
  });
  assert.equal(result.ok, true);
  assert.equal(await handlers.get('ext:read')(null, { id: 'focus-tools', file: 'main.js' }), 'module.exports = {};');
  const extensions = await handlers.get('ext:list')();
  assert.equal(extensions.length, 1);
  assert.equal(extensions[0].id, 'focus-tools');
  assert.equal(extensions[0].error, null);
});

test('extension writes reject traversal, id mismatches and non-whitelisted reads', async t => {
  const { handlers } = await createHarness(t);
  await assert.rejects(
    handlers.get('ext:write')(null, { id: '../outside', files: { manifest: { id: '../outside' } } }),
    /非法扩展 id/
  );
  await assert.rejects(
    handlers.get('ext:write')(null, { id: 'safe-id', files: { manifest: { id: 'other-id' } } }),
    /不一致/
  );
  await assert.rejects(
    handlers.get('ext:read')(null, { id: 'safe-id', file: '../secret' }),
    /不允许读取/
  );
});

test('extension trash supports remove and restore without losing files', async t => {
  const { handlers } = await createHarness(t);
  await handlers.get('ext:write')(null, {
    id: 'recoverable',
    files: { manifest: { id: 'recoverable', enabled: true }, main: '42' }
  });
  const removed = await handlers.get('ext:remove')(null, { id: 'recoverable' });
  assert.equal(removed.trashed, true);
  assert.equal((await handlers.get('ext:list')()).length, 0);
  const restored = await handlers.get('ext:trash-restore')(null, { trashDir: removed.trashDir });
  assert.deepEqual(restored, { ok: true, id: 'recoverable' });
  assert.equal(await handlers.get('ext:read')(null, { id: 'recoverable', file: 'main.js' }), '42');
});

test('folder imports copy only executable files and start disabled', async t => {
  const { handlers, root } = await createHarness(t);
  const source = path.join(root, 'incoming');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify({ id: 'imported', enabled: true }), 'utf8');
  await fs.writeFile(path.join(source, 'main.js'), 'console.log("loaded")', 'utf8');
  await fs.writeFile(path.join(source, 'ignored.txt'), 'not copied', 'utf8');
  const result = await handlers.get('ext:import')(null, { sourcePath: source });
  assert.equal(result.ok, true);
  const manifest = JSON.parse(await handlers.get('ext:read')(null, { id: 'imported', file: 'manifest.json' }));
  assert.equal(manifest.enabled, false);
  assert.equal(manifest.source, 'local-directory');
  await assert.rejects(fs.access(path.join(result.dir, 'ignored.txt')));
});
