/* 当前 AI 对话的可视化系统提示词编辑器 */
'use strict';

const PROMPT_SECTION_META = [
  { key: 'role', label: '角色设定', icon: 'user', tone: 'violet', hint: 'AI 应该扮演谁，具备什么能力和态度？', placeholder: '例如：你是一位耐心、严谨的学习导师。' },
  { key: 'goal', label: '目标任务', icon: 'goal', tone: 'blue', hint: '希望 AI 完成什么，成功标准是什么？', placeholder: '例如：帮助我理解 {{主题}}，并能独立解决同类问题。' },
  { key: 'context', label: '背景信息', icon: 'notebook-text', tone: 'cyan', hint: '提供任务所需的上下文、受众和已知条件。', placeholder: '例如：\n学习阶段：{{学习阶段}}\n当前主题：{{主题}}' },
  { key: 'rules', label: '规则约束', icon: 'list-checks', tone: 'amber', hint: '列出必须遵守、需要避免的要求。', placeholder: '例如：\n- 先确认我的基础\n- 不确定时明确说明' },
  { key: 'output', label: '输出格式', icon: 'layout-list', tone: 'green', hint: '规定结构、语气、篇幅或格式。', placeholder: '例如：按“结论 → 解释 → 示例 → 自测题”的顺序回答。' },
  { key: 'examples', label: '参考示例', icon: 'messages-square', tone: 'pink', hint: '提供理想输入或输出示例，可留空。', placeholder: '例如：解释概念时，先用生活场景举例。' }
];
const PROMPT_COMMON_VARIABLES = ['主题', '学习阶段', '目标', '受众', '语气', '输出长度', '已有材料', '当前日期'];
const PROMPT_PRESETS = [
  {
    name: '学习导师', icon: 'graduation-cap',
    sections: {
      role: '你是一位耐心、严谨的学习导师，擅长用类比和循序渐进的问题解释复杂概念。',
      goal: '帮助我真正理解 {{主题}}，最终能用自己的话解释并独立解决同类问题。',
      context: '我的学习阶段：{{学习阶段}}\n当前主题：{{主题}}',
      rules: '- 先用一个简短问题确认我的基础\n- 每次只引入一个关键概念\n- 不直接给出练习题答案，先给提示\n- 对不确定的信息明确说明',
      output: '按“核心结论 → 生活化类比 → 分步讲解 → 一道自测题”的顺序回答。', examples: ''
    }
  },
  {
    name: '写作审阅', icon: 'pen-line',
    sections: {
      role: '你是一位克制、具体的中文编辑，重视作者原有风格。',
      goal: '审阅我提供的文本，找出最影响阅读与说服力的问题，并给出可执行的修改。',
      context: '目标受众：{{受众}}\n写作目的：{{目标}}',
      rules: '- 不凭空改写事实\n- 每条建议引用对应句子\n- 优先处理结构和论证，再处理措辞',
      output: '先给整体判断，再列出最多 5 个关键问题；每项包含“问题、原因、修改示例”。', examples: ''
    }
  },
  {
    name: '行动计划', icon: 'route',
    sections: {
      role: '你是一位务实的计划教练，擅长识别依赖、风险和最小行动。',
      goal: '把 {{目标}} 拆解为可以立刻开始、能够检查结果的行动计划。',
      context: '目标：{{目标}}\n可用时间：{{输出长度}}\n现有资源或限制：{{已有材料}}',
      rules: '- 优先安排最小可行步骤\n- 标出依赖和风险\n- 每一步必须有完成标准',
      output: '输出步骤、预计用时、依赖、完成标准，最后给出一个 15 分钟内可开始的行动。', examples: ''
    }
  }
];

let promptEditorMode = 'visual';
let promptRawDirty = false;
let promptConversationSearch = '';
let promptLastFocusedSection = 'goal';
let promptSaveTimer = null;

function promptEsc(value) {
  if (typeof escapeHtml === 'function') return escapeHtml(String(value == null ? '' : value));
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function emptyPromptSections() {
  return { role: '', goal: '', context: '', rules: '', output: '', examples: '' };
}

function parseSystemPrompt(raw) {
  const text = String(raw || '').trim();
  const sections = emptyPromptSections();
  if (!text) return sections;
  const labelToKey = Object.fromEntries(PROMPT_SECTION_META.map(item => [item.label, item.key]));
  const re = /【([^】]+)】\s*\n?/g;
  const matches = [...text.matchAll(re)];
  if (!matches.length) {
    sections.goal = text;
    return sections;
  }
  matches.forEach((match, index) => {
    const key = labelToKey[match[1]];
    if (!key) return;
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    sections[key] = text.slice(start, end).trim();
  });
  return sections;
}

function ensureConversationPromptModel(conv) {
  if (!conv) return { sections: emptyPromptSections(), variableValues: {} };
  if (!conv.promptBuilder || !conv.promptBuilder.sections) {
    conv.promptBuilder = { sections: parseSystemPrompt(conv.systemPrompt), variableValues: {} };
  }
  conv.promptBuilder.sections = Object.assign(emptyPromptSections(), conv.promptBuilder.sections || {});
  conv.promptBuilder.variableValues = Object.assign({}, conv.promptBuilder.variableValues || {});
  return conv.promptBuilder;
}

function detectPromptVariables(model) {
  const names = [];
  const seen = new Set();
  PROMPT_SECTION_META.forEach(meta => {
    const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
    let match;
    while ((match = re.exec(String(model.sections[meta.key] || '')))) {
      const name = match[1].trim();
      if (name && !seen.has(name)) { seen.add(name); names.push(name); }
    }
  });
  return names;
}

function resolvePromptText(text, values) {
  return String(text || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (all, rawName) => {
    const name = rawName.trim();
    if (name === '当前日期') return new Date().toLocaleDateString('zh-CN');
    const value = values[name];
    return value == null || String(value).trim() === '' ? all : String(value).trim();
  });
}

function compileConversationPrompt(model, resolveVariables) {
  return PROMPT_SECTION_META.map(meta => {
    let text = String(model.sections[meta.key] || '').trim();
    if (!text) return '';
    if (resolveVariables) text = resolvePromptText(text, model.variableValues);
    return '【' + meta.label + '】\n' + text;
  }).filter(Boolean).join('\n\n');
}

function getPromptConversations() {
  const q = promptConversationSearch.trim().toLowerCase();
  const list = typeof aiConvs !== 'undefined' && Array.isArray(aiConvs) ? aiConvs : [];
  return list.filter(conv => !q || String(conv.title || '').toLowerCase().includes(q));
}

function renderPromptStudio() {
  const root = document.getElementById('promptStudio');
  if (!root) return;
  let conv = typeof getActiveConv === 'function' ? getActiveConv() : null;
  if (!conv && typeof createNewConv === 'function') { createNewConv(); conv = getActiveConv(); }
  if (!conv) { root.innerHTML = '<div class="empty-state">无法创建 AI 对话</div>'; return; }
  const model = ensureConversationPromptModel(conv);
  const variables = detectPromptVariables(model);
  const conversations = getPromptConversations();

  root.innerHTML = `
    <aside class="prompt-library" aria-label="AI 对话列表">
      <div class="prompt-library-head"><div><span class="prompt-eyebrow">CONVERSATIONS</span><h2>AI 对话</h2></div><button class="prompt-icon-btn primary" type="button" onclick="createPromptConversation()" title="新建对话" aria-label="新建对话"><i data-lucide="plus"></i></button></div>
      <label class="prompt-search"><i data-lucide="search"></i><input id="promptSearchInput" type="search" value="${promptEsc(promptConversationSearch)}" placeholder="搜索对话…" oninput="setPromptConversationSearch(this.value)"></label>
      <p class="prompt-conversation-guide">选择一个对话，直接编辑它每次请求都会使用的系统提示词。</p>
      <div class="prompt-template-list" id="promptTemplateList">${conversations.length ? conversations.map(renderPromptConversationCard).join('') : '<div class="prompt-list-empty"><i data-lucide="search-x"></i><span>没有匹配的对话</span></div>'}</div>
      <div class="prompt-preset-panel"><span>快速套用</span>${PROMPT_PRESETS.map((preset, index) => `<button type="button" onclick="applyPromptPreset(${index})"><i data-lucide="${preset.icon}"></i>${preset.name}</button>`).join('')}</div>
    </aside>

    <main class="prompt-editor-shell">
      <header class="prompt-editor-header">
        <div class="prompt-title-fields"><span class="prompt-current-label">正在编辑当前对话</span><input id="promptNameInput" class="prompt-name-input" value="${promptEsc(conv.title || '未命名对话')}" maxlength="60" aria-label="当前对话名称" oninput="updatePromptConversationTitle(this.value)"></div>
        <div class="prompt-editor-actions"><span class="prompt-save-state" id="promptSaveState"><i data-lucide="check-circle"></i> 已同步到对话</span><div class="prompt-mode-switch"><button class="${promptEditorMode === 'visual' ? 'active' : ''}" onclick="setPromptEditorMode('visual')"><i data-lucide="layout-grid"></i>可视化</button><button class="${promptEditorMode === 'raw' ? 'active' : ''}" onclick="setPromptEditorMode('raw')"><i data-lucide="code-2"></i>原始文本</button></div><button class="prompt-icon-btn" type="button" onclick="openCurrentAiConversation()" title="返回 AI 对话" aria-label="返回 AI 对话"><i data-lucide="message-circle"></i></button></div>
      </header>
      ${promptEditorMode === 'raw' ? renderRawPromptEditor(conv) : renderVisualPromptEditor(conv, model, variables)}
    </main>`;
  bindPromptEditorEvents();
  refreshPromptPreview();
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
}

function renderPromptConversationCard(conv) {
  const active = typeof getActiveConvId === 'function' && String(getActiveConvId()) === String(conv.id);
  const text = String(conv.systemPrompt || '').trim();
  return `<button type="button" class="prompt-template-card ${active ? 'active' : ''}" onclick="selectPromptConversation('${promptEsc(conv.id)}')"><span class="prompt-template-icon"><i data-lucide="message-circle"></i></span><span class="prompt-template-copy"><strong>${promptEsc(conv.title || '未命名对话')}</strong><small>${promptEsc(text ? text.replace(/\s+/g, ' ').slice(0, 55) : '尚未设置系统提示词')}</small><em>${text.length} 字符 · ${conv.messages?.length || 0} 条消息</em></span></button>`;
}

function renderVisualPromptEditor(conv, model, variables) {
  return `<div class="prompt-workspace">
    <section class="prompt-builder" aria-label="结构化系统提示词编辑器"><div class="prompt-builder-intro"><div><h3>系统提示词结构</h3><p>修改后自动保存到“${promptEsc(conv.title || '当前对话')}”，无需再次应用。</p></div><span>${PROMPT_SECTION_META.filter(meta => String(model.sections[meta.key] || '').trim()).length}/${PROMPT_SECTION_META.length} 个区块</span></div><div class="prompt-section-grid">${PROMPT_SECTION_META.map((meta, index) => renderPromptSection(model, meta, index)).join('')}</div></section>
    <aside class="prompt-preview-panel" aria-label="系统提示词预览"><div class="prompt-preview-head"><div><span class="prompt-eyebrow">SYSTEM PROMPT</span><h3>发送给 AI 的内容</h3></div><button type="button" class="prompt-copy-btn" onclick="copyCompiledPrompt()"><i data-lucide="copy"></i>复制</button></div><div class="prompt-variable-box"><div class="prompt-variable-title"><span><i data-lucide="braces"></i>变量</span><small>${variables.length} 个</small></div><div class="prompt-quick-vars">${PROMPT_COMMON_VARIABLES.map(name => `<button type="button" onclick="insertPromptVariable('${promptEsc(name)}')">+ ${promptEsc(name)}</button>`).join('')}</div><div class="prompt-variable-values" id="promptVariableValues">${renderPromptVariableInputs(model, variables)}</div></div><pre class="prompt-preview-text" id="promptPreviewText"></pre><div class="prompt-preview-stats" id="promptPreviewStats"></div><div class="prompt-direct-sync"><i data-lucide="refresh-cw"></i><span>所有修改都会自动同步到当前 AI 对话</span></div><button type="button" class="prompt-apply-btn" onclick="openCurrentAiConversation()"><i data-lucide="message-circle"></i>返回当前对话</button><div class="prompt-action-status" id="promptActionStatus" role="status"></div></aside>
  </div>`;
}

function renderRawPromptEditor(conv) {
  return `<div class="prompt-raw-editor"><div class="prompt-builder-intro"><div><h3>原始系统提示词</h3><p>适合直接编辑已有提示词；切回可视化模式时会识别“【角色设定】”等区块。</p></div><span>${String(conv.systemPrompt || '').length} 字符</span></div><textarea id="promptRawText" aria-label="原始系统提示词" placeholder="输入这个对话要使用的系统提示词…">${promptEsc(conv.systemPrompt || '')}</textarea><div class="prompt-direct-sync"><i data-lucide="refresh-cw"></i><span>输入内容会自动保存到当前对话</span></div><button type="button" class="prompt-apply-btn prompt-raw-back" onclick="openCurrentAiConversation()"><i data-lucide="message-circle"></i>返回当前对话</button></div>`;
}

function renderPromptSection(model, meta, index) {
  return `<article class="prompt-section-card tone-${meta.tone}"><div class="prompt-section-heading"><span class="prompt-section-number">${String(index + 1).padStart(2, '0')}</span><span class="prompt-section-icon"><i data-lucide="${meta.icon}"></i></span><div><h4>${meta.label}</h4><p>${meta.hint}</p></div></div><textarea id="promptSection-${meta.key}" data-prompt-section="${meta.key}" rows="${meta.key === 'rules' || meta.key === 'context' ? 5 : 4}" placeholder="${promptEsc(meta.placeholder)}">${promptEsc(model.sections[meta.key] || '')}</textarea></article>`;
}

function renderPromptVariableInputs(model, variables) {
  if (!variables.length) return '<p class="prompt-no-vars">在编辑区插入变量后，可在这里填写当前对话使用的值。</p>';
  return variables.map(name => `<label><span>{{${promptEsc(name)}}}</span><input type="text" data-prompt-variable="${promptEsc(name)}" value="${promptEsc(model.variableValues[name] || '')}" placeholder="填写变量值"></label>`).join('');
}

function bindPromptEditorEvents() {
  const root = document.getElementById('promptStudio');
  if (!root || root.dataset.bound === 'true') return;
  root.dataset.bound = 'true';
  root.addEventListener('focusin', event => {
    const area = event.target.closest('[data-prompt-section]');
    if (area) promptLastFocusedSection = area.dataset.promptSection;
  });
  root.addEventListener('input', event => {
    const conv = getActiveConv();
    if (!conv) return;
    if (event.target.id === 'promptRawText') {
      promptRawDirty = true;
      conv.systemPrompt = event.target.value;
      conv.promptBuilder = { sections: parseSystemPrompt(conv.systemPrompt), variableValues: conv.promptBuilder?.variableValues || {} };
      scheduleConversationPromptSave();
      return;
    }
    const model = ensureConversationPromptModel(conv);
    const area = event.target.closest('[data-prompt-section]');
    if (area) {
      model.sections[area.dataset.promptSection] = area.value;
      syncVisualPromptToConversation(conv, model);
      refreshPromptVariables(); refreshPromptPreview();
      return;
    }
    const variable = event.target.closest('[data-prompt-variable]');
    if (variable) {
      model.variableValues[variable.dataset.promptVariable] = variable.value;
      syncVisualPromptToConversation(conv, model); refreshPromptPreview();
    }
  });
}

function syncVisualPromptToConversation(conv, model) {
  conv.promptBuilder = model;
  conv.systemPrompt = compileConversationPrompt(model, true);
  scheduleConversationPromptSave();
}

function scheduleConversationPromptSave() {
  clearTimeout(promptSaveTimer);
  updatePromptSaveState('正在同步…');
  promptSaveTimer = setTimeout(() => {
    if (typeof safeSaveAiConvs === 'function') safeSaveAiConvs();
    updatePromptSaveState('已同步到对话');
  }, 300);
}

function updatePromptSaveState(text) {
  const el = document.getElementById('promptSaveState');
  if (!el) return;
  el.innerHTML = `<i data-lucide="${text === '已同步到对话' ? 'check-circle' : 'loader'}"></i> ${promptEsc(text)}`;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function refreshPromptPreview() {
  const conv = typeof getActiveConv === 'function' ? getActiveConv() : null;
  const preview = document.getElementById('promptPreviewText');
  if (!conv || !preview) return;
  const text = compileConversationPrompt(ensureConversationPromptModel(conv), true);
  preview.textContent = text || '填写任一区块后，这里会实时显示发送给 AI 的系统提示词。';
  const unresolved = (text.match(/\{\{\s*[^{}]+?\s*\}\}/g) || []).length;
  const stats = document.getElementById('promptPreviewStats');
  if (stats) stats.innerHTML = `<span>${text.length} 字符</span><span>${unresolved ? unresolved + ' 个变量待填写' : '变量已就绪'}</span>`;
}

function refreshPromptVariables() {
  const model = ensureConversationPromptModel(getActiveConv());
  const wrap = document.getElementById('promptVariableValues');
  if (wrap) wrap.innerHTML = renderPromptVariableInputs(model, detectPromptVariables(model));
}

function selectPromptConversation(id) {
  const conv = (typeof aiConvs !== 'undefined' ? aiConvs : []).find(item => String(item.id) === String(id));
  if (!conv) return;
  if (typeof saveAiDraft === 'function') saveAiDraft();
  activeConvId = conv.id;
  localStorage.setItem('study_active_conv', activeConvId);
  renderPromptStudio();
}

function createPromptConversation() {
  if (typeof createNewConv === 'function') createNewConv();
  promptEditorMode = 'visual';
  renderPromptStudio();
}

function setPromptConversationSearch(value) {
  promptConversationSearch = value;
  const list = document.getElementById('promptTemplateList');
  if (!list) return;
  const conversations = getPromptConversations();
  list.innerHTML = conversations.length ? conversations.map(renderPromptConversationCard).join('') : '<div class="prompt-list-empty"><span>没有匹配的对话</span></div>';
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function updatePromptConversationTitle(value) {
  const conv = getActiveConv();
  if (!conv) return;
  conv.title = value.trim() || '未命名对话';
  scheduleConversationPromptSave();
  const card = document.querySelector('.prompt-template-card.active');
  if (card) card.outerHTML = renderPromptConversationCard(conv);
}

function setPromptEditorMode(mode) {
  if (!['visual', 'raw'].includes(mode)) return;
  if (mode === 'visual' && promptEditorMode === 'raw' && promptRawDirty) {
    const conv = getActiveConv();
    if (conv) conv.promptBuilder = { sections: parseSystemPrompt(conv.systemPrompt), variableValues: conv.promptBuilder?.variableValues || {} };
  }
  if (mode === 'raw') promptRawDirty = false;
  promptEditorMode = mode;
  renderPromptStudio();
}

async function applyPromptPreset(index) {
  const preset = PROMPT_PRESETS[index];
  const conv = getActiveConv();
  if (!preset || !conv) return;
  if (String(conv.systemPrompt || '').trim() && typeof showCustomConfirm === 'function') {
    const confirmed = await showCustomConfirm('用“' + promptEsc(preset.name) + '”替换当前对话的系统提示词吗？');
    if (!confirmed) return;
  }
  conv.promptBuilder = { sections: Object.assign(emptyPromptSections(), JSON.parse(JSON.stringify(preset.sections))), variableValues: {} };
  syncVisualPromptToConversation(conv, conv.promptBuilder);
  promptEditorMode = 'visual';
  renderPromptStudio();
  setPromptActionStatus('已将“' + preset.name + '”应用到当前对话');
}

function insertPromptVariable(name) {
  const conv = getActiveConv();
  const model = ensureConversationPromptModel(conv);
  const area = document.getElementById('promptSection-' + promptLastFocusedSection);
  if (!area) return;
  const token = '{{' + name + '}}';
  const start = area.selectionStart == null ? area.value.length : area.selectionStart;
  const end = area.selectionEnd == null ? start : area.selectionEnd;
  const prefix = start > 0 && !/\s/.test(area.value[start - 1]) ? ' ' : '';
  area.value = area.value.slice(0, start) + prefix + token + area.value.slice(end);
  model.sections[promptLastFocusedSection] = area.value;
  syncVisualPromptToConversation(conv, model);
  refreshPromptVariables(); refreshPromptPreview();
  area.focus();
}

async function copyCompiledPrompt() {
  const text = String(getActiveConv()?.systemPrompt || '');
  if (!text) { setPromptActionStatus('当前系统提示词为空', true); return; }
  try { await navigator.clipboard.writeText(text); setPromptActionStatus('系统提示词已复制'); }
  catch (_) { setPromptActionStatus('复制失败，请手动选择文本', true); }
}

function openCurrentAiConversation() {
  clearTimeout(promptSaveTimer);
  if (typeof safeSaveAiConvs === 'function') safeSaveAiConvs();
  if (typeof switchTab === 'function') switchTab('ai');
}

function setPromptActionStatus(message, isError) {
  const el = document.getElementById('promptActionStatus');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('error', !!isError);
  el.classList.add('show');
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
