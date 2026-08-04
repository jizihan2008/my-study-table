const { app, BrowserWindow, ipcMain, Notification, shell, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

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

// ── Supabase 邮件确认回调本地服务器 ──
// Supabase 的确认链接默认跳转 http://localhost:3000。应用在本地监听 3000 端口，
// 让浏览器能打开一个友好的"注册成功"页面（而不是"无法访问此页面"）。
let confirmServer = null;

const CONFIRM_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>My Study Table — 确认完成</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, #f0f2f5, #e8ecf8); color: #1a1a2e;
  }
  .card {
    background: #fff; border-radius: 16px; padding: 40px 48px; max-width: 420px;
    box-shadow: 0 12px 40px rgba(79,110,247,0.15); text-align: center;
  }
  .icon { font-size: 52px; margin-bottom: 14px; }
  h1 { font-size: 20px; margin-bottom: 10px; }
  p { font-size: 14px; color: #6b7280; line-height: 1.8; }
  .tip {
    margin-top: 16px; padding: 10px 14px; background: #f0f2f5; border-radius: 8px;
    font-size: 12.5px; color: #4b5563;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #0f172a; color: #e2e8f0; }
    .card { background: #1e293b; }
    p { color: #94a3b8; }
    .tip { background: #0f172a; color: #cbd5e1; }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="icon" id="icon">✅</div>
    <h1 id="title">操作已完成</h1>
    <p id="desc">现在可以回到「My Study Table」应用，使用你的邮箱和密码登录了。</p>
    <div class="tip">如果应用没有反应，请重新打开应用并进入「好友」页面。</div>
  </div>
  <script>
    try {
      var h = location.hash || '';
      if (h.indexOf('type=signup') >= 0 || h.indexOf('type=invite') >= 0) {
        document.getElementById('icon').textContent = '🎉';
        document.getElementById('title').textContent = '注册成功！';
        document.getElementById('desc').textContent = '你的邮箱已验证，现在可以回到「My Study Table」应用，使用邮箱和密码登录。';
      } else if (h.indexOf('type=recovery') >= 0) {
        document.getElementById('icon').textContent = '🔑';
        document.getElementById('title').textContent = '密码重置链接已生效';
        document.getElementById('desc').textContent = '请回到「My Study Table」应用，在登录页完成密码重置。';
      } else if (h.indexOf('type=email_change') >= 0) {
        document.getElementById('icon').textContent = '📧';
        document.getElementById('title').textContent = '邮箱修改成功';
        document.getElementById('desc').textContent = '你的邮箱已更新，可以回到「My Study Table」应用继续使用。';
      } else if (h.indexOf('error') >= 0) {
        document.getElementById('icon').textContent = '⚠️';
        document.getElementById('title').textContent = '确认链接存在问题';
        document.getElementById('desc').textContent = '链接可能已过期或已被使用。请回到应用重新注册或发送确认邮件。';
      }
    } catch (e) {}
  <\/script>
</body>
</html>`;

// 启动本地确认页服务器（监听 3000 端口，端口被占用则静默跳过）
function startConfirmServer() {
  try {
    if (confirmServer) return;
    confirmServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(CONFIRM_PAGE_HTML);
    });
    confirmServer.on('error', () => { confirmServer = null; });
    confirmServer.listen(3000, '127.0.0.1');
  } catch (e) {
    confirmServer = null;
  }
}

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

// 单实例锁：若已有实例在运行（最小化到系统托盘），再次打开时激活已有窗口，而不是新开一个进程
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    createTray();
    createWindow();
    initAutoUpdater();
    startConfirmServer(); // 监听 localhost:3000 供 Supabase 确认链接回调
  });
}

app.on('window-all-closed', () => {
  // 不退出应用，保持在托盘中运行
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

// 确保真正退出时清理托盘与本地确认服务器
app.on('before-quit', () => {
  isQuitting = true;
  if (confirmServer) {
    try { confirmServer.close(); } catch (e) {}
    confirmServer = null;
  }
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

// ═══════════ Extension System ═══════════
// 外部扩展（安全插件 plugin / 源码补丁 patch）统一存放在 <userData>/extensions/<id>/
// 每个扩展目录：manifest.json + main.js + backup/<时间戳>（应用前自动备份）
const extensionsDir = path.join(userDataPath, 'extensions');

function ensureExtensionsDir() {
  if (!fs.existsSync(extensionsDir)) fs.mkdirSync(extensionsDir, { recursive: true });
}

// 规范化扩展 ID：仅允许字母数字与中划线，防止路径穿越
function safeExtId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function extDir(id) {
  return path.join(extensionsDir, safeExtId(id));
}

// 路径安全校验：target 必须位于 base 目录内
function isPathInside(base, target) {
  const rel = path.relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// IPC: 列出所有扩展（扫描目录 + 解析 manifest）
ipcMain.handle('ext:list', async () => {
  ensureExtensionsDir();
  const entries = fs.readdirSync(extensionsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    // 跳过软件内回收站目录与隐藏目录，避免被误认为扩展
    .filter(e => e.name !== 'trash' && !e.name.startsWith('.'));
  return entries.map(entry => {
    const dir = path.join(extensionsDir, entry.name);
    const manifestPath = path.join(dir, 'manifest.json');
    const mainPath = path.join(dir, 'main.js');
    let manifest = null;
    let error = null;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (e) {
      error = 'manifest 解析失败';
    }
    const hasMain = fs.existsSync(mainPath);
    let size = 0, mtime = null;
    if (hasMain) {
      try {
        const st = fs.statSync(mainPath);
        size = st.size;
        mtime = st.mtime.toISOString();
      } catch (e) {}
    }
    return {
      id: (manifest && manifest.id) || entry.name,
      dir,
      manifest,
      hasMain,
      size,
      mtime,
      error
    };
  });
});

// IPC: 读取扩展内文件（白名单：仅扩展目录内部）
ipcMain.handle('ext:read', async (event, { id, file }) => {
  const dir = extDir(id);
  const target = path.resolve(dir, String(file || 'main.js'));
  if (!isPathInside(dir, target)) throw new Error('非法路径');
  return fs.readFileSync(target, 'utf-8');
});

// IPC: 写入扩展（files: { manifest?: object, main?: string }）
ipcMain.handle('ext:write', async (event, { id, files }) => {
  const dir = extDir(id);
  ensureExtensionsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (files && files.manifest !== undefined) {
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(files.manifest, null, 2), 'utf-8');
  }
  if (files && files.main !== undefined) {
    fs.writeFileSync(path.join(dir, 'main.js'), String(files.main), 'utf-8');
  }
  return { ok: true, dir };
});

// IPC: 备份扩展当前文件到 backup/<时间戳>/
ipcMain.handle('ext:backup', async (event, { id }) => {
  const dir = extDir(id);
  if (!fs.existsSync(dir)) return { ok: false, reason: '扩展不存在' };
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = path.join(dir, 'backup', ts);
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  const copied = [];
  for (const f of fs.readdirSync(dir)) {
    if (f === 'backup') continue;
    const src = path.join(dir, f);
    try {
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, path.join(target, f));
        copied.push(f);
      }
    } catch (e) {}
  }
  return { ok: true, backupPath: target, files: copied };
});

// IPC: 列出扩展的备份版本
ipcMain.handle('ext:list-backups', async (event, { id }) => {
  const backupRoot = path.join(extDir(id), 'backup');
  if (!fs.existsSync(backupRoot)) return [];
  return fs.readdirSync(backupRoot)
    .filter(f => {
      try { return fs.statSync(path.join(backupRoot, f)).isDirectory(); } catch { return false; }
    })
    .sort()
    .reverse()
    .map(f => {
      try {
        const st = fs.statSync(path.join(backupRoot, f));
        return { name: f, mtime: st.mtime.toISOString() };
      } catch { return null; }
    })
    .filter(Boolean);
});

// IPC: 从指定备份恢复扩展（覆盖 manifest.json 与 main.js）
ipcMain.handle('ext:restore', async (event, { id, backupName }) => {
  const dir = extDir(id);
  const backupRoot = path.join(dir, 'backup');
  const src = path.join(backupRoot, String(backupName || ''));
  if (!isPathInside(backupRoot, src)) throw new Error('非法路径');
  if (!fs.existsSync(src)) return { ok: false, reason: '备份不存在' };
  for (const f of ['manifest.json', 'main.js']) {
    const s = path.join(src, f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dir, f));
  }
  return { ok: true };
});

// IPC: 卸载扩展（移入软件内回收站 extensions/trash/，可从扩展页恢复）
const extTrashDir = path.join(extensionsDir, 'trash');
function ensureExtTrashDir() {
  if (!fs.existsSync(extTrashDir)) fs.mkdirSync(extTrashDir, { recursive: true });
}
ipcMain.handle('ext:remove', async (event, { id }) => {
  const dir = extDir(id);
  if (!fs.existsSync(dir)) return { ok: true, trashed: false, reason: 'not-exists' };
  ensureExtTrashDir();
  const trashName = safeExtId(id) + '-' + Date.now().toString(36);
  const trashTarget = path.join(extTrashDir, trashName);
  // 防止重名（极端情况同毫秒）
  if (fs.existsSync(trashTarget)) {
    const alt = trashName + '-' + Math.random().toString(36).slice(2, 6);
    try { fs.renameSync(dir, path.join(extTrashDir, alt)); return { ok: true, trashed: true, trashDir: alt }; }
    catch (e) { /* fallthrough */ }
  }
  try {
    fs.renameSync(dir, trashTarget);
    return { ok: true, trashed: true, trashDir: trashName };
  } catch (e) {
    // rename 失败（跨盘等）回退复制+删除
    try {
      fs.cpSync(dir, trashTarget, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: true, trashed: true, trashDir: trashName };
    } catch (e2) {
      return { ok: false, reason: String(e2 && e2.message || e2) };
    }
  }
});

// IPC: 列出软件内回收站中的扩展
ipcMain.handle('ext:trash-list', async () => {
  ensureExtTrashDir();
  return fs.readdirSync(extTrashDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(entry => {
      const dir = path.join(extTrashDir, entry.name);
      const manifestPath = path.join(dir, 'manifest.json');
      let manifest = null, error = null;
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); } catch (e) { error = 'manifest 解析失败'; }
      // 目录名格式 <id>-<base36 时间戳>
      const m = entry.name.match(/^(.+)-([a-z0-9]{6,})$/);
      const originalId = m ? m[1] : entry.name;
      let deletedAt = null;
      if (m) {
        try {
          const n = parseInt(m[2], 36);
          if (!isNaN(n)) deletedAt = new Date(n).toISOString();
        } catch (e) {}
      }
      return {
        id: (manifest && manifest.id) || originalId,
        trashDir: entry.name,
        manifest,
        hasMain: fs.existsSync(path.join(dir, 'main.js')),
        error,
        deletedAt
      };
    })
    .sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')));
});

// IPC: 从回收站恢复扩展（校验 id 合法 + 目标不存在）
ipcMain.handle('ext:trash-restore', async (event, { trashDir }) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(String(trashDir || ''))) return { ok: false, reason: '非法回收站目录名' };
  ensureExtTrashDir();
  const src = path.join(extTrashDir, String(trashDir));
  if (!isPathInside(extTrashDir, src) || !fs.existsSync(src)) return { ok: false, reason: '回收站项不存在' };
  const manifestPath = path.join(src, 'manifest.json');
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); } catch (e) { return { ok: false, reason: '回收站项缺少有效 manifest.json' }; }
  const id = safeExtId(manifest.id || '');
  if (!id) return { ok: false, reason: 'manifest 缺少合法 id' };
  const dest = extDir(id);
  if (fs.existsSync(dest)) return { ok: false, reason: '扩展 ' + id + ' 已存在，请先卸载' };
  try {
    fs.renameSync(src, dest);
    return { ok: true, id };
  } catch (e) {
    try {
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src)) {
        fs.cpSync(path.join(src, entry), path.join(dest, entry), { recursive: true, force: true });
      }
      fs.rmSync(src, { recursive: true, force: true });
      return { ok: true, id };
    } catch (e2) {
      return { ok: false, reason: String(e2 && e2.message || e2) };
    }
  }
});

// IPC: 从回收站永久删除
ipcMain.handle('ext:trash-purge', async (event, { trashDir }) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(String(trashDir || ''))) return { ok: false, reason: '非法回收站目录名' };
  ensureExtTrashDir();
  const target = path.join(extTrashDir, String(trashDir));
  if (!isPathInside(extTrashDir, target)) return { ok: false, reason: '非法路径' };
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  return { ok: true };
});

// IPC: 清空扩展回收站（清空 trash 目录全部内容）
ipcMain.handle('ext:trash-empty', async () => {
  ensureExtTrashDir();
  for (const entry of fs.readdirSync(extTrashDir, { withFileTypes: true })) {
    const target = path.join(extTrashDir, entry.name);
    if (!isPathInside(extTrashDir, target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
  }
  return { ok: true };
});

// IPC: 打开扩展目录（资源管理器）
ipcMain.handle('ext:open-dir', async () => {
  ensureExtensionsDir();
  await shell.openPath(extensionsDir);
  return true;
});

// IPC: 导入扩展（sourcePath 为空时弹出文件夹选择框）
// 校验目标目录含 manifest.json + 合法 id 后整体复制到 extensionsDir/<id>
ipcMain.handle('ext:import', async (event, { sourcePath } = {}) => {
  ensureExtensionsDir();
  let src = String(sourcePath || '').trim();
  if (!src) {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择要导入的扩展文件夹',
      properties: ['openDirectory']
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true };
    src = res.filePaths[0];
  }
  if (!fs.existsSync(src)) return { ok: false, reason: '来源目录不存在: ' + src };
  const stat = fs.statSync(src);
  if (!stat.isDirectory()) return { ok: false, reason: '请选择文件夹（每个扩展一个目录，含 manifest.json + main.js）' };

  // 读取 manifest 确定扩展 id（校验防路径穿越）
  const manifestPath = path.join(src, 'manifest.json');
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    return { ok: false, reason: '所选文件夹缺少有效的 manifest.json（不是扩展目录）' };
  }
  const rawId = String(manifest.id || '').trim();
  const id = safeExtId(rawId);
  if (!id || id !== rawId) return { ok: false, reason: 'manifest 的 id 不合法（仅允许字母/数字/中划线）: ' + rawId };
  const dest = extDir(id);
  if (fs.existsSync(dest)) return { ok: false, reason: '扩展 ' + id + ' 已存在，可先卸载后再导入' };

  // 复制整个目录（含 main.js、backup 等）
  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      const s = path.join(src, entry);
      const d = path.join(dest, entry);
      fs.cpSync(s, d, { recursive: true, force: true });
    }
  } catch (e) {
    // 复制失败时清理残留
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch (e2) {}
    return { ok: false, reason: '复制失败: ' + String(e && e.message || e) };
  }
  return { ok: true, id, dir: dest };
});

// IPC: 核心源码文件清单（供 AI 编程助手构建上下文，只读）
ipcMain.handle('src:list', async () => {
  const jsRoot = path.join(__dirname, 'js');
  const cssRoot = path.join(__dirname, 'css');
  const result = { js: [], css: [], indexHtml: false };
  try {
    result.js = fs.readdirSync(jsRoot).filter(f => f.endsWith('.js')).sort();
  } catch (e) {}
  try {
    result.css = fs.readdirSync(cssRoot).filter(f => f.endsWith('.css')).sort();
  } catch (e) {}
  result.indexHtml = fs.existsSync(path.join(__dirname, 'index.html'));
  return result;
});

// IPC: 读取核心源码片段（带行号信息，供 AI 上下文，只读）
ipcMain.handle('src:read', async (event, { file, offset, limit }) => {
  const allowedRoot = __dirname;
  const target = path.resolve(allowedRoot, String(file || ''));
  if (!isPathInside(allowedRoot, target)) throw new Error('非法路径');
  const ext = path.extname(target).toLowerCase();
  if (!['.js', '.css', '.html'].includes(ext)) throw new Error('仅支持 js/css/html');
  const content = fs.readFileSync(target, 'utf-8');
  const lines = content.split('\n');
  const start = Math.max(0, Number(offset) || 0);
  const end = limit ? Math.min(lines.length, start + Number(limit)) : lines.length;
  return { file, totalLines: lines.length, start, end, content: lines.slice(start, end).join('\n') };
});

// ═══════════ CodeBuddy CLI 支持 ═══════════
// AI 编程助手通过本机 CodeBuddy CLI（-p 非交互模式）运行 agent 任务：
// 自动读写扩展目录文件、流式输出执行日志。
// CLI 包名：@tencent-ai/codebuddy-code（命令 codebuddy，兼容 cbc），需 Node.js >= 18.20。

const codebuddyPkg = '@tencent-ai/codebuddy-code';
const sourceSnapshotDir = path.join(userDataPath, 'source-snapshot');

// 流式发送事件到渲染进程
function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// 检查路径是否是可执行的 CLI 入口
function isExecutableCli(p) {
  if (!p) return false;
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    // Windows 下 .cmd / .exe 等均为可执行；其他平台要求有执行位
    if (process.platform === 'win32') return true;
    // eslint-disable-next-line no-bitwise
    return (st.mode & 0o111) !== 0;
  } catch (e) {
    return false;
  }
}

// ── CodeBuddy CLI 运行辅助 ─────────────────────────────────────
// 解析 npm 全局安装的 .cmd/.bat 包装脚本，拿到真实脚本入口，
// 从而可以用 process.execPath（Electron 内置 Node）直接 spawn，
// 绕开 cmd.exe 的参数二次解析（长 prompt 中的双引号/特殊字符
// 不会被破坏）与 GBK 输出乱码。
// 返回 { script } 或 null（解析失败时回退到 shell 方式）。
function resolveCliEntry(cliPath) {
  try {
    if (!cliPath) return null;
    const lower = String(cliPath).toLowerCase();
    if (!lower.endsWith('.cmd') && !lower.endsWith('.bat')) return null;
    const content = String(fs.readFileSync(cliPath, 'utf8'));
    const dir = path.dirname(cliPath);
    // 标准 npm 全局 bin 包装脚本：node "…%dp0%\node_modules\<pkg>\bin\<entry>" %*
    // 入口可能无扩展名（如 bin/codebuddy），也可能为 .js/.mjs/.cjs。
    // 提取所有双引号包裹路径，从后往前找 node_modules 下的 bin 入口。
    const quoted = content.match(/"([^"\r\n]+)"/g) || [];
    let script = null;
    for (let i = quoted.length - 1; i >= 0; i--) {
      const s = quoted[i].slice(1, -1).trim();
      if (!s) continue;
      const ls = s.toLowerCase();
      const isEntry = ls.indexOf('node_modules') >= 0 &&
        (/[\\/]bin[\\/][^\\/"]+$/.test(ls) || /\.(js|mjs|cjs)$/.test(ls));
      if (!isEntry) continue;
      let resolved = s.replace(/%dp0%/gi, dir).replace(/%~dp0%/gi, dir);
      if (!path.isAbsolute(resolved)) resolved = path.resolve(dir, resolved);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) { script = resolved; break; }
    }
    if (!script) {
      // 兜底：node(或 node.exe) 之后跟的脚本路径（旧式包装脚本）
      const m = content.match(/(?:node(?:\.exe)?"?\s+)"?((?:%dp0%|%~dp0|[A-Za-z]:)[^"\r\n]+)"?/i);
      if (m) {
        let resolved = m[1].replace(/%dp0%/gi, dir).replace(/%~dp0%/gi, dir).replace(/"/g, '');
        if (!path.isAbsolute(resolved)) resolved = path.resolve(dir, resolved);
        if (fs.existsSync(resolved)) script = resolved;
      }
    }
    if (!script) return null;
    return { script };
  } catch (e) {
    return null;
  }
}

// 流式文本解码：先用严格 UTF-8 探测首段（约 1KB），失败则整体切换 GB18030。
// 解决 Windows 下子进程输出系统代码页（GBK）导致的乱码，且切换前的
// 缓冲内容也会被正确解码（不做边切边丢的流式重判）。
function createStreamDecoder() {
  let pending = Buffer.alloc(0);   // 编码探测前的缓冲
  let decoder = null;              // null = 尚未确定编码
  let pendingSize = 0;
  return {
    decode(chunk) {
      if (!chunk || chunk.length === 0) return '';
      if (!decoder) {
        pending = Buffer.concat([pending, chunk]);
        pendingSize += chunk.length;
        if (pendingSize < 1024) return ''; // 攒够再探测，避免边界误判
        // 严格 UTF-8 解码探测：失败说明输出是 GBK 等非 UTF-8 编码。
        // 去掉末尾最多 3 字节，避免多字节字符被截断导致误判。
        let useUtf8 = true;
        const probe = pending.length > 3 ? pending.slice(0, pending.length - 3) : pending;
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(probe);
        } catch (e) {
          useUtf8 = false;
        }
        try {
          decoder = useUtf8 ? new TextDecoder('utf-8') : new TextDecoder('gb18030');
        } catch (e) {
          decoder = new TextDecoder('utf-8');
        }
        const firstText = decoder.decode(pending, { stream: true });
        pending = Buffer.alloc(0);
        pendingSize = 0;
        return firstText;
      }
      return decoder.decode(chunk, { stream: true });
    },
    flush() {
      if (pending.length > 0) {
        if (!decoder) {
          try { decoder = new TextDecoder('utf-8'); } catch (e) { decoder = new TextDecoder('utf-8'); }
        }
        return decoder.decode(pending);
      }
      return decoder ? decoder.decode() : '';
    }
  };
}

// Windows 下通过 cmd.exe 执行 .cmd 时的参数引号转义（回退方案）
function quoteCmdArgs(exe, args) {
  return [exe].concat(args).map(function (a) {
    return '"' + String(a).replace(/"/g, '\\"') + '"';
  }).join(' ');
}

// Windows 常见 npm 全局 bin 路径
function npmGlobalBinCandidates() {
  const candidates = [];
  const ap = process.env.APPDATA;
  if (ap) candidates.push(path.join(ap, 'npm'));
  const lap = process.env.LOCALAPPDATA;
  if (lap) candidates.push(path.join(lap, 'npm'));
  const pf = process.env.ProgramFiles;
  if (pf) candidates.push(path.join(pf, 'nodejs'));
  return candidates;
}

// 探测 CodeBuddy CLI 路径（用户配置优先 → 常见 npm 全局 bin → PATH）
async function locateCodebuddyCli(userConfiguredPath) {
  // 1. 用户配置路径
  if (userConfiguredPath && isExecutableCli(userConfiguredPath)) {
    return { found: true, path: userConfiguredPath, source: 'user' };
  }
  // 2. 常见 npm 全局 bin 目录（codebuddy.cmd / cbc.cmd / codebuddy / cbc）
  for (const binDir of npmGlobalBinCandidates()) {
    for (const name of ['codebuddy.cmd', 'cbc.cmd', 'codebuddy', 'cbc']) {
      const p = path.join(binDir, name);
      if (isExecutableCli(p)) return { found: true, path: p, source: 'npm-global' };
    }
  }
  // 3. 系统 PATH（返回命令名，spawn 时用 shell 解析）
  return { found: false, path: '' };
}

// 导出核心源码快照（打包版源码在 asar，导出到 userData 供 agent 只读）
function exportSourceSnapshot() {
  if (!fs.existsSync(sourceSnapshotDir)) fs.mkdirSync(sourceSnapshotDir, { recursive: true });
  const dirs = ['js', 'css', 'lib'];
  for (const d of dirs) {
    const src = path.join(__dirname, d);
    const dst = path.join(sourceSnapshotDir, d);
    if (!fs.existsSync(src)) continue;
    if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      const sf = path.join(src, f);
      if (!fs.statSync(sf).isFile()) continue;
      fs.copyFileSync(sf, path.join(dst, f));
    }
  }
  // index.html / main.js / preload.js
  for (const f of ['index.html', 'main.js', 'preload.js', 'package.json']) {
    const sf = path.join(__dirname, f);
    if (fs.existsSync(sf)) fs.copyFileSync(sf, path.join(sourceSnapshotDir, f));
  }
  return sourceSnapshotDir;
}

// IPC: 探测 CodeBuddy CLI
ipcMain.handle('codebuddy:locate', async (event, { userPath } = {}) => {
  try {
    const result = await locateCodebuddyCli(userPath);
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// IPC: 导出核心源码快照（供 agent 只读参考）
ipcMain.handle('src:export-snapshot', async () => {
  try {
    const dir = exportSourceSnapshot();
    return { ok: true, dir };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// IPC: 检测 CodeBuddy CLI 登录状态
// 方法：运行一个极简 -p 任务，观察输出是否出现认证错误。
// 未登录时 CLI 会立即输出 "Authentication required. Please use /login"；
// 已登录时任务会正常推进（超过超时视为已登录，避免等待 agent 完成）。
ipcMain.handle('codebuddy:check-login', async (event, { userPath } = {}) => {
  const loc = await locateCodebuddyCli(userPath);
  if (!loc.found) {
    return { ok: true, loggedIn: false, reason: 'cli-not-found', hint: '未安装 CodeBuddy CLI' };
  }
  const entry = resolveCliEntry(loc.path);
  const args = ['-p', 'hi', '--output-format', 'stream-json', '--add-dir', extensionsDir, '--allowedTools', 'Read', '--dangerously-skip-permissions'];
  return new Promise((resolve) => {
    let child;
    try {
      if (entry && entry.script) {
        child = spawn(process.execPath, [entry.script].concat(args), {
          cwd: extensionsDir,
          env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' })
        });
      } else {
        child = spawn(loc.path, args, { cwd: extensionsDir, shell: process.platform === 'win32' });
      }
    } catch (e) {
      resolve({ ok: false, loggedIn: false, reason: String((e && e.message) || e) });
      return;
    }
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) {}
      resolve({ ok: true, loggedIn: true, reason: 'timeout' }); // 正常运行超过 12s，视为已登录
    }, 12000);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, loggedIn: false, reason: String(err.message || err) });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const text = String(stdout || '');
      if (/Authentication required|Please use \/login/i.test(text)) {
        resolve({ ok: true, loggedIn: false, reason: 'auth-required' });
      } else {
        resolve({ ok: true, loggedIn: true });
      }
    });
  });
});

// IPC: 打开终端执行 codebuddy（交互登录）
// 注意：cmd 默认用系统代码页(GBK)解析命令行，完整路径含非 ASCII 字符时会被
// 破坏（报"Windows 找不到 xx 文件"）。因此优先用 PATH 中的命令名（codebuddy/cbc），
// 让 cmd 自己按 PATHEXT 查找，彻底绕开中文路径。
ipcMain.handle('codebuddy:open-login-terminal', async (event, { userPath } = {}) => {
  const loc = await locateCodebuddyCli(userPath);
  let cmdName = 'codebuddy';
  if (loc.found && loc.path) {
    const base = path.basename(loc.path).replace(/\.(cmd|bat|exe)$/i, '');
    if (/^[A-Za-z0-9_-]+$/.test(base)) cmdName = base; // 仅纯 ASCII 名才用，否则用默认 codebuddy
  }
  try {
    if (process.platform === 'win32') {
      // 打开新的 cmd 窗口并保持（/d 禁 AutoRun，/k 运行后保留窗口），运行 codebuddy 交互登录
      const child = spawn('cmd.exe', ['/d', '/k', cmdName], { detached: true, stdio: 'ignore', windowsHide: false });
      if (child) child.unref();
      return { ok: true, cmdName };
    }
    if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Terminal', cmdName]);
      return { ok: true };
    }
    spawn('x-terminal-emulator', ['-e', cmdName], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// IPC: 一键安装 CodeBuddy CLI（npm install -g），流式回传安装日志
ipcMain.handle('codebuddy:install', async (event, { useMirror } = {}) => {
  return new Promise((resolve) => {
    const runInstall = () => {
      const args = ['install', '-g', codebuddyPkg];
      if (useMirror) args.push('--registry', 'https://registry.npmmirror.com');
      sendToRenderer('codebuddy:install-output', { type: 'info', text: '开始安装 ' + codebuddyPkg + ' …' });
      const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { shell: process.platform === 'win32' });
      const outDec = createStreamDecoder();
      const errDec = createStreamDecoder();
      child.stdout.on('data', (d) => {
        const text = outDec.decode(d);
        if (text) sendToRenderer('codebuddy:install-output', { type: 'out', text });
      });
      child.stderr.on('data', (d) => {
        const text = errDec.decode(d);
        if (text) sendToRenderer('codebuddy:install-output', { type: 'out', text });
      });
      child.on('error', (err) => {
        sendToRenderer('codebuddy:install-output', { type: 'error', text: '安装失败: ' + err.message });
        resolve({ ok: false, reason: String(err.message || err) });
      });
      child.on('close', async (code) => {
        if (code !== 0) {
          sendToRenderer('codebuddy:install-output', { type: 'error', text: 'npm 安装退出码: ' + code });
          resolve({ ok: false, reason: 'exit-' + code });
          return;
        }
        sendToRenderer('codebuddy:install-output', { type: 'success', text: '安装完成，正在重新探测 CLI …' });
        const loc = await locateCodebuddyCli();
        sendToRenderer('codebuddy:install-output', {
          type: loc.found ? 'success' : 'error',
          text: loc.found ? '已找到 CLI: ' + loc.path : '安装完成但未找到 CLI，请检查 npm 全局 bin 或手动配置路径'
        });
        resolve({ ok: true, exitCode: code, ...loc });
      });
    };
    // 先检测 npm
    const npmProbe = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { shell: process.platform === 'win32' });
    npmProbe.on('error', () => {
      sendToRenderer('codebuddy:install-output', { type: 'error', text: '未检测到 npm，请先安装 Node.js（>=18.20）后重试。' });
      resolve({ ok: false, reason: 'npm-not-found' });
    });
    npmProbe.on('close', (code) => {
      if (code !== 0) {
        sendToRenderer('codebuddy:install-output', { type: 'error', text: '未检测到 npm，请先安装 Node.js（>=18.20）后重试。' });
        resolve({ ok: false, reason: 'npm-not-found' });
        return;
      }
      runInstall();
    });
  });
});

// IPC: 运行 CodeBuddy CLI agent 任务（核心）
// 参数：{ prompt, userPath?, apiKey?, useMirror? }
// cwd 强制为 extensionsDir；add-dir 为源码只读目录（开发=项目根，打包=source-snapshot）
ipcMain.handle('codebuddy:run', async (event, { prompt, userPath, apiKey } = {}) => {
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) return { ok: false, reason: 'prompt 为空' };

  // 1. 定位 CLI
  const loc = await locateCodebuddyCli(userPath);
  if (!loc.found) {
    return { ok: false, reason: 'codebuddy-cli-not-found', hint: '未检测到 CodeBuddy CLI，请先安装（npm install -g @tencent-ai/codebuddy-code）' };
  }

  // 2. 源码只读目录（开发模式=项目根；打包模式=source-snapshot，且已导出）
  ensureExtensionsDir();
  let sourceDir = __dirname;
  if (app.isPackaged) {
    sourceDir = exportSourceSnapshot();
  }

  // 3. 组装 spawn 参数（全部数组元素传入，防 shell 注入）
  const args = ['-p', cleanPrompt, '--output-format', 'stream-json', '--add-dir', sourceDir, '--allowedTools', 'Read Edit Write', '--dangerously-skip-permissions'];

  // 4. 环境变量（API Key 授权时注入）
  const env = Object.assign({}, process.env);
  if (apiKey) {
    env.CODEBUDDY_API_KEY = String(apiKey);
    // 中国版 API Key 必须声明环境（internal），海外版无需
    if (!env.CODEBUDDY_INTERNET_ENVIRONMENT) env.CODEBUDDY_INTERNET_ENVIRONMENT = 'internal';
  }

  return new Promise((resolve) => {
    sendToRenderer('codegen:agent-output', { type: 'meta', text: '启动 CodeBuddy CLI agent …\n' });

    // 优先解析 .cmd 包装脚本的真实 JS 入口，用 Electron 内置 Node 直接运行
    // （ELECTRON_RUN_AS_NODE=1 让 electron.exe 以纯 Node 模式执行，绕开 cmd.exe
    // 参数二次解析与 GBK 乱码）；失败时回退到 cmd /c 引号转义。
    let child;
    const isWin = process.platform === 'win32';
    const entry = resolveCliEntry(loc.path);
    if (entry && entry.script) {
      const runEnv = Object.assign({}, env, { ELECTRON_RUN_AS_NODE: '1' });
      child = spawn(process.execPath, [entry.script].concat(args), { cwd: extensionsDir, env: runEnv });
    } else if (isWin && /\.(cmd|bat)$/i.test(loc.path)) {
      child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', quoteCmdArgs(loc.path, args)], { cwd: extensionsDir, env });
    } else {
      child = spawn(loc.path, args, { cwd: extensionsDir, env, shell: isWin });
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    const outDec = createStreamDecoder();
    const errDec = createStreamDecoder();

    child.stdout.on('data', (d) => {
      const text = outDec.decode(d);
      if (!text) return;
      stdoutBuf += text;
      sendToRenderer('codegen:agent-output', { type: 'out', text });
    });
    child.stderr.on('data', (d) => {
      const text = errDec.decode(d);
      if (!text) return;
      stderrBuf += text;
      sendToRenderer('codegen:agent-output', { type: 'err', text });
    });
    child.on('error', (err) => {
      sendToRenderer('codegen:agent-output', { type: 'error', text: 'CLI 启动失败: ' + err.message });
      resolve({ ok: false, reason: String(err.message || err) });
    });
    child.on('close', (code) => {
      stdoutBuf += outDec.flush() || '';
      stderrBuf += errDec.flush() || '';
      sendToRenderer('codegen:agent-output', {
        type: 'meta',
        text: (code === 0 ? 'CodeBuddy agent 执行完成。' : 'CodeBuddy agent 异常退出（code=' + code + '）。') + '\n'
      });
      resolve({ ok: code === 0, exitCode: code, stdout: stdoutBuf, stderr: stderrBuf });
    });
  });
});
