// ═══════════════════════════════════════════════
//  AI 附件处理：文件上传、预览、Kimi 文件处理、图片（视觉）识别与预处理
//  · 文本类附件：按纯文本读取后拼进提示词
//  · 图片附件：走 OpenAI 兼容的 image_url base64 内联（deepseek-flash / Kimi / *vision* 模型）
//  · 本地预处理：超大图缩放、BMP 等不支持格式转 PNG/JPEG、按扩展名补齐 MIME
// ═══════════════════════════════════════════════

// ═══════════ AI Chat: Attachments ═══════════
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

// 附件大小上限：Kimi 文档 100MB；图片按“最宽松的一条路径”放行，
// 真正发送时若走内联且超限会被 pruneOversizedImageAttachments 拦截并提示
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
  const isImage = !!file && (typeof isImageFile === 'function' ? isImageFile(file) : false);
  const max = isKimiModel(apiCfg)
    ? ATTACH_MAX_BYTES.kimi
    : (isImage ? ATTACH_MAX_BYTES.visionImage : ATTACH_MAX_BYTES.file);
  return { max: max, label: formatFileSize(max) };
}

// 将文件列表加入附件（供文件选择框、拖拽与粘贴共用）
function addAiAttachmentFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  const apiCfg = getEffectiveApiConfig();
  for (const file of files) {
    const limit = getAttachSizeLimit(file, apiCfg);
    if (file.size > limit.max) {
      alert(`文件 "${file.name}" 超过 ${limit.label} 限制，已跳过`);
      continue;
    }
    // 非多模态模型只接受文本类文件（发送时按纯文本读取，二进制会乱码）。
    // 多模态模型（Kimi / deepseek-flash 等）额外放行「图片」——注意只认图片，
    // 否则 .exe/.zip 这类二进制也会被放行并按文本读取，产生乱码垃圾。
    const isImage = isImageFile(file);
    if (!isTextFile(file) && !(isMultimodalModel(apiCfg) && isImage)) {
      alert(`当前模型（${apiCfg.model || '未知'}）不支持 "${file.name}"，`
        + (isMultimodalModel(apiCfg)
          ? '仅支持图片（PNG / JPEG / GIF / WebP / BMP）与文本类文件（.txt / .md / .json / 代码文件等）'
          : '仅支持文本类文件（.txt / .md / .json / 代码文件等），图片需切换到支持看图的模型'));
      continue;
    }
    const attach = { name: file.name, file: file, size: file.size };
    // For Kimi image files, default to inline (base64), user can switch to OCR
    if (isKimiModel(apiCfg) && isImage) {
      attach.ocrMode = false; // false = base64 inline, true = OCR via file-extract
    }
    aiAttachments.push(attach);
    // DeepSeek 等视觉模型：本地预处理图片（超大图缩放、BMP 等不支持格式转 PNG/JPEG、补齐 MIME），
    // 避免上传后才由服务端报错，同时明显减小请求体
    if (!isKimiModel(apiCfg) && isImage) preprocessAiImageAttachment(attach);
  }
  renderAttachPreview();
}

// 内联图片体积：base64 约等于原始字节 ×1.37（预处理结果存在时按其实际长度精确计算）
function getInlineImageBytes(attach) {
  if (!attach) return 0;
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

// 在历史消息里找同一张图已上传的 file_id：
//  · 同一 API Key 上传的文件才能被该 Key 引用（换 Key 后必须重新上传）
//  · 会话内多次发送同名图片（同一张图配不同问题）时命中，直接复用不再上传
//  · 跨会话命中依赖文件名相同，属于尽力而为的优化
function findReusableUploadedImage(name, apiCfg = getEffectiveApiConfig()) {
  const target = String(name || '');
  if (!target) return null;
  const keyId = apiCfg.keyId || '';
  const convs = (typeof aiConvs !== 'undefined' && Array.isArray(aiConvs)) ? aiConvs : [];
  for (const conv of convs) {
    const messages = (conv && Array.isArray(conv.messages)) ? conv.messages : [];
    for (const m of messages) {
      if (!m || !Array.isArray(m.visionFiles)) continue;
      for (const vf of m.visionFiles) {
        if (vf && vf.type === 'file' && vf.fileId && vf.name === target && (vf.uploadKeyId || '') === keyId) {
          return { fileId: vf.fileId, uploadKeyId: vf.uploadKeyId || '', thumb: vf.dataUrl || '' };
        }
      }
    }
  }
  return null;
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
//   · Files API（大图/照片）：上传原图换 file_id → 之后每轮只发 file_id，另存小缩略图供界面预览
//   · 内联 base64（小图 / 非官方端点 / 用户关闭上传）：缩放转码后内联
function preprocessAiImageAttachment(attach) {
  if (attach._processPromise) return attach._processPromise;
  attach.imageProcessing = true;
  attach._processPromise = (async () => {
    const apiCfg = getEffectiveApiConfig();
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
    try {
      const processed = await downscaleImageForApi(attach.file);
      attach.file = processed.file;
      attach.dataUrl = processed.dataUrl;
      attach.imageInfo = processed.info;
    } catch (err) {
      attach._preprocessError = (err && err.message) || String(err);
      if (isDebugMode()) console.warn('[AI attach] 图片预处理失败，发送时将按原文件读取：', attach._preprocessError);
    }
    return attach;
  })().finally(() => {
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

// 只读快照（供测试/诊断查看待发附件；aiAttachments 是 settings.js 的 let 绑定，不在 window 上）
function getAiAttachmentsSnapshot() {
  return aiAttachments.map(a => ({
    name: a.name,
    size: a.size,
    type: (a.file && a.file.type) || '',
    ocrMode: a.ocrMode,
    imageProcessing: a.imageProcessing === true,
    imageInfo: a.imageInfo || null,
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
    const isImage = (isKimiModel() && a.ocrMode !== undefined) || (multimodal && isImageFile(a.file));
    // 已预处理的图片直接显示缩略图（BMP 等不支持格式转换后也能看到效果）
    const thumb = isImage && a.dataUrl
      ? `<img class="preview-thumb" src="${a.dataUrl}" alt="">`
      : `<span class="preview-icon">${isImage ? '🖼️' : '📝'}</span>`;
    let modeToggle = '';
    if (isImage && a.ocrMode !== undefined) {
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
        tip = `图片内联(base64)分析：${a.imageInfo.width}×${a.imageInfo.height}${a.imageInfo.converted ? '（已转为 ' + a.imageInfo.format.toUpperCase() + '）' : ''}${a.imageInfo.resized ? '（已缩放）' : ''}`;
      } else {
        tip = '图片内联(base64)分析';
      }
      const label = a.imageProcessing ? '⏳ 处理中' : (a.uploadError ? '🖼️ 内联(回退)' : '🖼️ 内联');
      modeToggle = `<span class="preview-mode-tag" title="${escapeHtml(tip)}">${label}</span>`;
    }
    return `<span class="ai-attach-preview">
      ${thumb}
      <span class="preview-name">${escapeHtml(a.name.length > 15 ? a.name.slice(0,15)+'…' : a.name)}</span>
      <span class="preview-size">${formatFileSize(a.size)}</span>
      ${modeToggle}
      <button class="preview-remove" onclick="removeAttachment(${i})">✕</button>
    </span>`;
  }).join('');
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
  if (isKimiModel()) {
    input.accept = '';
    placeholder.placeholder = '输入你的问题，回车发送... (支持 PDF / Word / Excel / 图片 / 视频等文件)';
  } else if (isVisionModel()) {
    // 视觉模型（deepseek-flash / DeepSeek V4.1 Flash 等）：图片支持内联分析，其他文件按文本读取
    input.accept = '';
    placeholder.placeholder = '输入你的问题，回车发送... (支持图片分析 / 拖拽或粘贴图片 / .txt / .md / .json / 代码文件等)';
  } else {
    // 非视觉模型（DeepSeek 等）：文本类文件按纯文本读取，支持常见文本格式
    input.accept = TEXT_FILE_EXTS.join(',');
    placeholder.placeholder = '输入你的问题，回车发送... (支持 .txt / .md / .json / 代码文件等文本附件)';
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

// ═══════════ 图片预处理：格式归一 + 超大图缩放 ═══════════
// 依据 DeepSeek 图像理解限制：仅支持 JPEG / PNG / GIF / WebP；单边最长 8192 像素；单图内联 32 MiB。
// 这里把不支持/过大的图片在本地转成 JPEG(照片) 或 PNG(含透明/小图)，既保证可发送也减小请求体。
const DS_IMAGE_FORMATS = ['jpeg', 'png', 'gif', 'webp'];
const IMAGE_MAX_EDGE_PX = 2048;     // 超过则等比缩小（远低于服务端 8192 上限，显著减小 base64 体积）
const IMAGE_REENCODE_EDGE_PX = 1600; // 原本已合规但尺寸偏大时也压缩一次，便于本地存档与传输
const IMAGE_JPEG_QUALITY = 0.85;
const IMAGE_PNG_KEEP_MAX_PX = 1024 * 1024; // png/webp/gif 且像素不多、无缩放宽高时保留原图（无损）

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

// 粘贴图片（剪贴板）→ 加入附件：截图直接 Ctrl+V 即可分析
function handleAiPaste(event) {
  const dt = event.clipboardData;
  if (!dt || !dt.items || dt.items.length === 0) return;
  const files = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile && item.getAsFile();
    if (!file) continue;
    if (isImageFile(file) || (file.type || '').startsWith('image/')) {
      // 剪贴板图片常无文件名 → 补一个便于识别与回显
      const named = file.name ? file : new File([file], '粘贴图片-' + Date.now() + '.png', { type: file.type || 'image/png' });
      files.push(named);
    }
  }
  if (files.length === 0) return;
  event.preventDefault(); // 有图片时不再把二进制当文本粘进输入框
  addAiAttachmentFiles(files);
}

// 绑定剪贴板粘贴（DOM 重建后输入框会被替换，故暴露为可重复调用）
function initAiPasteZone() {
  const input = document.getElementById('aiInput');
  if (!input || input._pasteAttached) return;
  input._pasteAttached = true;
  input.addEventListener('paste', handleAiPaste);
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
