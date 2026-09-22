// ═══════════════════════════════════════════════
//  AI 附件处理：文件上传、预览、PDF 本地兼容、Kimi 文件处理、图片识别与预处理
//  · 文本类附件：按纯文本读取后拼进提示词
//  · PDF 附件：非 Kimi 模型可由用户选择提取文字，或逐页渲染为图片
//  · 图片附件：走 OpenAI 兼容的 image_url base64 内联（deepseek-flash / Kimi / *vision* 模型）
//  · 本地预处理：超大图缩放、BMP 等不支持格式转 PNG/JPEG、按扩展名补齐 MIME
//  · 附件入口：文件选择框、拖拽到对话区、Ctrl+V 粘贴（三者共用 addAiAttachmentFiles 校验）
// ═══════════════════════════════════════════════

// ═══════════ AI Chat: Attachments ═══════════
// Selected local items are injected into the next user message as readable
// context, rather than uploaded as files.
let aiContextInserts = []; // [{ type: 'note'|'todo'|'skill', id }]
let aiContextPickerType = null;
let aiContextPickerQuery = '';
let aiContextPickerExpandedIds = new Set();

function getAiContextTodoPath(todo) {
  if (!todo) return '';
  const ancestors = typeof getAncestorPath === 'function'
    ? getAncestorPath(todo.id).map(item => item.text).filter(Boolean)
    : [];
  return [...ancestors, todo.text || '未命名待办'].join(' > ');
}

function getAiContextNotePath(note) {
  if (!note) return '';
  const ancestors = [];
  const seen = new Set([note.id]);
  let parentId = note.parentId;
  while (parentId !== null && parentId !== undefined && !seen.has(parentId)) {
    const folder = (typeof notes !== 'undefined' ? notes : []).find(item => item.id === parentId && item.type === 'folder');
    if (!folder) break;
    seen.add(folder.id);
    if (folder.title) ancestors.unshift(folder.title);
    parentId = folder.parentId;
  }
  return [...ancestors, note.title || '未命名笔记'].join(' > ');
}

function getAiContextInsertSnapshot() {
  if (!Array.isArray(aiContextInserts)) return [];
  return aiContextInserts.map(item => {
    if (item.type === 'note') {
      const note = (typeof notes !== 'undefined' ? notes : []).find(n => n.id === item.id && n.type === 'note');
      return note ? { type: 'note', id: note.id, label: getAiContextNotePath(note), content: note.content || '' } : null;
    }
    if (item.type === 'skill') {
      const skill = typeof getAiSkill === 'function' ? getAiSkill(item.id) : null;
      return skill ? { type: 'skill', id: skill.id, label: skill.name, content: skill.content } : null;
    }
    const todo = typeof findTodo === 'function' ? findTodo(item.id) : null;
    return todo ? { type: 'todo', id: todo.id, label: getAiContextTodoPath(todo) } : null;
  }).filter(Boolean);
}

function buildAiContextInsertText(snapshot) {
  const items = Array.isArray(snapshot) ? snapshot : getAiContextInsertSnapshot();
  if (items.length === 0) return '';
  const blocks = items.map(item => item.type === 'note'
    ? `【插入笔记】${item.label}\n正文：\n${item.content || '（空笔记）'}`
    : item.type === 'skill'
      ? `【启用技能：${item.label}】\n${item.content}`
      : `【插入待办】${item.label}`);
  return blocks.length ? `\n\n---\n${blocks.join('\n\n')}\n---` : '';
}

function clearAiContextInserts() {
  aiContextInserts = [];
  renderAiContextPreview();
}

function removeAiContextInsert(index) {
  aiContextInserts.splice(index, 1);
  renderAiContextPreview();
}

function renderAiContextPreview() {
  const wrap = document.getElementById('aiContextPreview');
  if (!wrap) return;
  const valid = aiContextInserts.map((item, index) => ({ item, index })).filter(({ item }) => {
    if (item.type === 'skill') return typeof getAiSkill === 'function' && !!getAiSkill(item.id);
    return item.type === 'note'
      ? (typeof notes !== 'undefined' && notes.some(n => n.id === item.id && n.type === 'note'))
      : (typeof findTodo === 'function' && !!findTodo(item.id));
  });
  if (valid.length !== aiContextInserts.length) aiContextInserts = valid.map(x => x.item);
  if (valid.length === 0) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
  wrap.style.display = 'flex';
  wrap.innerHTML = valid.map(({ item }, index) => {
    const isNote = item.type === 'note';
    const isSkill = item.type === 'skill';
    const source = isNote ? notes.find(n => n.id === item.id) : isSkill ? getAiSkill(item.id) : findTodo(item.id);
    const label = isNote ? getAiContextNotePath(source) : isSkill ? source.name : getAiContextTodoPath(source);
    return `<span class="ai-attach-preview" title="${escapeAttr(label)}">${isNote ? '📝 笔记正文：' : isSkill ? '✨ 技能：' : '📋 待办路径：'}<span class="preview-name">${escapeHtml(label)}</span><button class="preview-remove" onclick="removeAiContextInsert(${index})">✕</button></span>`;
  }).join('');
}

function openAiContextPicker(type) {
  aiContextPickerType = type;
  aiContextPickerQuery = '';
  aiContextPickerExpandedIds = new Set();
  let overlay = document.getElementById('aiContextPickerOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'aiContextPickerOverlay';
    overlay.className = 'timer-picker-overlay';
    overlay.onclick = event => { if (event.target === overlay) closeAiContextPicker(); };
    document.body.appendChild(overlay);
  }
  overlay.style.display = '';
  renderAiContextPicker();
}

function closeAiContextPicker() {
  const overlay = document.getElementById('aiContextPickerOverlay');
  if (overlay) overlay.style.display = 'none';
  aiContextPickerExpandedIds = new Set();
}

function updateAiContextPickerQuery(value) {
  aiContextPickerQuery = value || '';
  renderAiContextPicker();
}

function toggleAiContextPickerExpand(id, event) {
  if (event) event.stopPropagation();
  if (aiContextPickerExpandedIds.has(id)) aiContextPickerExpandedIds.delete(id);
  else aiContextPickerExpandedIds.add(id);
  renderAiContextPicker();
}

function getAiContextPickerChildren(item, isNote) {
  const source = isNote
    ? (typeof notes !== 'undefined' ? notes : [])
    : (typeof todos !== 'undefined' ? todos : []);
  return source.filter(child => child.parentId === item.id);
}

function renderAiContextPickerNode(item, depth, isNote, visited) {
  if (!item || depth > 50) return '';
  const branch = visited || new Set();
  if (branch.has(item.id)) return '';
  const nextBranch = new Set(branch);
  nextBranch.add(item.id);

  const children = getAiContextPickerChildren(item, isNote);
  const isFolder = isNote && item.type === 'folder';
  const hasKids = children.length > 0;
  const isExpanded = aiContextPickerExpandedIds.has(item.id);
  const isSelected = !isFolder && aiContextInserts.some(insert => insert.type === aiContextPickerType && insert.id === item.id);
  const title = isNote ? (item.title || '未命名笔记') : (item.text || '未命名待办');
  const indent = depth * 16;
  const childHtml = children.map(child => renderAiContextPickerNode(child, depth + 1, isNote, nextBranch)).join('');
  const action = isFolder
    ? `toggleAiContextPickerExpand(${item.id}, event)`
    : `insertAiContext('${aiContextPickerType}', ${item.id})`;

  return `<div>
    <div class="todo-picker-item${isSelected ? ' selected' : ''}${isFolder ? ' ai-context-folder' : ''}" onclick="${action}" style="padding-left:${14 + indent}px;">
      ${hasKids ? `<button class="picker-expand${isExpanded ? ' expanded' : ''}" onclick="toggleAiContextPickerExpand(${item.id}, event)" title="展开/折叠">▶</button>` : '<span class="picker-expand-spacer"></span>'}
      ${isFolder
        ? '<span class="ai-context-folder-icon"><i data-lucide="folder" class="lucide-icon"></i></span>'
        : '<div class="picker-check"></div>'}
      <span class="picker-text${!isNote && item.done ? ' done' : ''}">${escapeHtml(title)}</span>
      ${hasKids ? `<span class="picker-badge">${children.length}</span>` : ''}
      ${!isNote && item.dueDate ? `<span class="picker-due">📅 ${escapeHtml(item.dueDate)}</span>` : ''}
    </div>
    ${(hasKids && childHtml) ? `<div class="picker-children${isExpanded ? '' : ' collapsed'}">${childHtml}</div>` : ''}
  </div>`;
}

function renderAiContextPicker() {
  const overlay = document.getElementById('aiContextPickerOverlay');
  if (!overlay || !aiContextPickerType) return;
  const previousScrollTop = overlay.querySelector('.todo-picker-list')?.scrollTop || 0;
  const isNote = aiContextPickerType === 'note';
  const query = aiContextPickerQuery.trim().toLowerCase();
  const source = isNote
    ? (typeof notes !== 'undefined' ? notes : [])
    : (typeof todos !== 'undefined' ? todos : []);
  const selectableItems = isNote ? source.filter(item => item.type === 'note') : source;
  let listHtml = '';

  if (query) {
    const matches = selectableItems
      .map(item => ({ item, label: isNote ? getAiContextNotePath(item) : getAiContextTodoPath(item) }))
      .filter(row => row.label.toLowerCase().includes(query));
    listHtml = matches.map(({ item, label }) => {
      const selected = aiContextInserts.some(insert => insert.type === aiContextPickerType && insert.id === item.id);
      return `<div class="todo-picker-item${selected ? ' selected' : ''}" onclick="insertAiContext('${aiContextPickerType}', ${item.id})">
        <span class="picker-expand-spacer"></span>
        <div class="picker-check"></div>
        <span class="picker-text">${escapeHtml(label)}</span>
        ${!isNote && item.dueDate ? `<span class="picker-due">📅 ${escapeHtml(item.dueDate)}</span>` : ''}
      </div>`;
    }).join('');
    if (!listHtml) listHtml = `<div class="todo-picker-empty">没有匹配的${isNote ? '笔记' : '待办事项'}</div>`;
  } else {
    const roots = source.filter(item => item.parentId === null || item.parentId === undefined);
    listHtml = roots.map(item => renderAiContextPickerNode(item, 0, isNote)).join('');
    if (!listHtml) listHtml = `<div class="todo-picker-empty">暂无${isNote ? '笔记' : '待办事项'}</div>`;
  }

  overlay.innerHTML = `<div class="timer-picker ai-context-picker" role="dialog" aria-modal="true" aria-label="选择${isNote ? '笔记' : '待办事项'}">
    <div class="todo-picker-header">
      <span><i data-lucide="${isNote ? 'notebook-pen' : 'clipboard-list'}" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle;"></i> 选择${isNote ? '笔记' : '待办事项'}</span>
      <button class="todo-picker-close" onclick="closeAiContextPicker()" title="关闭"><i data-lucide="x" class="lucide-icon" style="width:14px;height:14px;"></i></button>
    </div>
    <div class="todo-picker-search">
      <input autofocus placeholder="搜索${isNote ? '笔记' : '待办'}..." value="${escapeAttr(aiContextPickerQuery)}" oninput="updateAiContextPickerQuery(this.value)" onkeydown="if(event.key==='Escape')closeAiContextPicker()">
    </div>
    <div class="todo-picker-list">${listHtml}</div>
  </div>`;
  const list = overlay.querySelector('.todo-picker-list');
  if (list) list.scrollTop = previousScrollTop;
  if (typeof lucide !== 'undefined') {
    try { lucide.createIcons(); } catch (_) {}
  }
  const input = overlay.querySelector('input');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

function insertAiContext(type, id) {
  if (!aiContextInserts.some(item => item.type === type && item.id === id)) aiContextInserts.push({ type, id });
  closeAiContextPicker();
  renderAiContextPreview();
}

function handleAiFileSelect(event) {
  addAiAttachmentFiles(event.target.files);
  event.target.value = '';
}

// 非视觉模型（DeepSeek 等）允许的文本扩展名（发送时按纯文本 readAsText 读取）
const TEXT_FILE_EXTS = [
  '.txt', '.md', '.markdown', '.json', '.js', '.mjs', '.ts', '.jsx', '.tsx',
  '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.rb',
  '.php', '.swift', '.kt', '.sql', '.html', '.htm', '.css', '.scss', '.less',
  '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.log', '.csv',
  '.tsv', '.diff', '.patch', '.sh', '.bat', '.ps1'
];

function isTextFile(file) {
  const ext = (file.name.match(/\.([^.]+)$/) || [])[1];
  if (!ext) return false;
  return TEXT_FILE_EXTS.includes('.' + ext.toLowerCase());
}

function isPdfFile(file) {
  if (!file) return false;
  const name = String(file.name || '').toLowerCase();
  return String(file.type || '').toLowerCase() === 'application/pdf' || name.endsWith('.pdf');
}

// PDF 可按页选择并在本地处理，不套用普通附件的 20MB 限制；
// 其他 Kimi 文档上限 100MB，图片按“最宽松的一条路径”放行。
// 真正发送时若图片走内联且超限，会被 pruneOversizedImageAttachments 拦截并提示。
const ATTACH_MAX_BYTES = { kimi: 100 * 1024 * 1024, visionImage: 64 * 1024 * 1024, file: 20 * 1024 * 1024 };
// DeepSeek Files API 单文件上限 64 MiB，且引用 file_id 的图片不受 32 MiB 内联限制
const DS_FILES_MAX_BYTES = 64 * 1024 * 1024;
// 内联(base64)路径的单图上限：官方 32 MiB 限制，这里留出 base64 膨胀余量
const INLINE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
// 低于该体积的图片直接内联（省掉一次上传往返）；超过则走 Files API，避免每轮把 base64 重发一遍
const DS_FILES_INLINE_LIMIT = 1024 * 1024;
const AI_IMAGE_UPLOAD_KEY = 'study_ai_image_upload'; // auto | always | never

// 返回 { max, label }，供大小校验与提示文案共用
function getAttachSizeLimit(file, apiCfg = getEffectiveApiConfig()) {
  if (isPdfFile(file)) return { max: Infinity, label: '无限制', unlimited: true };
  const isImage = !!file && (typeof isImageFile === 'function' ? isImageFile(file) : false);
  const max = isKimiModel(apiCfg)
    ? ATTACH_MAX_BYTES.kimi
    : (isImage ? ATTACH_MAX_BYTES.visionImage : ATTACH_MAX_BYTES.file);
  return { max: max, label: formatFileSize(max), unlimited: false };
}

// 将文件列表加入附件（供文件选择框、拖拽与粘贴共用）
// 返回本次真正加入的附件名数组：被拒绝/超限的文件已在这里提示过，调用方只需据返回值给成功反馈。
function addAiAttachmentFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return [];
  const added = [];
  const apiCfg = getEffectiveApiConfig();
  for (const file of files) {
    const limit = getAttachSizeLimit(file, apiCfg);
    if (!limit.unlimited && file.size > limit.max) {
      alert(`文件 "${file.name}" 超过 ${limit.label} 限制，已跳过`);
      continue;
    }
    // 所有模型都可通过本地文本提取读取 PDF；多模态模型（Kimi / deepseek-flash 等）
    // 额外放行「图片」——注意只认图片，
    // 否则 .exe/.zip 这类二进制也会被放行并按文本读取，产生乱码垃圾。
    const isImage = isImageFile(file);
    const isPdf = isPdfFile(file);
    if (!isTextFile(file) && !isPdf && !(isMultimodalModel(apiCfg) && isImage)) {
      alert(`当前模型（${apiCfg.model || '未知'}）不支持 "${file.name}"，`
        + (isMultimodalModel(apiCfg)
          ? '支持 PDF、图片（PNG / JPEG / GIF / WebP / BMP）与文本类文件（.txt / .md / .json / 代码文件等）'
          : '支持 PDF 与文本类文件（.txt / .md / .json / 代码文件等），图片需切换到支持看图的模型'));
      continue;
    }
    const attach = { name: file.name, file: file, size: file.size };
    if (isPdf) {
      attach.pdfStartPage = null;
      attach.pdfEndPage = null;
    }
    // Kimi 保留原生 file-extract；其余模型统一走本地 PDF 兼容层，由用户选择文字或页面图片。
    if (isPdf && !isKimiModel(apiCfg)) attach.pdfMode = 'text';
    // For Kimi image files, default to inline (base64), user can switch to OCR
    if (isKimiModel(apiCfg) && isImage) {
      attach.ocrMode = false; // false = base64 inline, true = OCR via file-extract
    }
    aiAttachments.push(attach);
    added.push(attach.name);
    // 所有视觉模型都先在本地规范化。Kimi 的内联分支过去会绕过这里，导致真实格式正确、
    // 但单边极长的 PNG 被服务端笼统报成 "unsupported image"。
    if (isImage) preprocessAiImageAttachment(attach);
  }
  renderAttachPreview();
  return added;
}

// 内联图片体积：base64 约等于原始字节 ×1.37（预处理结果存在时按其实际长度精确计算）
function getInlineImageBytes(attach) {
  if (!attach) return 0;
  if (Array.isArray(attach.dataUrls) && attach.dataUrls.length > 0) {
    return attach.dataUrls.reduce((total, url) => total + (typeof url === 'string' ? Math.ceil(url.length * 0.73) : 0), 0);
  }
  if (typeof attach.dataUrl === 'string' && attach.dataUrl.length > 0) return Math.ceil(attach.dataUrl.length * 0.73);
  const size = Number(attach.size) || (attach.file && attach.file.size) || 0;
  return Math.ceil(size * 1.37);
}

// ═══════════ DeepSeek Files API：图片上传一次，之后用 file_id 引用 ═══════════
// 官方文档 https://api-docs.deepseek.com/zh-cn/guides/files_api
//   · POST {baseUrl}/files，multipart/form-data：file + purpose=user_data（必填）
//   · 不传 expires_after → 文件永久有效（因此可以长期复用 file_id）
//   · 单文件 ≤ 64 MiB；对话里以 {"type":"file","file_id":"file-api-…"} 内容块引用
//   · 文件归属于上传时使用的 API Key（单账号上限 25 GiB / 10000 个文件）
// 仅对 DeepSeek 官方端点启用（第三方 OpenAI 兼容网关不保证有该接口）。

// 取 baseUrl 的主机名（解析失败时退回正则粗提，避免把带路径/端口的地址判错）
function getApiHostname(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch (e) {
    const m = raw.match(/^[a-z]+:\/\/([^/?#]+)/i);
    return m ? m[1].toLowerCase().replace(/:\d+$/, '') : '';
  }
}

// 是否 DeepSeek 官方端点（决定能否使用 Files API）。
// 自测/联调时可把额外主机名放进 window.__MST_FILE_API_TEST_HOSTS__ 放行，生产环境为空。
function isDeepSeekEndpoint(apiCfg = getEffectiveApiConfig()) {
  const host = getApiHostname(apiCfg && apiCfg.baseUrl);
  if (!host) return false;
  if (host === 'deepseek.com' || host.endsWith('.deepseek.com')) return true;
  const extra = (typeof window !== 'undefined' && Array.isArray(window.__MST_FILE_API_TEST_HOSTS__))
    ? window.__MST_FILE_API_TEST_HOSTS__ : [];
  return extra.map(h => String(h).toLowerCase()).includes(host);
}

// 是否具备 Files API 复用条件（DeepSeek 官方端点 + 支持看图的模型）
function supportsDeepSeekFilesApi(apiCfg = getEffectiveApiConfig()) {
  return isDeepSeekEndpoint(apiCfg) && modelSupportsVision(apiCfg);
}

// auto：超过 1 MiB 才上传；always：一律上传；never：一律内联
function getAiImageUploadMode() {
  try {
    const mode = localStorage.getItem(AI_IMAGE_UPLOAD_KEY);
    return (mode === 'always' || mode === 'never') ? mode : 'auto';
  } catch (e) { return 'auto'; }
}

function setAiImageUploadMode(mode) {
  const next = (mode === 'always' || mode === 'never') ? mode : 'auto';
  try { localStorage.setItem(AI_IMAGE_UPLOAD_KEY, next); } catch (e) {}
  return next;
}

// 该图片是否走 Files API（上传一次 → 后续轮次只发 file_id）
function shouldUploadImageToFiles(attach, apiCfg = getEffectiveApiConfig()) {
  if (!attach || !attach.file || !isImageFile(attach.file)) return false;
  if (!supportsDeepSeekFilesApi(apiCfg)) return false;
  if (attach.uploadFileId && attach.uploadKeyId === apiCfg.keyId) return false; // 本会话已上传
  const size = Number(attach.size) || attach.file.size || 0;
  if (size > DS_FILES_MAX_BYTES) return false; // 超过 64 MiB 上传也会失败 → 交给内联路径提示
  const mode = getAiImageUploadMode();
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  return size > DS_FILES_INLINE_LIMIT;
}

// 上传图片到 DeepSeek Files API，返回 file_id（形如 file-api-…）
async function uploadImageToDeepSeek(file, apiCfg = getEffectiveApiConfig()) {
  const baseUrl = String(apiCfg.baseUrl || '').replace(/\/+$/, '');
  const formData = new FormData();
  formData.append('file', file, String(file.name || 'image').slice(0, 512)); // 文件名上限 512 字符
  formData.append('purpose', 'user_data'); // 必填，且仅支持 user_data
  // 刻意不传 expires_after：文件永久有效，才能长期复用 file_id

  const resp = await fetch(baseUrl + '/files', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiCfg.apiKey },
    body: formData
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error((data && data.error && data.error.message) || `图片上传失败 (HTTP ${resp.status})`);
  }
  if (!data || !data.id) throw new Error('图片上传失败：响应缺少 file_id');
  return data.id;
}

// 删除已上传的文件（供设置里的清理功能使用）
async function deleteDeepSeekFile(fileId, apiCfg = getEffectiveApiConfig()) {
  const baseUrl = String(apiCfg.baseUrl || '').replace(/\/+$/, '');
  const resp = await fetch(baseUrl + '/files/' + encodeURIComponent(fileId), {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + apiCfg.apiKey }
  });
  return resp.ok;
}

// 列出已上传的文件（GET /files，按 purpose=user_data 过滤）
async function listDeepSeekFiles(apiCfg = getEffectiveApiConfig()) {
  const baseUrl = String(apiCfg.baseUrl || '').replace(/\/+$/, '');
  const resp = await fetch(baseUrl + '/files?purpose=user_data&limit=1000', {
    headers: { 'Authorization': 'Bearer ' + apiCfg.apiKey }
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error((data && data.error && data.error.message) || `读取文件列表失败 (HTTP ${resp.status})`);
  }
  return Array.isArray(data.data) ? data.data : [];
}

// 收集所有对话里仍被引用的 file_id（清理时据此避免删掉正在用的图）
function collectReferencedFileIds() {
  const used = new Set();
  const convs = (typeof aiConvs !== 'undefined' && Array.isArray(aiConvs)) ? aiConvs : [];
  for (const conv of convs) {
    const messages = (conv && Array.isArray(conv.messages)) ? conv.messages : [];
    for (const m of messages) {
      if (!m || !Array.isArray(m.visionFiles)) continue;
      for (const vf of m.visionFiles) {
        if (vf && vf.fileId) used.add(vf.fileId);
      }
    }
  }
  return used;
}

// 生成用于界面预览的小缩略图（长边 ≤ 320px），避免把整张大图 base64 存进对话历史
async function makeImageThumb(attach) {
  const out = await downscaleImageForApi(attach.file, { maxEdge: 320, maxPixels: 320 * 320, quality: 0.7 });
  return out.dataUrl;
}

// 在历史消息里找内容完全相同的图片 file_id。文件名不能作为身份：手机/截图导出的
// "1.png"、"image.png" 极易重名，曾因此把别的图片的 file_id 错发给模型。
// 旧记录没有 SHA-256 指纹时宁可重新上传，也绝不按文件名猜测复用。
function findReusableUploadedImage(attach, apiCfg = getEffectiveApiConfig()) {
  const fingerprint = String(attach && attach.imageFingerprint || '');
  if (!fingerprint) return null;
  const keyId = apiCfg.keyId || '';
  const convs = (typeof aiConvs !== 'undefined' && Array.isArray(aiConvs)) ? aiConvs : [];
  for (const conv of convs) {
    const messages = (conv && Array.isArray(conv.messages)) ? conv.messages : [];
    for (const m of messages) {
      if (!m || !Array.isArray(m.visionFiles)) continue;
      for (const vf of m.visionFiles) {
        if (vf && vf.type === 'file' && vf.fileId && vf.imageFingerprint === fingerprint && (vf.uploadKeyId || '') === keyId) {
          return { fileId: vf.fileId, uploadKeyId: vf.uploadKeyId || '', thumb: vf.dataUrl || '', imageFingerprint: fingerprint };
        }
      }
    }
  }
  return null;
}

async function fingerprintImageFile(file) {
  const subtle = typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle;
  if (!file || !subtle) return '';
  const buffer = typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : await readFileAsArrayBuffer(file);
  const digest = new Uint8Array(await subtle.digest('SHA-256', buffer));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

// 剔除只能内联、且内联后超出单图限制的图片附件：同时清掉编辑器里的待发附件与本次快照，
// 返回被剔除的文件名（供调用方在消息中说明）。返回后调用方需按名单过滤自己的快照副本。
// 已走 Files API（file_id 引用）的图片不在内联限制内，不参与剔除。
function pruneOversizedImageAttachments(attachments, apiCfg = getEffectiveApiConfig()) {
  const snapshot = Array.isArray(attachments) ? attachments : [];
  if (snapshot.length === 0 && aiAttachments.length === 0) return [];
  const isKimi = isKimiModel(apiCfg);
  const max = isKimi ? ATTACH_MAX_BYTES.kimi : INLINE_IMAGE_MAX_BYTES;
  const dropped = [];
  const tooLarge = a => {
    if (!a || !a.file || !isImageFile(a.file)) return false;
    if (!isKimi && (a.uploadFileId || a.imageStrategy === 'file')) return false; // 走 file_id，不限内联体积
    return getInlineImageBytes(a) > max;
  };
  // 1) 编辑器里的待发附件（用户可见的预览）
  for (let i = aiAttachments.length - 1; i >= 0; i--) {
    if (tooLarge(aiAttachments[i])) dropped.unshift(aiAttachments[i].name);
  }
  if (dropped.length > 0) {
    aiAttachments = aiAttachments.filter(a => !tooLarge(a));
    renderAttachPreview();
  }
  // 2) 本次发送使用的快照副本（队列发送时两者可能不同）
  for (let i = snapshot.length - 1; i >= 0; i--) {
    if (tooLarge(snapshot[i]) && dropped.indexOf(snapshot[i].name) < 0) dropped.unshift(snapshot[i].name);
  }
  return dropped;
}

// 图片附件预处理（异步）：结果写入 attach.dataUrl / attach.imageInfo / attach.uploadFileId。
// 同时把这次处理的 Promise 存到 attach._processPromise，发送时 await 它即可，
// 既不必重复解码一次，也不会出现「刚点发送时预处理还没完成」的竞态。
// 两条路径：
//   · Files API（普通大图/照片）：规范化后上传换 file_id → 之后每轮只发 file_id，另存小缩略图供界面预览
//   · 内联 base64（小图 / 长图切片 / 非官方端点 / 用户关闭上传）：缩放或切片后内联
function preprocessAiImageAttachment(attach) {
  if (attach._processPromise) return attach._processPromise;
  attach.imageProcessing = true;
  attach._processPromise = (async () => {
    const apiCfg = getEffectiveApiConfig();
    attach.imageFingerprint = await fingerprintImageFile(attach.file).catch(() => '');
    // 教材扫描、网页截图等极长图片不能整张缩到 2048px 高，否则文字会小到不可读。
    // 将它们切成多个合规图片块；普通图片仍沿用单图缩放路径。
    const split = await splitTallImageForApi(attach.file);
    if (split) {
      attach.dataUrls = split.dataUrls;
      attach.dataUrl = split.dataUrls[0] || '';
      attach.imageInfo = split.info;
      attach.imageStrategy = 'inline';
      return attach;
    }
    const processed = await downscaleImageForApi(attach.file);
    attach.file = processed.file;
    attach.dataUrl = processed.dataUrl;
    attach.dataUrls = [processed.dataUrl];
    attach.imageInfo = processed.info;
    if (shouldUploadImageToFiles(attach, apiCfg)) {
      try {
        attach.uploadFileId = await uploadImageToDeepSeek(attach.file, apiCfg);
        attach.uploadKeyId = apiCfg.keyId || '';
        attach.imageStrategy = 'file';
        attach.dataUrl = await makeImageThumb(attach); // 仅用于预览/历史回显
        return attach;
      } catch (err) {
        // 上传失败（网关无此接口、超配额、网络问题…）→ 自动退回内联，不阻断发送
        attach.uploadError = (err && err.message) || String(err);
        attach.imageStrategy = 'inline';
        if (isDebugMode()) console.warn('[AI attach] Files API 上传失败，改用内联：', attach.uploadError);
      }
    }
    return attach;
  })().catch(err => {
    attach._preprocessError = (err && err.message) || String(err);
    if (isDebugMode()) console.warn('[AI attach] 图片预处理失败，发送时将按原文件读取：', attach._preprocessError);
    return attach;
  }).finally(() => {
    attach.imageProcessing = false;
    renderAttachPreview();
  });
  return attach._processPromise;
}

// ═══════════ AI Chat: 拖拽文件到对话区域添加附件 ═══════════
function initAiDropZone() {
  const layout = document.getElementById('aiChatLayout');
  if (!layout || layout._dropAttached) return;
  layout._dropAttached = true;

  layout.addEventListener('dragover', function(e) {
    // 仅处理外部文件拖拽（内部待办/笔记拖拽不含 Files 类型）
    const types = e.dataTransfer ? Array.from(e.dataTransfer.types || []) : [];
    if (!types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    layout.classList.add('ai-drop-active');
  });

  layout.addEventListener('dragleave', function(e) {
    // 实际离开布局时才移除高亮（防止在子元素间移动时闪烁）
    if (!layout.contains(e.relatedTarget)) {
      layout.classList.remove('ai-drop-active');
    }
  });

  layout.addEventListener('drop', function(e) {
    if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    layout.classList.remove('ai-drop-active');
    addAiAttachmentFiles(e.dataTransfer.files);
  });
}

// 脚本加载即初始化（脚本位于 body 末尾，DOM 已就绪）
initAiDropZone();
initAiPasteZone();

// 待发附件列表（浅拷贝）。与只读投影 getAiAttachmentsSnapshot() 的区别：
// 这里保留 file 引用，发送路径要靠它把本次快照与预览下标配对，才能就地刷新渲染进度。
function getAiAttachments() {
  return aiAttachments.slice();
}

// 只读快照（供测试/诊断查看待发附件；aiAttachments 是 settings.js 的 let 绑定，不在 window 上）
function getAiAttachmentsSnapshot() {
  return aiAttachments.map(a => ({
    name: a.name,
    size: a.size,
    type: (a.file && a.file.type) || '',
    ocrMode: a.ocrMode,
    pdfMode: a.pdfMode,
    pdfStartPage: a.pdfStartPage || null,
    pdfEndPage: a.pdfEndPage || null,
    pdfInfo: a.pdfInfo || null,
    imageProcessing: a.imageProcessing === true,
    imageInfo: a.imageInfo || null,
    imagePartCount: Array.isArray(a.dataUrls) ? a.dataUrls.length : 0,
    imageFingerprint: a.imageFingerprint || null,
    preprocessError: a._preprocessError || null,
    imageStrategy: a.imageStrategy || null,
    uploadFileId: a.uploadFileId || null,
    uploadError: a.uploadError || null,
    hasDataUrl: typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:')
  }));
}

function removeAttachment(idx) {
  aiAttachments.splice(idx, 1);
  renderAttachPreview();
}

function toggleAttachOcrMode(idx) {
  const a = aiAttachments[idx];
  if (!a || a.ocrMode === undefined) return;
  a.ocrMode = !a.ocrMode;
  renderAttachPreview();
}

function toggleAttachPdfMode(idx) {
  const a = aiAttachments[idx];
  if (!a || a.pdfMode === undefined) return;
  const next = a.pdfMode === 'text' ? 'image' : 'text';
  if (next === 'image' && !isMultimodalModel()) {
    alert('当前模型不支持图片输入；PDF 仍可使用“提取文字”模式。若是扫描版 PDF，请切换到支持看图的模型。');
    return;
  }
  a.pdfMode = next;
  renderAttachPreview();
}

function updateAttachPdfRange(idx, field, rawValue) {
  const a = aiAttachments[idx];
  if (!a || !isPdfFile(a.file) || (field !== 'start' && field !== 'end')) return;
  const parsed = parseInt(rawValue, 10);
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  if (field === 'start') a.pdfStartPage = value;
  else a.pdfEndPage = value;
  a.pdfInfo = null;
  const start = a.pdfStartPage;
  const end = a.pdfEndPage;
  if (start && end && start > end) {
    if (field === 'start') a.pdfEndPage = start;
    else a.pdfStartPage = end;
  }
  renderAttachPreview();
}

function renderAttachPreview() {
  const wrap = document.getElementById('aiAttachPreview');
  const btn = document.getElementById('aiAttachBtn');
  if (!wrap || !btn) return;
  if (aiAttachments.length === 0) {
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    btn.classList.remove('has-file');
    return;
  }
  btn.classList.add('has-file');
  wrap.style.display = 'flex';
  const multimodal = isMultimodalModel();
  wrap.innerHTML = aiAttachments.map((a, i) => {
    const isPdf = isPdfFile(a.file);
    const isImage = (isKimiModel() && a.ocrMode !== undefined) || (multimodal && isImageFile(a.file));
    // 已预处理的图片直接显示缩略图（BMP 等不支持格式转换后也能看到效果）
    const thumb = isImage && a.dataUrl
      ? `<img class="preview-thumb" src="${a.dataUrl}" alt="">`
      : `<span class="preview-icon">${isImage ? '🖼️' : (isPdf ? '📕' : '📝')}</span>`;
    let modeToggle = '';
    let pdfRange = '';
    let pdfRender = '';
    if (isPdf) {
      const total = a.pdfInfo && Number(a.pdfInfo.pageCount) > 0 ? Number(a.pdfInfo.pageCount) : '';
      // 留空 = 从第 1 页开始。文字模式会在 PDF_TEXT_MAX_CHARS 处截断，
      // 图片模式最多渲染 PDF_IMAGE_MAX_PAGES 页——把上限写进提示，
      // 用户才能明白"留空"为什么会渲染这么多页、填页码又为什么更快。
      const rangeTitle = isKimiModel()
        ? '设置后仅发送所选页；留空则使用 Kimi 原生整文件解析'
        : (a.pdfMode === 'image'
          ? `留空表示从第一页开始（最多渲染 ${PDF_IMAGE_MAX_PAGES} 页，超出部分不发送；只发几页时请填页码，会快很多）`
          : `留空表示从第一页开始（提取到约 ${PDF_TEXT_MAX_CHARS} 字为止）`);
      pdfRange = `<span class="preview-pdf-range" title="${rangeTitle}">
        <span>页</span>
        <input type="number" min="1" ${total ? `max="${total}"` : ''} value="${a.pdfStartPage || ''}" placeholder="1"
          aria-label="PDF 起始页" onchange="updateAttachPdfRange(${i}, 'start', this.value)">
        <span>–</span>
        <input type="number" min="1" ${total ? `max="${total}"` : ''} value="${a.pdfEndPage || ''}" placeholder="末页"
          aria-label="PDF 结束页" onchange="updateAttachPdfRange(${i}, 'end', this.value)">
      </span>`;
      pdfRender = formatPdfAttachStatus(a, i);
    }
    if (isPdf && a.pdfMode !== undefined) {
      const imageMode = a.pdfMode === 'image';
      const modeLabel = imageMode ? '🖼️ 页面图片' : '📄 提取文字';
      const title = imageMode
        ? '切换到提取 PDF 文本层（所有模型可用）'
        : (multimodal ? `切换到逐页渲染图片（每次最多 ${PDF_IMAGE_MAX_PAGES} 页）` : '当前模型不支持图片；切换视觉模型后可用页面图片');
      modeToggle = `<button class="preview-mode-btn" onclick="toggleAttachPdfMode(${i})" title="${title}">${modeLabel}</button>`;
    } else if (isImage && a.ocrMode !== undefined) {
      const modeLabel = a.ocrMode ? '📄 OCR' : '🖼️ 内联';
      modeToggle = `<button class="preview-mode-btn" onclick="toggleAttachOcrMode(${i})" title="${a.ocrMode ? '切换到内联(base64)上传' : '切换到 OCR 提取文字'}">${modeLabel}</button>`;
    } else if (isImage && a.uploadFileId) {
      // Files API：已上传一次，后续每轮只发 file_id（不再重复传图）
      const tip = `已上传到 DeepSeek 文件服务：${a.uploadFileId}\n后续轮次只发送 file_id，不会重复上传图片`;
      modeToggle = `<span class="preview-mode-tag preview-mode-file" title="${escapeHtml(tip)}">📎 已上传</span>`;
    } else if (isImage) {
      let tip;
      if (a.uploadError) {
        tip = `Files API 上传失败，已回退为内联(base64)：${a.uploadError}`;
      } else if (a.imageInfo) {
        tip = `图片内联(base64)分析：${a.imageInfo.width}×${a.imageInfo.height}${a.imageInfo.parts > 1 ? `（已切为 ${a.imageInfo.parts} 段）` : ''}${a.imageInfo.converted ? '（已转为 ' + a.imageInfo.format.toUpperCase() + '）' : ''}${a.imageInfo.resized ? '（已缩放）' : ''}`;
      } else {
        tip = '图片内联(base64)分析';
      }
      const label = a.imageProcessing ? '⏳ 处理中' : (a.uploadError ? '🖼️ 内联(回退)' : '🖼️ 内联');
      modeToggle = `<span class="preview-mode-tag" title="${escapeHtml(tip)}">${label}</span>`;
    }
    return `<span class="ai-attach-preview${isPdf ? ' pdf-attachment' : ''}">
      ${thumb}
      <span class="preview-name">${escapeHtml(a.name.length > 15 ? a.name.slice(0,15)+'…' : a.name)}</span>
      <span class="preview-size">${formatFileSize(a.size)}</span>
      ${modeToggle}
      ${pdfRender}
      ${pdfRange}
      <button class="preview-remove" onclick="removeAttachment(${i})">✕</button>
    </span>`;
  }).join('');
}

// ═══════════ 通用 PDF 兼容层：文本提取 / 页面图片 ═══════════
const PDF_TEXT_MAX_CHARS = 80000;
// 页面图片模式每次最多渲染多少页（只约束"没填范围时从第 1 页开始渲染几页"）。
// 逐页渲染是主线程重活，实测密集教材约 0.35–0.55 秒/页，24 页 ≈ 8–13 秒；
// 用户显式填了页码范围就按所选页数渲染，不受这个上限"补足"。
const PDF_IMAGE_MAX_PAGES = 24;
const PDF_IMAGE_MAX_WIDTH = 1600;
const PDF_IMAGE_JPEG_QUALITY = 0.86;

async function getPdfJsForAttachment() {
  if (typeof ensurePdfJs === 'function') {
    const lib = await ensurePdfJs();
    if (lib) return lib;
  }
  if (typeof window !== 'undefined' && window.pdfjsLib) return window.pdfjsLib;
  throw new Error('PDF 引擎尚未加载，请稍后重试');
}

async function openPdfAttachment(file) {
  const pdfjsLib = await getPdfJsForAttachment();
  const buffer = await readFileAsArrayBuffer(file);
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  return { pdfjsLib, pdf: await loadingTask.promise };
}

function resolvePdfAttachmentRange(pageCount, opts = {}) {
  const total = Math.max(1, Math.floor(Number(pageCount) || 1));
  let startPage = Math.floor(Number(opts.startPage));
  let endPage = Math.floor(Number(opts.endPage));
  if (!Number.isFinite(startPage) || startPage < 1) startPage = 1;
  if (!Number.isFinite(endPage) || endPage < 1) endPage = total;
  startPage = Math.min(startPage, total);
  endPage = Math.min(endPage, total);
  if (startPage > endPage) [startPage, endPage] = [endPage, startPage];
  return { startPage, endPage, selectedPages: endPage - startPage + 1 };
}

// 附件预览里的 PDF 状态徽标：渲染进度 / 本次实际发出的页数。
// 逐页渲染是主线程上的重活（实测密集教材约 0.35–0.55 秒/页，上限 24 页可达十几秒），
// 没有这个反馈时用户只能看到"点了发送就没反应"。
// 始终返回一个带固定 id 的空容器：渲染开始前它也在 DOM 里，
// updatePdfRenderStatus 才有稳定的挂载点可替换。
function formatPdfAttachStatus(a, index) {
  const idx = Number.isInteger(index) ? index : 0;
  const r = a && a._pdfRender;
  let inner = '';
  if (r && r.total) {
    if (r.rendering) {
      const pct = Math.max(0, Math.min(100, Math.round((r.done / r.total) * 100)));
      inner = `<span class="preview-render-label">🖼️ 渲染中 ${r.done}/${r.total}</span>
      <span class="preview-render-bar"><span class="preview-render-fill" style="width:${pct}%"></span></span>`;
    } else if (r.aborted) {
      inner = `⏹️ 已取消（${r.done}/${r.total} 页）`;
    } else {
      const parts = [`本次发 ${r.done} 页`];
      if (r.bytes) parts.push(formatFileSize(r.bytes));
      if (r.ms) parts.push(`${(r.ms / 1000).toFixed(1)}s`);
      inner = `✅ ${parts.join(' · ')}`;
    }
  }
  const state = !r || !r.total ? 'idle' : (r.rendering ? 'rendering' : (r.aborted ? 'aborted' : 'done'));
  const title = state === 'rendering'
    ? '正在把 PDF 页面渲染成图片，请稍候（可点停止取消）'
    : (state === 'aborted'
      ? '已取消本次页面渲染'
      : (r && r.truncated
        ? `已完成页面渲染；所选 ${r.selectedPages} 页超出单次上限，其余未发送`
        : '渲染成图片后随消息一起发送'));
  return `<span class="preview-render-status ${state}" id="aiPdfRenderStatus${idx}" title="${escapeHtml(title)}">${inner}</span>`;
}

// 渲染过程中就地更新徽标：重建整个预览列表会打断用户的输入焦点。
// 附件上还没有渲染状态时自动建一份，避免调用方漏建导致进度悄无声息。
function updatePdfRenderStatus(index, state) {
  const a = aiAttachments[index];
  if (!a || typeof a !== 'object') return;
  if (!a._pdfRender) a._pdfRender = { rendering: true, done: 0, total: Math.max(0, Number(state && state.total) || 0) };
  if (state.rendering) {
    a._pdfRender.rendering = true;
    a._pdfRender.done = state.done;
    a._pdfRender.total = state.total;
  } else {
    a._pdfRender.rendering = false;
    if (state.aborted) a._pdfRender.aborted = true;
  }
  const el = typeof document !== 'undefined' && document.getElementById ? document.getElementById('aiPdfRenderStatus' + index) : null;
  if (el) el.outerHTML = formatPdfAttachStatus(a, index);
}

async function extractPdfAttachmentText(file, opts = {}) {
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : PDF_TEXT_MAX_CHARS;
  const opened = await openPdfAttachment(file);
  const pdf = opened.pdf;
  const range = resolvePdfAttachmentRange(pdf.numPages, opts);
  const pages = [];
  let charCount = 0;
  let truncated = false;
  try {
    for (let pageNo = range.startPage; pageNo <= range.endPage; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const content = await page.getTextContent();
      const text = (content.items || [])
        .map(item => item && item.str !== undefined ? item.str : '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) continue;
      const marker = `[第 ${pageNo} 页]\n`;
      const remaining = maxChars - charCount - marker.length;
      if (remaining <= 0) { truncated = true; break; }
      const pageText = text.length > remaining ? text.slice(0, remaining) : text;
      pages.push(marker + pageText);
      charCount += marker.length + pageText.length;
      if (pageText.length < text.length) { truncated = true; break; }
    }
    return { text: pages.join('\n\n'), pageCount: pdf.numPages, textPageCount: pages.length, truncated, ...range };
  } finally {
    try { await pdf.destroy(); } catch (e) {}
  }
}

async function renderPdfAttachmentPages(file, opts = {}) {
  const maxPages = Number(opts.maxPages) > 0 ? Math.floor(Number(opts.maxPages)) : PDF_IMAGE_MAX_PAGES;
  const maxWidth = Number(opts.maxWidth) > 0 ? Number(opts.maxWidth) : PDF_IMAGE_MAX_WIDTH;
  const onPage = typeof opts.onPage === 'function' ? opts.onPage : null;
  const isAborted = typeof opts.isAborted === 'function' ? opts.isAborted : null;
  const opened = await openPdfAttachment(file);
  const pdf = opened.pdf;
  const dataUrls = [];
  const range = resolvePdfAttachmentRange(pdf.numPages, opts);
  // 逐页渲染：上限只约束"没填范围时从第 1 页开始能渲染多少页"，
  // 用户显式选定的页码范围始终优先，不被上限补足或改写。
  const renderCount = Math.min(range.selectedPages, maxPages);
  const pageNumbers = [];
  let aborted = false;
  let reusedCanvas = null;
  let totalBytes = 0;
  const startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  try {
    for (let pageNo = range.startPage; pageNo < range.startPage + renderCount; pageNo++) {
      if (isAborted && isAborted()) { aborted = true; break; }
      const page = await pdf.getPage(pageNo);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(2, maxWidth / Math.max(1, baseViewport.width));
      const viewport = page.getViewport({ scale });
      // 复用同一块画布：每页新建 canvas 会让上一块的后端显存迟迟不释放，
      // 长文档逐页渲染时会把主线程和显存一起拖住。
      if (!reusedCanvas) reusedCanvas = document.createElement('canvas');
      const canvas = reusedCanvas;
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('无法创建 PDF 页面画布');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await canvasToBlob(canvas, 'image/jpeg', PDF_IMAGE_JPEG_QUALITY);
      totalBytes += Number(blob && blob.size) || 0;
      dataUrls.push(await blobToDataUrl(blob));
      pageNumbers.push(pageNo);
      // 每页之后让出一次事件循环：否则连续渲染会把主线程完全堵死，
      // 进度无法重绘、取消也点不动，用户看到的就是"点了发送整个界面卡住"。
      if (onPage) { try { onPage({ done: pageNumbers.length, total: renderCount, pageNo }); } catch (e) {} }
      // 让出一次事件循环，进度才有机会重绘、停止按钮才点得动。
      // 这里刻意用 setTimeout 而不是 requestAnimationFrame：窗口被遮挡/最小化时
      // rAF 会被节流到约 1fps，等于给每页硬加 1 秒（隐藏窗口实测 3 页从 1.3s 掉到 17s）。
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const endedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    return {
      dataUrls, pageCount: pdf.numPages, renderedPages: pageNumbers.length, pageNumbers,
      truncated: range.selectedPages > renderCount, aborted,
      bytes: totalBytes, ms: Math.round(endedAt - startedAt), ...range
    };
  } finally {
    // 先放掉画布后端再销毁文档，避免几十 MB 的显存在长文档上滞留。
    if (reusedCanvas) { reusedCanvas.width = 1; reusedCanvas.height = 1; }
    if (aborted) {
      // 主动取消时不必等 pdf.js 逐页清理，destroy 可能耗时数百毫秒。
      try { pdf.destroy(); } catch (e) {}
    } else {
      try { await pdf.destroy(); } catch (e) {}
    }
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

// Check if the current model is a Kimi model
function isKimiModel(apiCfg = getEffectiveApiConfig()) {
  return (apiCfg.model || '').toLowerCase().includes('kimi');
}

// 是否视觉模型：支持 OpenAI 兼容的 image_url 多模态（图片可 base64 内联发送）
// 名单（官方文档 https://api-docs.deepseek.com/zh-cn/guides/vision/ 与「模型 & 价格」页）：
//   · deepseek-flash            → DeepSeek-V4.1-Flash，官方「图像理解：支持」，支持 JPEG/PNG/GIF/WebP
//   · deepseek-v4-flash         → 旧模型名，请求同样由 DeepSeek-V4.1-Flash 承接，故同样支持图片
//   · deepseek-v4-flash-vision-exp → 已下线的旧视觉模型名，请求同样由上述 Flash 模型承接，保留兼容
// 注意：deepseek-v4-pro（DeepSeek-V4-Pro）官方标注「图像理解：不支持」，不要加入白名单；
//       其余厂商模型沿用「模型名含 vision」的宽松判定（GPT-4o / Qwen-VL / GLM-4V 等需在模型名中体现）。
function modelSupportsVision(apiCfg = getEffectiveApiConfig()) {
  const model = String((apiCfg && apiCfg.model) || '').toLowerCase();
  if (!model) return false;
  if (model.includes('vision')) return true;
  return /deepseek-(v4-)?flash/.test(model);
}

function isVisionModel(apiCfg = getEffectiveApiConfig()) {
  return modelSupportsVision(apiCfg);
}

// 是否多模态模型（Kimi 或视觉模型）：图片可走 base64 image_url 内联分析
function isMultimodalModel(apiCfg = getEffectiveApiConfig()) {
  return isKimiModel(apiCfg) || isVisionModel(apiCfg);
}

// Update file input accept and placeholder based on current model
function updateAiFileInput() {
  const input = document.getElementById('aiFileInput');
  const placeholder = document.getElementById('aiInput');
  if (!input || !placeholder) return;
  // 拖拽与 Ctrl+V 粘贴共用同一条附件路径，输入框提示里一并说明
  const pasteHint = '（可直接拖拽或粘贴文件）';
  if (isKimiModel()) {
    input.accept = '';
    placeholder.placeholder = '输入你的问题，回车发送... (支持 PDF / Word / Excel / 图片 / 视频等文件)' + pasteHint;
  } else if (isVisionModel()) {
    // 视觉模型：PDF 可选提取文字或逐页转图片，普通图片继续内联分析。
    input.accept = '';
    placeholder.placeholder = '输入你的问题，回车发送... (支持 PDF 文字/页面图片、图片分析、文本附件等)' + pasteHint;
  } else {
    // 非视觉模型也可通过本地文本提取使用 PDF；页面图片模式只在视觉模型下开放。
    input.accept = ['.pdf', 'application/pdf'].concat(TEXT_FILE_EXTS).join(',');
    placeholder.placeholder = '输入你的问题，回车发送... (支持 PDF 提取文字 / .txt / .md / .json / 代码文件等)' + pasteHint;
  }
}

// Upload file to Kimi API and return the extracted content (for documents: PDF/Word/Excel etc.)
async function uploadToKimi(file, apiCfg = getEffectiveApiConfig()) {
  const baseUrl = apiCfg.baseUrl.replace(/\/+$/, '');
  const formData = new FormData();
  formData.append('file', file);
  formData.append('purpose', 'file-extract');

  const resp = await fetch(baseUrl + '/files', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiCfg.apiKey
    },
    body: formData
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `文件上传失败 (HTTP ${resp.status})`);
  }

  const fileObj = await resp.json();
  const fileId = fileObj.id;

  // Get the extracted content
  const contentResp = await fetch(baseUrl + '/files/' + fileId + '/content', {
    headers: {
      'Authorization': 'Bearer ' + apiCfg.apiKey
    }
  });

  if (!contentResp.ok) {
    throw new Error('文件内容提取失败 (HTTP ' + contentResp.status + ')');
  }

  return await contentResp.text();
}

// Upload video to Kimi API, returns fileId for ms:// reference
async function uploadVideoToKimi(file, apiCfg = getEffectiveApiConfig()) {
  const baseUrl = apiCfg.baseUrl.replace(/\/+$/, '');
  const formData = new FormData();
  formData.append('file', file);
  formData.append('purpose', 'video');

  const resp = await fetch(baseUrl + '/files', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiCfg.apiKey
    },
    body: formData
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `视频上传失败 (HTTP ${resp.status})`);
  }

  const fileObj = await resp.json();
  return fileObj.id;
}

// Read an image/video file as base64 data URL for inline vision analysis
// 图片扩展名 → MIME 映射（DeepSeek Flash 支持 png/jpeg/gif/webp，Kimi 额外支持 bmp）
const IMG_EXT_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp'
};
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      let result = e.target.result;
      // 部分来源的文件 file.type 为空 → FileReader 生成 "data:;base64,..."（无 MIME 前缀），
      // 服务端嗅探不到格式会报 "unsupported image"。
      // 这里按扩展名强制修正 data URL 的 MIME 前缀（若原本已有正确 MIME 则不动）。
      if (typeof result === 'string' && result.startsWith('data:')) {
        const comma = result.indexOf(',');
        const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
        const mime = IMG_EXT_MIME[ext];
        if (mime && !result.slice(0, comma).includes(mime)) {
          result = 'data:' + mime + ';base64,' + result.slice(comma + 1);
        }
      }
      resolve(result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 同步检查已保存在对话历史里的内联图片。旧版本可能已经把超长原图存进 visionFiles；
// 每次后续请求都会再次携带它，所以必须在构建请求时拦截，而不能只校验本次新附件。
function inspectInlineImageForApi(dataUrl) {
  const match = String(dataUrl || '').match(/^data:image\/(png|jpe?g|gif|webp);base64,/i);
  if (!match) return { ok: false, reason: 'MIME 或 data URL 不受支持' };
  if (typeof atob !== 'function') return { ok: true };
  try {
    const payload = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const prefixLength = Math.min(payload.length, 512) & ~3;
    const binary = atob(payload.slice(0, prefixLength));
    if (binary.length < 12) return { ok: true }; // 测试桩/极短数据交由服务端最终校验
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const detected = detectImageFormatFromBytes(bytes);
    const declared = match[1].toLowerCase().replace('jpg', 'jpeg');
    if (!detected || detected !== declared) return { ok: false, reason: '声明格式与文件内容不一致' };
    if (detected === 'png' && bytes.length >= 24) {
      const readU32 = offset => (((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
      const width = readU32(16);
      const height = readU32(20);
      if (!width || !height || width > 8192 || height > 8192) {
        return { ok: false, reason: `PNG 尺寸 ${width}×${height} 超出接口限制`, width, height };
      }
      return { ok: true, width, height };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'Base64 图片数据损坏' };
  }
}

// ═══════════ 图片预处理：格式归一 + 超大图缩放 ═══════════
// 依据 DeepSeek 图像理解限制：仅支持 JPEG / PNG / GIF / WebP；单边最长 8192 像素；单图内联 32 MiB。
// 这里把不支持/过大的图片在本地转成 JPEG(照片) 或 PNG(含透明/小图)，既保证可发送也减小请求体。
const DS_IMAGE_FORMATS = ['jpeg', 'png', 'gif', 'webp'];
const IMAGE_MAX_EDGE_PX = 2048;     // 超过则等比缩小（远低于服务端 8192 上限，显著减小 base64 体积）
const IMAGE_REENCODE_EDGE_PX = 1600; // 原本已合规但尺寸偏大时也压缩一次，便于本地存档与传输
const IMAGE_JPEG_QUALITY = 0.85;
const IMAGE_LONG_JPEG_QUALITY = 0.9; // 长图多为文字截图，略高质量以保住细字，同时显著小于分段 PNG
const IMAGE_PNG_KEEP_MAX_PX = 1024 * 1024; // png/webp/gif 且像素不多、无缩放宽高时保留原图（无损）
const IMAGE_LONG_RATIO = 2.5;       // 仅切教材/网页截图等明显长图，普通照片继续等比缩放
const IMAGE_MAX_PARTS = 12;         // 控制单条消息的图片块数量；超长图会先按总高度等比缩小

// 按文件内容（魔数）判断图片真实格式，避免扩展名/MIME 撒谎
function detectImageFormatFromBytes(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpeg';
  const ascii = (start, len) => {
    let s = '';
    for (let i = start; i < start + len && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  };
  if (ascii(0, 3) === 'GIF') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
  return null;
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// 用 createImageBitmap 或 <img> 解码位图（Electron/Chromium 均有 createImageBitmap，<img> 作为兜底）
async function decodeImageBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try { return { bitmap: await createImageBitmap(file), revoke: false }; } catch (e) { /* 回退到 <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('图片解码失败'));
      el.src = url;
    });
    return { bitmap: img, revoke: true };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片编码失败')), type, quality);
      return;
    }
    try {
      const dataUrl = canvas.toDataURL(type, quality);
      const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      resolve(new Blob([bytes], { type: type }));
    } catch (err) { reject(err); }
  });
}

// 将竖向长图按阅读顺序切成多个图片块，每块的宽高都不超过 maxEdge。
// 返回 null 表示不是长图，调用方继续走 downscaleImageForApi 的普通单图路径。
async function splitTallImageForApi(file, opts = {}) {
  const maxEdge = Number(opts.maxEdge) > 0 ? Number(opts.maxEdge) : IMAGE_MAX_EDGE_PX;
  const maxParts = Number(opts.maxParts) > 0 ? Math.floor(Number(opts.maxParts)) : IMAGE_MAX_PARTS;
  let bitmap = null;
  let release = null;
  try {
    const decoded = await decodeImageBitmap(file);
    bitmap = decoded.bitmap;
    if (decoded.revoke && bitmap.src) release = () => URL.revokeObjectURL(bitmap.src);
    const width = bitmap.width || bitmap.naturalWidth || 0;
    const height = bitmap.height || bitmap.naturalHeight || 0;
    if (!width || !height || height <= maxEdge || height / width < IMAGE_LONG_RATIO) return null;

    // 先保证宽度不超限；若切片仍超过上限，再整体缩小到最多 maxParts 块。
    let scale = Math.min(1, maxEdge / width);
    const partsAtWidthScale = Math.ceil(height * scale / maxEdge);
    if (partsAtWidthScale > maxParts) scale = Math.min(scale, maxEdge * maxParts / height);
    const outW = Math.max(1, Math.round(width * scale));
    const sourceSliceH = Math.max(1, Math.floor(maxEdge / scale));
    const partCount = Math.ceil(height / sourceSliceH);
    const ext = '.' + (String(file.name || '').split('.').pop() || '').toLowerCase();
    const outFormat = 'jpeg';
    const dataUrls = [];

    for (let i = 0; i < partCount; i++) {
      const sourceY = i * sourceSliceH;
      const sourceH = Math.min(sourceSliceH, height - sourceY);
      const outH = Math.max(1, Math.round(sourceH * scale));
      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('无法创建画布上下文');
      // JPEG 没有透明通道；先铺白底，避免带透明区域的截图被编码成黑底。
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(bitmap, 0, sourceY, width, sourceH, 0, 0, outW, outH);
      const blob = await canvasToBlob(canvas, 'image/' + outFormat, IMAGE_LONG_JPEG_QUALITY);
      dataUrls.push(await blobToDataUrl(blob));
    }
    return {
      dataUrls,
      info: {
        width: outW,
        height: Math.min(maxEdge, Math.round(sourceSliceH * scale)),
        sourceWidth: width,
        sourceHeight: height,
        format: outFormat,
        converted: !['.jpg', '.jpeg'].includes(ext),
        resized: scale < 1,
        original: false,
        parts: dataUrls.length
      }
    };
  } catch (err) {
    // 解码/切片失败时交回普通单图预处理；后者还有原文件 data URL 兜底。
    return null;
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    if (release) release();
  }
}

// 把图片规范化为服务端一定接受的格式与尺寸；返回 { file, dataUrl, info }
// info: { width, height, format, converted, resized, original }
// opts.maxEdge / opts.maxPixels / opts.quality 可覆盖默认值（生成界面缩略图时用更小的尺寸）
async function downscaleImageForApi(file, opts = {}) {
  const maxEdge = Number(opts.maxEdge) > 0 ? Number(opts.maxEdge) : IMAGE_MAX_EDGE_PX;
  const maxPixels = Number(opts.maxPixels) > 0 ? Number(opts.maxPixels) : IMAGE_PNG_KEEP_MAX_PX;
  const jpegQuality = Number(opts.quality) > 0 ? Number(opts.quality) : IMAGE_JPEG_QUALITY;
  let bitmap = null;
  let release = null;
  try {
    const decoded = await decodeImageBitmap(file);
    bitmap = decoded.bitmap;
    if (decoded.revoke && bitmap.src) release = () => URL.revokeObjectURL(bitmap.src);
  } catch (err) {
    // 解不开（损坏文件等）：原样交给发送阶段，由服务端或后续提示兜底
    return { file: file, dataUrl: await readFileAsDataURL(file), info: null };
  }

  try {
    const width = bitmap.width || bitmap.naturalWidth || 0;
    const height = bitmap.height || bitmap.naturalHeight || 0;
    // 真实格式优先取魔数，其次 MIME / 扩展名
    let format = null;
    try {
      const head = new Uint8Array((await readFileAsArrayBuffer(file)).slice(0, 16));
      format = detectImageFormatFromBytes(head);
    } catch (e) { format = null; }
    if (!format) {
      const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
      format = (IMG_EXT_MIME[ext] || file.type || '').replace('image/', '').replace('jpg', 'jpeg') || null;
    }
    const supported = DS_IMAGE_FORMATS.includes(format);

    const longest = Math.max(width, height);
    const needsResize = longest > maxEdge;
    const scale = needsResize ? maxEdge / longest : 1;
    const extLower = '.' + (String(file.name || '').split('.').pop() || '').toLowerCase();
    const hasAlpha = format === 'png' || format === 'gif' || extLower === '.png';
    const pixels = width * height;
    // 已经是合规格式、尺寸也不大 → 原图直传，避免无谓重编码
    //  · GIF 一律直传（保留动画，转码会丢帧）
    //  · PNG 仅在像素不多时直传（PNG 体积大，大图重编码为 JPEG 后请求体明显更小）
    const canPassThrough = supported && !needsResize
      && (format === 'gif' || format !== 'png' || pixels <= maxPixels);
    if (canPassThrough) {
      return {
        file: file,
        dataUrl: await readFileAsDataURL(file),
        info: { width: width, height: height, format: format, converted: false, resized: false, original: true }
      };
    }

    const outW = Math.max(1, Math.round(width * scale));
    const outH = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布上下文');
    ctx.drawImage(bitmap, 0, 0, outW, outH);

    // 含透明通道或原本就是 PNG 的小图用 PNG（无损），其余用 JPEG（体积小，适合照片与截图）
    const usePng = hasAlpha || (format === 'png' && outW * outH <= maxPixels);
    const outFormat = usePng ? 'png' : 'jpeg';
    const blob = await canvasToBlob(canvas, 'image/' + outFormat, usePng ? undefined : jpegQuality);
    let outFile;
    try {
      outFile = new File([blob], String(file.name || 'image').replace(/\.[^.]+$/, '') + (outFormat === 'png' ? '.png' : '.jpg'), { type: 'image/' + outFormat });
    } catch (e) {
      outFile = blob; // 极端环境无 File 构造器时退回 Blob（readAsDataURL 仍可用）
      outFile.name = String(file.name || 'image');
    }
    const dataUrl = await blobToDataUrl(outFile);
    return {
      file: outFile,
      dataUrl: dataUrl,
      info: {
        width: outW, height: outH, format: outFormat,
        converted: !supported || format !== outFormat,
        resized: needsResize || longest > IMAGE_REENCODE_EDGE_PX,
        original: false
      }
    };
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    if (release) release();
  }
}

// 按当前模型给出图片是否可直接发送的判断与说明（供添加附件时提示）
function describeImageSupport(file, apiCfg = getEffectiveApiConfig()) {
  const raw = String(file.type || '').replace('image/', '').toLowerCase();
  let format = raw === 'jpg' ? 'jpeg' : raw;
  const ext = '.' + (String(file.name || '').split('.').pop() || '').toLowerCase();
  if (!format && IMG_EXT_MIME[ext]) format = IMG_EXT_MIME[ext].replace('image/', '');
  if (modelSupportsVision(apiCfg)) {
    const supported = DS_IMAGE_FORMATS.includes(format) || format === 'bmp';
    return {
      ok: true,
      note: supported ? '' : '该格式将在本地转换为 PNG/JPEG 后发送'
    };
  }
  return {
    ok: false,
    note: `当前模型（${apiCfg.model || '未知'}）不支持图片输入，请切换到支持看图的模型（如 deepseek-flash / Kimi）`
  };
}

// ═══════════ AI Chat: 粘贴（Ctrl+V）添加附件 ═══════════
// 剪贴板里的文件可能是：截图（无文件名）、从文件管理器复制的任意文件（PDF / 文本 / 图片…），
// 或从网页 / Office 复制的「文件 + 文本」组合。文件统一交给 addAiAttachmentFiles 校验——
// 与文件选择框、拖拽共用同一条路径（大小限制、模型能力判定、图片预处理都一致）。

// 剪贴板文件（截图 / 部分应用复制）常常没有文件名，这里按 MIME 补一个扩展名正确的名字。
// 不能随手补 .png：readFileAsDataURL() 会按扩展名改写 data URL 的 MIME，
// 一旦扩展名与真实格式不符（JPEG 字节存成 .png），服务端会直接判为不支持的图片。
const PASTE_FILE_MIME_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/bmp': '.bmp', 'application/pdf': '.pdf',
  'text/plain': '.txt', 'text/markdown': '.md', 'application/json': '.json'
};

// 纯文本达到该长度时，先询问是否转成 .txt 附件，避免超长正文挤满输入框。
const LARGE_PASTE_TEXT_THRESHOLD = 2000;
let largePasteDialogResolver = null;

function normalizePastedTextFileName(value) {
  let name = String(value || '').trim().replace(/[\\/:*?"<>|]/g, '-');
  if (!name) name = '粘贴文本';
  if (!name.toLowerCase().endsWith('.txt')) name += '.txt';
  return name;
}

function closeLargePasteDialog(asFile) {
  const overlay = document.getElementById('aiLargePasteOverlay');
  if (!overlay || !largePasteDialogResolver) return;
  const input = document.getElementById('aiLargePasteFileName');
  const resolve = largePasteDialogResolver;
  largePasteDialogResolver = null;
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  resolve(asFile ? normalizePastedTextFileName(input && input.value) : null);
}

function askLargePasteAsFile(text) {
  let overlay = document.getElementById('aiLargePasteOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'aiLargePasteOverlay';
    overlay.className = 'modal-overlay ai-large-paste-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `<div class="modal ai-large-paste-dialog" role="dialog" aria-modal="true" aria-labelledby="aiLargePasteTitle">
      <div class="modal-header">
        <div class="modal-title" id="aiLargePasteTitle">粘贴为文本文件？</div>
        <button class="modal-close" type="button" onclick="closeLargePasteDialog(false)" aria-label="关闭">✕</button>
      </div>
      <div class="modal-body">
        <p class="ai-large-paste-summary"></p>
        <label class="modal-field"><span>文件名</span><input id="aiLargePasteFileName" type="text" value="粘贴文本.txt" autocomplete="off" spellcheck="false"></label>
        <div class="ai-large-paste-actions">
          <button type="button" class="btn-secondary" onclick="closeLargePasteDialog(false)">直接粘贴</button>
          <button type="button" class="btn-save-modal" onclick="closeLargePasteDialog(true)">作为 .txt 附件</button>
        </div>
      </div>
    </div>`;
    overlay.addEventListener('click', event => { if (event.target === overlay) closeLargePasteDialog(false); });
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeLargePasteDialog(false);
      if (event.key === 'Enter') { event.preventDefault(); closeLargePasteDialog(true); }
    });
    document.body.appendChild(overlay);
  }
  // 若极短时间内重复触发粘贴，上一段按直接粘贴处理，不让 Promise 永久悬空。
  if (largePasteDialogResolver) closeLargePasteDialog(false);
  overlay.querySelector('.ai-large-paste-summary').textContent = `检测到 ${text.length.toLocaleString()} 个字符。转为附件可以保持输入框简洁。`;
  const nameInput = overlay.querySelector('#aiLargePasteFileName');
  nameInput.value = `粘贴文本-${new Date().toISOString().slice(0, 10)}.txt`;
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  return new Promise(resolve => {
    largePasteDialogResolver = resolve;
    requestAnimationFrame(() => { nameInput.focus(); nameInput.select(); });
  });
}

function buildClipboardFileName(file, index) {
  const type = String((file && file.type) || '').toLowerCase();
  const isImage = type.startsWith('image/');
  const ext = PASTE_FILE_MIME_EXT[type] || (isImage ? '.png' : '');
  const seq = index > 0 ? '-' + (index + 1) : '';
  return (isImage ? '粘贴图片-' : '粘贴文件-') + Date.now() + seq + ext;
}

// 取出剪贴板里的文件项（部分来源只填 clipboardData.files 不填 items），并补齐缺失的文件名
function getClipboardFiles(clipboardData) {
  const dt = clipboardData;
  const out = [];
  const items = dt && dt.items ? Array.from(dt.items) : [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile && item.getAsFile();
    if (file) out.push(file);
  }
  if (out.length === 0 && dt && dt.files) out.push(...Array.from(dt.files));
  return out.map((file, index) => (file.name
    ? file
    : new File([file], buildClipboardFileName(file, index), { type: file.type || 'image/png' })));
}

// 剪贴板同时带文本时（网页 / Office 复制常见），文本按原生粘贴补进输入框，
// 避免只贴到附件而丢掉文字。从文件管理器复制文件时 text/plain 可能是纯文件路径，不插入。
function getClipboardPlainText(clipboardData) {
  if (!clipboardData || typeof clipboardData.getData !== 'function') return '';
  const text = clipboardData.getData('text/plain') || '';
  if (!text.trim()) return '';
  const single = text.trim();
  if (!text.includes('\n') && /^[a-zA-Z]:\\|^\\\\|^\//.test(single)) return '';
  return text;
}

// 把文本插到输入框光标处（尽量用 execCommand 以保留原生撤销栈与 input 事件）
function insertPastedInputText(text, selection) {
  const input = document.getElementById('aiInput');
  if (!input || input.disabled || !text) return;
  input.focus();
  let inserted = false;
  if (!selection && typeof document.execCommand === 'function') {
    try { inserted = document.execCommand('insertText', false, text); } catch (e) { inserted = false; }
  }
  if (!inserted) {
    const start = selection && Number.isInteger(selection.start)
      ? selection.start : (typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length);
    const end = selection && Number.isInteger(selection.end)
      ? selection.end : (typeof input.selectionEnd === 'number' ? input.selectionEnd : start);
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    const caret = start + text.length;
    try { input.setSelectionRange(caret, caret); } catch (e) { /* 忽略：光标恢复失败不影响已插入的文本 */ }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (typeof autoResizeAiInput === 'function') autoResizeAiInput();
}

// 这次粘贴是否由本模块接管：
//   · 目标在聊天区内（输入框、消息区、附件预览…）→ 接管
//   · 焦点不在聊天区（例如刚点过消息区 / body 拿到焦点）→ 仅当 AI 栏目处于激活状态才接管，
//     避免抢走其他栏目与弹窗里的粘贴
function isAiPasteZone(event) {
  const layout = document.getElementById('aiChatLayout');
  const target = event.target;
  if (layout && target && layout.contains(target)) return true;
  if (target !== document.body && target !== document.documentElement) return false;
  const section = document.getElementById('section-ai');
  return !!(section && section.classList.contains('active'));
}

// 粘贴文件 → 加入附件；短纯文本仍走浏览器原生行为，长纯文本可转成可命名的 .txt 附件。
async function handleAiPaste(event) {
  const dt = event.clipboardData;
  if (!dt) return;
  const input = document.getElementById('aiInput');
  if (input && input.disabled) return; // 未配置 Key 时界面只读，保持原生粘贴
  if (!isAiPasteZone(event)) return;
  const files = getClipboardFiles(dt);
  const plainText = getClipboardPlainText(dt);
  if (files.length === 0) {
    if (!input || event.target !== input || plainText.length < LARGE_PASTE_TEXT_THRESHOLD) return;
    const selection = { start: input.selectionStart, end: input.selectionEnd };
    event.preventDefault();
    const fileName = await askLargePasteAsFile(plainText);
    if (fileName) {
      const file = new File([plainText], fileName, { type: 'text/plain;charset=utf-8' });
      const added = addAiAttachmentFiles([file]);
      if (added.length && typeof showAiToast === 'function') showAiToast(`📎 已添加文本附件：${added[0]}`);
    } else {
      insertPastedInputText(plainText, selection);
    }
    return;
  }
  event.preventDefault(); // 有文件时不要把二进制/文件名当文本贴进输入框
  const added = addAiAttachmentFiles(files);
  if (added.length === 0) return;
  if (plainText) insertPastedInputText(plainText);
  if (typeof showAiToast === 'function') {
    showAiToast(added.length === 1 ? `📎 已粘贴附件：${added[0]}` : `📎 已粘贴 ${added.length} 个附件`);
  }
}

// 绑定剪贴板粘贴。事件挂在 document 上——输入框会被 renderAiChat 重建，挂在输入框上每次重建都要重绑；
// 是否接管由 isAiPasteZone() 判定。保留为可重复调用的形式，兼容既有调用点。
function initAiPasteZone() {
  if (document._aiPasteAttached) return;
  document._aiPasteAttached = true;
  document.addEventListener('paste', handleAiPaste);
}

// Check if a file is an image (for Kimi vision inline base64 analysis)
function isImageFile(file) {
  const imgTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/bmp'];
  const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
  const imgExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
  return imgTypes.includes(file.type) || imgExts.includes(ext);
}

// Check if a file is a video (for Kimi vision via file upload + ms://)
function isVideoFile(file) {
  const videoTypes = ['video/mp4', 'video/mpeg', 'video/mov', 'video/avi', 'video/x-flv', 'video/mpg', 'video/webm', 'video/wmv', 'video/3gpp'];
  const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
  const videoExts = ['.mp4', '.mpeg', '.mov', '.avi', '.flv', '.mpg', '.webm', '.wmv', '.3gpp'];
  return videoTypes.includes(file.type) || videoExts.includes(ext);
}

// Check if a file is an image or video (for Kimi vision analysis)
function isVisionFile(file) {
  const imgTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/bmp'];
  const videoTypes = ['video/mp4', 'video/webm', 'video/mov', 'video/avi'];
  const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
  const imgExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
  const videoExts = ['.mp4', '.webm', '.mov', '.avi'];

  const byMime = [...imgTypes, ...videoTypes].includes(file.type);
  const byExt = [...imgExts, ...videoExts].includes(ext);
  if (isDebugMode()) console.log('[DEBUG isVisionFile] name:', file.name, 'type:', file.type, 'ext:', ext, 'byMime:', byMime, 'byExt:', byExt, 'result:', byMime || byExt);
  return byMime || byExt;
}
