// Central renderer bootstrap. Feature scripts register behavior; this file owns startup order.
(function registerApplicationBootstrap(global) {
  'use strict';

  const platform = global.StudyPlatform;
  if (!platform) throw new Error('StudyPlatform must be loaded before bootstrap.js');

  platform.registerInitializer('secure-credentials', async () => {
    if (global.SecretVault && typeof global.SecretVault.initialize === 'function') {
      await global.SecretVault.initialize();
    }
  }, 1);

  platform.registerInitializer('versioned-data-store', async () => {
    if (global.StudyData && typeof global.StudyData.initialize === 'function') {
      await global.StudyData.initialize();
    }
  }, 2);

  platform.registerInitializer('theme', () => {
    if (typeof applyTheme === 'function' && typeof getTheme === 'function') applyTheme(getTheme());
  }, 10);

  platform.registerInitializer('sidebar', () => {
    if (platform.storage.getRaw('study_sidebar_open') === 'true') {
      sidebarOpen = true;
      const sidebar = document.getElementById('sidebar');
      if (sidebar) sidebar.classList.add('open');
    }
    if (typeof initSidebarHover === 'function') initSidebarHover();
  }, 20);

  platform.registerInitializer('core-views', () => {
    if (typeof initChangelog === 'function') initChangelog();
    const views = [
      ['renderTodos', typeof renderTodos === 'function' ? renderTodos : null],
      ['refreshRepeatTodos', typeof refreshRepeatTodos === 'function' ? refreshRepeatTodos : null],
      ['renderNotes', typeof renderNotes === 'function' ? renderNotes : null],
      ['renderAiChat', typeof renderAiChat === 'function' ? renderAiChat : null],
      ['renderToday', typeof renderToday === 'function' ? renderToday : null]
    ];
    for (const [name, render] of views) {
      if (!render) continue;
      try { render(); } catch (error) { console.error('[bootstrap] ' + name + ' failed:', error); }
    }
  }, 30);

  platform.registerInitializer('extensions', async () => {
    if (global.ExtManager && typeof global.ExtManager.init === 'function') await global.ExtManager.init();
    if (typeof renderSidebarNav === 'function') renderSidebarNav();
  }, 40);

  platform.registerInitializer('navigation', () => {
    if (typeof loadNavConfig === 'function' && typeof switchTab === 'function') {
      const config = loadNavConfig();
      if (config.homeTab) switchTab(config.homeTab);
    }
    if (typeof updateSidebarAiBadge === 'function') updateSidebarAiBadge();
  }, 50);

  platform.registerInitializer('sync', () => {
    if (global.Sync && typeof global.Sync.init === 'function') global.Sync.init();
  }, 60);

  platform.registerInitializer('calendar-color-picker', () => {
    if (typeof CAL_EVENT_COLORS === 'undefined') return;
    const picker = document.getElementById('calEventColorPicker');
    if (!picker) return;
    picker.innerHTML = CAL_EVENT_COLORS.map((color, index) =>
      `<label class="cal-event-color-swatch" style="background:${color.dot}" title="${color.key}">` +
      `<input type="radio" name="calEventColor" value="${color.key}" ${index === 4 ? 'checked' : ''}>` +
      '</label>'
    ).join('');
  }, 70);

  platform.registerInitializer('icons', () => {
    if (global.lucide && typeof global.lucide.createIcons === 'function') global.lucide.createIcons();
  }, 80);

  platform.registerInitializer('daily-memory', () => {
    if (typeof checkDailyIntegration === 'function') setTimeout(checkDailyIntegration, 3000);
  }, 90);

  platform.registerInitializer('service-worker', () => {
    if (typeof Env === 'undefined' || Env.isElectron || !location.protocol.startsWith('http')) return;
    if (!('serviceWorker' in navigator)) return;
    const register = () => navigator.serviceWorker.register('service-worker.js')
      .catch(error => console.warn('[PWA] Service Worker 注册失败:', error));
    if (document.readyState === 'complete') register();
    else global.addEventListener('load', register, { once: true });
  }, 100);

  setTimeout(() => {
    platform.initialize().then(results => {
      const failures = results.filter(result => !result.ok);
      if (failures.length) console.warn('[bootstrap] initialization failures:', failures.map(item => item.name));
    });
  }, 0);
})(window);
