/* Shared prompt templates. App data is resolved immediately before each request. */
'use strict';

const PROMPT_TEMPLATES_KEY = 'study_prompt_templates_v1';
const PROMPT_TEMPLATE_DEFS = [
  { id: 'chat', name: '普通聊天', icon: 'message-circle', description: '所有普通对话默认使用' },
  { id: 'morning', name: '晨间日报', icon: 'sun', description: '生成晨间日报时使用' },
  { id: 'evening', name: '晚间日报', icon: 'moon', description: '生成晚间日报时使用' }
];
const PROMPT_INSERTIONS = [
  { token: '当前时间', hint: '发送时的本地日期和时间' },
  { token: '待办信息', hint: '发送时的待办状态、层级和截止日期' },
  { token: '今日聚焦', hint: '发送时的今日聚焦任务' },
  { token: '工具说明', hint: '当前对话实际开放的 AI 工具说明' },
  { token: '当前AI身份', hint: '本次使用的 Key 与模型信息' },
  { token: '应用快照', hint: '普通聊天发送时的完整应用数据快照' },
  { token: '日报数据', hint: '生成日报时收集的数据' },
  { token: '我的补充', hint: '生成日报前输入的补充要求' }
];
const REPORT_DEFAULTS = {
  morning: '你是用户的学习伙伴。请生成一份晨间日报，帮助用户回顾昨天、安排今天。语气清醒、温暖、有洞察力；用 Markdown 自然表达，选择最有意义的信息，不必逐项罗列。关注完成的待办、逾期事项、今日聚焦、复习与习惯，并给出明确的今日方向。\n\n当前时间：{{当前时间}}\n\n{{日报数据}}\n\n{{我的补充}}',
  evening: '你是用户的学习伙伴。请生成一份晚间日报，帮助用户总结今天、沉淀收获，并为明天指出方向。语气温暖、具体、有洞察力；用 Markdown 自然表达，选择最有意义的信息，不必逐项罗列。关注完成的待办、专注时间、笔记、复习、习惯和遗留事项。\n\n当前时间：{{当前时间}}\n\n{{日报数据}}\n\n{{我的补充}}'
};
let selectedPromptTemplate = 'chat';
let promptSelection = { start: 0, end: 0 };
let promptEditorResizeObserver = null;

function promptEsc(value) {
  if (typeof escapeHtml === 'function') return escapeHtml(String(value ?? ''));
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function loadPromptTemplates() {
  try {
    const saved = JSON.parse(localStorage.getItem(PROMPT_TEMPLATES_KEY) || '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch (_) { return {}; }
}

function getPromptTemplateDefs() {
  const custom = loadPromptTemplates().customTemplates;
  const extras = Array.isArray(custom) ? custom.filter(item =>
    item && /^custom-[\w-]+$/.test(item.id) && typeof item.name === 'string'
  ).map(item => ({ id: item.id, name: item.name, icon: 'file-text', description: '自定义普通聊天模板' })) : [];
  return [...PROMPT_TEMPLATE_DEFS, ...extras];
}

function getChatPromptTemplateDefs() {
  return getPromptTemplateDefs().filter(item => !['morning', 'evening'].includes(item.id));
}

function persistPromptTemplates(saved) {
  if (typeof saveData === 'function') saveData(PROMPT_TEMPLATES_KEY, saved);
  else localStorage.setItem(PROMPT_TEMPLATES_KEY, JSON.stringify(saved));
}

function defaultPromptTemplate(id, conv, apiCfg) {
  if (id === 'chat') {
    const full = typeof buildToolsSystemPrompt === 'function'
      ? buildToolsSystemPrompt(conv || (typeof getActiveConv === 'function' ? getActiveConv() : null), apiCfg || (typeof getEffectiveApiConfig === 'function' ? getEffectiveApiConfig() : {}))
      : '你是我的学习桌面的 AI 助手。';
    const toolsStart = full.indexOf('═══ 工具调用说明 ═══');
    const rulesStart = full.indexOf('\n规则：\n', toolsStart);
    const identityStart = full.indexOf('═══ 当前 AI 身份 ═══');
    const snapshotStart = full.indexOf('═══ 当前数据快照（只读参考） ═══');
    let editable = full;
    if (identityStart >= 0 && snapshotStart > identityStart) {
      editable = editable.slice(0, identityStart) + '{{当前AI身份}}\n\n{{应用快照}}';
    } else if (snapshotStart >= 0) {
      editable = editable.slice(0, snapshotStart) + '{{应用快照}}';
    }
    if (toolsStart >= 0 && rulesStart > toolsStart) {
      editable = editable.slice(0, toolsStart) + '{{工具说明}}' + editable.slice(rulesStart);
    }
    return editable;
  }
  return REPORT_DEFAULTS[id] || '';
}

function getPromptTemplate(id, conv, apiCfg) {
  const saved = loadPromptTemplates();
  return Object.prototype.hasOwnProperty.call(saved, id) && typeof saved[id] === 'string'
    ? saved[id] : defaultPromptTemplate(id, conv, apiCfg);
}

function savePromptTemplate(id, value) {
  const saved = loadPromptTemplates();
  saved[id] = String(value);
  persistPromptTemplates(saved);
}

function promptTodoInfo() {
  const items = typeof todos !== 'undefined' && Array.isArray(todos) ? todos : [];
  if (!items.length) return '当前没有待办。';
  const lines = items.slice(0, 100).map(todo => {
    const parents = typeof getAncestorPath === 'function' ? getAncestorPath(todo.id).map(item => item.text) : [];
    const path = [...parents, todo.text || '未命名待办'].join(' / ');
    return `- ${todo.done ? '[已完成]' : '[未完成]'} ${path}${todo.dueDate ? '；截止 ' + todo.dueDate : ''}`;
  });
  if (items.length > 100) lines.push(`（另有 ${items.length - 100} 项待办未列出）`);
  return lines.join('\n');
}

function promptFocusInfo() {
  try {
    if (typeof getTodayFocusItems === 'function') {
      const items = getTodayFocusItems().items || [];
      if (Array.isArray(items)) return items.length
        ? items.map(item => {
          const todo = typeof findTodo === 'function' ? findTodo(item.todoId) : null;
          return '- ' + (item.done ? '[已完成] ' : '[未完成] ') + (todo?.text || '已移除的待办');
        }).join('\n')
        : '今日没有设置聚焦任务。';
    }
  } catch (_) { /* Fall through. */ }
  return '今日聚焦信息暂不可用。';
}

function resolvePromptTemplate(template, context = {}) {
  let fullBuilt;
  const builtinSection = (startMarker, endMarker) => {
    if (typeof buildToolsSystemPrompt !== 'function') return '应用数据暂不可用。';
    if (fullBuilt === undefined) fullBuilt = buildToolsSystemPrompt(context.conv || (typeof getActiveConv === 'function' ? getActiveConv() : null), context.apiCfg || (typeof getEffectiveApiConfig === 'function' ? getEffectiveApiConfig() : {}));
    const full = fullBuilt;
    const start = full.indexOf(startMarker);
    const end = endMarker ? full.indexOf(endMarker, start) : -1;
    return start >= 0 ? full.slice(start, end >= 0 ? end : undefined).trimEnd() : '应用数据暂不可用。';
  };
  const values = {
    '当前时间': () => new Date().toLocaleString('zh-CN'),
    '待办信息': promptTodoInfo,
    '今日聚焦': promptFocusInfo,
    '工具说明': () => builtinSection('═══ 工具调用说明 ═══', '\n规则：\n'),
    '当前AI身份': () => builtinSection('═══ 当前 AI 身份 ═══', '═══ 当前数据快照（只读参考） ═══'),
    '应用快照': () => builtinSection('═══ 当前数据快照（只读参考） ═══'),
    '日报数据': () => context.reportData || '（仅在生成日报时插入）',
    '我的补充': () => context.userInstruction ? '我的补充：\n' + context.userInstruction : ''
  };
  return String(template ?? '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (token, name) => {
    const value = values[name.trim()];
    return value ? String(value()) : token;
  });
}

function reportDataFromLegacyPrompt(reportPrompt) {
  const text = String(reportPrompt || '');
  const start = text.indexOf('📊 **');
  const end = text.indexOf('\n---', start);
  return start >= 0 ? text.slice(start, end >= 0 ? end : undefined).trim() : text;
}

function renderPromptStudio() {
  const root = document.getElementById('promptStudio');
  if (!root) return;
  if (promptEditorResizeObserver) promptEditorResizeObserver.disconnect();
  const defs = getPromptTemplateDefs();
  const def = defs.find(item => item.id === selectedPromptTemplate) || defs[0];
  const value = getPromptTemplate(def.id);
  root.innerHTML = `
    <aside class="prompt-library" aria-label="提示词模板">
      <div class="prompt-library-head"><div><span class="prompt-eyebrow">TEMPLATES</span><h2>提示词模板</h2></div><button class="prompt-icon-btn primary" id="promptAddBtn" type="button" title="新建模板" aria-label="新建模板"><i data-lucide="plus"></i></button></div>
      <p class="prompt-conversation-guide">编辑一次，之后使用此模板时都会读取最新版。应用信息会在实际发送时插入。</p>
      <div class="prompt-template-list">${defs.map(item => `<button type="button" class="prompt-template-card ${item.id === def.id ? 'active' : ''}" data-template-id="${item.id}"><span class="prompt-template-icon"><i data-lucide="${item.icon}"></i></span><span class="prompt-template-copy"><strong>${promptEsc(item.name)}</strong><small>${item.description}</small></span></button>`).join('')}</div>
    </aside>
    <main class="prompt-editor-shell">
      <header class="prompt-editor-header"><div class="prompt-title-fields"><span class="prompt-current-label">正在编辑模板</span><strong class="prompt-name-input">${promptEsc(def.name)}</strong></div><div class="prompt-editor-actions"><span class="prompt-save-state" id="promptSaveState">已保存</span>${def.id.startsWith('custom-') ? '<button class="prompt-copy-btn" type="button" id="promptDeleteBtn"><i data-lucide="trash-2"></i>删除模板</button>' : '<button class="prompt-copy-btn" type="button" id="promptResetBtn"><i data-lucide="rotate-ccw"></i>恢复默认</button>'}</div></header>
      <div class="prompt-workspace prompt-template-workspace">
        <section class="prompt-builder prompt-full-editor"><div class="prompt-builder-intro"><div><h3>提示词全文</h3><p>直接编辑完整文本。点击右侧的信息项，可将标记插入光标处。</p></div><span id="promptLength">${value.length} 字符</span></div><div class="prompt-text-editor"><pre class="prompt-highlight-layer" id="promptHighlightLayer" aria-hidden="true"></pre><textarea id="promptTemplateText" aria-label="${def.name}提示词全文" spellcheck="false">${promptEsc(value)}</textarea></div></section>
        <aside class="prompt-preview-panel"><div class="prompt-preview-head"><div><span class="prompt-eyebrow">APP DATA</span><h3>插入应用信息</h3></div></div><p class="prompt-insert-help">标记在编辑时保持原样；每次发送时读取当时的信息并替换。</p><div class="prompt-insertion-list">${PROMPT_INSERTIONS.map(item => `<button type="button" data-insert-token="${item.token}"><span><strong>${item.token}</strong><small>${item.hint}</small></span><code>{{${item.token}}}</code></button>`).join('')}</div><div class="prompt-preview-head prompt-live-head"><div><span class="prompt-eyebrow">PREVIEW</span><h3>当前数据预览</h3></div><button type="button" class="prompt-copy-btn" id="promptCopyBtn"><i data-lucide="copy"></i>复制</button></div><pre class="prompt-preview-text" id="promptPreviewText"></pre><p class="prompt-insert-help">实际发送时会重新获取数据。</p></aside>
      </div>
    </main>`;
  const area = root.querySelector('#promptTemplateText');
  area.addEventListener('input', () => {
    promptSelection = { start: area.selectionStart, end: area.selectionEnd };
    savePromptTemplate(def.id, area.value);
    root.querySelector('#promptLength').textContent = `${area.value.length} 字符`;
    root.querySelector('#promptSaveState').textContent = '已保存';
    refreshPromptTokenHighlights();
    refreshPromptTemplatePreview();
  });
  area.addEventListener('scroll', syncPromptTokenHighlights);
  if (typeof ResizeObserver !== 'undefined') {
    promptEditorResizeObserver = new ResizeObserver(syncPromptTokenHighlights);
    promptEditorResizeObserver.observe(area);
  }
  for (const type of ['click', 'keyup', 'select']) area.addEventListener(type, () => { promptSelection = { start: area.selectionStart, end: area.selectionEnd }; });
  root.querySelectorAll('[data-template-id]').forEach(button => button.addEventListener('click', () => {
    selectedPromptTemplate = button.dataset.templateId;
    promptSelection = { start: 0, end: 0 };
    renderPromptStudio();
  }));
  root.querySelector('#promptAddBtn').addEventListener('click', createPromptTemplate);
  root.querySelectorAll('[data-insert-token]').forEach(button => button.addEventListener('click', () => {
    const token = `{{${button.dataset.insertToken}}}`;
    area.setRangeText(token, Math.min(promptSelection.start, area.value.length), Math.min(promptSelection.end, area.value.length), 'end');
    area.dispatchEvent(new Event('input', { bubbles: true }));
    area.focus();
  }));
  const reset = root.querySelector('#promptResetBtn');
  if (reset) reset.addEventListener('click', async () => {
    if (typeof showCustomConfirm === 'function' && !await showCustomConfirm(`恢复“${def.name}”的默认提示词吗？`)) return;
    const saved = loadPromptTemplates();
    delete saved[def.id];
    persistPromptTemplates(saved);
    renderPromptStudio();
  });
  const remove = root.querySelector('#promptDeleteBtn');
  if (remove) remove.addEventListener('click', () => deletePromptTemplate(def.id));
  root.querySelector('#promptCopyBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(root.querySelector('#promptPreviewText').textContent); root.querySelector('#promptSaveState').textContent = '已复制预览'; }
    catch (_) { root.querySelector('#promptSaveState').textContent = '复制失败'; }
  });
  refreshPromptTemplatePreview();
  refreshPromptTokenHighlights();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function refreshPromptTokenHighlights() {
  const area = document.getElementById('promptTemplateText');
  const layer = document.getElementById('promptHighlightLayer');
  if (!area || !layer) return;
  const known = new Set(PROMPT_INSERTIONS.map(item => item.token));
  let last = 0;
  let html = '';
  const pattern = /\{\{\s*([^{}]+?)\s*\}\}/g;
  for (const match of area.value.matchAll(pattern)) {
    html += promptEsc(area.value.slice(last, match.index));
    const recognized = known.has(match[1].trim());
    html += `<span class="prompt-token-highlight${recognized ? '' : ' unknown'}">${promptEsc(match[0])}</span>`;
    last = match.index + match[0].length;
  }
  layer.innerHTML = html + promptEsc(area.value.slice(last)) + '\n';
  syncPromptTokenHighlights();
}

function syncPromptTokenHighlights() {
  const area = document.getElementById('promptTemplateText');
  const layer = document.getElementById('promptHighlightLayer');
  if (!area || !layer) return;
  layer.style.right = Math.max(0, area.offsetWidth - area.clientWidth - 2) + 'px';
  layer.scrollTop = area.scrollTop;
  layer.scrollLeft = area.scrollLeft;
}

async function createPromptTemplate() {
  const answer = typeof showCustomPrompt === 'function'
    ? await showCustomPrompt('新模板名称', '我的聊天模板')
    : window.prompt('新模板名称', '我的聊天模板');
  const name = String(answer || '').trim().slice(0, 40);
  if (!name) return;
  const id = 'custom-' + (typeof genId === 'function' ? genId() : Date.now());
  const saved = loadPromptTemplates();
  saved.customTemplates = [...(Array.isArray(saved.customTemplates) ? saved.customTemplates : []), { id, name }];
  saved[id] = getPromptTemplate('chat');
  persistPromptTemplates(saved);
  selectedPromptTemplate = id;
  renderPromptStudio();
}

async function deletePromptTemplate(id) {
  const def = getPromptTemplateDefs().find(item => item.id === id);
  if (!def || !id.startsWith('custom-')) return;
  if (typeof showCustomConfirm === 'function' && !await showCustomConfirm(`删除“${def.name}”模板吗？使用它的对话将改用普通聊天模板。`)) return;
  const saved = loadPromptTemplates();
  saved.customTemplates = (saved.customTemplates || []).filter(item => item.id !== id);
  delete saved[id];
  persistPromptTemplates(saved);
  if (typeof aiConvs !== 'undefined' && Array.isArray(aiConvs)) {
    for (const conv of aiConvs) if (conv.promptTemplateId === id) conv.promptTemplateId = 'chat';
    if (typeof safeSaveAiConvs === 'function') safeSaveAiConvs();
  }
  selectedPromptTemplate = 'chat';
  renderPromptStudio();
}

function refreshPromptTemplatePreview() {
  const area = document.getElementById('promptTemplateText');
  const preview = document.getElementById('promptPreviewText');
  if (area && preview) preview.textContent = resolvePromptTemplate(area.value);
}
