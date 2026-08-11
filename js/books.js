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
  if (booksData.length === 0) {
    app.innerHTML = `
      <div class="bk-empty-hint" style="height:100%;">
        <i data-lucide="library" class="lucide-icon" style="width:64px;height:64px;"></i>
        <p><b>书架还是空的</b><br>导入一本 PDF 教材，让 AI 帮你建立章节知识库<br>支持讲解、问答、测验与摘要导图</p>
        <button class="bk-quiz-btn primary" onclick="bkImportBook()" style="padding:10px 20px;font-size:13.5px;">
          <i data-lucide="plus" class="lucide-icon" style="width:15px;height:15px;"></i> 导入 PDF 教材
        </button>
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

  app.innerHTML = `
    <div class="bk-shelf" id="bkShelf">
      <div class="bk-shelf-header">
        <span class="bk-shelf-title"><i data-lucide="library" class="lucide-icon" style="width:15px;height:15px;"></i> 书架</span>
        <div class="bk-shelf-actions">
          ${(typeof Env !== 'undefined' && Env.isPwa) ? `<button class="bk-add-book-btn" onclick="bkReceiveFromPhone()" title="从桌面端传输 PDF（WebRTC 局域网）"><i data-lucide="download" class="lucide-icon" style="width:13px;height:13px;"></i>从桌面传输</button>` : ''}
          ${(typeof Env !== 'undefined' && Env.isPwa) ? `<button class="bk-add-book-btn" onclick="bkShowReceivedPdfs()" title="本机已传输的 PDF"><i data-lucide="folder-open" class="lucide-icon" style="width:13px;height:13px;"></i>本机</button>` : `<button class="bk-add-book-btn" onclick="bkImportBook()" title="导入 PDF 教材"><i data-lucide="plus" class="lucide-icon" style="width:13px;height:13px;"></i>导入</button>`}
          <button class="bk-pane-toggle" onclick="bkToggleShelf()" title="隐藏书架"><i data-lucide="panel-left-close" class="lucide-icon" style="width:13px;height:13px;"></i></button>
        </div>
      </div>
      <div class="bk-shelf-list" id="bkShelfList"></div>
    </div>
    <div class="bk-pane-restore" id="bkShelfRestore" title="显示书架">
      <button onclick="bkToggleShelf()"><i data-lucide="panel-left-open" class="lucide-icon" style="width:14px;height:14px;"></i><span>书架</span></button>
    </div>
    <div class="bk-toc" id="bkToc">
      <div class="bk-toc-header">
        <div class="bk-toc-title">
          <i data-lucide="list-tree" class="lucide-icon" style="width:15px;height:15px;"></i> <span id="bkTocTitle">章节目录</span>
        </div>
        <div class="bk-toc-toolbar">
          <button class="bk-toc-btn" onclick="bkToggleToc()" title="隐藏目录"><i data-lucide="panel-left-close" class="lucide-icon" style="width:12px;height:12px;"></i>隐藏</button>
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
    return `
      <div class="bk-book-item ${active ? 'active' : ''}" onclick="bkSelectBook(${b.id})" title="${escapeHtml(b.title)}">
        <div class="bk-book-cover"><i data-lucide="book-open" class="lucide-icon"></i></div>
        <div class="bk-book-meta">
          <div class="bk-book-name">${escapeHtml(b.title)}</div>
          <div class="bk-book-sub">${(b.chapters || []).length} 章 · ${b.pageCount || 0} 页</div>
        </div>
        <span class="bk-book-kb-badge ${badgeCls}">${badgeText}</span>
        <div class="bk-book-actions">
          ${(typeof Env !== 'undefined' && Env.isElectron) ? `<button class="bk-book-del-btn" onclick="event.stopPropagation();bkSendToPhone(${b.id})" title="发送到手机（WebRTC 局域网传输）"><i data-lucide="send" class="lucide-icon" style="width:12px;height:12px;"></i></button>` : ''}
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
function bkAskChapterGranularity(outline) {
  const info = bkCollectOutlineLevels(outline);
  const totalLevels = info.maxLevel + 1; // 层级数量（1 基）
  return new Promise((resolve) => {
    const levelsHtml = [];
    for (let i = 0; i < totalLevels; i++) {
      const lv = info.levels[i] || { items: 0, withPage: 0 };
      levelsHtml.push(`<button class="bk-gran-lvl" data-level="${i}">
        <b>层级 ${i + 1}</b>
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
    let selected = -1;

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
// 弹窗展示配对码，等待手机端「从桌面传输」输入并连接，然后发送当前书 PDF
function bkSendToPhone(bookId) {
  if (typeof window.WebRtcSend === 'undefined') { alert('WebRTC 发送模块未加载'); return; }
  const book = booksData.find(b => String(b.id) === String(bookId));
  if (!book) { alert('未找到该教材'); return; }
  if (!window.electronAPI || !window.electronAPI.readPdfFile) { alert('当前环境无法读取本地 PDF'); return; }

  const code = window.WebRtcSend.generateCode();
  let pairStarted = false;

  // 构建弹窗
  const overlay = document.createElement('div');
  overlay.className = 'bk-original-overlay';
  overlay.innerHTML = `
    <div class="bk-original-panel" style="max-width:520px;">
      <div class="bk-original-head">
        <span class="bk-original-title"><i data-lucide="send" class="lucide-icon" style="width:15px;height:15px;"></i> 发送「${escapeHtml(book.title)}」到手机</span>
        <button class="bk-original-close" onclick="this.closest('.bk-original-overlay').remove()"><i data-lucide="x" class="lucide-icon" style="width:16px;height:16px;"></i></button>
      </div>
      <div class="bk-original-body" id="bkSendPhoneBody" style="text-align:center;">
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:6px;">请在手机端「教材 → 从桌面传输」输入以下配对码：</div>
        <div style="font-size:38px;font-weight:800;letter-spacing:8px;color:var(--primary);font-family:monospace;margin:8px 0;">${code}</div>
        <div id="bkSendPhoneStatus" style="font-size:13px;color:var(--text-secondary);margin-top:8px;">等待手机连接…</div>
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:center;">
          <button class="btn-save-settings" style="background:#ef4444;width:auto;" onclick="this.closest('.bk-original-overlay').querySelector('.bk-original-close').click()">取消</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  if (typeof lucide !== 'undefined') setTimeout(() => { try { lucide.createIcons(); } catch (e) {} }, 0);

  const statusEl = overlay.querySelector('#bkSendPhoneStatus');
  const setStatus = (msg, cls) => {
    statusEl.textContent = msg;
    if (cls) statusEl.style.color = cls === 'err' ? 'var(--danger)' : 'var(--primary)';
    else statusEl.style.color = 'var(--text-secondary)';
  };

  const onStatus = (st) => {
    if (st.phase === 'connecting') setStatus('已检测到手机，正在建立连接…', '');
    else if (st.phase === 'connected') {
      setStatus('连接已建立，正在读取并发送 PDF…', '');
      sendFile();
    } else if (st.phase === 'transfer') {
      setStatus('发送中：' + (st.progress || 0) + '%', '');
    } else if (st.phase === 'done') {
      setStatus('✅ 发送完成！', '');
      setTimeout(() => overlay.remove(), 1200);
    } else if (st.phase === 'error') {
      setStatus('⚠️ ' + st.message, 'err');
      window.WebRtcSend.stopPair();
    }
  };

  async function sendFile() {
    try {
      const buffer = await window.electronAPI.readPdfFile(book.filePath);
      if (!buffer) { setStatus('⚠️ 无法读取 PDF 文件', 'err'); return; }
      await window.WebRtcSend.sendPdf(buffer, book.id, book.fileName || (book.title + '.pdf'), function (p) {
        setStatus('发送中：' + p + '%', '');
      });
    } catch (e) {
      setStatus('⚠️ 读取文件失败：' + String(e), 'err');
    }
  }

  // 启动配对
  window.WebRtcSend.startPair({ onStatus: onStatus });

  // 关闭时清理
  overlay.querySelector('.bk-original-close').addEventListener('click', function () {
    window.WebRtcSend.stopPair();
  });
}

// ═══════════ WebRTC：从桌面接收 PDF（手机端 PWA）═══════
function bkReceiveFromPhone() {
  if (typeof window.WebRtcRecv === 'undefined') { alert('WebRTC 接收模块未加载'); return; }

  const overlay = document.createElement('div');
  overlay.className = 'bk-original-overlay';
  overlay.innerHTML = `
    <div class="bk-original-panel" style="max-width:520px;">
      <div class="bk-original-head">
        <span class="bk-original-title"><i data-lucide="download" class="lucide-icon" style="width:15px;height:15px;"></i> 从桌面端传输 PDF</span>
        <button class="bk-original-close" onclick="this.closest('.bk-original-overlay').remove()"><i data-lucide="x" class="lucide-icon" style="width:16px;height:16px;"></i></button>
      </div>
      <div class="bk-original-body" style="text-align:center;">
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">请在电脑端「教材 → 发送到手机」生成配对码，然后在此输入 6 位配对码：</div>
        <input id="bkRecvCodeInput" value="" placeholder="6 位配对码" maxlength="6"
          style="width:200px;height:46px;font-size:22px;font-family:monospace;letter-spacing:6px;text-align:center;
                 border:2px solid var(--border);border-radius:10px;background:var(--input-bg);color:var(--text);outline:none;"
          oninput="this.value=this.value.replace(/\\D/g,'')">
        <div id="bkRecvStatus" style="font-size:13px;color:var(--text-secondary);margin-top:12px;min-height:20px;">请输入配对码</div>
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:center;">
          <button class="btn-save-settings" style="background:var(--primary);width:auto;min-width:120px;" onclick="bkRecvConnect()">开始接收</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  if (typeof lucide !== 'undefined') setTimeout(() => { try { lucide.createIcons(); } catch (e) {} }, 0);
  const codeInput = overlay.querySelector('#bkRecvCodeInput');
  setTimeout(() => codeInput.focus(), 100);

  overlay.querySelector('.bk-original-close').addEventListener('click', function () {
    window.WebRtcRecv.stopReceive();
  });

  window._bkRecvOverlay = overlay;
  window._bkRecvStatusEl = overlay.querySelector('#bkRecvStatus');
}

function bkRecvConnect() {
  if (typeof window.WebRtcRecv === 'undefined') return;
  const input = document.querySelector('#bkRecvCodeInput');
  const code = input ? input.value : '';
  if (code.length !== 6) {
    const s = window._bkRecvStatusEl;
    if (s) { s.textContent = '请输入 6 位配对码'; s.style.color = 'var(--danger)'; }
    return;
  }
  window.WebRtcRecv.startReceive(code, {
    onStatus: function (st) {
      const s = window._bkRecvStatusEl;
      if (!s) return;
      s.style.color = 'var(--text-secondary)';
      if (st.phase === 'waiting') s.textContent = '等待桌面端连接…（' + st.message + '）';
      else if (st.phase === 'connecting') s.textContent = '连接建立中…';
      else if (st.phase === 'transfer') s.textContent = st.progress !== undefined ? '接收中：' + st.progress + '%' : st.message;
      else if (st.phase === 'done') {
        s.textContent = '✅ ' + st.message;
        s.style.color = 'var(--done)';
        setTimeout(() => { if (window._bkRecvOverlay) window._bkRecvOverlay.remove(); }, 1500);
      } else if (st.phase === 'error') { s.textContent = '⚠️ ' + st.message; s.style.color = 'var(--danger)'; }
    }
  });
}

// 查看本机已通过 WebRTC 传输的 PDF
function bkShowReceivedPdfs() {
  if (typeof window.BookPdfStore === 'undefined') { alert('PDF 存储模块未加载'); return; }
  window.BookPdfStore.list().then(function (items) {
    let html = '';
    if (items.length === 0) {
      html = '<div class="bk-kb-empty">本机暂无已传输的 PDF。请先在电脑端「发送到手机」，再在手机端「从桌面传输」拉取。</div>';
    } else {
      html = items.map(function (it) {
        return `<div class="bk-kb-card" style="display:flex;align-items:center;gap:10px;margin-bottom:8px;padding:12px 14px;">
          <i data-lucide="file-text" class="lucide-icon" style="width:18px;height:18px;color:var(--primary);"></i>
          <div style="flex:1;min-width:0;">
            <div style="font-size:13.5px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(it.fileName || ('Book ' + it.bookId))}</div>
            <div style="font-size:11px;color:var(--text-secondary);">${(it.size / 1024 / 1024).toFixed(1)} MB · ${new Date(it.savedAt).toLocaleString()}</div>
          </div>
          <button class="bk-quiz-btn primary" style="padding:6px 12px;font-size:12px;" onclick="bkOpenReceivedPdf('${it.bookId}')">阅读</button>
          <button class="bk-quiz-btn" style="padding:6px 10px;font-size:12px;background:transparent;border-color:var(--border);" onclick="bkDeleteReceivedPdf('${it.bookId}')">删除</button>
        </div>`;
      }).join('');
    }
    const overlay = document.createElement('div');
    overlay.className = 'bk-original-overlay';
    overlay.innerHTML = `
      <div class="bk-original-panel" style="max-width:560px;">
        <div class="bk-original-head">
          <span class="bk-original-title"><i data-lucide="folder-open" class="lucide-icon" style="width:15px;height:15px;"></i> 本机已传输的 PDF</span>
          <button class="bk-original-close" onclick="this.closest('.bk-original-overlay').remove()"><i data-lucide="x" class="lucide-icon" style="width:16px;height:16px;"></i></button>
        </div>
        <div class="bk-original-body">${html}</div>
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
async function bkImportBook() {
  if (!window.electronAPI || !window.electronAPI.pickPdfFile) {
    alert('当前环境不支持文件选择（需在 Electron 中运行）');
    return;
  }
  if (typeof parsePdfFile !== 'function') {
    alert('PDF 解析模块未加载，请重启应用');
    return;
  }
  try {
    const filePath = await window.electronAPI.pickPdfFile();
    if (!filePath) return;
    const buffer = await window.electronAPI.readPdfFile(filePath);
    if (!buffer) { alert('无法读取所选 PDF 文件'); return; }

    const fileName = String(filePath).split(/[\\/]/).pop() || '未命名.pdf';
    const title = fileName.replace(/\.pdf$/i, '').trim() || '未命名教材';

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
    const parsed = await parsePdfFile(buffer, onProgress);
    if (!parsed || !parsed.pages || parsed.pages.length === 0) {
      bkHideOverlay();
      alert('PDF 解析失败：未能提取到文本（可能是扫描版 PDF，目前仅支持带文字层的电子版）');
      return;
    }

    // 章节切分：优先 outline，无 outline 时 AI 辅助
    let chapters = null;
    let granLevel = 0; // 用户选择的颗粒度层级
    onProgress({ text: '正在切分章节…', percent: 99 });
    if (parsed.outline && parsed.outline.length > 0) {
      // 多层级目录：询问用户章节划分颗粒度
      if (typeof bkAskChapterGranularity === 'function' && typeof splitChaptersAtLevel === 'function') {
        const info = bkCollectOutlineLevels(parsed.outline);
        if (info.maxLevel > 0) {
          bkHideOverlay();
          const picked = await bkAskChapterGranularity(parsed.outline);
          if (picked === null) return; // 用户取消导入
          granLevel = picked;
          onProgress({ text: '正在切分章节…', percent: 99 });
          chapters = splitChaptersAtLevel(parsed.outline, parsed.pageCount, granLevel);
        }
      }
      if (!chapters) chapters = splitChaptersByOutline(parsed.outline, parsed.pageCount);
    } else if (typeof aiSplitChapters === 'function') {
      chapters = await aiSplitChapters(parsed.pages, (msg) => onProgress({ text: msg, percent: 99 }));
    }
    if (!chapters || chapters.length === 0) {
      // 兜底：整本作为一章
      chapters = [{ id: genId(), title: title, level: 0, startPage: 1, endPage: parsed.pageCount, kb: { status: 'pending', summary: '', terms: [], keyPoints: [], mindmap: null } }];
    }

    // 构造书籍对象
    const book = {
      id: genId(),
      title: title,
      fileName: fileName,
      filePath: filePath,
      pageCount: parsed.pageCount,
      chapters: chapters,
      quizRecords: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    booksData.push(book);
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
    const buffer = await window.electronAPI.readPdfFile(book.filePath);
    if (!buffer) { alert('无法读取原 PDF 文件（文件可能已被移动）'); return; }
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
    const parsed = await parsePdfFile(buffer, onProgress);
    let chapters = null;
    if (parsed.outline && parsed.outline.length > 0) {
      // 多层级目录：询问用户章节划分颗粒度
      if (typeof bkAskChapterGranularity === 'function' && typeof splitChaptersAtLevel === 'function') {
        const info = bkCollectOutlineLevels(parsed.outline);
        if (info.maxLevel > 0) {
          bkHideOverlay();
          const picked = await bkAskChapterGranularity(parsed.outline);
          if (picked === null) return; // 用户取消重新导入
          onProgress({ text: '正在切分章节…', percent: 99 });
          chapters = splitChaptersAtLevel(parsed.outline, parsed.pageCount, picked);
        }
      }
      if (!chapters) chapters = splitChaptersByOutline(parsed.outline, parsed.pageCount);
    } else if (typeof aiSplitChapters === 'function') {
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
