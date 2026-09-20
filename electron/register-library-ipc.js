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

function safeLibraryName(value) {
  const cleaned = path.basename(String(value || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return (cleaned || 'file').slice(0, 180);
}

function registerLibraryIpc({ app, dialog, ipcMain, userDataPath, getMainWindow }) {
  const booksCacheDir = path.join(userDataPath, 'books');
  const fileLibraryDir = path.join(userDataPath, 'files');
  const window = () => typeof getMainWindow === 'function' ? getMainWindow() : null;

  function libraryTarget(id, name) {
    if (!/^file_[a-zA-Z0-9-]+$/.test(String(id || ''))) return null;
    const target = path.join(fileLibraryDir, id + '__' + safeLibraryName(name));
    return isPathInside(fileLibraryDir, target) ? target : null;
  }

  async function findLibraryFile(id) {
    if (!/^file_[a-zA-Z0-9-]+$/.test(String(id || ''))) return null;
    try {
      const entries = await fs.readdir(fileLibraryDir, { withFileTypes: true });
      const entry = entries.find(item => item.isFile() && item.name.startsWith(id + '__'));
      if (!entry) return null;
      const target = path.join(fileLibraryDir, entry.name);
      return isPathInside(fileLibraryDir, target) ? target : null;
    } catch (_) { return null; }
  }

  ipcMain.handle('files:import', async () => {
    const result = await dialog.showOpenDialog(window(), { title: '导入到文件库', properties: ['openFile', 'multiSelections'] });
    if (result.canceled) return [];
    await fs.mkdir(fileLibraryDir, { recursive: true });
    const imported = [];
    for (const source of result.filePaths) {
      const id = FILE_LIBRARY_PREFIX + require('node:crypto').randomUUID();
      const name = safeLibraryName(source);
      const target = libraryTarget(id, name);
      await fs.copyFile(source, target);
      const stat = await fs.stat(target);
      imported.push({ id, name, size: stat.size, type: '', createdAt: stat.birthtimeMs || stat.mtimeMs });
    }
    return imported;
  });

  ipcMain.handle('files:import-data', async (_event, payload) => {
    const files = Array.isArray(payload) ? payload.slice(0, 100) : [];
    await fs.mkdir(fileLibraryDir, { recursive: true });
    const imported = [];
    for (const item of files) {
      const data = item && item.data;
      if (!data || typeof data.byteLength !== 'number' || data.byteLength > 512 * 1024 * 1024) continue;
      const id = FILE_LIBRARY_PREFIX + require('node:crypto').randomUUID();
      const name = safeLibraryName(item.name);
      const target = libraryTarget(id, name);
      await fs.writeFile(target, Buffer.from(data));
      const stat = await fs.stat(target);
      imported.push({ id, name, size: stat.size, type: String(item.type || ''), createdAt: stat.birthtimeMs || stat.mtimeMs });
    }
    return imported;
  });

  ipcMain.handle('files:list', async () => {
    try {
      await fs.mkdir(fileLibraryDir, { recursive: true });
      const entries = await fs.readdir(fileLibraryDir, { withFileTypes: true });
      const rows = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith(FILE_LIBRARY_PREFIX) || !entry.name.includes('__')) continue;
        const split = entry.name.indexOf('__');
        const stat = await fs.stat(path.join(fileLibraryDir, entry.name));
        rows.push({ id: entry.name.slice(0, split), name: entry.name.slice(split + 2), size: stat.size, type: '', createdAt: stat.birthtimeMs || stat.mtimeMs });
      }
      return rows.sort((a, b) => b.createdAt - a.createdAt);
    } catch (_) { return []; }
  });

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

  ipcMain.handle('files:show-dir', async () => {
    await fs.mkdir(fileLibraryDir, { recursive: true });
    const reason = await require('electron').shell.openPath(fileLibraryDir);
    return reason ? { ok: false, reason } : { ok: true };
  });

  ipcMain.handle('files:delete', async (_event, id) => {
    const target = await findLibraryFile(id);
    if (!target) return { ok: false, reason: '文件不存在' };
    await fs.rm(target, { force: true });
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
