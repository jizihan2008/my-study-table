// ═══════════════════════════════════════════════════════════════════
//  教材学习（AI 教材工作台）— 数据模型 / 书架 / 工作台三栏 / 章节树
//  依赖（加载顺序见 index.html）：
//    core.js（loadData/saveData/genId）、utils.js（escapeHtml）、ai-utils.js（showCustomConfirm）
//  跨模块接口（由 books-pdf.js / books-kb.js / books-ai.js 提供）：
//    books-pdf.js : parsePdfFile / splitChaptersByOutline / aiSplitChapters /
//                   saveBookTextCache / loadBookTextCache / deleteBookTextCache / getChapterText
//    books-kb.js  : bkRenderKbPanel / bkStartKbBuild / bkStopKbBuild / bkRetryChapter / bkBuildChapterSummary
//    books-ai.js  : bkRenderExplainTab / bkRenderQaTab / bkRenderQuizTab / bkRenderSummaryTab
// ═══════════════════════════════════════════════════════════════════

// ── 数据存储 ──
// localStorage key：study_books_v1（书籍列表：元数据 + 章节树 + 知识库 + 测验记录）
// 正文文本缓存：<userData>/books/<bookId>.json（见 books-pdf.js，避免占 localStorage 容量）
let booksData = loadData('study_books_v1');

// ── 会话状态 ──
let bkActiveBookId = null;
try {
  const raw = localStorage.getItem('study_bk_active_book');
  if (raw) { const n = Number(raw); if (!isNaN(n)) bkActiveBookId = n; }
} catch (e) {}
let bkActiveChapterId = null;
try {
  const chRaw = localStorage.getItem('study_bk_active_chapter');
  if (chRaw) { const n = Number(chRaw); if (!isNaN(n)) bkActiveChapterId = n; }
} catch (e) {}
let bkActiveTab = 'explain'; // explain | qa | quiz | summary
try {
  const savedTab = localStorage.getItem('study_bk_active_tab') || '';
  if (['explain', 'qa', 'quiz', 'summary', 'wrongbook'].includes(savedTab)) bkActiveTab = savedTab;
} catch (e) {}
let bkTextCache = null;      // 当前书籍的正文缓存 { bookId, pages, chapterTexts }

// ── 移动端三级导航状态（仅 ≤800px 或移动设备生效）──
// bkMobileView: 'shelf'（书架）| 'toc'（目录）| 'main'（章节内容）
let bkMobileView = 'shelf';
function bkIsMobileView() {
  return (typeof Env !== 'undefined' && Env.isMobile) ||
    (typeof Env !== 'undefined' && Env.isPwa && window.innerWidth <= 800) ||
    (!(typeof Env !== 'undefined' && Env.isMobile) && !(typeof Env !== 'undefined' && Env.isPwa) && window.innerWidth <= 800);
}
// 移动端进入对应视图
function bkGoShelf() { if (!bkIsMobileView()) return; bkMobileView = 'shelf'; const a = document.getElementById('booksApp'); if (a) a.dataset.bkview = 'shelf'; }
function bkGoToc() { if (!bkIsMobileView()) return; bkMobileView = 'toc'; const a = document.getElementById('booksApp'); if (a) a.dataset.bkview = 'toc'; }

// ── 查询辅助 ──
// id 宽松比较（localStorage 读出为字符串，而 id 为数字，避免类型失配导致找不到书/章）
function bkGetBookById(id) { return booksData.find(b => String(b.id) === String(id)) || null; }
function bkGetActiveBook() { return bkGetBookById(bkActiveBookId); }
function bkGetActiveChapter() {
  const book = bkGetActiveBook();
  if (!book || bkActiveChapterId == null) return null;
  return book.chapters.find(c => String(c.id) === String(bkActiveChapterId)) || null;
}
function bkSaveBooks() {
  saveData('study_books_v1', booksData);
  try {
    if (bkActiveBookId) localStorage.setItem('study_bk_active_book', bkActiveBookId);
    else localStorage.removeItem('study_bk_active_book');
  } catch (e) {}
}

// 持久化当前选中章节与 tab（跨会话恢复「上次学习位置」）
function _bkPersistNav() {
  try {
    if (bkActiveChapterId) localStorage.setItem('study_bk_active_chapter', bkActiveChapterId);
    else localStorage.removeItem('study_bk_active_chapter');
    localStorage.setItem('study_bk_active_tab', bkActiveTab || 'explain');
  } catch (e) {}
}

// 派生书籍级知识库状态（不额外存储，实时计算）
function bkDeriveBookKbState(book) {
  const chapters = book.chapters || [];
  const total = chapters.length;
  const done = chapters.filter(c => c.kb && c.kb.status === 'done').length;
  const building = chapters.some(c => c.kb && c.kb.status === 'building');
  const failed = chapters.some(c => c.kb && c.kb.status === 'failed');
  let status = 'idle';
  if (total > 0 && done === total) status = 'done';
  else if (building) status = 'building';
  else if (done > 0) status = 'partial';
  else if (failed && done === 0) status = 'idle';
  return { status, doneCount: done, total, building, failed };
}

// ═══════════ 书架 / 目录 侧栏显隐（内存 + localStorage 持久化） ═══════════
let _bkShelfHidden = false;
let _bkTocHidden = false;
try {
  const p = JSON.parse(localStorage.getItem('study_bk_panes_v1') || '{}');
  _bkShelfHidden = !!p.shelfHidden;
  _bkTocHidden = !!p.tocHidden;
} catch (e) {}

// 应用显隐状态：面板 display:none，恢复把手（.bk-pane-restore）显示
function bkApplyPanes() {
  const shelf = document.getElementById('bkShelf');
  const toc = document.getElementById('bkToc');
  const shelfRestore = document.getElementById('bkShelfRestore');
  const tocRestore = document.getElementById('bkTocRestore');
  // 移动端三级导航：不应用桌面端「隐藏书架/目录」状态，强制移除 hidden，
  // 否则若用户在桌面端隐藏过目录栏（_bkTocHidden=true），移动端点书后目录被误隐藏而空白。
  if (bkIsMobileView()) {
    if (shelf) shelf.classList.remove('hidden');
    if (toc) toc.classList.remove('hidden');
    if (shelfRestore) shelfRestore.classList.remove('show');
    if (tocRestore) tocRestore.classList.remove('show');
    return;
  }
  if (shelf) shelf.classList.toggle('hidden', _bkShelfHidden);
  if (toc) toc.classList.toggle('hidden', _bkTocHidden);
  if (shelfRestore) shelfRestore.classList.toggle('show', _bkShelfHidden);
  if (tocRestore) tocRestore.classList.toggle('show', _bkTocHidden);
  try {
    localStorage.setItem('study_bk_panes_v1', JSON.stringify({ shelfHidden: _bkShelfHidden, tocHidden: _bkTocHidden }));
  } catch (e) {}
}
function bkToggleShelf() { _bkShelfHidden = !_bkShelfHidden; bkApplyPanes(); }
function bkToggleToc() { _bkTocHidden = !_bkTocHidden; bkApplyPanes(); }

// ═══════════ 主入口：渲染整个工作台 ═══════════
function renderBooks() {
  const app = document.getElementById('booksApp');
  if (!app) return;
  if (bkIsMobileView()) app.dataset.bkview = bkMobileView || 'shelf';
  if (booksData.length === 0) {
    // 手机端空态：提供「从桌面传输 / 本机」入口（PWA 无法本地选文件）
    const emptyActions = bkIsMobileView() && (typeof Env !== 'undefined' && Env.isPwa) ? `
      <button class="bk-quiz-btn primary" onclick="bkImportBook()" style="padding:10px 20px;font-size:13.5px;">
        <i data-lucide="upload" class="lucide-icon" style="width:15px;height:15px;"></i> 导入 PDF
      </button>
      <button class="bk-quiz-btn" onclick="bkShowReceivedPdfs()" style="padding:10px 20px;font-size:13.5px;margin-top:8px;">
        <i data-lucide="folder-open" class="lucide-icon" style="width:15px;height:15px;"></i> 本机已传输的 PDF
      </button>` : `
      <button class="bk-quiz-btn primary" onclick="bkImportBook()" style="padding:10px 20px;font-size:13.5px;">
        <i data-lucide="plus" class="lucide-icon" style="width:15px;height:15px;"></i> 导入 PDF 教材
      </button>`;
    app.innerHTML = `
      <div class="bk-empty-hint" style="height:100%;">
        <i data-lucide="library" class="lucide-icon" style="width:64px;height:64px;"></i>
        <p><b>书架还是空的</b><br>${bkIsMobileView() ? '在电脑端用「发送到手机」把教材传过来<br>或导入 PDF，让 AI 帮你建立章节知识库' : '导入一本 PDF 教材，让 AI 帮你建立章节知识库<br>支持讲解、问答、测验与摘要导图'}</p>
        <div style="display:flex;flex-direction:column;align-items:center;gap:0;">${emptyActions}</div>
      </div>`;
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
    return;
  }
  if (!bkGetActiveBook()) { bkActiveBookId = booksData[0].id; bkActiveChapterId = null; }
  // 上次章节不在当前书（书被删除/重导入）时重置，避免空高亮与空内容
  if (bkActiveChapterId && !bkGetActiveChapter()) {
    bkActiveChapterId = null;
    bkActiveTab = 'explain';
    _bkPersistNav();
  }
  bkTextCache = null; // 切换书籍时惰性加载正文缓存

  // 移动端书架导航头：标题 + 传输入口（桌面端三栏布局下这些元素被 CSS 隐藏）
  const mobileShelfNav = bkIsMobileView() ? `
    <div class="bk-mob-navbar bk-mob-navbar-shelf">
      <span class="bk-mob-navbar-title"><i data-lucide="library" class="lucide-icon" style="width:16px;height:16px;"></i> 教材书架</span>
      <div class="bk-mob-navbar-actions">
        ${(typeof Env !== 'undefined' && Env.isPwa) ? `<button class="bk-add-book-btn" onclick="bkImportBook()" title="从文件导入 PDF 教材"><i data-lucide="upload" class="lucide-icon" style="width:15px;height:15px;"></i><span>导入 PDF</span></button>` : ''}
        ${(typeof Env !== 'undefined' && Env.isPwa) ? `<button class="bk-add-book-btn" onclick="bkShowReceivedPdfs()" title="本机已传输的 PDF"><i data-lucide="folder-open" class="lucide-icon" style="width:15px;height:15px;"></i><span>本机</span></button>` : ''}
      </div>
    </div>` : '';

  const activeBook = bkGetActiveBook();
  const mobBookName = activeBook ? activeBook.title : '';
  // 移动端目录导航头：返回书架 + 书名
  const mobileTocNav = bkIsMobileView() ? `
    <div class="bk-mob-navbar bk-mob-navbar-toc">
      <button class="bk-mob-back" onclick="bkGoShelf()" title="返回书架"><i data-lucide="chevron-left" class="lucide-icon"></i></button>
      <span class="bk-mob-navbar-title bk-mob-navbar-bookname" title="${escapeHtml(mobBookName)}">${escapeHtml(mobBookName)}</span>
    </div>` : '';
  // 移动端内容导航头：返回目录 + 面包屑（书名/章节名）
  const mobChapter = bkGetActiveChapter();
  const mobileMainNav = bkIsMobileView() ? `
    <div class="bk-mob-navbar bk-mob-navbar-main">
      <button class="bk-mob-back" onclick="bkGoToc()" title="返回目录"><i data-lucide="chevron-left" class="lucide-icon"></i></button>
      <div class="bk-mob-navbar-breadcrumb">
        <span class="bk-mob-bc-book" title="${escapeHtml(mobBookName)}">${escapeHtml(mobBookName)}</span>
        ${mobChapter ? `<span class="bk-mob-bc-sep">/</span><span class="bk-mob-bc-chapter" title="${escapeHtml(mobChapter.title)}">${escapeHtml(mobChapter.title)}</span>` : ''}
      </div>
    </div>` : '';

  app.innerHTML = `
    <div class="bk-shelf" id="bkShelf">
      ${mobileShelfNav}
      <div class="bk-shelf-header">
        <span class="bk-shelf-title"><i data-lucide="library" class="lucide-icon" style="width:15px;height:15px;"></i> 书架</span>
        <div class="bk-shelf-actions">
          ${(typeof Env !== 'undefined' && Env.isPwa) ? `<button class="bk-add-book-btn" onclick="bkImportBook()" title="从文件导入 PDF 教材"><i data-lucide="upload" class="lucide-icon" style="width:13px;height:13px;"></i>导入 PDF</button>` : ''}
          ${(typeof Env !== 'undefined' && Env.isPwa) ? `<button class="bk-add-book-btn" onclick="bkShowReceivedPdfs()" title="本机已导入的 PDF"><i data-lucide="folder-open" class="lucide-icon" style="width:13px;height:13px;"></i>本机</button>` : `<button class="bk-add-book-btn" onclick="bkImportBook()" title="导入 PDF 教材"><i data-lucide="plus" class="lucide-icon" style="width:13px;height:13px;"></i>导入</button>`}
          <button class="bk-pane-toggle" onclick="bkToggleShelf()" title="隐藏书架"><i data-lucide="panel-left-close" class="lucide-icon" style="width:13px;height:13px;"></i></button>
        </div>
      </div>
      <div class="bk-shelf-list" id="bkShelfList"></div>
    </div>
    <div class="bk-pane-restore" id="bkShelfRestore" title="显示书架">
      <button onclick="bkToggleShelf()"><i data-lucide="panel-left-open" class="lucide-icon" style="width:14px;height:14px;"></i><span>书架</span></button>
    </div>
    <div class="bk-toc" id="bkToc">
      ${mobileTocNav}
      <div class="bk-toc-header">
        <div class="bk-toc-title">
          <i data-lucide="list-tree" class="lucide-icon" style="width:15px;height:15px;"></i> <span id="bkTocTitle">章节目录</span>
        </div>
        <div class="bk-toc-toolbar">
          <button class="bk-toc-btn bk-toc-hide-btn" onclick="bkToggleToc()" title="隐藏目录"><i data-lucide="panel-left-close" class="lucide-icon" style="width:12px;height:12px;"></i>隐藏</button>
          <button class="bk-toc-btn" id="bkTocExpandAll" onclick="bkExpandAllToc(true)" title="展开全部目录"><i data-lucide="chevrons-down-up" class="lucide-icon" style="width:12px;height:12px;"></i>全部展开</button>
          <button class="bk-toc-btn" id="bkTocCollapseAll" onclick="bkExpandAllToc(false)" title="折叠全部目录"><i data-lucide="chevrons-up-down" class="lucide-icon" style="width:12px;height:12px;"></i>全部折叠</button>
        </div>
        <div id="bkKbPanel"></div>
        <div class="bk-kb-current" id="bkKbCurrent"></div>
      </div>
      <div class="bk-toc-list" id="bkTocList"></div>
    </div>
    <div class="bk-pane-restore" id="bkTocRestore" title="显示目录">
      <button onclick="bkToggleToc()"><i data-lucide="panel-left-open" class="lucide-icon" style="width:14px;height:14px;"></i><span>目录</span></button>
    </div>
    <div class="bk-main">
      ${mobileMainNav}
      <div class="bk-main-head" id="bkMainHead"></div>
      <div class="bk-main-tabs" id="bkMainTabs"></div>
      <div class="bk-main-body" id="bkMainBody"></div>
    </div>`;

  bkRenderShelfList();
  bkRenderToc();
  bkRenderMain();
  bkApplyPanes();
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
}

// ═══════════ 左栏：书架列表 ═══════════
function bkRenderShelfList() {
  const list = document.getElementById('bkShelfList');
  if (!list) return;
  list.innerHTML = booksData.map(b => {
    const st = bkDeriveBookKbState(b);
    const active = b.id === bkActiveBookId;
    const badgeCls = st.status === 'done' ? 'bk-badge-done'
      : st.status === 'building' ? 'bk-badge-building'
      : st.status === 'partial' ? 'bk-badge-partial' : 'bk-badge-pending';
    const badgeText = st.status === 'done' ? '已建库'
      : st.status === 'building' ? '构建中'
      : st.status === 'partial' ? st.doneCount + '/' + st.total : '未建库';
    // 移动端：书架卡片右下角提供删除入口（隐藏桌面行内操作区）
    const mobileDel = bkIsMobileView() ? `
      <button class="bk-book-del-btn bk-book-del-mobile" onclick="event.stopPropagation();bkDeleteBook(${b.id})" title="删除教材">
        <i data-lucide="trash-2" class="lucide-icon" style="width:16px;height:16px;"></i>
      </button>` : '';
    return `
      <div class="bk-book-item ${active ? 'active' : ''}" onclick="bkSelectBook(${b.id})" title="${escapeHtml(b.title)}">
        <div class="bk-book-cover"><i data-lucide="book-open" class="lucide-icon"></i></div>
        <div class="bk-book-meta">
          <div class="bk-book-name">${escapeHtml(b.title)}</div>
          <div class="bk-book-sub">${(b.chapters || []).length} 章 · ${b.pageCount || 0} 页</div>
        </div>
        <span class="bk-book-kb-badge ${badgeCls}">${badgeText}</span>
        ${mobileDel}
        <div class="bk-book-actions">
          <button class="bk-book-del-btn" onclick="event.stopPropagation();bkReimportBook(${b.id})" title="重新导入（重新解析 PDF）"><i data-lucide="refresh-cw" class="lucide-icon" style="width:12px;height:12px;"></i></button>
          <button class="bk-book-del-btn" onclick="event.stopPropagation();bkDeleteBook(${b.id})" title="删除教材"><i data-lucide="trash-2" class="lucide-icon" style="width:12px;height:12px;"></i></button>
        </div>
      </div>`;
  }).join('');
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
}

function bkSelectBook(id) {
  bkActiveBookId = id;
  bkActiveChapterId = null;
  bkActiveTab = 'explain';
  _bkPersistNav();
  bkTextCache = null;
  bkSaveBooks();
  if (bkIsMobileView()) { bkMobileView = 'toc'; renderBooks(); return; }
  renderBooks();
}

function bkDeleteBook(id) {
  showCustomConfirm('确定删除该教材？<br><small>知识库与正文缓存将一并清除，不可恢复。</small>', { dontAskKey: 'study_dontask_delete_book' }).then(confirmed => {
    if (!confirmed) return;
    booksData = booksData.filter(b => b.id !== id);
    if (bkActiveBookId === id) {
      bkActiveBookId = booksData.length ? booksData[0].id : null;
      bkActiveChapterId = null;
      bkActiveTab = 'explain';
    }
    _bkPersistNav();
    bkSaveBooks();
    if (typeof deleteBookTextCache === 'function') deleteBookTextCache(id);
    // PWA 本机导入的 PDF：同时清理 IndexedDB 中的原始字节
    if (window.BookPdfStore && typeof window.BookPdfStore.remove === 'function') {
      try { window.BookPdfStore.remove(id); } catch (e) {}
    }
    renderBooks();
  });
}

// ═══════════ 中栏：章节树 + 知识库面板 ═══════════
// 折叠状态（内存级）：Set 存已折叠的节点 key（实体节点用 id 字符串）
let _bkCollapsedToc = new Set();

function bkToggleTocGroup(el) {
  const key = el && el.dataset ? el.dataset.key : '';
  if (!key) return;
  if (_bkCollapsedToc.has(key)) _bkCollapsedToc.delete(key);
  else _bkCollapsedToc.add(key);
  bkRenderToc();
}

// 全部展开 / 全部折叠（仅折叠状态；实体树折叠 key 为 node.id 字符串）
function bkExpandAllToc(expand) {
  const book = bkGetActiveBook();
  if (!book) return;
  if (expand) {
    _bkCollapsedToc.clear();
  } else {
    // 收集所有非叶节点 id
    const nonLeaf = new Set();
    const collect = (nodes) => {
      for (const c of nodes || []) {
        if (Array.isArray(c.children) && c.children.length > 0) {
          nonLeaf.add(String(c.id));
          collect((book.chapters || []).filter(x => c.children.includes(x.id)));
        }
      }
    };
    collect(bkBuildEntityRoots(book.chapters));
    _bkCollapsedToc = nonLeaf;
  }
  bkRenderToc();
}

// 实体树：根据 children 数组递归取根节点列表（顶层节点 parentId 为 null 或无父引用）
function bkBuildEntityRoots(chapters) {
  const byId = {};
  for (const c of chapters || []) byId[c.id] = c;
  const roots = [];
  for (const c of chapters || []) {
    const hasParent = c.parentId != null && byId[c.parentId];
    if (!hasParent) roots.push(c);
  }
  // 按起始页排序保证顶层顺序稳定
  roots.sort((a, b) => (a.startPage || 0) - (b.startPage || 0));
  return roots;
}

// 渲染实体树目录 HTML：非叶节点（children 非空）与叶节点均可选中，
// 非叶节点额外提供折叠箭头；所有节点展示知识库状态徽章
function bkRenderEntityTreeHtml(roots, book, depth = 0) {
  let html = '';
  const badgeMap = {
    done: '<span class="bk-chapter-badge ok">已建</span>',
    building: '<span class="bk-chapter-badge building">构建中</span>',
    failed: '<span class="bk-chapter-badge fail">失败</span>',
    pending: '<span class="bk-chapter-badge pending">待建</span>'
  };
  for (const node of roots) {
    const kids = (node.children || []).map(cid => (book.chapters || []).find(x => x.id === cid)).filter(Boolean);
    const hasKids = kids.length > 0;
    const collapsed = hasKids && _bkCollapsedToc.has(String(node.id));
    const active = node.id === bkActiveChapterId;
    const st = (node.kb && node.kb.status) || 'pending';
    const badge = badgeMap[st] || '';
    if (hasKids) {
      // 非叶节点：整行可选中（讲解/知识库/问答等），箭头单独折叠
      html += `
        <div class="bk-chapter-group${active ? ' active' : ''}${collapsed ? ' collapsed' : ''}"
             style="padding-left:${8 + depth * 14}px"
             onclick="bkSelectChapter(${node.id})" title="${escapeHtml(node.title)}">
          <span class="bk-chapter-arrow" data-key="${node.id}" onclick="event.stopPropagation();bkToggleTocGroup(this)">${collapsed ? '▸' : '▾'}</span>
          <span class="bk-chapter-name">${escapeHtml(node.title)}</span>${badge}
        </div>`;
      if (!collapsed) html += bkRenderEntityTreeHtml(kids, book, depth + 1);
    } else {
      // 叶节点
      html += `
        <div class="bk-chapter ${active ? 'active' : ''}" style="padding-left:${10 + (depth + 1) * 14}px"
             onclick="bkSelectChapter(${node.id})" title="${escapeHtml(node.title)}">
          <span class="bk-chapter-name">${escapeHtml(node.title)}</span>${badge}
        </div>`;
    }
  }
  return html;
}

// 兼容旧数据（无 children 实体树，仅有 ancestors 分组）：按 ancestors 构建虚拟分组树
// 返回 { groups: [{ title, level, path, chapterIds, children }], orphans: [chapterId] }
function bkBuildChapterTree(chapters) {
  const root = { title: null, level: -1, path: '', chapterIds: [], children: [] };
  const walk = (node, ancestors, chapter) => {
    if (!ancestors || ancestors.length === 0) { node.chapterIds.push(chapter.id); return; }
    const title = ancestors[0];
    let child = node.children.find(c => c.title === title);
    if (!child) {
      const path = node.path ? node.path + ' › ' + title : title;
      child = { title, level: node.level + 1, path, chapterIds: [], children: [] };
      node.children.push(child);
    }
    walk(child, ancestors.slice(1), chapter);
  };
  for (const c of chapters || []) walk(root, (c.ancestors || []).slice(), c);
  return { groups: root.children, orphans: root.chapterIds };
}

// 渲染虚拟分组树目录 HTML（旧数据，分组仅折叠不可选中）
function bkRenderChapterTreeHtml(tree, book, depth = 0) {
  let html = '';
  const badgeMap = {
    done: '<span class="bk-chapter-badge ok">已建</span>',
    building: '<span class="bk-chapter-badge building">构建中</span>',
    failed: '<span class="bk-chapter-badge fail">失败</span>',
    pending: '<span class="bk-chapter-badge pending">待建</span>'
  };
  for (const node of tree) {
    const collapsed = _bkCollapsedToc.has(node.path);
    html += `
      <div class="bk-chapter-group${collapsed ? ' collapsed' : ''}" data-key="${escapeHtml(node.path)}"
           style="padding-left:${8 + depth * 14}px" onclick="bkToggleTocGroup(this)" title="${escapeHtml(node.title)}">
        <span class="bk-chapter-arrow">${collapsed ? '▸' : '▾'}</span>
        <span class="bk-chapter-name">${escapeHtml(node.title)}</span>
      </div>`;
    if (!collapsed) {
      for (const cid of node.chapterIds) {
        const c = book.chapters.find(x => x.id === cid);
        if (!c) continue;
        const active = c.id === bkActiveChapterId;
        const st = (c.kb && c.kb.status) || 'pending';
        const indent = (depth + 1) * 14;
        html += `
          <div class="bk-chapter ${active ? 'active' : ''}" style="padding-left:${10 + indent}px"
               onclick="bkSelectChapter(${c.id})" title="${escapeHtml(c.title)}">
            <span class="bk-chapter-name">${escapeHtml(c.title)}</span>${badgeMap[st] || ''}
          </div>`;
      }
      html += bkRenderChapterTreeHtml(node.children, book, depth + 1);
    }
  }
  return html;
}

function bkRenderToc() {
  const book = bkGetActiveBook();
  const titleEl = document.getElementById('bkTocTitle');
  const list = document.getElementById('bkTocList');
  if (!book || !titleEl || !list) return;
  titleEl.textContent = book.title.length > 14 ? book.title.slice(0, 14) + '…' : book.title;

  // 知识库面板（进度 + 操作按钮）由 books-kb.js 负责渲染
  const kbPanel = document.getElementById('bkKbPanel');
  if (kbPanel) {
    if (typeof bkRenderKbPanel === 'function') bkRenderKbPanel();
    else kbPanel.innerHTML = '';
  }

  if (!book.chapters || book.chapters.length === 0) {
    list.innerHTML = `
      <div class="bk-toc-empty">
        <i data-lucide="list-tree" class="lucide-icon" style="width:40px;height:40px;"></i>
        <p>本书尚未切分章节<br>点击上方「构建知识库」开始</p>
      </div>`;
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
    return;
  }

  // 多层级目录：实体树（splitChaptersAtLevel 产出，节点带 children）优先；
  // 其次旧数据 ancestors 虚拟分组；最后扁平渲染
  const hasEntityTree = book.chapters.some(c => Array.isArray(c.children) && c.children.length > 0);
  if (hasEntityTree) {
    const roots = bkBuildEntityRoots(book.chapters);
    list.innerHTML = bkRenderEntityTreeHtml(roots, book);
  } else if (book.chapters.some(c => c.ancestors && c.ancestors.length > 0)) {
    const { groups, orphans } = bkBuildChapterTree(book.chapters);
    const badgeMap = {
      done: '<span class="bk-chapter-badge ok">已建</span>',
      building: '<span class="bk-chapter-badge building">构建中</span>',
      failed: '<span class="bk-chapter-badge fail">失败</span>',
      pending: '<span class="bk-chapter-badge pending">待建</span>'
    };
    // 无祖先的顶层章（orphans）先渲染
    let html = orphans.map(cid => {
      const c = book.chapters.find(x => x.id === cid);
      if (!c) return '';
      const active = c.id === bkActiveChapterId;
      const st = (c.kb && c.kb.status) || 'pending';
      return `
        <div class="bk-chapter ${active ? 'active' : ''}" style="padding-left:10px"
             onclick="bkSelectChapter(${c.id})" title="${escapeHtml(c.title)}">
          <span class="bk-chapter-name">${escapeHtml(c.title)}</span>${badgeMap[st] || ''}
        </div>`;
    }).join('');
    html += bkRenderChapterTreeHtml(groups, book);
    list.innerHTML = html;
  } else {
    const badgeMap = {
      done: '<span class="bk-chapter-badge ok">已建</span>',
      building: '<span class="bk-chapter-badge building">构建中</span>',
      failed: '<span class="bk-chapter-badge fail">失败</span>',
      pending: '<span class="bk-chapter-badge pending">待建</span>'
    };
    list.innerHTML = book.chapters.map(c => {
      const active = c.id === bkActiveChapterId;
      const st = (c.kb && c.kb.status) || 'pending';
      const indent = Math.min(c.level || 0, 3) * 14;
      return `
        <div class="bk-chapter ${active ? 'active' : ''}" style="padding-left:${10 + indent}px"
             onclick="bkSelectChapter(${c.id})" title="${escapeHtml(c.title)}">
          <span class="bk-chapter-name">${escapeHtml(c.title)}</span>${badgeMap[st] || ''}
        </div>`;
    }).join('');
  }
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
}

function bkSelectChapter(id) {
  bkActiveChapterId = id;
  // 点击章节优先跳到「摘要导图」；知识库尚未构建时保留「章节讲解」（摘要页无可看内容）
  const ch = bkGetActiveChapter();
  bkActiveTab = (ch && ch.kb && ch.kb.status === 'done') ? 'summary' : 'explain';
  _bkPersistNav();
  if (bkIsMobileView()) { bkMobileView = 'main'; renderBooks(); return; }
  bkRenderToc();
  bkRenderMain();
}

// ═══════════ 右栏：头部 + tab + 内容 ═══════════
function bkRenderMain() {
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  const head = document.getElementById('bkMainHead');
  const tabs = document.getElementById('bkMainTabs');
  if (!book || !head || !tabs) return;

  head.innerHTML = `
    <div class="bk-main-title"><i data-lucide="book-open" class="lucide-icon" style="width:18px;height:18px;"></i>${escapeHtml(book.title)}</div>
    ${chapter ? `<div class="bk-main-bookname">${escapeHtml(chapter.title)}</div>` : ''}
    <div class="bk-chapter-nav">
      <button class="bk-chapter-nav-btn" onclick="bkNavChapter(-1)" title="上一章"><i data-lucide="chevron-left" class="lucide-icon" style="width:14px;height:14px;"></i></button>
      <button class="bk-chapter-nav-btn" onclick="bkNavChapter(1)" title="下一章"><i data-lucide="chevron-right" class="lucide-icon" style="width:14px;height:14px;"></i></button>
    </div>`;

  const tabDefs = [
    { id: 'explain', icon: 'graduation-cap', label: '章节讲解' },
    { id: 'qa',      icon: 'message-circle-question', label: '全书问答' },
    { id: 'quiz',    icon: 'list-checks',     label: '测验练习' },
    { id: 'summary', icon: 'network',         label: '摘要导图' },
    { id: 'wrongbook', icon: 'book-x',        label: '错题本' }
  ];
  tabs.innerHTML = tabDefs.map(t =>
    `<button class="bk-tab-btn ${bkActiveTab === t.id ? 'active' : ''}" onclick="bkSwitchTab('${t.id}')">
      <i data-lucide="${t.icon}" class="lucide-icon" style="width:14px;height:14px;"></i>${t.label}
    </button>`
  ).join('');

  bkRenderTabBody();
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
}

function bkSwitchTab(tab) {
  bkActiveTab = tab;
  _bkPersistNav();
  bkRenderMain();
}

// 目录隐藏时的「上一章 / 下一章」导航
function bkNavChapter(dir) {
  const book = bkGetActiveBook();
  if (!book) return;
  const chapters = book.chapters || [];
  if (chapters.length === 0) return;
  const idx = chapters.findIndex(c => String(c.id) === String(bkActiveChapterId));
  if (idx < 0) return;
  const target = idx + dir;
  if (target < 0 || target >= chapters.length) return;
  bkSelectChapter(chapters[target].id);
}

// 渲染右栏 tab 内容（委托给 books-ai.js）
function bkRenderTabBody() {
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  const body = document.getElementById('bkMainBody');
  if (!body || !book) return;

  if (!chapter) {
    body.innerHTML = `
      <div class="bk-empty-hint">
        <i data-lucide="mouse-pointer-click" class="lucide-icon" style="width:52px;height:52px;"></i>
        <p>请在左侧选择要学习的章节</p>
      </div>`;
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
    return;
  }

  const fnMap = {
    explain: 'bkRenderExplainTab',
    qa: 'bkRenderQaTab',
    quiz: 'bkRenderQuizTab',
    summary: 'bkRenderSummaryTab',
    wrongbook: 'bkRenderWrongbookTab'
  };
  const fn = fnMap[bkActiveTab];
  if (fn && typeof window[fn] === 'function') {
    window[fn](book, chapter);
  } else {
    body.innerHTML = '<div class="bk-empty-hint"><p>该功能模块尚未加载，请重启应用。</p></div>';
  }
}

// ═══════════ 章节颗粒度选择 ═══════════
// 递归遍历 outline，收集每层级的条目（含子级数量）
function bkCollectOutlineLevels(outline, level = 0, result = null) {
  if (!result) result = { maxLevel: 0, levels: [] };
  if (level > result.maxLevel) result.maxLevel = level;
  if (!result.levels[level]) result.levels[level] = { items: 0, withPage: 0 };
  const bucket = result.levels[level];
  for (const o of outline || []) {
    bucket.items++;
    if (o.page && o.page > 0) bucket.withPage++;
    if (o.items && o.items.length) bkCollectOutlineLevels(o.items, level + 1, result);
  }
  return result;
}

// 渲染目录树 HTML（到指定层级，多层级缩进展示）
function bkRenderOutlineTreeHtml(outline, maxLevel, level = 0) {
  let html = '';
  for (const o of outline || []) {
    const t = String(o.title || '').trim() || '（无标题）';
    const pageTxt = (o.page && o.page > 0) ? `<span class="bk-gran-page">p.${o.page}</span>` : '';
    const kids = (o.items && o.items.length) ? o.items.length : 0;
    const kidTxt = (level < maxLevel && kids > 0) ? `<span class="bk-gran-kids">${kids}</span>` : '';
    const hasMore = (level >= maxLevel && kids > 0) ? `<span class="bk-gran-more">+${kids} 项</span>` : '';
    html += `<div class="bk-gran-row" style="padding-left:${level * 22}px">
      <span class="bk-gran-bullet">${(level < maxLevel && kids > 0) ? '▾' : '·'}</span>
      <span class="bk-gran-name">${escapeHtml(t)}</span>${kidTxt}${hasMore}${pageTxt}
    </div>`;
    if (level < maxLevel && o.items && o.items.length) {
      html += bkRenderOutlineTreeHtml(o.items, maxLevel, level + 1);
    }
  }
  return html;
}

// 询问用户章节划分颗粒度；返回 Promise<chapterLevel(0基)>，取消返回 null
// source：'toc'（从原书目录页解析）或 'outline'（从 PDF 书签解析），用于说明识别方式
function bkAskChapterGranularity(outline, source) {
  const info = bkCollectOutlineLevels(outline);
  const totalLevels = info.maxLevel + 1; // 层级数量（1 基）
  // 判断书是否含 Part 分组（如 Sipser 的 Part One/Two/Three）
  const hasParts = (outline || []).some(o => /^part\s/i.test(String(o.title || '')));
  // 每层的语义名称：有 Part 时 Part/章/节/小节，无 Part 时 章/节/小节
  const levelNames = hasParts ? ['Part', '章', '节', '小节', '第四级', '第五级'] : ['章', '节', '小节', '第四级', '第五级'];
  // 默认选中「章」层：有 Part 时章在 level1，无 Part 时章在 level0
  const defaultLevel = hasParts ? 1 : 0;
  return new Promise((resolve) => {
    const levelsHtml = [];
    for (let i = 0; i < totalLevels; i++) {
      const lv = info.levels[i] || { items: 0, withPage: 0 };
      levelsHtml.push(`<button class="bk-gran-lvl" data-level="${i}" ${i === defaultLevel ? 'data-default="1"' : ''}>
        <b>${levelNames[i] || ('层级 ' + (i + 1))}</b>
        <span>${lv.items} 项</span>
      </button>`);
    }
    bkShowOverlay(`
      <div style="width:520px;max-width:92vw;text-align:left;font-size:13px;color:var(--text);">
        <div style="font-size:16px;font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:8px;">
          <i data-lucide="list-tree" class="lucide-icon" style="width:18px;height:18px;"></i>选择章节划分颗粒度
        </div>
        <div style="font-size:12.5px;color:var(--text-secondary);margin-bottom:14px;line-height:1.7;">
          检测到本书目录包含 <b>${totalLevels}</b> 个层级。请选择将哪一层作为「章」：
          <div style="margin-top:6px;padding:8px 10px;background:var(--hover-bg,#f4f4f5);border-radius:8px;font-size:12px;">
            <b>识别方式：</b>${source === 'toc'
              ? '从原书目录页（Contents）提取，按「章节编号位数」分层——一位数编号为章（如 1），两位为节（1.1），三位为小节（1.1.1）。'
              : '从 PDF 自带书签（Outline）提取，按书签缩进层级分层。'}
          </div>
        </div>
        <div class="bk-gran-levels" id="bkGranLevels">${levelsHtml.join('')}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin:12px 0 6px;font-weight:500;">目录预览（展开至所选层级）：</div>
        <div class="bk-gran-tree" id="bkGranTree"></div>
        <div class="bk-gran-actions">
          <button class="confirm-btn confirm-btn-cancel" id="bkGranCancel">取消</button>
          <button class="confirm-btn confirm-btn-ok" id="bkGranOk">按此划分章节</button>
        </div>
      </div>`, { width: 560 });
    const treeEl = document.getElementById('bkGranTree');
    let selected = defaultLevel;   // 默认选中「章」层，并展开预览到该层

    const renderTree = () => {
      if (treeEl) treeEl.innerHTML = bkRenderOutlineTreeHtml(outline, selected, 0);
      document.querySelectorAll('#bkGranLevels .bk-gran-lvl').forEach((el) => {
        el.classList.toggle('active', Number(el.dataset.level) === selected);
      });
    };
    const onLvlClick = (e) => {
      const btn = e.target.closest('.bk-gran-lvl');
      if (!btn) return;
      selected = Number(btn.dataset.level);
      renderTree();
    };
    document.getElementById('bkGranLevels').addEventListener('click', onLvlClick);
    // 首次渲染默认选中「章」层
    renderTree();

    const cleanup = (val) => {
      document.getElementById('bkGranLevels').removeEventListener('click', onLvlClick);
      bkHideOverlay();
      resolve(val);
    };
    document.getElementById('bkGranCancel').addEventListener('click', () => cleanup(null));
    document.getElementById('bkGranOk').addEventListener('click', () => {
      if (selected < 0) { alert('请先选择章节层级'); return; }
      cleanup(selected);
    });

    // 默认选中层级：顶层若项数过多(>30)则选中第 2 层，否则顶层
    const topCount = (info.levels[0] && info.levels[0].items) || 0;
    selected = topCount > 30 ? 1 : 0;
    if (selected >= totalLevels) selected = totalLevels - 1;
    renderTree();
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
  });
}

// ═══════════ WebRTC：发送 PDF 到手机（桌面端）═══════════
// 查看本机已导入的 PDF
function bkShowReceivedPdfs() {
  if (typeof window.BookPdfStore === 'undefined') { alert('PDF 存储模块未加载'); return; }
  window.BookPdfStore.list().then(function (items) {
    let html = '';
    if (items.length === 0) {
      html = '<div class="bk-kb-empty">本机暂无已导入的 PDF。请先「导入 PDF」从文件中选择教材。</div>';
    } else {
      html = items.map(function (it) {
        return `<div class="bk-kb-card" style="display:flex;align-items:center;gap:10px;margin-bottom:8px;padding:12px 14px;">
          <i data-lucide="file-text" class="lucide-icon" style="width:18px;height:18px;color:var(--primary);"></i>
          <div style="flex:1;min-width:0;">
            <div style="font-size:13.5px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(it.fileName || ('Book ' + it.bookId))}</div>
            <div style="font-size:11px;color:var(--text-secondary);">${(it.size / 1024 / 1024).toFixed(1)} MB · ${new Date(it.savedAt).toLocaleString()}</div>
          </div>
          <button class="bk-quiz-btn primary" style="padding:6px 12px;font-size:12px;" onclick="bkOpenReceivedPdf('${escapeJs(it.bookId)}')">阅读</button>
          <button class="bk-quiz-btn" style="padding:6px 10px;font-size:12px;background:transparent;border-color:var(--border);" onclick="bkDeleteReceivedPdf('${escapeJs(it.bookId)}')">删除</button>
        </div>`;
      }).join('');
    }
    const overlay = document.createElement('div');
    overlay.className = 'bk-original-overlay';
    overlay.innerHTML = `
      <div class="bk-original-panel" style="max-width:560px;">
        <div class="bk-original-head">
          <span class="bk-original-title"><i data-lucide="folder-open" class="lucide-icon" style="width:15px;height:15px;"></i> 本机已导入的 PDF</span>
          <button class="bk-original-close" onclick="this.closest('.bk-original-overlay').remove()"><i data-lucide="x" class="lucide-icon" style="width:16px;height:16px;"></i></button>
        </div>
        <div class="bk-original-body" style="white-space:normal;">${html}</div>
      </div>`;
    document.body.appendChild(overlay);
    if (typeof lucide !== 'undefined') setTimeout(() => { try { lucide.createIcons(); } catch (e) {} }, 0);
  });
}

// 打开已传输的 PDF（读 IndexedDB 后用 pdf.js 渲染）
function bkOpenReceivedPdf(bookId) {
  window.BookPdfStore.read(bookId).then(function (data) {
    if (!data) { alert('未找到该 PDF 数据'); return; }
    // 构造一个虚拟 book 对象，复用 bkOpenPdfAtPage 的数据源分流
    const fakeBook = { id: bookId, title: '已传输 PDF', filePath: '' };
    if (typeof bkOpenPdfAtPage === 'function') {
      bkOpenPdfAtPage(null, null, fakeBook);
    } else {
      alert('PDF 阅读模块未加载');
    }
  });
}

async function bkDeleteReceivedPdf(bookId) {
  if (!confirm('确定删除本机上的这份 PDF 吗？')) return;
  await window.BookPdfStore.remove(bookId);
  bkShowReceivedPdfs();
}

// ═══════════ 导入流程 ═══════════
// PWA/浏览器：用 <input type=file> 选择 PDF（iOS 可从「文件」App 选择）
function _bkPickPdfFileBrowser() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = function () {
      const file = input.files && input.files[0];
      document.body.removeChild(input);
      if (!file) { resolve(null); return; }
      file.arrayBuffer().then((ab) => {
        resolve({ name: file.name, data: new Uint8Array(ab) });
      }).catch(() => resolve(null));
    };
    input.oncancel = function () { document.body.removeChild(input); resolve(null); };
    input.click();
  });
}

// 计算两个书名的相似度（0~1），用于导入时匹配已有书目
function _bkTitleSimilarity(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[_\-—]+/g, '');
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.8;
  // 简单公共子串比例
  let common = 0;
  for (let i = 0; i < Math.min(x.length, y.length); i++) { if (x[i] === y[i]) common++; else break; }
  const prefix = common / Math.max(x.length, y.length);
  return Math.min(0.7, prefix);
}

// 导入时询问用户：新建书目 or 匹配已有书目
// 返回 Promise<{ mode:'new'|'match', title, bookId? }>；用户取消返回 null
function bkAskImportMode(defaultTitle) {
  return new Promise((resolve) => {
    // 计算匹配候选（按文件名/标题相似度）
    const normTitle = String(defaultTitle || '').replace(/\.pdf$/i, '');
    const candidates = (booksData || []).map((b) => ({
      book: b,
      sim: Math.max(
        _bkTitleSimilarity(normTitle, b.title),
        _bkTitleSimilarity(normTitle, b.fileName),
        _bkTitleSimilarity(b.fileName, normTitle)
      )
    })).filter((c) => c.sim >= 0.5)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 5);

    const overlay = document.createElement('div');
    overlay.className = 'bk-original-overlay';
    overlay.innerHTML = `
      <div class="bk-original-panel" style="max-width:460px;">
        <div class="bk-original-head">
          <span class="bk-original-title"><i data-lucide="file-input" class="lucide-icon" style="width:15px;height:15px;"></i> 导入教材</span>
          <button class="bk-original-close" onclick="this.closest('.bk-original-overlay').remove();window._bkImportModeResolve(null)"><i data-lucide="x" class="lucide-icon" style="width:16px;height:16px;"></i></button>
        </div>
        <div class="bk-original-body" style="padding:16px 18px 20px;text-align:left;white-space:normal;">
          <!-- 文件名确认条 -->
          <div style="display:flex;align-items:center;gap:8px;background:var(--hover-bg,#f4f4f5);border:1px solid var(--border);border-radius:9px;padding:9px 12px;margin-bottom:14px;">
            <i data-lucide="file-text" class="lucide-icon" style="width:15px;height:15px;color:var(--primary);flex-shrink:0;"></i>
            <span style="font-size:12.5px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(defaultTitle || '')}</span>
          </div>

          <!-- 匹配已有书目 -->
          ${candidates.length ? `
          <div style="margin-bottom:14px;">
            <div style="font-size:12px;color:var(--text-secondary);font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
              <i data-lucide="git-merge" class="lucide-icon" style="width:13px;height:13px;"></i> 已有相似书目（匹配将沿用章节与学习进度）
            </div>
            ${candidates.map((c) => `
            <button class="bk-match-card" data-match-id="${c.book.id}">
              <span class="bk-match-name" title="${escapeHtml(c.book.title)}">${escapeHtml(c.book.title)}</span>
              <span class="bk-match-pct" style="${c.sim >= 0.85 ? 'background:var(--primary);color:#fff;' : ''}">${Math.round(c.sim * 100)}%</span>
            </button>`).join('')}
          </div>` : `
          <div style="display:flex;align-items:center;gap:8px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:9px;padding:9px 12px;margin-bottom:14px;">
            <i data-lucide="search-x" class="lucide-icon" style="width:15px;height:15px;color:#f59e0b;flex-shrink:0;"></i>
            <span style="font-size:12px;color:var(--text);">未检测到相似书目，将新建一本教材。</span>
          </div>`}

          <!-- 分隔 -->
          <div style="display:flex;align-items:center;gap:10px;margin:14px 0;">
            <div style="flex:1;height:1px;background:var(--border);"></div>
            <span style="font-size:11px;color:var(--text-secondary);">或</span>
            <div style="flex:1;height:1px;background:var(--border);"></div>
          </div>

          <!-- 新建书目 -->
          <div style="margin-bottom:16px;">
            <label style="font-size:12px;color:var(--text-secondary);font-weight:600;display:block;margin-bottom:6px;">书名（可修改）</label>
            <input id="bkImportTitleInput" value="${escapeHtml(normTitle)}" placeholder="输入书名"
              style="width:100%;height:40px;font-size:14px;padding:0 12px;border:2px solid var(--border);border-radius:9px;background:var(--input-bg);color:var(--text);outline:none;box-sizing:border-box;">
          </div>

          <button class="bk-quiz-btn primary" data-mode-new style="width:100%;padding:12px;font-size:13.5px;justify-content:center;">
            <i data-lucide="plus" class="lucide-icon" style="width:16px;height:16px;"></i> 新建书目并解析
          </button>
          <div style="margin-top:8px;font-size:11px;color:var(--text-secondary);line-height:1.6;">新建会完整解析 PDF 并切分章节；匹配已有书目则直接沿用该书内容，无需解析。</div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    if (typeof lucide !== 'undefined') setTimeout(() => { try { lucide.createIcons(); } catch (e) {} }, 0);
    const titleInput = overlay.querySelector('#bkImportTitleInput');
    setTimeout(() => titleInput && titleInput.focus(), 100);

    const finish = (mode, bookId) => {
      const t = titleInput ? titleInput.value.trim() : '';
      const resolved = { mode: mode, title: t || String(defaultTitle || '').replace(/\.pdf$/i, '') };
      if (mode === 'match') resolved.bookId = bookId;
      overlay.remove();
      window._bkImportModeResolve(resolved);
    };
    overlay.querySelectorAll('[data-match-id]').forEach((btn) => {
      btn.addEventListener('click', () => finish('match', btn.getAttribute('data-match-id')));
    });
    overlay.querySelector('[data-mode-new]').addEventListener('click', () => finish('new'));
    window._bkImportModeResolve = resolve;
  });
}

async function bkImportBook() {
  if (typeof parsePdfFile !== 'function') {
    alert('PDF 解析模块未加载，请重启应用');
    return;
  }
  // 读取 PDF：Electron 用文件对话框；PWA/浏览器用 <input type=file>（iOS 可从「文件」App 选择）
  let pdfData = null;       // Uint8Array / ArrayBuffer
  let fileName = '';
  let filePath = null;
  try {
    if (window.electronAPI && window.electronAPI.pickPdfFile) {
      filePath = await window.electronAPI.pickPdfFile();
      if (!filePath) return;
      const buf = await window.electronAPI.readPdfFile(filePath);
      if (!buf) { alert('无法读取所选 PDF 文件'); return; }
      pdfData = buf;
      fileName = String(filePath).split(/[\\/]/).pop() || '未命名.pdf';
    } else {
      // PWA/浏览器：文件选择
      const picked = await _bkPickPdfFileBrowser();
      if (!picked) return;
      pdfData = picked.data;
      fileName = picked.name;
    }
    if (!pdfData) return;

    const title = fileName.replace(/\.pdf$/i, '').trim() || '未命名教材';

    // 询问用户：新建书目 or 匹配已有书目（放在解析之前，匹配则无需重新解析）
    const importChoice = await bkAskImportMode(fileName);
    if (!importChoice) return; // 用户取消导入
    const finalTitle = importChoice.title || title;
    const isPwaImport = !window.electronAPI || !window.electronAPI.readPdfFile;

    // 匹配已有书目：沿用旧书的章节与正文缓存，保留学习进度，不重新解析；
    // 但把新选的 PDF 字节存入本机（PWA 用 IndexedDB，供阅读时打开新 PDF）
    if (importChoice.mode === 'match') {
      const book = bkGetBookById(importChoice.bookId);
      if (!book) { alert('未找到要匹配的书目'); return; }
      book.title = finalTitle;
      book.fileName = fileName;
      book.updatedAt = new Date().toISOString();
      // PWA：用新 PDF 替换本机存储（替换旧的），阅读时打开这份新 PDF
      if (isPwaImport && typeof BookPdfStore !== 'undefined') {
        await BookPdfStore.put(book.id, pdfData, fileName);
      }
      bkSaveBooks();
      bkActiveBookId = book.id;
      bkActiveChapterId = book.chapters && book.chapters.length ? book.chapters[0].id : null;
      bkActiveTab = 'summary';
      _bkPersistNav();
      bkTextCache = null;
      renderBooks();
      bkRenderMain();
      return;
    }

    // ── 新建书目：才需要解析 PDF ──
    const onProgress = (p) => {
      bkShowOverlay(`<div class="bk-import-box">
        <div class="bk-spinner" style="width:26px;height:26px;"></div>
        <p style="margin:10px 0 6px;font-size:14px;color:var(--text);font-weight:600;">正在解析 PDF…</p>
        <p style="margin:0;font-size:12px;color:var(--text-secondary);">${escapeHtml(p && p.text ? p.text : '')}</p>
        ${p && p.percent != null ? `<div class="bk-kb-bar" style="width:280px;margin-top:10px;">
          <div class="bk-kb-bar-fill"><div class="bk-kb-bar-inner" style="width:${Math.round(p.percent)}%"></div></div>
          <span>${Math.round(p.percent)}%</span></div>` : ''}
      </div>`);
    };

    bkShowOverlay('<div class="bk-import-box"><div class="bk-spinner" style="width:26px;height:26px;"></div><p style="margin:12px 0 0;font-size:13.5px;color:var(--text);">正在解析 PDF…</p></div>');

    // 解析 PDF：提取逐页文本 + outline
    const parsed = await parsePdfFile(pdfData, onProgress);
    if (!parsed || !parsed.pages || parsed.pages.length === 0) {
      bkHideOverlay();
      alert('PDF 解析失败：未能提取到文本（可能是扫描版 PDF，目前仅支持带文字层的电子版）');
      return;
    }

    // 章节切分：优先从原书目录页（Contents）解析完整层级，其次 outline，最后 AI 辅助
    let chapters = null;
    let granLevel = 0; // 用户选择的颗粒度层级
    onProgress({ text: '正在切分章节…', percent: 99 });
    // ① 原书目录页解析（最完整、干净，含子章节结构；同样支持用户选择颗粒度）
    if (typeof parseContentsFromToc === 'function' && parsed.tocTexts && parsed.tocTexts.length) {
      try {
        const tocChapters = parseContentsFromToc(parsed.tocTexts, parsed.pageCount);
        if (tocChapters && tocChapters.length) {
          if (typeof bkAskChapterGranularity === 'function' && typeof splitChaptersAtLevel === 'function') {
            const info = bkCollectOutlineLevels(tocChapters);
            if (info.maxLevel > 0) {
              bkHideOverlay();
              const picked = await bkAskChapterGranularity(tocChapters, 'toc');
              if (picked === null) return; // 用户取消导入
              granLevel = picked;
              onProgress({ text: '正在切分章节…', percent: 99 });
              chapters = splitChaptersAtLevel(tocChapters, parsed.pageCount, granLevel);
            } else {
              chapters = splitChaptersAtLevel(tocChapters, parsed.pageCount, 0);
            }
          } else {
            chapters = splitChaptersAtLevel(tocChapters, parsed.pageCount, 0);
          }
        }
      } catch (e) { chapters = null; }
    }
    // ② outline（书签）解析
    if (!chapters && parsed.outline && parsed.outline.length > 0) {
      // 多层级目录：询问用户章节划分颗粒度
      if (typeof bkAskChapterGranularity === 'function' && typeof splitChaptersAtLevel === 'function') {
        const info = bkCollectOutlineLevels(parsed.outline);
        if (info.maxLevel > 0) {
          bkHideOverlay();
          const picked = await bkAskChapterGranularity(parsed.outline, 'outline');
          if (picked === null) return; // 用户取消导入
          granLevel = picked;
          onProgress({ text: '正在切分章节…', percent: 99 });
          chapters = splitChaptersAtLevel(parsed.outline, parsed.pageCount, granLevel);
        }
      }
      if (!chapters) chapters = splitChaptersByOutline(parsed.outline, parsed.pageCount);
    }
    // ③ AI 辅助切分：仅当目录页解析和书签都未得到章节时才走 AI（独立判断，不挂在 else 上，
    //   避免目录/书签已成功时误触发 AI）
    if (!chapters && typeof aiSplitChapters === 'function') {
      chapters = await aiSplitChapters(parsed.pages, (msg) => onProgress({ text: msg, percent: 99 }));
    }
    if (!chapters || chapters.length === 0) {
      // 兜底：整本作为一章
      chapters = [{ id: genId(), title: title, level: 0, startPage: 1, endPage: parsed.pageCount, kb: { status: 'pending', summary: '', terms: [], keyPoints: [], mindmap: null } }];
    }

    // 新建书目
    const book = {
      id: genId(),
      title: finalTitle,
      fileName: fileName,
      filePath: isPwaImport ? null : filePath,
      importedLocally: isPwaImport ? true : false,
      pageCount: parsed.pageCount,
      chapters: chapters,
      quizRecords: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    booksData.push(book);
    // PWA：把 PDF 原始字节存入 IndexedDB（供阅读时 bkOpenPdfAtPage 现场解析）
    if (isPwaImport && typeof BookPdfStore !== 'undefined') {
      await BookPdfStore.put(book.id, pdfData, fileName);
    }
    bkActiveBookId = book.id;
    bkActiveChapterId = book.chapters && book.chapters.length ? book.chapters[0].id : null;
    bkActiveTab = 'summary';
    _bkPersistNav();
    bkTextCache = null;
    bkSaveBooks();

    // 持久化正文缓存（pages + 各章文本拼接）
    if (typeof saveBookTextCache === 'function') {
      onProgress({ text: '正在保存正文缓存…', percent: 100 });
      const chapterTexts = {};
      for (const c of chapters) {
        chapterTexts[c.id] = bkJoinChapterText(parsed.pages, c);
      }
      await saveBookTextCache(book.id, { bookId: book.id, pages: parsed.pages, chapterTexts: chapterTexts });
    }

    bkHideOverlay();
    renderBooks();
    // 进入摘要 tab 引导用户构建知识库
    bkRenderMain();
  } catch (err) {
    bkHideOverlay();
    alert('导入失败：' + String((err && err.message) || err));
  }
}

// 重新导入：按原文件路径重新解析，重建章节与正文缓存
async function bkReimportBook(id) {
  const book = bkGetBookById(id);
  if (!book) return;
  const confirmed = await showCustomConfirm('重新解析该教材？<br><small>章节切分与知识库将重建，原学习进度与测验记录保留。</small>');
  if (!confirmed) return;
  if (typeof parsePdfFile !== 'function') { alert('PDF 解析模块未加载'); return; }
  try {
    // 读取 PDF：Electron 用原文件路径；PWA 用 IndexedDB 中的原始字节
    let pdfData = null;
    if (window.electronAPI && window.electronAPI.readPdfFile) {
      pdfData = await window.electronAPI.readPdfFile(book.filePath);
    } else if (window.BookPdfStore && typeof window.BookPdfStore.read === 'function') {
      pdfData = await window.BookPdfStore.read(book.id);
    }
    if (!pdfData) { alert('无法读取原 PDF 文件（文件可能已被移动或未导入）'); return; }
    const onProgress = (p) => {
      bkShowOverlay(`<div class="bk-import-box">
        <div class="bk-spinner" style="width:26px;height:26px;"></div>
        <p style="margin:10px 0 6px;font-size:14px;color:var(--text);font-weight:600;">正在重新解析…</p>
        <p style="margin:0;font-size:12px;color:var(--text-secondary);">${escapeHtml(p && p.text ? p.text : '')}</p>
        ${p && p.percent != null ? `<div class="bk-kb-bar" style="width:280px;margin-top:10px;">
          <div class="bk-kb-bar-fill"><div class="bk-kb-bar-inner" style="width:${Math.round(p.percent)}%"></div></div>
          <span>${Math.round(p.percent)}%</span></div>` : ''}
      </div>`);
    };
    bkShowOverlay('<div class="bk-import-box"><div class="bk-spinner" style="width:26px;height:26px;"></div><p style="margin:12px 0 0;font-size:13.5px;color:var(--text);">正在重新解析 PDF…</p></div>');
    const parsed = await parsePdfFile(pdfData, onProgress);
    let chapters = null;
    // ① 原书目录页解析（与 bkImportBook 一致）
    if (typeof parseContentsFromToc === 'function' && parsed.tocTexts && parsed.tocTexts.length) {
      try {
        const tocChapters = parseContentsFromToc(parsed.tocTexts, parsed.pageCount);
        if (tocChapters && tocChapters.length) {
          if (typeof bkAskChapterGranularity === 'function' && typeof splitChaptersAtLevel === 'function') {
            const info = bkCollectOutlineLevels(tocChapters);
            if (info.maxLevel > 0) {
              bkHideOverlay();
              const picked = await bkAskChapterGranularity(tocChapters, 'toc');
              if (picked === null) return; // 用户取消重新导入
              onProgress({ text: '正在切分章节…', percent: 99 });
              chapters = splitChaptersAtLevel(tocChapters, parsed.pageCount, picked);
            } else {
              chapters = splitChaptersAtLevel(tocChapters, parsed.pageCount, 0);
            }
          } else {
            chapters = splitChaptersAtLevel(tocChapters, parsed.pageCount, 0);
          }
        }
      } catch (e) { chapters = null; }
    }
    // ② outline（书签）解析
    if (!chapters && parsed.outline && parsed.outline.length > 0) {
      // 多层级目录：询问用户章节划分颗粒度
      if (typeof bkAskChapterGranularity === 'function' && typeof splitChaptersAtLevel === 'function') {
        const info = bkCollectOutlineLevels(parsed.outline);
        if (info.maxLevel > 0) {
          bkHideOverlay();
          const picked = await bkAskChapterGranularity(parsed.outline, 'outline');
          if (picked === null) return; // 用户取消重新导入
          onProgress({ text: '正在切分章节…', percent: 99 });
          chapters = splitChaptersAtLevel(parsed.outline, parsed.pageCount, picked);
        }
      }
      if (!chapters) chapters = splitChaptersByOutline(parsed.outline, parsed.pageCount);
    }
    // ③ AI 辅助切分：仅当目录页解析和书签都未得到章节时才走 AI（独立判断，避免误触发）
    if (!chapters && typeof aiSplitChapters === 'function') {
      chapters = await aiSplitChapters(parsed.pages, (msg) => onProgress({ text: msg, percent: 99 }));
    }
    if (!chapters || chapters.length === 0) {
      chapters = [{ id: genId(), title: book.title, level: 0, startPage: 1, endPage: parsed.pageCount, kb: { status: 'pending', summary: '', terms: [], keyPoints: [], mindmap: null } }];
    }
    book.chapters = chapters;
    book.pageCount = parsed.pageCount;
    book.updatedAt = new Date().toISOString();
    bkSaveBooks();
    if (typeof saveBookTextCache === 'function') {
      const chapterTexts = {};
      for (const c of chapters) chapterTexts[c.id] = bkJoinChapterText(parsed.pages, c);
      await saveBookTextCache(book.id, { bookId: book.id, pages: parsed.pages, chapterTexts: chapterTexts });
    }
    bkHideOverlay();
    bkActiveChapterId = null;
    renderBooks();
  } catch (err) {
    bkHideOverlay();
    alert('重新导入失败：' + String((err && err.message) || err));
  }
}

// 拼接章节正文（从逐页文本中截取）
function bkJoinChapterText(pages, chapter) {
  const start = Math.max(1, chapter.startPage || 1);
  const end = Math.min(pages.length, chapter.endPage || pages.length);
  const parts = [];
  for (let i = start; i <= end; i++) {
    const t = pages[i - 1];
    if (t && t.trim()) parts.push(t.trim());
  }
  return parts.join('\n\n');
}

// ═══════════ 正文缓存访问（惰性） ═══════════
async function bkEnsureTextCache() {
  const book = bkGetActiveBook();
  if (!book) return null;
  if (bkTextCache && bkTextCache.bookId === book.id) return bkTextCache;
  if (typeof loadBookTextCache === 'function') {
    try { bkTextCache = await loadBookTextCache(book.id); } catch (e) { bkTextCache = null; }
  }
  if (!bkTextCache) {
    bkTextCache = { bookId: book.id, pages: [], chapterTexts: {} };
  }
  return bkTextCache;
}

// 获取指定章节的正文文本（缓存优先，未命中则返回空）
async function bkGetChapterText(chapter) {
  const cache = await bkEnsureTextCache();
  if (!cache || !chapter) return '';
  if (cache.chapterTexts && cache.chapterTexts[chapter.id]) return cache.chapterTexts[chapter.id];
  // 缓存缺失时尝试按页码重建
  if (cache.pages && cache.pages.length && typeof getChapterText === 'function') {
    try { return await getChapterText(cache, chapter); } catch (e) { return ''; }
  }
  return '';
}

// 全书页文本（用于问答检索）
async function bkGetAllPages() {
  const cache = await bkEnsureTextCache();
  return (cache && cache.pages) || [];
}

// ═══════════ 导入/解析进度浮层 ═══════════
let _bkOverlayEl = null;
function bkShowOverlay(html, opts = {}) {
  if (!_bkOverlayEl || !document.body.contains(_bkOverlayEl)) {
    _bkOverlayEl = document.createElement('div');
    _bkOverlayEl.style.cssText = 'position:fixed;inset:0;background:var(--modal-overlay,rgba(0,0,0,0.4));display:flex;align-items:center;justify-content:center;z-index:9999;';
    document.body.appendChild(_bkOverlayEl);
  }
  _bkOverlayEl.innerHTML = `<div style="background:var(--modal-bg,#fff);border-radius:14px;padding:28px 34px;display:flex;flex-direction:column;align-items:center;box-shadow:var(--shadow-lg);max-width:${opts.width || 420}px;">${html}</div>`;
}
function bkHideOverlay() {
  if (_bkOverlayEl) { try { _bkOverlayEl.remove(); } catch (e) {} _bkOverlayEl = null; }
}

// ═══════════ 工具 ═══════════
// 截取文本片段（用于问答检索时的上下文控制）
function bkSnippet(text, maxLen) {
  if (typeof text !== 'string') return '';
  const len = maxLen || 600;
  if (text.length <= len) return text;
  const half = Math.floor(len / 2);
  return text.slice(0, half) + '…\n[中间内容已省略]…\n' + text.slice(-half);
}

// 章节检索：按关键词加权匹配，返回排名靠前的章节
function bkSearchChapters(book, query) {
  const chapters = book.chapters || [];
  if (chapters.length === 0) return [];
  // 中文按 bigram、英文按词分词
  function tokenize(s) {
    const lower = String(s || '').toLowerCase();
    const tokens = [];
    // 英文/数字词
    const words = lower.match(/[a-z0-9]{2,}/g);
    if (words) tokens.push(...words.map(w => w.slice(0, 8)));
    // 中文 bigram
    const cjk = lower.replace(/[a-z0-9\s]/g, '');
    for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk.slice(i, i + 2));
    return tokens.filter(Boolean);
  }
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const scored = chapters.map(ch => {
    const kb = ch.kb || {};
    const termText = (kb.terms || []).map(t => (t && (t.term || '')) + ' ' + (t && (t.def || ''))).join(' ');
    const haystack = (ch.title + ' ' + (kb.summary || '') + ' ' + termText + ' ' + (kb.keyPoints || []).join(' ')).toLowerCase();
    let score = 0;
    for (const t of qTokens) {
      if (haystack.includes(t)) score++;
    }
    return { ch, score };
  });
  return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map(s => s.ch);
}
