'use strict';

// 回归守护：教材 PDF 阅读器的全屏能力。
//
// 曾经的问题：main.js 的主窗口把一切权限请求都无条件拒绝。Chromium/Electron 把
// 「元素全屏（requestFullscreen）」也算作一种权限，被拒后渲染进程拿到的 Promise
// 既不 resolve 也不 reject（永久挂起，见 electron#37719），于是阅读器的全屏按钮
// 点了毫无反应——既进不了原生全屏，也永远走不到 catch 里的「类全屏」兜底。
//
// 这里用静态断言锁定两处修复，避免它们被无意改回去：
//   1) 主窗口放行 'fullscreen' 权限（其余仍全部拒绝）；网页正文阅读窗口仍然全拒。
//   2) 渲染进程的切换逻辑带超时兜底，不会因为 Promise 挂起而卡死。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const studySource = fs.readFileSync(path.join(root, 'js', 'books-study.js'), 'utf8');

test('主窗口放行 fullscreen 权限，其余权限仍然拒绝', () => {
  const requestHandler = mainSource.match(/mainWindow\.webContents\.session\.setPermissionRequestHandler\((.*)\);/);
  assert.ok(requestHandler, '主窗口应设置权限请求处理器');
  assert.match(requestHandler[1], /permission === 'fullscreen'/, '权限请求处理器必须放行 fullscreen');

  const checkHandler = mainSource.match(/mainWindow\.webContents\.session\.setPermissionCheckHandler\((.*)\);/);
  assert.ok(checkHandler, '主窗口应设置权限检查处理器');
  assert.match(checkHandler[1], /permission === 'fullscreen'/, '权限检查处理器必须放行 fullscreen');

  // 放行必须是白名单式：不能退化成无条件允许
  assert.doesNotMatch(requestHandler[1], /callback\(true\)/, '权限请求不能无条件允许');
  assert.doesNotMatch(checkHandler[1], /=>\s*true\b/, '权限检查不能无条件允许');
});

test('网页正文阅读窗口仍然拒绝一切权限', () => {
  const readerBlock = mainSource.slice(mainSource.indexOf("ipcMain.handle('web:read'"));
  assert.match(readerBlock, /setPermissionRequestHandler\(\(wc, permission, cb\) => cb\(false\)\)/);
  assert.match(readerBlock, /setPermissionCheckHandler\(\(\) => false\)/);
});

test('全屏切换带超时兜底，Promise 挂起时回退到类全屏', () => {
  assert.match(studySource, /function _bkRequestNativeFullscreen\(/, '应封装原生全屏请求');
  assert.match(studySource, /setTimeout\(\(\) => finish\(false\), fallbackMs\)/, '原生全屏请求必须有超时兜底');
  assert.match(studySource, /if \(!ok\) _bkSetFakeFs\(true\)/, '原生全屏不可用时必须回退到类全屏');
  assert.match(studySource, /_bkRequestNativeFullscreen\(root, \d+\)/, '切换逻辑应使用带兜底的请求封装');
});
