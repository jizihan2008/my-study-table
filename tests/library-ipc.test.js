'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { registerLibraryIpc } = require('../electron/register-library-ipc');
const { compare } = require('../lib/file-library-order');

test('file library persists sorting and moves folders without losing their contents', async t => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-library-organize-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const handlers = new Map();
  const register = () => registerLibraryIpc({
    app: { getPath: () => tempRoot },
    dialog: {},
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    userDataPath: tempRoot,
    getMainWindow: () => null
  });
  register();
  const folder = await handlers.get('files:create-folder')(null, { name: '课程' });
  const child = await handlers.get('files:create-folder')(null, { name: '章节', parentId: folder.id });
  const [a, b] = await handlers.get('files:import-data')(null, [
    { name: 'a.txt', data: Buffer.from('a') }, { name: 'b.txt', data: Buffer.from('b') }
  ]);
  await handlers.get('files:organize')(null, { id: b.id, beforeId: folder.id });
  register(); // Reopen handlers to check disk persistence rather than in-memory state.
  let rows = await handlers.get('files:list')();
  assert.deepEqual(rows.filter(row => !row.parentId).sort(compare).map(row => row.id), [b.id, folder.id, a.id]);
  await handlers.get('files:organize')(null, { id: a.id, parentId: child.id });
  await assert.rejects(handlers.get('files:organize')(null, { id: folder.id, parentId: child.id }), /自身或其子文件夹/);
  await assert.rejects(handlers.get('files:organize')(null, { id: folder.id, parentId: folder.id }), /自身或其子文件夹/);
  await assert.rejects(handlers.get('files:organize')(null, { id: a.id, parentId: b.id }), /目标文件夹/);
  await assert.rejects(handlers.get('files:organize')(null, { id: b.id, beforeId: a.id }), /排序目标/);
  await handlers.get('files:organize')(null, { id: folder.id, parentId: null, beforeId: b.id });
  assert.equal(String((await handlers.get('files:read')(null, a.id)).data), 'a');
  await handlers.get('files:organize')(null, { id: child.id, parentId: null });
  rows = await handlers.get('files:list')();
  assert.equal(rows.find(row => row.id === a.id).parentId, child.id);
  assert.equal(rows.find(row => row.id === child.id).parentId, null);
  assert.equal(String((await handlers.get('files:read')(null, a.id)).data), 'a');
  await handlers.get('files:organize')(null, { id: a.id, beforeId: folder.id });
  assert.equal((await handlers.get('files:list')()).find(row => row.id === a.id).parentId, null);
});

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

test('file library creates nested folders, imports a directory tree, and deletes its subtree', async t => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-library-tree-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-library-source-'));
  t.after(() => fs.rm(source, { recursive: true, force: true }));
  await fs.mkdir(path.join(source, 'chapter', 'empty'), { recursive: true });
  await fs.writeFile(path.join(source, 'chapter', 'lesson.txt'), 'lesson');
  const handlers = new Map();
  registerLibraryIpc({
    app: { getPath: () => tempRoot },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [source] }) },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    userDataPath: tempRoot,
    getMainWindow: () => null
  });

  const parent = await handlers.get('files:create-folder')(null, { name: '课程' });
  await handlers.get('files:import-folder')(null, parent.id);
  const rows = await handlers.get('files:list')();
  const importedRoot = rows.find(row => row.name === path.basename(source));
  const chapter = rows.find(row => row.name === 'chapter');
  const empty = rows.find(row => row.name === 'empty');
  const lesson = rows.find(row => row.name === 'lesson.txt');
  assert.equal(importedRoot.parentId, parent.id);
  assert.equal(chapter.parentId, importedRoot.id);
  assert.equal(empty.parentId, chapter.id);
  assert.equal(lesson.parentId, chapter.id);
  assert.equal(String((await handlers.get('files:read')(null, lesson.id)).data), 'lesson');
  await assert.rejects(handlers.get('files:create-folder')(null, { name: 'bad', parentId: '../escape' }));
  assert.equal((await handlers.get('files:delete')(null, importedRoot.id)).ok, true);
  assert.deepEqual((await handlers.get('files:list')()).map(row => row.name), ['课程']);
});
