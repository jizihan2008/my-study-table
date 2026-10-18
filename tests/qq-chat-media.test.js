'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { extractImages, mergeImages } = require('../lib/qq-chat-media');
const { createQQChatMedia } = require('../electron/qq-chat-media');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=', 'base64');
const nativeImage = { createFromBuffer(buffer) { return { isEmpty: () => !buffer.equals(png), getSize: () => ({ width: 1, height: 1 }), toDataURL: () => 'data:image/png;base64,' + buffer.toString('base64') }; } };

test('QCE resources and image elements merge without dropping image metadata', () => {
  const images = extractImages({ content: { resources: [{ type: 'image', filename: 'PHOTO.png', localPath: 'images/photo.png', width: 800 }], elements: [{ type: 'image', data: { filename: 'PHOTO.png', md5: 'abc', url: 'resources/images/photo.png' } }, { type: 'text', data: { text: 'text' } }] } });
  assert.equal(images.length, 1);
  assert.equal(images[0].localPath, 'images/photo.png');
  assert.equal(images[0].md5, 'abc');
  assert.equal(images[0].width, 800);
  const updated = mergeImages([{ ...images[0], error: 'missing' }], [{ filename: 'PHOTO.png', cacheKey: 'cache' }]);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].cacheKey, 'cache');
  assert.equal(updated[0].error, undefined);
});

test('media survives source deletion and a new service instance', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-qq-media-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await fs.mkdir(path.join(source, 'images'), { recursive: true });
  await fs.writeFile(path.join(source, 'images', 'photo.png'), png);
  const options = { cacheDir: path.join(root, 'cache'), nativeImage, getRoots: async () => [source] };
  const service = createQQChatMedia(options);
  const exported = { messages: [{ content: { resources: [{ type: 'image', filename: 'photo.png', localPath: 'images/photo.png' }] } }] };
  assert.deepEqual(await service.prepareExport(exported), { cached: 1, missing: 0 });
  const image = exported.messages[0].images[0];
  assert.match(image.cacheKey, /^[a-f0-9]{64}$/);
  await fs.rm(source, { recursive: true, force: true });
  const restored = createQQChatMedia(options);
  assert.equal((await restored.read(image, 0)).dataUrl, 'data:image/png;base64,' + png.toString('base64'));
});

test('media rejects traversal, remote URLs and non-image files and reports missing files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-qq-media-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(root, 'outside.png'), png);
  await fs.writeFile(path.join(source, 'bad.png'), 'private text');
  const service = createQQChatMedia({ cacheDir: path.join(root, 'cache'), nativeImage, getRoots: async () => [source] });
  await assert.rejects(service.read({ localPath: '../outside.png' }, 0), /原图缺失/);
  await assert.rejects(service.read({ url: 'https://example.com/image.png' }, 0), /原图缺失/);
  await assert.rejects(service.read({ localPath: 'bad.png' }, 0), /无法解码/);
  const json = { messages: [{ content: { elements: [{ type: 'image', data: { filename: 'missing.png' } }] } }] };
  assert.deepEqual(await service.prepareExport(json), { cached: 0, missing: 1 });
  assert.match(json.messages[0].images[0].error, /原图缺失/);
});

test('same filenames in different validated export folders retain different bytes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-qq-media-names-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = path.join(root, 'chat-a');
  const b = path.join(root, 'chat-b');
  await fs.mkdir(a); await fs.mkdir(b);
  await fs.writeFile(path.join(a, 'photo.png'), png);
  await fs.writeFile(path.join(b, 'photo.png'), Buffer.concat([png, Buffer.from('different')]));
  const decoder = { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toDataURL: () => '' }) };
  const service = createQQChatMedia({ cacheDir: path.join(root, 'cache'), nativeImage: decoder, getRoots: async () => [] });
  const first = await service.ensure({ filename: 'photo.png' }, [a]);
  const second = await service.ensure({ filename: 'photo.png' }, [b]);
  assert.notEqual(first.cacheKey, second.cacheKey);
});
