// ═══════════════════════════════════════════════════════════════════
// js/store.js — 插件市场（Plugin Marketplace）
// v0.2.3 · 免费社区插件上传/下载/评分
// ═══════════════════════════════════════════════════════════════════

window.Store = (function () {
  // 与好友系统共用 Supabase 配置
  const CONFIG_KEY = 'study_supabase_config';
  const OLD_CONFIG_KEY = 'study_plugin_store_config';
  const SESSION_KEY = 'study_store_session';

  let _supabase = null;
  let _currentUser = null;
  let _pluginsCache = null;
  let _searchQuery = '';
  let _tagFilter = '';

  // ── 配置 ──
  function getStoreConfig() {
    try {
      let raw = localStorage.getItem(CONFIG_KEY);
      if (raw) {
        const cfg = JSON.parse(raw);
        if (cfg && cfg.url && cfg.anonKey) return cfg;
      }
      // 从旧键迁移
      raw = localStorage.getItem(OLD_CONFIG_KEY);
      if (raw) {
        const cfg = JSON.parse(raw);
        if (cfg.url && cfg.anonKey) {
          localStorage.setItem(CONFIG_KEY, raw);
          // 不删旧键，保留给 friends.js 做反向迁移
        }
        return cfg;
      }
      // 再尝试好友系统的旧键
      raw = localStorage.getItem('study_friends_config');
      if (raw) {
        const cfg = JSON.parse(raw);
        if (cfg.url && cfg.anonKey) return cfg;
      }
      // 无本地配置 → 回退到内置默认（与好友系统共用）
      const builtin = (typeof BUILTIN_SUPABASE_CONFIG !== 'undefined' && BUILTIN_SUPABASE_CONFIG)
        ? BUILTIN_SUPABASE_CONFIG : { url: '', anonKey: '' };
      return { url: builtin.url || '', anonKey: builtin.anonKey || '' };
    } catch (e) {
      const builtin = (typeof BUILTIN_SUPABASE_CONFIG !== 'undefined' && BUILTIN_SUPABASE_CONFIG)
        ? BUILTIN_SUPABASE_CONFIG : { url: '', anonKey: '' };
      return { url: builtin.url || '', anonKey: builtin.anonKey || '' };
    }
  }

  function saveStoreConfig(cfg) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    _supabase = null;
    _currentUser = null;
    _pluginsCache = null;
  }

  function isConfigured() {
    const cfg = getStoreConfig();
    return !!(cfg.url && cfg.anonKey);
  }

  // ── Supabase 客户端（单例）──
  function getSupabaseClient() {
    if (_supabase) return _supabase;
    const cfg = getStoreConfig();
    if (!cfg.url || !cfg.anonKey) return null;
    if (typeof window.supabase === 'undefined' || !window.supabase.createClient) return null;
    _supabase = window.supabase.createClient(cfg.url, cfg.anonKey);
    return _supabase;
  }

  // ── 认证 ──
  async function ensureStoreAuth() {
    const sb = getSupabaseClient();
    if (!sb) return null;
    // 优先尝试读已有 session
    if (_currentUser) return _currentUser;
    try {
      const { data } = await sb.auth.getSession();
      if (data && data.session) {
        _currentUser = data.session.user;
        return _currentUser;
      }
    } catch (e) { /* 未登录 */ }
    return null;
  }

  async function storeSignUp(email, password, username, nickname) {
    const sb = getSupabaseClient();
    if (!sb) throw new Error('插件市场未配置');
    const options = {};
    if (username) options.data = Object.assign({}, options.data, { username: username.trim() });
    if (nickname) options.data = Object.assign({}, options.data, { nickname: nickname.trim() || username.trim() });
    const { data, error } = await sb.auth.signUp(Object.keys(options.data || {}).length
      ? { email, password, options }
      : { email, password });
    if (error) throw error;
    if (data.user) _currentUser = data.user;
    return data;
  }

  async function storeSignIn(email, password) {
    const sb = getSupabaseClient();
    if (!sb) throw new Error('插件市场未配置');
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (data.user) _currentUser = data.user;
    return data;
  }

  async function storeSignOut() {
    const sb = getSupabaseClient();
    if (sb) await sb.auth.signOut();
    _currentUser = null;
  }

  // 获取展示名：昵称 || 用户名 || 邮箱
  async function getStoreDisplayName(user) {
    if (!user) return '';
    if (user._displayName) return user._displayName;
    try {
      const sb = getSupabaseClient();
      if (sb) {
        const { data } = await sb.from('profiles').select('nickname,username').eq('id', user.id).maybeSingle();
        if (data) {
          user._displayName = (data.nickname || data.username || user.email || '').trim() || user.email || '用户';
          return user._displayName;
        }
      }
    } catch (e) { /* 忽略 */ }
    user._displayName = user.email || '用户';
    return user._displayName;
  }

  // 给插件列表补充作者展示名（昵称/用户名，替代上传时存的邮箱）
  // 通过 profiles_public 最小公开视图查询，未登录用户也能读到作者名（仅昵称/用户名），
  // 不涉及在线状态、简介等隐私字段（profiles 表 RLS 收紧为仅登录可读）。
  async function _enrichAuthorNames(list) {
    if (!list || !list.length) return;
    const sb = getSupabaseClient();
    if (!sb) return;
    const ids = [...new Set(list.map(p => p.author_id).filter(Boolean))];
    if (!ids.length) return;
    try {
      const { data: profs } = await sb.from('profiles_public').select('id,nickname,username').in('id', ids);
      const map = {};
      (profs || []).forEach(p => { map[p.id] = (p.nickname || p.username || '').trim() || ''; });
      list.forEach(p => { if (map[p.author_id]) p.author_name = map[p.author_id]; });
    } catch (e) { /* 忽略 */ }
  }

  // ── 插件 CRUD ──
  async function fetchPlugins(force) {
    const sb = getSupabaseClient();
    if (!sb) return [];

    if (!force && _pluginsCache) return _pluginsCache;

    try {
      let q = sb.from('plugin_store_items').select('*').eq('status', 'approved').order('downloads', { ascending: false });
      if (_tagFilter) q = q.contains('tags', [_tagFilter]);
      if (_searchQuery) q = q.or(`name.ilike.%${_searchQuery}%,description.ilike.%${_searchQuery}%,tags.cs.{${_searchQuery}}`);
      const { data, error } = await q;
      if (error) throw error;
      _pluginsCache = data || [];
      await _enrichAuthorNames(_pluginsCache);
      return _pluginsCache;
    } catch (e) {
      console.warn('[store] fetchPlugins error', e);
      return _pluginsCache || [];
    }
  }

  function setSearch(q) { _searchQuery = q; _pluginsCache = null; }
  function setTag(t)    { _tagFilter = t; _pluginsCache = null; }

  // 查询已上传到市场的 ext_id 集合（供扩展页显示"已发布"状态）
  async function fetchUploadedExtIds() {
    const sb = getSupabaseClient();
    if (!sb) return new Set();
    try {
      const { data, error } = await sb.from('plugin_store_items').select('ext_id').eq('status', 'approved');
      if (error) throw error;
      return new Set((data || []).map(d => d.ext_id));
    } catch (e) {
      console.warn('[store] fetchUploadedExtIds error', e);
      return new Set();
    }
  }

  async function downloadPlugin(item) {
    const sb = getSupabaseClient();
    if (!sb) throw new Error('插件市场未配置');

    // 1. 下载 zip
    const { data, error } = await sb.storage.from('plugin-store').download(item.file_path);
    if (error) throw new Error('下载失败: ' + error.message);
    if (!data) throw new Error('文件为空');

    // 2. 解压 zip：采用 JSZip 或按需自行实现简单逻辑
    const zipBuf = await data.arrayBuffer();
    const files = await _unzip(zipBuf);
    const manifestRaw = files['manifest.json'];
    const mainRaw = files['main.js'];
    if (!manifestRaw) throw new Error('zip 内缺少 manifest.json');

    let manifest;
    try { manifest = JSON.parse(manifestRaw); } catch (e) { throw new Error('manifest.json 解析失败'); }
    if (!manifest.id || !manifest.name || !manifest.type) throw new Error('manifest.json 缺少必要字段');
    const extId = manifest.id;

    // 3. 写入本地扩展目录（ext:write 只接受 files: { manifest, main } 格式）
    try {
      await window.electronAPI.extWrite({ id: extId, files: { manifest, main: mainRaw } });
    } catch (e) {
      console.warn('[store] extWrite error', e);
      throw new Error('写入扩展文件失败: ' + e.message);
    }

    // 4. 重装载
    if (typeof window.ExtManager !== 'undefined') {
      try { await window.ExtManager.loadAll(); await window.ExtManager.init(); } catch (e) { console.error('[store] 装载失败', e); }
    }
    if (typeof renderSidebarNav === 'function') renderSidebarNav();

    // 5. 记录下载
    try {
      const user = await ensureStoreAuth();
      if (user) {
        await sb.from('plugin_downloads').insert({ plugin_id: item.id, user_id: user.id });
        await sb.rpc('increment_downloads', { target_plugin_id: item.id });
      }
    } catch (e) { /* 非关键 */ }

    return { ok: true, extId, name: manifest.name };
  }

  // ── 上传 ──
  async function uploadPlugin(extId) {
    const user = await ensureStoreAuth();
    if (!user) throw new Error('请先登录插件市场');
    const sb = getSupabaseClient();
    if (!sb) throw new Error('插件市场未配置');

    // 1. 读本地扩展文件
    let manifestRaw, mainRaw;
    try {
      manifestRaw = await window.electronAPI.extRead({ id: extId, filename: 'manifest.json' });
      mainRaw = await window.electronAPI.extRead({ id: extId, filename: 'main.js' });
    } catch (e) {
      throw new Error('读取本地扩展失败: ' + e.message);
    }
    if (!manifestRaw) throw new Error('manifest.json 不存在');
    let manifest;
    try { manifest = JSON.parse(manifestRaw); } catch (e) { throw new Error('manifest.json 解析失败'); }

    if (manifest.type !== 'plugin' && manifest.type !== 'patch') throw new Error('仅支持 plugin/patch 类型');
    if (manifest.builtin) throw new Error('内置扩展不可上传到市场');

    // 2. 打包 zip
    const zipBlob = await _zip(manifestRaw, mainRaw || '', manifest.id);

    // 3. 上传到 Storage
    const filePath = `${extId}/1.0.0/${extId}.zip`;
    const { error: uploadErr } = await sb.storage.from('plugin-store').upload(filePath, zipBlob, {
      contentType: 'application/zip',
      upsert: true
    });
    if (uploadErr) throw new Error('上传失败: ' + uploadErr.message);

    // 4. 检查是否已有记录
    const { data: existing } = await sb.from('plugin_store_items')
      .select('id').eq('ext_id', extId).eq('author_id', user.id).maybeSingle();

    const itemData = {
      author_id: user.id,
      author_name: await getStoreDisplayName(user) || '匿名',
      ext_id: extId,
      name: manifest.name || extId,
      type: manifest.type,
      version: manifest.version || '1.0.0',
      description: manifest.description || '',
      tags: _extractTags(manifest),
      file_path: filePath,
      status: 'approved',
      updated_at: new Date().toISOString()
    };

    if (existing) {
      const { error: updErr } = await sb.from('plugin_store_items').update(itemData).eq('id', existing.id);
      if (updErr) throw new Error('更新记录失败: ' + updErr.message);
    } else {
      const { error: insErr } = await sb.from('plugin_store_items').insert(itemData);
      if (insErr) throw new Error('上传记录失败: ' + insErr.message);
    }

    return { ok: true, message: '上传成功，已发布到市场' };
  }

  function _extractTags(manifest) {
    const tags = [];
    if (manifest.tags && Array.isArray(manifest.tags)) tags.push(...manifest.tags);
    if (manifest.description) {
      const lower = manifest.description.toLowerCase();
      if (lower.includes('todo') || lower.includes('待办')) tags.push('todo');
      if (lower.includes('note') || lower.includes('笔记')) tags.push('notes');
      if (lower.includes('timer') || lower.includes('计时')) tags.push('timer');
      if (lower.includes('habit') || lower.includes('习惯')) tags.push('habits');
      if (lower.includes('ai') || lower.includes('ai')) tags.push('ai');
    }
    return [...new Set(tags)].slice(0, 6);
  }

  // ── 评分 ──
  async function ratePlugin(pluginId, rating) {
    const user = await ensureStoreAuth();
    if (!user) throw new Error('请先登录');
    const sb = getSupabaseClient();
    if (!sb) throw new Error('插件市场未配置');
    const { data, error } = await sb.from('plugin_ratings').upsert(
      { plugin_id: pluginId, user_id: user.id, rating },
      { onConflict: 'plugin_id,user_id' }
    );
    if (error) throw new Error('评分失败: ' + error.message);
    _pluginsCache = null;
    return { ok: true };
  }

  // 获取当前用户对某插件的评分（未评返回 0）
  async function getMyRating(pluginId) {
    const user = await ensureStoreAuth();
    if (!user) return 0;
    const sb = getSupabaseClient();
    if (!sb) return 0;
    try {
      const { data, error } = await sb.from('plugin_ratings')
        .select('rating').eq('plugin_id', pluginId).eq('user_id', user.id).maybeSingle();
      if (error) throw error;
      return (data && data.rating) || 0;
    } catch (e) {
      console.warn('[store] getMyRating error', e);
      return 0;
    }
  }

  // ── 简单 ZIP（manifest.json + main.js，不依赖外部库）──
  async function _zip(manifestStr, mainStr, extId) {
    // 利用浏览器原生 JSZip 能力——如果没有则回退到手动构建
    // 优先使用轻量方案：Data URI + Blob
    // 实际上这里用简单实现：把两个文件内容拼接成一个 JSON 包，客户端解包时还原
    // 但这种"zip"不标准。改用实际 JSZip 如果可用，否则用 base64 JSON 包。
    if (typeof window.JSZip !== 'undefined') {
      const zip = new window.JSZip();
      zip.file('manifest.json', manifestStr);
      if (mainStr) zip.file('main.js', mainStr);
      return await zip.generateAsync({ type: 'blob' });
    }
    // 回退：简单的 JSON 包（非标准 zip，但我们的 _unzip 可以理解）
    const pkg = {
      format: 'plugin-store-pkg',
      version: 1,
      files: { 'manifest.json': manifestStr, 'main.js': mainStr }
    };
    const json = JSON.stringify(pkg);
    return new Blob([json], { type: 'application/json' });
  }

  async function _unzip(arrayBuf) {
    // 尝试 JSZip 解析
    if (typeof window.JSZip !== 'undefined') {
      try {
        const zip = await window.JSZip.loadAsync(arrayBuf);
        const files = {};
        for (const [name, entry] of Object.entries(zip.files)) {
          if (entry.dir) continue;
          // 去掉根目录前缀（zip 内可能有多层目录）
          const base = name.split('/').pop();
          if (base === 'manifest.json' || base === 'main.js') {
            files[base] = await entry.async('string');
          }
        }
        if (files['manifest.json']) return files;
      } catch (e) { /* 不是标准 zip，尝试回退解析 */ }
    }
    // 回退：JSON 包
    try {
      const text = new TextDecoder('utf-8').decode(new Uint8Array(arrayBuf));
      const pkg = JSON.parse(text);
      if (pkg && pkg.format === 'plugin-store-pkg' && pkg.files) {
        return pkg.files;
      }
    } catch (e) { /* ignore */ }
    return {};
  }

  // ── 用户可上传的本地扩展列表 ──
  async function listUploadableExtensions() {
    try {
      const all = await window.electronAPI.extList();
      return (all || []).filter(e => e.type === 'plugin' || e.type === 'patch')
        .filter(e => !e.builtin && e.hasManifest);
    } catch (e) { return []; }
  }

  // ── 安装本地压缩包（ZIP 导入）──
  async function installFromZip(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const buf = e.target.result;
          const files = await _unzip(buf);
          const manifestRaw = files['manifest.json'];
          const mainRaw = files['main.js'];
          if (!manifestRaw) throw new Error('ZIP 内缺少 manifest.json');

          let manifest;
          try { manifest = JSON.parse(manifestRaw); } catch (err) { throw new Error('manifest.json 解析失败'); }
          if (!manifest.id || !manifest.name || !manifest.type) throw new Error('manifest.json 字段不完整');

          // 写入本地（ext:write 只接受 files: { manifest, main } 格式）
          await window.electronAPI.extWrite({ id: manifest.id, files: { manifest, main: mainRaw } });

          // 重装载
          if (typeof window.ExtManager !== 'undefined') {
            try { await window.ExtManager.loadAll(); await window.ExtManager.init(); } catch (err) { console.error('[store] 装载失败', err); }
          }
          if (typeof renderSidebarNav === 'function') renderSidebarNav();

          resolve({ ok: true, name: manifest.name });
        } catch (err) { reject(err); }
      };
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsArrayBuffer(file);
    });
  }

  // ── HTML 转义 ──
  function _esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ═══════════════════════════════════════════════════════════════
  // 渲染：设置页插件市场说明面板（URL/Key 统一在 Supabase 连接面板配置）
  // ═══════════════════════════════════════════════════════════════
  function renderStoreSettings() {
    const panel = document.getElementById('settingsPanelStore');
    if (!panel) return;
    const configured = isConfigured();
    panel.innerHTML = `
      <div class="store-conn-status" style="margin-bottom:12px;">
        ${configured
          ? '<span style="color:var(--green)"><i data-lucide="check-circle" class="lucide-icon" style="width:15px;height:15px;vertical-align:middle;"></i> 已连接到 Supabase</span>'
          : '<span style="color:var(--orange)"><i data-lucide="alert-circle" class="lucide-icon" style="width:15px;height:15px;vertical-align:middle;"></i> 未配置 Supabase 连接 - 请前往 <a href="#" onclick="switchSettingsTab(\'supabase\')">Supabase 连接</a> 设置 URL 和 Key</span>'
        }
      </div>
      <button class="settings-btn" onclick="window.Store.testStoreConnection()" style="margin-bottom:12px;">
        <i data-lucide="plug" class="lucide-icon"></i> 测试插件市场连接
      </button>
      <div id="storeSettingsStatus" class="settings-status"></div>
      <hr>
      <div class="settings-note">
        <p><strong>使用说明</strong></p>
        <ol>
          <li>先到 <a href="#" onclick="switchSettingsTab(\'supabase\')">Supabase 连接</a> 填入 URL 和 Anon Key 并保存</li>
          <li>在 Supabase SQL Editor 中执行 <code>supabase/schema.sql</code> 中插件市场相关建表语句</li>
          <li>在 Storage 页面创建 <code>plugin-store</code> bucket（勾选 Public）</li>
          <li>设置 RLS Policy：SELECT 允许所有人，INSERT 仅认证用户</li>
          <li>回到本页测试连接，成功即可使用</li>
        </ol>
      </div>
    `;
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
  }

  async function saveStoreSettings() {
    // 不再从此面板保存 URL/Key，保留函数作兼容入口
  }

  async function testStoreConnection() {
    const status = document.getElementById('storeSettingsStatus');
    const sb = getSupabaseClient();
    if (!sb) {
      if (status) status.innerHTML = '<span style="color:var(--red)"><i data-lucide="x-circle" class="lucide-icon"></i> 连接失败：Supabase 未配置，请先前往 Supabase 连接页设置</span>';
      if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
      return;
    }
    try {
      const { data, error } = await sb.from('plugin_store_items').select('id').limit(1);
      if (error) throw error;
      if (status) status.innerHTML = '<span style="color:var(--green)"><i data-lucide="check-circle" class="lucide-icon"></i> 连接成功，插件市场可用！</span>';
    } catch (e) {
      if (status) status.innerHTML = `<span style="color:var(--red)"><i data-lucide="x-circle" class="lucide-icon"></i> 连接失败：${_esc(e.message)}</span>`;
    }
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
  }

  // ═══════════════════════════════════════════════════════════════
  // 渲染：插件市场主页面
  // ═══════════════════════════════════════════════════════════════
  async function renderStore() {
    const container = document.getElementById('storeApp');
    if (!container) return;

    if (!isConfigured()) {
      container.innerHTML = `
        <div class="store-empty">
          <i data-lucide="package-open" class="lucide-icon" style="width:48px;height:48px;stroke:var(--text-muted);"></i>
          <h3>插件市场未配置</h3>
          <p>前往 <a href="#" onclick="openSettingsModal();switchSettingsTab('store')">设置 → 插件市场</a> 配置 Supabase 连接</p>
        </div>`;
      if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
      return;
    }

    container.innerHTML = `
      <!-- 顶部栏 -->
      <div class="store-topbar">
        <div class="store-topbar-left">
          <input type="text" id="storeSearch" class="store-search-input"
            placeholder="搜索插件名称、描述或标签…" value="${_esc(_searchQuery)}"
            oninput="window.Store.onSearchChange(this.value)">
          <select id="storeTagFilter" class="store-tag-select" onchange="window.Store.onTagChange(this.value)">
            <option value="">全部标签</option>
            <option value="todo" ${_tagFilter==='todo'?'selected':''}>待办</option>
            <option value="notes" ${_tagFilter==='notes'?'selected':''}>笔记</option>
            <option value="timer" ${_tagFilter==='timer'?'selected':''}>计时器</option>
            <option value="habits" ${_tagFilter==='habits'?'selected':''}>习惯</option>
            <option value="ai" ${_tagFilter==='ai'?'selected':''}>AI</option>
          </select>
        </div>
        <div class="store-topbar-right">
          <button class="store-auth-btn" onclick="window.Store.showAuthModal()" id="storeAuthBtn">
            <i data-lucide="log-in" class="lucide-icon" style="width:15px;height:15px;"></i> 登录
          </button>
        </div>
      </div>

      <!-- 插件列表 -->
      <div class="store-grid" id="storeGrid">
        <div class="store-loading">
          <i data-lucide="loader-2" class="lucide-icon spin" style="width:24px;height:24px;"></i>
          <span>加载中…</span>
        </div>
      </div>

      <!-- 状态栏 -->
      <div id="storeStatus" class="store-status"></div>
    `;

    // 隐藏的文件选择器（导入用）
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.zip';
    fileInput.style.display = 'none';
    fileInput.id = 'storeImportFile';
    fileInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        await installFromZip(file);
        showStoreToast('导入成功！', 'success');
        renderStore();
      } catch (err) {
        showStoreToast('导入失败: ' + err.message, 'error');
      }
      fileInput.value = '';
    };
    container.appendChild(fileInput);

    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);

    // 加载插件列表
    await _renderPluginGrid();
    // 更新登录按钮状态
    _updateAuthButton();
  }

  async function _renderPluginGrid() {
    const grid = document.getElementById('storeGrid');
    if (!grid) return;
    try {
      const plugins = await fetchPlugins(true);
      // 本地已安装扩展 id 集合（用于显示"已安装"状态）
      let installedIds = new Set();
      try {
        const local = await window.electronAPI.extList();
        (local || []).forEach(e => { if (e.id) installedIds.add(e.id); });
      } catch (e) { /* 忽略 */ }
      if (!plugins || plugins.length === 0) {
        grid.innerHTML = `<div class="store-empty">
          <i data-lucide="package" class="lucide-icon" style="width:40px;height:40px;stroke:var(--text-muted);"></i>
          <p>${_searchQuery || _tagFilter ? '没有匹配的插件' : '插件市场暂无内容，快去发布第一个插件吧！'}</p>
        </div>`;
      } else {
        grid.innerHTML = plugins.map(p => {
          const installed = installedIds.has(p.ext_id);
          return `
          <div class="store-card">
            <div class="store-card-header">
              <span class="store-card-type store-type-${p.type}">${p.type === 'plugin' ? '插件' : '补丁'}</span>
              <span class="store-card-version">v${_esc(p.version)}</span>
              ${installed ? '<span class="store-installed-badge"><i data-lucide="check" style="width:11px;height:11px;vertical-align:-1px;"></i> 已安装</span>' : ''}
            </div>
            <h4 class="store-card-name">${_esc(p.name)}</h4>
            <p class="store-card-desc">${_esc(p.description || '暂无描述')}</p>
            <div class="store-card-tags">
              ${(p.tags || []).slice(0,4).map(t => `<span class="store-tag" onclick="window.Store.onTagClick('${_esc(t)}')">${_esc(t)}</span>`).join('')}
            </div>
            <div class="store-card-footer">
              <span class="store-card-author"><i data-lucide="user" style="width:13px;height:13px;"></i> ${_esc(p.author_name || '匿名')}</span>
              <span class="store-card-stats">
                <span title="下载量"><i data-lucide="download" style="width:13px;height:13px;"></i> ${p.downloads || 0}</span>
                <span title="评分" style="margin-left:8px;"><i data-lucide="star" style="width:13px;height:13px;"></i> ${p.rating ? p.rating.toFixed(1) : '-'}</span>
              </span>
            </div>
            <div class="store-card-actions">
              ${installed
                ? `<button class="store-download-btn store-installed-btn" disabled style="cursor:default;">
                    <i data-lucide="check" style="width:14px;height:14px;"></i> 已安装
                  </button>`
                : `<button class="store-download-btn" onclick="window.Store.doDownload('${p.id}')">
                    <i data-lucide="download" style="width:14px;height:14px;"></i> 安装
                  </button>`}
              <button class="store-rate-btn" onclick="window.Store.showRateModal('${p.id}','${_esc(p.name)}')" title="评分">
                <i data-lucide="star" style="width:14px;height:14px;"></i>
              </button>
            </div>
          </div>
        `}).join('');
      }
      if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
    } catch (e) {
      grid.innerHTML = `<div class="store-empty" style="color:var(--red);">加载失败: ${_esc(e.message)}</div>`;
    }
  }

  // ── 交互事件 ──
  function onSearchChange(q) {
    setSearch(q);
    _renderPluginGrid();
  }

  function onTagChange(t) {
    setTag(t);
    _renderPluginGrid();
  }

  function onTagClick(t) {
    _tagFilter = t;
    const sel = document.getElementById('storeTagFilter');
    if (sel) sel.value = t;
    _pluginsCache = null;
    _renderPluginGrid();
  }

  async function doDownload(pluginId) {
    const plugins = _pluginsCache || [];
    const item = plugins.find(p => p.id === pluginId);
    if (!item) return;
    showStoreToast('正在下载 ' + _esc(item.name) + '…', 'info');
    try {
      const res = await downloadPlugin(item);
      showStoreToast(res.name + ' 安装成功！', 'success');
      _pluginsCache = null;
      _renderPluginGrid();
    } catch (e) {
      showStoreToast('下载失败: ' + e.message, 'error');
    }
  }

  // ── 弹窗 ──
  function showStoreToast(msg, type) {
    const el = document.getElementById('storeStatus');
    if (!el) return;
    el.innerHTML = `<span class="store-toast store-toast-${type || 'info'}">${_esc(msg)}</span>`;
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
    setTimeout(() => { if (el) el.innerHTML = ''; }, 4000);
  }

  let _authMode = 'login';

  // 登录/注册表单（参照好友系统 fr-auth 风格）
  function _storeAuthForm(mode) {
    if (mode === 'register') {
      return `
        <div class="fr-auth-form">
          <i data-lucide="user-plus" class="lucide-icon fr-auth-icon"></i>
          <h3>注册新账号</h3>
          <label class="fr-auth-label">用户名（唯一，展示用）</label>
          <input type="text" class="fr-auth-input" id="storeAuthUsername" placeholder="如：小纪" maxlength="30">
          <label class="fr-auth-label">昵称（可选）</label>
          <input type="text" class="fr-auth-input" id="storeAuthNickname" placeholder="展示昵称" maxlength="30">
          <label class="fr-auth-label">邮箱</label>
          <input type="email" class="fr-auth-input" id="storeAuthEmail" placeholder="you@example.com" onkeydown="if(event.key==='Enter')window.Store.doRegister()">
          <label class="fr-auth-label">密码（至少 6 位）</label>
          <input type="password" class="fr-auth-input" id="storeAuthPassword" placeholder="密码" onkeydown="if(event.key==='Enter')window.Store.doRegister()">
          <div class="fr-auth-status" id="storeAuthStatus"></div>
          <button class="btn-add" onclick="window.Store.doRegister()" style="width:100%;justify-content:center;margin-top:6px;">
            <i data-lucide="user-plus" class="lucide-icon" style="width:15px;height:15px;"></i> 注册
          </button>
        </div>`;
    }
    return `
      <div class="fr-auth-form">
        <i data-lucide="store" class="lucide-icon fr-auth-icon"></i>
        <h3>登录账号</h3>
        <label class="fr-auth-label">邮箱</label>
        <input type="email" class="fr-auth-input" id="storeAuthEmail" placeholder="you@example.com" onkeydown="if(event.key==='Enter')window.Store.doLogin()">
        <label class="fr-auth-label">密码</label>
        <input type="password" class="fr-auth-input" id="storeAuthPassword" placeholder="密码" onkeydown="if(event.key==='Enter')window.Store.doLogin()">
        <div class="fr-auth-status" id="storeAuthStatus"></div>
        <button class="btn-add" onclick="window.Store.doLogin()" style="width:100%;justify-content:center;margin-top:6px;">
          <i data-lucide="log-in" class="lucide-icon" style="width:15px;height:15px;"></i> 登录
        </button>
      </div>`;
  }

  function showAuthModal() {
    if (typeof showCustomConfirm !== 'function') return;
    _authMode = 'login';
    showCustomConfirm(`
      <div class="store-auth-modal">
        <div class="store-auth-tabs">
          <button class="store-auth-tab active" id="storeAuthTabLogin" onclick="window.Store.switchAuthTab('login')">登录账号</button>
          <button class="store-auth-tab" id="storeAuthTabRegister" onclick="window.Store.switchAuthTab('register')">注册新账号</button>
        </div>
        <div id="storeAuthBody">${_storeAuthForm('login')}</div>
      </div>
    `, { title: '插件市场', dontAskKey: '', hideActions: true });
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
  }

  function switchAuthTab(mode) {
    _authMode = mode;
    const tL = document.getElementById('storeAuthTabLogin');
    const tR = document.getElementById('storeAuthTabRegister');
    const body = document.getElementById('storeAuthBody');
    if (tL) tL.classList.toggle('active', mode === 'login');
    if (tR) tR.classList.toggle('active', mode === 'register');
    if (body) body.innerHTML = _storeAuthForm(mode);
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
  }

  // 账户菜单：展示昵称/用户名 + 退出登录
  async function showAccountMenu() {
    if (typeof showCustomConfirm !== 'function') return;
    const user = await ensureStoreAuth();
    if (!user) { _updateAuthButton(); return; }
    const name = await getStoreDisplayName(user);
    const email = user.email || '';
    showCustomConfirm(`
      <div class="store-account-modal">
        <div class="store-account-head">
          <div class="store-account-avatar">${_esc((name || '?').charAt(0).toUpperCase())}</div>
          <div>
            <div class="store-account-name">${_esc(name)}</div>
            <div class="store-account-email">${_esc(email)}</div>
          </div>
        </div>
        <button class="btn-add store-account-logout" onclick="window.Store.doSignOut()">
          <i data-lucide="log-out" class="lucide-icon" style="width:14px;height:14px;"></i> 退出登录
        </button>
      </div>
    `, { title: '账户', dontAskKey: '', hideActions: true });
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
  }

  async function doSignOut() {
    await storeSignOut();
    _currentUser = null;
    if (typeof closeCustomConfirm === 'function') closeCustomConfirm();
    _updateAuthButton();
    renderStore();
  }

  async function doLogin() {
    const email = (document.getElementById('storeAuthEmail') || {}).value || '';
    const password = (document.getElementById('storeAuthPassword') || {}).value || '';
    const status = document.getElementById('storeAuthStatus');
    const set = (msg, err) => { if (status) { status.textContent = msg; status.style.color = err ? 'var(--red)' : 'var(--green)'; } };
    if (!email || !password) { set('请填写邮箱和密码', true); return; }
    try {
      await storeSignIn(email, password);
      set('登录成功！');
      _storeFeedback('登录成功，欢迎回来！', 'success');
      if (typeof closeCustomConfirm === 'function') setTimeout(closeCustomConfirm, 800);
      _updateAuthButton();
      renderStore();
    } catch (e) {
      set(e.message, true);
    }
  }

  async function doRegister() {
    const username = (document.getElementById('storeAuthUsername') || {}).value || '';
    const nickname = (document.getElementById('storeAuthNickname') || {}).value || '';
    const email = (document.getElementById('storeAuthEmail') || {}).value || '';
    const password = (document.getElementById('storeAuthPassword') || {}).value || '';
    const status = document.getElementById('storeAuthStatus');
    const set = (msg, err) => { if (status) { status.textContent = msg; status.style.color = err ? 'var(--red)' : 'var(--green)'; } };
    if (!email || !password) { set('请填写邮箱和密码', true); return; }
    if (password.length < 6) { set('密码至少需要 6 位', true); return; }
    try {
      await storeSignUp(email, password, username, nickname);
      set('注册成功！');
      _storeFeedback('注册成功，欢迎加入！', 'success');
      if (typeof closeCustomConfirm === 'function') setTimeout(closeCustomConfirm, 900);
      _updateAuthButton();
      renderStore();
    } catch (e) {
      set(e.message, true);
    }
  }

  async function _updateAuthButton() {
    const btn = document.getElementById('storeAuthBtn');
    if (!btn) return;
    const user = await ensureStoreAuth();
    if (user) {
      const name = await getStoreDisplayName(user);
      btn.innerHTML = `<i data-lucide="user-check" class="lucide-icon" style="width:15px;height:15px;"></i> ${_esc(name)}`;
      btn.onclick = () => showAccountMenu();
    } else {
      btn.innerHTML = '<i data-lucide="log-in" class="lucide-icon" style="width:15px;height:15px;"></i> 登录';
      btn.onclick = () => showAuthModal();
    }
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
  }

  function showUploadModal() {
    if (typeof showCustomConfirm !== 'function') return;
    // 列出可上传的本地扩展
    listUploadableExtensions().then(exts => {
      if (exts.length === 0) {
        showStoreToast('没有可上传的扩展（仅非内置 plugin/patch 类型）', 'error');
        return;
      }
      showCustomConfirm(`
        <div class="store-upload-modal">
          <h3>发布到插件市场</h3>
          <p>选择要发布的扩展：</p>
          <div class="store-upload-list">
            ${exts.map(e => `
              <button class="store-upload-item" onclick="window.Store.doUpload('${_esc(e.id)}')">
                <span><strong>${_esc(e.name || e.id)}</strong> · ${e.type === 'plugin' ? '插件' : '补丁'} · v${_esc(e.version || '1.0.0')}</span>
                <span style="color:var(--text-muted);">由 ${_esc(e.author || '未知')}</span>
                <i data-lucide="upload" style="width:14px;height:14px;"></i>
              </button>
            `).join('')}
          </div>
          <p style="font-size:11px;color:var(--text-muted);margin-top:8px;">上传后将直接发布到市场</p>
        </div>
      `, { title: '发布插件', dontAskKey: '', hideActions: true });
      if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
    }).catch(e => showStoreToast('加载失败: ' + e.message, 'error'));
  }

  let _storeToastTimer = null;
  function _storeFeedback(msg, type) {
    // 全局浮动 toast（任何页面可见）
    let toast = document.getElementById('storeToastPop');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'storeToastPop';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.className = 'store-toast-pop show' + (type === 'error' ? ' error' : (type === 'success' ? ' success' : ''));
    clearTimeout(_storeToastTimer);
    _storeToastTimer = setTimeout(() => { toast.className = 'store-toast-pop'; }, 3200);
  }

  async function doUpload(extId) {
    const user = await ensureStoreAuth();
    if (!user) {
      showAuthModal();
      _storeFeedback('发布需要先登录插件市场', 'info');
      return;
    }
    try {
      _storeFeedback('正在发布…', 'info');
      const res = await uploadPlugin(extId);
      _storeFeedback(res.message || '发布成功', 'success');
      if (typeof closeCustomConfirm === 'function') closeCustomConfirm();
      // 刷新插件市场列表
      if (document.getElementById('storeGrid')) {
        _pluginsCache = null;
        _renderPluginGrid();
      }
      // 刷新扩展页面（更新"已发布"状态徽标）
      if (typeof renderExtensionsPanel === 'function' && document.getElementById('extensionsList')) {
        setTimeout(renderExtensionsPanel, 100);
      }
    } catch (e) {
      _storeFeedback('发布失败: ' + e.message, 'error');
    }
  }

  function showImportDialog() {
    const input = document.getElementById('storeImportFile');
    if (input) input.click();
  }

  async function showRateModal(pluginId, name) {
    if (typeof showCustomConfirm !== 'function') return;
    const myRating = await getMyRating(pluginId);
    const hasRated = myRating > 0;
    const stars = [1,2,3,4,5].map(n => `
      <button class="store-star-btn ${n <= myRating ? 'active' : ''}" data-rate="${n}"
        onclick="window.Store.doRate('${pluginId}',${n})" title="${n}星">
        <i data-lucide="${n <= myRating ? 'star' : 'star'}" style="width:24px;height:24px;${n <= myRating ? 'fill:currentColor;' : ''}"></i>
      </button>`).join('');
    showCustomConfirm(`
      <div class="store-rate-modal">
        <h3>评分：${_esc(name)}</h3>
        <div class="store-rate-stars" id="storeRateStars">
          ${stars}
        </div>
        <div id="storeRateStatus" style="margin-top:8px;font-size:12px;min-height:16px;">${hasRated ? `<span style="color:var(--text-muted);">你已评 ${myRating} 星，点击星星可修改</span>` : ''}</div>
      </div>
    `, { title: '评分', dontAskKey: '', hideActions: true });
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
  }

  async function doRate(pluginId, rating) {
    try {
      await ratePlugin(pluginId, rating);
      document.getElementById('storeRateStatus').innerHTML = '<span style="color:var(--green);">评分成功！</span>';
      if (typeof closeCustomConfirm === 'function') setTimeout(closeCustomConfirm, 800);
      _pluginsCache = null;
      _renderPluginGrid();
    } catch (e) {
      document.getElementById('storeRateStatus').innerHTML = `<span style="color:var(--red);">${_esc(e.message)}</span>`;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 导出
  // ═══════════════════════════════════════════════════════════════
  const api = {
    renderStore,
    renderStoreSettings,
    saveStoreSettings,
    testStoreConnection,
    fetchPlugins,
    fetchUploadedExtIds,
    downloadPlugin,
    uploadPlugin,
    installFromZip,
    ratePlugin,
    onSearchChange,
    onTagChange,
    onTagClick,
    doDownload,
    doUpload,
    doRate,
    doLogin,
    doRegister,
    doSignOut,
    showAuthModal,
    switchAuthTab,
    showAccountMenu,
    showUploadModal,
    showImportDialog,
    showRateModal,
    isConfigured,
    getStoreConfig,
    saveStoreConfig
  };

  return api;
})();
