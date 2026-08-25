'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { registerLibraryIpc } = require('../electron/register-library-ipc');

test('textbook cache handlers round-trip safe identifiers and reject traversal', async t => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-library-test-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const handlers = new Map();
  registerLibraryIpc({
    app: { getPath: () => tempRoot },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    userDataPath: tempRoot,
    getMainWindow: () => null
  });

  const saved = await handlers.get('books:text-save')(null, { bookId: 'book_2026-1', data: { pages: 3 } });
  assert.equal(saved.ok, true);
  assert.equal(await handlers.get('books:text-load')(null, { bookId: 'book_2026-1' }), '{"pages":3}');
  assert.deepEqual(await handlers.get('books:text-save')(null, { bookId: '../secret', data: 'x' }), {
    ok: false,
    reason: '非法 bookId'
  });
  assert.equal((await handlers.get('books:text-delete')(null, { bookId: 'book_2026-1' })).ok, true);
  assert.equal(await handlers.get('books:text-load')(null, { bookId: 'book_2026-1' }), null);
});

test('media readers enforce their extension allowlists', async () => {
  const handlers = new Map();
  registerLibraryIpc({
    app: { getPath: () => '' },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    userDataPath: os.tmpdir(),
    getMainWindow: () => null
  });
  assert.equal(await handlers.get('read-audio-file')(null, 'notes.txt'), null);
  assert.equal(await handlers.get('pdf:read')(null, 'notes.txt'), null);
});
