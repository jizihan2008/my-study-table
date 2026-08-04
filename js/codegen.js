// ═══════════════════════════════════════════════════════════
//  AI 编程助手（codegen）— CodeBuddy CLI Agent 模式
//  通过本机 CodeBuddy CLI（-p 非交互 + stream-json）运行 agent，
//  agent 在扩展目录（可写）+ 源码目录（只读）内全栈式自动读写
//  文件生成扩展。流程：输入需求 → 检查 CLI → 预备份 → runAgent
//  → 流式日志 → 解析摘要 → 重新装载 → 提示完成。
//  本机无 CLI 时提供一键安装（npm install -g）。
//
//  UI：与 AI 助手一致的「多项目标签页 + 消息流」布局。
//  每个标签页是一个开发项目，项目内为线性消息流
//  （用户需求 → Agent 结果卡片 + 日志），数据持久化于 localStorage。
// ═══════════════════════════════════════════════════════════

window.Codegen = (function () {
  // ── CLI 状态 ──
  function getCliPath() {
    try { return localStorage.getItem('study_codebuddy_cli_path') || ''; } catch (e) { return ''; }
  }
  function getCodebuddyApiKey() {
    try { return localStorage.getItem('study_codebuddy_api_key') || ''; } catch (e) { return ''; }
  }
  function setCodebuddyApiKey(key) {
    try { localStorage.setItem('study_codebuddy_api_key', key); } catch (e) {}
  }

  // 探测 CLI 状态（缓存避免频繁探测）
  let _cliCache = null;
  async function locateCli(force) {
    if (_cliCache && !force) return _cliCache;
    try {
      const res = await window.electronAPI.codebuddyLocate({ userPath: getCliPath() });
      _cliCache = res || { ok: true, found: false, path: '' };
    } catch (e) {
      _cliCache = { ok: false, found: false, path: '', reason: String(e && e.message || e) };
    }
    return _cliCache;
  }

  // ── 登录状态检测（带缓存与防重入）──
  let _loginState = null;      // { loggedIn, reason, ok, ts }
  let _loginPromise = null;    // 并发检测共享同一 Promise
  let _loginModalShown = false; // 本会话是否已弹过登录引导

  function ensureLoginCheck(force) {
    if (typeof window.electronAPI === 'undefined' || !window.electronAPI.codebuddyCheckLogin) {
      return Promise.resolve(null);
    }
    const now = Date.now();
    if (!force && _loginState && (now - _loginState.ts < 5 * 60 * 1000)) {
      return Promise.resolve(_loginState);
    }
    if (_loginPromise) return _loginPromise;
    _loginPromise = (async () => {
      try {
        const res = await window.electronAPI.codebuddyCheckLogin({ userPath: getCliPath() });
        _loginState = { loggedIn: !!(res && res.loggedIn), reason: (res && res.reason) || '', ok: !!(res && res.ok), ts: Date.now() };
      } catch (e) {
        _loginState = { loggedIn: false, reason: String(e && e.message || e), ok: false, ts: Date.now() };
      }
      return _loginState;
    })();
    try {
      return _loginPromise.finally(() => { _loginPromise = null; });
    } catch (e) {
      _loginPromise = null;
      return Promise.resolve(_loginState);
    }
  }

  // ── 上下文构建（供 agent prompt 参考，控制 token）──
  async function buildContext(userReq) {
    let files = { js: [], css: [], indexHtml: false };
    try {
      if (typeof window.electronAPI !== 'undefined' && window.electronAPI.srcList) {
        files = await window.electronAPI.srcList();
      }
    } catch (e) { console.error('[codegen] srcList 失败', e); }

    const snippets = [];
    const targets = [
      { file: 'js/ext-api.js', limit: 50, label: 'ext-api.js（扩展 API 接口）' },
      { file: 'js/patch-engine.js', limit: 50, label: 'patch-engine.js（补丁引擎）' },
      { file: 'js/core.js', limit: 40, label: 'core.js（导航/切换）' }
    ];
    for (const t of targets) {
      try {
        const src = await window.electronAPI.srcRead({ file: t.file, offset: 0, limit: t.limit });
        snippets.push('### ' + t.label + ' (' + t.file + ')\n```js\n' + src.content + '\n```');
      } catch (e) { /* 忽略 */ }
    }

    const guessFile = guessTargetFile(userReq, files);
    if (guessFile) {
      try {
        const src = await window.electronAPI.srcRead({ file: guessFile, offset: 0, limit: 100 });
        snippets.push('### 目标文件 ' + guessFile + '（前 100 行）\n```js\n' + src.content + '\n```');
      } catch (e) { /* 忽略 */ }
    }

    return { fileList: files, snippetText: snippets.join('\n\n'), guessFile };
  }

  function guessTargetFile(req, files) {
    const kw = String(req || '').toLowerCase();
    const map = [
      ['todo', '待办', 'js/todos.js'],
      ['note', '笔记', 'js/notes.js'],
      ['link', '快捷', 'js/links.js'],
      ['habit', '习惯', 'js/habits.js'],
      ['timer', '计时', 'js/timer.js'],
      ['calendar', '日历', 'js/calendar.js'],
      ['music', '音乐', 'js/music.js'],
      ['stat', '统计', 'js/stats.js'],
      ['today', '今天', 'js/today.js']
    ];
    for (const [en, zh, file] of map) {
      if (kw.includes(en) || kw.includes(zh)) return file;
    }
    return null;
  }

  // ── 构建 Agent Prompt ──
  async function buildAgentPrompt(userReq) {
    const ctx = await buildContext(userReq);
    const lines = [
      '你是 My Study Table（一款 Electron 学习桌面应用）的扩展开发 Agent。',
      '你的任务：根据用户需求，在扩展目录（当前工作目录）内创建或修改一个扩展。',
      '',
      '## 扩展目录结构（当前工作目录即扩展根目录）',
      '每个扩展是一个子目录 <id>/，包含两个文件：',
      '- manifest.json：{ id, name, version, type, description, author, enabled: true, createdAt }',
      '- main.js：扩展代码（扩展装载时自动执行）',
      '',
      '## 两类扩展',
      '1. plugin（安全插件）：通过 extAPI 白名单接口新增功能。可用接口：',
      '   extAPI.registerNavItem({id, icon, label}) / registerSection({id, html, render}) /',
      '   addToolbarButton({icon, label, onclick}) / on(event, handler) / emit(event, data) /',
      '   getData(key) / setData(key, value) / notify(title, body) / log(...) /',
      '   callCore(fnName, ...) / openExternal(url)',
      '2. patch（源码补丁）：通过 PatchEngine 覆盖全局函数修改现有行为：',
      '   PatchEngine.wrap(extId, window, "函数名", function(original, self, args){...})',
      '   或 PatchEngine.override(extId, window, "函数名", function(){...})',
      '   卸载时自动恢复原函数。',
      '',
      '## 权限约束（必须严格遵守）',
      '- 只允许在扩展根目录内创建/修改子目录、manifest.json、main.js 文件。',
      '- 应用核心源码（js/ css/ index.html）只读，禁止修改任何核心文件。',
      '- 若目标扩展已存在，先读取其 manifest.json 与 main.js 了解现状再修改。',
      '- 避免使用 Bash 等系统命令，只做文件读写。',
      '',
      '## 源码参考',
      '### 应用文件清单',
      'js 文件：' + (ctx.fileList.js || []).join(', '),
      'css 文件：' + (ctx.fileList.css || []).join(', '),
      '',
      '### 关键源码片段',
      ctx.snippetText || '（无）',
      '',
      '## 输出约定',
      '直接写入扩展文件（创建目录 + manifest.json + main.js）。',
      '全部完成后，在回复的最后一行输出一个 JSON 对象（不要有其他文字）：',
      '{"type":"plugin或patch","id":"扩展id","name":"扩展名称","description":"一句话说明","summary":"对修改和功能的详细说明，面向用户"}',
      '',
      '## 用户需求',
      userReq
    ];
    return lines.join('\n');
  }

  // ── 运行 Agent（核心）──
  async function runAgent(userReq) {
    const cli = await locateCli();
    if (!cli.found) {
      throw new Error('未检测到 CodeBuddy CLI，请先安装（设置 → AI 设置 → 一键安装，或 npm install -g @tencent-ai/codebuddy-code）');
    }

    // 1. 预备份所有现有扩展（agent 可能修改任一扩展）
    try {
      const exts = await window.electronAPI.extList();
      for (const ext of exts) {
        if (ext.hasMain) await window.electronAPI.extBackup({ id: ext.id });
      }
    } catch (e) { console.warn('[codegen] 预备份失败', e); }

    // 2. 构建 prompt 并运行
    const prompt = await buildAgentPrompt(userReq);
    const result = await window.electronAPI.codebuddyRun({
      prompt,
      userPath: getCliPath(),
      apiKey: getCodebuddyApiKey()
    });

    // 3. 解析 agent 输出：明确失败检测优先，其次提取摘要
    //    （CLI 退出码可能为 0，但 agent 内部 result 事件带 is_error 时仍算失败）
    const hardError = extractAgentError(result.stdout);
    const ok = !!result.ok && !hardError;
    let summary = null;
    if (ok) {
      try { summary = parseAgentSummary(result.stdout); } catch (e) { console.warn('[codegen] 解析摘要失败', e); }
    }

    // 4. 重新装载扩展（仅在确实成功时）
    if (ok && typeof window.ExtManager !== 'undefined') {
      try { await window.ExtManager.loadAll(); await window.ExtManager.init(); } catch (e) { console.error('[codegen] 装载失败', e); }
    }
    if (typeof renderSidebarNav === 'function') renderSidebarNav();

    return {
      ok,
      exitCode: result.exitCode,
      summary,
      stdout: result.stdout || '',
      stderr: hardError || result.stderr || ''
    };
  }

  // 从 agent 输出中提取约定的摘要 JSON（{type:'plugin'|'patch', id, name, ...}）。
  // 必须严格匹配约定格式，避免误抓 stream-json 的系统事件
  // （如 file-history-snapshot/system/result 等恰好带 type+id 的对象）。
  // 摘要可能以两种形态出现：
  //   1. stream-json 输出中的独立一行 JSON（agent 回复最后直接输出）
  //   2. 嵌套在 assistant 事件的 text 字段里（转义后的 JSON 字符串）——
  //      此时需先解析外层事件行，再在其 text 中找摘要 JSON。
  function parseAgentSummary(stdout) {
    const text = String(stdout || '');
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    // 形态 1：独立 JSON 行（从后往前找）
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      let candidate = line;
      const m = line.match(/\{[\s\S]*\}/);
      if (m) candidate = m[0];
      const obj = tryParseJson(candidate);
      if (isSummaryObj(obj)) return obj;
      // 若该行是 assistant 事件，可能把摘要嵌套在 text 里（形态 2）
      if (obj && obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
        const nested = findSummaryInTexts(obj.message.content);
        if (nested) return nested;
      }
    }
    return null;
  }

  // 安全 JSON 解析
  function tryParseJson(s) {
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  // 判断是否为约定的插件/补丁摘要
  function isSummaryObj(obj) {
    return !!(obj && typeof obj === 'object' &&
      (obj.type === 'plugin' || obj.type === 'patch') && obj.id && obj.name);
  }

  // 在 assistant 事件的 content 数组的 text 段中查找摘要 JSON
  function findSummaryInTexts(content) {
    for (let i = content.length - 1; i >= 0; i--) {
      const c = content[i];
      if (!c || typeof c.text !== 'string') continue;
      const lines = c.text.split('\n').map(l => l.trim()).filter(Boolean);
      for (let j = lines.length - 1; j >= 0; j--) {
        const m = lines[j].match(/\{[\s\S]*\}/);
        const candidate = m ? m[0] : lines[j];
        const obj = tryParseJson(candidate);
        if (isSummaryObj(obj)) return obj;
      }
    }
    return null;
  }

  // 从 agent 输出中检测明确的失败事件（stream-json result 事件的 is_error）。
  // CLI 进程退出码为 0 时 agent 内部也可能报错（如未登录），必须据此判断真实成败。
  function extractAgentError(stdout) {
    const text = String(stdout || '');
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj && obj.type === 'result' && obj.is_error) {
          const errs = Array.isArray(obj.errors) && obj.errors.length ? obj.errors : [];
          return errs.join('；') || 'agent 执行出错';
        }
      } catch (e) { /* 继续 */ }
    }
    return '';
  }

  // ── 兼容：解析 AI 返回（旧 API 模式保留）──
  function parseGenerated(text) {
    const t = String(text || '').trim();
    const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = m ? m[1] : t;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('AI 返回不是有效 JSON');
    const obj = JSON.parse(raw.slice(start, end + 1));
    if (!obj.type || !obj.name || !obj.code) throw new Error('AI 返回缺少必需字段（type/name/code）');
    obj.id = obj.id || ('ext_' + Date.now().toString(36));
    obj.manifest = obj.manifest || {};
    return obj;
  }

  // ── 应用：自动备份 → 写扩展 → 装载（旧 API 模式保留，CLI 模式不走此路径）──
  async function apply(generated) {
    const existing = await window.electronAPI.extList();
    const exists = existing.find(e => e.id === generated.id);
    if (exists) await window.electronAPI.extBackup({ id: generated.id });

    const manifest = Object.assign({
      id: generated.id,
      name: generated.name,
      version: (generated.manifest && generated.manifest.version) || '0.1.0',
      type: generated.type,
      description: generated.description || '',
      author: (generated.manifest && generated.manifest.author) || 'AI 生成',
      enabled: true,
      createdAt: new Date().toISOString()
    }, generated.manifest);

    const writeRes = await window.electronAPI.extWrite({ id: generated.id, files: { manifest, main: generated.code } });
    if (!writeRes || writeRes.ok === false) {
      throw new Error('写入扩展失败: ' + ((writeRes && writeRes.reason) || '未知错误'));
    }
    if (typeof window.ExtManager !== 'undefined') await window.ExtManager.init();
    return { ok: true, id: generated.id };
  }

  // ── 回滚：恢复最近备份 ──
  async function rollback(id) {
    const backups = await window.electronAPI.extListBackups({ id });
    if (!backups || backups.length === 0) return { ok: false, reason: '没有可用备份' };
    const res = await window.electronAPI.extRestore({ id, backupName: backups[0].name });
    if (typeof window.ExtManager !== 'undefined') await window.ExtManager.init();
    return res;
  }

  // ═══════════ 项目数据管理（多标签页 = 多项目）═══════════
  const CG_PROJECTS_KEY = 'study_cg_projects';
  const CG_ACTIVE_KEY = 'study_active_cg_project';

  let cgProjects = [];
  let cgActiveId = null;
  let cgRenamingId = null;   // 正在内联重命名的项目 id
  let _generating = false;   // 是否有 Agent 在运行

  function genCgId() {
    return 'cg' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function nowTime() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function loadCgProjects() {
    try {
      const raw = localStorage.getItem(CG_PROJECTS_KEY);
      cgProjects = raw ? JSON.parse(raw) : [];
    } catch (e) { cgProjects = []; }
    if (!Array.isArray(cgProjects)) cgProjects = [];
    let dirty = false;
    // 每个项目补齐字段（兼容旧数据）
    cgProjects = cgProjects.map(p => Object.assign({
      id: genCgId(), title: '项目', createdAt: Date.now(), messages: [], draft: ''
    }, p));
    // 清理上次会话未完成的运行中消息（应用已重启，agent 必然已中断）
    cgProjects.forEach(p => {
      if (!Array.isArray(p.messages)) { p.messages = []; dirty = true; }
      p.messages.forEach(m => {
        if (m && m.running) {
          m.running = false;
          m.ok = false;
          m.error = m.error || '上次运行已中断（应用重启）。';
          dirty = true;
        }
      });
    });
    if (cgProjects.length === 0) {
      cgProjects = [{ id: genCgId(), title: '项目 1', createdAt: Date.now(), messages: [], draft: '' }];
      dirty = true;
    }
    cgActiveId = localStorage.getItem(CG_ACTIVE_KEY) || cgProjects[0].id;
    if (!cgProjects.some(p => p.id === cgActiveId)) cgActiveId = cgProjects[0].id;
    if (dirty) saveCgProjects();
  }

  function saveCgProjects() {
    try { localStorage.setItem(CG_PROJECTS_KEY, JSON.stringify(cgProjects)); } catch (e) {}
  }

  function getActiveCgProject() {
    return cgProjects.find(p => p.id === cgActiveId) || cgProjects[0] || null;
  }

  function createNewCgProject() {
    if (_generating) return;
    const p = { id: genCgId(), title: '新项目 ' + (cgProjects.length + 1), createdAt: Date.now(), messages: [], draft: '' };
    cgProjects.push(p);
    cgActiveId = p.id;
    localStorage.setItem(CG_ACTIVE_KEY, cgActiveId);
    saveCgProjects();
    renderCodegen();
    const input = document.getElementById('codegenReqInput');
    if (input) input.focus();
  }

  function switchCgProject(id) {
    if (!cgProjects.some(p => p.id === id)) return;
    const input = document.getElementById('codegenReqInput');
    const cur = getActiveCgProject();
    if (cur && input) cur.draft = input.value;
    cgActiveId = id;
    localStorage.setItem(CG_ACTIVE_KEY, id);
    saveCgProjects();
    renderCodegen();
  }

  function deleteCgProject(id, e) {
    if (e) e.stopPropagation();
    if (cgProjects.length <= 1) { clearCgProject(e); return; }
    const p = cgProjects.find(x => x.id === id);
    if (!p) return;
    showCustomConfirm('确定删除项目「' + p.title + '」吗？该项目全部记录将被清空。').then(ok => {
      if (!ok) return;
      cgProjects = cgProjects.filter(x => x.id !== id);
      if (cgActiveId === id) cgActiveId = cgProjects[0].id;
      localStorage.setItem(CG_ACTIVE_KEY, cgActiveId);
      saveCgProjects();
      renderCodegen();
    });
  }

  function clearCgProject(e) {
    if (e) e.stopPropagation();
    const p = getActiveCgProject();
    if (!p) return;
    showCustomConfirm('确定清空「' + p.title + '」的所有记录吗？').then(ok => {
      if (!ok) return;
      p.messages = [];
      p.draft = '';
      saveCgProjects();
      renderCodegen();
    });
  }

  // 内联重命名项目（双击标签）
  function startCgRename(id) {
    if (_generating) return;
    cgRenamingId = id;
    renderCodegen();
    const inp = document.getElementById('cgRenameInput');
    if (inp) { inp.focus(); inp.select(); }
  }

  function commitCgRename(id) {
    if (!cgRenamingId) return;
    const inp = document.getElementById('cgRenameInput');
    const p = cgProjects.find(x => x.id === id);
    if (p && inp && inp.value.trim()) p.title = inp.value.trim();
    cgRenamingId = null;
    saveCgProjects();
    renderCodegen();
  }

  function handleCgRenameKey(e, id) {
    if (e.key === 'Enter') { e.preventDefault(); commitCgRename(id); }
    else if (e.key === 'Escape') { cgRenamingId = null; renderCodegen(); }
  }

  function handleCgInputKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      cgGenerate();
    }
  }

  function autoResizeCgInput() {
    const input = document.getElementById('codegenReqInput');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }

  // ═══════════ UI 渲染 ═══════════
  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function cgStatus(msg, isError) {
    const el = document.getElementById('codegenStatus');
    if (!el) return;
    el.className = 'cg-status' + (isError ? ' error' : '');
    el.textContent = msg || '';
  }

  // 安全渲染 markdown 说明（复用 AI 聊天的渲染函数，自动转义 HTML）
  function renderMarkdownSafe(text) {
    const raw = String(text || '');
    if (typeof formatMarkdownBase === 'function') {
      try { return formatMarkdownBase(raw); } catch (e) { /* fallback */ }
    }
    return '<pre class="codegen-summary">' + escapeHtml(raw) + '</pre>';
  }

  const CG_SAMPLES = [
    '给待办加一个「随机挑一个任务」按钮，点击后随机选中一条未完成任务',
    '在笔记编辑器底部加一个实时字数统计',
    '新建一个「番茄钟」面板，25 分钟倒计时 + 开始/暂停/重置',
    '待办完成时播放一段提示音',
    '在「今天」页面加一个励志名言卡片'
  ];

  const CG_GUIDE_ITEMS = [
    { icon: 'bot', color: '#8b5cf6', title: 'CodeBuddy Agent', desc: '调用本机 CodeBuddy CLI，agent 会自主读文件、写代码、建扩展，全栈式完成你的需求。' },
    { icon: 'wrench', color: '#d97706', title: '修改现有功能', desc: '可生成「源码补丁」覆盖任意全局函数，或直接修改已有扩展，卸载时自动恢复原状。' },
    { icon: 'shield-check', color: '#10b981', title: '安全可回滚', desc: '运行前自动备份全部扩展，完成后随时可在「扩展」页面中禁用、卸载或一键回滚。' }
  ];

  // 项目标签
  function renderCgTab(p) {
    if (cgRenamingId === p.id) {
      return `<span class="cg-conv-tab renaming">
        <input class="cg-rename-input" id="cgRenameInput" value="${escapeHtml(p.title)}"
          onkeydown="handleCgRenameKey(event, '${p.id}')" onblur="commitCgRename('${p.id}')" />
      </span>`;
    }
    const active = p.id === cgActiveId;
    return `
    <button class="cg-conv-tab${active ? ' active' : ''}" data-cg-id="${p.id}"
            onclick="switchCgProject('${p.id}')"
            ondblclick="startCgRename('${p.id}')"
            title="${escapeHtml(p.title)}（双击重命名）">
      <i data-lucide="folder" class="lucide-icon" style="width:13px;height:13px;flex-shrink:0;"></i>
      <span class="cg-conv-tab-name">${escapeHtml(p.title)}</span>
      <span class="cg-conv-tab-clear" onclick="event.stopPropagation(); clearCgProject(event)" title="清空项目记录">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
      </span>
      <span class="cg-conv-tab-delete" onclick="event.stopPropagation(); deleteCgProject('${p.id}', event)" title="删除项目">✕</span>
    </button>`;
  }

  // 空态指引
  function renderCgGuideHtml() {
    const guideHtml = CG_GUIDE_ITEMS.map(it => `
      <div class="cg-guide-card">
        <div class="cg-guide-icon" style="background:${it.color}1a;color:${it.color};"><i data-lucide="${it.icon}" class="lucide-icon" style="width:20px;height:20px;"></i></div>
        <div class="cg-guide-title">${it.title}</div>
        <div class="cg-guide-desc">${it.desc}</div>
      </div>`).join('');
    return `
      <div class="cg-guide" id="cgGuide">
        <div class="cg-guide-tip"><i data-lucide="lightbulb" class="lucide-icon" style="width:14px;height:14px;"></i> 每个标签页是一个独立开发项目，在下方输入需求即可开始。</div>
        ${guideHtml}
      </div>`;
  }

  // 消息渲染
  function renderCgMessages(project) {
    return project.messages.map(m => renderCgMsg(m)).join('');
  }

  function renderCgMsg(m) {
    const timeHtml = m.time ? `<div class="cg-msg-time">${m.time}</div>` : '';
    if (m.role === 'user') {
      return `
      <div class="cg-msg user">
        <div class="cg-msg-avatar"><i data-lucide="user" class="lucide-icon" style="width:15px;height:15px;"></i></div>
        <div class="cg-msg-body">
          <div class="cg-msg-bubble cg-user-bubble">${escapeHtml(m.content)}</div>
          ${timeHtml}
        </div>
      </div>`;
    }
    return `
      <div class="cg-msg assistant">
        <div class="cg-msg-avatar"><i data-lucide="bot" class="lucide-icon" style="width:15px;height:15px;"></i></div>
        <div class="cg-msg-body">
          ${renderCgAssistantBody(m)}
          ${timeHtml}
        </div>
      </div>`;
  }

  function renderCgAssistantBody(m) {
    if (m.running) {
      const label = m.install
        ? '<i data-lucide="download" class="lucide-icon" style="width:14px;height:14px;"></i> 正在安装 CodeBuddy CLI…'
        : '<i data-lucide="loader-2" class="lucide-icon spin" style="width:14px;height:14px;"></i> Agent 运行中（可能需要 1~3 分钟），可切换标签页等待…';
      return `
        <div class="cg-msg-bubble cg-running-label">${label}</div>
        <div class="cg-log-box">
          <div class="cg-col-title"><i data-lucide="terminal" class="lucide-icon" style="width:13px;height:13px;"></i> Agent 动态</div>
          <div class="cg-log-stream" id="cgLogStream-${m._uid}">${renderCgLogGroups(m)}</div>
        </div>`;
    }

    if (m.install) {
      return `
        <div class="cg-result">
          <div class="cg-result-header">
            <div class="cg-result-title-wrap">
              <span class="cg-result-title"><i data-lucide="${m.ok ? 'check-circle-2' : 'x-circle'}" class="lucide-icon" style="width:16px;height:16px;"></i> ${m.ok ? 'CodeBuddy CLI 安装完成' : 'CodeBuddy CLI 安装失败'}</span>
            </div>
          </div>
          <div class="cg-result-desc">${m.ok ? 'CLI 已安装，现在可以直接在下方输入需求运行 Agent 了。' : escapeHtml(m.error || '安装失败，请到 设置 → AI 设置 查看详情或手动安装。')}</div>
        </div>
        ${renderCgLogToggle(m.log)}`;
    }

    if (m.ok) {
      const finalReply = renderCgFinalReply(m);
      const card = m.summary
        ? renderCgResultCard(m)
        : `
        <div class="cg-result">
          <div class="cg-result-desc">Agent 执行完成。扩展文件已写入，扩展列表已刷新，可到「扩展」页面查看与管理。</div>
          <div class="cg-result-actions">
            <button class="cg-apply-btn" onclick="openExtensionsSettings()"><i data-lucide="puzzle" class="lucide-icon" style="width:14px;height:14px;"></i> 打开扩展管理</button>
            <button class="cg-ghost-btn" onclick="cgContinue()"><i data-lucide="plus" class="lucide-icon" style="width:14px;height:14px;"></i> 继续生成</button>
          </div>
        </div>`;
      return finalReply + card + renderCgLogToggleStream(m);
    }
    // 失败
    const hint = cgAuthHint(m.error) || cgAuthHint(m.log);
    return `
      <div class="cg-result cg-result-error">
        <div class="cg-result-desc"><i data-lucide="alert-triangle" class="lucide-icon" style="width:14px;height:14px;vertical-align:-2px;"></i> Agent 执行失败（exit=${escapeHtml(m.exitCode)}）：${escapeHtml(m.error || '未知错误')}${hint ? '<br>' + hint : ''}</div>
        <div class="cg-result-actions">
          <button class="cg-ghost-btn" onclick="cgContinue()"><i data-lucide="refresh-cw" class="lucide-icon" style="width:14px;height:14px;"></i> 重试</button>
        </div>
      </div>
      ${renderCgLogToggleStream(m)}`;
  }

  // 从错误信息中识别登录/授权类问题并给出操作提示
  function cgAuthHint(text) {
    const t = String(text || '').toLowerCase();
    if (/login|log\s*in|authoriz|auth|credential|api[-\s]?key|sign\s*in|未登录|未授权|登录|授权|token/.test(t)) {
      return '提示：若为登录/授权相关错误，请在终端运行 <b>codebuddy</b> 完成登录，或到 设置 → AI 设置 配置 API Key。';
    }
    return '';
  }

  function renderCgResultCard(m) {
    const s = m.summary;
    const typeLabel = s.type === 'patch' ? '源码补丁' : '安全插件';
    return `
      <div class="cg-result">
        <div class="cg-result-header">
          <div class="cg-result-title-wrap">
            <span class="cg-result-title"><i data-lucide="${s.type === 'patch' ? 'wrench' : 'puzzle'}" class="lucide-icon" style="width:16px;height:16px;"></i> ${escapeHtml(s.name || s.id)}</span>
            <span class="ext-badge ext-badge-${s.type === 'patch' ? 'patch' : 'plugin'}">${typeLabel}</span>
            <span class="cg-result-id">id: ${escapeHtml(s.id)}</span>
          </div>
        </div>
        <div class="cg-result-desc">${escapeHtml(s.description || '')}</div>
        <div class="cg-result-split">
          <div class="cg-result-col cg-result-col-summary">
            <div class="cg-col-title"><i data-lucide="info" class="lucide-icon" style="width:13px;height:13px;"></i> 功能说明</div>
            <div class="cg-summary-md">${renderMarkdownSafe(s.summary || '（无说明）')}</div>
          </div>
          <div class="cg-result-col cg-result-col-code">
            <div class="cg-col-title"><i data-lucide="folder-check" class="lucide-icon" style="width:13px;height:13px;"></i> 已写入扩展目录</div>
            <div class="cg-summary-md">Agent 已在 <b>~/.my-study-table/extensions/${escapeHtml(s.id)}/</b> 创建扩展并装载生效。可在「扩展」页面查看代码、禁用或回滚。</div>
          </div>
        </div>
        <div class="cg-result-actions">
          <button class="cg-apply-btn" onclick="openExtensionsSettings()"><i data-lucide="puzzle" class="lucide-icon" style="width:14px;height:14px;"></i> 打开扩展管理</button>
          <button class="cg-ghost-btn" onclick="cgContinue()"><i data-lucide="plus" class="lucide-icon" style="width:14px;height:14px;"></i> 继续生成</button>
        </div>
      </div>`;
  }

  // ═══════ Agent 日志：一次回复 = 一个大气泡（对齐 CodeBuddy） ═══════
  // 数据模型：m.logGroups 是「回复组」数组。每个组 { parts:[...] } 对应一次
  // assistant 事件（同一事件内的文本 + 多个工具调用归入同一大气泡）。
  // 另有 m.logItems 兼容旧的结构化单条数据。系统初始化 / result 各成一个独立小组。

  // 完成态日志折叠：有回复组时逐组气泡展示，否则回退纯文本折叠
  function renderCgLogToggleStream(m) {
    const groups = getCgLogGroups(m);
    if (groups.length) {
      const last = getLastAgentText(m);
      const summary = last
        ? `最后回复：${last}`
        : `Agent 动态（${groups.length} 条回复）`;
      return `<details class="cg-log-toggle">
        <summary><i data-lucide="terminal" class="lucide-icon" style="width:13px;height:13px;"></i> <span class="cg-log-toggle-summary">${escapeHtml(summary)}</span></summary>
        <div class="cg-log-stream">${renderCgLogGroups(m)}</div>
      </details>`;
    }
    return renderCgLogToggle(m.log);
  }

  // 取最后一条面向用户的纯文本（排除工具调用、状态行），用于完成态摘要
  function getLastAgentText(m) {
    const groups = getCgLogGroups(m);
    for (let i = groups.length - 1; i >= 0; i--) {
      const parts = (groups[i] && groups[i].parts) || [];
      for (let j = parts.length - 1; j >= 0; j--) {
        const p = parts[j];
        if (p && p.kind === 'text' && p.text) {
          const t = p.text.replace(/\s+/g, ' ').trim();
          if (t) return t.length > 60 ? t.slice(0, 60) + '…' : t;
        }
      }
    }
    return '';
  }

  // 取最后一条完整回复文本（不截断），并剥离末尾的摘要 JSON 行
  // （摘要 JSON 已单独生成插件卡片，不应重复显示在回复里）
  function getLastAgentFullText(m) {
    const groups = getCgLogGroups(m);
    for (let i = groups.length - 1; i >= 0; i--) {
      const parts = (groups[i] && groups[i].parts) || [];
      for (let j = parts.length - 1; j >= 0; j--) {
        const p = parts[j];
        if (p && p.kind === 'text' && p.text && p.text.trim()) {
          const cleaned = stripSummaryLine(p.text);
          if (cleaned) return cleaned;
          // 该 text 全部是摘要 JSON（无正文），继续向前找真正的回复
        }
      }
    }
    return '';
  }

  // 从文本末尾剥离独立的摘要 JSON 行（形如 {"type":"patch",...}）
  function stripSummaryLine(text) {
    let lines = String(text || '').split('\n');
    while (lines.length) {
      const t = lines[lines.length - 1].trim();
      if (t.indexOf('{') === 0 && t.indexOf('}') === t.length - 1) {
        try {
          const obj = JSON.parse(t);
          if (obj && (obj.type === 'plugin' || obj.type === 'patch')) { lines.pop(); continue; }
        } catch (e) { /* 非 JSON，保留 */ }
      }
      break;
    }
    return lines.join('\n').trim();
  }

  // 完成态：在消息流中展示 AI 最后一条完整回复（markdown 渲染）
  function renderCgFinalReply(m) {
    const text = getLastAgentFullText(m);
    if (!text) return '';
    return `
      <div class="cg-msg-bubble cg-final-reply">
        <div class="cg-col-title"><i data-lucide="message-square-text" class="lucide-icon" style="width:13px;height:13px;"></i> Agent 最后回复</div>
        <div class="cg-summary-md">${renderMarkdownSafe(text)}</div>
      </div>`;
  }

  // 取消息的回复组：优先 logGroups，兼容旧 logItems / 纯文本 log
  function getCgLogGroups(m) {
    if (Array.isArray(m.logGroups) && m.logGroups.length) return m.logGroups;
    if (Array.isArray(m.logItems) && m.logItems.length) return [{ parts: m.logItems.slice() }];
    if (m.log && String(m.log).trim()) return splitLegacyLogGroups(m.log);
    return [];
  }

  // 将旧格式的累积文本拆成「每个工具调用/状态段各一组」的回复组（兼容历史数据）
  function splitLegacyLogGroups(log) {
    const groups = [];
    let cur = null;
    String(log || '').split('\n').forEach(function (l) {
      l = l.trim();
      if (!l) return;
      if (l.indexOf('🔧 调用工具 ') === 0) {
        const rest = l.slice('🔧 调用工具 '.length).trim();
        const sp = rest.indexOf(' ');
        cur = { parts: [{ kind: 'tool', name: sp > 0 ? rest.slice(0, sp) : rest, input: sp > 0 ? rest.slice(sp + 1) : '' }] };
        groups.push(cur);
      } else if (l.indexOf('✔ Agent 执行完成') === 0 || l.indexOf('✔ Agent 已连接') === 0) {
        const kind = l.indexOf('已连接') >= 0 ? 'sys' : 'ok';
        groups.push({ parts: [{ kind: kind, text: l }] });
      } else if (l.indexOf('✘') === 0 || l.indexOf('Agent 执行出错') >= 0) {
        groups.push({ parts: [{ kind: 'error', text: l }] });
      } else if (isCliMetaText(l)) {
        groups.push({ parts: [{ kind: 'sys', text: l }] });
      } else {
        if (!cur) { cur = { parts: [] }; groups.push(cur); }
        cur.parts.push({ kind: 'text', text: l });
      }
    });
    return groups;
  }

  // 渲染消息的全部回复组
  function renderCgLogGroups(m) {
    return getCgLogGroups(m).map(renderCgLogGroupHtml).join('');
  }

  // 渲染单个回复组（一个大气泡，内含文本 + 工具调用等 parts）
  function renderCgLogGroupHtml(g) {
    if (!g || !Array.isArray(g.parts)) return '';
    const body = g.parts.map(renderCgLogPartHtml).join('');
    if (!body) return '';
    const kind = groupKind(g);
    return `<div class="cg-log-group cg-log-group-${kind}">${body}</div>`;
  }

  // 推断组类别（用于外框配色）：error > ok > sys > tool > text
  function groupKind(g) {
    for (let i = 0; i < g.parts.length; i++) {
      const k = g.parts[i].kind;
      if (k === 'error') return 'error';
    }
    for (let i = 0; i < g.parts.length; i++) {
      const k = g.parts[i].kind;
      if (k === 'ok') return 'ok';
      if (k === 'sys') return 'sys';
    }
    for (let i = 0; i < g.parts.length; i++) {
      if (g.parts[i].kind === 'tool') return 'tool';
    }
    return 'text';
  }

  // 渲染单个 part（文本 / 工具调用 / 状态）
  function renderCgLogPartHtml(it) {
    if (!it) return '';
    const cls = 'cg-log-part' + (it.kind ? ' cg-log-part-' + it.kind : '');
    if (it.kind === 'tool') {
      const fullInput = it.input || '';
      return `<div class="${cls}">
        <i data-lucide="${cgToolIcon(it.name)}" class="lucide-icon" style="width:13px;height:13px;flex:none;"></i>
        <b>${escapeHtml(cgToolLabel(it.name))}</b>
        ${fullInput ? `<code class="cg-tool-input" onclick="toggleCgLogToolDetail(this)" data-full="${escapeHtml(fullInput)}" data-preview="${escapeHtml(toolInputPreview(it))}" title="点击展开/收起参数">${escapeHtml(toolInputPreview(it))}</code>` : ''}
      </div>`;
    }
    if (it.kind === 'text') {
      return `<div class="${cls}">${renderMarkdownSafe(it.text || '')}</div>`;
    }
    return `<div class="${cls}">${escapeHtml(it.text || '')}</div>`;
  }

  // 工具名 → 中文标签
  function cgToolLabel(name) {
    const n = String(name || '').toLowerCase();
    if (n.indexOf('bash') >= 0 || n.indexOf('powershell') >= 0 || n.indexOf('execute') >= 0 || n.indexOf('terminal') >= 0) return '终端命令';
    if (n.indexOf('read') >= 0) return '读取文件';
    if (n.indexOf('write') >= 0 || n.indexOf('edit') >= 0) return '写入/编辑文件';
    if (n.indexOf('grep') >= 0) return '代码搜索';
    if (n.indexOf('glob') >= 0 || n.indexOf('list_dir') >= 0 || n.indexOf('search_file') >= 0) return '查找文件';
    if (n.indexOf('web_fetch') >= 0 || n.indexOf('web_search') >= 0 || n.indexOf('fetch') >= 0) return '联网检索';
    if (n.indexOf('task') >= 0) return '子任务';
    if (n.indexOf('skill') >= 0) return '使用技能';
    if (n.indexOf('lsp') >= 0 || n.indexOf('read_lints') >= 0) return '代码检查';
    if (n.indexOf('notebook') >= 0) return '笔记编辑';
    if (n.indexOf('agent') >= 0) return '子代理';
    if (n.indexOf('notify') >= 0) return '通知';
    if (n.indexOf('image') >= 0 || n.indexOf('video') >= 0) return '生成媒体';
    return String(name || '工具');
  }

  // 工具参数折叠预览：若 JSON 参数含 description 字段则优先展示它（人类可读），
  // 否则展示截断的完整参数。完整内容始终在 data-full，点击可展开。
  function toolInputPreview(it) {
    const input = it && it.input ? String(it.input) : '';
    if (input) {
      try {
        const obj = JSON.parse(input);
        if (obj && typeof obj === 'object' && typeof obj.description === 'string' && obj.description.trim()) {
          return truncateCgInput(obj.description.trim(), 160);
        }
      } catch (e) { /* 非 JSON 参数，走截断展示 */ }
    }
    return truncateCgInput(input, 120);
  }

  // 工具参数：超长时截断显示（完整内容在 data-full，点击展开）
  function truncateCgInput(s, max) {
    s = String(s || '');
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  // 展开/收起工具参数详情（HTML onclick 调用，需挂到 window）
  function toggleCgLogToolDetail(el) {
    if (!el) return;
    const full = el.getAttribute('data-full') || '';
    const preview = el.getAttribute('data-preview') || truncateCgInput(full, 120);
    if (el.classList.contains('cg-tool-open')) {
      el.classList.remove('cg-tool-open');
      el.textContent = preview;
    } else {
      el.classList.add('cg-tool-open');
      el.textContent = full;
    }
  }
  window.toggleCgLogToolDetail = toggleCgLogToolDetail;

  // 工具名 → Lucide 图标
  function cgToolIcon(name) {
    const n = String(name || '').toLowerCase();
    if (n.indexOf('bash') >= 0 || n.indexOf('powershell') >= 0 || n.indexOf('execute') >= 0 || n.indexOf('terminal') >= 0) return 'terminal';
    if (n.indexOf('read') >= 0) return 'file-text';
    if (n.indexOf('write') >= 0 || n.indexOf('edit') >= 0) return 'pen-line';
    if (n.indexOf('grep') >= 0) return 'search';
    if (n.indexOf('glob') >= 0 || n.indexOf('list') >= 0) return 'folder-search';
    if (n.indexOf('web') >= 0 || n.indexOf('url') >= 0) return 'globe';
    if (n.indexOf('task') >= 0) return 'list-checks';
    if (n.indexOf('skill') >= 0) return 'sparkles';
    if (n.indexOf('lsp') >= 0) return 'braces';
    if (n.indexOf('notebook') >= 0) return 'notebook-pen';
    if (n.indexOf('notify') >= 0) return 'bell';
    if (n.indexOf('image') >= 0 || n.indexOf('video') >= 0) return 'image';
    return 'wrench';
  }

  // 将 stream-json 事件行解析为一个「回复组」（一次回复 = 一个大气泡）。
  // 返回 null = 噪音行（忽略）。assistant 事件含多个 content part 时归入同一组。
  function parseAgentLogLine(line) {
    const t = String(line || '');
    let trimmed = t.trim();
    // CLI 进程的 meta 提示（main.js 发送的启动/完成/异常退出）归类为 sys，
    // 不作为 AI 回复文本，避免「CodeBuddy agent 执行完成。」被误当最后回复。
    if (isCliMetaText(trimmed)) {
      return { kind: 'sys', parts: [{ kind: 'sys', text: trimmed }] };
    }
    // 行首可能被 meta 前置文本污染（如「启动 CodeBuddy CLI agent …」），
    // 尝试提取其中的 JSON 事件再解析，避免 3KB 的 init 事件整行当纯文本展示。
    if (!trimmed.startsWith('{')) {
      const braceIdx = trimmed.indexOf('{"type":');
      if (braceIdx > 0) {
        const prefix = trimmed.slice(0, braceIdx).trim();
        const jsonPart = trimmed.slice(braceIdx);
        let probe;
        try { probe = JSON.parse(jsonPart); } catch (e) { probe = null; }
        if (probe && typeof probe === 'object') {
          const groups = [];
          if (prefix) groups.push({ kind: 'plain', parts: [{ kind: 'text', text: prefix }] });
          const inner = buildGroupFromEvent(probe);
          if (inner) groups.push(inner);
          return groups.length === 1 ? groups[0] : { kind: 'multi', parts: [], _groups: groups };
        }
      }
      return trimmed ? { kind: 'plain', parts: [{ kind: 'text', text: trimmed }] } : null;
    }
    let obj;
    try { obj = JSON.parse(trimmed); } catch (e) { return trimmed ? { kind: 'plain', parts: [{ kind: 'text', text: trimmed }] } : null; }
    return buildGroupFromEvent(obj);
  }

  // 识别 main.js 发送的 CLI meta 提示文本（启动 / 完成 / 异常退出）
  function isCliMetaText(s) {
    return s.indexOf('启动 CodeBuddy CLI agent') === 0 ||
      s.indexOf('CodeBuddy agent 执行完成') === 0 ||
      s.indexOf('CodeBuddy agent 异常退出') === 0;
  }

  // 由单个 stream-json 事件对象构造回复组；无法识别时返回 null
  function buildGroupFromEvent(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.type === 'system') {
      if (obj.subtype === 'init') return { kind: 'sys', parts: [{ kind: 'sys', text: '✔ Agent 已连接（登录来源: ' + (obj.apiKeySource || '未知') + '）' }] };
      return null;
    }
    if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
      const parts = [];
      for (const c of obj.message.content) {
        if (!c) continue;
        if (c.type === 'text' && c.text) parts.push({ kind: 'text', text: c.text });
        else if (c.type === 'tool_use' && c.name) {
          let inputStr = '';
          try { inputStr = JSON.stringify(c.input || {}); } catch (e) { inputStr = ''; }
          parts.push({ kind: 'tool', name: c.name, input: inputStr });
        }
      }
      return parts.length ? { kind: 'assistant', parts: parts } : null;
    }
    if (obj.type === 'result') {
      if (obj.is_error) {
        const errs = (Array.isArray(obj.errors) && obj.errors.length) ? obj.errors.join('；') : '未知错误';
        return { kind: 'error', parts: [{ kind: 'error', text: '✘ Agent 执行出错：' + errs }] };
      }
      return { kind: 'ok', parts: [{ kind: 'ok', text: '✔ Agent 执行完成' }] };
    }
    if (obj.type === 'file-history-snapshot' || obj.type === 'progress') return null;
    return null;
  }

  // part → 纯文本行（用于兼容字段 log 的累积）
  function partToText(it) {
    if (!it) return '';
    if (it.kind === 'tool') return '🔧 调用工具 ' + it.name + (it.input ? ' ' + it.input : '');
    return it.text || '';
  }

  // 将 stream-json 事件行格式化为可读日志（纯文本折叠场景使用）
  function formatAgentLogLine(line) {
    const r = parseAgentLogLine(line);
    if (r == null) return '';
    if (r._groups) return r._groups.map(g => g.parts.map(partToText).join('\n')).join('\n') + '\n';
    return r.parts.map(partToText).join('\n') + '\n';
  }

  // Agent 日志折叠（纯文本版，install 等场景使用）
  function renderCgLogToggle(log) {
    if (!log || !String(log).trim()) return '';
    return `<details class="cg-log-toggle">
      <summary><i data-lucide="terminal" class="lucide-icon" style="width:13px;height:13px;"></i> 查看 Agent 日志</summary>
      <pre class="cg-agent-log">${escapeHtml(String(log))}</pre>
    </details>`;
  }

  // 创建按行缓冲的日志追加器：收到一个事件插一个大气泡。
  // 长 JSON 行可能被拆成多个 chunk，先按换行符拼装成完整行再解析，
  // 避免解析到半个 JSON 而误判。
  function createLogAppender(msg) {
    let buf = '';
    return function (text) {
      buf += String(text || '');
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const p of parts) {
        if (!p.trim()) continue;
        const r = parseAgentLogLine(p);
        if (r == null) continue;
        const groups = r._groups ? r._groups : [r];
        for (const g of groups) {
          msg.log += g.parts.map(partToText).join('\n') + '\n';
          msg.logGroups.push(g);
          appendCgLogGroupEl(msg, g);
        }
      }
    };
  }

  // 运行时 DOM 增量插入：一个事件 = 一个新大气泡，追加到日志流末尾。
  function appendCgLogGroupEl(msg, group) {
    const box = document.getElementById('cgLogStream-' + msg._uid);
    if (!box) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = renderCgLogGroupHtml(group);
    if (wrap.firstChild) box.appendChild(wrap.firstChild); else box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  }

  function scrollCgToBottom() {
    setTimeout(() => {
      const msgs = document.getElementById('cgMessages');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
    }, 30);
  }

  // 运行按钮状态
  function updateCgGenBtn() {
    const btn = document.getElementById('codegenGenBtn');
    if (!btn) return;
    if (_generating) {
      btn.disabled = true;
      btn.innerHTML = '<i data-lucide="loader-2" class="lucide-icon spin" style="width:17px;height:17px;"></i><span>Agent 运行中…</span>';
    } else {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="sparkles" class="lucide-icon" style="width:17px;height:17px;"></i><span>运行 Agent</span>';
    }
  }

  function renderCodegen() {
    const body = document.getElementById('codegenBody');
    if (!body) return;
    // 仅在首次（内存为空）时从 localStorage 加载；之后以内存中的对象为权威，
    // 避免重载导致运行中的消息对象引用脱离数组（丢失流式日志）。
    if (cgProjects.length === 0) loadCgProjects();
    const project = getActiveCgProject();
    if (!project) return;

    body.innerHTML = `
      <!-- 项目标签条 -->
      <div class="cg-conv-tabs-wrap" id="cgConvTabsWrap">
        ${cgProjects.map(renderCgTab).join('')}
        <button class="cg-conv-tab-add" onclick="createNewCgProject()" title="新建项目">＋</button>
      </div>

      <!-- CLI 状态条 -->
      <div class="cg-topbar">
        <div class="cg-topbar-left">
          <span class="cg-key-status" id="cgCliStatus">
            <i data-lucide="loader-2" class="lucide-icon spin" style="width:15px;height:15px;"></i>
            正在检测 CodeBuddy CLI…
          </span>
          <span class="cg-topbar-model" id="cgCliPath"></span>
        </div>
        <div class="cg-topbar-right">
          <button class="cg-key-btn" onclick="recheckCgLogin()" title="重新检测 CLI 登录状态">
            <i data-lucide="refresh-cw" class="lucide-icon" style="width:13px;height:13px;"></i> 重新检测
          </button>
          <button class="cg-key-btn" onclick="openSettingsApiTab()">
            <i data-lucide="settings" class="lucide-icon" style="width:13px;height:13px;"></i> CLI 设置
          </button>
        </div>
      </div>

      <!-- 消息流 -->
      <div class="cg-messages" id="cgMessages">
        ${project.messages.length === 0 ? renderCgGuideHtml() : renderCgMessages(project)}
      </div>

      <!-- 临时状态提示 -->
      <div class="cg-status" id="codegenStatus"></div>

      <!-- 输入区 -->
      <div class="cg-input-wrap">
        <div class="cg-input-row">
          <textarea id="codegenReqInput" rows="3"
            placeholder="描述你想要的功能或修改，例如：在待办页面加一个「随机挑一个任务」按钮（Enter 发送）"
            onkeydown="handleCgInputKey(event)" oninput="autoResizeCgInput()"></textarea>
          <button id="codegenGenBtn" class="cg-gen-btn" onclick="cgGenerate()">
            <i data-lucide="sparkles" class="lucide-icon" style="width:17px;height:17px;"></i>
            <span>运行 Agent</span>
          </button>
        </div>
        <div class="cg-samples">
          <span class="cg-samples-label"><i data-lucide="lightbulb" class="lucide-icon" style="width:13px;height:13px;"></i> 试试：</span>
          ${CG_SAMPLES.map(s => `<button class="cg-chip" onclick="fillCgSample('${escapeHtml(s).replace(/'/g, '\\u0027')}')">${escapeHtml(s)}</button>`).join('')}
        </div>
        <div class="cg-type-hint">
          <span><i data-lucide="puzzle" class="lucide-icon" style="width:13px;height:13px;"></i> 新增功能 → 生成「插件」</span>
          <span><i data-lucide="wrench" class="lucide-icon" style="width:13px;height:13px;"></i> 修改现有功能 → 生成「补丁」</span>
        </div>
      </div>
    `;

    // 恢复当前项目输入草稿
    const input = document.getElementById('codegenReqInput');
    if (input) input.value = project.draft || '';
    updateCgGenBtn();
    if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
    refreshCliBar();
    if (project.messages.length === 0) {
      const inputEl = document.getElementById('codegenReqInput');
      if (inputEl) setTimeout(function () { inputEl.focus(); }, 60);
    }
    // 异步检测登录状态：未登录（且未配置 API Key）时弹出登录引导
    ensureLoginCheck().then(function (login) {
      if (!cgLoginUsable(login)) showCgLoginModal();
    });
  }

  // 刷新顶部 CLI 状态条（已连接 / 未登录 / 未安装 三态）
  async function refreshCliBar() {
    const statusEl = document.getElementById('cgCliStatus');
    const pathEl = document.getElementById('cgCliPath');
    if (!statusEl) return;
    const cli = await locateCli(true);
    if (cli.found) {
      const login = await ensureLoginCheck();
      if (login && login.loggedIn) {
        statusEl.className = 'cg-key-status ok';
        statusEl.innerHTML = '<i data-lucide="check-circle-2" class="lucide-icon" style="width:15px;height:15px;"></i> CodeBuddy CLI 已连接';
        if (pathEl) pathEl.innerHTML = '<i data-lucide="file-code" class="lucide-icon" style="width:13px;height:13px;"></i> ' + escapeHtml(cli.path);
      } else {
        statusEl.className = 'cg-key-status installing';
        statusEl.innerHTML = '<i data-lucide="user-x" class="lucide-icon" style="width:15px;height:15px;"></i> CodeBuddy CLI 未登录';
        if (pathEl) pathEl.innerHTML = '<button class="cg-key-btn" onclick="showCgLoginModal()"><i data-lucide="log-in" class="lucide-icon" style="width:13px;height:13px;"></i> 去登录</button>';
      }
    } else {
      statusEl.className = 'cg-key-status warn';
      statusEl.innerHTML = '<i data-lucide="alert-circle" class="lucide-icon" style="width:15px;height:15px;"></i> 未安装 CodeBuddy CLI';
      if (pathEl) pathEl.innerHTML = '<button class="cg-key-btn" onclick="installCliFromCodegen()"><i data-lucide="download" class="lucide-icon" style="width:13px;height:13px;"></i> 一键安装</button>';
    }
    if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
  }

  function fillCgSample(text) {
    const input = document.getElementById('codegenReqInput');
    if (input) {
      input.value = String(text);
      input.focus();
      autoResizeCgInput();
    }
  }

  function openSettingsApiTab() {
    if (typeof openSettingsModal === 'function') openSettingsModal();
    if (typeof switchSettingsTab === 'function') switchSettingsTab('api');
  }

  function openExtensionsSettings() {
    if (typeof switchTab === 'function') switchTab('extensions');
  }

  // ── 登录引导弹窗 ──
  // 可用性判定：已配置 API Key 即可工作（无需 CLI OAuth 登录）
  function cgLoginUsable(login) {
    if (getCodebuddyApiKey()) return true;
    return !!(login && login.loggedIn);
  }

  function showCgLoginModal() {
    if (_loginModalShown) return;
    _loginModalShown = true;
    let ov = document.getElementById('cgLoginModal');
    if (ov) { ov.classList.add('open'); return; }
    ov = document.createElement('div');
    ov.className = 'modal-overlay cg-login-overlay';
    ov.id = 'cgLoginModal';
    ov.onclick = closeCgLoginModal;
    ov.innerHTML = `
      <div class="modal" style="max-width:480px;" onclick="event.stopPropagation()">
        <div class="modal-header">
          <span class="modal-title"><i data-lucide="log-in" class="lucide-icon" style="width:16px;height:16px;"></i> 需要登录 CodeBuddy</span>
          <button class="modal-close" onclick="closeCgLoginModal()"><i data-lucide="x" class="lucide-icon" style="width:16px;height:16px;"></i></button>
        </div>
        <div class="modal-body">
          <p class="cg-login-desc">未检测到 CodeBuddy CLI 登录，AI 编程 Agent 无法正常工作。请选择一种方式继续：</p>
          <div class="cg-login-actions">
            <button class="cg-login-btn primary" onclick="openCgLoginTerminal()">
              <i data-lucide="terminal" class="lucide-icon" style="width:18px;height:18px;"></i>
              <span class="cg-login-btn-text">
                <span class="cg-login-btn-main">打开终端登录</span>
                <span class="cg-login-btn-desc">自动打开终端运行 codebuddy，执行 /login 完成账号登录</span>
              </span>
            </button>
            <button class="cg-login-btn" onclick="openCgApiKeyConfig()">
              <i data-lucide="key-round" class="lucide-icon" style="width:18px;height:18px;"></i>
              <span class="cg-login-btn-text">
                <span class="cg-login-btn-main">配置 API Key</span>
                <span class="cg-login-btn-desc">跳转到设置，填写 CodeBuddy API Key 直接使用</span>
              </span>
            </button>
          </div>
          <div class="cg-login-recheck-wrap">
            <button class="cg-login-recheck" onclick="recheckCgLogin()">
              <i data-lucide="refresh-cw" class="lucide-icon" style="width:13px;height:13px;"></i> 已登录？重新检测
            </button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(ov);
    requestAnimationFrame(() => ov.classList.add('open'));
    if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
  }

  function closeCgLoginModal() {
    const ov = document.getElementById('cgLoginModal');
    if (ov) ov.classList.remove('open');
  }

  function openCgLoginTerminal() {
    closeCgLoginModal();
    if (typeof window.electronAPI !== 'undefined' && window.electronAPI.codebuddyOpenLoginTerminal) {
      window.electronAPI.codebuddyOpenLoginTerminal({ userPath: getCliPath() }).catch(function () {});
    }
    cgStatus('已打开终端，请在窗口中执行 /login 完成登录，然后点击「已登录？重新检测」。');
  }

  function openCgApiKeyConfig() {
    closeCgLoginModal();
    openSettingsApiTab();
  }

  async function recheckCgLogin() {
    closeCgLoginModal();
    cgStatus('正在重新检测登录状态…');
    _loginState = null;
    const login = await ensureLoginCheck(true);
    if (cgLoginUsable(login)) {
      cgStatus('登录状态正常，可以开始使用。');
    } else {
      cgStatus('仍未检测到登录，请先在终端 /login 或配置 API Key。', true);
    }
    if (typeof refreshCliBar === 'function') refreshCliBar();
  }

  // ── 一键安装 CLI（AI 编程页入口，安装日志写入当前项目消息流）──
  async function installCliFromCodegen() {
    if (typeof window.electronAPI === 'undefined' || !window.electronAPI.codebuddyInstall) return;
    if (_generating) { cgStatus('已有 Agent 在运行，请稍后再安装 CLI。', true); return; }
    const p = getActiveCgProject();
    if (!p) return;

    const aMsg = { role: 'assistant', content: '', time: nowTime(), running: true, ok: false, summary: null, log: '', logGroups: [], error: null, install: true, _uid: genCgId() };
    p.messages.push(aMsg);
    p.draft = '';
    saveCgProjects();
    renderCodegen();

    const appendLog = (text) => {
      if (!text) return;
      aMsg.log += text;
      const el = document.getElementById('cgLog-' + aMsg._uid);
      if (el) { el.textContent = aMsg.log; el.scrollTop = el.scrollHeight; }
    };

    const off = window.electronAPI.onCodebuddyInstallOutput((payload) => {
      if (payload && payload.text) appendLog(payload.text);
    });
    try {
      const res = await window.electronAPI.codebuddyInstall({ useMirror: true });
      aMsg.running = false;
      aMsg.ok = !!(res && res.ok);
      if (!aMsg.ok) aMsg.error = ((res && res.reason) || '未知错误');
    } catch (e) {
      aMsg.running = false;
      aMsg.ok = false;
      aMsg.error = String(e && e.message || e);
    } finally {
      if (typeof off === 'function') off();
      saveCgProjects();
      renderCodegen();
      await refreshCliBar();
      if (typeof renderCodegenConfig === 'function') renderCodegenConfig();
    }
  }

  // ── 生成（CLI Agent 模式，写入当前项目消息流）──
  async function cgGenerate() {
    const input = document.getElementById('codegenReqInput');
    const req = (input && input.value || '').trim();
    if (!req) { cgStatus('请输入需求描述', true); return; }
    if (_generating) { cgStatus('已有 Agent 在运行，请等待完成或切换标签页查看进度。', true); return; }

    const cli = await locateCli();
    if (!cli.found) {
      cgStatus('未检测到 CodeBuddy CLI，请先点击顶部「一键安装」或到 设置 → AI 设置 配置。', true);
      return;
    }

    const p = getActiveCgProject();
    if (!p) return;

    // 写入用户需求 + 空的 assistant 消息（运行中）
    p.draft = '';
    const timeStr = nowTime();
    p.messages.push({ role: 'user', content: req, time: timeStr });
    const aMsg = { role: 'assistant', content: '', time: timeStr, running: true, ok: false, exitCode: null, summary: null, log: '', logGroups: [], error: null, _uid: genCgId() };
    p.messages.push(aMsg);
    if (input) input.value = '';
    saveCgProjects();

    _generating = true;
    renderCodegen();
    updateCgGenBtn();
    cgStatus('正在运行 CodeBuddy Agent（可能需 1~3 分钟），可切换标签页等待…');

    const appendAgentLog = createLogAppender(aMsg);
    const off = (typeof window.electronAPI !== 'undefined' && window.electronAPI.onCodegenAgentOutput)
      ? window.electronAPI.onCodegenAgentOutput((payload) => {
          if (payload && payload.text) appendAgentLog(payload.text);
        }) : null;

    try {
      const res = await runAgent(req);
      aMsg.running = false;
      aMsg.ok = !!res.ok;
      aMsg.exitCode = res.exitCode;
      aMsg.summary = res.summary || null;
      aMsg.error = !res.ok ? (res.stderr || 'exit-' + res.exitCode) : null;
      saveCgProjects();
    } catch (e) {
      aMsg.running = false;
      aMsg.ok = false;
      aMsg.exitCode = null;
      aMsg.error = String(e && e.message || e);
      saveCgProjects();
    } finally {
      if (off) off();
      _generating = false;
      renderCodegen();
      scrollCgToBottom();
      cgStatus(aMsg.ok ? 'Agent 执行完成，扩展已写入并装载。' : 'Agent 执行失败，详见消息区日志。', !aMsg.ok);
    }
  }

  // 继续生成 / 重新输入（兼容入口：聚焦输入框）
  function cgContinue() {
    const input = document.getElementById('codegenReqInput');
    if (input) { input.value = ''; input.focus(); }
    cgStatus('');
  }

  function cgDiscard() {
    cgContinue();
  }

  // 暴露给全局（onclick 使用）
  window.renderCodegen = renderCodegen;
  window.cgGenerate = cgGenerate;
  window.cgDiscard = cgDiscard;
  window.fillCgSample = fillCgSample;
  window.openSettingsApiTab = openSettingsApiTab;
  window.openExtensionsSettings = openExtensionsSettings;
  window.cgContinue = cgContinue;
  window.installCliFromCodegen = installCliFromCodegen;
  window.refreshCliBar = refreshCliBar;
  window.locateCodebuddyCli = locateCli;
  window.getCodebuddyApiKey = getCodebuddyApiKey;
  window.setCodebuddyApiKey = setCodebuddyApiKey;
  window.parseAgentSummary = parseAgentSummary;
  // 项目管理（标签页交互）
  window.createNewCgProject = createNewCgProject;
  window.switchCgProject = switchCgProject;
  window.deleteCgProject = deleteCgProject;
  window.clearCgProject = clearCgProject;
  window.startCgRename = startCgRename;
  window.commitCgRename = commitCgRename;
  window.handleCgRenameKey = handleCgRenameKey;
  window.handleCgInputKey = handleCgInputKey;
  window.autoResizeCgInput = autoResizeCgInput;
  // 登录引导
  window.showCgLoginModal = showCgLoginModal;
  window.closeCgLoginModal = closeCgLoginModal;
  window.openCgLoginTerminal = openCgLoginTerminal;
  window.openCgApiKeyConfig = openCgApiKeyConfig;
  window.recheckCgLogin = recheckCgLogin;

  return {
    buildContext,
    buildAgentPrompt,
    runAgent,
    parseGenerated,
    parseAgentSummary,
    apply,
    rollback,
    locateCli,
    renderCodegen
  };
})();
