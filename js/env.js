// ═══════════════════════════════════════════════════════════════════
// env.js — 环境适配层
// 判定当前运行环境（Electron 桌面 / PWA 手机端 / 浏览器），并为所有
// 桌面专属能力（window.electronAPI）提供安全访问器，纯浏览器/PWA 下
// 调用不抛错，返回 null / 降级结果。
//
// 依赖：无（最先加载）。被 core.js / settings.js / sync.js / webrtc.js
// 及各模块引用。
// ═══════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';

  // ── 环境判定 ─────────────────────────────────────────────
  const isElectron = !!(global.window && global.window.electronAPI && global.window.electronAPI.isElectron);

  // 是否为 PWA / 浏览器环境（非 Electron）
  const isPwa = !isElectron;

  // 是否为移动设备（触屏 + 窄屏优先）
  function detectIsMobile() {
    if (typeof window === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const mobileUA = /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    const touch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    const narrow = window.innerWidth <= 800;
    return mobileUA || (touch && narrow);
  }
  const isMobile = detectIsMobile();

  // 是否在 PWA standalone（已添加到主屏幕）中运行
  const isStandalone = (typeof navigator !== 'undefined' && (
    navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
  ));

  // ── 桌面能力安全访问器 ─────────────────────────────────────
  // 在 Electron 下返回 window.electronAPI 对应方法；纯浏览器/PWA 下返回 null。
  function api(method) {
    const ea = (typeof window !== 'undefined') ? window.electronAPI : null;
    if (!ea || !ea.isElectron) return null;
    if (typeof ea[method] === 'function') return ea[method];
    return null;
  }

  // 判断当前环境是否具备某桌面能力
  function hasCapability(method) {
    return typeof api(method) === 'function';
  }

  // 桌面专属能力清单：PWA 端应隐藏 / 禁用对应入口
  const DESKTOP_ONLY = {
    inbox: ['inboxMailTest', 'inboxMailFetch', 'captureListWindows', 'captureLongShot',
            'capturePickDir', 'captureListFiles', 'captureSaveImage', 'captureReadImage', 'captureReadFileText'],
    codegen: ['codebuddyLocate', 'codebuddyInstall', 'codebuddyRun', 'codebuddyCheckLogin',
              'codebuddyOpenLoginTerminal', 'srcList', 'srcRead', 'srcExportSnapshot'],
    extensions: ['extList', 'extRead', 'extWrite', 'extBackup', 'extRemove', 'extOpenDir', 'extImport'],
    pdfRead: ['pickPdfFile', 'readPdfFile'],
    updater: ['checkForUpdate', 'downloadUpdate', 'installUpdate']
  };

  // ── 暴露 ──────────────────────────────────────────────────
  const Env = {
    isElectron,
    isPwa,
    isMobile,
    isStandalone,
    api,
    hasCapability,
    DESKTOP_ONLY,
    // 便捷：桌面能力安全调用（方法存在才调用，否则返回 undefined）
    call(method, ...args) {
      const fn = api(method);
      return fn ? fn.apply(window.electronAPI, args) : undefined;
    }
  };

  global.Env = Env;
  // 兼容旧式全局判断
  global.isPwa = isPwa;
  global.isMobile = isMobile;
})(typeof window !== 'undefined' ? window : globalThis);
