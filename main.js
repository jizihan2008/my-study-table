const { app, BrowserWindow, ipcMain, Notification, shell, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// 屏蔽 Qt/log4cplus 等系统级无关警告
process.env.QT_LOGGING_RULES = '*.debug=false;*.warning=false';
process.env.QT_LOGGING_CONF = '';

// 设置固定的用户数据目录，避免默认路径权限问题
const userDataPath = path.join(app.getPath('home'), '.my-study-table');
app.setPath('userData', userDataPath);

// 禁用 GPU 缓存（解决 cache_util_win 拒绝访问错误）
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-gpu-program-cache');

let mainWindow;
let tray = null;
let isQuitting = false;

function createTray() {
  // 使用原生图标创建一个 16x16 的托盘图标
  const iconPath = path.join(__dirname, 'tray-icon.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    // 如果图片加载失败，创建一个简单的纯色图标
    if (trayIcon.isEmpty()) {
      trayIcon = nativeImage.createEmpty();
    }
  } catch (e) {
    trayIcon = nativeImage.createEmpty();
  }

  // 如果无法加载自定义图标，创建一个简单的程序化图标
  if (trayIcon.isEmpty()) {
    // 用 Canvas 方式不可行，直接用 resize 一个小尺寸的内置图标
    // 使用 app 图标作为后备
    trayIcon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAbwAAAG8B8aLcQwAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAEYSURBVFiF7ZY9bsJAEIXfLKVSpEiRIkWKFCnSpYhSpUjlK3ABjkDFCbgA3CBSpEiRIkWKFCnSpYgSJYqUIpD3SbO7sLbBm6c8abQ7O/Nm9nu7QgjBBjW8or3D9kCiUWBfAUQSeAio+yngI6BOBewIKAo4EdYC9wG1uSPgUUBVwLGAPQF3Am4FHAjYEXAjoEXAuYBNgM2ApYB5QDuBNEAjoI3AOAJ6AjoC2gg8joCzFwF3I6AnoCOgjcCTCPC/YuO/EK8esBDQElAWcCxgIuBDQB/Ai/43oIKvx7/fgLiidP8sR6OAHQE1AdWcCFgTUBVQFrAkoCigIKAmYJtAFW+9p3X+L9qFABXBB4JaHrZCFSOVAAAAAElFTkSuQmCC'
    );
  }

  tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));
  tray.setToolTip('My Study Table');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出应用',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  // 双击托盘图标显示窗口
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'My Study Table',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    autoHideMenuBar: true,
    show: false
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 点击关闭按钮时隐藏到托盘，而不是退出
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createTray();
  createWindow();
  initAutoUpdater();
});

app.on('window-all-closed', () => {
  // 不退出应用，保持在托盘中运行
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

// 确保真正退出时清理托盘
app.on('before-quit', () => {
  isQuitting = true;
});

// IPC: 桌面通知
ipcMain.handle('show-notification', async (event, { title, body }) => {
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body });
    notification.show();
    return true;
  }
  return false;
});

// IPC: 用默认浏览器（Edge）打开外部链接
ipcMain.handle('open-external', async (event, url) => {
  try {
    await shell.openExternal(url);
    return true;
  } catch (err) {
    console.error('Failed to open URL:', err);
    return false;
  }
});

// IPC: 完全退出应用
ipcMain.handle('quit-app', async () => {
  isQuitting = true;
  app.quit();
  return true;
});

// IPC: 聚焦主窗口（解决 confirm 弹窗后焦点丢失问题）
ipcMain.handle('focus-window', async () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.focus();
    return true;
  }
  return false;
});

// IPC: 打开音频文件选择对话框
ipcMain.handle('open-audio-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择音频文件',
    filters: [
      { name: '音频文件', extensions: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['openFile', 'multiSelections']
  });
  if (result.canceled) return [];
  return result.filePaths;
});

// IPC: 打开图片文件选择对话框（返回 Data URL）
ipcMain.handle('open-image-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
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
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml'
    };
    const mime = mimeMap[ext] || 'image/png';
    const buffer = await fs.promises.readFile(filePath);
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    // Warn if too large (>8MB in base64 ≈ 6MB original)
    if (buffer.length > 6 * 1024 * 1024) {
      return { dataUrl, warning: '图片较大（>6MB），可能影响性能' };
    }
    return { dataUrl };
  } catch (err) {
  console.error('读取图片失败:', err);
  return null;
  }
});

// IPC: 打开视频文件选择对话框（返回文件路径）
ipcMain.handle('open-video-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择背景视频',
    filters: [
      { name: '视频文件', extensions: ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  try {
    const filePath = result.filePaths[0];
    // Return as file:// URL for video element
    const fileUrl = 'file:///' + filePath.replace(/\\/g, '/');
    return { fileUrl };
  } catch (err) {
    console.error('读取视频文件失败:', err);
    return null;
  }
});

// ═══════════ File-based Backup System ═══════════
const backupDir = path.join(userDataPath, 'backups');

// Ensure backup directory exists
function ensureBackupDir() {
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
}

// IPC: 打开备份目录
ipcMain.handle('open-backup-dir', async () => {
  ensureBackupDir();
  await shell.openPath(backupDir);
  return true;
});

// IPC: 获取备份目录路径
ipcMain.handle('get-backup-dir', async () => {
  ensureBackupDir();
  return backupDir;
});

// IPC: 执行一次文件备份
// Receives all localStorage data from renderer, writes to a file
ipcMain.handle('perform-backup', async (event, { data, maxFiles }) => {
  ensureBackupDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `backup-${timestamp}.json`;
  const filePath = path.join(backupDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');

  // Enforce max file count: delete oldest files if over limit
  let files = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
    .sort(); // alphabetical = chronological order

  const limit = Math.max(Number(maxFiles) || 30, 1);
  let deletedCount = 0;
  while (files.length > limit) {
    const oldest = files[0];
    try { fs.unlinkSync(path.join(backupDir, oldest)); deletedCount++; } catch (e) {}
    files = files.slice(1); // Remove first element (already deleted)
  }

  // Re-read the actual directory to get accurate count
  const finalFiles = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
    .length;

  return {
    path: filePath,
    totalFiles: finalFiles,
    deleted: deletedCount
  };
});

// IPC: 获取备份文件列表
ipcMain.handle('list-backups', async () => {
  ensureBackupDir();
  const files = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
    .sort()
    .reverse();
  return files.map(f => {
    const filePath = path.join(backupDir, f);
    try {
      const stat = fs.statSync(filePath);
      return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
    } catch { return null; }
  }).filter(Boolean);
});

// IPC: 获取下载目录路径
ipcMain.handle('get-downloads-path', async () => {
  return app.getPath('downloads');
});

// IPC: 读取文件为 base64 Data URL
ipcMain.handle('read-audio-file', async (event, filePath) => {
  try {
    // 先校验扩展名白名单再读盘，避免渲染层传入任意路径读取本地文件
    const ext = path.extname(String(filePath)).toLowerCase();
    const mimeMap = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.flac': 'audio/flac',
      '.aac': 'audio/aac',
      '.m4a': 'audio/mp4',
      '.wma': 'audio/x-ms-wma'
    };
    const mime = mimeMap[ext];
    if (!mime) return null;
    const buffer = await fs.promises.readFile(filePath);
    const base64 = buffer.toString('base64');
    return `data:${mime};base64,${base64}`;
  } catch (err) {
    console.error('Failed to read audio file:', err);
    return null;
  }
});

// ═══════════ Auto Updater ═══════════
let autoUpdater = null;
let updaterSupported = false;
let updaterChecking = false;

// 转发更新事件到渲染进程
function sendUpdateEvent(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:event', payload);
  }
}

function initAutoUpdater() {
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.error('[updater] electron-updater 加载失败:', err);
    updaterSupported = false;
    return;
  }
  // 仅在打包的 NSIS 安装版中可用；开发模式 / portable / zip 解压版不支持
  // electron-builder 打包 portable 时会设置 PORTABLE_EXECUTABLE_FILE 环境变量
  const isPortableBuild = !!process.env.PORTABLE_EXECUTABLE_FILE;
  try {
    updaterSupported = app.isPackaged && !isPortableBuild && typeof autoUpdater.isUpdaterActive === 'function' && autoUpdater.isUpdaterActive();
  } catch (err) {
    updaterSupported = false;
  }
  if (!updaterSupported) {
    // 通知渲染层：当前版本不支持自动更新，只提供手动下载提示
    sendUpdateEvent({ type: 'unsupported' });
    return;
  }

  autoUpdater.autoDownload = false; // 由渲染层确认后手动下载
  autoUpdater.autoInstallOnAppQuit = false; // 等用户点击后安装

  autoUpdater.on('checking-for-update', () => {
    updaterChecking = true;
    sendUpdateEvent({ type: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    updaterChecking = false;
    sendUpdateEvent({ type: 'available', info });
  });
  autoUpdater.on('update-not-available', (info) => {
    updaterChecking = false;
    sendUpdateEvent({ type: 'not-available', info });
  });
  autoUpdater.on('error', (err) => {
    updaterChecking = false;
    sendUpdateEvent({ type: 'error', message: String((err && err.message) || err) });
  });
  autoUpdater.on('download-progress', (progressObj) => {
    sendUpdateEvent({
      type: 'progress',
      percent: Math.round(progressObj.percent || 0),
      transferred: progressObj.transferred || 0,
      total: progressObj.total || 0,
      bytesPerSecond: progressObj.bytesPerSecond || 0
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateEvent({ type: 'downloaded', info });
  });
}

// IPC: 查询更新支持状态
ipcMain.handle('update:get-state', async () => {
  return {
    supported: updaterSupported,
    currentVersion: app.getVersion(),
    checking: updaterChecking
  };
});

// IPC: 触发检查更新
ipcMain.handle('update:check', async () => {
  if (!updaterSupported || !autoUpdater) return { ok: false, reason: 'unsupported' };
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
});

// IPC: 开始下载更新
ipcMain.handle('update:download', async () => {
  if (!updaterSupported || !autoUpdater) return { ok: false, reason: 'unsupported' };
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
});

// IPC: 安装并重启（仅 NSIS 安装版）
ipcMain.handle('update:install', async () => {
  if (!updaterSupported || !autoUpdater) return { ok: false, reason: 'unsupported' };
  try {
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
});
