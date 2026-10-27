/* ═══════════════════════════════════════════════════════════════
 * service-worker.js — PWA 离线缓存
 * 仅缓存静态资源（js/css/lib/index 等），绝不缓存任何用户数据
 * （用户数据在 localStorage / IndexedDB，由应用自行管理）。
 * 策略：版本化资源缓存优先；其他静态资源后台更新；页面限时等待网络。
 * ═══════════════════════════════════════════════════════════════ */
'use strict';

const VERSION = 'mst-v265';
const CACHE_STATIC = VERSION + '-static';

// 需预缓存的静态资源（相对应用根）。更新资源时请在此追加版本化文件名。
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./reset-site-data.html",
  "./manifest.webmanifest?v=20260926-icon-v3",
  "./icons/icon-192-v3.png",
  "./icons/apple-touch-icon-v3.png",
  "./css/style.css?v=20261026-calendar-location-r1",
  "./css/workspace.css?v=20261020-table-context-only-r1",
  "./css/appearance.css?v=20260929-r2",
  "./lib/katex/katex.min.css",
  "./lib/markdown/highlight-github-dark-dimmed.min.css",
  "./lib/lucide/lucide.min.js",
  "./lib/markdown/markdown-it.min.js",
  "./lib/markdown/markdown-it-footnote.min.js",
  "./lib/markdown/purify.min.js",
  "./lib/markdown/highlight.min.js",
  "./lib/katex/katex.min.js",
  "./js/markdown.js?v=20261019-note-links-r1",
  "./js/note-reading-renderer.js?v=20261015-fold-toc-r1",
  "./js/note-view-position.js?v=20261004-r1",
  "./js/note-rich-editor.js?v=20261020-table-context-only-r1",
  "./js/platform.js?v=20261014-idb-r1",
  "./js/secrets.js?v=20261016-web-r1",
  "./js/data-store.js?v=20261014-idb-r1",
  "./js/settings-sync.js?v=20261020-idle-calendar-r1",
  "./js/diagnostics.js?v=20260825-r1",
  "./js/env.js?v=20260911-r2",
  "./js/theme-model.js?v=20260914-r5",
  "./js/liquid-glass.js?v=20260929-r1",
  "./js/nav-shortcuts.js?v=20260920-r1",
  "./js/core.js?v=20261014-idb-r1",
  "./js/trash.js?v=20261010-r1",
  "./js/todos.js?v=20261017-status-r1",
  "./js/notes.js?v=20261021-note-ask-r1",
  "./lib/file-library-order.js?v=20261004-r1",
  "./js/file-library.js?v=20261004-r1",
  "./js/links.js?v=20260813-r1",
  "./js/timer-types.js?v=20261013-custom-types-r1",
  "./js/today.js?v=20261026-calendar-location-r1",
  "./js/ai-utils.js?v=20261012-protocol-r2-timer",
  "./js/ai-tree.js?v=20261012-visual-fold-r1",
  "./js/ai-conv.js?v=20261012-protocol-r2",
  "./js/ai-attach.js?v=20261019-paste-capsule-r1",
  "./js/ai-render.js?v=20261019-paste-capsule-r1",
  "./js/web-access.js?v=20261016-web-r1",
  "./js/ai-tools.js?v=20261016-web-r1",
  "./js/ai-search.js?v=20261017-ai-notify-r1",
  "./js/ai-client.js?v=20260914-r3",
  "./js/ai-stream.js?v=20261012-protocol-r2",
  "./js/ai-api.js?v=20261016-web-r1",
  "./js/ai-send.js?v=20261019-ipad-send-r1",
  "./js/skills.js?v=20261010-r1",
  "./js/prompts.js?v=20261014-completed-review-r1",
  "./js/music.js",
  "./js/memory.js?v=20261014-complete-summary-r1",
  "./js/bg-media-idb.js?v=20260906-r2",
  "./js/appearance.js?v=20260929-r1",
  "./js/backup-idb.js?v=20260812-r1",
  "./js/habit-status-text.js?v=20260920-r1",
  "./js/todo-queue.js?v=20261017-todo-status-r1",
  "./js/storage-usage.js?v=20261014-idb-r1",
  "./js/settings.js?v=20261020-report-history-r1",
  "./js/utils.js?v=20261020-fold-menu-r1",
  "./lib/qq-chat-media.js?v=20261017-images-r1",
  "./js/qq-chats.js?v=20261017-images-r1",
  "./js/inbox.js?v=20261017-inbox-images-r1",
  "./js/books-pdfstore.js?v=20260812-r2",
  "./js/books.js?v=20260814-r1",
  "./js/books-pdf.js?v=20260914-r7",
  "./js/books-kb.js?v=20260914-r2",
  "./js/books-ai.js?v=20260914-r8",
  "./js/books-annot.js?v=20260914-r5",
  "./js/keywords.js?v=20260818-r1",
  "./js/books-study.js?v=20260821-r2",
  "./js/calendar.js?v=20261026-calendar-location-r1",
  "./js/taskline.js?v=20261012-focus",
  "./js/timer.js?v=20261014-shared-picker-r1",
  "./js/habits.js?v=20261019-habit-debug-r1",
  "./js/stats.js?v=20261012-focus",
  "./js/updater.js?v=20260802-r1",
  "./lib/supabase/supabase.js",
  "./lib/cloudbase/cloudbase.js",
  "./js/cloud-client.js?v=20260913-r2",
  "./js/friends-polling-policy.js?v=20260910-r1",
  "./js/friends.js?v=20260913-r4",
  "./js/friends-chat.js?v=20260910-r1",
  "./js/ext-api.js?v=20260804-r1",
  "./js/ext-sandbox.js?v=20260825-r1",
  "./js/patch-engine.js?v=20260804-r1",
  "./js/builtin-extensions.js?v=20260804-r1",
  "./js/extension-repository.js?v=20260923-r1",
  "./js/ext-manager.js?v=20260923-r1",
  "./js/codegen.js?v=20260808-r14",
  "./js/store.js?v=20260913-r2",
  "./js/sync-policy.js?v=20261008-r1",
  "./js/sync-diff.js?v=20261008-r1",
  "./js/sync-collections.js?v=20261014-idb-r1",
  "./js/sync-dom.js?v=20260930-r1",
  "./js/sync.js?v=20261014-settings-r1",
  "./js/sync-logs.js?v=20261017-cloud-manage-r1",
  "./js/bootstrap.js?v=20261014-idb-r1",
  "./js/desktop-pet.js?v=20261005-r1",
  "./lib/cet/vocabulary.js?v=20261008-r1",
  "./js/translation.js?v=20261018-note-selection-r1",
  "./js/app-loader.js?v=20261026-startup-r1",
  "./lib/pdfjs/pdf.min.mjs",
  "./lib/pdfjs/pdf.worker.min.mjs",
  "./icons/icon-512-v3.png"
];

// Bound install traffic and reuse unchanged versioned assets from previous releases.
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_STATIC);
    const pending = PRECACHE_URLS.slice();
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (pending.length) {
        const url = pending.shift();
        try {
          const cached = new URL(url, self.location.href).searchParams.has('v')
            ? await caches.match(url) : null;
          if (cached) await cache.put(url, cached);
          else await cache.add(url);
        } catch (_) { /* A missing optional asset must not block installation. */ }
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => /^mst-v\d+-static$/.test(key) && key !== CACHE_STATIC)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  if (req.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const relative = url.pathname.slice(scope.pathname.length);
  const navigation = req.mode === 'navigate';
  // Leave dynamic/API requests alone, even when they share the app's origin.
  if (!navigation && !/^(?:js|css|lib|icons)\//.test(relative) &&
      !['', 'index.html', 'reset-site-data.html', 'manifest.webmanifest'].includes(relative)) return;

  const response = (async () => {
    const cache = await caches.open(CACHE_STATIC);
    const cached = await cache.match(req);
    const refresh = async () => {
      const res = await fetch(req);
      if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
        await cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    };
    if (!navigation) {
      if (cached) {
        if (!url.searchParams.has('v')) event.waitUntil(refresh().catch(() => {}));
        return cached;
      }
      return refresh();
    }
    // HTML still checks for new releases; slow networks cannot hold a cached app hostage.
    const fallback = cached || (relative === '' || relative === 'index.html'
      ? await cache.match(new URL('index.html', scope).href) : null);
    const network = refresh();
    event.waitUntil(network.catch(() => {}));
    if (!fallback) return network;
    let timer;
    try {
      return await Promise.race([
        network.then(res => res.ok ? res : fallback).catch(() => fallback),
        new Promise(resolve => { timer = setTimeout(() => resolve(fallback), 1800); })
      ]);
    } finally { clearTimeout(timer); }
  })();
  event.respondWith(response);
});
