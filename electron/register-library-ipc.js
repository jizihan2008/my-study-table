'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { isPathInside, normalizeExtensionId } = require('./security');

const AUDIO_MIME = Object.freeze({
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.aac': 'audio/aac', '.m4a': 'audio/mp4', '.wma': 'audio/x-ms-wma'
});
const IMAGE_MIME = Object.freeze({
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml'
});

const FILE_LIBRARY_PREFIX = 'file_';
const FOLDER_LIBRARY_PREFIX = 'folder_';
const { randomUUID } = require('node:crypto');

function safeLibraryName(value) {
  const cleaned = path.basename(String(value || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return (cleaned || 'file').slice(0, 180);
}

function registerLibraryIpc({ app, dialog, ipcMain, userDataPath, getMainWindow }) {
  const booksCacheDir = path.join(userDataPath, 'books');
  const fileLibraryDir = path.join(userDataPath, 'files');
  const window = () => typeof getMainWindow === 'function' ? getMainWindow() : null;

  function libraryTarget(parent, id, name) {
    if (!/^(file|folder)_[a-zA-Z0-9-]+$/.test(String(id || ''))) return null;
    const target = path.join(parent, id + '__' + safeLibraryName(name));
    return isPathInside(fileLibraryDir, target) ? target : null;
  }

  async function scanLibrary(dir = fileLibraryDir, parentId = null, rows = [], paths = new Map()) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return { rows, paths }; throw error; }
    for (const entry of entries) {
      const match = /^(file|folder)_[a-zA-Z0-9-]+__/.exec(entry.name);
      if (!match) continue;
      const kind = match[1];
      if (kind === 'file' ? !entry.isFile() : !entry.isDirectory()) continue;
      const target = path.join(dir, entry.name);
      if (!isPathInside(fileLibraryDir, target)) continue;
      const id = entry.name.slice(0, entry.name.indexOf('__'));
      const stat = await fs.stat(target);
      rows.push({ id, kind, parentId, name: entry.name.slice(entry.name.indexOf('__') + 2), size: kind === 'file' ? stat.size : 0, type: '', createdAt: stat.birthtimeMs || stat.mtimeMs });
      paths.set(id, target);
      if (kind === 'folder') await scanLibrary(target, id, rows, paths);
    }
    return { rows, paths };
  }

  async function parentPath(parentId) {
    if (!parentId) return fileLibraryDir;
    if (!/^folder_[a-zA-Z0-9-]+$/.test(String(parentId))) throw new Error('无效的文件夹');
    const { paths } = await scanLibrary();
    const target = paths.get(parentId);
    if (!target) throw new Error('文件夹不存在');
    return target;
  }

  async function addFolder(parent, name) {
    const id = FOLDER_LIBRARY_PREFIX + randomUUID();
    const target = libraryTarget(parent, id, name);
    await fs.mkdir(target);
    return { id, kind: 'folder', name: safeLibraryName(name) };
  }

  async function importDirectory(source, parent) {
    const folder = await addFolder(parent, path.basename(source));
    const target = libraryTarget(parent, folder.id, folder.name);
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
      const child = path.join(source, entry.name);
      if (entry.isDirectory()) await importDirectory(child, target);
      else if (entry.isFile()) {
        const id = FILE_LIBRARY_PREFIX + randomUUID();
        await fs.copyFile(child, libraryTarget(target, id, entry.name));
      }
    }
    return folder;
  }

  ipcMain.handle('files:create-folder', async (_event, payload = {}) => {
    const name = String(payload.name || '').trim();
    if (!name || name === '.' || name === '..') throw new Error('请输入文件夹名称');
    await fs.mkdir(fileLibraryDir, { recursive: true });
    return addFolder(await parentPath(payload.parentId), name);
  });

  ipcMain.handle('files:import-folder', async (_event, parentId) => {
    await fs.mkdir(fileLibraryDir, { recursive: true });
    const parent = await parentPath(parentId);
    const result = await dialog.showOpenDialog(window(), { title: '导入文件夹到文件库', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths.length) return [];
    const source = await fs.realpath(result.filePaths[0]);
    const libraryRoot = await fs.realpath(fileLibraryDir);
    if (source === libraryRoot || isPathInside(source, libraryRoot) || isPathInside(libraryRoot, source)) throw new Error('不能导入文件库所在的文件夹');
    return [await importDirectory(source, parent)];
  });

  ipcMain.handle('files:import', async (_event, parentId) => {
    const result = await dialog.showOpenDialog(window(), { title: '导入到文件库', properties: ['openFile', 'multiSelections'] });
    if (result.canceled) return [];
    await fs.mkdir(fileLibraryDir, { recursive: true });
    const parent = await parentPath(parentId);
    const imported = [];
    for (const source of result.filePaths) {
      const id = FILE_LIBRARY_PREFIX + randomUUID();
      const name = safeLibraryName(source);
      const target = libraryTarget(parent, id, name);
      await fs.copyFile(source, target);
      const stat = await fs.stat(target);
      imported.push({ id, kind: 'file', parentId: parentId || null, name, size: stat.size, type: '', createdAt: stat.birthtimeMs || stat.mtimeMs });
    }
    return imported;
  });

  ipcMain.handle('files:import-data', async (_event, payload, parentId) => {
    const files = Array.isArray(payload) ? payload.slice(0, 100) : [];
    await fs.mkdir(fileLibraryDir, { recursive: true });
    const parent = await parentPath(parentId);
    const imported = [];
    for (const item of files) {
      const data = item && item.data;
      if (!data || typeof data.byteLength !== 'number' || data.byteLength > 512 * 1024 * 1024) continue;
      const id = FILE_LIBRARY_PREFIX + randomUUID();
      const name = safeLibraryName(item.name);
      const target = libraryTarget(parent, id, name);
      await fs.writeFile(target, Buffer.from(data));
      const stat = await fs.stat(target);
      imported.push({ id, kind: 'file', parentId: parentId || null, name, size: stat.size, type: String(item.type || ''), createdAt: stat.birthtimeMs || stat.mtimeMs });
    }
    return imported;
  });

  ipcMain.handle('files:list', async () => {
    try {
      await fs.mkdir(fileLibraryDir, { recursive: true });
      const { rows } = await scanLibrary();
      return rows.sort((a, b) => b.createdAt - a.createdAt);
    } catch (_) { return []; }
  });

  async function findLibraryFile(id) {
    if (!/^file_[a-zA-Z0-9-]+$/.test(String(id || ''))) return null;
    return (await scanLibrary()).paths.get(id) || null;
  }

  ipcMain.handle('files:read', async (_event, id) => {
    const target = await findLibraryFile(id);
    if (!target) return null;
    return { name: path.basename(target).split('__').slice(1).join('__'), data: await fs.readFile(target) };
  });

  ipcMain.handle('files:open', async (_event, id) => {
    const target = await findLibraryFile(id);
    if (!target) return { ok: false, reason: '文件不存在' };
    const reason = await require('electron').shell.openPath(target);
    return reason ? { ok: false, reason } : { ok: true };
  });

  ipcMain.handle('files:show-dir', async (_event, folderId) => {
    await fs.mkdir(fileLibraryDir, { recursive: true });
    const reason = await require('electron').shell.openPath(await parentPath(folderId));
    return reason ? { ok: false, reason } : { ok: true };
  });

  ipcMain.handle('files:delete', async (_event, id) => {
    if (!/^(file|folder)_[a-zA-Z0-9-]+$/.test(String(id || ''))) return { ok: false, reason: '无效的项目' };
    const target = (await scanLibrary()).paths.get(id);
    if (!target) return { ok: false, reason: '文件不存在' };
    await fs.rm(target, { recursive: true, force: true });
    return { ok: true };
  });

  ipcMain.handle('open-audio-dialog', async () => {
    const result = await dialog.showOpenDialog(window(), {
      title: '选择音频文件',
      filters: [
        { name: '音频文件', extensions: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile', 'multiSelections']
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('open-image-dialog', async () => {
    const result = await dialog.showOpenDialog(window(), {
      title: '选择背景图片',
      filters: [
        { name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    try {
      const filePath = result.filePaths[0];
      const mime = IMAGE_MIME[path.extname(filePath).toLowerCase()];
      if (!mime) return null;
      const buffer = await fs.readFile(filePath);
      const value = { dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
      if (buffer.length > 6 * 1024 * 1024) value.warning = '图片较大（>6MB），可能影响性能';
      return value;
    } catch (error) {
      console.error('读取图片失败:', error);
      return null;
    }
  });

  ipcMain.handle('open-video-dialog', async () => {
    const result = await dialog.showOpenDialog(window(), {
      title: '选择背景视频',
      filters: [
        { name: '视频文件', extensions: ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return { fileUrl: new URL('file:///' + result.filePaths[0].replace(/\\/g, '/')).href };
  });

  ipcMain.handle('get-downloads-path', async () => app.getPath('downloads'));

  ipcMain.handle('read-audio-file', async (_event, filePath) => {
    try {
      const mime = AUDIO_MIME[path.extname(String(filePath || '')).toLowerCase()];
      if (!mime) return null;
      const buffer = await fs.readFile(String(filePath));
      return `data:${mime};base64,${buffer.toString('base64')}`;
    } catch (error) {
      console.error('Failed to read audio file:', error);
      return null;
    }
  });

  ipcMain.handle('pdf:pick', async () => {
    const result = await dialog.showOpenDialog(window(), {
      title: '选择教材 PDF',
      filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
      properties: ['openFile']
    });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });

  ipcMain.handle('pdf:read', async (_event, filePath) => {
    try {
      if (path.extname(String(filePath || '')).toLowerCase() !== '.pdf') return null;
      return await fs.readFile(String(filePath));
    } catch (error) {
      console.error('Failed to read PDF file:', error);
      return null;
    }
  });

  function bookCachePath(bookId) {
    const safeId = normalizeExtensionId(bookId);
    if (!safeId) return null;
    const target = path.join(booksCacheDir, safeId + '.json');
    return isPathInside(booksCacheDir, target) ? target : null;
  }

  ipcMain.handle('books:text-save', async (_event, payload = {}) => {
    try {
      const target = bookCachePath(payload.bookId);
      if (!target) return { ok: false, reason: '非法 bookId' };
      await fs.mkdir(booksCacheDir, { recursive: true });
      const content = typeof payload.data === 'string' ? payload.data : JSON.stringify(payload.data);
      await fs.writeFile(target, content, 'utf8');
      return { ok: true, path: target };
    } catch (error) {
      return { ok: false, reason: String((error && error.message) || error) };
    }
  });

  ipcMain.handle('books:text-load', async (_event, payload = {}) => {
    try {
      const target = bookCachePath(payload.bookId);
      if (!target) return null;
      return await fs.readFile(target, 'utf8');
    } catch (_) {
      return null;
    }
  });

  ipcMain.handle('books:text-delete', async (_event, payload = {}) => {
    try {
      const target = bookCachePath(payload.bookId);
      if (!target) return { ok: false };
      await fs.rm(target, { force: true });
      return { ok: true };
    } catch (_) {
      return { ok: false };
    }
  });
}

module.exports = { AUDIO_MIME, IMAGE_MIME, registerLibraryIpc };
