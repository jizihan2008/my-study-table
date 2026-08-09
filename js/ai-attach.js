// ═══════════════════════════════════════════════
//  AI 附件处理：文件上传、预览、Kimi 文件处理、视觉文件识别
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

// 将文件列表加入附件（供文件选择框与拖拽共用）
function addAiAttachmentFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  const maxSize = isKimiModel() ? 100 * 1024 * 1024 : 20 * 1024 * 1024; // Kimi: 100MB, others: 20MB
  const sizeLabel = isKimiModel() ? '100MB' : '20MB';
  for (const file of files) {
    if (file.size > maxSize) {
      alert(`文件 "${file.name}" 超过 ${sizeLabel} 限制，已跳过`);
      continue;
    }
    // 非视觉模型只接受文本类文件（发送时按纯文本读取，二进制会乱码）
    if (!isKimiModel() && !isTextFile(file)) {
      alert(`当前模型（${getEffectiveApiConfig().model || '未知'}）不支持 "${file.name}"，仅支持文本类文件（.txt / .md / .json / 代码文件等）`);
      continue;
    }
    const attach = { name: file.name, file: file, size: file.size };
    // For Kimi image files, default to inline (base64), user can switch to OCR
    if (isKimiModel() && isVisionFile(file)) {
      attach.ocrMode = false; // false = base64 inline, true = OCR via file-extract
    }
    aiAttachments.push(attach);
  }
  renderAttachPreview();
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
  wrap.innerHTML = aiAttachments.map((a, i) => {
    const isImage = isKimiModel() && a.ocrMode !== undefined;
    const modeLabel = a.ocrMode ? '📄 OCR' : '🖼️ 内联';
    const modeToggle = isImage
      ? `<button class="preview-mode-btn" onclick="toggleAttachOcrMode(${i})" title="${a.ocrMode ? '切换到内联(base64)上传' : '切换到 OCR 提取文字'}">${modeLabel}</button>`
      : '';
    return `<span class="ai-attach-preview">
      <span class="preview-icon">${isImage ? '🖼️' : '📝'}</span>
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
function isKimiModel() {
  const apiCfg = getEffectiveApiConfig();
  return (apiCfg.model || '').toLowerCase().includes('kimi');
}

// Update file input accept and placeholder based on current model
function updateAiFileInput() {
  const input = document.getElementById('aiFileInput');
  const placeholder = document.getElementById('aiInput');
  if (!input || !placeholder) return;
  if (isKimiModel()) {
    input.accept = '';
    placeholder.placeholder = '输入你的问题，回车发送... (支持 PDF / Word / Excel / 图片 / 视频等文件)';
  } else {
    // 非视觉模型（DeepSeek 等）：文本类文件按纯文本读取，支持常见文本格式
    input.accept = TEXT_FILE_EXTS.join(',');
    placeholder.placeholder = '输入你的问题，回车发送... (支持 .txt / .md / .json / 代码文件等文本附件)';
  }
}

// Upload file to Kimi API and return the extracted content (for documents: PDF/Word/Excel etc.)
async function uploadToKimi(file) {
  const apiCfg = getEffectiveApiConfig();
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
async function uploadVideoToKimi(file) {
  const apiCfg = getEffectiveApiConfig();
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
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
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
