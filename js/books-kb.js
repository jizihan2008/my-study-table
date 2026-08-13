// ═══════════════════════════════════════════════════════════════════
//  教材学习 — 知识库构建（逐章 AI 生成摘要 / 术语表 / 重点 / 知识导图 / 伪代码）
//  依赖：ai-api.js（callAiApi）、settings.js（getEffectiveApiConfig）、
//        books.js（bkGetActiveBook / bkGetChapterText / bkSaveBooks / bkRenderToc）
//  提供接口：
//    bkRenderKbPanel()     — 渲染中栏知识库进度面板（含构建队列条）
//    bkConfirmStartKbBuild() — 全书构建二次确认（弹窗标注费 token 提示，确认后入队）
//    bkStartKbBuild()      — 入队全书构建（断点续跑，跳过已 done 章节）
//    bkStopKbBuild()       — 停止当前构建并清空队列
//    bkRetryChapter(id)    — 单章重试（委托 bkBuildChapter 入队）
//    bkBuildChapter(id)    — 入队单章构建（不影响其他章节）
//    bkRebuildKb()         — 重新构建全书知识库（重置 pending 后入队全量重建）
//    bkKbRemoveTask(idx)   — 将等待队列中指定任务移出队列
//    bkKbClearQueue()      — 清空所有等待队列任务
//    bkBuildChapterSummary(chapter, text, cfg) — 仅重新生成单章摘要（不动术语/重点/导图）
//    bkShouldCollectPseudocode(book) / bkJudgeProgrammingBook(book,cfg) / bkEnsurePseudocodeJudged(book,cfg)
//                          — 编程书判断与伪代码收集开关（book.pseudocode）
//  构建队列说明：全书构建/单章构建/全书重建统一进入 bkKbQueue 排队，由
//  bkKbProcessQueue 按序串行执行（同一时刻只跑一个任务），支持跨书排队。
// ═══════════════════════════════════════════════════════════════════

let bkKbBuilding = false;      // 是否正在构建
let bkBuildStopRequested = false; // 请求停止标志
let bkKbCurrentTask = null;    // 当前正在执行的任务 { bookId, mode, chapterId?, detailLevel }（已从队列取出）
let bkKbQueue = [];            // 构建队列：等待执行的任务 [{ bookId, mode:'full'|'rebuild'|'chapter', chapterId?, detailLevel }]
let _bkKbCurrentChapter = null; // 当前正在构建的章节标题（队列条显示细化进度，替代被移除的琥珀色提示条）
let _bkKbQueueCollapsed = false; // 队列条折叠状态（localStorage 持久化）
try { _bkKbQueueCollapsed = localStorage.getItem('study_bk_kb_queue_collapsed') === '1'; } catch (e) {}

// ═══════════ 构建队列核心 ═══════════
// 统一刷新队列相关 UI：知识库面板 + 目录徽章 + 书架徽章（排队中/构建中）
function bkRefreshKbUi() {
  bkRenderKbPanel();
  bkRenderToc();
  if (typeof bkRenderShelfList === 'function') bkRenderShelfList();
}

// 任务入队：去重（同书同类型任务已在等待队列则不重复），入队后尝试启动队列处理
function bkKbEnqueue(task) {
  if (!task || task.bookId == null) return;
  const dup = bkKbQueue.some(t =>
    String(t.bookId) === String(task.bookId)
    && t.mode === task.mode
    && String(t.chapterId || '') === String(task.chapterId || ''));
  if (dup) { bkRefreshKbUi(); return; }
  bkKbQueue.push(task);
  bkRefreshKbUi();
  bkKbProcessQueue();
}

// 队列处理循环：空闲时取出队首任务串行执行，执行完继续下一个
async function bkKbProcessQueue() {
  if (bkKbBuilding) return;
  if (bkKbQueue.length === 0) return;
  const task = bkKbQueue.shift();
  const book = (typeof bkGetBookById === 'function') ? bkGetBookById(task.bookId) : null;
  if (!book) { bkKbProcessQueue(); return; } // 书已被删除，跳过该任务
  bkKbBuilding = true;
  bkKbCurrentTask = task;
  bkBuildStopRequested = false;
  bkRefreshKbUi();
  try {
    if (task.mode === 'chapter') {
      const ch = (book.chapters || []).find(c => String(c.id) === String(task.chapterId));
      if (ch) await _bkRunChapterBuild(book, ch, task.detailLevel);
    } else {
      // 'full' / 'rebuild'（rebuild 的重置已在入队时完成）
      await _bkRunBookBuild(book, task.detailLevel);
    }
  } catch (e) {
    console.error('队列构建任务执行失败:', e);
  } finally {
    bkKbBuilding = false;
    bkKbCurrentTask = null;
    _bkKbCurrentChapter = null;
    bkBuildStopRequested = false;
    bkRefreshKbUi();
    if (bkKbQueue.length > 0) bkKbProcessQueue(); // 继续下一个任务
  }
}

// 将等待队列中指定任务移出队列（仅等待中的任务，正在执行的无法移除）
function bkKbRemoveTask(idx) {
  if (!Number.isFinite(idx) || idx < 0 || idx >= bkKbQueue.length) return;
  bkKbQueue.splice(idx, 1);
  bkRefreshKbUi();
}

// 清空所有等待队列任务（不影响正在执行的任务）
function bkKbClearQueue() {
  bkKbQueue = [];
  bkRefreshKbUi();
}

// 渲染队列条 HTML（当前执行任务 + 等待任务列表），无任务返回 ''
// 可折叠：头部点击切换展开/收起（_bkKbQueueCollapsed），折叠时仍显示任务数摘要
function bkRenderKbQueueBarHtml() {
  const parts = [];
  if (bkKbBuilding && bkKbCurrentTask) {
    const t = bkKbCurrentTask;
    const b = (typeof bkGetBookById === 'function') ? bkGetBookById(t.bookId) : null;
    let label = b ? b.title : '未知书籍';
    if (t.mode === 'chapter') {
      const ch = b ? (b.chapters || []).find(c => String(c.id) === String(t.chapterId)) : null;
      label += ' / ' + (ch ? ch.title : '章节');
    } else if (t.mode === 'rebuild') {
      label += '（重建）';
    }
    // 整书/重建任务补充当前正在构建的章节（替代被移除的琥珀色提示条）
    if (t.mode !== 'chapter' && _bkKbCurrentChapter) {
      label += ' / ' + _bkKbCurrentChapter;
    }
    const stateText = bkBuildStopRequested ? '正在停止' : '正在构建';
    parts.push(`<div class="bk-kb-queue-item running">
      <i data-lucide="loader" class="lucide-icon bk-spinner" style="width:11px;height:11px;flex:none;"></i>
      <span class="bk-kb-queue-item-title" title="${escapeHtml(label)}">${stateText}：${escapeHtml(label)}</span>
    </div>`);
  }
  bkKbQueue.forEach((t, idx) => {
    const b = (typeof bkGetBookById === 'function') ? bkGetBookById(t.bookId) : null;
    let label = b ? b.title : '未知书籍';
    if (t.mode === 'chapter') {
      const ch = b ? (b.chapters || []).find(c => String(c.id) === String(t.chapterId)) : null;
      label += ' / ' + (ch ? ch.title : '章节');
    } else if (t.mode === 'rebuild') {
      label += '（重建）';
    }
    parts.push(`<div class="bk-kb-queue-item">
      <i data-lucide="list-ordered" class="lucide-icon" style="width:11px;height:11px;flex:none;"></i>
      <span class="bk-kb-queue-item-title" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
      <button class="bk-kb-queue-item-x" onclick="bkKbRemoveTask(${idx})" title="移出队列"><i data-lucide="x" class="lucide-icon" style="width:10px;height:10px;"></i></button>
    </div>`);
  });
  if (parts.length === 0) return '';
  const collapsed = _bkKbQueueCollapsed;
  // 折叠时头部摘要：总任务数（正在构建 1 + 等待 N）
  const total = (bkKbBuilding ? 1 : 0) + bkKbQueue.length;
  return `<div class="bk-kb-queue-bar">
    <div class="bk-kb-queue-head">
      <button class="bk-kb-queue-toggle" onclick="bkKbToggleQueue()" title="${collapsed ? '展开' : '折叠'}队列">
        <i data-lucide="${collapsed ? 'chevron-right' : 'chevron-down'}" class="lucide-icon" style="width:12px;height:12px;flex:none;"></i>
        <span>构建队列${total ? ' (' + total + ')' : ''}</span>
      </button>
      <span style="display:inline-flex;align-items:center;gap:6px;font-weight:400;">
        ${bkKbQueue.length ? `<span class="bk-kb-queue-count">等待 ${bkKbQueue.length}</span>` : (bkKbBuilding ? '<span class="bk-kb-queue-count">构建中</span>' : '')}
        ${bkKbQueue.length > 0 ? `<button class="bk-kb-queue-clear" onclick="bkKbClearQueue()" title="清空所有等待任务">清空队列</button>` : ''}
      </span>
    </div>
    ${collapsed ? '' : parts.join('')}
  </div>`;
}

// 折叠 / 展开构建队列条（偏好持久化到 localStorage）
function bkKbToggleQueue() {
  _bkKbQueueCollapsed = !_bkKbQueueCollapsed;
  try { localStorage.setItem('study_bk_kb_queue_collapsed', _bkKbQueueCollapsed ? '1' : '0'); } catch (e) {}
  bkRefreshKbUi();
}

// ═══════════ 正文截断设置（可在 设置 → 更多设置 中调整） ═══════════
// 阈值：章节正文超过该字符数时触发截断（默认 9000）
function bkTruncateLimit() {
  const v = parseInt(localStorage.getItem('study_books_kb_truncate') || '9000', 10);
  return (Number.isFinite(v) && v >= 1000 && v <= 100000) ? v : 9000;
}

// 按阈值比例计算头尾各保留的字符数（6500/9000 ≈ 0.72，保持原有行为）
function bkTruncateKeep() {
  return Math.max(500, Math.round(bkTruncateLimit() * 0.72));
}

// 对章节正文做 token 控制：超阈值时取头尾关键片段，中间省略
function bkTruncateChapterText(text) {
  if (typeof text !== 'string' || !text) return '';
  const limit = bkTruncateLimit();
  const keep = bkTruncateKeep();
  if (text.length <= limit) return text;
  return text.slice(0, keep) + '\n\n[中间内容省略，约 ' + (text.length - keep * 2) + ' 字符]…\n\n' + text.slice(-keep);
}

// 渲染知识库进度面板（进度条 + 操作按钮），由 books.js 的 bkRenderToc 调用
function bkRenderKbPanel() {
  const book = bkGetActiveBook();
  const panel = document.getElementById('bkKbPanel');
  if (!book || !panel) return;

  const st = bkDeriveBookKbState(book);
  const pct = st.total ? Math.round((st.doneCount / st.total) * 100) : 0;
  // 仅当「当前正在构建的书」是本书时显示停止按钮；正在构建其他书时本书可正常入队
  const buildingThisBook = bkKbBuilding && bkKbCurrentTask && String(bkKbCurrentTask.bookId) === String(book.id);

  let actions = '';
  if (buildingThisBook) {
    actions = `<button class="bk-kb-action-btn danger" onclick="bkStopKbBuild()" ${bkBuildStopRequested ? 'disabled' : ''}>
      <i data-lucide="square" class="lucide-icon" style="width:12px;height:12px;"></i>${bkBuildStopRequested ? '正在停止…' : '停止构建'}
    </button>`;
  } else if (st.status === 'done') {
    actions = `<span class="bk-kb-action-btn" style="border-color:var(--done);color:var(--done);pointer-events:none;">
      <i data-lucide="check-circle-2" class="lucide-icon" style="width:12px;height:12px;"></i>知识库已构建完成
    </span>`;
  } else if (st.status === 'partial' || st.failed || (st.doneCount > 0 && st.doneCount < st.total)) {
    actions = `<button class="bk-kb-action-btn primary" onclick="bkConfirmStartKbBuild()">
      <i data-lucide="play" class="lucide-icon" style="width:12px;height:12px;"></i>继续构建
    </button>`;
  } else {
    actions = `<button class="bk-kb-action-btn primary" onclick="bkConfirmStartKbBuild()">
      <i data-lucide="wand-2" class="lucide-icon" style="width:12px;height:12px;"></i>构建知识库
    </button>`;
  }

  // 构建队列条（正在执行的任务 + 等待任务）
  const queueBar = (typeof bkRenderKbQueueBarHtml === 'function') ? bkRenderKbQueueBarHtml() : '';

  panel.innerHTML = `
    ${queueBar}
    <div class="bk-kb-bar">
      <span>知识库</span>
      <div class="bk-kb-bar-fill"><div class="bk-kb-bar-inner" style="width:${pct}%"></div></div>
      <span>${st.doneCount}/${st.total}</span>
    </div>
    <div class="bk-kb-actions">
      ${actions}
      <button class="bk-kb-action-btn" id="bkKbRebuildBtn" onclick="bkRebuildKb()" ${bkKbBuilding ? 'disabled' : ''} title="清空并重新生成全书所有章节的摘要、术语表、重点与知识导图">
        <i data-lucide="refresh-cw" class="lucide-icon" style="width:12px;height:12px;"></i> 重新构建知识库
      </button>
    </div>`;

  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
}

// 全书构建二次确认（点「构建知识库 / 继续构建」时弹出，标注费 token 提示，确认后入队）
function bkConfirmStartKbBuild() {
  const book = bkGetActiveBook();
  if (!book) return;
  const todo = (book.chapters || []).filter(c => !(c.kb && c.kb.status === 'done'));
  if (todo.length === 0) { bkRenderKbPanel(); return; }
  const extraCollect = [
    bkShouldCollectPseudocode(book) ? '伪代码' : '',
    bkShouldCollectFigures(book) ? '图片及其解释' : ''
  ].filter(Boolean);
  // 有任务正在执行/排队时，提示本次操作将加入队列
  const queuedHint = (bkKbQueue.length > 0 || (bkKbBuilding && bkKbCurrentTask))
    ? `<br><small style="color:var(--primary);font-weight:600;">⏳ 当前有构建任务正在进行/排队，本书将加入构建队列，按顺序依次构建。</small>`
    : '';
  showCustomConfirm(`确定要开始构建《${escapeHtml(book.title)}》的知识库吗？<br><small>将处理 <b>${todo.length}</b> 个章节的摘要、术语表、重点与知识导图${extraCollect.length ? '及' + extraCollect.join('、') : ''}，耗时较长，构建过程中可随时停止。<br><span style="color:var(--danger);font-weight:600;">⚠️ 全书构建比较费 token，建议仅构建需要的章节（选中章节 → 摘要导图 → 仅构建本章）。</span>${queuedHint}</small>`).then(ok => {
    if (!ok) return;
    bkStartKbBuild();
  });
}

// ── 全书构建入队（断点续跑：跳过已 done 章节） ──
// 入队后由 bkKbProcessQueue 串行执行，支持与其他书籍构建任务排队
function bkStartKbBuild(detailLevel) {
  detailLevel = detailLevel || 'standard';
  const book = bkGetActiveBook();
  if (!book) return;

  const cfg = (typeof getEffectiveApiConfig === 'function') ? getEffectiveApiConfig() : null;
  if (!cfg || !cfg.apiKey || typeof callAiApi !== 'function') {
    alert('请先在「设置 → AI」中配置 API Key，再构建知识库');
    return;
  }

  // 需要构建的章节（pending / failed）
  const todo = (book.chapters || []).filter(c => !(c.kb && c.kb.status === 'done'));
  if (todo.length === 0) { bkRenderKbPanel(); return; }

  bkKbEnqueue({ bookId: book.id, mode: 'full', detailLevel });
}

// ── 全书构建执行体（由队列调度执行） ──
async function _bkRunBookBuild(book, detailLevel) {
  detailLevel = detailLevel || 'standard';
  const cfg = (typeof getEffectiveApiConfig === 'function') ? getEffectiveApiConfig() : null;
  if (!cfg || !cfg.apiKey || typeof callAiApi !== 'function') return;

  const todo = (book.chapters || []).filter(c => !(c.kb && c.kb.status === 'done'));
  if (todo.length === 0) return;

  // 编程书判断（AI 自动，用户可手动覆盖）：决定构建时是否顺带收集伪代码
  let collectPseudocode = false;
  try { collectPseudocode = await bkEnsurePseudocodeJudged(book, cfg); } catch (e) { collectPseudocode = false; }
  // 图片集：用户手动开关，决定构建时是否顺带收集本章图片及其解释
  const collectFigures = bkShouldCollectFigures(book);

  for (let i = 0; i < todo.length; i++) {
    if (bkBuildStopRequested) break;
    const ch = todo[i];
    _bkKbCurrentChapter = ch.title; // 队列条 running 项显示当前章节
    await _bkBuildChapterCore(book, ch, cfg, collectPseudocode, collectFigures, detailLevel);
  }
}

// 停止构建：停止当前正在执行的任务，并清空等待队列（不再继续执行后续任务）
function bkStopKbBuild() {
  if (!bkKbBuilding && bkKbQueue.length === 0) return;
  bkBuildStopRequested = true;
  bkKbQueue = [];            // 清空等待任务（正在执行的任务将在章节边界停止）
  bkRefreshKbUi();           // 队列条 running 项随即显示「正在停止…」
}

// 读取当前书的 PDF 字节（Electron 用文件路径；PWA 用 IndexedDB 存储的原始字节）
// 返回 Uint8Array 或 null
async function bkLoadPdfData(book) {
  if (!book) return null;
  try {
    if (window.electronAPI && window.electronAPI.readPdfFile && book.filePath) {
      return await window.electronAPI.readPdfFile(book.filePath);
    }
    if (window.BookPdfStore && typeof window.BookPdfStore.read === 'function') {
      return await window.BookPdfStore.read(book.id);
    }
  } catch (e) { /* ignore */ }
  return null;
}

// 提取本章图片（含图注）：从 PDF 渲染含图注页面 → [{ page, caption, dataUrl }]
async function bkExtractChapterFigures(book, ch) {
  try {
    const pdfData = await bkLoadPdfData(book);
    if (!pdfData || typeof extractChapterFigurePages !== 'function') return [];
    return await extractChapterFigurePages(pdfData, ch, 8);
  } catch (e) {
    console.error('图片提取失败:', e);
    return [];
  }
}

// ── 单章构建核心 ──
// 构建单个章节：置 building 状态 → AI 生成 → 落盘结果（done/failed），并刷新目录徽章
// 供 _bkRunBookBuild（全量）与 _bkRunChapterBuild（单章）共用
// book 显式传入（构建任务可能作用于非当前激活书籍）
// collectPseudocode=true 时顺带提取该章伪代码（编程书）
// collectFigures=true 时顺带提取该章图片并让 AI 生成解释（图片集模块）
async function _bkBuildChapterCore(book, ch, cfg, collectPseudocode, collectFigures, detailLevel) {
  detailLevel = detailLevel || 'standard';
  if (!book || !ch) return;
  ch.kb = ch.kb || { status: 'pending', summary: '', terms: [], keyPoints: [], mindmap: null, pseudocode: [], figures: [] };
  ch.kb.status = 'building';
  bkSaveBooks();
  bkRefreshKbUi();

  let chapterText = '';
  try { chapterText = await bkGetChapterTextWithPages(ch); } catch (e) { chapterText = ''; }

  // 图片集：收集本章图片（含图注），多模态模型可看图、非多模态依据图注
  let figures = [];
  if (collectFigures) {
    try { figures = await bkExtractChapterFigures(book, ch); } catch (e) { figures = []; }
  }

  try {
    const kb = await bkBuildChapterKb(ch, chapterText, cfg, collectPseudocode, figures, detailLevel);
    if (kb) {
      ch.kb.status = 'done';
      ch.kb.summary = kb.summary || '';
      ch.kb.summaryNodes = Array.isArray(kb.summaryNodes) ? kb.summaryNodes : [];
      ch.kb.terms = Array.isArray(kb.terms) ? kb.terms : [];
      ch.kb.keyPoints = Array.isArray(kb.keyPoints) ? kb.keyPoints : [];
      ch.kb.mindmap = kb.mindmap || null;
      ch.kb.pseudocode = Array.isArray(kb.pseudocode) ? kb.pseudocode : [];
      // 图片集：ch.kb.figures 只存元数据（caption/explanation/page），dataUrl 存正文缓存避免撑爆 localStorage
      if (collectFigures && figures.length) {
        const aiFigs = Array.isArray(kb.figures) ? kb.figures : [];
        const figureMeta = aiFigs.length
          ? aiFigs.map((f, i) => {
              // 优先按 AI 返回的 idx（对应「图N」编号）精确匹配提取的图片，防止 AI 重排导致图文错位
              let srcIdx = -1;
              if (Number.isFinite(f.idx) && f.idx >= 1 && f.idx <= figures.length) {
                srcIdx = f.idx - 1;
              } else if (figures[i]) {
                srcIdx = i;
              }
              const matched = srcIdx >= 0 ? figures[srcIdx] : null;
              return {
                caption: f.caption || (matched ? matched.caption : ''),
                explanation: f.explanation || '',
                page: f.page || (matched ? matched.page : 0),
                dataUrlIndex: srcIdx >= 0 ? srcIdx : i
              };
            })
          : figures.map((f, i) => ({
              caption: f.caption || '',
              explanation: '',
              page: f.page || 0,
              dataUrlIndex: i
            }));
        ch.kb.figures = figureMeta;
        await bkStoreChapterFigureImages(book, ch, figures);
      } else {
        ch.kb.figures = [];
      }
    } else {
      ch.kb.status = 'failed';
    }
  } catch (err) {
    console.error('章节知识库构建失败:', err);
    ch.kb.status = 'failed';
  }
  bkSaveBooks();
  bkRefreshKbUi();
}

// 把本章提取的图片（dataUrl）存入正文缓存（Electron 磁盘 / IndexedDB），避免占 localStorage 容量
async function bkStoreChapterFigureImages(book, ch, figures) {
  try {
    let cache = null;
    if (typeof bkEnsureTextCache === 'function') {
      try { cache = await bkEnsureTextCache(); } catch (e) { cache = null; }
    }
    if (!cache || !figures || !figures.length) return;
    cache.figures = cache.figures || {};
    cache.figures[ch.id] = figures.map(f => ({
      page: f.page || 0,
      caption: f.caption || '',
      dataUrl: f.dataUrl || ''
    }));
    if (typeof saveBookTextCache === 'function') {
      try { await saveBookTextCache(book.id, cache); } catch (e) {}
    }
  } catch (e) { /* 缓存写入失败不影响主流程 */ }
}

// 读取本章图片 dataUrl 列表（从正文缓存），供渲染展示
async function bkGetChapterFigureImages(ch) {
  try {
    const cache = (typeof bkEnsureTextCache === 'function') ? await bkEnsureTextCache() : null;
    if (!cache || !cache.figures || !ch) return [];
    return cache.figures[ch.id] || [];
  } catch (e) { return []; }
}

// 单独构建一个章节的知识库入队（不影响其他章节；支持排队）
function bkBuildChapter(chapterId, detailLevel) {
  detailLevel = detailLevel || 'standard';
  const book = bkGetActiveBook();
  if (!book) return;
  const ch = (book.chapters || []).find(c => String(c.id) === String(chapterId));
  if (!ch) return;
  const cfg = (typeof getEffectiveApiConfig === 'function') ? getEffectiveApiConfig() : null;
  if (!cfg || !cfg.apiKey || typeof callAiApi !== 'function') {
    alert('请先在「设置 → AI」中配置 API Key，再构建知识库');
    return;
  }
  bkKbEnqueue({ bookId: book.id, mode: 'chapter', chapterId: ch.id, detailLevel });
}

// ── 单章构建执行体（由队列调度执行） ──
async function _bkRunChapterBuild(book, ch, detailLevel) {
  detailLevel = detailLevel || 'standard';
  const cfg = (typeof getEffectiveApiConfig === 'function') ? getEffectiveApiConfig() : null;
  if (!cfg || !cfg.apiKey || typeof callAiApi !== 'function') return;

  // 编程书判断（AI 自动，用户可手动覆盖）：决定构建时是否顺带收集伪代码
  let collectPseudocode = false;
  try { collectPseudocode = await bkEnsurePseudocodeJudged(book, cfg); } catch (e) { collectPseudocode = false; }
  // 图片集：用户手动开关，决定构建时是否顺带收集本章图片及其解释
  const collectFigures = bkShouldCollectFigures(book);

  _bkKbCurrentChapter = ch.title; // 队列条 running 项显示当前章节
  bkRefreshKbUi();

  await _bkBuildChapterCore(book, ch, cfg, collectPseudocode, collectFigures, detailLevel);
  // 若当前正选中该章（且激活书为该任务书），刷新右栏以展示新生成的知识库
  if (typeof bkActiveChapterId !== 'undefined'
    && String(ch.id) === String(bkActiveChapterId)
    && bkGetActiveBook() && String(bkGetActiveBook().id) === String(book.id)
    && typeof bkRenderMain === 'function') {
    bkRenderMain();
  }
}

// 单章重试（真正只重试本章，委托单章构建）
function bkRetryChapter(chapterId) {
  bkBuildChapter(chapterId);
}

// ── 编程书判断与伪代码收集开关 ──
// book.pseudocode = { enabled: boolean, source: 'ai'|'manual', judgedAt }
// enabled=true 时构建知识库顺带收集各章伪代码

// 是否应为本书收集伪代码（无判定记录时返回 false，由 bkEnsurePseudocodeJudged 触发判断）
function bkShouldCollectPseudocode(book) {
  return !!(book && book.pseudocode && book.pseudocode.enabled === true);
}

// AI 自动判断本书是否为编程/算法/计算机类图书（基于书名 + 章节目录），失败保守返回 false
async function bkJudgeProgrammingBook(book, cfg) {
  if (!book || !cfg || !cfg.apiKey) return false;
  const titles = (book.chapters || []).slice(0, 50).map(c => c.title).join('、');
  const systemPrompt = '你是图书分类助手。判断给定教材是否属于「编程/算法/计算机科学」类（书中可能包含伪代码、程序代码、算法步骤描述）。'
    + '\n只输出 JSON：{"isProgramming":true或false}，不要任何解释与代码块包裹。';
  try {
    const res = await callAiApi([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `书名：${book.title}\n章节目录：${titles}` }
    ], cfg, null);
    const raw = (res && (res.cleanText || res.rawReply)) || '';
    const obj = bkSafeParseJson(raw);
    return !!(obj && obj.isProgramming === true);
  } catch (err) {
    console.error('编程书判断失败:', err);
    return false;
  }
}

// 确保本书已有伪代码收集判定：未判定时用 AI 判断一次并写入 book.pseudocode；返回是否收集
async function bkEnsurePseudocodeJudged(book, cfg) {
  if (!book) return false;
  if (book.pseudocode && typeof book.pseudocode.enabled === 'boolean') {
    return book.pseudocode.enabled === true;
  }
  const isProg = await bkJudgeProgrammingBook(book, cfg);
  book.pseudocode = { enabled: isProg, source: 'ai', judgedAt: new Date().toISOString() };
  book.updatedAt = new Date().toISOString();
  bkSaveBooks();
  return isProg;
}

// ═══════════ 图片集收集开关（与伪代码收集并列） ═══════════
// book.figures = { enabled: boolean, judgedAt }；所有教材都可能有图，由用户手动开关。
// 开启后构建/重建知识库时按章提取含图注的页面并让 AI 生成图片解释。

// 是否应为本书收集图片及其解释
function bkShouldCollectFigures(book) {
  return !!(book && book.figures && book.figures.enabled === true);
}

// 判断当前模型是否支持视觉（可接收 image_url 内容块）
// Kimi 支持；GPT-4o/GLM-4V/Qwen-VL 等视觉模型名称关键词命中即视为支持；DeepSeek 等纯文本模型返回 false
function bkIsVisionModel(cfg) {
  const model = String((cfg && cfg.model) || '').toLowerCase();
  if (!model) return false;
  if (/kimi/.test(model)) return true;
  if (/gpt-4o|gpt-4\.1|glm-4v|glm-4\.5v|qwen.*vl|qwen2.*vl|claude-3|claude-4|gemini|doubao-.*vision|step-1v|hunyuan.*vision|gpt-4-vision/i.test(model)) return true;
  return false;
}

// 重新构建全书知识库：所有章节重置为 pending 后全量重建（保留旧数据，构建成功即覆盖）
// 确认后入队 rebuild 任务，支持与其他构建任务排队
function bkRebuildKb() {
  const book = bkGetActiveBook();
  if (!book) return;
  const chapters = book.chapters || [];
  if (chapters.length === 0) return;
  const extraCollect = [
    bkShouldCollectPseudocode(book) ? '伪代码' : '',
    bkShouldCollectFigures(book) ? '图片及其解释' : ''
  ].filter(Boolean);
  const queuedHint = (bkKbQueue.length > 0 || (bkKbBuilding && bkKbCurrentTask))
    ? `<br><small style="color:var(--primary);font-weight:600;">⏳ 当前有构建任务正在进行/排队，本书将加入构建队列，按顺序依次构建。</small>`
    : '';
  bkChooseKbLevel(`确定要重新构建《${escapeHtml(book.title)}》的完整知识库吗？<br><small>将重新生成全部 <b>${chapters.length}</b> 个章节的摘要、术语表、重点与知识导图${extraCollect.length ? '及' + extraCollect.join('、') : ''}，耗时较长，构建过程中可随时停止。<br><span style="color:var(--danger);font-weight:600;">⚠️ 全书构建比较费 token，建议仅构建需要的章节（选中章节 → 摘要导图 → 仅构建本章）。</span>${queuedHint}<br>请选择摘要详细程度：</small>`).then(level => {
    if (!level) return;
    for (const ch of chapters) {
      ch.kb = ch.kb || { status: 'pending', summary: '', terms: [], keyPoints: [], mindmap: null };
      ch.kb.status = 'pending';
    }
    book.updatedAt = new Date().toISOString();
    bkSaveBooks();
    bkRenderKbPanel();
    bkRenderToc();
    bkKbEnqueue({ bookId: book.id, mode: 'rebuild', detailLevel: level });
  });
}

// ═══════════ 知识库详细程度选择弹窗（重构时：更简略 / 不变 / 更详细） ═══════════
// 复用 showCustomConfirm（hideActions 隐藏默认按钮），消息内嵌三个选项按钮
let _bkLevelResolve = null;
function bkChooseKbLevel(message) {
  return new Promise((resolve) => {
    _bkLevelResolve = resolve;
    showCustomConfirm(String(message || '')
      + '<div class="bk-level-options">'
      + '<button class="bk-level-btn" onclick="bkPickKbLevel(\'brief\')">更简略</button>'
      + '<button class="bk-level-btn bk-level-btn-default" onclick="bkPickKbLevel(\'standard\')">不变</button>'
      + '<button class="bk-level-btn" onclick="bkPickKbLevel(\'detailed\')">更详细</button>'
      + '</div>'
      + '<div class="bk-level-hint">更简略：120-220 字摘要，3-6 术语，3-5 重点；不变：250-450 字，5-12 术语，4-8 重点；更详细：450-800 字，8-16 术语，6-12 重点。</div>',
      { hideActions: true, showIcon: false })
      .then(ok => {
        // 兜底：用户点遮罩/取消关闭（未选三档）时也 resolve(null)，避免 Promise 挂起
        if (!ok) {
          const r = _bkLevelResolve;
          _bkLevelResolve = null;
          if (typeof r === 'function') r(null);
        }
      });
  });
}
function bkPickKbLevel(level) {
  const r = _bkLevelResolve;
  _bkLevelResolve = null;
  // 触发 showCustomConfirm 内部 cleanup（关闭弹窗），返回值被忽略，结果以 r(level) 为准
  const cancel = document.getElementById('confirmCancel');
  if (cancel) cancel.click();
  if (typeof r === 'function') r(level);
}

// ── 单章 AI 生成 ──
// 返回 { summary, terms[], keyPoints[], mindmap } 或 null

// 摘要「节点化」输出规范（bkBuildChapterKb 与 bkBuildChapterSummary 共用）
const BK_SUMMARY_NODE_RULE = '摘要必须按节点分条列出（每条以 - 开头，可含   - 二级要点）。'
  + '节点定义：节点＝一个可独立理解的知识单元（定义/分类/判定标准/规则/步骤/定理/结论），一条只承载一件事，格式「- **节点名**：定义与判定说明」。'
  + '节点三条硬性规则：'
  + '①单义——一条只讲一个知识点，禁止把多个知识点塞进一条（如「区分了非陈述句和含变量的句子」必须独立成条）；'
  + '②自足——读者只看这一条即可复述该知识点，并能据此判断某个对象是否属于该概念（给出可操作的判定标准）；'
  + '③判定显式——凡涉及定义/分类/区分/判定，必须写明判定标准，禁止只写「区分了……」而不说明如何区分。'
  + '拆解示例（把一句原文拆成三个节点）：'
  + '- **命题的定义**：能判定真假的陈述句。判定标准：①是陈述句（疑问/感叹/祈使句都不是）；②有确定的真假。'
  + '- **非陈述句与含变量句子的区分**：非陈述句（如「今天下雨吗？」）没有真假；含变量的句子（如「x>3」）代入前真假未定，两者都不是命题。'
  + '- **命题变元与真值**：用 p、q、r 等符号表示命题，命题变元可取的真值为真（T）或假（F）。';

// ═══════════ 知识库详细程度（重构时可选择 更详细/不变/更简略） ═══════════
// detailLevel: 'brief' | 'standard' | 'detailed'；标准档位与历史行为完全一致
const BK_KB_LEVELS = {
  brief:    { summary: '120-220', terms: '3-6', keyPoints: '3-5', mindmap: '2-3', desc: '更简略' },
  standard: { summary: '250-450', terms: '5-12', keyPoints: '4-8', mindmap: '2-4', desc: '不变' },
  detailed: { summary: '450-800', terms: '8-16', keyPoints: '6-12', mindmap: '2-5', desc: '更详细' }
};
function bkKbLevelInfo(level) {
  return BK_KB_LEVELS[level] || BK_KB_LEVELS.standard;
}

async function bkBuildChapterKb(chapter, chapterText, cfg, collectPseudocode, figures, detailLevel) {
  const c = cfg || ((typeof getEffectiveApiConfig === 'function') ? getEffectiveApiConfig() : null);
  if (!c || !c.apiKey) return null;

  // 控制 token：正文过长时取头尾关键片段（阈值可在 设置 → 更多设置 调整）
  let content = bkTruncateChapterText(chapterText);
  if (content.trim().length < 50) content = '（该章节正文较短或无有效文本）';

  // 编程书：构建知识库时顺带提取该章伪代码及其解释（每条 title/code/explanation/page）
  const pseudoField = collectPseudocode
    ? '"pseudocode":[{"title":"伪代码/算法名称","code":"伪代码或程序代码原文（保留原始缩进与换行）","explanation":"解释（作用/输入输出/关键步骤，中文）","page":页码}]'
    : '"pseudocode":[]';

  // 图片集：collectFigures 时，生成图注的中文直译（每条 idx/caption/explanation/page）
  // explanation 以图注忠实直译为主体（防止概括/改写失真）；
  // 多模态模型可真正看图，允许在直译之后追加基于图片实际内容的补充说明（如结构要点、标注含义）
  // 非多模态只依据图注文字直译，禁止臆造
  // idx 必须与下方「图N」编号一一对应（N 从 1 开始），用于构建后精确匹配图片与图注，防止 AI 重排顺序导致图文错位
  const collectFigures = Array.isArray(figures) && figures.length > 0;
  const figuresField = collectFigures
    ? '"figures":[{"idx":1,"caption":"图注原文，如 Figure 1.1 或 图 1-1：xxx","explanation":"图注的中文直译（忠实翻译图注原文）","page":页码}]'
    : '"figures":[]';

  const lv = bkKbLevelInfo(detailLevel); // 详细程度：更简略/不变/更详细（影响摘要字数与各项数量）
  const systemPrompt = '你是「学习导师」，负责为教材章节建立知识库。请基于给出的章节原文，输出结构化知识卡片。'
    + '\n规则：'
    + '\n1. 只输出 JSON，不要任何解释，不要用 Markdown 代码块包裹。'
    + '\n2. JSON 规范：整个 JSON 只输出一行；字符串值内禁止使用 ASCII 双引号（引用或强调一律用中文引号「」），禁止在字符串值内出现真实换行；反斜杠、制表符等特殊字符按 JSON 规范转义（如字符串内换行写 \\n）。'
    + '\n3. 输出格式：'
    + `{"summary":"${lv.summary} 字中文摘要（按节点分条）","summaryNodes":[{"text":"- **节点名**：说明","src":"12"}],"terms":[{"term":"术语/概念","def":"一句话定义"}],"keyPoints":["重点1","重点2","重点3"],"mindmap":{"name":"章节标题","children":[{"name":"子主题","children":[{"name":"更细节"}]}]},${pseudoField},${figuresField}}`
    + `\n4. terms 给出 ${lv.terms} 个关键术语；keyPoints 给出 ${lv.keyPoints} 条重点。`
    + `\n5. mindmap 为知识结构树（${lv.mindmap} 层），name 用中文。`
    + '\n6. summary 的节点化输出规范：\n' + BK_SUMMARY_NODE_RULE
    + `\n7. ⚠️ summary 是核心交付物，必须保持 ${lv.summary} 字、完整详细、覆盖全部重要细节；summaryNodes 只是 summary 的结构化副本，禁止为了生成 summaryNodes 或其他字段而压缩、简化 summary。`
    + '\n8. summaryNodes 与 summary 同源一致：每条 text 就是 summary 中的一条节点（text 为完整一行节点，形如「- **节点名**：定义与判定说明」）。章节原文中「〔第 N 页〕」是页码标记，其后的内容属于 PDF 第 N 页。每条 src 输出该节点核心知识点所属的 PDF 页码（纯数字，1 起始的 PDF 页号；节点内容跨页时取起始页；依据最近的〔第 N 页〕标记判断，无法确定页码时输出空字符串 ""，禁止臆造页码）。'
    + (collectPseudocode
      ? '\n9. pseudocode：提取本章出现的所有伪代码/算法/程序片段，每条含 title（算法或片段名称）、code（原文，保留缩进换行）、explanation（中文解释，说明作用/输入输出/关键步骤）、page（该伪代码所在 PDF 页码，纯数字；依据最近的〔第 N 页〕标记判断，无法确定时输出空字符串 ""，禁止臆造）。若本章无伪代码，输出 []。'
      : '')
    + (collectFigures
      ? '\n' + (collectPseudocode ? '10. ' : '9. ') + 'figures：对下方「本章图片列表」中列出的每张图片（含图注文字）生成图注的中文直译。每条必须含 idx（整数，与列表中的「图N」编号严格一一对应，第 N 张图 idx=N，禁止重排、合并或省略）、caption（该图的图注原文，直接复制列表中的图注）、explanation、page（该图所属 PDF 页码，直接使用列表中给出的页码）。' + (bkIsVisionModel(c) ? 'explanation 的结构：先给出图注的中文直译（忠实翻译图注文字），然后在直译之后用「补充：」引导，基于你实际看到的图片内容追加补充说明（如图中关键结构、标注、箭头或数据的含义），但直译部分必须完整保留、不得被概括或改写。' : '注意：你无法直接查看图片，只能依据图注文字做忠实直译，explanation 就是图注的中文直译，不要概括、改写、省略或补充任何内容，更不要臆造图片细节。') + ' 必须为列表中的每张图各输出一条，且顺序不限（以 idx 为准）。若本章无图片，输出 []。'
      : '');

  // 知识库构建是长输出任务（summary+summaryNodes+terms+keyPoints+mindmap+伪代码），提高输出上限避免压缩摘要质量
  const kbCfg = { ...c, maxTokens: Math.max(c.maxTokens || 0, 8192) };
  const textMsg = `章节标题：${chapter.title}\n\n章节原文：\n${content}`
    + (collectFigures
      ? '\n\n本章图片列表（含图注，按「图N」编号）：\n' + figures.map((f, i) => `图${i + 1}（第 ${f.page} 页）：${f.caption}`).join('\n')
      : '');

  // 多模态模型：把图片作为 image_url 内容块一并发送（模型可真正看图）
  let userContent = textMsg;
  if (collectFigures && bkIsVisionModel(c)) {
    const parts = [{ type: 'text', text: textMsg }];
    for (const f of figures) {
      if (f.dataUrl) parts.push({ type: 'image_url', image_url: { url: f.dataUrl } });
    }
    userContent = parts;
  }

  const res = await callAiApi(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    kbCfg,
    null
  );
  const raw = (res && (res.cleanText || res.rawReply)) || '';
  return bkParseKbJson(raw);
}

// 仅重新生成单章摘要（不影响 terms/keyPoints/mindmap），失败返回 null
async function bkBuildChapterSummary(chapter, chapterText, cfg, detailLevel) {
  const c = cfg || ((typeof getEffectiveApiConfig === 'function') ? getEffectiveApiConfig() : null);
  if (!c || !c.apiKey) return null;

  // 控制 token：正文过长时取头尾关键片段（与 bkBuildChapterKb 一致，阈值可在设置中调整）
  let content = bkTruncateChapterText(chapterText);
  if (content.trim().length < 50) content = '（该章节正文较短或无有效文本）';

  const lv = bkKbLevelInfo(detailLevel); // 详细程度：更简略/不变/更详细
  const systemPrompt = '你是「学习导师」，负责为教材章节撰写摘要。请基于给出的章节原文，按节点分条输出章节摘要。'
    + '\n规则：'
    + '\n1. 只输出 JSON，不要任何解释，不要用 Markdown 代码块包裹。'
    + '\n2. JSON 规范：整个 JSON 只输出一行；字符串值内禁止使用 ASCII 双引号（引用或强调一律用中文引号「」），禁止在字符串值内出现真实换行；反斜杠、制表符等特殊字符按 JSON 规范转义。'
    + `\n3. 输出格式：{"summary":"${lv.summary} 字中文摘要（按节点分条）","summaryNodes":[{"text":"- **节点名**：说明","src":"12"}]}`
    + '\n4. summary 的节点化输出规范：\n' + BK_SUMMARY_NODE_RULE
    + `\n5. ⚠️ summary 是核心交付物，必须保持 ${lv.summary} 字、完整详细、覆盖全部重要细节；禁止为了生成 summaryNodes 而压缩、简化 summary。`
    + '\n6. summaryNodes 与 summary 同源一致：每条 text 就是 summary 中的一条节点。章节原文中「〔第 N 页〕」是页码标记，其后的内容属于 PDF 第 N 页。每条 src 输出该节点核心知识点所属的 PDF 页码（纯数字，1 起始的 PDF 页号；节点内容跨页时取起始页；依据最近的〔第 N 页〕标记判断，无法确定页码时输出空字符串 ""，禁止臆造页码）。';

  // 摘要+summaryNodes 为长输出，提高输出上限避免压缩摘要质量
  const kbCfg = { ...c, maxTokens: Math.max(c.maxTokens || 0, 8192) };
  const res = await callAiApi(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `章节标题：${chapter.title}\n\n章节原文：\n${content}` }
    ],
    kbCfg,
    null
  );
  const raw = (res && (res.cleanText || res.rawReply)) || '';
  const obj = bkParseKbJson(raw);
  if (!obj) return null;
  return {
    summary: (obj.summary || '').trim(),
    summaryNodes: Array.isArray(obj.summaryNodes) ? obj.summaryNodes : []
  };
}

// ═══════════ AI 输出 JSON 容错解析（状态机提取 + 裸引号/换行修复） ═══════════
// AI 常在字符串值内输出未转义的 ASCII 双引号（如 "向左"扭""）或真实换行，导致 JSON.parse 崩溃。
// 三级容错：① 状态机精确提取最外层 JSON 区间；② 修复字符串内裸引号/换行/控制字符后再解析；③ 截断兜底。
// 本组函数放 books-kb.js 顶部，books-ai.js（其后加载）可复用。

// 状态机提取最外层 JSON 对象/数组区间：正确处理字符串值内的 { } [ ] 与引号转义
function bkExtractJsonBlock(text) {
  let inStr = false, esc = false, depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) { esc = false; }
      else if (ch === '\\') { esc = true; }
      else if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; if (start < 0) start = i; continue; }
    if (start < 0) {
      if (ch === '{' || ch === '[') { start = i; depth = 1; }
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // 未找到配对括号（可能因字符串内裸引号误判），退回从起始括号到末尾
  return start >= 0 ? text.slice(start) : null;
}

// 修复字符串值内的非法字符：真实换行/控制字符 → \n；字符串内容中的裸 ASCII 双引号 → 中文左引号「“」
// 启发式：字符串态中遇到 " 且其后（跳过空白）不是 , } ] : 或 EOF，视为内容中的裸引号而非闭合引号
function bkRepairJsonStrings(jsonStr) {
  if (typeof jsonStr !== 'string') return jsonStr;
  let out = '';
  let inStr = false, esc = false;
  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') {
        let j = i + 1;
        while (j < jsonStr.length && /\s/.test(jsonStr[j])) j++;
        const next = jsonStr[j];
        if (j >= jsonStr.length || next === ',' || next === '}' || next === ']' || next === ':') {
          out += ch; inStr = false; continue; // 合法闭合引号
        }
        out += '“'; continue; // 字符串内容中的裸引号 → 中文左引号
      }
      if (ch === '\n' || ch === '\r') { out += '\\n'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      if (ch.charCodeAt(0) < 0x20) { out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'); continue; }
      out += ch; continue;
    }
    if (ch === '"') { out += ch; inStr = true; continue; }
    out += ch;
  }
  return out;
}

// 安全解析 AI 回复中的 JSON：剥离围栏 → 提取区间 → 标准解析 → 修复后重试 → 截断兜底
// 成功返回对象，失败返回 null（不抛异常）
function bkSafeParseJson(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  const first = text.indexOf('{');
  if (first < 0) return null;
  text = text.slice(first);

  const block = bkExtractJsonBlock(text) || text;
  let obj = null;
  try { obj = JSON.parse(block); } catch (e) {}
  if (obj && typeof obj === 'object') return obj;

  const repaired = bkRepairJsonStrings(block);
  try { obj = JSON.parse(repaired); } catch (e) {}
  if (obj && typeof obj === 'object') return obj;

  try {
    const last = repaired.lastIndexOf('}');
    if (last > 0) {
      obj = JSON.parse(repaired.slice(0, last + 1));
      if (obj && typeof obj === 'object') return obj;
    }
  } catch (e2) {}
  return null;
}

// 从 AI 回复中提取知识库 JSON（容错：bkSafeParseJson）
function bkParseKbJson(raw) {
  const obj = bkSafeParseJson(raw);
  if (!obj || typeof obj !== 'object') return null;
  // summaryNodes：摘要节点化结构 [{ text: '- **节点名**：说明', src: '逐字摘录' }]
  const summaryNodes = Array.isArray(obj.summaryNodes)
    ? obj.summaryNodes
        .filter(n => n && typeof n === 'object' && n.text)
        .map(n => ({
          text: String(n.text).trim(),
          src: String(n.src || '').trim()
        }))
        .filter(n => n.text)
        .slice(0, 30)
    : [];
  let summary = String(obj.summary || '').trim();
  // summary 为空时用 summaryNodes 的 text 拼接兜底（保持纯文本可用性）
  if (!summary && summaryNodes.length) {
    summary = summaryNodes.map(n => n.text).join('\n');
  }
  return {
    summary: summary,
    summaryNodes: summaryNodes,
    terms: Array.isArray(obj.terms) ? obj.terms.slice(0, 15) : [],
    keyPoints: Array.isArray(obj.keyPoints) ? obj.keyPoints.slice(0, 10) : [],
    mindmap: (obj.mindmap && typeof obj.mindmap === 'object') ? obj.mindmap : null,
    pseudocode: Array.isArray(obj.pseudocode)
      ? obj.pseudocode
          .filter(p => p && typeof p === 'object')
          .map(p => ({
            title: String(p.title || '').trim(),
            code: String(p.code || '').trim(),
            explanation: String(p.explanation || '').trim(),
            page: (Number(p.page) > 0) ? Number(p.page) : 0
          }))
          .filter(p => p.title || p.code)
          .slice(0, 30)
      : [],
    figures: Array.isArray(obj.figures)
      ? obj.figures
          .filter(f => f && typeof f === 'object')
          .map(f => ({
            idx: (Number(f.idx) >= 1 && Number.isFinite(Number(f.idx))) ? Number(f.idx) : 0,
            caption: String(f.caption || f.num || '').trim(),
            explanation: String(f.explanation || '').trim(),
            page: (Number(f.page) > 0) ? Number(f.page) : 0
          }))
          .filter(f => f.caption)
          .slice(0, 30)
      : []
  };
}
