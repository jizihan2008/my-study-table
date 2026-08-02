// ═══════════ Auto Update Module ═══════════
// 管理更新状态机：启动检查 / 定时检查 / 手动检查 / 下载进度 / 非安装版降级提示
(function () {
  const CHECK_INTERVAL = 60 * 60 * 1000; // 定时检查间隔：1 小时

  let supported = false;      // 当前环境是否支持自动更新（仅 NSIS 安装版）
  let currentVersion = '';
  let state = 'idle';         // idle / checking / available / not-available / downloading / downloaded / error / unsupported
  let updateInfo = null;      // 新版本信息
  let progress = 0;           // 下载进度百分比
  let errorMsg = '';
  let unsubscribe = null;
  let modalOpen = false;

  const api = window.electronAPI || null;

  function init() {
    if (!api || typeof api.getUpdateState !== 'function') return;
    api.getUpdateState().then((s) => {
      supported = !!s.supported;
      currentVersion = s.currentVersion || '';
      updateVersionLabel();
      if (supported) {
        unsubscribe = api.onUpdateEvent(handleEvent);
        renderSettings();
        // 启动后延迟 5 秒自动检查一次
        setTimeout(() => checkForUpdates(false), 5000);
        // 定时检查
        setInterval(() => checkForUpdates(false), CHECK_INTERVAL);
      } else {
        state = 'unsupported';
        renderSettings();
      }
    }).catch(() => {
      supported = false;
      state = 'unsupported';
      renderSettings();
    });
  }

  function handleEvent(payload) {
    if (!payload || !payload.type) return;
    switch (payload.type) {
      case 'checking':
        state = 'checking';
        break;
      case 'available':
        state = 'available';
        updateInfo = payload.info || null;
        showUpdateModal();
        break;
      case 'not-available':
        state = 'not-available';
        updateInfo = payload.info || null;
        break;
      case 'progress':
        state = 'downloading';
        progress = payload.percent || 0;
        break;
      case 'downloaded':
        state = 'downloaded';
        updateInfo = payload.info || null;
        break;
      case 'error':
        state = 'error';
        errorMsg = payload.message || '未知错误';
        break;
      case 'unsupported':
        supported = false;
        state = 'unsupported';
        break;
      default:
        return;
    }
    renderSettings();
    renderModal();
  }

  function updateVersionLabel() {
    const el = document.getElementById('updateCurrentVersion');
    if (el) el.textContent = currentVersion ? 'v' + currentVersion : '-';
  }

  // ── 检查更新（manual=true 时点击设置页按钮，manual=false 为自动检查）──
  function checkForUpdates(manual) {
    if (!supported || !api) {
      if (manual) showManualUnsupported();
      return;
    }
    if (state === 'checking') return; // 避免并发
    state = 'checking';
    renderSettings();
    api.checkForUpdate().then((res) => {
      if (!res || !res.ok) {
        state = 'error';
        errorMsg = (res && res.reason) || '检查失败';
        renderSettings();
        renderModal();
      }
    }).catch(() => {
      state = 'error';
      errorMsg = '检查更新失败';
      renderSettings();
      renderModal();
    });
  }

  // 手动检查时若当前版本不支持自动更新，弹出说明
  function showManualUnsupported() {
    renderSettings();
    showUpdateModal();
  }

  // ── 设置页状态区 ──
  function renderSettings() {
    const statusEl = document.getElementById('updateStatus');
    if (!statusEl) return;
    const textEl = document.getElementById('updateStatusText');
    const btn = document.getElementById('checkUpdateBtn');

    if (!supported) {
      statusEl.className = 'settings-status';
      statusEl.textContent = '当前版本（便携版/解压版）不支持自动更新，请前往发布页手动下载最新版。';
      if (textEl) textEl.textContent = '不支持自动更新';
      if (btn) { btn.disabled = false; btn.textContent = '检查更新'; }
      return;
    }
    if (btn) btn.disabled = (state === 'checking' || state === 'downloading');

    const map = {
      idle: ['', '等待检查…'],
      checking: ['info', '正在检查更新…'],
      available: ['', '发现新版本' + (updateInfo && updateInfo.version ? ' v' + updateInfo.version : '')],
      'not-available': ['success', '已是最新版本'],
      downloading: ['info', '正在下载更新 ' + progress + '%'],
      downloaded: ['success', '更新已下载，可重启安装'],
      error: ['error', errorMsg],
      unsupported: ['', '不支持自动更新']
    };
    const cfg = map[state] || ['', ''];
    statusEl.className = 'settings-status ' + (cfg[0] ? 'status-' + cfg[0] : '');
    statusEl.textContent = cfg[1];
    if (textEl) {
      textEl.textContent = supported ? '自动检查已开启（每小时）' : '不支持自动更新';
    }
  }

  // ── 更新弹窗 ──
  function showUpdateModal() {
    const modal = document.getElementById('updateModal');
    if (!modal) return;
    modalOpen = true;
    modal.classList.add('open');
    renderModal();
  }

  function closeUpdateModal(e) {
    if (e && e.target !== document.getElementById('updateModal')) return;
    modalOpen = false;
    document.getElementById('updateModal').classList.remove('open');
  }

  function renderModal() {
    const body = document.getElementById('updateModalBody');
    if (!body || !modalOpen) return;
    const ver = (updateInfo && updateInfo.version) ? 'v' + updateInfo.version : '';
    let html = '';
    let title = '软件更新';

    if (!supported) {
      html = '<div class="hint" style="margin:4px 0;">当前版本（便携版/解压版）不支持一键自动更新。<br><br>请前往 <b>GitHub Releases</b> 页面手动下载最新的安装包完成更新。</div>';
      html += '<div style="margin-top:14px;text-align:right;"><button class="btn-save-settings" onclick="closeUpdateModal()" style="padding:6px 16px;">知道了</button></div>';
    } else if (state === 'checking') {
      html = '<div class="hint" style="margin:4px 0;">正在检查更新…</div>';
    } else if (state === 'available') {
      html = '<div style="font-size:14px;color:var(--text);">发现新版本 <b>' + ver + '</b>，是否立即下载？</div>';
      html += '<div style="margin-top:14px;text-align:right;">'
        + '<button class="btn-save-settings" onclick="closeUpdateModal()" style="padding:6px 16px;background:transparent;border:1px solid var(--border);color:var(--text);">稍后</button> '
        + '<button class="btn-save-settings" onclick="updaterStartDownload()" style="padding:6px 16px;"><i data-lucide="download" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle;"></i> 立即下载</button>'
        + '</div>';
    } else if (state === 'downloading') {
      html = '<div class="hint" style="margin:4px 0;">正在下载更新 ' + ver + '…</div>';
      html += '<div class="update-progress"><div class="update-progress-fill" style="width:' + progress + '%"></div></div>';
      html += '<div style="margin-top:8px;font-size:13px;color:var(--text);">' + progress + '%</div>';
      html += '<div style="margin-top:14px;text-align:right;"><button class="btn-save-settings" onclick="closeUpdateModal()" style="padding:6px 16px;background:transparent;border:1px solid var(--border);color:var(--text);">后台下载</button></div>';
    } else if (state === 'downloaded') {
      html = '<div style="font-size:14px;color:var(--text);">更新 ' + ver + ' 已下载完成，重启应用即可完成安装。</div>';
      html += '<div style="margin-top:14px;text-align:right;">'
        + '<button class="btn-save-settings" onclick="closeUpdateModal()" style="padding:6px 16px;background:transparent;border:1px solid var(--border);color:var(--text);">稍后</button> '
        + '<button class="btn-save-settings" onclick="updaterInstallNow()" style="padding:6px 16px;"><i data-lucide="power" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle;"></i> 重启并安装</button>'
        + '</div>';
    } else if (state === 'error') {
      html = '<div class="hint" style="margin:4px 0;">检查更新失败：' + (errorMsg || '网络错误') + '</div>';
      html += '<div style="margin-top:14px;text-align:right;"><button class="btn-save-settings" onclick="closeUpdateModal()" style="padding:6px 16px;">关闭</button></div>';
    } else {
      html = '<div class="hint" style="margin:4px 0;">当前已是最新版本。</div>';
      html += '<div style="margin-top:14px;text-align:right;"><button class="btn-save-settings" onclick="closeUpdateModal()" style="padding:6px 16px;">确定</button></div>';
    }

    body.innerHTML = html;
    if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
  }

  // ── 全局方法（供 HTML onclick 调用）──
  window.checkForUpdatesNow = () => { state = 'idle'; renderSettings(); checkForUpdates(true); };
  window.updaterStartDownload = () => {
    if (!api) return;
    progress = 0;
    state = 'downloading';
    renderSettings();
    renderModal();
    api.downloadUpdate().catch(() => {});
  };
  window.updaterInstallNow = () => {
    if (api) api.installUpdate().catch(() => {});
  };
  window.closeUpdateModal = closeUpdateModal;

  // 暴露初始化（由 utils.js 的初始化流程调用）
  window.initUpdater = init;

  // 若未被外部调用，则在 DOM 就绪后自启
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initUpdater());
  } else {
    setTimeout(initUpdater, 0);
  }
})();
