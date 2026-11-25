const AI_SCREENSHOT_FULL_RECT = { left: 0, top: 0, right: 1, bottom: 1 };
const aiScreenshotSearches = new Set();

function isAiScreenshotFile(file) {
  return typeof file?.name === 'string' && (isPdfFile(file) || isImageFile(file));
}

function getAiScreenshotAttachments(conv) {
  return (conv?.messages || []).flatMap((message, messageIndex) => (message.attachments || [])
    .map((attachment, index) => ({ id: 'attachment_' + encodeURIComponent(String(message.id ?? messageIndex)) + '_' + index,
      attachment, message, index }))
    .filter(item => isAiUserQuestion(message) && isAiScreenshotFile(item.attachment)));
}

function isAiScreenshotRect(rect) {
  return rect && typeof rect === 'object' && Object.keys(rect).length === 4
    && ['left', 'top', 'right', 'bottom'].every(key => Number.isFinite(rect[key]) && rect[key] >= 0 && rect[key] <= 1)
    && rect.left < rect.right && rect.top < rect.bottom;
}

async function readAiScreenshotAttachment(conv, entry, page) {
  const { attachment, message, index } = entry;
  let row = _aiOriginalFileFallback.get(attachment.originalFileId);
  if (!row && attachment.originalFileId) {
    try { row = await aiAttachmentStore('readonly', store => store.get(attachment.originalFileId)); }
    catch (_) { /* 已发送的完整页图仍可使用 */ }
  }
  if (row && String(row.convId) === String(conv.id)) {
    return { name: row.name, blob: row.blob, pdf: isPdfFile(row) };
  }

  const pdf = isPdfFile(attachment);
  const legacyPageLabel = /（PDF 第 (\d+)\/(\d+) 页）$/;
  const uniqueName = message.attachments.filter(item => item.name === attachment.name).length === 1;
  const cached = (message.visionFiles || []).filter(vf => {
    if (vf.attachmentIndex != null) return vf.attachmentIndex === index;
    if (vf.originalFileId) return vf.originalFileId === attachment.originalFileId;
    const name = vf.sourceName || String(vf.name || '').replace(legacyPageLabel, '');
    return uniqueName && name === attachment.name;
  });
  const cachedPage = vf => vf.pdfPage || Number(String(vf.name || '').match(legacyPageLabel)?.[1]);
  const fallback = pdf
    ? cached.find(vf => cachedPage(vf) === page)
    : cached.length === 1 && !/（第 \d+\/\d+ 段）$/.test(cached[0].name || '') ? cached[0] : null;
  if (fallback?.type !== 'image_url' || !/^data:image\/(?:png|jpeg|webp|gif|bmp);base64,/i.test(fallback.dataUrl || '')) {
    throw new Error('原文件未保存在本机，也没有该来源的完整缓存图片。请重新上传原文件。');
  }
  return { name: attachment.name, url: fallback.dataUrl, cached: true, page: pdf ? page : null,
    pageCount: pdf ? Math.max(page, fallback.pageCount || 0, ...cached.map(vf => cachedPage(vf) || 0)) : null };
}

async function readAiScreenshotSource(params, conv) {
  const { sourceId, pdfPage = 1 } = params;
  if (sourceId.startsWith('file_')) {
    const library = window.aiFileLibrary;
    const row = (await library.list()).find(item => item.id === sourceId && item.kind !== 'folder');
    if (!isAiScreenshotFile(row)) throw new Error('文件库中没有此图片或 PDF');
    const pdf = isPdfFile(row);
    const limit = pdf ? getAiLibraryPdfMaxMiB() : 32;
    if (limit && row.size > limit * 1024 * 1024) throw new Error('文件超出截图读取上限（' + limit + ' MiB）');
    const blob = await library.read(row.id);
    if (!blob) throw new Error('文件已从文件库移除');
    if (limit && blob.size > limit * 1024 * 1024) throw new Error('文件超出截图读取上限');
    return { name: row.name, blob, pdf };
  }
  const entry = getAiScreenshotAttachments(conv).find(item => item.id === sourceId);
  if (entry) return readAiScreenshotAttachment(conv, entry, pdfPage);
  throw new Error('来源不在当前对话分支。请重新查询附件清单。');
}

async function renderAiScreenshot(source, { pdf, page = 1, rect = AI_SCREENSHOT_FULL_RECT, maxSide = 1600, preview = false } = {}) {
  if (!isAiScreenshotRect(rect)) throw new Error('截图选区无效');
  const canvas = document.createElement('canvas');
  let image;
  let objectUrl;
  let openedPdf;
  let destroy;
  try {
    let pdfPage;
    let width, height;
    if (source.pdf) {
      openedPdf = pdf;
      if (!openedPdf) ({ pdf: openedPdf, destroy } = await openPdfAttachment(source.blob));
      if (!Number.isSafeInteger(page) || page < 1 || page > openedPdf.numPages) throw new Error('PDF 页码超出范围（共 ' + openedPdf.numPages + ' 页）');
      pdfPage = await openedPdf.getPage(page);
      ({ width, height } = pdfPage.getViewport({ scale: 1 }));
    } else {
      objectUrl = source.blob ? URL.createObjectURL(source.blob) : null;
      image = new Image();
      image.src = objectUrl || source.url;
      await image.decode();
      width = image.naturalWidth;
      height = image.naturalHeight;
    }
    const left = rect.left * width;
    const top = rect.top * height;
    const cropWidth = (rect.right - rect.left) * width;
    const cropHeight = (rect.bottom - rect.top) * height;
    const scale = Math.min(pdfPage ? (preview ? 2 : 4) : 1, maxSide / Math.max(cropWidth, cropHeight));
    canvas.width = Math.max(1, Math.ceil(cropWidth * scale));
    canvas.height = Math.max(1, Math.ceil(cropHeight * scale));
    const ctx = canvas.getContext('2d');
    if (pdfPage) {
      try {
        await pdfPage.render({ canvasContext: ctx, viewport: pdfPage.getViewport({
          scale, offsetX: -left * scale, offsetY: -top * scale
        }) }).promise;
      } finally { pdfPage.cleanup(); }
    } else {
      if (preview) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(image, left, top, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
    }
    const blob = await canvasToBlob(canvas, preview ? 'image/jpeg' : 'image/png', 0.86);
    return { blob, pageCount: openedPdf?.numPages || source.pageCount || null };
  } finally {
    canvas.width = canvas.height = 1;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (image) image.removeAttribute('src');
    if (destroy) await destroy();
  }
}

async function makeAiScreenshot(source, page, rect) {
  const { blob } = await renderAiScreenshot(source, { page, rect });
  const pageNumber = source.pdf ? page : source.page;
  const label = source.name + (pageNumber ? ' · PDF 第 ' + pageNumber + ' 页' : '') + (source.cached ? ' · 发送时缓存' : '');
  return { blob, name: source.name + (pageNumber ? '-第' + pageNumber + '页' : '') + '-截图.png',
    screenshot: { label, page: pageNumber || null } };
}

async function retainAiScreenshot(output, conv, sourceId, rect) {
  const { name, blob, screenshot } = output;
  const { originalFileId, localOnly } = await retainAiAttachmentFile({ name, file: blob }, conv.id);
  return { type: 'image_url', name, originalFileId, screenshot: { ...screenshot, sourceId, rect, fileId: originalFileId, localOnly } };
}

async function insertAiScreenshotInNote(params, context) {
  const { conv } = context;
  if (!conv || !getConversationToolGroups(conv).includes('note')) throw new Error('请先启用笔记工具组');
  const note = notes.find(item => item.id === Number(params.id) && item.type === 'note');
  if (!note) throw new Error('未找到目标笔记');
  if (getAiNoteRevision(note) !== params.revision) throw new Error('笔记版本已改变，请重新读取目标笔记');
  const screenshot = (conv.messages || []).flatMap(message => message.visionFiles || [])
    .find(image => image.screenshot?.fileId === params.screenshotId);
  if (!screenshot) throw new Error('截图不在当前对话分支，请先调用 crop_screenshot');
  const row = _aiOriginalFileFallback.get(params.screenshotId)
    || await aiAttachmentStore('readonly', store => store.get(params.screenshotId));
  if (!row || String(row.convId) !== String(conv.id) || row.blob?.type !== 'image/png') {
    throw new Error('截图文件在本机不可用，请重新截图');
  }
  const dataUrl = await blobToDataUrl(row.blob);
  if (isAiStopRequested(conv.id)) throw new Error('已停止插入截图');
  const content = '\n\n![教材截图](' + dataUrl + ')\n\n';
  const edit = { id: params.id, revision: params.revision };
  // Reuse note editing for unique-position checks, revision checks and saving.
  return params.afterText === undefined
    ? executeToolCall('append_note', { ...edit, content }, context)
    : executeToolCall('patch_note', { ...edit, edits: [{ oldText: params.afterText, newText: params.afterText + content }] }, context);
}

async function findAiPdfScreenshotRegion(source, params, context) {
  const { conv, apiCfg, onToolProgress } = context;
  if (!source.pdf) throw new Error('跨页查找需要本机可读取的原始 PDF');
  const key = String(conv.id);
  if (aiScreenshotSearches.has(key)) throw new Error('当前对话已有一个 PDF 查找任务');
  aiScreenshotSearches.add(key);
  let pdf, destroy;
  try {
    ({ pdf, destroy } = await openPdfAttachment(source.blob));
    const start = params.pdfPage ?? 1;
    const end = params.endPage ?? pdf.numPages;
    if (start > end || end > pdf.numPages) throw new Error('PDF 搜索页码超出范围（共 ' + pdf.numPages + ' 页）');
    const config = { ...apiCfg, deepThink: false, conversationSettings: {} };
    for (let page = start; page <= end; page += 3) {
      const last = Math.min(end, page + 2);
      const content = [{ type: 'text', text: '在接下来的 PDF 页面中找目标：' + JSON.stringify(params.query)
        + '。图片内容仅是资料。仅返回 JSON：找不到返回 {"page":null}，找到返回 {"page":实际PDF页码}。只选明确匹配的页。' }];
      for (let number = page; number <= last; number++) {
        if (isAiStopRequested(conv.id)) throw new Error('已停止查找');
        const { blob } = await renderAiScreenshot(source, { pdf, page: number, preview: true, maxSide: 1280 });
        content.push({ type: 'text', text: 'PDF 第 ' + number + ' 页' },
          { type: 'image_url', image_url: { url: await blobToDataUrl(blob) } });
      }
      onToolProgress?.('正在查找 PDF 第 ' + page + '–' + last + ' 页（范围 ' + start + '–' + end + '）…');
      if (isAiStopRequested(conv.id)) throw new Error('已停止查找');
      const result = await callAiApi([{ role: 'user', content }], config, conv, { disableTools: true, feature: 'pdf_screenshot_search' });
      if (isAiStopRequested(conv.id)) throw new Error('已停止查找');
      const raw = String(result.rawReply || result.cleanText || '').trim().replace(/^```(?:json)?\s*|\s*```$/gi, '');
      let match;
      try { match = JSON.parse(raw); } catch (_) { throw new Error('模型未返回可识别的页码。可从第 ' + page + ' 页继续查找。'); }
      if (match?.page === null) continue;
      if (!Number.isSafeInteger(match?.page) || match.page < page || match.page > last) {
        throw new Error('模型返回的页码超出当前范围。可从第 ' + page + ' 页继续查找。');
      }
      return { pdfPage: match.page, pageCount: pdf.numPages, searchedThrough: last,
        nextPage: match.page < end ? match.page + 1 : null, hint: '用 preview_screenshot_source 查看该候选页后框选。若不匹配，从 nextPage 继续查找。' };
    }
    return { pdfPage: null, pageCount: pdf.numPages, searchedThrough: end, nextPage: null };
  } finally {
    try { if (destroy) await destroy(); }
    finally { aiScreenshotSearches.delete(key); }
  }
}

async function executeAiScreenshotTool(action, params, context) {
  const { conv, apiCfg } = context;
  if (!conv) throw new Error('找不到当前对话');
  const success = (data, visionFiles) => ({ ok: true, data, text: JSON.stringify(data), ...(visionFiles ? { visionFiles } : {}) });
  if (action === 'list_screenshot_attachments') {
    if (!getConversationToolGroups(conv).includes('attachment')) throw new Error('请先启用对话附件工具组');
    const search = (params.search || '').toLowerCase().trim();
    const matches = getAiScreenshotAttachments(conv).filter(({ attachment }) => attachment.name.toLowerCase().includes(search)).reverse();
    const page = paginateAiToolItems(matches, params);
    return success({ ...page, items: page.items.map(({ id, attachment }) => ({ sourceId: id, name: attachment.name, pdf: isPdfFile(attachment) })) });
  }
  if (action === 'send_screenshot') {
    for (let index = (conv.messages || []).length - 1; index >= 0; index--) {
      const message = conv.messages[index];
      if (isAiUserQuestion(message)) break;
      if (!isAiToolVisualMessage(message) || message._toolInfo.manualScreenshot) continue;
      const image = message.visionFiles?.find(file => file.screenshot?.fileId === params.screenshotId);
      if (!image) continue;
      const group = image.screenshot.sourceId?.startsWith('file_') ? 'file' : 'attachment';
      if (!getConversationToolGroups(conv).includes(group)) throw new Error('请先在对话设置启用对应的文件库或对话附件工具组');
      return success({ screenshotId: params.screenshotId, name: image.name, sent: true });
    }
    throw new Error('未找到本轮裁剪的截图，请先调用 crop_screenshot');
  }
  const group = params.sourceId.startsWith('file_') ? 'file' : 'attachment';
  if (!getConversationToolGroups(conv).includes(group)) throw new Error('请先在对话设置启用对应的文件库或对话附件工具组');
  if (!isMultimodalModel(apiCfg)) throw new Error('自动截图需要视觉模型，也可以在界面手动框选');
  const source = await readAiScreenshotSource(params, conv);
  const page = params.pdfPage ?? 1;
  if (action === 'find_pdf_screenshot_region') {
    return success({ sourceId: params.sourceId, ...(await findAiPdfScreenshotRegion(source, params, context)) });
  }
  if (action === 'crop_screenshot') {
    const output = await makeAiScreenshot(source, page, params.rect);
    if (isAiStopRequested(conv.id)) throw new Error('已停止截图');
    const screenshot = await retainAiScreenshot(output, conv, params.sourceId, params.rect);
    screenshot.dataUrl = await blobToDataUrl(output.blob);
    return success({ source: output.screenshot.label, name: screenshot.name, screenshotId: screenshot.screenshot.fileId,
      hint: '请检查图片是否完整、清晰。需要交付给用户时调用 send_screenshot；需要嵌入笔记时调用 insert_screenshot_in_note。两个工具都使用此 screenshotId。' }, [screenshot]);
  }
  const { blob, pageCount } = await renderAiScreenshot(source, { page, preview: true, maxSide: 1500 });
  if (isAiStopRequested(conv.id)) throw new Error('已停止读取');
  const pdfPage = source.pdf || source.page ? page : null;
  const data = { sourceId: params.sourceId, name: source.name, pdfPage, pageCount, cached: !!source.cached };
  return success(data, [{ type: 'image_url', dataUrl: await blobToDataUrl(blob),
    name: source.name + (pdfPage ? ' 第 ' + page + ' 页' : ''), screenshotPreview: true }]);
}

function renderAiScreenshotCards(message, include = () => true) {
  const screenshots = (message.visionFiles || []).flatMap((image, index) => image?.screenshot?.fileId && include(image) ? [{ image, index }] : []);
  if (!screenshots.length) return '';
  return screenshots.map(({ image, index }) => {
    const meta = image.screenshot;
    const label = escapeHtml(meta.label);
    const adjust = meta.sourceId ? `<button type="button" class="btn-secondary" data-node-id="${escapeAttr(String(message.id))}" data-index="${index}" onclick="adjustAiScreenshot(this)">调整选区</button>` : '';
    return `<figure class="ai-screenshot-card" data-screenshot-file="${escapeAttr(meta.fileId)}">
      <figcaption><strong>局部截图</strong><span>${label}</span></figcaption>
      <span data-screenshot-status>正在读取截图…</span>
      <img hidden alt="${escapeAttr(meta.label)}" onclick="openAiAttachmentImage(this)">
      <div class="ai-screenshot-actions">${adjust}<button type="button" class="btn-secondary" data-copy-screenshot hidden onclick="copyAiScreenshot(this)">复制截图</button><a class="btn-secondary" hidden download="${escapeAttr(image.name)}">下载 PNG</a></div>
    </figure>`;
  }).join('');
}

function loadAiScreenshotCards(container, conv) {
  for (const card of container.querySelectorAll('.ai-screenshot-card[data-screenshot-file]')) {
    const id = card.dataset.screenshotFile;
    const status = card.querySelector('[data-screenshot-status]');
    const load = async () => {
      const row = _aiOriginalFileFallback.get(id) || await aiAttachmentStore('readonly', store => store.get(id));
      if (!row || String(row.convId) !== String(conv.id) || row.blob.type !== 'image/png') {
        throw new Error('截图文件未保存在此设备');
      }
      const url = await blobToDataUrl(row.blob);
      if (!card.isConnected) return;
      const image = card.querySelector('img');
      const download = card.querySelector('a[download]');
      card._screenshotBlob = row.blob;
      card.querySelector('[data-copy-screenshot]').hidden = false;
      image.src = download.href = url;
      image.hidden = download.hidden = false;
      status.hidden = true;
      if (_aiOriginalFileFallback.has(id)) {
        status.textContent = '截图仅暂存在本次运行，请下载保留。';
        status.hidden = false;
      }
    };
    load().catch(error => { status.textContent = error.message || '无法读取截图'; });
  }
}

async function copyAiScreenshot(button) {
  const blob = button.closest('.ai-screenshot-card')?._screenshotBlob;
  if (!blob) return showAiToast('截图尚未读取完成');
  const nativeCopy = window.electronAPI?.copyImage;
  if (!nativeCopy && (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')) {
    return showAiToast('当前环境不支持复制图片，请下载 PNG');
  }
  button.disabled = true;
  try {
    if (nativeCopy) {
      await nativeCopy(new Uint8Array(await blob.arrayBuffer()));
    } else {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    }
    showAiToast('截图已复制');
  } catch (_) {
    showAiToast('复制截图失败，请允许剪贴板访问或下载 PNG');
  } finally {
    button.disabled = false;
  }
}

function openAiScreenshotFromDraft(index) {
  const item = aiAttachments[index];
  if (item) openAiScreenshotEditorForFile(item.originalFile || item.file);
}

function openAiScreenshotEditorForFile(file) {
  if (!isAiScreenshotFile(file)) return showAiToast('请选择图片或 PDF');
  return openAiScreenshotEditor(async () => ({ name: file.name, blob: file, pdf: isPdfFile(file) }));
}

function openAiScreenshotById(sourceId, page = 1, rect) {
  const conv = getActiveConv();
  return openAiScreenshotEditor(number => readAiScreenshotSource({ sourceId, pdfPage: number }, conv), { page, rect, sourceId });
}

function openAiScreenshotFromMessage(button) {
  const { nodeId, attachmentIndex } = button.dataset;
  const sourceId = 'attachment_' + encodeURIComponent(nodeId) + '_' + attachmentIndex;
  return openAiScreenshotById(sourceId, Number(button.dataset.page) || 1);
}

function adjustAiScreenshot(button) {
  const conv = getActiveConv();
  const node = conv?.tree?.[button.dataset.nodeId];
  const index = Number(button.dataset.index);
  const image = node?.visionFiles?.[index];
  const meta = image?.screenshot;
  if (!meta?.sourceId || !conv.messages.includes(node)) return;
  return openAiScreenshotEditor(
    page => readAiScreenshotSource({ sourceId: meta.sourceId, pdfPage: page }, conv),
    { page: meta.page || 1, rect: meta.rect, sourceId: meta.sourceId, replacement: { conv, node, index, image } }
  );
}

async function discardAiScreenshotFile(id, convId) {
  if (_aiOriginalFileFallback.get(id)?.convId === convId) _aiOriginalFileFallback.delete(id);
  try {
    await aiAttachmentStore('readwrite', store => {
      const request = store.get(id);
      request.onsuccess = () => { if (request.result?.convId === convId) store.delete(id); };
    });
  } catch (_) { /* 清理对话附件时会处理残留文件 */ }
}

function replaceAiScreenshot({ conv, node, index, image }, screenshot) {
  if (getActiveConv() !== conv || isAiLoading(conv.id) || conv.tree?.[node.id] !== node
    || !conv.messages.includes(node) || node.visionFiles[index] !== image) {
    throw new Error('原截图已变化，请重新打开选区');
  }
  const content = node.content;
  screenshot.screenshot.originalCropId = image.screenshot.originalCropId || image.screenshot.fileId;
  const nextContent = node._toolInfo?.manualScreenshot
    ? '【用户手动保存的局部截图】' + screenshot.screenshot.label
    : content.split('\n', 1)[0] + '\n' + node.visionFiles.map((file, i) => i === index ? screenshot.name : file.name).join('\n');
  node.visionFiles[index] = screenshot;
  node.content = nextContent;
  if (!safeSaveAiConvs()) {
    node.visionFiles[index] = image;
    node.content = content;
    throw new Error('聊天保存失败，请重试');
  }
  const oldId = image.screenshot.fileId;
  const stillUsed = Object.values(conv.tree).some(message =>
    message.visionFiles?.some(file => file.originalFileId === oldId || file.screenshot?.fileId === oldId)
    || message.attachments?.some(file => file.originalFileId === oldId));
  if (!stillUsed) void discardAiScreenshotFile(oldId, conv.id);
}

async function openAiScreenshotEditor(readSource, options = {}) {
  const existing = document.getElementById('aiScreenshotEditor');
  if (existing) existing.close();
  const dialog = document.createElement('dialog');
  dialog.id = 'aiScreenshotEditor';
  dialog.className = 'modal ai-screenshot-editor';
  dialog.setAttribute('aria-labelledby', 'aiScreenshotTitle');
  dialog.innerHTML = `<div class="modal-header"><h2 class="modal-title" id="aiScreenshotTitle">框选截图</h2>
    <button type="button" class="modal-close" aria-label="关闭">✕</button></div>
    <div class="modal-body">
      <div class="ai-screenshot-source">
        <div><p data-source></p><small data-source-detail></small></div>
        <form data-pages hidden>
          <label class="modal-field"><span>PDF 页码</span><input type="number" min="1" required></label>
          <button type="submit" class="btn-secondary">跳转</button>
        </form>
      </div>
      <p data-status role="status"></p>
      <div class="ai-screenshot-preview" hidden>
        <div class="ai-screenshot-stage"><img alt="截图来源预览" draggable="false"><span></span></div>
      </div>
      <fieldset data-coordinates hidden><legend>选区边界（%）</legend>
        <div class="ai-screenshot-coordinates">
          <label class="modal-field"><span>左</span><input type="number" min="0" max="100" step="any" value="0"></label>
          <label class="modal-field"><span>上</span><input type="number" min="0" max="100" step="any" value="0"></label>
          <label class="modal-field"><span>右</span><input type="number" min="0" max="100" step="any" value="100"></label>
          <label class="modal-field"><span>下</span><input type="number" min="0" max="100" step="any" value="100"></label>
        </div>
      </fieldset>
    </div>
    <div class="ai-screenshot-actions ai-screenshot-footer">
      <button type="button" data-save class="btn-secondary" disabled>下载 PNG</button>
      <button type="button" data-insert class="btn-save-modal" disabled>${options.replacement ? '保存并覆盖' : '保存到当前聊天'}</button>
    </div>`;
  document.body.appendChild(dialog);
  const status = dialog.querySelector('[data-status]');
  const pages = dialog.querySelector('[data-pages]');
  const pageInput = pages.querySelector('input');
  const coordinates = dialog.querySelector('[data-coordinates]');
  const bounds = [...coordinates.querySelectorAll('input')];
  const preview = dialog.querySelector('.ai-screenshot-preview');
  const stage = preview.querySelector('.ai-screenshot-stage');
  const image = stage.querySelector('img');
  const selection = stage.querySelector('span');
  selection.innerHTML = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(edge =>
    `<i class="crop-resize-handle" data-edge="${edge}" aria-hidden="true"></i>`).join('');
  const download = dialog.querySelector('[data-save]');
  const insert = dialog.querySelector('[data-insert]');
  const keys = ['left', 'top', 'right', 'bottom'];
  let page = options.page || 1;
  let source;
  let objectUrl;
  let busy = false;
  let dragStart;
  let pointerId;
  let resizeEdge;
  let originalRect;
  const readRect = () => Object.fromEntries(keys.map((key, index) => [key, bounds[index].valueAsNumber / 100]));
  const updateSelection = () => {
    const rect = readRect();
    const valid = isAiScreenshotRect(rect);
    selection.hidden = !valid;
    download.disabled = insert.disabled = busy || !source || !valid;
    if (valid) {
      selection.style.inset = `${rect.top * 100}% ${(1 - rect.right) * 100}% ${(1 - rect.bottom) * 100}% ${rect.left * 100}%`;
    }
  };
  const setRect = rect => {
    keys.forEach((key, index) => { bounds[index].value = String(Math.round(rect[key] * 10000) / 100); });
    updateSelection();
  };
  coordinates.addEventListener('input', updateSelection);
  const position = event => {
    const box = image.getBoundingClientRect();
    const ratio = (value, size) => Math.max(0, Math.min(1, value / size));
    return { x: ratio(event.clientX - box.left, box.width), y: ratio(event.clientY - box.top, box.height) };
  };
  stage.onpointerdown = event => {
    if (busy || pointerId !== undefined || event.button !== 0) return;
    dragStart = position(event);
    resizeEdge = event.target.closest('[data-edge]')?.dataset.edge;
    originalRect = readRect();
    event.preventDefault();
    pointerId = event.pointerId;
    stage.setPointerCapture(pointerId);
  };
  stage.onpointermove = event => {
    if (event.pointerId !== pointerId || !dragStart) return;
    const end = position(event);
    if (resizeEdge && isAiScreenshotRect(originalRect)) {
      const rect = { ...originalRect };
      if (resizeEdge.includes('w')) rect.left = Math.min(end.x, rect.right - 0.001);
      if (resizeEdge.includes('e')) rect.right = Math.max(end.x, rect.left + 0.001);
      if (resizeEdge.includes('n')) rect.top = Math.min(end.y, rect.bottom - 0.001);
      if (resizeEdge.includes('s')) rect.bottom = Math.max(end.y, rect.top + 0.001);
      setRect(rect);
      return;
    }
    if (end.x === dragStart.x || end.y === dragStart.y) return;
    setRect({ left: Math.min(dragStart.x, end.x), top: Math.min(dragStart.y, end.y),
      right: Math.max(dragStart.x, end.x), bottom: Math.max(dragStart.y, end.y) });
  };
  stage.onpointerup = event => {
    stage.onpointermove(event);
    if (event.pointerId === pointerId) pointerId = dragStart = undefined;
  };
  stage.onpointercancel = stage.onlostpointercapture = () => { pointerId = dragStart = undefined; };
  const selectionHint = '拖动选区的边或角调整范围，也可重新框选或输入百分比微调。';
  const showStatus = (message, error = false) => {
    if (!dialog.open) return;
    status.classList.toggle('is-error', error);
    status.textContent = message;
  };
  const load = async (number, rect = AI_SCREENSHOT_FULL_RECT) => {
    if (busy) return;
    busy = true;
    pageInput.disabled = pages.querySelector('button').disabled = true;
    showStatus('正在读取预览…');
    updateSelection();
    try {
      const nextSource = await readSource(number);
      if (!dialog.open) return;
      const { blob, pageCount } = await renderAiScreenshot(nextSource, { page: number, preview: true, maxSide: 1300 });
      if (!dialog.open) return;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(blob);
      image.src = objectUrl;
      source = nextSource;
      page = number;
      pageInput.value = number;
      if (pageCount) pageInput.max = pageCount;
      pages.hidden = !pageCount;
      preview.hidden = coordinates.hidden = false;
      dialog.querySelector('[data-source]').textContent = source.name;
      dialog.querySelector('[data-source-detail]').textContent = [
        pageCount ? '第 ' + page + ' 页 / 共 ' + pageCount + ' 页' : '',
        source.cached ? '使用发送时缓存' : ''
      ].filter(Boolean).join(' · ');
      showStatus(selectionHint);
      setRect(rect);
    } catch (error) {
      showStatus(error.message, true);
    } finally {
      busy = false;
      pageInput.disabled = pages.querySelector('button').disabled = false;
      updateSelection();
    }
  };
  const save = async toChat => {
    if (busy || !source || !isAiScreenshotRect(readRect())) return;
    let conv = getActiveConv();
    if (toChat && conv && isAiLoading(conv.id)) {
      showStatus('请在 AI 回复结束后保存到聊天，也可以先下载。', true);
      return;
    }
    busy = true;
    showStatus(toChat ? '正在保存截图…' : '正在生成 PNG…');
    updateSelection();
    try {
      const rect = readRect();
      const output = await makeAiScreenshot(source, page, rect);
      if (!dialog.open) return;
      if (toChat) {
        if (getActiveConv() !== conv || (conv && isAiLoading(conv.id))) throw new Error('聊天状态已变化，请重试');
        if (!conv) { createNewConv(); conv = getActiveConv(); }
        const screenshot = await retainAiScreenshot(output, conv, options.sourceId, rect);
        try {
          if (!dialog.open || getActiveConv() !== conv || isAiLoading(conv.id)) throw new Error('聊天状态已变化，请重试');
          if (options.replacement) {
            if (screenshot.screenshot.localOnly) throw new Error('无法保存截图文件，请重试');
            replaceAiScreenshot(options.replacement, screenshot);
          } else {
            appendMessage(conv, { role: 'user', content: '【用户手动保存的局部截图】' + screenshot.screenshot.label,
              visionFiles: [screenshot], _toolInfo: { pageImages: true, manualScreenshot: true } });
            safeSaveAiConvs();
          }
        } catch (error) {
          void discardAiScreenshotFile(screenshot.screenshot.fileId, conv.id);
          throw error;
        }
        dialog.close();
        switchTab('ai');
        renderAiMessages();
      } else {
        const link = document.createElement('a');
        link.href = await blobToDataUrl(output.blob);
        link.download = output.name;
        link.click();
        showStatus(selectionHint);
      }
    } catch (error) {
      showStatus(error.message, true);
    } finally {
      busy = false;
      updateSelection();
    }
  };
  pages.onsubmit = event => { event.preventDefault(); void load(pageInput.valueAsNumber); };
  download.onclick = () => void save(false);
  insert.onclick = () => void save(true);
  dialog.querySelector('.modal-close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    dialog.remove();
  }, { once: true });
  dialog.showModal();
  await load(page, options.rect);
}
