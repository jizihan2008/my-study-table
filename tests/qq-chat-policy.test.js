'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { isPathInside } = require('../electron/security');
const { resolveQQChatChunks } = require('../electron/qq-chat-policy');

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mst-qq-policy-'));
  const chunks = path.join(root, 'chunks');
  await fsp.mkdir(chunks);
  await fsp.writeFile(path.join(chunks, 'part-1.jsonl'), '{"id":1}\n', 'utf8');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

function resolve(root, manifest, limits = {}) {
  return resolveQQChatChunks({
    exportRoot: root,
    manifest,
    fs,
    path,
    isPathInside,
    maxChunkBytes: limits.maxChunkBytes || 1024,
    maxTotalBytes: limits.maxTotalBytes || 4096
  });
}

test('QQ manifest accepts ordinary JSONL chunks inside the selected folder', async t => {
  const root = await fixture(t);
  const result = await resolve(root, { chunked: { chunksDir: 'chunks', chunks: [{ relativePath: 'chunks/part-1.jsonl' }] } });
  assert.equal(result.chunkFiles.length, 1);
  assert.equal(path.basename(result.chunkFiles[0]), 'part-1.jsonl');
});

test('QQ manifest rejects traversal and non-JSONL files', async t => {
  const root = await fixture(t);
  await fsp.writeFile(path.join(root, 'outside.jsonl'), '{}\n', 'utf8');
  await assert.rejects(
    resolve(root, { chunked: { chunksDir: 'chunks', chunks: [{ relativePath: 'outside.jsonl' }] } }),
    /chunks 目录内/
  );
  await assert.rejects(
    resolve(root, { chunked: { chunksDir: 'chunks', chunks: [{ relativePath: 'chunks/notes.txt' }] } }),
    /\.jsonl/
  );
});

test('QQ manifest enforces per-chunk and total size limits', async t => {
  const root = await fixture(t);
  await assert.rejects(
    resolve(root, { chunked: { chunksDir: 'chunks', chunks: [{ relativePath: 'chunks/part-1.jsonl' }] } }, { maxChunkBytes: 2 }),
    /32 MB/
  );
});
