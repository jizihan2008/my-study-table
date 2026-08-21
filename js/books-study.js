// ═══════════════════════════════════════════════════════════════════
//  教材学习（学习 tab）— 内嵌 PDF 阅读器（翻页 / 缩放 / 文本层选中）
//  依赖（加载顺序见 index.html）：
//    core.js（loadData/saveData）、utils.js（escapeHtml/escapeJs）、
//    books.js（bkGetActiveBook/bkGetActiveChapter/bkRenderMain）、
//    books-kb.js（bkLoadPdfData）、books-ai.js（bkAskTutorCore/bkAiExplainTerm/_bkRenderMd/_bkRequireKey）、
//    keywords.js（kwAddGlobalKeyword/kwGetGlobalKeywords）、
//    ai-api.js（callAiApi）、ai-render.js（formatMarkdownBase）
//  提供接口：
//    bkRenderStudyTab(book, chapter) — 渲染学习 tab（内嵌 PDF 阅读器 + AI 板块）
//    bkStudyPdfPrev() / bkStudyPdfNext() / bkStudyPdfJump() / bkStudyPdfZoom(delta)
//    bkStudySend()                   — 内嵌 AI 板块发送
//    bkStudyAskAddTerm() / bkStudyAskExplain() / bkStudyAskTranslate() — 右键菜单动作
// ═══════════════════════════════════════════════════════════════════

// 内嵌阅读器状态（独立于全屏阅读器 _bkPdfDoc）
let _stPdfDoc = null;     // pdf.js 文档对象
let _stPdfTotal = 1;      // 总页数
let _stPdfPage = 1;       // 当前页（PDF 物理页码）
let _stPdfScale = 1;      // 缩放比例
let _stPdfFitWidth = true;// 是否按容器宽度自适应
let _stBookId = null;     // 已加载 PDF 对应的 book.id
let _stChapterId = null;  // 已加载 PDF 对应的 chapter.id
let _stPageMin = 1;       // 章节起始页（翻页下限，PDF 物理页码）
let _stPageMax = 1;       // 章节结束页（翻页上限）
let _stBusy = false;      // AI 板块忙碌
let _stSelText = '';      // 右键选中的文字
let _stPdfLoading = false;

// ── 加载 PDF 文档 ──
async function _stLoadPdf(book, chapter) {
  // 同书同章已加载则复用
  if (_stPdfDoc && _stBookId === String(book.id) && _stChapterId === String(chapter.id)) {
    return _stPdfDoc;
  }
  // 关闭旧文档
  if (_stPdfDoc && typeof _stPdfDoc.destroy === 'function') {
    try { await _stPdfDoc.destroy(); } catch (e) {}
  }
  _stPdfDoc = null;
  const pdfData = await bkLoadPdfData(book);
  if (!pdfData) return null;
  const pdfjsLib = window.pdfjsLib || (typeof ensurePdfJs === 'function' ? await ensurePdfJs() : null);
  if (!pdfjsLib) return null;
  let data;
  if (pdfData instanceof Uint8Array) data = pdfData;
  else if (pdfData && pdfData.data && typeof pdfData.type === 'string') data = new Uint8Array(pdfData.data);
  else if (pdfData && typeof pdfData === 'object') data = pdfData;
  else return null;
  try {
    const loadingTask = pdfjsLib.getDocument({ data });
    _stPdfDoc = await loadingTask.promise;
    _stPdfTotal = _stPdfDoc.numPages;
    _stPdfPage = Math.min(Math.max(1, _stPdfPage), _stPdfTotal);
    _stBookId = String(book.id);
    _stChapterId = String(chapter.id);
    return _stPdfDoc;
  } catch (err) {
    console.error('学习 tab：PDF 打开失败', err);
    _stPdfDoc = null;
    return null;
  }
}

// ── 渲染当前页（canvas + 文本层） ──
async function _stRenderPage() {
  const wrap = document.getElementById('bkStudyPdfWrap');
  if (!wrap || !_stPdfDoc) return;
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) return;

  const page = await _stPdfDoc.getPage(_stPdfPage);
  // 计算缩放：fitWidth 时按容器宽度；否则用用户缩放
  let scale;
  if (_stPdfFitWidth) {
    const containerW = (wrap.clientWidth || 720) - 40;
    const base = page.getViewport({ scale: 1 });
    scale = Math.min(containerW / base.width, 10);
    // 同步当前实际缩放，保证「适应宽度」后点 +/− 是在当前尺寸基础上继续（而非回到默认值）
    _stPdfScale = scale;
  } else {
    scale = _stPdfScale;
  }
  const viewport = page.getViewport({ scale });
  const cssW = Math.floor(viewport.width);
  const cssH = Math.floor(viewport.height);

  // 构建页容器（canvas + textLayer）
  wrap.innerHTML = `<div class="bk-study-pdf-page" style="width:${cssW}px;height:${cssH}px;">
    <canvas class="bk-study-pdf-canvas"></canvas>
    <div class="textLayer bk-study-pdf-text"></div>
  </div>`;
  const canvas = wrap.querySelector('.bk-study-pdf-canvas');
  const textDiv = wrap.querySelector('.bk-study-pdf-text');
  const ctx = canvas.getContext('2d');

  // 高清渲染：canvas 与文本层使用「同一个 viewport」，dpr 高清通过 OutputScale 变换实现。
  // 关键：不能用 page.getViewport({scale*dpr}) 渲染 canvas（会与文本层坐标产生偏移），
  // 而是 viewport 不变 + render({ transform }) 处理设备像素比。
  const outputScale = new pdfjsLib.OutputScale();
  canvas.width = Math.floor(viewport.width * outputScale.sx);
  canvas.height = Math.floor(viewport.height * outputScale.sy);
  canvas.style.width = Math.floor(viewport.width) + 'px';
  canvas.style.height = Math.floor(viewport.height) + 'px';
  const transform = outputScale.scaled ? [outputScale.sx, 0, 0, outputScale.sy, 0, 0] : null;

  try {
    await page.render({ canvasContext: ctx, viewport, transform }).promise;
  } catch (e) {
    wrap.innerHTML = '<div class="bk-study-pdf-loading" style="color:var(--danger);">渲染失败</div>';
    return;
  }

  // 文本层（选中文字用）— 与 canvas 完全相同的 viewport，保证坐标一致
  try {
    // setLayerDimensions 用 var(--total-scale-factor) 计算容器尺寸与字号放大，
    // 必须显式设为当前缩放 scale（canvas 相对原始 PDF 页的缩放），否则文本层容器/字号
    // 会按 1:1 原始尺寸渲染，与实际渲染页面错位。
    textDiv.style.setProperty('--total-scale-factor', String(scale));
    const textContent = await page.getTextContent();
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: textDiv,
      viewport: viewport
    });
    await textLayer.render();
  } catch (e) {
    console.error('学习 tab：文本层渲染失败', e);
  }

  // 更新页码指示（显示章节内相对页码 + PDF 物理页码）
  const ind = document.getElementById('bkStudyPdfIndicator');
  if (ind) {
    const rel = _stPdfPage - _stPageMin + 1;
    const totalRel = _stPageMax - _stPageMin + 1;
    ind.textContent = `第 ${rel}/${totalRel} 页（PDF ${_stPdfPage}）`;
  }
  const input = document.getElementById('bkStudyPdfInput');
  if (input) input.value = _stPdfPage - _stPageMin + 1;
  input.min = 1;
  input.max = _stPageMax - _stPageMin + 1;
  const prevBtn = document.getElementById('bkStudyPdfPrev');
  const nextBtn = document.getElementById('bkStudyPdfNext');
  if (prevBtn) prevBtn.disabled = _stPdfPage <= _stPageMin;
  if (nextBtn) nextBtn.disabled = _stPdfPage >= _stPageMax;
  const zoomLabel = document.getElementById('bkStudyPdfZoomLabel');
  if (zoomLabel) zoomLabel.textContent = Math.round(scale * 100) + '%';
}

// 翻页（限制在章节页范围内）
function bkStudyPdfPrev() {
  if (_stPdfPage > _stPageMin) { _stPdfPage--; _stRenderPage(); }
}
function bkStudyPdfNext() {
  if (_stPdfPage < _stPageMax) { _stPdfPage++; _stRenderPage(); }
}
// 跳页：输入框显示章节相对页码（1=章节起始页），内部换算为 PDF 物理页码
function bkStudyPdfJump() {
  const input = document.getElementById('bkStudyPdfInput');
  if (!input) return;
  const rel = parseInt(input.value, 10);
  const totalRel = _stPageMax - _stPageMin + 1;
  if (!rel || rel < 1 || rel > totalRel) { input.value = _stPdfPage - _stPageMin + 1; return; }
  _stPdfPage = _stPageMin + rel - 1;
  _stRenderPage();
}
// 缩放：delta = 1 / -1（放大/缩小）；fitWidth=true 时切回自适应
function bkStudyPdfZoom(delta) {
  _stPdfFitWidth = false;
  _stPdfScale = Math.min(10, Math.max(0.5, _stPdfScale + delta * 0.25));
  _stRenderPage();
}
function bkStudyPdfFitWidth() {
  _stPdfFitWidth = true;
  _stRenderPage();
}
function bkStudyPdfReload() {
  // 重新加载（如文件变更）
  _stPdfDoc = null;
  _stBookId = null;
  _stChapterId = null;
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  if (book && chapter) bkRenderStudyTab(book, chapter);
}

// 计算章节翻页范围（PDF 物理页码）。
// 相邻章节可能共享同一 PDF 页（上一章 endPage == 下一章 startPage），这是正常现象——
// 该页既包含上一章的结尾、也包含下一章的开头，两章都应包含它。
// 因此这里**不做任何收缩**，直接用章节自身的 [startPage, endPage]（clamp 到 PDF 总页数）。
// 注意：旧版切分逻辑生成的章节数据 endPage 不含共享页（endPage = 下一章 startPage - 1），
// 需重新导入/重新切分才会更新边界。
function _stComputeChapterRange(book, chapter, totalPages) {
  const total = totalPages || 1;
  let min = Math.max(1, Math.min(total, chapter.startPage || 1));
  let max = Math.max(min, Math.min(total, chapter.endPage || total));
  return { min, max };
}

// ── 主渲染 ──
async function bkRenderStudyTab(book, chapter) {
  const body = document.getElementById('bkMainBody');
  if (!body) return;
  body.classList.add('bk-body-chat'); // 阅读区滚动 + 底部 AI 板块固定
  if (!book || !chapter) {
    body.innerHTML = '<div class="bk-empty-hint"><p>请先在左侧选择要学习的章节</p></div>';
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
    return;
  }

  // 骨架：顶部工具栏 + PDF 阅读区 + 内嵌 AI 板块
  body.innerHTML = `
    <div class="bk-study" id="bkStudyRoot">
      <div class="bk-study-top" id="bkStudyTop">
        <div class="bk-study-title" title="${escapeHtml(chapter.title)}">${escapeHtml(chapter.title)}</div>
        <div class="bk-study-pdf-toolbar">
          <button class="bk-study-nav-btn" id="bkStudyPdfPrev" onclick="bkStudyPdfPrev()" title="上一页"><i data-lucide="chevron-left" class="lucide-icon" style="width:15px;height:15px;"></i></button>
          <input class="bk-study-pdf-input" id="bkStudyPdfInput" type="number" min="1" value="${_stPdfPage}" onchange="bkStudyPdfJump()" onkeydown="if(event.key==='Enter'){this.blur();bkStudyPdfJump();}" title="输入本章页码后回车跳转">
          <span class="bk-study-pdf-indicator" id="bkStudyPdfIndicator">加载中…</span>
          <button class="bk-study-nav-btn" id="bkStudyPdfNext" onclick="bkStudyPdfNext()" title="下一页"><i data-lucide="chevron-right" class="lucide-icon" style="width:15px;height:15px;"></i></button>
          <span class="bk-study-pdf-sep"></span>
          <button class="bk-study-nav-btn" onclick="bkStudyPdfZoom(-1)" title="缩小"><i data-lucide="zoom-out" class="lucide-icon" style="width:15px;height:15px;"></i></button>
          <button class="bk-study-nav-btn" onclick="bkStudyPdfFitWidth()" title="适应宽度"><i data-lucide="scan" class="lucide-icon" style="width:15px;height:15px;"></i></button>
          <button class="bk-study-nav-btn" onclick="bkStudyPdfZoom(1)" title="放大"><i data-lucide="zoom-in" class="lucide-icon" style="width:15px;height:15px;"></i></button>
          <span class="bk-study-pdf-zoom" id="bkStudyPdfZoomLabel">100%</span>
          <span class="bk-study-pdf-sep"></span>
          <button class="bk-study-nav-btn" id="bkStudyFullscreenBtn" onclick="bkStudyToggleFullscreen()" title="全屏"><i data-lucide="maximize" class="lucide-icon" style="width:15px;height:15px;"></i></button>
        </div>
      </div>
      <div class="bk-study-stage" id="bkStudyPdfWrap">
        <div class="bk-study-pdf-loading"><i data-lucide="loader" class="lucide-icon bk-spinner" style="width:22px;height:22px;border-width:2px;animation:bk-spin 0.8s linear infinite;"></i> 正在打开 PDF…</div>
      </div>
      <div class="bk-study-ai" id="bkStudyAiPanel">
        <div class="bk-study-ai-tabs">
          <button class="bk-study-ai-tab active" data-sttab="chat" onclick="bkStudySwitchAiTab('chat')"><i data-lucide="graduation-cap" class="lucide-icon" style="width:13px;height:13px;"></i> 学习助手</button>
          <button class="bk-study-ai-tab" data-sttab="notes" onclick="bkStudySwitchAiTab('notes')"><i data-lucide="file-text" class="lucide-icon" style="width:13px;height:13px;"></i> 笔记</button>
        </div>
        <div class="bk-study-ai-body" data-stpanel="chat">
          <div class="bk-study-ai-head">
            <span>学习助手</span>
            <button class="bk-study-ai-clear" onclick="bkStudyClearChat()"><i data-lucide="eraser" class="lucide-icon" style="width:12px;height:12px;"></i> 清空</button>
          </div>
          <div class="bk-study-ai-flow" id="bkStudyAiFlow">
            <div class="bk-study-ai-hint">在 PDF 页面里选中文字后右键可「添加到术语表」「解释一下」「翻译」，回答会显示在这里，与「章节讲解」共用同一对话历史。</div>
          </div>
          <div class="bk-qa-input-row">
            <input type="text" class="bk-qa-input" id="bkStudyAiInput" placeholder="就本章内容提问（与章节讲解共享上下文）…" onkeydown="if(event.key==='Enter')bkStudySend()">
            <button class="bk-qa-send" id="bkStudyAiSend" onclick="bkStudySend()"><i data-lucide="send" class="lucide-icon" style="width:14px;height:14px;"></i> 提问</button>
          </div>
        </div>
        <div class="bk-study-ai-body bk-study-notes" data-stpanel="notes">
          <div class="bk-study-ai-head">
            <span><i data-lucide="file-text" class="lucide-icon" style="width:13px;height:13px;"></i> 笔记</span>
            <button class="bk-study-ai-clear" onclick="bkStudyOpenNotesPage()" title="打开笔记页面"><i data-lucide="external-link" class="lucide-icon" style="width:12px;height:12px;"></i> 打开</button>
          </div>
          <div class="bk-study-notes-list" id="bkStudyNotesList">
            <div class="bk-study-notes-empty">暂无笔记，去笔记页面新建吧</div>
          </div>
        </div>
      </div>
      <div class="bk-study-ai-trigger" id="bkStudyAiTrigger" title="展开侧边栏">
        <i data-lucide="panel-right" class="lucide-icon" style="width:15px;height:15px;"></i>
      </div>
    </div>`;
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);

  // 加载 PDF（切换章节/书籍时定位到该章起始页；同章切回保留位置）
  if (_stChapterId !== String(chapter.id) || _stBookId !== String(book.id)) {
    _stPdfPage = Math.max(1, chapter.startPage || 1);
    _stPdfFitWidth = true;
  }
  const pdf = await _stLoadPdf(book, chapter);
  if (!pdf) {
    const wrap = document.getElementById('bkStudyPdfWrap');
    if (wrap) wrap.innerHTML = '<div class="bk-study-pdf-loading" style="color:var(--danger);">无法打开 PDF（文件可能已被移动或未导入）</div>';
    return;
  }
  // 章节页范围（PDF 物理页码），限制翻页只能在章节内。
  // 相邻章节共享页（上一章 endPage == 下一章 startPage）是正常现象，两章都包含该页，不收缩。
  const { min: _stStart, max: _stEnd } = _stComputeChapterRange(book, chapter, _stPdfTotal);
  _stPageMin = _stStart;
  _stPageMax = _stEnd;
  _stPdfPage = Math.max(_stPageMin, Math.min(_stPageMax, _stPdfPage));
  await _stRenderPage();

  // 恢复讲解历史到内嵌板块
  _bkStudyRenderHistory(chapter.id);

  // 恢复侧边栏 tab 状态（chat / notes）
  bkStudySwitchAiTab(_stAiTab);

  // 顶部工具栏空闲自动隐藏：鼠标在 PDF 区移动/点击时显示，空闲 2.5s 后隐藏
  bkStudyBindPdfInteractions();

  // iOS 类全屏状态保持：新 root 重新挂类（html 层类已在 documentElement 上）
  if (_stFakeFs) {
    body.querySelector('#bkStudyRoot')?.classList.add('fake-fullscreen');
  }
}

// ── 阅读交互：工具栏自动隐藏 / 点击空白翻页 / 键盘翻页 ──
let _stTopTimer = null;
let _stPdfInteractBound = false;

// 全屏时 AI 侧边栏 hover 开关（仿左侧界面栏：trigger 竖条 + 面板本身，mouseenter 打开、mouseleave 延迟关闭）
let _stAiCloseTimer = null;
const _ST_AI_HOVER_DELAY = 300;
function bkStudyOpenAiPanel() {
  if (_stAiCloseTimer) { clearTimeout(_stAiCloseTimer); _stAiCloseTimer = null; }
  const p = document.getElementById('bkStudyAiPanel');
  if (p) p.classList.add('open');
}
function bkStudyScheduleCloseAiPanel() {
  if (_stAiCloseTimer) clearTimeout(_stAiCloseTimer);
  _stAiCloseTimer = setTimeout(() => {
    const p = document.getElementById('bkStudyAiPanel');
    if (p) p.classList.remove('open');
  }, _ST_AI_HOVER_DELAY);
}

// 是否非全屏（原生全屏 + iOS 类全屏都算全屏）
function _stIsFullscreen() {
  return _stFakeFs || !!document.fullscreenElement;
}
// 显示顶部工具栏 + 底部 AI 面板（非全屏时），并重置空闲计时
function bkStudyShowTop() {
  const t = document.getElementById('bkStudyTop');
  if (t) t.classList.remove('hidden');
  // 非全屏时底部面板一起显示（全屏时底部是侧边栏，由 hover 控制）
  if (!_stIsFullscreen()) {
    const ai = document.getElementById('bkStudyAiPanel');
    if (ai) ai.classList.remove('hidden');
  }
  clearTimeout(_stTopTimer);
  _stTopTimer = setTimeout(() => {
    const el = document.getElementById('bkStudyTop');
    if (el && document.activeElement && document.activeElement.id !== 'bkStudyPdfInput') {
      el.classList.add('hidden');
      // 非全屏时底部面板一起隐藏（全屏时不动，避免影响 hover 侧边栏）
      if (!_stIsFullscreen()) {
        const ai = document.getElementById('bkStudyAiPanel');
        if (ai && document.activeElement && document.activeElement.id !== 'bkStudyAiInput') {
          ai.classList.add('hidden');
        }
      }
    }
  }, 2500);
}

// 切换工具栏显示/隐藏（点击 PDF 中间区域；非全屏时顶部+底部一起切换）
function bkStudyToggleTop() {
  const t = document.getElementById('bkStudyTop');
  if (!t) return;
  if (t.classList.contains('hidden')) {
    bkStudyShowTop();
  } else {
    // 手动隐藏：立即隐藏并取消空闲计时
    clearTimeout(_stTopTimer);
    t.classList.add('hidden');
    // 非全屏时底部面板一起隐藏
    if (!_stIsFullscreen()) {
      const ai = document.getElementById('bkStudyAiPanel');
      if (ai) ai.classList.add('hidden');
    }
  }
}

// iOS（Safari/部分 WebView）不支持元素 requestFullscreen，用「类全屏」模拟。
// 检测增强：iPadOS 13+ Safari UA 伪装成 Mac，需靠 platform + 触屏能力判断；
// 再兜底「有触屏但没有真正 Fullscreen API」的情况。
function bkIsIOS() {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true; // iPadOS 13+
  // 触屏设备（iPad/安卓平板）但平台非 MacIntel 且无真正全屏 API → 也走类全屏
  const hasTouch = ('ontouchstart' in window) && navigator.maxTouchPoints > 0;
  const noRealFs = !document.documentElement.requestFullscreen
    && !document.documentElement.webkitRequestFullscreen;
  return hasTouch && noRealFs;
}
let _stFakeFs = false; // 类全屏状态

// 切换到类全屏 / 退出类全屏
function _bkSetFakeFs(on) {
  _stFakeFs = on;
  document.documentElement.classList.toggle('mst-fake-fullscreen', on);
  const root = document.getElementById('bkStudyRoot');
  if (root) root.classList.toggle('fake-fullscreen', on);
  bkStudyOnFullscreenChange();
}

// 全屏切换：优先标准 Fullscreen API，iOS/不支持时回退到类全屏（position:fixed 铺满视口）
function bkStudyToggleFullscreen() {
  const root = document.getElementById('bkStudyRoot');
  if (!root) return;
  // 类全屏中 → 退出
  if (_stFakeFs) { _bkSetFakeFs(false); return; }
  // 标准全屏中 → 退出
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => _bkSetFakeFs(true));
    return;
  }
  if (bkIsIOS()) { _bkSetFakeFs(true); return; }
  if (root.requestFullscreen) {
    root.requestFullscreen()
      .catch(() => _bkSetFakeFs(true)); // 标准 API 失败（如 iOS/权限）→ 类全屏
  } else if (root.webkitRequestFullscreen) {
    root.webkitRequestFullscreen();
  } else {
    _bkSetFakeFs(true);
  }
}
// 全屏状态变化：更新按钮图标（maximize ⇄ minimize）
function bkStudyOnFullscreenChange() {
  const btn = document.getElementById('bkStudyFullscreenBtn');
  if (!btn) return;
  const isFs = _stFakeFs || !!document.fullscreenElement;
  btn.innerHTML = `<i data-lucide="${isFs ? 'minimize' : 'maximize'}" class="lucide-icon" style="width:15px;height:15px;"></i>`;
  btn.title = isFs ? '退出全屏' : '全屏';
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
  // 全屏切换后布局尺寸变化，延迟到布局稳定后重新 fit 宽度并重渲染
  _stPdfFitWidth = true;
  setTimeout(() => _stRenderPage(), 60);
}
if (typeof document !== 'undefined') {
  document.addEventListener('fullscreenchange', bkStudyOnFullscreenChange);
  if (document.webkitfullscreenchange) document.addEventListener('webkitfullscreenchange', bkStudyOnFullscreenChange);
}

function bkStudyBindPdfInteractions() {
  // 每次进入学习 tab 都短暂显示工具栏
  bkStudyShowTop();
  if (_stPdfInteractBound) return;
  _stPdfInteractBound = true;

  // 鼠标在 PDF 区移动 → 显示
  // 点击 PDF 区：中间区域 → 切换工具栏显示/隐藏；左右空白 → 翻页（同时保持工具栏状态）
  document.addEventListener('click', (e) => {
    if (typeof bkActiveTab !== 'undefined' && bkActiveTab !== 'study') return;
    const wrap = document.getElementById('bkStudyPdfWrap');
    if (!wrap || !e.target || !e.target.closest) return;
    if (!e.target.closest('#bkStudyPdfWrap')) return;
    // 点击工具栏按钮/输入框不参与切换
    if (e.target.closest('#bkStudyTop')) return;
    // 文本层选中文字时不切换/不翻页
    const sel = window.getSelection();
    if (sel && sel.toString() && sel.toString().trim()) return;

    const rect = wrap.getBoundingClientRect();
    if (!rect.width) return;
    const rel = (e.clientX - rect.left) / rect.width;
    if (rel < 0.22) {
      // 左空白 → 上一页（不切换工具栏，避免翻页时工具栏闪动）
      bkStudyPdfPrev();
    } else if (rel > 0.78) {
      // 右空白 → 下一页
      bkStudyPdfNext();
    } else {
      // 中间区域 → 切换工具栏显示/隐藏
      bkStudyToggleTop();
    }
  });

  // 键盘左右箭头 → 翻页（仅学习 tab，且焦点不在输入框）
  document.addEventListener('keydown', (e) => {
    if (typeof bkActiveTab !== 'undefined' && bkActiveTab !== 'study') return;
    const t = e.target;
    const tag = t && t.tagName ? t.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); bkStudyPdfPrev(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); bkStudyPdfNext(); }
  });

  // 全屏时 AI 侧边栏 hover 打开/关闭（仿左侧界面栏：mouseenter 打开、mouseleave 延迟关闭）
  const aiTrigger = document.getElementById('bkStudyAiTrigger');
  const aiPanel = document.getElementById('bkStudyAiPanel');
  if (aiTrigger) {
    aiTrigger.addEventListener('mouseenter', bkStudyOpenAiPanel);
  }
  if (aiPanel) {
    aiPanel.addEventListener('mouseenter', bkStudyOpenAiPanel);
    aiPanel.addEventListener('mouseleave', bkStudyScheduleCloseAiPanel);
  }

  // 触屏双指捏合缩放 PDF（iPhone/iPad）
  bkStudyBindPinchZoom();
}

// ── 双指捏合缩放 PDF（触屏） ──
// 在 #bkStudyPdfWrap 上监听两个触点的间距变化，按比例调整 _stPdfScale（退出 fit-width）。
// 用 document 委托（wrap 每次渲染重建）；单指滚动/翻页不干扰；双指时阻止浏览器原生缩放。
let _pinch = null; // { d0, scale0 }
function bkStudyBindPinchZoom() {
  const canTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  if (!canTouch) return;
  const wrapSel = '#bkStudyPdfWrap';
  const isInWrap = (t) => t && t.closest && t.closest(wrapSel);

  document.addEventListener('touchstart', (e) => {
    if (typeof bkActiveTab !== 'undefined' && bkActiveTab !== 'study') return;
    if (!isInWrap(e.target)) return;
    if (e.touches.length >= 2) {
      const t0 = e.touches[0], t1 = e.touches[1];
      const d = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      if (d > 0) {
        _pinch = { d0: d, scale0: _stPdfScale };
        // 双指捏合时禁止浏览器原生页面缩放
        try { e.preventDefault(); } catch (err) {}
      }
    }
  }, { passive: false });

  document.addEventListener('touchmove', (e) => {
    if (!_pinch || typeof bkActiveTab === 'undefined' || bkActiveTab !== 'study') return;
    if (!isInWrap(e.target)) return;
    if (e.touches.length >= 2) {
      try { e.preventDefault(); } catch (err) {} // 阻止浏览器原生缩放/手势
      const t0 = e.touches[0], t1 = e.touches[1];
      const d = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      if (d > 0 && _pinch.d0 > 0) {
        const s = Math.min(10, Math.max(0.5, _pinch.scale0 * (d / _pinch.d0)));
        _stPdfScale = s;
        _stPdfFitWidth = false;
        // 实时用 CSS transform 预览缩放（不重渲染，保证流畅）
        const pageEl = document.querySelector('#bkStudyPdfWrap .bk-study-pdf-page');
        if (pageEl) {
          pageEl.style.transform = 'scale(' + s / _pinch.scale0 + ')';
          pageEl.style.transformOrigin = 'center top';
        }
      }
    }
  }, { passive: false });

  document.addEventListener('touchend', () => {
    if (_pinch) {
      // 手指抬起：按最终比例高清重渲染
      _pinch = null;
      _stPdfFitWidth = false;
      _stRenderPage();
    }
  });
  document.addEventListener('touchcancel', () => {
    _pinch = null;
    _stRenderPage(); // 恢复布局
  });
}

// ── 右侧侧边栏：学习助手 / 笔记 tab 切换 ──
let _stAiTab = 'chat'; // chat | notes
function bkStudySwitchAiTab(tab) {
  _stAiTab = tab;
  const panel = document.getElementById('bkStudyAiPanel');
  if (!panel) return;
  panel.querySelectorAll('.bk-study-ai-tab').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-sttab') === tab);
  });
  panel.querySelectorAll('.bk-study-ai-body').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-stpanel') === tab);
  });
  if (tab === 'notes') bkStudyRenderNotesList();
}

// 渲染笔记列表（侧边栏「笔记」tab）
function bkStudyRenderNotesList() {
  const list = document.getElementById('bkStudyNotesList');
  if (!list) return;
  const items = (typeof notes !== 'undefined' && Array.isArray(notes))
    ? notes.filter(n => n && n.type === 'note') : [];
  if (!items.length) {
    list.innerHTML = '<div class="bk-study-notes-empty">暂无笔记，点击下方「打开」去笔记页面新建吧</div>';
    return;
  }
  // 按更新时间倒序
  items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  list.innerHTML = items.map(n => {
    const t = n.title || '未命名笔记';
    const time = (n.updatedAt || n.createdAt || '');
    const timeStr = time ? new Date(time).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '';
    const snippet = (n.content || '').replace(/\s+/g, ' ').slice(0, 60);
    return `<div class="bk-study-note-item" onclick="bkStudyOpenNote('${escapeJs(n.id)}')" title="${escapeHtml(t)}">
      <div class="bk-study-note-title"><i data-lucide="file-text" class="lucide-icon" style="width:12px;height:12px;flex-shrink:0;"></i>${escapeHtml(t)}</div>
      ${snippet ? `<div class="bk-study-note-snippet">${escapeHtml(snippet)}</div>` : ''}
      ${timeStr ? `<div class="bk-study-note-time">${timeStr}</div>` : ''}
    </div>`;
  }).join('');
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
}

// 打开侧边栏里的某个笔记（切到笔记页并选中）
function bkStudyOpenNote(id) {
  const sid = String(id || '');
  // 先切到笔记页，再选中该笔记（switchTab 后 DOM 就绪）
  if (typeof switchTab === 'function') switchTab('notes');
  setTimeout(() => {
    if (typeof selectNote === 'function') selectNote(sid);
  }, 50);
}
// 打开笔记页面（切到侧边栏「笔记」tab）
function bkStudyOpenNotesPage() {
  if (typeof switchTab === 'function') switchTab('notes');
}

// ── 内嵌 AI 板块：与章节讲解共享 study_bk_explain_logs_v1[chapterId] ──
function _bkStudyRenderHistory(chapterId) {
  const flow = document.getElementById('bkStudyAiFlow');
  if (!flow || !chapterId) return;
  if (typeof _bkExplainLogLoad === 'function') {
    const logs = _bkExplainLogLoad(chapterId);
    if (logs.length > 0) {
      flow.innerHTML = logs.map(m => {
        if (m.role === 'user') {
          return `<div class="bk-msg user"><div class="bk-msg-row"><div class="bk-msg-avatar"><i data-lucide="user" class="lucide-icon" style="width:15px;height:15px;"></i></div><div class="bk-msg-bubble">${escapeHtml(m.content)}</div></div></div>`;
        }
        return `<div class="bk-msg assistant"><div class="bk-msg-row"><div class="bk-msg-avatar"><i data-lucide="graduation-cap" class="lucide-icon" style="width:16px;height:16px;"></i></div><div class="bk-msg-bubble"><div class="markdown-body">${_bkRenderMd(m.content)}</div></div></div></div>`;
      }).join('');
      if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
    }
  }
}

async function bkStudySend() {
  const input = document.getElementById('bkStudyAiInput');
  const sendBtn = document.getElementById('bkStudyAiSend');
  const flow = document.getElementById('bkStudyAiFlow');
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  if (!input || !sendBtn || !flow || !book || !chapter || _stBusy) return;
  const q = input.value.trim();
  if (!q) return;
  if (typeof _bkRequireKey === 'function' && !_bkRequireKey()) return;
  // 全屏时确保侧边栏展开（否则看不到回复）
  bkStudyOpenAiPanel();

  flow.insertAdjacentHTML('beforeend', `
    <div class="bk-msg user bk-fade-in">
      <div class="bk-msg-row">
        <div class="bk-msg-avatar"><i data-lucide="user" class="lucide-icon" style="width:15px;height:15px;"></i></div>
        <div class="bk-msg-bubble">${escapeHtml(q)}</div>
      </div>
    </div>`);
  flow.insertAdjacentHTML('beforeend', `
    <div class="bk-msg assistant bk-fade-in" id="bkStudyLoadingMsg">
      <div class="bk-msg-row">
        <div class="bk-msg-avatar"><i data-lucide="graduation-cap" class="lucide-icon" style="width:16px;height:16px;"></i></div>
        <div class="bk-msg-bubble"><i data-lucide="loader" class="lucide-icon bk-spinner" style="width:12px;height:12px;border-width:2px;animation:bk-spin 0.8s linear infinite;"></i> 正在讲解…</div>
      </div>
    </div>`);
  input.value = '';
  _stBusy = true;
  sendBtn.disabled = true;
  sendBtn.innerHTML = '<i data-lucide="loader" class="lucide-icon bk-spinner" style="width:14px;height:14px;border-width:2px;animation:bk-spin 0.8s linear infinite;"></i> 讲解中…';
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);

  try {
    const answer = await bkAskTutorCore(chapter, q);
    const loadingEl = document.getElementById('bkStudyLoadingMsg');
    if (loadingEl) loadingEl.remove();
    if (answer === null) return;
    flow.insertAdjacentHTML('beforeend', `
      <div class="bk-msg assistant bk-fade-in">
        <div class="bk-msg-row">
          <div class="bk-msg-avatar"><i data-lucide="graduation-cap" class="lucide-icon" style="width:16px;height:16px;"></i></div>
          <div class="bk-msg-bubble"><div class="markdown-body">${_bkRenderMd(answer)}</div></div>
        </div>
      </div>`);
    flow.scrollTop = flow.scrollHeight;
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
  } catch (err) {
    const loadingEl = document.getElementById('bkStudyLoadingMsg');
    if (loadingEl) loadingEl.remove();
    flow.insertAdjacentHTML('beforeend', `
      <div class="bk-msg assistant bk-fade-in">
        <div class="bk-msg-row">
          <div class="bk-msg-avatar"><i data-lucide="alert-triangle" class="lucide-icon" style="width:16px;height:16px;"></i></div>
          <div class="bk-msg-bubble" style="color:var(--danger);">AI 调用失败：${escapeHtml(String((err && err.message) || err))}</div>
        </div>
      </div>`);
  } finally {
    _stBusy = false;
    const curBtn = document.getElementById('bkStudyAiSend');
    if (curBtn) {
      curBtn.disabled = false;
      curBtn.innerHTML = '<i data-lucide="send" class="lucide-icon" style="width:14px;height:14px;"></i> 提问';
      if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
    }
  }
}

function bkStudyClearChat() {
  const chapter = bkGetActiveChapter();
  if (!chapter) return;
  if (typeof showCustomConfirm === 'function') {
    showCustomConfirm('确定要清空本章的学习助手对话记录吗？<br><small>这将同时清空「章节讲解」tab 的历史记录。</small>').then(ok => {
      if (!ok) return;
      _bkStudyDoClear(chapter.id);
    });
  } else {
    _bkStudyDoClear(chapter.id);
  }
}
function _bkStudyDoClear(chapterId) {
  if (typeof _bkExplainLogSave === 'function') _bkExplainLogSave(chapterId, []);
  const flow = document.getElementById('bkStudyAiFlow');
  if (flow) {
    flow.innerHTML = '<div class="bk-study-ai-hint">对话已清空。在 PDF 页面选中文字右键可「解释一下」「翻译」。</div>';
  }
}

// ── 右键菜单（文本层选中文字） ──
function bkStudyOpenContextMenu(e, selectedText) {
  _stSelText = selectedText || '';
  const menu = document.getElementById('bkStudyContextMenu');
  if (!menu) return;
  const hasSel = !!_stSelText.trim();
  if (!hasSel) { bkStudyCloseContextMenu(); return; }
  const itemAdd = document.getElementById('bkStudyCtxAddTerm');
  const itemExplain = document.getElementById('bkStudyCtxExplain');
  const itemTranslate = document.getElementById('bkStudyCtxTranslate');
  if (itemAdd) itemAdd.style.display = '';
  if (itemExplain) itemExplain.style.display = '';
  if (itemTranslate) itemTranslate.style.display = '';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.classList.add('visible');
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  if (rect.right > vw) menu.style.left = Math.max(0, vw - rect.width - 6) + 'px';
  if (rect.bottom > vh) menu.style.top = Math.max(0, vh - rect.height - 6) + 'px';
}
function bkStudyCloseContextMenu() {
  const menu = document.getElementById('bkStudyContextMenu');
  if (menu) menu.classList.remove('visible');
  _stSelText = '';
}
function bkStudyGetSelectedText() {
  const sel = window.getSelection();
  const t = sel ? sel.toString() : '';
  if (t && t.trim()) return t.trim();
  return _stSelText;
}

async function bkStudyAskAddTerm() {
  const term = bkStudyGetSelectedText();
  bkStudyCloseContextMenu();
  if (!term) return;
  if (typeof kwGetGlobalKeywords === 'function') {
    const existing = kwGetGlobalKeywords().find(x => x.word.toLowerCase() === term.toLowerCase());
    if (existing) {
      alert('「' + term + '」已在全局关键词库中');
      return;
    }
  }
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  const ref = (book ? book.title : '') + (chapter ? ' · ' + chapter.title : '');
  let def = '';
  if (typeof bkAiExplainTerm === 'function' && chapter) {
    const r = await bkAiExplainTerm(term);
    if (r && r.def) def = r.def;
  }
  if (typeof kwAddGlobalKeyword === 'function') {
    const res = kwAddGlobalKeyword(term, def, ref);
    if (res.ok) alert('已添加到全局关键词库' + (def ? '（含 AI 释义）' : ''));
  }
}

function bkStudyAskExplain() {
  const term = bkStudyGetSelectedText();
  bkStudyCloseContextMenu();
  if (!term) return;
  _bkStudyAskAi('请详细解释一下下面这段话，拆解其中的概念、补充直觉与例子：\n' + term);
}
function bkStudyAskTranslate() {
  const term = bkStudyGetSelectedText();
  bkStudyCloseContextMenu();
  if (!term) return;
  _bkStudyAskAi('请将下面这段文字翻译成中文，若原文已是中文则翻译成英文；保留专业术语并在括号中给出原文：\n' + term);
}
function _bkStudyAskAi(q) {
  const input = document.getElementById('bkStudyAiInput');
  if (input) input.value = q;
  bkStudySend();
}

// 全局监听：学习 tab 文本层选中文字右键弹出菜单
function bkInitStudyContextMenu() {
  document.addEventListener('contextmenu', function (e) {
    const isStudyTab = (typeof bkActiveTab !== 'undefined' && bkActiveTab === 'study');
    const inPdfWrap = e.target.closest ? e.target.closest('#bkStudyPdfWrap') : null;
    if (!isStudyTab || !inPdfWrap) return;
    const sel = window.getSelection();
    const t = sel ? sel.toString() : '';
    if (t && t.trim()) {
      e.preventDefault();
      bkStudyOpenContextMenu(e, t.trim());
    }
  });
  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('#bkStudyContextMenu')) bkStudyCloseContextMenu();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') bkStudyCloseContextMenu();
  });
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bkInitStudyContextMenu);
  } else {
    bkInitStudyContextMenu();
  }
}
