'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { sanitizeBackupData } = require('./backup-policy');

function registerBackupIpc({ ipcMain, shell, userDataPath }) {
  const backupDir = path.join(userDataPath, 'backups');

  async function ensureBackupDir() {
    await fs.mkdir(backupDir, { recursive: true });
  }

  async function listBackupNames() {
    await ensureBackupDir();
    return (await fs.readdir(backupDir))
      .filter(name => name.startsWith('backup-') && name.endsWith('.json'))
      .sort();
  }

  ipcMain.handle('open-backup-dir', async () => {
    await ensureBackupDir();
    await shell.openPath(backupDir);
    return true;
  });

  ipcMain.handle('get-backup-dir', async () => {
    await ensureBackupDir();
    return backupDir;
  });

  ipcMain.handle('perform-backup', async (_event, payload = {}) => {
    await ensureBackupDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filePath = path.join(backupDir, `backup-${timestamp}.json`);
    const safeData = sanitizeBackupData(payload.data, { includeSecrets: payload.includeSecrets === true });
    await fs.writeFile(filePath, JSON.stringify(safeData, null, 2), 'utf8');

    let names = await listBackupNames();
    const limit = Math.min(Math.max(Number(payload.maxFiles) || 30, 1), 365);
    let deletedCount = 0;
    for (const name of names.slice(0, Math.max(0, names.length - limit))) {
      try {
        await fs.unlink(path.join(backupDir, name));
        deletedCount += 1;
      } catch (_) { /* best effort retention */ }
    }
    names = await listBackupNames();
    return { path: filePath, totalFiles: names.length, deleted: deletedCount };
  });

  ipcMain.handle('list-backups', async () => {
    const names = (await listBackupNames()).reverse();
    const rows = await Promise.all(names.map(async name => {
      try {
        const stat = await fs.stat(path.join(backupDir, name));
        return { name, size: stat.size, mtime: stat.mtime.toISOString() };
      } catch (_) {
        return null;
      }
    }));
    return rows.filter(Boolean);
  });
}

module.exports = { registerBackupIpc };
