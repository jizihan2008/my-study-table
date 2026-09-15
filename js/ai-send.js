// ═══════════════════════════════════════════════
//  AI 发送与交互：消息发送、候选回复管理、工具栏、快速操作
// ═══════════════════════════════════════════════

// ═══════════ Send/stop button handler ═══════════
function handleAiSendOrStop() {
  const convId = getActiveConvId();
  if (isAiLoading(convId)) {
    // Stop the AI for this conversation
    setAiStopRequested(convId, true);
    if (typeof AIClient !== 'undefined') AIClient.cancel(convId);
    // 停止当前回复时清空发送队列（停止 = 停止一切），避免回复结束后自动补发排队消息
    if (_aiSendQueue.length > 0) {
      _aiSendQueue = _aiSendQueue.filter(item => item.convId !== convId);
      updateAiQueueIndicator();
      if (typeof showAiToast === 'function') showAiToast('已停止并清空当前对话的发送队列');
    }
    updateAiSendButton();
  } else {
    sendAiMessage();
  }
}

function updateAiSendButton() {
  const sendBtn = document.getElementById('aiSendBtn');
  const sendIcon = document.getElementById('aiSendIcon');
  if (!sendBtn || !sendIcon) return;
  if (isAiLoading(getActiveConvId())) {
    sendBtn.title = '停止';
    sendBtn.style.background = 'var(--danger, #ef4444)';
    sendBtn.style.borderColor = 'var(--danger, #ef4444)';
    sendIcon.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>';
    sendBtn.disabled = false;
  } else {
    sendBtn.title = '发送';
    sendBtn.style.background = '';
    sendBtn.style.borderColor = '';
    sendIcon.innerHTML = '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>';
    sendBtn.disabled = false;
  }
}

// ═══════════ AI 发送队列：回复中发送的消息排队，回复完成后自动发送下一条 ═══════════
let _aiSendQueue = [];       // [{ id, convId, text, attachments, contextInserts, displayContent }]
let _aiQueueDraining = false; // 防止队列递归触发
let _aiQueueSeq = 0;         // 队列项唯一 id 序号
let _aiQueuePanelOpen = false; // 预览面板展开状态

// 队列项文本预览（单行截断）
function _queueTextPreview(text, maxLen) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '（纯附件）';
  return t.length > (maxLen || 40) ? t.slice(0, maxLen) + '…' : t;
}

function formatAiRequestError(error) {
  const message = String(error?.message || error || '未知错误');
  if (/unsupported image|image.+(?:format|invalid|unsupported)|图片.+(?:格式|不支持|无效)/i.test(message)) {
    return '❌ 图片发送失败：' + message + '\n\n该图片可能来自旧对话记录，或尺寸/编码不被当前模型接受。请刷新应用后重新上传；应用会自动跳过历史中的不兼容原图。';
  }
  if (/上下文预算|系统提示词|Max Tokens/.test(message)) {
    return '❌ 出错了：' + message + '\n\n可在“设置 → AI 设置 → 编辑当前 Key → 更多设置”中调整。';
  }
  if (/已取消|手动停止/.test(message)) return '⏹️ ' + message;
  return '❌ 出错了：' + message + '\n\n请检查 API Key、接口地址和网络连接。';
}

// 更新指示条 + 预览面板
function updateAiQueueIndicator() {
  const el = document.getElementById('aiQueueIndicator');
  if (!el) return;
  const n = _aiSendQueue.length;
  if (n > 0) {
    el.innerHTML = '<i data-lucide="list-ordered" style="width:13px;height:13px;vertical-align:middle;"></i> 发送队列：' + n + ' 条消息等待中' + (_aiQueuePanelOpen ? '（点击收起）' : '（点击查看）');
    el.style.display = '';
  } else {
    el.style.display = 'none';
    _aiQueuePanelOpen = false;
    const panel = document.getElementById('aiQueuePanel');
    if (panel) panel.style.display = 'none';
  }
  renderAiQueuePanel();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// 渲染预览面板（播放列表风格：每条消息预览 + 删除按钮，底部清空）
function renderAiQueuePanel() {
  const panel = document.getElementById('aiQueuePanel');
  if (!panel) return;
  if (!_aiQueuePanelOpen) { panel.style.display = 'none'; return; }
  if (_aiSendQueue.length === 0) {
    panel.style.display = 'none';
    _aiQueuePanelOpen = false;
    updateAiQueueIndicator();
    return;
  }
  const rows = _aiSendQueue.map((item, idx) => `
    <div class="ai-queue-item">
      <span class="ai-queue-item-num">${idx + 1}</span>
      <span class="ai-queue-item-text" title="${String(item.text || '纯附件').replace(/"/g, '&quot;').replace(/\n/g, ' ')}">${_queueTextPreview(item.text, 48)}</span>
      ${item.attachments && item.attachments.length > 0 ? '<span class="ai-queue-item-attach">📎</span>' : ''}
      <button class="ai-queue-item-del" onclick="removeAiQueueItem('${item.id}')" title="从队列移除">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`).join('');
  panel.innerHTML = `
    <div class="ai-queue-panel-head">
      <span>待发送消息（${_aiSendQueue.length}）</span>
      <button class="ai-queue-clear-btn" onclick="clearAiQueue()">清空全部</button>
    </div>
    ${rows}`;
  panel.style.display = '';
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// 切换预览面板展开/折叠
function toggleAiQueuePanel(ev) {
  if (ev && ev.target.closest('.ai-queue-item-del')) return; // 点击删除按钮不切换
  _aiQueuePanelOpen = !_aiQueuePanelOpen;
  renderAiQueuePanel();
  updateAiQueueIndicator();
}

// 从队列移除单条（供面板删除按钮调用）
function removeAiQueueItem(id) {
  _aiSendQueue = _aiSendQueue.filter(item => item.id !== id);
  if (_aiSendQueue.length === 0) _aiQueuePanelOpen = false;
  updateAiQueueIndicator();
  if (typeof showAiToast === 'function') showAiToast('已从发送队列移除');
}

// 清空整个发送队列
function clearAiQueue() {
  const n = _aiSendQueue.length;
  if (n === 0) return;
  if (typeof confirm === 'function' && !confirm('清空全部 ' + n + ' 条待发送消息？')) return;
  _aiSendQueue = [];
  _aiQueuePanelOpen = false;
  updateAiQueueIndicator();
  if (typeof showAiToast === 'function') showAiToast('已清空发送队列');
}

async function drainAiSendQueue(convId) {
  if (_aiQueueDraining) return;
  // 该会话仍在回复中 → 等 sendAiMessage 完成后再次触发
  if (isAiLoading(convId)) return;
  _aiQueueDraining = true;
  try {
    // 循环处理该会话的全部排队消息（sendAiMessage 内部也会触发本函数，
    // 但受 _aiQueueDraining 保护不会重入）
    while (_aiSendQueue.length > 0) {
      // 用户已切换到其他会话 → 暂停发送，等切回该会话时（switchConv）再继续
      if (convId !== getActiveConvId()) break;
      const idx = _aiSendQueue.findIndex(item => item.convId === convId);
      if (idx < 0) break;
      const item = _aiSendQueue.splice(idx, 1)[0];
      updateAiQueueIndicator();
      await sendAiMessage(item.text, item.attachments, item.contextInserts, item.displayContent);
    }
  } finally {
    _aiQueueDraining = false;
    updateAiQueueIndicator();
  }
}

// sendAiMessage(externalText, externalAttachments, externalContextInserts, externalDisplayContent)：
//   - 不传参：从输入框读取（用户手动发送）。若当前正在回复 → 入队等待，回复完成后自动发送。
//   - 传参：由队列自动发送（drainAiSendQueue 调用），文本/附件来自队列快照。
async function sendAiMessage(externalText, externalAttachments, externalContextInserts, externalDisplayContent) {
  const convId = getActiveConvId();
  const fromQueue = externalText !== undefined;
  const input = document.getElementById('aiInput');

  // 用户手动发送但 AI 正在回复 → 加入发送队列（不清空输入框，提示排队）
  if (!fromQueue && isAiLoading(convId)) {
    if (!input) return null;
    const displayContent = input.value.trim();
    const contextInserts = typeof getAiContextInsertSnapshot === 'function' ? getAiContextInsertSnapshot() : [];
    const qText = displayContent + (typeof buildAiContextInsertText === 'function' ? buildAiContextInsertText(contextInserts) : '');
    const hasContext = typeof aiContextInserts !== 'undefined' && aiContextInserts.length > 0;
    if (!qText && aiAttachments.length === 0 && !hasContext) return null;
    _aiQueueSeq++;
    _aiSendQueue.push({ id: 'q' + _aiQueueSeq, convId, text: qText, attachments: [...aiAttachments], contextInserts, displayContent });
    updateAiQueueIndicator();
    if (typeof showAiToast === 'function') showAiToast('已加入发送队列（' + _aiSendQueue.length + ' 条待发送）');
    clearAiDraft();
    input.value = '';
    input.style.height = 'auto';
    aiAttachments = [];
    if (typeof clearAiContextInserts === 'function') clearAiContextInserts();
    renderAttachPreview();
    return null;
  }

  if (!fromQueue && !input) return null;
  const contextInserts = fromQueue
    ? (Array.isArray(externalContextInserts) ? externalContextInserts : [])
    : (typeof getAiContextInsertSnapshot === 'function' ? getAiContextInsertSnapshot() : []);
  const displayContent = fromQueue ? String(externalDisplayContent ?? externalText ?? '') : input.value.trim();
  const contextText = !fromQueue && typeof buildAiContextInsertText === 'function' ? buildAiContextInsertText(contextInserts) : '';
  const text = (fromQueue ? String(externalText) : displayContent) + contextText;
  // Allow empty text if there are attachments
  const hasAttach = fromQueue ? (externalAttachments && externalAttachments.length > 0) : aiAttachments.length > 0;
  if (!text && !hasAttach) return null;
  // Clear draft for this conv before sending
  if (!fromQueue) clearAiDraft();
  const apiCfg = { ...getEffectiveApiConfig() };
  if (!apiCfg.apiKey) { openSettingsModal(); return null; }

  const conv = getActiveConv();
  if (!conv) return null;
  // 队列发送防御：若发送期间用户切换了会话，放回队列并停止本次处理
  // （drainAiSendQueue 检测到会话不匹配时会 break，等待切回后继续）
  if (fromQueue && conv.id !== convId) {
    _aiQueueSeq++;
    _aiSendQueue.unshift({ id: 'q' + _aiQueueSeq, convId, text: String(externalText), attachments: externalAttachments || [], contextInserts, displayContent });
    updateAiQueueIndicator();
    return null;
  }

  apiCfg.conversationSettings = { id: conv.id, _webSearchMode: conv._webSearchMode, _webSearchEnabled: conv._webSearchEnabled };

  // Snapshot current attachments
  const currentAttachments = fromQueue ? [...(externalAttachments || [])] : [...aiAttachments];

  // Clear only the originating composer, before file reads yield control.
  // After an await the user may already be editing another conversation.
  if (!fromQueue) {
    input.value = '';
    input.style.height = 'auto';
    aiAttachments = [];
    renderAttachPreview();
    if (typeof clearAiContextInserts === 'function') clearAiContextInserts();
  }
  setAiLoading(conv.id, true);
  setAiStopRequested(conv.id, false);
  updateAiSendButton();

  // 附件在消息里的展示信息（displayUrl 在下面处理附件时补上：可能是 Files API 的小缩略图）
  const displayAttachments = currentAttachments.map(a => ({ name: a.name, size: a.size, displayUrl: a.dataUrl || '' }));

  // Process attachments: Kimi uses its file API; other models use local PDF conversion or text/image input.
  let docTexts = '';
  const isKimi = isKimiModel(apiCfg);
  const isVision = isVisionModel(apiCfg);
  // 图片附件：内联 base64 会让请求体膨胀约 1.37 倍（服务端另有 48 MiB 请求体上限），
  // 预处理失败的超大图在发送前剔除并说明，避免整条消息因 413/400 失败
  const oversized = pruneOversizedImageAttachments(currentAttachments, apiCfg);
  if (oversized.length > 0) {
    docTexts += `\n\n[以下图片未发送：${oversized.join('、')} —— 内联(base64)体积超出限制，请压缩后重试]`;
    // 从本次发送的快照中剔除（currentAttachments 是浅拷贝，需按名字过滤）
    for (let i = currentAttachments.length - 1; i >= 0; i--) {
      if (currentAttachments[i] && oversized.indexOf(currentAttachments[i].name) >= 0) currentAttachments.splice(i, 1);
    }
  }
  if (isDebugMode()) console.log('[DEBUG sendAiMessage] isKimi:', isKimi, 'isVision:', isVision, 'attachments:', currentAttachments.length);
  // Collect vision file references (base64 data URLs) for multimodal content
  let visionFiles = [];
  for (const a of currentAttachments) {
    if (isAiStopRequested(conv.id)) break;
    try {
      // Kimi 已有原生 file-extract；其他模型的 PDF 统一在本地转为文本或页面图片。
      if (!isKimi && isPdfFile(a.file)) {
        if (a.pdfMode === 'image') {
          if (!isVision) {
            docTexts += `\n\n[附件：${a.name} — 当前模型不支持图片输入，请改用“提取文字”模式]`;
            continue;
          }
          const rendered = await renderPdfAttachmentPages(a.file);
          a.pdfInfo = rendered;
          a.dataUrls = rendered.dataUrls;
          a.dataUrl = rendered.dataUrls[0] || '';
          rendered.dataUrls.forEach((dataUrl, index) => visionFiles.push({
            dataUrl,
            name: `${a.name}（PDF 第 ${index + 1}/${rendered.pageCount} 页）`,
            type: 'image_url'
          }));
          if (rendered.truncated) {
            docTexts += `\n\n[PDF：${a.name} — 共 ${rendered.pageCount} 页，页面图片模式本次仅发送前 ${rendered.renderedPages} 页]`;
          }
          const idx = displayAttachments.findIndex(d => d.name === a.name);
          if (idx >= 0) displayAttachments[idx].displayUrl = a.dataUrl;
        } else {
          const extracted = await extractPdfAttachmentText(a.file);
          a.pdfInfo = extracted;
          let content = extracted.text;
          if (!content) {
            content = '[未检测到可提取的文字层；这可能是扫描版 PDF。请切换到“页面图片”模式并使用支持看图的模型。]';
          } else if (extracted.truncated) {
            content += '\n\n[PDF 文字内容过长，已截断]';
          }
          docTexts += `\n\n[PDF附件（提取文字）：${a.name}，共 ${extracted.pageCount} 页]\n` + content;
          const idx = displayAttachments.findIndex(d => d.name === a.name);
          if (idx >= 0) displayAttachments[idx].content = content;
        }
      } else if (isKimi) {
        if (isVisionFile(a.file)) {
          // Video: must upload to Kimi first, reference via ms://<fileId>
          if (isVideoFile(a.file)) {
            if (isDebugMode()) console.log('[DEBUG] Video upload', a.name);
            const fileId = await uploadVideoToKimi(a.file, apiCfg);
            visionFiles.push({
              fileId: fileId,
              name: a.name,
              type: 'video_url'
            });
          } else if (a.ocrMode) {
            // OCR mode: upload to Kimi file-extract for text extraction
            if (isDebugMode()) console.log('[DEBUG] Vision path: OCR upload', a.name);
            const content = await uploadToKimi(a.file, apiCfg);
            const maxLen = 80000;
            const truncated = content.length > maxLen ? content.slice(0, maxLen) + '\n\n[内容过长，已截断...]' : content;
            docTexts += `\n\n[附件(OCR)：${a.name}]\n` + truncated;
            const idx = displayAttachments.findIndex(d => d.name === a.name && !d.content);
            if (idx >= 0) displayAttachments[idx].content = truncated;
          } else {
            // Image inline mode: read as base64 data URL for multimodal analysis
            if (isDebugMode()) console.log('[DEBUG] Vision path: reading as base64', a.name);
            if (a._processPromise) {
              try { await a._processPromise; } catch (e) { /* 失败时走原文件兜底 */ }
            }
            const dataUrls = Array.isArray(a.dataUrls) && a.dataUrls.length
              ? a.dataUrls
              : [a.dataUrl || await readFileAsDataURL(a.file)];
            dataUrls.forEach((dataUrl, index) => visionFiles.push({
              dataUrl: dataUrl,
              name: dataUrls.length > 1 ? `${a.name}（第 ${index + 1}/${dataUrls.length} 段）` : a.name,
              type: 'image_url'
            }));
          }
        } else {
          if (isDebugMode()) console.log('[DEBUG] Doc path: uploading', a.name);
          // Document: use file-extract for text/OCR extraction
          const content = await uploadToKimi(a.file, apiCfg);
          const maxLen = 80000;
          const truncated = content.length > maxLen ? content.slice(0, maxLen) + '\n\n[内容过长，已截断...]' : content;
          docTexts += `\n\n[附件：${a.name}]\n` + truncated;
          const idx = displayAttachments.findIndex(d => d.name === a.name && !d.content);
          if (idx >= 0) displayAttachments[idx].content = truncated;
        }
      } else if (isVision) {
        // 视觉模型（deepseek-flash / DeepSeek V4.1 Flash 等）：图片 → 文件引用或 base64 内联；其他文件 → 文本读取
        // 仅按 SHA-256 内容指纹复用历史 file_id；同名文件不代表同一张图。
        if (isImageFile(a.file)) {
          if (isDebugMode()) console.log('[DEBUG] Vision path: inline image', a.name, a.imageInfo || '(未预处理)');
          // 添加附件时就已开始处理（上传或本地转码）：这里直接等它，避免重复解码，也避免"点发送时还没处理完"
          if (a._processPromise) {
            try { await a._processPromise; } catch (e) { /* 失败已在预处理里记录，走下面兜底 */ }
          }
          const reused = findReusableUploadedImage(a, apiCfg);
          if (reused) {
            if (isDebugMode()) console.log('[DEBUG] Vision path: reuse uploaded file', a.name, reused.fileId);
            visionFiles.push({
              type: 'file',
              fileId: reused.fileId,
              uploadKeyId: reused.uploadKeyId,
              imageFingerprint: reused.imageFingerprint,
              name: a.name,
              dataUrl: reused.thumb || '' // 缩略图沿用原消息里的，仅用于界面回显
            });
          } else if (a.uploadFileId) {
            if (isDebugMode()) console.log('[DEBUG] Vision path: uploaded now', a.name, a.uploadFileId);
            visionFiles.push({
              type: 'file',
              fileId: a.uploadFileId,
              uploadKeyId: a.uploadKeyId || apiCfg.keyId || '',
              imageFingerprint: a.imageFingerprint || '',
              name: a.name,
              dataUrl: a.dataUrl || ''
            });
          } else {
            let dataUrls = Array.isArray(a.dataUrls) && a.dataUrls.length ? a.dataUrls : null;
            if (!dataUrls) {
              // 附件是在切到视觉模型前添加的（那时没预处理）→ 现场补一次，仍失败则退回原文件
              try {
                const split = await splitTallImageForApi(a.file);
                if (split) {
                  dataUrls = split.dataUrls;
                  a.imageInfo = split.info;
                } else {
                  const processed = await downscaleImageForApi(a.file);
                  dataUrls = [processed.dataUrl];
                  a.file = processed.file;
                  a.imageInfo = processed.info;
                }
              } catch (e) {
                dataUrls = [await readFileAsDataURL(a.file)];
              }
            }
            if (a._preprocessError) {
              docTexts += `\n\n[附件：${a.name} — 图片本地转换失败（${a._preprocessError}），已按原文件内联发送]`;
            }
            a.dataUrls = dataUrls;
            a.dataUrl = dataUrls[0] || ''; // 首段用于缩略图；完整分段用于模型输入
            dataUrls.forEach((dataUrl, index) => visionFiles.push({
              dataUrl: dataUrl,
              name: dataUrls.length > 1 ? `${a.name}（第 ${index + 1}/${dataUrls.length} 段）` : a.name,
              type: 'image_url'
            }));
          }
        } else if (isVideoFile(a.file)) {
          // 视觉模型不支持视频内联，提示跳过
          docTexts += `\n\n[附件：${a.name} — 当前模型不支持视频分析]`;
        } else {
          // 非图片文件按文本读取
          const content = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsText(a.file);
          });
          const maxLen = 8000;
          const truncated = content.length > maxLen ? content.slice(0, maxLen) + '\n\n[内容过长，已截断...]' : content;
          docTexts += `\n\n[附件：${a.name}]\n` + truncated;
          const idx = displayAttachments.findIndex(d => d.name === a.name && !d.content);
          if (idx >= 0) displayAttachments[idx].content = truncated;
        }
      } else {
        // Read .txt files as text content
        const content = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = e => resolve(e.target.result);
          reader.onerror = reject;
          reader.readAsText(a.file);
        });
        const maxLen = 8000;
        const truncated = content.length > maxLen ? content.slice(0, maxLen) + '\n\n[内容过长，已截断...]' : content;
        docTexts += `\n\n[附件：${a.name}]\n` + truncated;
        const idx = displayAttachments.findIndex(d => d.name === a.name && !d.content);
        if (idx >= 0) displayAttachments[idx].content = truncated;
      }
    } catch (err) {
      docTexts += `\n\n[附件：${a.name} — 读取失败: ${err.message}]`;
    }
  }

  // 图片附件的展示图：Files API 路径下 attach.dataUrl 是本地生成的小缩略图（原图只在服务端）
  for (const d of displayAttachments) {
    if (d.displayUrl) continue;
    const attached = currentAttachments.find(a => a.name === d.name && a.dataUrl);
    if (attached) d.displayUrl = attached.dataUrl;
  }

  // Build user message content
  const userContent = text + docTexts;

  if (isDebugMode()) console.log('[DEBUG sendAiMessage] docTexts:', docTexts.slice(0,200), 'visionFiles:', JSON.stringify(visionFiles));

  const now = new Date();
  const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const userMsg = { role: 'user', content: userContent, time: timeStr };
  if (contextInserts.length > 0) {
    userMsg.contextInserts = contextInserts;
    userMsg.displayContent = displayContent;
  }
  if (displayAttachments.length > 0) {
    userMsg.attachments = displayAttachments;
  }
  // Store vision file refs for multimodal API calls (ms://<file-id>)
  if (visionFiles.length > 0) {
    userMsg.visionFiles = visionFiles;
  }
  // 记录待生成标记（刷新/重启后据此自动恢复被中断的 AI 回复）
  const _pendingUserNodeId = appendMessage(conv, userMsg);
  safeSaveAiConvs();
  if (_pendingUserNodeId) {
    setAiPendingRequest(conv.id, _pendingUserNodeId, apiCfg.keyId);
  }

  // AI Auto-title — regenerate after every exchange
  const shouldAutoTitle = conv.messages.filter(m => m.role === 'user').length >= 1;

  if (conv.title.startsWith('新对话 ') && conv.messages.filter(m => m.role === 'user').length === 1) {
    conv.title = text ? (text.length > 20 ? text.slice(0, 20) + '…' : text) : '附件对话';
    safeSaveAiConvs();
    if (getActiveConvId() === conv.id) renderAiChat();
  }
  // 发送后滚动交由 renderAiMessages 智能处理：用户接近底部才滚到底，否则保持浏览位置
  renderAiMessages();
  updateAiSendButton();

  // Debug
  const deepThinkParams = buildDeepThinkParams(apiCfg);
  console.log('[API] model:', apiCfg.model, 'deepThink:', apiCfg.deepThink, 'deepThinkParams:', JSON.stringify(deepThinkParams));

  let aiReplyText = null; // 最终回复文本（供调用方回填等使用）
  try {
    const streamingKeyName = (apiCfg.name || apiCfg.model || 'AI');
    const loopRes = await runToolCallLoop(apiCfg, conv, null, snapshot => {
      if (snapshot.reset) {
        clearAiStreamingDraft(conv.id);
        return;
      }
      setAiStreamingDraft(conv.id, {
        content: snapshot.content,
        reasoning: snapshot.reasoning,
        keyName: streamingKeyName
      });
    });
    let finalCleanText = loopRes.finalCleanText;
    const finalRawReply = loopRes.finalRawReply;
    const finalReasoning = loopRes.finalReasoning;
    clearAiStreamingDraft(conv.id, false);
    if (loopRes.stopped) {
      finalCleanText = finalCleanText && finalCleanText !== '⏹️ 已手动停止。'
        ? finalCleanText.replace(/\s+$/, '') + '\n\n> ⏹️ 已停止生成，以上为已收到的内容。'
        : '⏹️ 已手动停止。';
    } else if (loopRes.streamError) {
      finalCleanText = (finalCleanText || '（未收到完整回复）').replace(/\s+$/, '')
        + '\n\n> ⚠️ 流式连接中断：' + loopRes.streamError;
    }
    aiReplyText = finalCleanText || null;
    // max_tokens 截断（finish_reason='length'）→ 自动续写一次，让回复完整
    if (!loopRes.stopped && !loopRes.streamError && loopRes.finishReason === 'length') {
      const more = (typeof continueTruncatedReply === 'function') ? await continueTruncatedReply(apiCfg, conv, finalCleanText) : '';
      if (more) finalCleanText = (finalCleanText || '').replace(/\s+$/, '') + '\n' + more;
      else finalCleanText += '\n\n⚠️（回复因长度限制被截断，可调大 Max Tokens 或发送「继续」）';
      aiReplyText = finalCleanText;
    }

    // Build the final assistant message
    const keyName = (apiCfg.name || apiCfg.model || 'AI');
    const finalAssistantMsg = { role: 'assistant', content: finalCleanText, time: timeStr, keyName };
    if (finalReasoning) finalAssistantMsg.reasoning = finalReasoning;
    appendMessage(conv, finalAssistantMsg);
    safeSaveAiConvs();
    sendAiNotification(conv, finalCleanText, keyName);

    // ── Parse <memory> tags from AI raw response ──
    // Use finalRawReply (the original AI reply before <memory> stripping)
    if (typeof parseMemoryTags === 'function') {
      parseMemoryTags(finalRawReply || finalCleanText, conv.id, conv.title);
    }

    // ═══ call_ai queue: check if the AI requested another AI to respond ═══
    // (For simplicity, the call_ai chain is still pushed as a separate message after the candidate.)
    const callAiMatch = finalCleanText.match(/<call_ai>\s*({[\s\S]*?})\s*<\/call_ai>/);
    if (callAiMatch && !loopRes.stopped && !loopRes.streamError && !isAiStopRequested(conv.id)) {
      try {
        const callAiParams = JSON.parse(callAiMatch[1]);
        const errMsg = await executeCallAiAndPush(callAiParams, conv);
        if (errMsg) {
          appendMessage(conv, { role: 'assistant', content: errMsg, time: timeStr, keyName: (apiCfg.name || apiCfg.model || 'AI') });
          safeSaveAiConvs();
          sendAiNotification(conv, errMsg, (apiCfg.name || apiCfg.model || 'AI'));
        }
        renderAiMessages();
      } catch (e) {
        console.warn('[call_ai] parse/exec error:', e);
      }
    }
  } catch (err) {
    clearAiStreamingDraft(conv.id, false);
    const errorMsg = formatAiRequestError(err);
    const errMsg = { role: 'assistant', content: errorMsg, time: timeStr, keyName: (apiCfg.name || apiCfg.model || 'AI') };
    appendMessage(conv, errMsg);
    safeSaveAiConvs();
    sendAiNotification(conv, errorMsg, (apiCfg.name || apiCfg.model || 'AI'));
  }

  // Always reset loading state for this conversation
  setAiLoading(conv.id, false);
  setAiStopRequested(conv.id, false);
  clearAiStreamingDraft(conv.id, false);
  // 已生成/已停止/已失败：清除待生成标记（避免下次启动误判为"被中断"）
  clearAiPendingRequest(conv.id);
  renderAiMessages();
  updateAiSendButton();

  // 队列系统：回复完成后自动发送下一条排队消息
  if (typeof drainAiSendQueue === 'function') drainAiSendQueue(conv.id);

  // AI Auto-title: trigger after first AI reply is pushed to conversation
  if (shouldAutoTitle && typeof isAutoTitleEnabled === 'function' && isAutoTitleEnabled()) {
    generateConvTitle(conv);
  }

  return aiReplyText;
}

// ═══════════ 树状对话：候选分支导航 ═══════════
// 数据模型：一个 user 节点的多个 child 分支 = 多个候选回复。
// 切换候选 = 在 user 节点的 children 间切换活跃路径（switchBranch）。
// navigateCandidateBranch(userNodeId, delta)：在兄弟分支间循环切换。
// 切换候选分支：在同一父节点的兄弟间循环切换。
// - 传 assistant 节点 → 切换"同一问题重新生成"的候选（user 下的 assistant 兄弟）
// - 传 user 节点 → 切换"编辑产生"的版本（assistant 父下的 user 兄弟）
// （原版通用逻辑，未改底层语义）
function navigateCandidateBranch(userNodeId, delta) {
  const conv = getActiveConv();
  if (!conv || isAiLoading(conv.id) || !isTreeConv(conv) || !conv.tree[userNodeId]) return;
  const siblings = siblingNodeIds(conv, userNodeId);
  if (siblings.length === 0) return;
  const n = siblings.length + 1; // 含自己
  const curIdx = siblings.indexOf(userNodeId);
  const newIdx = (curIdx + delta + n) % n;
  const targetId = newIdx === curIdx ? userNodeId : siblings[newIdx];
  switchBranch(conv, targetId);
  safeSaveAiConvs();
  renderAiMessages();
}

// "采用本条"：树模式下当前活跃分支即被采用（无需额外动作），
// 仅作向后兼容占位，确保渲染按钮 onclick 不报错。
function adoptCandidate(userNodeId) {
  const conv = getActiveConv();
  if (!conv) return;
  safeSaveAiConvs();
  renderAiMessages();
}

// 旧函数名占位（树模式下无需"取消采用"）
function unadoptCandidate() {
  const conv = getActiveConv();
  if (!conv) return;
  safeSaveAiConvs();
  renderAiMessages();
}

async function regenerateAiMessage(nodeId) {
  const conv = getActiveConv();
  if (!conv || isAiLoading(conv.id)) return;
  ensureTree(conv); // 防御：确保 conv 已迁移为树

  // 树模式：在指定节点（user 或 assistant）下生成新分支。
  // 若传入 assistant 节点，向上找到最近的 user 节点作为分叉点。
  let userNodeId = nodeId;
  if (conv.tree[nodeId]) {
    const node = conv.tree[nodeId];
    if (node.role === 'assistant') {
      let cur = nodeId;
      while (cur && conv.tree[cur]) {
        const n = conv.tree[cur];
        if (n.role === 'user') { userNodeId = cur; break; }
        cur = n.parentId;
      }
    }
  }
  if (!isTreeConv(conv) || !conv.tree[userNodeId] || conv.tree[userNodeId].role !== 'user') return;

  await regenerateFromUserNode(conv, userNodeId);
}

// 核心：从指定 user 节点重新生成回复（在其下新建分支）。
// 被 regenerateAiMessage（换一条）与 sendEditedMessage（编辑后发送）复用。
async function regenerateFromUserNode(conv, userNodeId, config) {
  if (!conv || !conv.tree[userNodeId] || conv.tree[userNodeId].role !== 'user') return;
  if (isAiLoading(conv.id)) return;
  const apiCfg = { ...(config || getEffectiveApiConfig()) };
  if (!apiCfg.apiKey) return;

  // 切换到该 user 节点，使 runToolCallLoop 的 appendMessage 落在其下，自动形成新分支
  switchBranch(conv, userNodeId);
  setAiLoading(conv.id, true);
  updateAiSendButton();
  // 重新生成同样记录待生成标记（刷新中断后自动续传）
  setAiPendingRequest(conv.id, userNodeId, apiCfg.keyId);

  try {
    const streamingKeyName = (apiCfg.name || apiCfg.model || 'AI');
    const loopRes = await runToolCallLoop(apiCfg, conv, null, snapshot => {
      if (snapshot.reset) clearAiStreamingDraft(conv.id);
      else setAiStreamingDraft(conv.id, { content: snapshot.content, reasoning: snapshot.reasoning, keyName: streamingKeyName });
    });
    let finalCleanText = loopRes.finalCleanText;
    const finalRawReply = loopRes.finalRawReply;
    const finalReasoning = loopRes.finalReasoning;
    clearAiStreamingDraft(conv.id, false);
    if (loopRes.stopped) {
      finalCleanText = finalCleanText && finalCleanText !== '⏹️ 已手动停止。'
        ? finalCleanText.replace(/\s+$/, '') + '\n\n> ⏹️ 已停止生成，以上为已收到的内容。'
        : '⏹️ 已手动停止。';
    } else if (loopRes.streamError) {
      finalCleanText = (finalCleanText || '（未收到完整回复）').replace(/\s+$/, '')
        + '\n\n> ⚠️ 流式连接中断：' + loopRes.streamError;
    }
    // max_tokens 截断（finish_reason='length'）→ 自动续写一次，让回复完整
    if (!loopRes.stopped && !loopRes.streamError && loopRes.finishReason === 'length') {
      const more = (typeof continueTruncatedReply === 'function') ? await continueTruncatedReply(apiCfg, conv, finalCleanText) : '';
      if (more) finalCleanText = (finalCleanText || '').replace(/\s+$/, '') + '\n' + more;
      else finalCleanText += '\n\n⚠️（回复因长度限制被截断，可调大 Max Tokens 或发送「继续」）';
    }

    // The loop stores intermediate tool messages; the caller owns the final reply.
    const keyName = apiCfg.name || apiCfg.model || 'AI';
    const timeStr = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const finalAssistantMsg = { role: 'assistant', content: finalCleanText || '（未收到回复）', time: timeStr, keyName };
    if (finalReasoning) finalAssistantMsg.reasoning = finalReasoning;
    appendMessage(conv, finalAssistantMsg);
    safeSaveAiConvs();
    sendAiNotification(conv, finalCleanText, (apiCfg.name || apiCfg.model || 'AI'));

    // Parse <memory> tags (only from the most recent reply)
    if (typeof parseMemoryTags === 'function') {
      parseMemoryTags(finalRawReply || finalCleanText, conv.id, conv.title);
    }
  } catch (err) {
    clearAiStreamingDraft(conv.id, false);
    const errorMsg = formatAiRequestError(err);
    const errMsg = { role: 'assistant', content: errorMsg, time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), keyName: (apiCfg.name || apiCfg.model || 'AI') };
    appendMessage(conv, errMsg);
    safeSaveAiConvs();
    sendAiNotification(conv, errorMsg, (apiCfg.name || apiCfg.model || 'AI'));
  }

  setAiLoading(conv.id, false);
  setAiStopRequested(conv.id, false);
  clearAiStreamingDraft(conv.id, false);
  clearAiPendingRequest(conv.id);
  renderAiMessages();
  updateAiSendButton();
  if (typeof drainAiSendQueue === 'function') drainAiSendQueue(conv.id);
}

// 编辑消息后发送：在原 user 节点父节点下创建「编辑后新 user 分支」，
// 再像重新生成一样在其下生成 AI 回复（👤 b' → 🤖 回复B'）。
async function sendEditedMessage(nodeId, newText) {
  const conv = getActiveConv();
  if (!conv || isAiLoading(conv.id)) return;
  ensureTree(conv);
  const text = (newText || '').trim();
  if (!text) return;

  // 找到目标 user 节点（编辑入口通常传 user 节点 id）
  let userNodeId = nodeId;
  if (conv.tree[nodeId]) {
    const node = conv.tree[nodeId];
    if (node.role === 'assistant') {
      let cur = nodeId;
      while (cur && conv.tree[cur]) {
        const n = conv.tree[cur];
        if (n.role === 'user') { userNodeId = cur; break; }
        cur = n.parentId;
      }
    }
  }
  if (!isTreeConv(conv) || !conv.tree[userNodeId] || conv.tree[userNodeId].role !== 'user') return;

  // 内容没有变化时不创建“看不出区别”的 user 分支。旧行为会显示 1/2，
  // 并把其中一条回复藏在另一版本下，用户会误以为聊天记录丢失。
  if (text === String(conv.tree[userNodeId].content || '').trim()) {
    if (typeof showAiToast === 'function') showAiToast('内容没有变化，未创建新分支');
    return null;
  }

  // 创建编辑后的新 user 分支（与原文并列），并切换过去
  const newUserId = createBranchFromEdit(conv, userNodeId, text, { time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) });
  if (newUserId === null) return;
  safeSaveAiConvs();

  // 在其下重新生成回复（类似重新生成）
  await regenerateFromUserNode(conv, newUserId);
}

// ═══════════ AI Toolbar (Key select + Toggles + Quick actions) ═══════════
function initAiToolbar() {
  const select = document.getElementById('aiToolbarKeySelect');
  if (!select) return;
  const keys = loadApiKeys();
  const activeId = getActiveApiKeyId();
  select.innerHTML = keys.map(k =>
    `<option value="${k.id}" ${k.id === activeId ? 'selected' : ''}>${escapeHtml(k.name)}</option>`
  ).join('');
  if (keys.length === 0) {
    select.innerHTML = '<option value="">未配置 Key</option>';
  }

  // Restore deep think toggle state
  const dtBtn = document.getElementById('aiToolbarDeepThinkBtn');
  if (dtBtn) {
    const activeKey = keys.find(k => k.id === activeId);
    dtBtn.classList.toggle('active', activeKey?.deepThink === true);
  }

  // Restore web search toggle state (per-conversation)
  const wsBtn = document.getElementById('aiToolbarWebSearchBtn');
  if (wsBtn) {
    const conv = getActiveConv();
    const isKimi = typeof isKimiModel === 'function' && isKimiModel();
    if (isKimi && conv) {
      updateWebSearchBtn(wsBtn, conv._webSearchMode || null);
    } else {
      wsBtn.classList.toggle('active', conv?._webSearchEnabled === true);
      // Reset button text for non-Kimi
      const span = wsBtn.querySelector('span');
      if (span) span.textContent = '智能搜索';
      wsBtn.title = '联网搜索';
      wsBtn.classList.remove('kimi-native', 'kimi-external');
    }
  }

  // 图片上传方式（auto / always / never）
  updateAiImageUploadBtn();

  // Reset quick action dropdown
  const quickSelect = document.getElementById('aiToolbarQuick');
  if (quickSelect) quickSelect.value = '';
  // Re-render Lucide icons (the toolbar was just created/updated in DOM)
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}

// ═══════════ 图片上传方式：内联 base64 ↔ DeepSeek Files API ═══════════
// auto  ：小图内联，大图（>1 MiB）上传后按 file_id 引用（默认）
// always：图片一律先上传，后续轮次不再重复传图（最省请求体）
// never ：一律内联 base64（图片不出现在服务端文件列表里）
function updateAiImageUploadBtn() {
  const btn = document.getElementById('aiToolbarImageUploadBtn');
  if (!btn) return;
  const mode = (typeof getAiImageUploadMode === 'function') ? getAiImageUploadMode() : 'auto';
  const apiCfg = getEffectiveApiConfig();
  const available = (typeof supportsDeepSeekFilesApi === 'function') && supportsDeepSeekFilesApi(apiCfg);
  const span = btn.querySelector('span');
  const label = mode === 'never' ? '仅内联' : (mode === 'always' ? '全部上传' : '自动上传');
  if (span) span.textContent = label;
  btn.classList.toggle('active', mode !== 'never' && available);
  btn.title = available
    ? `图片上传方式：${label}\n点击切换（自动上传 → 全部上传 → 仅内联）\n上传后同一张图在后续轮次只发送 file_id，不再重复传图`
    : `图片上传方式：${label}\n当前 Key（${apiCfg.model || '未配置'}）不是 DeepSeek 官方端点，无法使用 Files API，图片将内联(base64)发送`;
}

function cycleAiImageUploadMode() {
  const current = (typeof getAiImageUploadMode === 'function') ? getAiImageUploadMode() : 'auto';
  const next = current === 'auto' ? 'always' : (current === 'always' ? 'never' : 'auto');
  if (typeof setAiImageUploadMode === 'function') setAiImageUploadMode(next);
  updateAiImageUploadBtn();
}

function onAiToolbarKeyChange() {
  const select = document.getElementById('aiToolbarKeySelect');
  if (!select || !select.value) return;
  switchActiveKey(select.value);
  // Update deep think toggle to match the new key's setting
  const keys = loadApiKeys();
  const key = keys.find(k => k.id === select.value);
  const dtCheckbox = document.getElementById('aiToolbarDeepThink');
  if (dtCheckbox && key) dtCheckbox.checked = key.deepThink === true;
}

function toggleAiDeepThink() {
  const btn = document.getElementById('aiToolbarDeepThinkBtn');
  if (!btn) return;
  const newState = !btn.classList.contains('active');
  btn.classList.toggle('active', newState);
  const keys = loadApiKeys();
  const activeId = getActiveApiKeyId();
  const key = keys.find(k => k.id === activeId);
  if (key) {
    key.deepThink = newState;
    saveApiKeys(keys);
  }
}

function toggleAiWebSearch() {
  const btn = document.getElementById('aiToolbarWebSearchBtn');
  if (!btn) return;
  const conv = getActiveConv();
  if (!conv) return;
  const isKimi = typeof isKimiModel === 'function' && isKimiModel();

  if (isKimi) {
    // Kimi: cycle null → 'native' → 'external' → null
    const current = conv._webSearchMode || null;
    let next;
    if (!current) next = 'native';
    else if (current === 'native') next = 'external';
    else next = null;
    conv._webSearchMode = next;
    updateWebSearchBtn(btn, next);
  } else {
    // Non-Kimi: simple on/off
    const newState = !btn.classList.contains('active');
    btn.classList.toggle('active', newState);
    conv._webSearchEnabled = newState;
  }
  safeSaveAiConvs();
}

function updateWebSearchBtn(btn, mode) {
  const span = btn.querySelector('span');
  btn.classList.remove('active', 'kimi-native', 'kimi-external');
  if (mode === 'native') {
    btn.classList.add('active', 'kimi-native');
    btn.title = 'Kimi 原生联网搜索';
    if (span) span.textContent = '原生搜索';
  } else if (mode === 'external') {
    btn.classList.add('active', 'kimi-external');
    btn.title = '外部引擎搜索 (Brave/Tavily)';
    if (span) span.textContent = '外部搜索';
  } else {
    btn.title = '联网搜索';
    if (span) span.textContent = '智能搜索';
  }
}

function onAiToolbarQuickChange() {
  const select = document.getElementById('aiToolbarQuick');
  if (!select || !select.value) return;
  const prompt = select.value;
  select.value = ''; // Reset immediately
  // Put the prompt into the input box (don't send)
  const input = document.getElementById('aiInput');
  if (!input) return;
  input.value = prompt;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  input.focus();
}

// ═══════════ AI Quick Action (legacy, kept for reference) ═══════════
function aiQuickAction(prompt) {
  const input = document.getElementById('aiInput');
  if (!input) return;
  const apiCfg = getEffectiveApiConfig();
  if (!apiCfg.apiKey) { openSettingsModal(); return; }
  input.value = prompt;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  input.focus();
  // Auto-send the quick action
  sendAiMessage();
}

// ═══════════ AI: Navigate to Todo from Chat ═══════════
function aiNavigateToTodo(todoId) {
  const t = findTodo(todoId);
  if (!t) return;
  document.getElementById('todoSearch').value = '';
  todoSearchQuery = '';
  const searchClear = document.getElementById('searchClear');
  if (searchClear) searchClear.classList.remove('visible');
  currentTodoRoot = t.parentId;
  activeSubInputId = null;
  switchTab('todo');
  renderTodos();
}

// ═══════════ AI: Toggle Todo from Chat ═══════════
function aiToggleTodo(todoId) {
  const t = findTodo(todoId);
  if (!t) return;
  t.done = !t.done;
  if (t.done) {
    t.completedAt = formatDate(new Date());
    const descendantIds = getAllDescendantIds(todoId).filter(did => did !== todoId);
    for (const did of descendantIds) {
      const d = findTodo(did);
      if (d) { d.done = true; if (!d.completedAt) d.completedAt = formatDate(new Date()); }
    }
  } else {
    // 取消勾选时清除完成时间（与 UI 的 toggleTodo 保持一致）
    delete t.completedAt;
  }
  saveData('study_todos_v2', todos);
  renderTodos();
  renderToday();
  renderAiMessages();
}

// ═══════════ 刷新/重启后恢复被中断的 AI 回复 ═══════════
// 发送/重新生成时写入 study_ai_pending { convId, userNodeId }，完成/停止/失败后清除。
// 若刷新打断（fetch 中断、loading 状态丢失），启动时检测到该标记且对应 user 节点下
// 还没有 assistant 回复，则自动切回该节点重新生成，实现"AI 对话不被打断"。
function getAiPendingRequests() {
  try {
    const stored = JSON.parse(localStorage.getItem('study_ai_pending') || '{}');
    if (stored?.convId) return { [stored.convId]: stored }; // Legacy single request.
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  } catch { return {}; }
}

function setAiPendingRequest(convId, userNodeId, keyId) {
  const requests = getAiPendingRequests();
  requests[convId] = { convId, userNodeId, keyId, at: Date.now() };
  try { localStorage.setItem('study_ai_pending', JSON.stringify(requests)); } catch {}
}

function clearAiPendingRequest(convId) {
  const requests = getAiPendingRequests();
  delete requests[convId];
  try {
    if (Object.keys(requests).length) localStorage.setItem('study_ai_pending', JSON.stringify(requests));
    else localStorage.removeItem('study_ai_pending');
  } catch {}
}

function resumeInterruptedAiReply() {
  for (const pending of Object.values(getAiPendingRequests())) resumePendingAiReply(pending);
}

function resumePendingAiReply(pending) {
  if (!pending || !pending.convId) return;
  clearAiPendingRequest(pending.convId);
  if (typeof aiConvs === 'undefined' || typeof ensureTree !== 'function' || typeof regenerateFromUserNode !== 'function') return;
  const conv = aiConvs.find(c => String(c.id) === String(pending.convId));
  if (!conv) return;
  ensureTree(conv);
  const userNode = conv.tree && conv.tree[pending.userNodeId];
  // 仅当该节点确为 user 且其下尚无 assistant 回复（含工具中间消息）才续传，避免重复消耗 token
  if (!userNode || userNode.role !== 'user') return;
  const kids = userNode.children || [];
  const hasAssistantReply = kids.some(kid => conv.tree[kid] && conv.tree[kid].role === 'assistant');
  if (hasAssistantReply) return;
  setTimeout(() => {
    if (typeof bkShowMiniToast === 'function') bkShowMiniToast('检测到上次 AI 回复被中断，已自动重新生成');
    regenerateFromUserNode(conv, pending.userNodeId, getEffectiveApiConfig(pending.keyId));
  }, 300);
}
if (typeof window._aiResumeInited === 'undefined') {
  window._aiResumeInited = true;
  resumeInterruptedAiReply();
}
