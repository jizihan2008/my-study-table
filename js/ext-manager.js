// ═══════════════════════════════════════════════════════════
//  ExtManager：扩展管理器
//  负责：扫描本地扩展 → 装载/卸载（执行扩展代码）→ 启用/禁用
//  → 管理动态 UI（侧边栏项 / 独立面板 / 工具栏按钮）。
//  插件与补丁统一通过 manifest.type 区分。
//  扩展代码以 new Function 注入，通过 extAPI 白名单访问能力，
//  补丁通过 PatchEngine 做函数覆盖。
// ═══════════════════════════════════════════════════════════

window.ExtManager = (function () {
  const _registry = {};       // id -> { meta, mainCode, enabled, error, navItems:[], sections:[], toolbarButtons:[] }
  const _allNavItems = [];    // 由插件注册的动态侧边栏项
  const _allSections = [];    // 由插件注册的动态面板
  const _allToolbarButtons = [];

  // 已执行过的扩展（避免重复执行 main code）
  const _executed = {};

  // ── 内置扩展状态（localStorage）──
  function loadBuiltinState(id) {
    try {
      const v = localStorage.getItem('study_ext_builtin_' + id);
      if (v === 'disabled') return { enabled: false, removed: false };
      if (v === 'removed') return { enabled: false, removed: true };
    } catch (e) {}
    return { enabled: true, removed: false };
  }
  function saveBuiltinState(id, state) {
    try { localStorage.setItem('study_ext_builtin_' + id, state); } catch (e) {}
  }

  // ── 扫描本地扩展（走 IPC）+ 合并内置扩展 ──
  async function loadAll() {
    try {
      // 磁盘扩展（用户安装）
      if (typeof window.electronAPI !== 'undefined' && window.electronAPI.extList) {
        const list = await window.electronAPI.extList();
        for (const item of list) {
          const enabled = item.manifest && item.manifest.enabled !== false;
          const mainCode = item.hasMain ? await window.electronAPI.extRead({ id: item.id, file: 'main.js' }) : '';
          _registry[item.id] = {
            id: item.id,
            meta: item.manifest || { id: item.id, name: item.id, type: 'plugin', version: '0.0.0', description: '', enabled: true },
            mainCode,
            enabled,
            error: item.error || null,
            builtin: false,
            navItems: [],
            sections: [],
            toolbarButtons: []
          };
        }
      }
      // 内置扩展（自带插件）
      const builtins = (typeof window.BUILTIN_EXTENSIONS !== 'undefined') ? window.BUILTIN_EXTENSIONS : [];
      builtins.forEach(b => {
        const state = loadBuiltinState(b.id);
        if (state.removed) return; // 已移除（恢复出厂可从扩展页操作）
        _registry[b.id] = {
          id: b.id,
          meta: Object.assign({ id: b.id, enabled: state.enabled, builtin: true }, b.meta || {}),
          mainCode: b.main || '',
          enabled: state.enabled,
          error: null,
          builtin: true,
          navItems: [],
          sections: [],
          toolbarButtons: []
        };
      });
      return { ok: true, count: Object.keys(_registry).length };
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e) };
    }
  }

  function get(id) { return _registry[id] || null; }
  function list() { return Object.values(_registry); }

  // ── 装载（执行 main code）──
  // autoLoad=false 时只注册已启用扩展；discovery 时调用
  async function mount(id) {
    const ext = _registry[id];
    if (!ext) return { ok: false, reason: '扩展不存在: ' + id };
    if (!ext.enabled) return { ok: false, reason: '扩展已禁用' };
    // 先卸载旧的状态（若已执行过）
    unmount(id);
    ext.error = null;
    window.__extCtx = { id, name: ext.meta.name || id };
    try {
      executeCode(ext.mainCode, id);
      // 装载后调用扩展的生命周期钩子 mount（若存在，通过 extAPI 全局对象识别）
      if (typeof window[ext.id + '_mount'] === 'function') {
        window[ext.id + '_mount']();
      }
      _executed[id] = true;
      return { ok: true };
    } catch (e) {
      ext.error = String(e && e.message || e);
      console.error('[ExtManager] 装载扩展失败', id, e);
      return { ok: false, reason: ext.error };
    } finally {
      window.__extCtx = { id: '', name: '' };
    }
  }

  function executeCode(code, id) {
    // 用 Function 构造器执行扩展代码，使扩展内部的函数声明可被识别
    // 扩展代码末尾可定义 window.<id>_mount 生命周期函数
    try {
      const fn = new Function('extAPI', 'ExtManager', 'PatchEngine', 'ExtBus', code + '\n;return true;');
      fn(window.extAPI, window.ExtManager, window.PatchEngine, window.ExtBus);
    } catch (e) {
      throw e;
    }
  }

  // ── 卸载（恢复补丁覆盖 + 移除动态 UI + 清事件）──
  function unmount(id) {
    const ext = _registry[id];
    if (!ext) return { ok: false, reason: '扩展不存在: ' + id };
    // 恢复补丁覆盖
    if (typeof window.PatchEngine !== 'undefined' && window.PatchEngine.revertExt) {
      window.PatchEngine.revertExt(id);
    }
    // 移除动态 UI
    removeNavItems(id);
    removeSections(id);
    removeToolbarButtons(id);
    // 清事件订阅
    if (typeof window.ExtBus !== 'undefined' && window.ExtBus._listenersOf) {
      window.ExtBus._listenersOf(id).forEach(ev => window.ExtBus.off(id, ev));
    }
    delete _executed[id];
    return { ok: true };
  }

  // ── 启用 / 禁用 ──
  async function setEnabled(id, enabled) {
    const ext = _registry[id];
    if (!ext) return { ok: false, reason: '扩展不存在' };
    ext.enabled = !!enabled;
    if (ext.builtin) {
      saveBuiltinState(id, enabled ? 'enabled' : 'disabled');
      if (ext.meta) ext.meta.enabled = !!enabled;
    } else if (ext.meta) {
      ext.meta.enabled = !!enabled;
      try {
        if (typeof window.electronAPI !== 'undefined' && window.electronAPI.extWrite) {
          await window.electronAPI.extWrite({ id, files: { manifest: ext.meta } });
        }
      } catch (e) { /* 忽略持久化错误 */ }
    }
    if (enabled) {
      await mount(id);
    } else {
      unmount(id);
    }
    // 通知核心刷新导航
    if (typeof renderSidebarNav === 'function') renderSidebarNav();
    return { ok: true };
  }

  async function remove(id) {
    const ext = _registry[id];
    unmount(id);
    let trashed = false;
    if (ext && ext.builtin) {
      // 内置扩展：仅标记移除（不删文件，可恢复出厂）
      saveBuiltinState(id, 'removed');
    } else {
      if (typeof window.electronAPI !== 'undefined' && window.electronAPI.extRemove) {
        const res = await window.electronAPI.extRemove({ id });
        trashed = !!(res && res.trashed);
      }
    }
    delete _registry[id];
    if (typeof renderSidebarNav === 'function') renderSidebarNav();
    return { ok: true, trashed };
  }

  // 恢复内置扩展（移除后恢复）
  function restoreBuiltin(id) {
    saveBuiltinState(id, 'enabled');
  }

  // 列出内置扩展定义（供扩展页展示"恢复内置"）
  function listBuiltins() {
    return (typeof window.BUILTIN_EXTENSIONS !== 'undefined') ? window.BUILTIN_EXTENSIONS : [];
  }

  // ── 动态 UI 注册 ──
  function addNavItem(extId, config) {
    const ext = _registry[extId];
    if (!ext) return { ok: false, reason: '扩展未注册' };
    if (!config || !config.id || !config.label) {
      return { ok: false, reason: 'config 需含 id 和 label' };
    }
    const item = { extId, id: config.id, icon: config.icon || 'puzzle', label: config.label };
    _allNavItems.push(item);
    ext.navItems.push(item);
    if (typeof renderSidebarNav === 'function') renderSidebarNav();
    return { ok: true };
  }

  function addSection(extId, config) {
    const ext = _registry[extId];
    if (!ext) return { ok: false, reason: '扩展未注册' };
    if (!config || !config.id || !config.html) {
      return { ok: false, reason: 'config 需含 id 和 html' };
    }
    const section = { extId, id: config.id, html: config.html, render: config.render || null };
    _allSections.push(section);
    ext.sections.push(section);
    // 把 section DOM 插入页面
    insertSectionDOM(section);
    return { ok: true };
  }

  function insertSectionDOM(section) {
    const app = document.querySelector('.app');
    if (!app || document.getElementById('section-' + section.id)) return;
    const div = document.createElement('div');
    div.className = 'section';
    div.id = 'section-' + section.id;
    div.innerHTML = section.html;
    app.appendChild(div);
    // 渲染扩展页面内的 lucide 图标
    if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
  }

  function addToolbarButton(extId, config) {
    const ext = _registry[extId];
    if (!ext) return { ok: false, reason: '扩展未注册' };
    if (!config || !config.label) return { ok: false, reason: 'config 需含 label' };
    const btn = { extId, label: config.label, icon: config.icon || 'puzzle', onclick: config.onclick || null };
    _allToolbarButtons.push(btn);
    ext.toolbarButtons.push(btn);
    renderToolbarButtons();
    return { ok: true };
  }

  // ── 动态 UI 移除 ──
  function removeNavItems(extId) {
    const ext = _registry[extId];
    if (!ext) return;
    ext.navItems.forEach(item => {
      const idx = _allNavItems.indexOf(item);
      if (idx >= 0) _allNavItems.splice(idx, 1);
    });
    ext.navItems = [];
    if (typeof renderSidebarNav === 'function') renderSidebarNav();
  }

  function removeSections(extId) {
    const ext = _registry[extId];
    if (!ext) return;
    ext.sections.forEach(sec => {
      const idx = _allSections.indexOf(sec);
      if (idx >= 0) _allSections.splice(idx, 1);
      const el = document.getElementById('section-' + sec.id);
      if (el) el.remove();
    });
    ext.sections = [];
  }

  function removeToolbarButtons(extId) {
    const ext = _registry[extId];
    if (!ext) return;
    ext.toolbarButtons.forEach(btn => {
      const idx = _allToolbarButtons.indexOf(btn);
      if (idx >= 0) _allToolbarButtons.splice(idx, 1);
    });
    ext.toolbarButtons = [];
    renderToolbarButtons();
  }

  function renderToolbarButtons() {
    const container = document.getElementById('extToolbar');
    if (!container) return;
    container.innerHTML = _allToolbarButtons.map(btn => {
      return `<button class="ext-toolbar-btn" title="${btn.label}">
        <i data-lucide="${btn.icon}" style="width:16px;height:16px;"></i>
      </button>`;
    }).join('');
    if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
    container.querySelectorAll('.ext-toolbar-btn').forEach((el, i) => {
      el.addEventListener('click', () => {
        const btn = _allToolbarButtons[i];
        if (btn && typeof btn.onclick === 'function') {
          try { btn.onclick(); } catch (e) { console.error('[ExtManager] 工具栏按钮出错', e); }
        }
      });
    });
  }

  // 动态侧边栏项合并进导航（供 core.js 调用）
  function getDynamicNavItems() {
    return _allNavItems.map(item => ({ id: item.id, icon: item.icon, label: item.label, extId: item.extId }));
  }

  // 动态 section 切换渲染
  function switchToExtSection(id) {
    const section = _allSections.find(s => s.id === id);
    if (section && typeof section.render === 'function') {
      try { section.render(); } catch (e) { console.error('[ExtManager] 扩展面板渲染出错', e); }
    }
  }

  // ── 初始化：扫描并装载已启用扩展 ──
  async function init() {
    await loadAll();
    for (const ext of Object.values(_registry)) {
      if (ext.enabled && ext.mainCode) {
        await mount(ext.id);
      }
    }
    if (typeof renderSidebarNav === 'function') renderSidebarNav();
    return { ok: true };
  }

  // ── 强制重载：卸载当前全部扩展 → 清空注册表 → 重扫磁盘 → 重装已启用的 ──
  // 用于「刷新」按钮 / 导入扩展后，确保磁盘新增/删除能反映到列表。
  async function reload() {
    // 先卸载所有已装载的扩展（恢复补丁、移除动态 UI、清事件）
    for (const id of Object.keys(_registry)) {
      try { unmount(id); } catch (e) {}
    }
    // 清空注册表
    Object.keys(_registry).forEach(k => { delete _registry[k]; });
    // 重扫磁盘 + 内置
    await loadAll();
    for (const ext of Object.values(_registry)) {
      if (ext.enabled && ext.mainCode) {
        try { await mount(ext.id); } catch (e) {}
      }
    }
    if (typeof renderSidebarNav === 'function') renderSidebarNav();
    return { ok: true };
  }

  return {
    init,
    loadAll,
    reload,
    list,
    get,
    mount,
    unmount,
    setEnabled,
    remove,
    restoreBuiltin,
    listBuiltins,
    addNavItem,
    addSection,
    addToolbarButton,
    getDynamicNavItems,
    switchToExtSection
  };
})();
