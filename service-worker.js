/* ═══════════════════════════════════════════════════════════════
 * service-worker.js — PWA 离线缓存
 * 仅缓存静态资源（js/css/lib/index 等），绝不缓存任何用户数据
 * （用户数据在 localStorage / IndexedDB，由应用自行管理）。
 * 策略：核心静态资源 install 时预缓存；运行时 network-first 回退缓存。
 * ═══════════════════════════════════════════════════════════════ */
'use strict';

const VERSION = 'mst-v14';
const CACHE_STATIC = VERSION + '-static';

// 需预缓存的静态资源（相对应用根）。更新资源时请在此追加版本化文件名。
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css?v=20260813-r16',
  './js/env.js?v=20260811-r1',
  './js/core.js?v=20260812-r10',
  './js/sync.js?v=20260811-r1',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// 安装：预缓存静态资源
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_STATIC).then(function (cache) {
      // 逐个 put，失败的条目不影响整体安装
      return Promise.all(PRECACHE_URLS.map(function (url) {
        return cache.add(url).catch(function () { /* 忽略单个失败 */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

// 激活：清理旧缓存
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k.indexOf(VERSION) === -1; })
          .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

// 网络优先，失败回退缓存；仅缓存 GET 静态请求
self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 仅同源请求走 SW；跨域（unpkg 等）直接用网络
  if (url.origin !== self.location.origin) return;
  // 不缓存 Supabase API / WebRTC 信令等动态请求
  if (url.pathname.indexOf('/supabase.co') !== -1) return;

  event.respondWith(
    fetch(req)
      .then(function (res) {
        if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
          const clone = res.clone();
          caches.open(CACHE_STATIC).then(function (cache) { cache.put(req, clone); });
        }
        return res;
      })
      .catch(function () {
        return caches.match(req).then(function (cached) {
          return cached || caches.match('./index.html');
        });
      })
  );
});
