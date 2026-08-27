const { app, BrowserWindow, ipcMain, Notification, safeStorage, shell, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const {
  isPathInside,
  normalizeExtensionId,
  parseExternalUrl,
  parsePublicWebUrl
} = require('./electron/security');
const { registerBackupIpc } = require('./electron/register-backup-ipc');
const { registerDiagnostics } = require('./electron/diagnostics');
const { registerExtensionIpc } = require('./electron/register-extension-ipc');
const { registerLibraryIpc } = require('./electron/register-library-ipc');
const { registerSecretIpc } = require('./electron/register-secret-ipc');
const { registerUpdaterIpc } = require('./electron/register-updater-ipc');
const { resolveQQChatChunks } = require('./electron/qq-chat-policy');
const { createQQChatAutoSyncService } = require('./electron/qq-chat-auto-sync');

// 屏蔽 Qt/log4cplus 等系统级无关警告
process.env.QT_LOGGING_RULES = '*.debug=false;*.warning=false';
process.env.QT_LOGGING_CONF = '';

// 设置固定的用户数据目录，避免默认路径权限问题
const userDataPath = process.env.MST_E2E === '1' && process.env.MST_USER_DATA_PATH
  ? path.resolve(process.env.MST_USER_DATA_PATH)
  : path.join(app.getPath('home'), '.my-study-table');
app.setPath('userData', userDataPath);

let mainWindow;
registerBackupIpc({ ipcMain, shell, userDataPath });
const diagnostics = registerDiagnostics({ app, ipcMain, userDataPath });
const extensionService = registerExtensionIpc({
  dialog,
  ipcMain,
  shell,
  userDataPath,
  getMainWindow: () => mainWindow
});
const { extensionsDir, ensureExtensionsDir } = extensionService;
registerLibraryIpc({ app, dialog, ipcMain, userDataPath, getMainWindow: () => mainWindow });
registerSecretIpc({ ipcMain, safeStorage, userDataPath });
const updaterService = registerUpdaterIpc({ app, ipcMain, getMainWindow: () => mainWindow });

// 禁用 GPU 缓存（解决 cache_util_win 拒绝访问错误）
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-gpu-program-cache');

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
      nodeIntegration: false,
      sandbox: true
    },
    autoHideMenuBar: true,
    show: false
  });

  mainWindow.loadFile('index.html');

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const currentUrl = mainWindow && mainWindow.webContents.getURL();
    if (currentUrl && targetUrl !== currentUrl) event.preventDefault();
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.webContents.on('render-process-gone', (_event, details) => diagnostics.write('render-process-gone', details));

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
    if (process.env.MST_E2E !== '1') createTray();
    createWindow();
    if (process.env.MST_E2E !== '1') {
      updaterService.init();
      startConfirmServer(); // 监听 localhost:3000 供 Supabase 确认链接回调
    }
    qqChatAutoSyncService.restore().catch(() => {});
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
  qqChatAutoSyncService.close();
  if (confirmServer) {
    try { confirmServer.close(); } catch (e) {}
    confirmServer = null;
  }
});

// IPC: 桌面通知（支持点击跳转）
// payload: { title, body, tag, target } target = { tab, convId } 等跳转意图
ipcMain.handle('show-notification', async (event, payload) => {
  const { title, body, tag, target } = payload || {};
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body, silent: false });
    notification.on('click', () => {
      // 点击通知 → 回发渲染进程执行跳转（切 tab / 定位对话）
      if (target && event.sender && !event.sender.isDestroyed()) {
        event.sender.send('notification-click', target);
      }
      // 若窗口最小化/失焦，先恢复焦点
      const win = mainWindow || BrowserWindow.fromWebContents(event.sender);
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    });
    notification.show();
    return true;
  }
  return false;
});

// IPC: 用默认浏览器（Edge）打开外部链接
ipcMain.handle('open-external', async (event, url) => {
  try {
    const target = parseExternalUrl(url);
    await shell.openExternal(target.href);
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
          // 输出不足 1KB 未触发首段探测：这里同样做严格探测，避免短输出被按 UTF-8 硬解成乱码。
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
ipcMain.handle('codebuddy:run', async (event, { prompt, userPath, apiKey, mode } = {}) => {
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) return { ok: false, reason: 'prompt 为空' };

  // 1. 定位 CLI
  const loc = await locateCodebuddyCli(userPath);
  if (!loc.found) {
    return { ok: false, reason: 'codebuddy-cli-not-found', hint: '未检测到 CodeBuddy CLI，请先安装（npm install -g @tencent-ai/codebuddy-code）' };
  }

  // 2. 源码只读目录（开发模式=项目根；打包模式=source-snapshot，且已导出）
  await ensureExtensionsDir();
  let sourceDir = __dirname;
  if (app.isPackaged) {
    sourceDir = exportSourceSnapshot();
  }

  // 3. 按模式决定 allowedTools
  //    craft: Read Edit Write（可读写）
  //    plan/ask/clarify: 只读 Read（禁写入，澄清轮必须只读）
  const effectiveMode = mode || 'craft';
  const allowedTools = (effectiveMode === 'plan' || effectiveMode === 'ask' || effectiveMode === 'clarify')
    ? 'Read'
    : 'Read Edit Write';

  // 4. 组装 spawn 参数（全部数组元素传入，防 shell 注入）
  const args = ['-p', cleanPrompt, '--output-format', 'stream-json', '--add-dir', sourceDir, '--allowedTools', allowedTools, '--dangerously-skip-permissions'];

  // 5. 环境变量（API Key 授权时注入）
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

// ═══════════════════════════════════════════════
//  Inbox Assistant（消息收件箱）：IMAP 邮箱拉取 + 窗口长截图 + 文件目录收集
// ═══════════════════════════════════════════════

const capturesDir = path.join(userDataPath, 'captures');
function ensureCapturesDir() {
  if (!fs.existsSync(capturesDir)) fs.mkdirSync(capturesDir, { recursive: true });
}

// ── imapflow 懒加载（未安装时返回 null，IPC 返回友好错误）──
let imapflowModule = null;
function getImapFlow() {
  if (imapflowModule === null) {
    try {
      // imapflow 1.x 是命名导出（module.exports.ImapFlow），个别版本还可能是 default 导出，做兼容
      const mod = require('imapflow');
      imapflowModule = mod && (mod.ImapFlow || mod.default || mod);
    }
    catch (e) { imapflowModule = false; }
  }
  return imapflowModule || null;
}

// ═══════════ 简易 MIME 正文解析 ═══════════
function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br[^>]*>/gi, '\n')
    .replace(/<\/p[^>]*>/gi, '\n\n')
    .replace(/<\/div[^>]*>/gi, '\n')
    .replace(/<tr[^>]*>/gi, '\n')
    .replace(/<\/li[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

function cleanMailText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 中文邮件编码（GBK/GB2312/Big5 等）用 iconv-lite 解码（imapflow 的依赖，已扁平安装到顶层 node_modules）
let _iconv = null;
function getIconv() {
  if (_iconv === null) {
    try { _iconv = require('iconv-lite'); } catch (e) { _iconv = false; }
  }
  return _iconv || null;
}
const MAIL_CHARSET_ALIAS = {
  'utf8': 'utf-8',
  'gb2312': 'gbk', 'gb_2312': 'gbk', 'gb_2312-80': 'gbk', 'x-gbk': 'gbk', 'windows-936': 'gbk',
  'big5': 'big5', 'euc-kr': 'euc-kr', 'shift-jis': 'shift_jis', 'shift_jis': 'shift_jis',
  'windows-1252': 'windows-1252', 'latin-1': 'latin1'
};
function decodeCharset(buf, cs) {
  const raw = String(cs || 'utf-8').toLowerCase().replace(/['"]/g, '').trim();
  const label = MAIL_CHARSET_ALIAS[raw] || raw;
  try {
    const ic = getIconv();
    if (ic) return ic.decode(buf, label);
    if (label === 'utf-8' || label === 'ascii' || label === 'us-ascii') return buf.toString('utf8');
    if (label === 'latin1' || label === 'iso-8859-1') return buf.toString('latin1');
    return buf.toString('utf8');
  } catch (e) {
    return buf.toString('utf8');
  }
}

// 递归解析 MIME 邮件，收集 text/plain（优先）或 text/html（转为纯文本）
function extractMailText(raw) {
  const src = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || '');
  const results = { texts: [], htmls: [] };
  const SEP = '\r\n\r\n';

  function decodePart(buf, enc, cs) {
    let out = buf;
    try {
      if (enc === 'base64') {
        out = Buffer.from(buf.toString('latin1').replace(/\s+/g, ''), 'base64');
      } else if (enc === 'quoted-printable') {
        out = Buffer.from(buf.toString('latin1')
          .replace(/=\r?\n/g, '')
          .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
      }
      return decodeCharset(out, cs);
    } catch (e) {
      try { return decodeCharset(out, cs); } catch (e2) { return out.toString('utf8'); }
    }
  }

  // 支持 RFC 5322 折行 header（续行以空白开头），并折叠回单行
  function getHeaderVal(headerStr, name) {
    const m = headerStr.match(new RegExp('(?:^|\\r\\n)' + name + '\\s*:\\s*((?:[^\\r\\n]|\\r\\n[ \\t])*)', 'im'));
    return m ? m[1].replace(/\r\n[ \t]+/g, ' ') : '';
  }

  // 递归解析一个完整的 MIME 节点（header + body）
  function parseNode(nodeBuf) {
    const hEnd = nodeBuf.indexOf(SEP);
    if (hEnd === -1) return;
    const header = nodeBuf.slice(0, hEnd).toString('latin1');
    const body = nodeBuf.slice(hEnd + SEP.length);
    const ct = getHeaderVal(header, 'content-type') || 'text/plain';
    const type = ct.split(';')[0].trim().toLowerCase();
    const cs = (ct.match(/charset\s*=\s*"?([^";\s]+)"?/i) || [])[1] || 'utf-8';
    const enc = (getHeaderVal(header, 'content-transfer-encoding') || '').trim().toLowerCase();

    if (type.startsWith('multipart/')) {
      const bm = (ct.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i) || [])[1];
      if (!bm) return;
      const delim = Buffer.from('--' + bm, 'latin1');
      let idx = body.indexOf(delim);
      while (idx !== -1) {
        const lineEnd = body.indexOf('\r\n', idx);
        if (lineEnd === -1) break;
        const after = body.slice(idx + delim.length, idx + delim.length + 2).toString('latin1');
        if (after === '--') break; // 结束边界
        const start = lineEnd + 2;
        const next = body.indexOf(delim, start);
        if (next === -1) break;
        parseNode(body.slice(start, next));
        idx = next;
      }
    } else if (type === 'message/rfc822') {
      // 转发的邮件：body 即完整的内嵌消息，递归解析其自身 header 与正文
      parseNode(body);
    } else if (type.startsWith('text/')) {
      const text = decodePart(body, enc, cs);
      if (type === 'text/html') results.htmls.push(text);
      else results.texts.push(text);
    }
  }

  try { parseNode(src); } catch (e) { /* 解析失败返回空 */ }

  let text = results.texts.join('\n');
  if (!text && results.htmls.length > 0) text = results.htmls.map(htmlToText).join('\n');
  const cleaned = cleanMailText(text);
  return cleaned.length > 80000 ? cleaned.slice(0, 80000) + '\n\n[正文过长，已截断]' : cleaned;
}

// ═══════════ 内联 PowerShell 长截图脚本 ═══════════
// 纯 ASCII（中文窗口标题由 ConvertTo-Json 转义为 \uXXXX），避免编码/引号地狱。
// 通过 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File` 执行。
const LONG_SHOT_PS1 = `
param(
  [string]$Action = 'list',
  [string]$Hwnd = '',
  [int]$MaxScreens = 25,
  [string]$OutPath = ''
)
$ErrorActionPreference = 'Stop'
# 强制 stdout 使用 UTF-8，避免中文窗口标题被 GBK 编码后乱码
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies "System.Drawing" -TypeDefinition @"
using System;
using System.Text;
using System.Threading;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

public static class NativeWin {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT pt);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    // 获取窗口在屏幕上的物理客户区（左上角绝对坐标 + 宽高），供截图/滚动使用
    public static bool GetClientRectOnScreen(IntPtr h, out int cx, out int cy, out int cw, out int ch) {
        cx = 0; cy = 0; cw = 0; ch = 0;
        RECT r; if (!GetClientRect(h, out r)) return false;
        POINT p = new POINT(); if (!ClientToScreen(h, ref p)) return false;
        cx = p.X; cy = p.Y; cw = r.Right - r.Left; ch = r.Bottom - r.Top;
        return cw > 0 && ch > 0;
    }

    public static IntPtr[] ListWindows() {
        System.Collections.Generic.List<IntPtr> list = new System.Collections.Generic.List<IntPtr>();
        EnumWindows((h, l) => {
            if (IsWindowVisible(h)) list.Add(h);
            return true;
        }, IntPtr.Zero);
        return list.ToArray();
    }
    public static string GetTitle(IntPtr h) {
        int len = GetWindowTextLength(h);
        if (len <= 0) return "";
        StringBuilder sb = new StringBuilder(len + 1);
        GetWindowText(h, sb, len + 1);
        return sb.ToString();
    }
    public static RECT GetRect(IntPtr h) {
        RECT r; GetWindowRect(h, out r); return r;
    }
    public static bool Activate(IntPtr h) {
        ShowWindow(h, 9); // SW_RESTORE，最小化的窗口恢复
        bool ok = SetForegroundWindow(h);
        SetWindowPos(h, new IntPtr(0), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0020);
        return ok;
    }
    public static void ScrollDown(IntPtr h) {
        // 直接把 WM_MOUSEWHEEL PostMessage 给顶层窗口通常无效（滚轮消息由系统按光标位置注入目标控件）。
        // 通用方案：将光标移到客户区中心，再注入真实的鼠标滚轮事件。
        // 滚动幅度：分 3 次注入（每次 5 档），共约 15 档 → 让单次滚动更接近一屏，减少截图次数。
        int cx, cy, cw, ch;
        if (!GetClientRectOnScreen(h, out cx, out cy, out cw, out ch) || cw <= 0 || ch <= 0) {
            RECT r; GetWindowRect(h, out r);
            cx = (r.Left + r.Right) / 2;
            cy = (r.Top + r.Bottom) / 2;
        } else {
            cx += cw / 2;
            cy += ch / 2;
        }
        SetCursorPos(cx, cy);
        Thread.Sleep(80);
        // MOUSEEVENTF_WHEEL = 0x0800
        const uint WHEEL_DELTA = 120;
        for (int k = 0; k < 3; k++) {
            mouse_event(0x0800, 0, 0, -(int)(WHEEL_DELTA * 5), UIntPtr.Zero);
            Thread.Sleep(50);
        }
        Thread.Sleep(120);
    }
    public static Bitmap Capture(IntPtr h, int w, int hh) {
        Bitmap bmp = new Bitmap(w, hh);
        using (Graphics g = Graphics.FromImage(bmp)) {
            IntPtr hdc = g.GetHdc();
            PrintWindow(h, hdc, 2);
            g.ReleaseHdc(hdc);
        }
        return bmp;
    }
    public static bool SamePixels(Bitmap a, Bitmap b) {
        if (a == null || b == null) return false;
        if (a.Width != b.Width || a.Height != b.Height) return false;
        // 采样更密（宽高均分 32 格）+ 阈值更严（差异 <0.5% 才算相同），避免滚动少量内容被误判为到底
        int sx = Math.Max(1, a.Width / 32);
        int sy = Math.Max(1, a.Height / 32);
        int diff = 0, total = 0;
        for (int y = 0; y < a.Height; y += sy) {
            for (int x = 0; x < a.Width; x += sx) {
                total++;
                Color c1 = a.GetPixel(x, y);
                Color c2 = b.GetPixel(x, y);
                int d = Math.Abs(c1.R - c2.R) + Math.Abs(c1.G - c2.G) + Math.Abs(c1.B - c2.B);
                if (d > 30) diff++;
            }
        }
        if (total == 0) return true;
        return (double)diff / total < 0.005;
    }
    public static Bitmap Resize(Bitmap src, int maxWidth) {
        if (src == null) return null;
        double scale = (maxWidth > 0 && src.Width > maxWidth) ? (double)maxWidth / src.Width : 1.0;
        int nw = Math.Max(1, (int)(src.Width * scale));
        int nh = Math.Max(1, (int)(src.Height * scale));
        Bitmap result = new Bitmap(nw, nh, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(result)) {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.CompositingQuality = CompositingQuality.HighQuality;
            g.Clear(Color.White);
            g.DrawImage(src, 0, 0, nw, nh);
        }
        return result;
    }
    // 单行像素差异百分比（采样列）
    public static double RowDiffPct(Bitmap a, int ra, Bitmap b, int rb, int stepX) {
        int diff = 0, total = 0;
        for (int x = 0; x < a.Width; x += stepX) {
            total++;
            Color c1 = a.GetPixel(x, ra);
            Color c2 = b.GetPixel(x, rb);
            int d = Math.Abs(c1.R - c2.R) + Math.Abs(c1.G - c2.G) + Math.Abs(c1.B - c2.B);
            if (d > 30) diff++;
        }
        return total == 0 ? 100 : diff * 100.0 / total;
    }
    // 返回 prev 底部与 cur 顶部重叠的行数（即拼接时 cur 应跳过的行数）。
    // 策略：多行窗口匹配 + 偏移投票。对 cur 中多个采样行，用"连续 WIN 行"在 prev 中
    // 找最佳匹配位置（多行一致比单行更抗相似纹理误匹配），偏移量 = prev行号 - cur行号，
    // 取最集中的偏移簇中位数作为滚动量 s。
    // s=0 → 无滚动/滚动到底（全重叠）；s>=屏高 → 无重叠。
    public static int FindOverlapRows(Bitmap prev, Bitmap cur) {
        int ph = prev.Height, ch = cur.Height;
        if (ph <= 0 || ch <= 0 || prev.Width != cur.Width) return 0;
        int stepX = Math.Max(2, prev.Width / 24);
        const int WIN = 4; // 匹配窗口行数
        // 采样行：覆盖滚动内容区（避开顶部固定栏 / 底部输入框）
        int[] sampleRows = new int[] {
            ch / 8, ch / 4, ch / 2, ch * 3 / 4, ch * 7 / 8
        };
        System.Collections.Generic.List<int> offsets = new System.Collections.Generic.List<int>();
        foreach (int i in sampleRows) {
            if (i < 0 || i + WIN > ch) continue;
            int bestJ = -1;
            double best = double.MaxValue;
            int jMax = ph - WIN;
            for (int j = i; j <= jMax; j++) {
                // 多行窗口平均差异（比单行更鲁棒）
                double sum = 0;
                for (int k = 0; k < WIN; k++) sum += RowDiffPct(prev, j + k, cur, i + k, stepX);
                double avg = sum / WIN;
                if (avg < best) { best = avg; bestJ = j; }
            }
            // 窗口平均差异阈值 25
            if (bestJ >= 0 && best <= 25) offsets.Add(bestJ - i);
        }
        if (offsets.Count == 0) {
            // 匹配失败：保守返回 30% 重叠，避免大段重复
            return ch * 3 / 10;
        }
        // 偏移投票：取最集中的簇的中位数（排序后，找最长连续区间）
        offsets.Sort();
        int s = offsets[offsets.Count / 2];
        // 校验投票一致性：若中位数与多数偏移偏差过大，说明匹配不稳定，回退 30%
        int close = 0;
        foreach (int o in offsets) if (Math.Abs(o - s) <= 60) close++;
        if (close * 2 < offsets.Count) return ch * 3 / 10;
        if (s <= 0) return ch;   // 无滚动 → 全屏重叠（滚动到底判定）
        if (s >= ch) return 0;   // 滚动超一屏 → 无重叠
        return ch - s;
    }
    // 检测两屏顶部/底部的固定区域高度（标题栏/输入框不随滚动变化）
    // 返回 fixed: [topFixed, bottomFixed]
    public static int[] DetectFixedRegions(Bitmap a, Bitmap b, int stepX) {
        int top = 0, bottom = 0;
        int h = Math.Min(a.Height, b.Height);
        // 顶部：从上往下找连续相同行
        for (int y = 0; y < h; y++) {
            if (RowDiffPct(a, y, b, y, stepX) <= 5) top++;
            else break;
        }
        // 底部：从下往上找连续相同行
        for (int y = h - 1; y >= 0; y--) {
            if (RowDiffPct(a, y, b, y, stepX) <= 5) bottom++;
            else break;
        }
        // 保护：固定区不超过 35%，防止误判
        if (top > h * 35 / 100) top = h * 35 / 100;
        if (bottom > h * 35 / 100) bottom = h * 35 / 100;
        return new int[] { top, bottom };
    }
    // 裁剪 Bitmap 顶部 top 行、底部 bottom 行，返回新图
    public static Bitmap CropBitmap(Bitmap src, int top, int bottom) {
        if (src == null) return null;
        int hh = src.Height - top - bottom;
        if (hh <= 0) return null;
        Bitmap result = new Bitmap(src.Width, hh, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(result)) {
            g.Clear(Color.White);
            g.DrawImage(src, new Rectangle(0, 0, src.Width, hh), new Rectangle(0, top, src.Width, hh), GraphicsUnit.Pixel);
        }
        return result;
    }
    // 判断单行是否接近空白（浅色背景，低饱和）
    public static bool IsBlankRow(Bitmap b, int y, int stepX) {
        int total = 0, similar = 0;
        for (int x = 0; x < b.Width; x += stepX) {
            total++;
            Color c = b.GetPixel(x, y);
            int max = Math.Max(c.R, Math.Max(c.G, c.B));
            int min = Math.Min(c.R, Math.Min(c.G, c.B));
            if (max > 235 && (max - min) < 22) similar++;
        }
        return total > 0 && similar * 100 / total >= 90;
    }
    // 统计内容区底部空白行数（从 bottomFixed 往上数，聊天滚动到底后消息不足一屏的空白背景）
    public static int CountBottomBlank(Bitmap b, int topFixed, int bottomFixed, int stepX) {
        int h = b.Height;
        int blank = 0;
        int limit = h - bottomFixed - 1;
        for (int y = limit; y > topFixed; y--) {
            if (IsBlankRow(b, y, stepX)) blank++;
            else break;
        }
        return blank;
    }
    // 精调 skip：在 approxSkip ±4 行内，找 cur[skip] 与 prev 底部行最接近的位置。
    // 解决滚动量非整数行导致的整行舍入误差（拼接处 1-3 行错位）。
    public static int RefineSkip(Bitmap prevCrop, Bitmap curCrop, int approxSkip) {
        int ph = prevCrop.Height, ch = curCrop.Height;
        if (ph <= 0 || ch <= 0 || prevCrop.Width != curCrop.Width) return approxSkip;
        int stepX = Math.Max(2, prevCrop.Width / 24);
        const int RANGE = 4;
        int best = approxSkip;
        double bestScore = double.MaxValue;
        int lo = Math.Max(0, approxSkip - RANGE);
        int hi = Math.Min(ch - 1, approxSkip + RANGE);
        for (int s = lo; s <= hi; s++) {
            // 用 cur[s..s+2] 与 prev[ph-3..ph-1]（底部 3 行）比对
            double sum = 0;
            for (int k = 0; k < 3; k++) {
                int py = ph - 3 + k;
                int cy = s + k;
                if (py >= 0 && py < ph && cy >= 0 && cy < ch) {
                    sum += RowDiffPct(prevCrop, py, curCrop, cy, stepX);
                }
            }
            if (sum < bestScore) { bestScore = sum; best = s; }
        }
        return best;
    }
    // 智能拼接：第 0 张全取，第 i 张跳过 overlaps[i] 行重叠，只拼新增内容。
    // topFixed/bottomFixed 为裁剪掉的固定区；每张图内容区底部空白会被检测并裁掉
    // （聊天滚动到底后消息不足一屏时的空白背景）。skip 经 RefineSkip 局部精调，
    // 消除滚动量非整数行导致的整行舍入误差（拼接处错位）。
    public static Bitmap JoinOverlap(System.Collections.Generic.List<Bitmap> list, int[] overlaps, int topFixed, int bottomFixed) {
        if (list == null || list.Count == 0) return null;
        int w = list[0].Width;
        int stepX = Math.Max(2, w / 24);
        int n = list.Count;
        // 每张图的有效底部（裁掉固定区 + 内容区空白）
        int[] effBottom = new int[n];
        for (int i = 0; i < n; i++) {
            int blank = CountBottomBlank(list[i], topFixed, bottomFixed, stepX);
            int contentH = list[i].Height - topFixed - bottomFixed;
            effBottom[i] = list[i].Height - bottomFixed - Math.Min(blank, contentH);
        }
        // skip = overlaps + 2（保守多算 2 行重叠，避免边界处消息被画两遍）。
        // FindOverlapRows 基于多行窗口匹配已找到最佳重叠，但因滚动量非整数 + 渲染差异，
        // 偶尔差 1-2 行，宁可裁多一点避免重复也不漏。
        int[] skipArr = new int[n];
        skipArr[0] = 0;
        for (int i = 1; i < n; i++) {
            int avail = effBottom[i] - topFixed;
            skipArr[i] = Math.Min(overlaps[i] + 2, avail - 1);
        }
        int totalH = 0;
        int firstH = effBottom[0] - topFixed;
        if (firstH <= 0) return null;
        totalH = firstH;
        for (int i = 1; i < n; i++) {
            int avail = effBottom[i] - topFixed;
            int skip = Math.Min(skipArr[i], avail - 1);
            int hh = avail - skip;
            if (hh > 0) totalH += hh;
        }
        if (totalH <= 0) return null;
        Bitmap result = new Bitmap(w, totalH, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(result)) {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.CompositingQuality = CompositingQuality.HighQuality;
            g.Clear(Color.White);
            int y = 0;
            // 第一屏：内容区（跳过顶部固定区，裁掉底部空白）
            g.DrawImage(list[0], new Rectangle(0, 0, w, firstH), new Rectangle(0, topFixed, w, firstH), GraphicsUnit.Pixel);
            y += firstH;
            // 后续屏：从顶部固定区后开始，跳过精调后的重叠，裁掉底部空白
            for (int i = 1; i < n; i++) {
                Bitmap b = list[i];
                int avail = effBottom[i] - topFixed;
                int skip = Math.Min(skipArr[i], avail - 1);
                int hh = avail - skip;
                if (hh <= 0) continue;
                int srcTop = topFixed + skip;
                g.DrawImage(b, new Rectangle(0, y, w, hh), new Rectangle(0, srcTop, w, hh), GraphicsUnit.Pixel);
                y += hh;
            }
        }
        return result;
    }
}
"@

# 声明 DPI-aware：确保 GetWindowRect/PrintWindow 使用物理像素而非虚拟化逻辑像素，
# 否则在高 DPI 缩放下截图宽度会小于窗口实际宽度（只截到一部分）。
[void][NativeWin]::SetProcessDPIAware()

if ($Action -eq 'list') {
    $result = @()
    foreach ($h in [NativeWin]::ListWindows()) {
        $title = [NativeWin]::GetTitle($h)
        if ([string]::IsNullOrWhiteSpace($title)) { continue }
        if ([NativeWin]::IsIconic($h)) { continue }
        $r = [NativeWin]::GetRect($h)
        if ($r.Right -le $r.Left -or $r.Bottom -le $r.Top) { continue }
        $result += @{ hwnd = $h.ToInt64(); title = $title; w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top) }
    }
    Write-Output ($result | ConvertTo-Json -Compress -Depth 4)
    exit 0
}

if ($Action -eq 'shot') {
    $h = [IntPtr][int64]$Hwnd
    $shots = New-Object System.Collections.Generic.List[System.Drawing.Bitmap]  # 完整屏（含固定区）
    $overlaps = New-Object System.Collections.Generic.List[int]
    [void][NativeWin]::Activate($h)
    Start-Sleep -Milliseconds 400
    $screens = 0
    $noChange = 0
    $topFixed = 0
    $bottomFixed = 0
    $fixedDetected = $false
    $w = 0; $hh = 0
    try {
        for ($i = 0; $i -lt $MaxScreens; $i++) {
            $r = [NativeWin]::GetRect($h)
            $w = $r.Right - $r.Left
            $hh = $r.Bottom - $r.Top
            if ($w -le 0 -or $hh -le 0) { break }
            $raw = [NativeWin]::Capture($h, $w, $hh)
            $bmp = [NativeWin]::Resize($raw, 1600)
            $raw.Dispose()
            if ($screens -eq 0) {
                # 第一屏
                $shots.Add($bmp)
                $overlaps.Add(0)
                $screens++
            } else {
                # 用前两屏检测固定区（标题栏/输入框高度）
                if (-not $fixedDetected) {
                    $stepX = [Math]::Max(2, [int]($shots[0].Width / 24))
                    $fixed = [NativeWin]::DetectFixedRegions($shots[0], $bmp, $stepX)
                    $topFixed = $fixed[0]
                    $bottomFixed = $fixed[1]
                    $fixedDetected = $true
                }
                # 内容区高度用 Resize 后的 bmp.Height（与 FindOverlapRows/JoinOverlap 坐标系一致）
                $contentH = $bmp.Height - $topFixed - $bottomFixed
                if ($contentH -le 0) { $bmp.Dispose(); break }
                # 早停：当前屏内容区几乎全空（空白超 60%）→ 已滚到底
                $stepX2 = [Math]::Max(2, [int]($bmp.Width / 24))
                $bottomBlank = [NativeWin]::CountBottomBlank($bmp, $topFixed, $bottomFixed, $stepX2)
                if ($bottomBlank -gt ($contentH * 60 / 100)) {
                    $bmp.Dispose()
                    break
                }
                $prevCrop = [NativeWin]::CropBitmap($shots[$shots.Count - 1], $topFixed, $bottomFixed)
                $curCrop = [NativeWin]::CropBitmap($bmp, $topFixed, $bottomFixed)
                $ov = [NativeWin]::FindOverlapRows($prevCrop, $curCrop)
                $newRows = $contentH - $ov
                $prevCrop.Dispose(); $curCrop.Dispose()
                if ($newRows -le 0) {
                    # 内容区完全重叠（滚动到底或未滚动）→ 累计判定，连续 2 次停止
                    $bmp.Dispose()
                    $noChange++
                    if ($noChange -ge 2) { break }
                    if ($i -lt $MaxScreens - 1) {
                        [NativeWin]::ScrollDown($h)
                        Start-Sleep -Milliseconds 450
                    }
                    continue
                }
                $noChange = 0
                $shots.Add($bmp)
                $overlaps.Add($ov)
                $screens++
            }
            if ($i -lt $MaxScreens - 1) {
                [NativeWin]::ScrollDown($h)
                Start-Sleep -Milliseconds 450
            }
        }
        if ($shots.Count -eq 0) {
            Write-Output '{"ok":false,"error":"capture-failed","screens":0}'
            exit 1
        }
        $joined = [NativeWin]::JoinOverlap($shots, $overlaps.ToArray(), $topFixed, $bottomFixed)
        if ($null -eq $joined) {
            Write-Output '{"ok":false,"error":"join-failed","screens":' + $screens + '}'
            exit 1
        }
        $joined.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
        $joined.Dispose()
        Write-Output (ConvertTo-Json -Compress -InputObject @{ ok = $true; screens = $screens; path = $OutPath; top = $topFixed; bottom = $bottomFixed })
        exit 0
    } finally {
        foreach ($b in $shots) { $b.Dispose() }
    }
}

Write-Output '{"ok":false,"error":"unknown-action"}'
exit 1
`;

// 运行内联 PowerShell 脚本（写入临时 .ps1，UTF-8 BOM，绕开引号地狱与中文乱码）
function runPowerShellScript(script, args) {
  const tmpDir = path.join(userDataPath, 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const scriptPath = path.join(tmpDir, 'inbox-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.ps1');
  try { fs.writeFileSync(scriptPath, '\uFEFF' + script, 'utf-8'); }
  catch (e) { return Promise.resolve({ ok: false, error: '写入脚本失败: ' + e.message }); }
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath].concat(args || []), { windowsHide: true });
    let stdout = '', stderr = '';
    const outDec = createStreamDecoder();
    const errDec = createStreamDecoder();
    child.stdout.on('data', (d) => { stdout += outDec.decode(d); });
    child.stderr.on('data', (d) => { stderr += errDec.decode(d); });
    child.on('error', (err) => {
      try { fs.unlinkSync(scriptPath); } catch (e2) {}
      resolve({ ok: false, error: String(err.message || err) });
    });
    child.on('close', (code) => {
      stdout += outDec.flush() || '';
      stderr += errDec.flush() || '';
      try { fs.unlinkSync(scriptPath); } catch (e2) {}
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

// 从 PowerShell 输出中提取最后一行 JSON（脚本 stdout 可能混有警告等）
function parsePsJsonOutput(stdout) {
  const lines = String(stdout || '').trim().split('\n').filter(l => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{') || line.startsWith('[')) {
      try { return JSON.parse(line); } catch (e) { /* 尝试下一行 */ }
    }
  }
  return null;
}

// ═══════════ IMAP 邮箱 IPC ═══════════
function buildImapConfig(cfg) {
  const host = String((cfg && cfg.host) || '').trim();
  const secure = cfg.secure === true || cfg.secure === 'true';
  const port = Number(cfg.port) || (secure ? 993 : 143);
  return {
    host,
    port,
    secure,
    auth: { user: String((cfg && cfg.user) || ''), pass: String((cfg && cfg.pass) || '') },
    logger: false
  };
}

// IPC: 测试邮箱连接
ipcMain.handle('mail:test', async (event, cfg) => {
  const ImapFlow = getImapFlow();
  if (!ImapFlow) return { ok: false, message: 'imapflow 依赖未安装' };
  if (!cfg || !cfg.host || !cfg.user || !cfg.pass) return { ok: false, message: '请填写完整的邮箱配置' };
  const client = new ImapFlow(buildImapConfig(cfg));
  try {
    await client.connect();
    await client.logout();
    return { ok: true, message: '连接成功' };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
});

// IPC: 拉取最近 N 封邮件（正文纯文本，最新在前）
ipcMain.handle('mail:fetch', async (event, cfg) => {
  const ImapFlow = getImapFlow();
  if (!ImapFlow) return { ok: false, reason: 'imapflow 依赖未安装' };
  if (!cfg || !cfg.host || !cfg.user || !cfg.pass) return { ok: false, reason: '邮箱配置不完整' };
  const limit = Math.min(Math.max(Number(cfg.limit) || 20, 1), 50);
  const client = new ImapFlow(buildImapConfig(cfg));
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    const mails = [];
    try {
      const status = await client.status('INBOX', { messages: true });
      const total = status.messages || 0;
      if (total > 0) {
        const start = Math.max(1, total - limit + 1);
        for await (const msg of client.fetch(start + ':*', { envelope: true, source: true, uid: true })) {
          const env = msg.envelope || {};
          const fromAddr = (env.from || []).map(a => {
            const nm = a.name || '';
            const addr = a.address || '';
            return nm && addr ? `${nm} <${addr}>` : (nm || addr || '');
          }).join(', ') || '未知发件人';
          const dateStr = env.date ? new Date(env.date).toISOString() : new Date().toISOString();
          const body = extractMailText(msg.source || Buffer.alloc(0));
          mails.push({
            id: msg.uid || 0,
            from: fromAddr,
            subject: env.subject || '(无主题)',
            date: dateStr,
            body
          });
        }
        mails.reverse(); // 最新在前
      }
    } finally {
      lock.release();
    }
    await client.logout();
    return { ok: true, mails };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// ═══════════ 网页阅读 IPC（AI 读网页）：隐藏 BrowserWindow 真实渲染 + 正文提取 ═══════════

// 常规 Chrome User-Agent，规避部分站点对爬虫的拦截
const WEB_READER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const WEB_READER_TIMEOUT = 25000;     // 整体渲染超时（ms）
const WEB_READER_STABLE_WAIT = 12000; // 等待 JS 渲染稳定的最大时长（ms）

// 在页面上下文执行的正文提取脚本：移除噪声节点后返回 { title, text }
function webReaderExtractScript() {
  return `(() => {
    try {
      const noise = 'script,style,noscript,svg,canvas,iframe,nav,footer,header,aside,form,' +
        '[class*="advertisement"],[class*="advert"],[id*="advert"],[class*="ads"],[id*="ads"],' +
        '.ad,.ads,.banner,.cookie,.popup,.modal,.comment,.related,[hidden]';
      document.querySelectorAll(noise).forEach(n => n.remove());
      document.querySelectorAll('*').forEach(el => {
        try {
          const st = window.getComputedStyle(el);
          if (st.display === 'none' || st.visibility === 'hidden' || el.getClientRects().length === 0) el.remove();
        } catch (e) {}
      });
      const main = document.querySelector('article') || document.querySelector('main') || document.body;
      let text = (main && main.innerText) || '';
      text = text.replace(/[ \\t]+/g, ' ').replace(/\\n\\s*\\n+/g, '\\n').trim();
      return JSON.stringify({ title: document.title || '', text: text });
    } catch (e) {
      return JSON.stringify({ title: '', text: '', error: String((e && e.message) || e) });
    }
  })()`;
}

// 等待页面 JS 渲染趋于稳定：正文长度两次采样一致且非空，或超时兜底
async function waitWebReaderStable(wc) {
  const deadline = Date.now() + WEB_READER_STABLE_WAIT;
  let prev = -1;
  while (Date.now() < deadline) {
    try {
      const len = await wc.executeJavaScript('document.body ? document.body.innerText.length : 0');
      if (len > 0 && len === prev) {
        await new Promise(r => setTimeout(r, 500));
        const again = await wc.executeJavaScript('document.body ? document.body.innerText.length : 0');
        if (again === len) return true;
      }
      prev = len;
    } catch (e) { /* 页面尚未就绪，继续等待 */ }
    await new Promise(r => setTimeout(r, 400));
  }
  return true;
}

// IPC: 阅读网页正文 —— 隐藏 BrowserWindow 真实渲染（支持 JS 渲染的 SPA），提取 title + 正文纯文本
ipcMain.handle('web:read', async (event, { url, maxChars } = {}) => {
  let win = null;
  try {
    if (!url) return { ok: false, error: '缺少网页 URL' };
    const target = parsePublicWebUrl(url);
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false, // 隐藏窗口禁用节流，保证 SPA 的 JS 正常执行
        partition: 'web-reader-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) // 独立临时会话，隔离 cookie
      }
    });
    // 安全加固：拦截新窗口/弹窗，拒绝一切权限请求
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => cb(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    win.webContents.setUserAgent(WEB_READER_UA);
    let blockedNavigation = '';
    const guardWebReaderNavigation = (navigationEvent, navigationUrl) => {
      try { parsePublicWebUrl(navigationUrl); }
      catch (error) {
        blockedNavigation = String((error && error.message) || error);
        navigationEvent.preventDefault();
      }
    };
    win.webContents.on('will-redirect', guardWebReaderNavigation);
    win.webContents.on('will-navigate', guardWebReaderNavigation);

    const outcome = await Promise.race([
      (async () => {
        try {
          await win.loadURL(target.href);
        } catch (e) {
          return { ok: false, error: '页面加载失败：' + String((e && e.message) || e) };
        }
        if (blockedNavigation) return { ok: false, error: '页面跳转已被拦截：' + blockedNavigation };
        await waitWebReaderStable(win.webContents);
        if (blockedNavigation) return { ok: false, error: '页面跳转已被拦截：' + blockedNavigation };
        const raw = await win.webContents.executeJavaScript(webReaderExtractScript());
        const data = JSON.parse(raw || '{}');
        if (data.error) return { ok: false, error: '页面内容提取失败：' + data.error };
        const text = (data.text || '').trim();
        if (!text) return { ok: false, error: '未能提取到页面正文（可能需登录或需交互渲染）' };
        return { ok: true, title: (data.title || '').trim(), text, finalUrl: win.webContents.getURL() || target.href };
      })(),
      new Promise(resolve => setTimeout(() => resolve({ ok: false, error: '页面渲染超时（超过 25 秒）' }), WEB_READER_TIMEOUT))
    ]);
    return outcome;
  } catch (err) {
    return { ok: false, error: '读取网页失败：' + String((err && err.message) || err) };
  } finally {
    if (win) { try { win.destroy(); } catch (e) {} }
  }
});

// ═══════════ 窗口长截图 IPC ═══════════

// IPC: 枚举可见窗口
ipcMain.handle('capture:list-windows', async () => {
  try {
    const res = await runPowerShellScript(LONG_SHOT_PS1, ['-Action', 'list']);
    if (!res.ok) return { ok: false, reason: res.stderr || res.stdout || '窗口枚举失败' };
    const parsed = parsePsJsonOutput(res.stdout);
    const windows = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    return { ok: true, windows };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// IPC: 对指定窗口执行自动滚动长截图
ipcMain.handle('capture:long-shot', async (event, { hwnd, maxScreens } = {}) => {
  try {
    ensureCapturesDir();
    const outPath = path.join(capturesDir, 'capture-' + Date.now() + '.png');
    const max = Math.min(Math.max(Number(maxScreens) || 25, 3), 50);
    const res = await runPowerShellScript(LONG_SHOT_PS1, [
      '-Action', 'shot',
      '-Hwnd', String(hwnd),
      '-MaxScreens', String(max),
      '-OutPath', outPath
    ]);
    if (!res.ok) {
      const parsed = parsePsJsonOutput(res.stdout);
      if (parsed && parsed.ok) return { ok: true, imagePath: parsed.path || outPath, screens: parsed.screens || 0 };
      return { ok: false, reason: (parsed && parsed.error) || res.stderr || res.stdout || '长截图失败' };
    }
    const parsed = parsePsJsonOutput(res.stdout);
    if (parsed && parsed.ok) return { ok: true, imagePath: parsed.path || outPath, screens: parsed.screens || 0 };
    return { ok: false, reason: '长截图失败（未获取到结果）' };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// ═══════════ 文件目录收集 IPC ═══════════
// 允许读取的根目录集合（captures 目录 + 用户通过 pick-dir / list-files 添加的目录）
const allowedInboxDirs = new Set();
function ensureInboxDirAllowed(dir) {
  if (!dir) return;
  const norm = path.resolve(dir);
  try {
    const st = fs.statSync(norm);
    allowedInboxDirs.add(st.isDirectory() ? norm : path.dirname(norm));
  } catch (e) {}
}
function isInboxPathAllowed(filePath) {
  if (!filePath) return false;
  const abs = path.resolve(filePath);
  const allowed = [capturesDir, ...Array.from(allowedInboxDirs)];
  for (const base of allowed) {
    try {
      // 目录自身（abs === base）与目录内部文件都放行：
      // isPathInside 对"恰好等于 base"返回 false（path.relative 为 ''），
      // 但选择导出文件夹后读取 manifest 时传的就是目录本身，必须放行。
      if (abs === base || isPathInside(base, abs)) return true;
    } catch (e) {}
  }
  return false;
}

const INBOX_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
const INBOX_TEXT_EXTS = [
  '.txt', '.md', '.markdown', '.json', '.js', '.mjs', '.ts', '.jsx', '.tsx',
  '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.rb',
  '.php', '.swift', '.kt', '.sql', '.html', '.htm', '.css', '.scss', '.less',
  '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.log', '.csv',
  '.tsv', '.diff', '.patch', '.sh', '.bat', '.ps1'
];

// IPC: 递归扫描目录中的新增可导入文件（图片/文本白名单，按 mtime 过滤）
ipcMain.handle('capture:list-files', async (event, { dir, sinceMs } = {}) => {
  try {
    const root = String(dir || '').trim();
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return { ok: false, reason: '目录不存在或不可访问' };
    }
    ensureInboxDirAllowed(root);
    const since = Number(sinceMs) || 0;
    const files = [];
    const walk = (cur, depth) => {
      if (depth > 8) return;
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const lower = entry.name.toLowerCase();
        if (lower === 'thumbs.db' || lower === 'desktop.ini') continue;
        const full = path.join(cur, entry.name);
        try {
          if (entry.isDirectory()) { walk(full, depth + 1); continue; }
          if (!entry.isFile()) continue;
          const ext = path.extname(entry.name).toLowerCase();
          const isImage = INBOX_IMAGE_EXTS.includes(ext);
          if (!isImage && !INBOX_TEXT_EXTS.includes(ext)) continue;
          const st = fs.statSync(full);
          const mtimeMs = st.mtimeMs;
          if (since > 0 && mtimeMs < since) continue;
          files.push({
            path: full,
            name: entry.name,
            size: st.size,
            mtime: st.mtime.toISOString(),
            mtimeMs,
            kind: isImage ? 'image' : 'text'
          });
        } catch (e2) { /* 跳过无法访问的文件 */ }
      }
    };
    walk(root, 0);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { ok: true, files };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// IPC: 选择文件目录
ipcMain.handle('capture:pick-dir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择微信 / QQ 文件保存目录',
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true };
  ensureInboxDirAllowed(res.filePaths[0]);
  return { ok: true, dir: res.filePaths[0] };
});

// IPC: 保存拖入的图片文件到 captures 目录（返回磁盘路径，避免把 base64 塞进 localStorage）
ipcMain.handle('capture:save-image', async (event, { name, buffer } = {}) => {
  try {
    const fname = String(name || 'drop-' + Date.now() + '.png');
    const ext = path.extname(fname).toLowerCase();
    if (!INBOX_IMAGE_EXTS.includes(ext)) {
      // 扩展名不合法则统一存为 .png（base64 数据可能来自任意图片）
      return { ok: false, reason: '不支持的图片类型: ' + ext };
    }
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    if (buf.length > 15 * 1024 * 1024) return { ok: false, reason: '图片过大（>15MB）' };
    ensureCapturesDir();
    const safeName = fname.replace(/[^\w.\-一-龥]/g, '_');
    const outPath = path.join(capturesDir, 'drop-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + ext);
    await fs.promises.writeFile(outPath, buf);
    return { ok: true, path: outPath };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// IPC: 读取图片为 Data URL（供 AI 视觉模型概括）
ipcMain.handle('capture:read-image', async (event, filePath) => {
  try {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    if (!INBOX_IMAGE_EXTS.includes(ext)) return { ok: false, reason: '不支持的文件类型' };
    const mimeMap = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp'
    };
    const mime = mimeMap[ext] || 'image/png';
    const buffer = await fs.promises.readFile(filePath);
    if (buffer.length > 15 * 1024 * 1024) return { ok: false, reason: '图片过大（>15MB）' };
    return { ok: true, dataUrl: 'data:' + mime + ';base64,' + buffer.toString('base64') };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// IPC: 读取文本文件内容（供目录收集的文本文件概括）
ipcMain.handle('capture:read-file-text', async (event, filePath) => {
  try {
    if (!isInboxPathAllowed(filePath)) return { ok: false, reason: '路径不在允许范围内' };
    const ext = path.extname(String(filePath || '')).toLowerCase();
    if (!INBOX_TEXT_EXTS.includes(ext)) return { ok: false, reason: '不支持的文件类型' };
    let text = await fs.promises.readFile(filePath, 'utf-8');
    if (text.length > 80000) text = text.slice(0, 80000) + '\n\n[内容过长，已截断]';
    return { ok: true, text };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// ═══════════ QQ 聊天 JSONL 导出文件夹读取 ═══════════
// qq-chat-exporter 流式导出产生「manifest.json + chunks/*.jsonl」，
// 这里让用户直接选择整个 ..._chunked_jsonl 文件夹，主进程读取 manifest 与全部 chunk。

const QQCHAT_MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const QQCHAT_MAX_CHUNK_BYTES = 32 * 1024 * 1024;
const QQCHAT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const QQCHAT_MAX_LINES_PER_CHUNK = 250000;
const QQCHAT_MAX_TOTAL_MESSAGES = 500000;
const allowedQQChatChunkFiles = new Set();
let qqChatMessagesRead = 0;
const qqChatMetaBackupDir = path.join(userDataPath, 'qq-chat-backups');
const qqChatAutoConfigPath = path.join(userDataPath, 'qq-chat-auto-sync.json');

async function readValidatedQQChatManifest(dir, authorize) {
  const exportRoot = path.resolve(String(dir || ''));
  if (!exportRoot || !fs.existsSync(exportRoot)) throw new Error('QQ 导出目录不存在或不可访问');
  const rootStat = await fs.promises.lstat(exportRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('QQ 导出目录必须是普通文件夹');
  if (authorize) ensureInboxDirAllowed(exportRoot);
  if (!isInboxPathAllowed(exportRoot)) throw new Error('路径不在允许范围内');
  const manifestPath = path.join(exportRoot, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('未找到 manifest.json，请选择 qq-chat-exporter 的 JSONL 导出文件夹');
  const manifestStat = await fs.promises.lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('manifest.json 必须是导出目录中的普通文件');
  if (manifestStat.size > QQCHAT_MAX_MANIFEST_BYTES) throw new Error('manifest.json 过大，拒绝读取');
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
  if (!manifest || !manifest.chunked || !Array.isArray(manifest.chunked.chunks)) {
    throw new Error('manifest.json 格式不正确（缺少 chunked.chunks）');
  }
  const resolved = await resolveQQChatChunks({
    exportRoot,
    manifest,
    fs,
    path,
    isPathInside,
    maxChunkBytes: QQCHAT_MAX_CHUNK_BYTES,
    maxTotalBytes: QQCHAT_MAX_TOTAL_BYTES
  });
  allowedQQChatChunkFiles.clear();
  for (const filePath of resolved.chunkFiles) allowedQQChatChunkFiles.add(filePath);
  qqChatMessagesRead = 0;
  return { manifest, chunkFiles: resolved.chunkFiles, chunksDir: resolved.realChunksDir, dir: exportRoot };
}

const qqChatAutoSyncService = createQQChatAutoSyncService({
  fs,
  path,
  configPath: qqChatAutoConfigPath,
  debounceMs: 4000,
  validateDirectory: function (dir) { return readValidatedQQChatManifest(dir, true); },
  onChanged: function (payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('qqchat:auto-changed', payload);
  }
});

// 自动保存轻量元数据/日报快照；完整消息由收件箱中的“备份 QQ”手动导出。
ipcMain.handle('qqchat:backup-meta', async (event, payload = {}) => {
  try {
    const chats = Array.isArray(payload.chats) ? payload.chats.slice(0, 5000) : [];
    const snapshot = { format: 'mst-qqchats-meta-backup', version: 1, reason: String(payload.reason || 'update').slice(0, 60), createdAt: new Date().toISOString(), chats };
    const text = JSON.stringify(snapshot);
    if (Buffer.byteLength(text, 'utf8') > 20 * 1024 * 1024) return { ok: false, reason: 'QQ 元数据备份超过 20 MB' };
    await fs.promises.mkdir(qqChatMetaBackupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(qqChatMetaBackupDir, 'qq-meta-' + stamp + '.json');
    await fs.promises.writeFile(filePath, text, 'utf8');
    const files = (await fs.promises.readdir(qqChatMetaBackupDir)).filter(name => /^qq-meta-.*\.json$/i.test(name)).sort();
    for (const name of files.slice(0, Math.max(0, files.length - 20))) {
      await fs.promises.unlink(path.join(qqChatMetaBackupDir, name)).catch(function () {});
    }
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// IPC: 选择 JSONL 导出文件夹
ipcMain.handle('qqchat:pick-dir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择 qq-chat-exporter 导出的 JSONL 文件夹',
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true };
  ensureInboxDirAllowed(res.filePaths[0]);
  return { ok: true, dir: res.filePaths[0] };
});

// 自动同步只监听用户明确选择的导出目录，不启动、注入或控制 QQ 进程。
ipcMain.handle('qqchat:auto-pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择要自动同步的 QQ JSONL 导出文件夹',
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true };
  try {
    const syncStatus = await qqChatAutoSyncService.enable(res.filePaths[0]);
    return { ok: true, status: syncStatus };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

ipcMain.handle('qqchat:auto-status', async () => ({ ok: true, status: qqChatAutoSyncService.status() }));
ipcMain.handle('qqchat:auto-disable', async () => {
  try { return { ok: true, status: await qqChatAutoSyncService.disable() }; }
  catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
});
ipcMain.handle('qqchat:auto-report', async (event, result) => {
  try { return { ok: true, status: await qqChatAutoSyncService.report(result || {}) }; }
  catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
});

// IPC: 读取 JSONL 导出文件夹的 manifest.json（结构校验 + 返回 chunk 清单）
ipcMain.handle('qqchat:read-manifest', async (event, dir) => {
  try {
    const result = await readValidatedQQChatManifest(dir, false);
    return { ok: true, manifest: result.manifest, chunkFiles: result.chunkFiles, dir: result.dir };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// IPC: 读取单个 JSONL chunk 文件的内容（返回数组）
ipcMain.handle('qqchat:read-chunk', async (event, filePath) => {
  try {
    const requestedPath = path.resolve(String(filePath || ''));
    if (!fs.existsSync(requestedPath)) return { ok: false, reason: '文件不存在' };
    const realFilePath = await fs.promises.realpath(requestedPath);
    if (!allowedQQChatChunkFiles.has(realFilePath)) return { ok: false, reason: '该文件不在本次已验证的分片清单中' };
    const st = await fs.promises.lstat(requestedPath);
    if (!st.isFile() || st.isSymbolicLink() || st.size > QQCHAT_MAX_CHUNK_BYTES) return { ok: false, reason: '分片文件类型或大小无效' };
    const text = await fs.promises.readFile(realFilePath, 'utf-8');
    const lines = text.split(/\r?\n/);
    if (lines.length > QQCHAT_MAX_LINES_PER_CHUNK) return { ok: false, reason: '单个消息分片行数过多，拒绝读取' };
    const items = [];
    let invalidLines = 0;
    for (const line of lines) {
      const s = String(line || '').trim();
      if (!s) continue;
      try { items.push(JSON.parse(s)); } catch (e) { invalidLines++; }
    }
    if (qqChatMessagesRead + items.length > QQCHAT_MAX_TOTAL_MESSAGES) {
      return { ok: false, reason: '本次导入消息超过 50 万条，请拆分后导入' };
    }
    qqChatMessagesRead += items.length;
    return { ok: true, items, invalidLines };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});
