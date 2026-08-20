// ═══════════ Keywords: Global keyword view（聚合教材术语 + 笔记关键词）═══════════
// v=20260818-r1: 全局关键词界面；搜索 / 按来源筛选（书/笔记）/ 跳转来源
// 数据源：booksData[].chapters[].kb.terms（教材章节 AI 术语） + notes[].keywords（笔记关键词）

let _kwFilterState = null; // 本地记忆的筛选状态：{ source:'all'|'book'|'note', bookId, noteId, q }

function kwGetFilter() {
  if (!_kwFilterState) {
    try {
      _kwFilterState = JSON.parse(localStorage.getItem('study_keywords_filter')) || { source: 'all', bookId: null, noteId: null, q: '' };
    } catch (e) { _kwFilterState = { source: 'all', bookId: null, noteId: null, q: '' }; }
  }
  return _kwFilterState;
}
function kwSaveFilter() {
  localStorage.setItem('study_keywords_filter', JSON.stringify(_kwFilterState));
}

// ── 全局关键词库（用户手动添加，如学习栏右键「添加到术语表」） ──
// key: study_global_keywords_v1 = [{ word, def, source:'manual', ref, createdAt }]
const KW_GLOBAL_KEY = 'study_global_keywords_v1';
function kwGetGlobalKeywords() {
  try {
    const arr = JSON.parse(localStorage.getItem(KW_GLOBAL_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function kwSaveGlobalKeywords(arr) {
  try { localStorage.setItem(KW_GLOBAL_KEY, JSON.stringify(Array.isArray(arr) ? arr : [])); } catch (e) {}
}
// 添加一个全局关键词（已存在同词则更新释义），返回 { ok, added }
function kwAddGlobalKeyword(word, def, ref) {
  const w = String(word || '').trim();
  if (!w) return { ok: false, error: '关键词为空' };
  const arr = kwGetGlobalKeywords();
  const idx = arr.findIndex(x => x.word.toLowerCase() === w.toLowerCase());
  const now = new Date().toISOString();
  if (idx >= 0) {
    arr[idx] = { word: arr[idx].word, def: (def || arr[idx].def || ''), source: 'manual', ref: (ref || arr[idx].ref || ''), createdAt: arr[idx].createdAt, updatedAt: now };
    kwSaveGlobalKeywords(arr);
    return { ok: true, added: false };
  }
  arr.push({ word: w, def: (def || ''), source: 'manual', ref: (ref || ''), createdAt: now });
  kwSaveGlobalKeywords(arr);
  return { ok: true, added: true };
}
// 删除一个全局关键词（按精确词）
function kwRemoveGlobalKeyword(word) {
  const arr = kwGetGlobalKeywords();
  const next = arr.filter(x => x.word.toLowerCase() !== String(word || '').toLowerCase());
  const changed = next.length !== arr.length;
  if (changed) kwSaveGlobalKeywords(next);
  return changed;
}

// 聚合全部关键词条目
function collectKeywordEntries() {
  const entries = [];
  // 0) 全局关键词库（手动添加，来源全局，含自定义释义）
  for (const g of kwGetGlobalKeywords()) {
    if (!g || !g.word) continue;
    entries.push({
      word: String(g.word).trim(),
      type: 'global',
      def: g.def || '',
      ref: g.ref || '',
      createdAt: g.createdAt || ''
    });
  }
  // 1) 教材章节 AI 术语
  if (typeof booksData !== 'undefined' && Array.isArray(booksData)) {
    for (const book of booksData) {
      const chapters = Array.isArray(book.chapters) ? book.chapters : [];
      for (const ch of chapters) {
        const terms = (ch && ch.kb && Array.isArray(ch.kb.terms)) ? ch.kb.terms : [];
        for (const t of terms) {
          if (!t || !t.term) continue;
          entries.push({
            word: String(t.term).trim(),
            type: 'book',
            bookId: book.id,
            bookTitle: book.title || '未命名教材',
            chapterId: ch.id,
            chapterTitle: ch.title || '',
            def: t.def || ''
          });
        }
      }
    }
  }
  // 2) 笔记关键词
  if (typeof notes !== 'undefined' && Array.isArray(notes)) {
    for (const n of notes) {
      if (!n || n.type !== 'note') continue;
      const kws = Array.isArray(n.keywords) ? n.keywords : [];
      for (const w of kws) {
        const word = String(w || '').trim();
        if (!word) continue;
        entries.push({ word, type: 'note', noteId: n.id, noteTitle: n.title || '未命名笔记' });
      }
    }
  }
  return entries;
}

// 渲染全局关键词界面
function renderKeywords() {
  const app = document.getElementById('keywordsApp');
  if (!app) return;
  const f = kwGetFilter();
  const entries = collectKeywordEntries();
  const bookWords = entries.filter(e => e.type === 'book').length;
  const noteWords = entries.filter(e => e.type === 'note').length;
  const globalWords = entries.filter(e => e.type === 'global').length;
  app.innerHTML = `
    <div class="kw-header">
      <span class="kw-title"><i data-lucide="key-round" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> 全局关键词</span>
      <span class="kw-count">全局 ${globalWords} 条 · 教材 ${bookWords} 条 · 笔记 ${noteWords} 条</span>
    </div>
    <div class="kw-toolbar">
      <div class="kw-search-wrap">
        <i data-lucide="search" class="lucide-icon" style="width:14px;height:14px;flex-shrink:0;"></i>
        <input type="text" class="kw-search" id="kwSearchInput" placeholder="搜索关键词、释义或来源…" value="${escapeHtml(f.q || '')}" oninput="kwOnSearch(this.value)">
        ${f.q ? '<button class="kw-search-clear" onclick="kwClearSearch()" title="清除搜索">✕</button>' : ''}
      </div>
      <div class="kw-filter-row">
        <div class="kw-seg" id="kwSeg">
          <button class="kw-seg-btn ${f.source === 'all' ? 'active' : ''}" onclick="kwSetSource('all')">全部</button>
          <button class="kw-seg-btn ${f.source === 'global' ? 'active' : ''}" onclick="kwSetSource('global')">全局</button>
          <button class="kw-seg-btn ${f.source === 'book' ? 'active' : ''}" onclick="kwSetSource('book')">教材</button>
          <button class="kw-seg-btn ${f.source === 'note' ? 'active' : ''}" onclick="kwSetSource('note')">笔记</button>
        </div>
        <select class="kw-select" id="kwSourceSelect" onchange="kwSetTarget(this.value)">
          ${kwBuildSelectOptions(f)}
        </select>
      </div>
    </div>
    <div class="kw-list" id="kwList">${kwRenderList(entries, f)}</div>`;
  if (typeof lucide !== 'undefined') setTimeout(() => { try { lucide.createIcons(); } catch (e) {} }, 0);
}

// 构建二级下拉选项（教材来源 → 书本列表；笔记来源 → 含关键词的笔记列表）
function kwBuildSelectOptions(f) {
  let opts = '';
  if (f.source === 'global') {
    opts += '<option value="">全部手动关键词</option>';
  } else if (f.source === 'book') {
    const books = (typeof booksData !== 'undefined' && Array.isArray(booksData) ? booksData : [])
      .filter(b => (b.chapters || []).some(ch => ch.kb && Array.isArray(ch.kb.terms) && ch.kb.terms.length > 0));
    opts += '<option value="">全部教材</option>';
    for (const b of books) {
      opts += `<option value="${escapeHtml(b.id)}" ${String(f.bookId) === String(b.id) ? 'selected' : ''}>${escapeHtml(b.title || '未命名教材')}</option>`;
    }
  } else if (f.source === 'note') {
    const noteList = (typeof notes !== 'undefined' && Array.isArray(notes) ? notes : [])
      .filter(n => n.type === 'note' && Array.isArray(n.keywords) && n.keywords.length > 0);
    opts += '<option value="">全部笔记</option>';
    for (const n of noteList) {
      opts += `<option value="${escapeHtml(n.id)}" ${String(f.noteId) === String(n.id) ? 'selected' : ''}>${escapeHtml(n.title || '未命名笔记')}</option>`;
    }
  } else {
    opts += '<option value="">全部来源</option>';
  }
  return opts;
}

// 渲染关键词分组列表
function kwRenderList(entries, f) {
  const q = (f.q || '').trim().toLowerCase();
  const filtered = entries.filter(e => {
    if (f.source === 'global' && e.type !== 'global') return false;
    if (f.source === 'book' && e.type !== 'book') return false;
    if (f.source === 'note' && e.type !== 'note') return false;
    if (f.source === 'book' && f.bookId && String(e.bookId) !== String(f.bookId)) return false;
    if (f.source === 'note' && f.noteId && String(e.noteId) !== String(f.noteId)) return false;
    if (q) {
      const hay = (e.word + ' ' + (e.def || '') + ' ' + (e.bookTitle || '') + ' ' + (e.chapterTitle || '') + ' ' + (e.noteTitle || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  if (filtered.length === 0) {
    if (entries.length === 0) {
      return '<div class="kw-empty"><i data-lucide="key-round" class="lucide-icon" style="width:26px;height:26px;opacity:.4;"></i><div class="kw-empty-title">暂无关键词</div><div class="kw-empty-sub">在教材「学习」页选中文字右键可添加全局关键词，或去教材章节构建知识库（AI 术语表）、为笔记添加关键词</div></div>';
    }
    if (f.source === 'global') {
      return '<div class="kw-empty"><i data-lucide="star" class="lucide-icon" style="width:26px;height:26px;opacity:.4;"></i><div class="kw-empty-title">暂无手动添加的关键词</div><div class="kw-empty-sub">在教材「学习」页选中文字，右键 → 添加到术语表</div></div>';
    }
    return '<div class="kw-empty"><i data-lucide="search-x" class="lucide-icon" style="width:26px;height:26px;opacity:.4;"></i><div class="kw-empty-title">未找到匹配的关键词</div><div class="kw-empty-sub">试试更换搜索词或调整来源筛选</div></div>';
  }
  // 按词分组（Map 单次遍历）
  const groups = new Map();
  for (const e of filtered) {
    if (!groups.has(e.word)) groups.set(e.word, []);
    groups.get(e.word).push(e);
  }
  // 排序：频次高在前，同频按词拼音排序
  const wordList = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'zh'));
  return wordList.map(([word, list]) => {
    const bookSrc = list.filter(e => e.type === 'book');
    const noteSrc = list.filter(e => e.type === 'note');
    const globalSrc = list.filter(e => e.type === 'global');
    const chips = [];
    for (const e of globalSrc) {
      chips.push(`<span class="kw-chip kw-chip-global" title="手动添加的全局关键词${e.ref ? '（来自：' + escapeHtml(e.ref) + '）' : ''}"><i data-lucide="star" class="lucide-icon" style="width:11px;height:11px;"></i> 全局${e.ref ? ' · ' + escapeHtml(e.ref) : ''}</span>`);
    }
    for (const e of bookSrc) {
      chips.push(`<span class="kw-chip kw-chip-book" title="跳转到《${escapeHtml(e.bookTitle)}》章节「${escapeHtml(e.chapterTitle)}」" onclick="kwJump('book','${escapeHtml(e.bookId)}','${escapeHtml(e.chapterId)}')"><i data-lucide="book-open" class="lucide-icon" style="width:11px;height:11px;"></i> ${escapeHtml(e.bookTitle)} · ${escapeHtml(e.chapterTitle)}</span>`);
    }
    for (const e of noteSrc) {
      chips.push(`<span class="kw-chip kw-chip-note" title="跳转到笔记「${escapeHtml(e.noteTitle)}」" onclick="kwJump('note','${escapeHtml(e.noteId)}')"><i data-lucide="file-text" class="lucide-icon" style="width:11px;height:11px;"></i> ${escapeHtml(e.noteTitle)}</span>`);
    }
    // 全局关键词自带释义 → 直接展示
    const defHtml = (globalSrc[0] && globalSrc[0].def) ? `<div class="kw-def">${escapeHtml(globalSrc[0].def)}</div>` : '';
    return `<div class="kw-group">
      <div class="kw-group-head">
        <span class="kw-word">${escapeHtml(word)}</span>
        <span class="kw-badge" title="出现次数">${list.length}</span>
      </div>
      ${defHtml}
      <div class="kw-chips">${chips.join('')}</div>
    </div>`;
  }).join('');
}

// ── 交互：来源切换 / 二级下拉 / 搜索 ──
function kwSetSource(src) {
  const f = kwGetFilter();
  f.source = src;
  f.bookId = null;
  f.noteId = null;
  kwSaveFilter();
  renderKeywords();
}
function kwSetTarget(val) {
  const f = kwGetFilter();
  if (f.source === 'book') f.bookId = val || null;
  else if (f.source === 'note') f.noteId = val || null;
  kwSaveFilter();
  renderKeywords();
}
function kwOnSearch(v) {
  const f = kwGetFilter();
  f.q = v;
  kwSaveFilter();
  const list = document.getElementById('kwList');
  if (list) list.innerHTML = kwRenderList(collectKeywordEntries(), f);
  // 同步清除按钮显隐
  const app = document.getElementById('keywordsApp');
  const clearBtn = app && app.querySelector('.kw-search-clear');
  if (clearBtn) clearBtn.style.display = v ? 'inline-flex' : 'none';
  if (typeof lucide !== 'undefined') setTimeout(() => { try { lucide.createIcons(); } catch (e) {} }, 0);
}
function kwClearSearch() {
  const f = kwGetFilter();
  f.q = '';
  kwSaveFilter();
  const input = document.getElementById('kwSearchInput');
  if (input) input.value = '';
  renderKeywords();
}

// ── 跳转到来源 ──
// type='book'：跳对应书的章节阅读页；type='note'：跳对应笔记
function kwJump(type, id1, id2) {
  if (type === 'book') {
    if (typeof switchTab === 'function') switchTab('books');
    if (typeof bkSelectBook === 'function' && id1) bkSelectBook(id1);
    if (typeof bkSelectChapter === 'function' && id2) bkSelectChapter(id2);
  } else if (type === 'note') {
    if (typeof switchTab === 'function') switchTab('notes');
    if (typeof selectNote === 'function' && id1) selectNote(id1);
  }
}
