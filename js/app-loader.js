// Hydrate the synchronous memory view before any business module reads data.
(async function loadApplication() {
  const scripts = [...document.querySelectorAll('script[data-app-src]')];
  // Fetch in parallel without executing modules before IndexedDB hydration.
  // Keep the sequential execution below so dependencies and fail-stop behavior remain intact.
  const preloads = scripts.map(placeholder => {
    const link = document.createElement('link');
    link.rel = 'preload';
    link.as = 'script';
    link.href = placeholder.dataset.appSrc;
    document.head.append(link);
    return link;
  });
  try {
    await window.StudyData.initialize();
    window.StudyPlatform.events.on('storage:failed', ({ error }) => {
      let banner = document.getElementById('storageSaveFailure');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'storageSaveFailure';
        banner.setAttribute('role', 'alert');
        banner.style.cssText = 'position:fixed;bottom:16px;left:16px;right:16px;z-index:99999;padding:12px;background:var(--bg,#fff);color:var(--text,#222);border:1px solid var(--border,#ccc);border-radius:8px;box-shadow:0 4px 16px #0002;';
        document.body.append(banner);
      }
      const text = document.createElement('span');
      text.textContent = '本地保存失败，当前页的数据尚未全部保存：' + error.name + '：' + error.message + '。';
      const retry = document.createElement('button');
      retry.textContent = '重试保存';
      retry.onclick = async () => {
        retry.disabled = true;
        try { await window.StudyData.retryFailed(); banner.remove(); }
        catch (_) { retry.disabled = false; }
      };
      banner.replaceChildren(text, retry);
    });
    const dismissRecoveredError = () => {
      if (!window.StudyData.status().lastError) document.getElementById('storageSaveFailure')?.remove();
    };
    window.StudyPlatform.events.on('storage:recovered', dismissRecoveredError);
    window.StudyPlatform.events.on('storage:committed', dismissRecoveredError);
    for (const placeholder of scripts) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = placeholder.dataset.appSrc;
        script.async = false;
        script.onload = resolve;
        script.onerror = () => reject(new Error('模块加载失败：' + script.src));
        placeholder.replaceWith(script);
      });
    }
    window.dispatchEvent(new Event('study:ready'));
  } catch (error) {
    console.error('[startup]', error);
    const message = document.createElement('div');
    message.setAttribute('role', 'alert');
    message.style.cssText = 'position:fixed;inset:0;z-index:99999;background:var(--bg,#fff);color:var(--text,#222);padding:32px;overflow:auto;';
    const text = document.createElement('p');
    text.textContent = '无法读取或迁移本地数据，应用已暂停启动以保护原有数据。' + (error.name || '错误') + '：' + error.message;
    const retry = document.createElement('button');
    retry.textContent = '重新加载';
    retry.onclick = () => location.reload();
    message.append(text, retry);
    document.body.append(message);
  } finally {
    preloads.forEach(link => link.remove());
  }
})();
