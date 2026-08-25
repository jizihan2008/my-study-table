'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { isPathInside, normalizeExtensionId } = require('./security');

const MANIFEST_FILE = 'manifest.json';
const MAIN_FILE = 'main.js';
const READABLE_FILES = new Set([MANIFEST_FILE, MAIN_FILE]);
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_MAIN_BYTES = 2 * 1024 * 1024;

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson(target, maxBytes = MAX_MANIFEST_BYTES) {
  const stat = await fs.stat(target);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('manifest 文件无效或过大');
  return JSON.parse(await fs.readFile(target, 'utf8'));
}

function validateManifest(manifest, expectedId) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('manifest 必须是对象');
  }
  const rawId = String(manifest.id || '').trim();
  const id = normalizeExtensionId(rawId);
  if (!id || id !== rawId) throw new Error('manifest 缺少合法 id');
  if (expectedId && id !== expectedId) throw new Error('manifest id 与目标扩展不一致');
  return id;
}

function validateTrashName(value) {
  const name = String(value || '');
  return /^[a-zA-Z0-9_-]+$/.test(name) ? name : '';
}

async function moveDirectory(source, destination) {
  try {
    await fs.rename(source, destination);
  } catch {
    await fs.cp(source, destination, { recursive: true, force: true, errorOnExist: false });
    await fs.rm(source, { recursive: true, force: true });
  }
}

function registerExtensionIpc({ dialog, ipcMain, shell, userDataPath, getMainWindow }) {
  const extensionsDir = path.join(userDataPath, 'extensions');
  const trashDir = path.join(extensionsDir, 'trash');
  const window = () => typeof getMainWindow === 'function' ? getMainWindow() : null;
  const ensureExtensionsDir = () => fs.mkdir(extensionsDir, { recursive: true });
  const ensureTrashDir = () => fs.mkdir(trashDir, { recursive: true });
  const extensionDir = id => {
    const safeId = normalizeExtensionId(id);
    if (!safeId) throw new Error('非法扩展 id');
    return path.join(extensionsDir, safeId);
  };

  ipcMain.handle('ext:list', async () => {
    await ensureExtensionsDir();
    const entries = (await fs.readdir(extensionsDir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name !== 'trash' && !entry.name.startsWith('.'));
    return Promise.all(entries.map(async entry => {
      const dir = path.join(extensionsDir, entry.name);
      let manifest = null;
      let error = null;
      try {
        manifest = await readJson(path.join(dir, MANIFEST_FILE));
        validateManifest(manifest, entry.name);
      } catch {
        manifest = null;
        error = 'manifest 解析失败或 id 与目录不一致';
      }
      const mainPath = path.join(dir, MAIN_FILE);
      let size = 0;
      let mtime = null;
      let hasMain = false;
      try {
        const stat = await fs.stat(mainPath);
        hasMain = stat.isFile();
        if (hasMain) {
          size = stat.size;
          mtime = stat.mtime.toISOString();
        }
      } catch {}
      return {
        id: entry.name,
        dir,
        manifest,
        hasMain,
        hasManifest: !!manifest,
        type: (manifest && manifest.type) || 'plugin',
        builtin: false,
        name: (manifest && manifest.name) || entry.name,
        version: (manifest && manifest.version) || '1.0.0',
        author: (manifest && manifest.author) || '',
        size,
        mtime,
        error
      };
    }));
  });

  ipcMain.handle('ext:read', async (_event, { id, file, filename } = {}) => {
    const name = String(file || filename || MAIN_FILE);
    if (!READABLE_FILES.has(name)) throw new Error('不允许读取该扩展文件');
    const limit = name === MANIFEST_FILE ? MAX_MANIFEST_BYTES : MAX_MAIN_BYTES;
    const target = path.join(extensionDir(id), name);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > limit) throw new Error('扩展文件无效或过大');
    return fs.readFile(target, 'utf8');
  });

  ipcMain.handle('ext:write', async (_event, { id, files } = {}) => {
    const safeId = normalizeExtensionId(id);
    if (!safeId || safeId !== String(id || '').trim()) throw new Error('非法扩展 id');
    if (!files || typeof files !== 'object') throw new Error('缺少扩展文件');
    if (files.manifest !== undefined) validateManifest(files.manifest, safeId);
    if (files.main !== undefined && Buffer.byteLength(String(files.main), 'utf8') > MAX_MAIN_BYTES) {
      throw new Error('main.js 超过 2MB 限制');
    }
    if (files.manifest !== undefined) {
      const serialized = JSON.stringify(files.manifest, null, 2);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('manifest 超过 256KB 限制');
    }
    const dir = extensionDir(safeId);
    await fs.mkdir(dir, { recursive: true });
    if (files.manifest !== undefined) {
      await fs.writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(files.manifest, null, 2), 'utf8');
    }
    if (files.main !== undefined) await fs.writeFile(path.join(dir, MAIN_FILE), String(files.main), 'utf8');
    return { ok: true, dir };
  });

  ipcMain.handle('ext:backup', async (_event, { id } = {}) => {
    const dir = extensionDir(id);
    if (!await pathExists(dir)) return { ok: false, reason: '扩展不存在' };
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const target = path.join(dir, 'backup', timestamp);
    await fs.mkdir(target, { recursive: true });
    const copied = [];
    for (const name of READABLE_FILES) {
      const source = path.join(dir, name);
      if (await pathExists(source)) {
        await fs.copyFile(source, path.join(target, name));
        copied.push(name);
      }
    }
    return { ok: true, backupPath: target, files: copied };
  });

  ipcMain.handle('ext:list-backups', async (_event, { id } = {}) => {
    const root = path.join(extensionDir(id), 'backup');
    if (!await pathExists(root)) return [];
    const entries = await fs.readdir(root, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const stat = await fs.stat(path.join(root, entry.name));
      result.push({ name: entry.name, mtime: stat.mtime.toISOString() });
    }
    return result.sort((a, b) => b.name.localeCompare(a.name));
  });

  ipcMain.handle('ext:restore', async (_event, { id, backupName } = {}) => {
    const dir = extensionDir(id);
    const root = path.join(dir, 'backup');
    const source = path.resolve(root, String(backupName || ''));
    if (!isPathInside(root, source) || !await pathExists(source)) return { ok: false, reason: '备份不存在或路径非法' };
    for (const name of READABLE_FILES) {
      const from = path.join(source, name);
      if (await pathExists(from)) await fs.copyFile(from, path.join(dir, name));
    }
    return { ok: true };
  });

  ipcMain.handle('ext:remove', async (_event, { id } = {}) => {
    const source = extensionDir(id);
    if (!await pathExists(source)) return { ok: true, trashed: false, reason: 'not-exists' };
    await ensureTrashDir();
    const prefix = normalizeExtensionId(id) + '-' + Date.now().toString(36);
    let name = prefix;
    if (await pathExists(path.join(trashDir, name))) name += '-' + Math.random().toString(36).slice(2, 6);
    try {
      await moveDirectory(source, path.join(trashDir, name));
      return { ok: true, trashed: true, trashDir: name };
    } catch (error) {
      return { ok: false, reason: String(error && error.message || error) };
    }
  });

  ipcMain.handle('ext:trash-list', async () => {
    await ensureTrashDir();
    const entries = (await fs.readdir(trashDir, { withFileTypes: true })).filter(entry => entry.isDirectory());
    const result = await Promise.all(entries.map(async entry => {
      const dir = path.join(trashDir, entry.name);
      let manifest = null;
      let error = null;
      try { manifest = await readJson(path.join(dir, MANIFEST_FILE)); } catch { error = 'manifest 解析失败'; }
      const match = entry.name.match(/^(.+)-([a-z0-9]{6,})(?:-[a-z0-9]+)?$/);
      const originalId = match ? match[1] : entry.name;
      let deletedAt = null;
      if (match) {
        const value = parseInt(match[2], 36);
        if (Number.isFinite(value)) deletedAt = new Date(value).toISOString();
      }
      return {
        id: (manifest && manifest.id) || originalId,
        trashDir: entry.name,
        manifest,
        hasMain: await pathExists(path.join(dir, MAIN_FILE)),
        error,
        deletedAt
      };
    }));
    return result.sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')));
  });

  ipcMain.handle('ext:trash-restore', async (_event, { trashDir: trashName } = {}) => {
    const safeName = validateTrashName(trashName);
    if (!safeName) return { ok: false, reason: '非法回收站目录名' };
    await ensureTrashDir();
    const source = path.join(trashDir, safeName);
    if (!await pathExists(source)) return { ok: false, reason: '回收站项不存在' };
    let manifest;
    try { manifest = await readJson(path.join(source, MANIFEST_FILE)); } catch { return { ok: false, reason: '回收站项缺少有效 manifest.json' }; }
    let id;
    try { id = validateManifest(manifest); } catch { return { ok: false, reason: 'manifest 缺少合法 id' }; }
    const destination = extensionDir(id);
    if (await pathExists(destination)) return { ok: false, reason: '扩展 ' + id + ' 已存在，请先卸载' };
    try {
      await moveDirectory(source, destination);
      return { ok: true, id };
    } catch (error) {
      return { ok: false, reason: String(error && error.message || error) };
    }
  });

  ipcMain.handle('ext:trash-purge', async (_event, { trashDir: trashName } = {}) => {
    const safeName = validateTrashName(trashName);
    if (!safeName) return { ok: false, reason: '非法回收站目录名' };
    await ensureTrashDir();
    await fs.rm(path.join(trashDir, safeName), { recursive: true, force: true });
    return { ok: true };
  });

  ipcMain.handle('ext:trash-empty', async () => {
    await ensureTrashDir();
    for (const entry of await fs.readdir(trashDir, { withFileTypes: true })) {
      await fs.rm(path.join(trashDir, entry.name), { recursive: true, force: true });
    }
    return { ok: true };
  });

  ipcMain.handle('ext:open-dir', async () => {
    await ensureExtensionsDir();
    await shell.openPath(extensionsDir);
    return true;
  });

  ipcMain.handle('ext:import', async (_event, { sourcePath } = {}) => {
    await ensureExtensionsDir();
    let source = String(sourcePath || '').trim();
    if (!source) {
      const result = await dialog.showOpenDialog(window(), {
        title: '选择要导入的扩展文件夹',
        properties: ['openDirectory']
      });
      if (result.canceled || !result.filePaths || !result.filePaths.length) return { ok: false, canceled: true };
      source = result.filePaths[0];
    }
    let stat;
    try { stat = await fs.stat(source); } catch { return { ok: false, reason: '来源目录不存在: ' + source }; }
    if (!stat.isDirectory()) return { ok: false, reason: '请选择含 manifest.json 和 main.js 的扩展文件夹' };
    let manifest;
    try { manifest = await readJson(path.join(source, MANIFEST_FILE)); } catch { return { ok: false, reason: '所选文件夹缺少有效的 manifest.json' }; }
    let id;
    try { id = validateManifest(manifest); } catch (error) { return { ok: false, reason: error.message }; }
    const destination = extensionDir(id);
    if (await pathExists(destination)) return { ok: false, reason: '扩展 ' + id + ' 已存在，可先卸载后再导入' };
    try {
      const mainSource = path.join(source, MAIN_FILE);
      const mainStat = await fs.stat(mainSource);
      if (!mainStat.isFile() || mainStat.size > MAX_MAIN_BYTES) throw new Error('main.js 不存在或超过 2MB 限制');
      await fs.mkdir(destination, { recursive: true });
      const safeManifest = { ...manifest, enabled: false, source: manifest.source || 'local-directory' };
      await fs.writeFile(path.join(destination, MANIFEST_FILE), JSON.stringify(safeManifest, null, 2), 'utf8');
      await fs.copyFile(mainSource, path.join(destination, MAIN_FILE));
      return { ok: true, id, dir: destination };
    } catch (error) {
      await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: '复制失败: ' + String(error && error.message || error) };
    }
  });

  return { extensionsDir, ensureExtensionsDir, extensionDir };
}

module.exports = {
  MAX_MAIN_BYTES,
  MAX_MANIFEST_BYTES,
  registerExtensionIpc,
  validateManifest
};
