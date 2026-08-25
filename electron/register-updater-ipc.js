'use strict';

function registerUpdaterIpc({ app, ipcMain, getMainWindow, loadUpdater = () => require('electron-updater').autoUpdater }) {
  let autoUpdater = null;
  let supported = false;
  let checking = false;

  function send(payload) {
    const window = typeof getMainWindow === 'function' ? getMainWindow() : null;
    if (window && !window.isDestroyed()) window.webContents.send('update:event', payload);
  }

  function init() {
    try {
      autoUpdater = loadUpdater();
    } catch (error) {
      console.error('[updater] electron-updater 加载失败:', error);
      supported = false;
      return;
    }

    const isPortableBuild = !!process.env.PORTABLE_EXECUTABLE_FILE;
    try {
      supported = app.isPackaged && !isPortableBuild &&
        typeof autoUpdater.isUpdaterActive === 'function' && autoUpdater.isUpdaterActive();
    } catch (_) {
      supported = false;
    }
    if (!supported) {
      send({ type: 'unsupported' });
      return;
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('checking-for-update', () => { checking = true; send({ type: 'checking' }); });
    autoUpdater.on('update-available', info => { checking = false; send({ type: 'available', info }); });
    autoUpdater.on('update-not-available', info => { checking = false; send({ type: 'not-available', info }); });
    autoUpdater.on('error', error => {
      checking = false;
      send({ type: 'error', message: String((error && error.message) || error) });
    });
    autoUpdater.on('download-progress', progress => send({
      type: 'progress',
      percent: Math.round(progress.percent || 0),
      transferred: progress.transferred || 0,
      total: progress.total || 0,
      bytesPerSecond: progress.bytesPerSecond || 0
    }));
    autoUpdater.on('update-downloaded', info => send({ type: 'downloaded', info }));
  }

  ipcMain.handle('update:get-state', async () => ({
    supported,
    currentVersion: app.getVersion(),
    checking
  }));

  ipcMain.handle('update:check', async () => {
    if (!supported || !autoUpdater) return { ok: false, reason: 'unsupported' };
    try { await autoUpdater.checkForUpdates(); return { ok: true }; }
    catch (error) { return { ok: false, reason: String((error && error.message) || error) }; }
  });

  ipcMain.handle('update:download', async () => {
    if (!supported || !autoUpdater) return { ok: false, reason: 'unsupported' };
    try { await autoUpdater.downloadUpdate(); return { ok: true }; }
    catch (error) { return { ok: false, reason: String((error && error.message) || error) }; }
  });

  ipcMain.handle('update:install', async () => {
    if (!supported || !autoUpdater) return { ok: false, reason: 'unsupported' };
    try { autoUpdater.quitAndInstall(false, true); return { ok: true }; }
    catch (error) { return { ok: false, reason: String((error && error.message) || error) }; }
  });

  return { init };
}

module.exports = { registerUpdaterIpc };
