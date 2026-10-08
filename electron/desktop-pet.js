'use strict';

const path = require('path');
const fs = require('fs');

function registerDesktopPet({ app, BrowserWindow, ipcMain, screen, Menu, userDataPath, getMainWindow }) {
  const stateFile = path.join(userDataPath, 'desktop-pet.json');
  let win = null;
  let state = { enabled: true, scale: 1, quiet: false };
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.enabled = saved.enabled !== false;
    state.quiet = saved.quiet === true;
    state.scale = [0.75, 1, 1.25].includes(saved.scale) ? saved.scale : 1;
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      state.x = saved.x;
      state.y = saved.y;
    }
  } catch (_) { /* First launch uses defaults. */ }

  function persist() {
    try {
      fs.mkdirSync(userDataPath, { recursive: true });
      fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state));
      fs.renameSync(stateFile + '.tmp', stateFile);
    } catch (error) { console.warn('[desktop-pet] save failed:', error.message); }
  }
  function live() { return win && !win.isDestroyed(); }
  function notifyState() {
    const main = getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.send('pet:state', { ...state });
    if (live()) win.webContents.send('pet:state', { ...state });
  }
  function bounds(x = state.x, y = state.y) {
    const width = Math.round(240 * state.scale);
    const height = Math.round(320 * state.scale);
    const area = Number.isFinite(x) && Number.isFinite(y)
      ? screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea
      : screen.getPrimaryDisplay().workArea;
    return {
      x: Math.round(Math.max(area.x, Math.min(Number.isFinite(x) ? x : area.x + area.width - width - 24, area.x + area.width - width))),
      y: Math.round(Math.max(area.y, Math.min(Number.isFinite(y) ? y : area.y + area.height - height - 12, area.y + area.height - height))),
      width, height
    };
  }
  function rememberPosition() {
    if (!live()) return;
    const position = win.getPosition();
    state.x = position[0]; state.y = position[1];
    persist();
  }
  function show() {
    state.enabled = true;
    if (!live()) {
      win = new BrowserWindow({
        ...bounds(), title: '时芽 · My Study Table', frame: false, transparent: true,
        backgroundColor: '#00000000', thickFrame: false, resizable: false, maximizable: false,
        minimizable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
        show: false, webPreferences: {
          preload: path.join(__dirname, 'pet', 'preload.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: true,
          // A non-focused transparent pet still needs a live animation clock.
          backgroundThrottling: false
        }
      });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', event => event.preventDefault());
      win.webContents.on('did-finish-load', notifyState);
      win.once('ready-to-show', () => { if (live() && state.enabled) win.showInactive(); });
      win.on('closed', () => { win = null; });
      win.loadFile(path.join(__dirname, 'pet', 'index.html'));
    } else {
      win.setBounds(bounds());
      win.showInactive();
    }
    persist(); notifyState();
    return { ...state };
  }
  function hide() {
    rememberPosition();
    state.enabled = false;
    if (live()) win.hide();
    persist(); notifyState();
    return { ...state };
  }
  function openMain() {
    const main = getMainWindow();
    if (main && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore();
      main.show(); main.focus();
    }
  }
  function menu() {
    if (!live()) return;
    Menu.buildFromTemplate([
      { label: '时芽 · 专注精灵', enabled: false },
      { label: '打开学习桌', click: openMain },
      { label: '时芽的动作', submenu: [
        ['idle', '发呆 / 眨眼'], ['walk', '散步'], ['wave', '打招呼'],
        ['read', '看书'], ['sleep', '打个盹'], ['celebrate', '开心庆祝']
      ].map(([action, label]) => ({ label, click: () => animate(action) })) },
      { label: '安静陪伴', type: 'checkbox', checked: state.quiet, click: item => {
        state.quiet = item.checked; persist(); notifyState();
      } },
      { label: '桌宠大小', submenu: [0.75, 1, 1.25].map(scale => ({
        label: ({ 0.75: '小', 1: '标准', 1.25: '大' })[scale], type: 'radio', checked: state.scale === scale,
        click: () => { state.scale = scale; win.setBounds(bounds()); rememberPosition(); notifyState(); }
      })) },
      { type: 'separator' },
      { label: '收起时芽（可从托盘唤回）', click: hide }
    ]).popup({ window: win });
  }
  function isMain(event) {
    const main = getMainWindow();
    return main && !main.isDestroyed() && event.sender === main.webContents;
  }
  function isPet(event) { return live() && event.sender === win.webContents; }
  const animations = new Set(['idle', 'walk', 'wave', 'read', 'sleep', 'celebrate']);
  function animate(action) {
    if (live() && animations.has(action)) win.webContents.send('pet:animation', action);
  }
  ipcMain.handle('pet:status', event => {
    if (!isMain(event) && !isPet(event)) throw new Error('Unauthorized pet sender');
    return { ...state };
  });
  ipcMain.handle('pet:toggle', event => {
    if (!isMain(event)) throw new Error('Unauthorized pet sender');
    return state.enabled ? hide() : show();
  });
  ipcMain.handle('pet:set-enabled', (event, enabled) => {
    if (!isMain(event) || typeof enabled !== 'boolean') throw new Error('Invalid pet enable request');
    return enabled ? show() : hide();
  });
  ipcMain.handle('pet:action', (event, action) => {
    if (!isPet(event)) throw new Error('Unauthorized pet sender');
    if (action === 'menu') menu();
    else if (action === 'hide') hide();
    else if (action === 'open') openMain();
    else if (typeof action === 'string' && action.startsWith('animate:')) animate(action.slice(8));
    return { ...state };
  });
  ipcMain.on('pet:move', (event, delta) => {
    if (!isPet(event) || !delta || !Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return;
    const [x, y] = win.getPosition();
    const nextX = Math.round(x + Math.max(-200, Math.min(200, delta.x)));
    const nextY = Math.round(y + Math.max(-200, Math.min(200, delta.y)));
    const area = screen.getDisplayNearestPoint({ x: nextX, y: nextY }).workArea;
    const [width, height] = win.getSize();
    // setPosition internally reuses the rounded native bounds on Windows. At
    // fractional DPI that can grow the width on every move. Always supply the
    // intended dimensions rather than feeding the previous native size back.
    win.setBounds({
      x: Math.max(area.x, Math.min(nextX, area.x + area.width - width)),
      y: Math.max(area.y, Math.min(nextY, area.y + area.height - height)),
      width: Math.round(240 * state.scale), height: Math.round(320 * state.scale)
    });
  });
  ipcMain.on('pet:move-end', event => { if (isPet(event)) rememberPosition(); });
  ipcMain.on('pet:pointer', (event, interactive) => {
    if (isPet(event) && typeof interactive === 'boolean') win.setIgnoreMouseEvents(!interactive, { forward: true });
  });
  const cues = new Set(['focus', 'pause', 'rest', 'complete']);
  ipcMain.on('pet:cue', (event, cue) => {
    if (isMain(event) && live() && state.enabled && cues.has(cue)) win.webContents.send('pet:cue', cue);
  });
  function relocate() { if (live()) { win.setBounds(bounds()); rememberPosition(); } }
  function restore(forceShow = false) {
    screen.on('display-removed', relocate);
    screen.on('display-metrics-changed', relocate);
    if (state.enabled || forceShow) show();
  }
  app.on('before-quit', () => { rememberPosition(); if (live()) win.destroy(); });
  return { show, hide, restore };
}

module.exports = { registerDesktopPet };
