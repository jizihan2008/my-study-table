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
  async function buildAgentPrompt(userReq, mode, project) {
    const ctx = await buildContext(userReq);
    const effectiveMode = mode || 'craft';
    const historyText = buildProjectHistory(project);
    const lines = [
      '你是 My Study Table（一款 Electron 学习桌面应用）的扩展开发 Agent。',
      '',
      '## 任务模式：' + _modeLabel(effectiveMode),
      _modeSystemInstruction(effectiveMode),
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
      _modePermissionConstraint(effectiveMode),
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
      _modeOutputConvention(effectiveMode),
      // 方案 C 分层注入：整个项目标签页的会话历史（近期完整 + 早期决策节点）
      ...(historyText ? ['', '## 项目对话历史（本项目此前所有轮次的对话记录）', historyText] : []),
      '## 用户需求',
      userReq
    ];
    return lines.join('\n');
  }

  // ═══════════ 项目会话分层注入（方案 C）═══════════
  // 近期消息完整重放 + 早期仅保留 clarify 问答 / plan 方案等决策节点，
  // 平衡上下文完整性与 prompt 长度。clarify 轮的问题与用户回答、
  // plan 轮的方案、craft 轮的完成摘要都会作为决策节点注入。
  const CG_HISTORY_RECENT_PAIRS = 6; // 近期完整重放的问答对数

  function buildProjectHistory(project) {
    if (!project || !Array.isArray(project.messages) || !project.messages.length) return '';
    const msgs = project.messages;
    // 最近 N 对 user+assistant 完整重放（成对计，×2 覆盖 user+assistant 两条）
    const recentStart = Math.max(0, msgs.length - CG_HISTORY_RECENT_PAIRS * 2);
    const out = [];
    let pendingUser = null;
    msgs.forEach((m, i) => {
      if (m.role === 'user') { pendingUser = { msg: m, idx: i }; return; }
      if (m.role !== 'assistant' || !pendingUser) return;
      const pair = { user: pendingUser.msg, asst: m, isRecent: i >= recentStart };
      pendingUser = null;
      const block = buildHistoryPair(pair);
      if (block) out.push(block);
    });
    return out.join('\n');
  }

  // 单个问答对的注入块：近期完整重放；早期仅保留决策节点
  function buildHistoryPair(pair) {
    const { user, asst, isRecent } = pair;
    const userText = String(user.content || '').trim();
    if (!userText) return '';
    const decision = historyDecisionNode(asst);
    if (!isRecent && !decision) return '';
    const modeMark = user.mode && user.mode !== 'craft'
      ? '（' + (cgModeBadgeLabel(user.mode) || user.mode) + '）'
      : '';
    const aiLine = decision || (function () {
      const last = getLastAgentText(asst);
      return last ? 'AI：' + last : '';
    })();
    if (!aiLine) return '';
    return '用户' + modeMark + '：' + userText + '\n' + aiLine;
  }

  // 提取消息中的决策节点文本（clarify 问答 / plan 方案 / 完成摘要），无则返回空
  function historyDecisionNode(asst) {
    if (asst && asst.clarify && Array.isArray(asst.clarify.questions) && asst.clarify.questions.length) {
      const qs = asst.clarify.questions
        .map(q => (typeof q === 'string' ? q : (q && q.q || '')))
        .filter(Boolean).join(' / ');
      let text = 'AI 澄清提问：' + qs;
      if (asst.clarify.answer) text += '\n用户回答：' + asst.clarify.answer;
      return text;
    }
    if (asst && asst.summary) {
      const s = asst.summary;
      if (s.type === 'plan') return 'AI 方案：' + (s.name || s.id) + ' — ' + (s.description || '');
      if (s.type === 'plugin' || s.type === 'patch') return 'AI 已完成开发（' + s.type + '）：' + (s.name || s.id) + ' — ' + (s.description || '');
    }
    return '';
  }

  function _modeLabel(mode) {
    if (mode === 'plan') return '方案';
    if (mode === 'ask')  return '问答';
    if (mode === 'clarify') return '澄清';
    return '开发';
  }

  function _modeSystemInstruction(mode) {
    if (mode === 'plan') {
      return [
        '你只做分析和规划，**不创建或修改任何文件**。请：',
        '1. 深入分析需求，理解用户想要什么',
        '2. 阅读相关源码，给出详细的实现方案：架构设计、文件结构、核心代码思路',
        '3. 列出实现步骤、注意事项和建议',
        '**所有文件操作（Edit/Write）都被禁用，你只能读取代码进行参考。**'
      ].join('\n');
    }
    if (mode === 'ask') {
      return [
        '你是 My Study Table 的专家顾问，**不创建或修改任何文件**。请：',
        '1. 回答用户关于应用架构、API、扩展机制的问题',
        '2. 解释代码逻辑，提供开发建议',
        '3. 阅读源码作为参考，给出详尽的解答',
        '**所有文件操作（Edit/Write）都被禁用，你只能读取代码进行参考。**'
      ].join('\n');
    }
    if (mode === 'clarify') {
      return [
        '你是需求澄清专家，**不创建或修改任何文件**。你的唯一任务是：在动手前主动向用户提问，澄清需求。',
        '请严格遵守以下行为准则：',
        '1. **信息不足就必须提问**：只要需求存在模糊点、歧义或缺失信息，就必须先提问澄清，禁止猜测、禁止假设、禁止直接给方案',
        '2. **优先提问**：宁可多问，不可不问。即使你觉得能猜，只要有任何不确定性就提问',
        '3. 一次提出 2~5 个最关键的澄清问题，覆盖：功能范围、交互细节、数据来源、边界情况、与现有功能的集成方式',
        '4. 提问要具体、可回答，尽量给出候选选项帮助用户快速选择',
        '5. 只有当你对需求完全有把握（几乎没有模糊点）时，才可以直接说明你的理解而不提问',
        '**所有文件操作（Edit/Write）都被禁用，你只能读取代码进行参考。**'
      ].join('\n');
    }
    // craft
    return '你的任务：根据用户需求，在扩展目录（当前工作目录）内创建或修改一个扩展。';
  }

  function _modePermissionConstraint(mode) {
    if (mode === 'plan' || mode === 'ask' || mode === 'clarify') {
      return '- **本模式禁止创建/修改任何文件**（工具已禁用），只可以读取源码参考。';
    }
    return '- 只允许在扩展根目录内创建/修改子目录、manifest.json、main.js 文件。';
  }

  function _modeOutputConvention(mode) {
    if (mode === 'plan') {
      return [
        '## 输出约定',
        '只需输出方案说明，**不要写文件**。',
        '在回复的最后一行输出一个 JSON 对象（不要有其他文字）：',
        '{"type":"plan","id":"计划id","name":"方案名称","description":"一句话说明","summary":"详细的实现方案说明"}'
      ].join('\n');
    }
    if (mode === 'ask') {
      return [
        '## 输出约定',
        '直接回答问题或解释代码，**不要写文件**。无需输出 JSON。'
      ].join('\n');
    }
    if (mode === 'clarify') {
      return [
        '## 输出约定',
        '只输出澄清问题，**不要写文件、不要给出实现方案**。',
        '在回复的最后一行输出一个 JSON 对象（不要有其他文字）：',
        '{"type":"clarify","questions":[{"q":"问题1","options":["候选答案1","候选答案2"]},{"q":"问题2","options":[]}]}',
        '要求：',
        '- questions 是数组，每个元素必须有 q（问题文本），最多 5 个、最少 2 个',
        '- options 为可选候选答案数组，没有候选答案时为空数组 []',
        '- 问题要具体且基于用户需求，禁止问与需求无关的泛泛问题'
      ].join('\n');
    }
    // craft
    return [
      '## 输出约定',
      '直接写入扩展文件（创建目录 + manifest.json + main.js）。',
      '全部完成后，在回复的最后一行输出一个 JSON 对象（不要有其他文字）：',
      '{"type":"plugin或patch","id":"扩展id","name":"扩展名称","description":"一句话说明","summary":"对修改和功能的详细说明，面向用户"}'
    ].join('\n');
  }

  // ── 运行 Agent（核心）──
  // project 可选：当前项目标签页对象，用于分层注入整项目会话历史
  async function runAgent(userReq, mode, project) {
    const cli = await locateCli();
    if (!cli.found) {
      throw new Error('未检测到 CodeBuddy CLI，请先安装（设置 → AI 设置 → 一键安装，或 npm install -g @tencent-ai/codebuddy-code）');
    }

    const effectiveMode = mode || 'craft';
    const proj = project || getActiveCgProject();

    // 1. 预备份所有现有扩展（agent 可能修改任一扩展）——plan/ask/clarify 模式无需备份
    if (effectiveMode === 'craft') {
      try {
        const exts = await window.electronAPI.extList();
        for (const ext of exts) {
          if (ext.hasMain) await window.electronAPI.extBackup({ id: ext.id });
        }
      } catch (e) { console.warn('[codegen] 预备份失败', e); }
    }

    // 2. 构建 prompt 并运行
    const prompt = await buildAgentPrompt(userReq, effectiveMode, proj);
    const result = await window.electronAPI.codebuddyRun({
      prompt,
      userPath: getCliPath(),
      apiKey: getCodebuddyApiKey(),
      mode: effectiveMode
    });

    // 3. 解析 agent 输出：明确失败检测优先，其次提取摘要
    //    （CLI 退出码可能为 0，但 agent 内部 result 事件带 is_error 时仍算失败）
    const hardError = extractAgentError(result.stdout);
    const ok = !!result.ok && !hardError;

    // clarify 模式：优先提取澄清问题（{type:'clarify', questions}），不作为正式摘要
    if (ok && effectiveMode === 'clarify') {
      let clarify = null;
      try { clarify = extractClarify(result.stdout); } catch (e) { console.warn('[codegen] 解析澄清失败', e); }
      return {
        ok,
        exitCode: result.exitCode,
        summary: null,
        clarify,
        stdout: result.stdout || '',
        stderr: hardError || result.stderr || ''
      };
    }

    let summary = null;
    if (ok) {
      try { summary = parseAgentSummary(result.stdout); } catch (e) { console.warn('[codegen] 解析摘要失败', e); }
    }

    // 4. 重新装载扩展（仅在 craft 模式且确实成功时）
    if (ok && effectiveMode === 'craft' && typeof window.ExtManager !== 'undefined') {
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

  // 从 agent 输出中提取澄清问题 JSON（{type:'clarify', questions:[...]}）。
  // 与 parseAgentSummary 同源两种形态：独立 JSON 行 / 嵌套在 assistant text 里。
  function extractClarify(stdout) {
    const text = String(stdout || '');
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      const m = line.match(/\{[\s\S]*\}/);
      const candidate = m ? m[0] : line;
      const obj = tryParseJson(candidate);
      if (obj && typeof obj === 'object' && obj.type === 'clarify' && Array.isArray(obj.questions)) {
        const qs = normalizeClarifyQuestions(obj.questions);
        if (qs.length) return { questions: qs };
      }
      // 形态 2：嵌套在 assistant 事件的 text 字段里
      if (obj && obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
        const nested = findClarifyInTexts(obj.message.content);
        if (nested) return nested;
      }
    }
    return null;
  }

  // 规范化澄清问题：兼容字符串与 {q, options} 两种形态，过滤空问题，上限 5 个
  function normalizeClarifyQuestions(questions) {
    const qs = [];
    for (const raw of questions) {
      const q = typeof raw === 'string' ? String(raw).trim() : (raw && typeof raw === 'object' ? String(raw.q || '').trim() : '');
      if (!q) continue;
      const options = (raw && typeof raw === 'object' && Array.isArray(raw.options))
        ? raw.options.map(o => String(o)).filter(Boolean).slice(0, 6)
        : [];
      qs.push({ q, options });
      if (qs.length >= 5) break;
    }
    return qs;
  }

  // 在 assistant 事件的 content 数组的 text 段中查找澄清 JSON
  function findClarifyInTexts(content) {
    for (let i = content.length - 1; i >= 0; i--) {
      const c = content[i];
      if (!c || typeof c.text !== 'string') continue;
      const lines = c.text.split('\n').map(l => l.trim()).filter(Boolean);
      for (let j = lines.length - 1; j >= 0; j--) {
        const m = lines[j].match(/\{[\s\S]*\}/);
        const candidate = m ? m[0] : lines[j];
        const obj = tryParseJson(candidate);
        if (obj && typeof obj === 'object' && obj.type === 'clarify' && Array.isArray(obj.questions)) {
          const qs = normalizeClarifyQuestions(obj.questions);
          if (qs.length) return { questions: qs };
        }
      }
    }
    return null;
  }

  // 判断是否为约定的插件/补丁摘要
  function isSummaryObj(obj) {
    return !!(obj && typeof obj === 'object' &&
      (obj.type === 'plugin' || obj.type === 'patch' || obj.type === 'plan') && obj.id && obj.name);
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
  // AI 编程模式：craft=写代码，plan=出方案，ask=问答，clarify=需求澄清（localStorage 持久化）
  let cgMode = (function() {
    try {
      const saved = localStorage.getItem('study_cg_mode');
      return (saved === 'plan' || saved === 'ask' || saved === 'clarify' || saved === 'craft') ? saved : 'craft';
    } catch (e) { return 'craft'; }
  })();

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

  const CG_GUIDE_ITEMS = [
    { icon: 'bot', color: '#8b5cf6', title: 'CodeBuddy Agent', desc: '调用本机 CodeBuddy CLI，agent 会自主读文件、写代码、建扩展，全栈式完成你的需求。' },
    { icon: 'message-circle-question', color: '#10b981', title: '需求澄清', desc: '需求不明确时先用澄清模式，AI 会主动提问，回答后自动带上下文进入方案与开发。' },
    { icon: 'wrench', color: '#d97706', title: '修改现有功能', desc: '可生成「源码补丁」覆盖任意全局函数，或直接修改已有扩展，卸载时自动恢复原状。' },
    { icon: 'shield-check', color: '#0284c7', title: '安全可回滚', desc: '运行前自动备份全部扩展，完成后随时可在「扩展」页面中禁用、卸载或一键回滚。' }
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

  // 用户消息上的模式徽标文案
  function cgModeBadgeLabel(mode) {
    if (mode === 'plan') return '方案';
    if (mode === 'ask') return '问答';
    if (mode === 'clarify') return '澄清';
    return '';
  }

  function renderCgMsg(m) {
    const timeHtml = m.time ? `<div class="cg-msg-time">${m.time}</div>` : '';
    if (m.role === 'user') {
      const modeBadge = m.mode && m.mode !== 'craft'
        ? `<span class="cg-mode-badge cg-mode-badge-${m.mode}">${cgModeBadgeLabel(m.mode)}</span>`
        : '';
      return `
      <div class="cg-msg user">
        <div class="cg-msg-avatar"><i data-lucide="user" class="lucide-icon" style="width:15px;height:15px;"></i></div>
        <div class="cg-msg-body">
          ${modeBadge}
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

    // 澄清提问卡：AI 主动反问，等待用户逐条回答
    if (m.clarify && !m.clarify.answered) {
      return renderCgClarifyCard(m);
    }
    // 澄清已回答：展示答案摘要 + 继续入口
    if (m.clarify && m.clarify.answered) {
      return renderCgClarifyAnswered(m);
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
      const isAsk = m.mode === 'ask';
      const isPlan = m.mode === 'plan';
      const isClarify = m.mode === 'clarify';
      // 有摘要（plan=方案卡 / plugin|patch=扩展信息卡）→ 渲染结果卡；ask/clarify 只读 → 只显示回复，无文件写入
      // plan 结束后提供「开始开发」按钮：以原需求切到 craft 模式直接开发（仿「生成实现方案」样式）
      const devBtn = isPlan
        ? `<button class="cg-apply-btn" onclick="cgStartDev('${m._uid}')"><i data-lucide="play" class="lucide-icon" style="width:14px;height:14px;"></i> 开始开发</button>`
        : '';
      const card = m.summary
        ? renderCgResultCard(m)
        : (isAsk || isPlan || isClarify
          ? `
          <div class="cg-result">
            <div class="cg-result-desc"><i data-lucide="check-circle-2" class="lucide-icon" style="width:14px;height:14px;vertical-align:-2px;"></i> ${isClarify ? 'AI 未提出澄清问题，可以直接开始规划或开发' : (isPlan ? '方案已生成' : '回答完成')}。本次为${isClarify ? '澄清' : (isPlan ? '规划' : '问答')}模式，仅读取源码参考，未修改任何文件。</div>
            <div class="cg-result-actions">
              ${devBtn}
              <button class="cg-ghost-btn" onclick="cgContinue()"><i data-lucide="plus" class="lucide-icon" style="width:14px;height:14px;"></i> 继续${isClarify ? '澄清' : (isPlan ? '规划' : '提问')}</button>
            </div>
          </div>`
          : `
          <div class="cg-result">
            <div class="cg-result-desc">Agent 执行完成。扩展文件已写入，扩展列表已刷新，可到「扩展」页面查看与管理。</div>
            <div class="cg-result-actions">
              <button class="cg-apply-btn" onclick="openExtensionsSettings()"><i data-lucide="puzzle" class="lucide-icon" style="width:14px;height:14px;"></i> 打开扩展管理</button>
              <button class="cg-ghost-btn" onclick="cgContinue()"><i data-lucide="plus" class="lucide-icon" style="width:14px;height:14px;"></i> 继续生成</button>
            </div>
          </div>`);
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

  // ── 澄清提问卡：列出 AI 提出的问题，等待用户逐条回答 ──
  function renderCgClarifyCard(m) {
    const questions = (m.clarify && m.clarify.questions) || [];
    return `
      <div class="cg-result cg-result-clarify">
        <div class="cg-result-header">
          <div class="cg-result-title-wrap">
            <span class="cg-result-title"><i data-lucide="message-circle-question" class="lucide-icon" style="width:16px;height:16px;"></i> 需求澄清</span>
            <span class="cg-mode-badge cg-mode-badge-clarify">澄清</span>
          </div>
        </div>
        <div class="cg-result-desc">在继续之前，我需要确认以下问题（请逐条填写，留空表示由 AI 决定）：</div>
        <div class="cg-clarify-list">
          ${questions.map((q, i) => `
            <div class="cg-clarify-item">
              <div class="cg-clarify-q"><span class="cg-clarify-num">${i + 1}</span>${escapeHtml(q.q)}</div>
              ${(q.options && q.options.length) ? `
                <div class="cg-clarify-options">
                  ${q.options.map((o, j) => `
                    <button class="cg-clarify-opt" data-uid="${m._uid}" data-idx="${i}" data-val="${escapeHtml(o).replace(/"/g, '&quot;')}" onclick="cgFillClarify(this)">${escapeHtml(o)}</button>`).join('')}
                </div>` : ''}
              <textarea class="cg-clarify-input" id="cgClarifyInput-${m._uid}-${i}" rows="2" placeholder="输入你的回答…（留空则由 AI 决定）"></textarea>
            </div>`).join('')}
        </div>
        <div class="cg-result-actions">
          <button class="cg-apply-btn" onclick="cgAnswerClarify('${m._uid}')"><i data-lucide="check" class="lucide-icon" style="width:14px;height:14px;"></i> 提交回答</button>
        </div>
      </div>
      ${renderCgLogToggleStream(m)}`;
  }

  // ── 澄清已回答：展示答案摘要 + 「继续规划 / 直接开发」入口 ──
  function renderCgClarifyAnswered(m) {
    const answer = (m.clarify && m.clarify.answer) || '';
    return `
      <div class="cg-result cg-result-clarify-done">
        <div class="cg-result-header">
          <div class="cg-result-title-wrap">
            <span class="cg-result-title"><i data-lucide="check-circle-2" class="lucide-icon" style="width:16px;height:16px;"></i> 澄清回答已记录</span>
            <span class="cg-mode-badge cg-mode-badge-clarify">澄清</span>
          </div>
        </div>
        <div class="cg-clarify-answer">
          <div class="cg-col-title"><i data-lucide="info" class="lucide-icon" style="width:13px;height:13px;"></i> 你的回答（已注入项目会话，后续方案与开发会基于它）</div>
          <pre class="cg-clarify-answer-text">${escapeHtml(answer)}</pre>
        </div>
        <div class="cg-result-actions">
          <button class="cg-apply-btn" onclick="cgProceedAfterClarify('${m._uid}', 'plan')"><i data-lucide="map" class="lucide-icon" style="width:14px;height:14px;"></i> 生成实现方案</button>
          <button class="cg-ghost-btn" onclick="cgProceedAfterClarify('${m._uid}', 'craft')"><i data-lucide="wand-2" class="lucide-icon" style="width:14px;height:14px;"></i> 直接开发</button>
        </div>
      </div>
      ${renderCgLogToggleStream(m)}`;
  }

  function renderCgResultCard(m) {
    const s = m.summary;
    // plan 模式：方案卡（不写文件）
    if (s.type === 'plan') {
      return `
      <div class="cg-result">
        <div class="cg-result-header">
          <div class="cg-result-title-wrap">
            <span class="cg-result-title"><i data-lucide="map" class="lucide-icon" style="width:16px;height:16px;"></i> ${escapeHtml(s.name || s.id)}</span>
            <span class="cg-mode-badge cg-mode-badge-plan">实现方案</span>
          </div>
        </div>
        <div class="cg-result-desc">${escapeHtml(s.description || '')}</div>
        <div class="cg-result-col cg-result-col-summary">
          <div class="cg-col-title"><i data-lucide="info" class="lucide-icon" style="width:13px;height:13px;"></i> 方案说明</div>
          <div class="cg-summary-md">${renderMarkdownSafe(s.summary || '（无说明）')}</div>
        </div>
        <div class="cg-result-actions">
          <button class="cg-apply-btn" onclick="cgStartDev('${m._uid}')"><i data-lucide="play" class="lucide-icon" style="width:14px;height:14px;"></i> 开始开发</button>
          <button class="cg-ghost-btn" onclick="cgContinue()"><i data-lucide="plus" class="lucide-icon" style="width:14px;height:14px;"></i> 继续规划</button>
        </div>
      </div>`;
    }
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

  // ── AI 编程模式选择器 ──
  function cgSetMode(mode) {
    if (!['craft', 'plan', 'ask', 'clarify'].includes(mode)) mode = 'craft';
    cgMode = mode;
    try { localStorage.setItem('study_cg_mode', mode); } catch (e) { /* 忽略 */ }
    // 更新按钮状态
    const sel = document.getElementById('codegenModeSelector');
    if (sel) {
      sel.querySelectorAll('.cg-mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === mode);
      });
    }
    // 更新 placeholder
    const ta = document.getElementById('codegenReqInput');
    if (ta) ta.placeholder = _cgPlaceholder();
    // 更新按钮文字
    const btn = document.getElementById('codegenGenBtn');
    if (btn) {
      const span = btn.querySelector('span');
      if (span) {
        if (mode === 'plan') span.textContent = '生成方案';
        else if (mode === 'ask') span.textContent = '提问';
        else if (mode === 'clarify') span.textContent = '澄清需求';
        else span.textContent = '运行 Agent';
      }
    }
  }

  function _cgPlaceholder() {
    if (cgMode === 'plan') return '描述你想要的扩展功能，AI 会给出详细的实现方案（不会写文件）';
    if (cgMode === 'ask')  return '问关于应用架构、API、扩展开发的任何问题（不会写文件）';
    if (cgMode === 'clarify') return '描述你的需求，AI 会先主动澄清关键问题再继续（不会写文件）';
    return '描述你想要的功能或修改，例如：在待办页面加一个「随机挑一个任务」按钮（Enter 发送）';
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
        <div class="cg-mode-selector" id="codegenModeSelector">
          <button class="cg-mode-btn${cgMode === 'craft' ? ' active' : ''}" data-mode="craft" onclick="cgSetMode('craft')" title="开发——全功能模式，可读写文件">
            <i data-lucide="wand-2" class="lucide-icon" style="width:14px;height:14px;"></i> 开发
          </button>
          <button class="cg-mode-btn${cgMode === 'plan' ? ' active' : ''}" data-mode="plan" onclick="cgSetMode('plan')" title="方案——只读，给出实现方案和架构设计">
            <i data-lucide="map" class="lucide-icon" style="width:14px;height:14px;"></i> 方案
          </button>
          <button class="cg-mode-btn${cgMode === 'ask' ? ' active' : ''}" data-mode="ask" onclick="cgSetMode('ask')" title="问答——只读，解答代码和应用问题">
            <i data-lucide="help-circle" class="lucide-icon" style="width:14px;height:14px;"></i> 问答
          </button>
          <button class="cg-mode-btn${cgMode === 'clarify' ? ' active' : ''}" data-mode="clarify" onclick="cgSetMode('clarify')" title="澄清——只读，AI 先主动提问澄清需求，不写文件">
            <i data-lucide="message-circle-question" class="lucide-icon" style="width:14px;height:14px;"></i> 澄清
          </button>
        </div>
        <div class="cg-input-row">
          <textarea id="codegenReqInput" rows="3"
            placeholder="${_cgPlaceholder()}"
            onkeydown="handleCgInputKey(event)" oninput="autoResizeCgInput()"></textarea>
          <button id="codegenGenBtn" class="cg-gen-btn" onclick="cgGenerate()">
            <i data-lucide="sparkles" class="lucide-icon" style="width:17px;height:17px;"></i>
            <span>运行 Agent</span>
          </button>
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
    p.messages.push({ role: 'user', content: req, time: timeStr, mode: cgMode });
    const aMsg = { role: 'assistant', content: '', time: timeStr, running: true, ok: false, exitCode: null, summary: null, log: '', logGroups: [], error: null, _uid: genCgId(), mode: cgMode };
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
      const res = await runAgent(req, cgMode);
      aMsg.running = false;
      aMsg.ok = !!res.ok;
      aMsg.exitCode = res.exitCode;
      aMsg.summary = res.summary || null;
      aMsg.clarify = res.clarify
        ? { questions: res.clarify.questions || [], answered: false, answer: '' }
        : null;
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

  // ── 澄清交互：查找消息 / 填充选项 / 提交回答 / 继续生成 ──
  function findCgMessage(uid) {
    for (const p of cgProjects) {
      const m = (p.messages || []).find(x => x._uid === uid);
      if (m) return m;
    }
    return null;
  }

  // 点击澄清选项：把选项文本填入对应问题的输入框并高亮
  function cgFillClarify(btn) {
    if (!btn) return;
    const uid = btn.getAttribute('data-uid');
    const idx = btn.getAttribute('data-idx');
    const val = btn.getAttribute('data-val') || '';
    const ta = (uid && idx !== null) ? document.getElementById('cgClarifyInput-' + uid + '-' + idx) : null;
    if (ta) ta.value = val;
    const opts = btn.parentNode ? btn.parentNode.querySelectorAll('.cg-clarify-opt') : [];
    opts.forEach(o => o.classList.remove('active'));
    btn.classList.add('active');
  }

  // 提交澄清回答：收集各问题输入框的非空回答 → 写入消息 → 切换到「已回答」卡
  function cgAnswerClarify(uid) {
    const m = findCgMessage(uid);
    if (!m) return;
    const qs = (m.clarify && m.clarify.questions) || [];
    const answers = [];
    qs.forEach((q, i) => {
      const ta = document.getElementById('cgClarifyInput-' + uid + '-' + i);
      const val = ta ? ta.value.trim() : '';
      if (val) answers.push((q.q || '问题' + (i + 1)) + '：' + val);
    });
    if (!m.clarify) m.clarify = {};
    m.clarify.answer = answers.length > 0 ? answers.join('\n') : '（用户未填写具体回答，由 AI 自行决定）';
    m.clarify.answered = true;
    saveCgProjects();
    renderCodegen();
  }

  // 已回答后继续：按 mode 重新跑 Agent（plan=生成方案 / craft=直接开发），需求=澄清回答
  async function cgProceedAfterClarify(uid, mode) {
    if (_generating) { cgStatus('已有 Agent 在运行，请等待完成。', true); return; }
    const p = getActiveCgProject();
    if (!p) return;
    const m = findCgMessage(uid);
    if (!m) return;
    if (mode !== 'plan' && mode !== 'craft') mode = 'craft';
    const answer = (m.clarify && m.clarify.answer) || '';
    const req = (answer && answer.indexOf('（用户未填写具体回答') !== 0) ? answer : '请基于上面的需求继续生成。';
    if (typeof cgSetMode === 'function') cgSetMode(mode);
    const timeStr = nowTime();
    p.messages.push({ role: 'user', content: '（澄清回答）\n' + req, time: timeStr, mode });
    const aMsg = { role: 'assistant', content: '', time: timeStr, running: true, ok: false, exitCode: null, summary: null, log: '', logGroups: [], error: null, _uid: genCgId(), mode };
    p.messages.push(aMsg);
    if (m.clarify) m.clarify.answered = true;
    saveCgProjects();
    _generating = true;
    renderCodegen();
    scrollCgToBottom();
    cgStatus('正在运行 CodeBuddy Agent（基于澄清回答）…');
    const appendAgentLog = createLogAppender(aMsg);
    const off = (typeof window.electronAPI !== 'undefined' && window.electronAPI.onCodegenAgentOutput)
      ? window.electronAPI.onCodegenAgentOutput((payload) => {
          if (payload && payload.text) appendAgentLog(payload.text);
        }) : null;
    try {
      const res = await runAgent(req, mode);
      aMsg.running = false;
      aMsg.ok = !!res.ok;
      aMsg.exitCode = res.exitCode;
      aMsg.summary = res.summary || null;
      aMsg.clarify = res.clarify ? { questions: res.clarify.questions || [], answered: false, answer: '' } : null;
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
      cgStatus(aMsg.ok ? 'Agent 执行完成。' : 'Agent 执行失败，详见消息区日志。', !aMsg.ok);
    }
  }

  // plan 结束后开始开发：用该 plan 消息对应的原需求，切到 craft 模式直接运行 Agent
  async function cgStartDev(uid) {
    if (_generating) { cgStatus('已有 Agent 在运行，请等待完成。', true); return; }
    const p = getActiveCgProject();
    if (!p) return;
    const m = findCgMessage(uid);
    if (!m) return;
    // 找该 assistant 消息之前最近的 user 消息作为需求
    const idx = (p.messages || []).indexOf(m);
    let req = '';
    for (let i = idx - 1; i >= 0; i--) {
      const um = p.messages[i];
      if (um && um.role === 'user') { req = (um.content || '').trim(); break; }
    }
    if (!req) req = '请基于上面的方案开始开发。';
    if (typeof cgSetMode === 'function') cgSetMode('craft');
    const timeStr = nowTime();
    p.messages.push({ role: 'user', content: req, time: timeStr, mode: 'craft' });
    const aMsg = { role: 'assistant', content: '', time: timeStr, running: true, ok: false, exitCode: null, summary: null, log: '', logGroups: [], error: null, _uid: genCgId(), mode: 'craft' };
    p.messages.push(aMsg);
    saveCgProjects();
    _generating = true;
    renderCodegen();
    scrollCgToBottom();
    cgStatus('正在运行 CodeBuddy Agent（开始开发）…');
    const appendAgentLog = createLogAppender(aMsg);
    const off = (typeof window.electronAPI !== 'undefined' && window.electronAPI.onCodegenAgentOutput)
      ? window.electronAPI.onCodegenAgentOutput((payload) => {
          if (payload && payload.text) appendAgentLog(payload.text);
        }) : null;
    try {
      const res = await runAgent(req, 'craft');
      aMsg.running = false;
      aMsg.ok = !!res.ok;
      aMsg.exitCode = res.exitCode;
      aMsg.summary = res.summary || null;
      aMsg.clarify = res.clarify ? { questions: res.clarify.questions || [], answered: false, answer: '' } : null;
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
      cgStatus(aMsg.ok ? 'Agent 执行完成。' : 'Agent 执行失败，详见消息区日志。', !aMsg.ok);
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
  window.openSettingsApiTab = openSettingsApiTab;
  window.openExtensionsSettings = openExtensionsSettings;
  window.cgContinue = cgContinue;
  window.cgStartDev = cgStartDev;
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
  window.cgSetMode = cgSetMode;
  // 澄清交互
  window.cgFillClarify = cgFillClarify;
  window.cgAnswerClarify = cgAnswerClarify;
  window.cgProceedAfterClarify = cgProceedAfterClarify;

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
