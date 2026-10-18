'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { extractImages } = require('../lib/qq-chat-media');
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

function createQQChatMedia({ cacheDir, getRoots, nativeImage }) {
  const pending = new Map();
  const keyOf = image => crypto.createHash('sha256').update(JSON.stringify([image.filename || '', image.md5 || '', image.localPath || '', image.url || ''])).digest('hex');
  function inside(root, file) { const rel = path.relative(root, file); return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); }
  async function validate(buffer) {
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error('图片为空或超过 32 MB');
    const decoded = nativeImage.createFromBuffer(buffer);
    if (decoded.isEmpty()) throw new Error('图片格式无法解码');
    return decoded;
  }
  async function locate(image, extraRoots) {
    const roots = extraRoots.concat(await getRoots());
    for (const root of roots.filter(Boolean)) {
      let realRoot;
      try { realRoot = await fs.realpath(root); } catch { continue; }
      for (const ref of [image.localPath, image.url, image.filename]) {
        if (!ref || /^(?:https?:|file:|data:)/i.test(ref)) continue;
        const candidate = path.resolve(realRoot, ref.replace(/\\/g, '/'));
        try {
          const real = await fs.realpath(candidate);
          if (!inside(realRoot, real)) continue;
          const stat = await fs.stat(real);
          if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) continue;
          return await fs.readFile(real);
        } catch { /* Another resource root may contain the image. */ }
      }
    }
    throw new Error('原图缺失；请保留 QCE 资源目录后重新补导图片');
  }
  async function ensure(image, extraRoots = []) {
    const requestKey = keyOf(image) + JSON.stringify(extraRoots);
    if (pending.has(requestKey)) return pending.get(requestKey);
    const task = (async () => {
      if (/^[a-f0-9]{64}$/.test(image.cacheKey || '')) {
        try { await fs.access(path.join(cacheDir, image.cacheKey + '.image')); return { cacheKey: image.cacheKey }; } catch {}
      }
      let buffer;
      const dataUrl = image.dataUrl || image.url || '';
      if (/^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]+$/i.test(dataUrl)) {
        if (dataUrl.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 1024) throw new Error('图片超过 32 MB');
        buffer = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      } else buffer = await locate(image, extraRoots);
      await validate(buffer);
      // Content addressing prevents same-name files from different exports being confused.
      const key = crypto.createHash('sha256').update(buffer).digest('hex');
      const file = path.join(cacheDir, key + '.image');
      await fs.mkdir(cacheDir, { recursive: true });
      try { await fs.access(file); return { cacheKey: key }; } catch {}
      const temporary = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
      try {
        await fs.writeFile(temporary, buffer);
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      return { cacheKey: key };
    })();
    pending.set(requestKey, task);
    try { return await task; } finally { pending.delete(requestKey); }
  }
  async function read(image, maxEdge) {
    let key = /^[a-f0-9]{64}$/.test(image.cacheKey || '') ? image.cacheKey : '';
    let buffer;
    if (key) { try { buffer = await fs.readFile(path.join(cacheDir, key + '.image')); } catch {} }
    if (!buffer) { key = (await ensure(image)).cacheKey; buffer = await fs.readFile(path.join(cacheDir, key + '.image')); }
    let decoded = await validate(buffer);
    const size = decoded.getSize();
    const edge = Math.max(0, Math.min(2048, Number(maxEdge) || 0));
    if (edge && Math.max(size.width, size.height) > edge) {
      decoded = decoded.resize(size.width >= size.height ? { width: edge } : { height: edge });
    }
    let dataUrl = decoded.toDataURL();
    if (!edge) {
      const mime = buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' ? 'image/png'
        : buffer[0] === 0xff && buffer[1] === 0xd8 ? 'image/jpeg'
        : buffer.subarray(0, 3).toString() === 'GIF' ? 'image/gif'
        : buffer.subarray(8, 12).toString() === 'WEBP' ? 'image/webp'
        : buffer.subarray(0, 2).toString() === 'BM' ? 'image/bmp' : '';
      if (mime) dataUrl = 'data:' + mime + ';base64,' + buffer.toString('base64');
    }
    return { cacheKey: key, width: size.width, height: size.height, dataUrl };
  }
  async function prepareExport(json, extraRoots = []) {
    let cached = 0, missing = 0;
    for (const message of json.messages || []) {
      const images = extractImages(message);
      if (!images.length) continue;
      for (const image of images) {
        try { Object.assign(image, await ensure(image, extraRoots)); cached++; }
        catch (error) { image.error = String(error.message || error); missing++; }
      }
      message.images = images;
    }
    return { cached, missing };
  }
  return { ensure, read, prepareExport };
}
module.exports = { createQQChatMedia, MAX_IMAGE_BYTES };
