// ═══════════════════════════════════════════════════════════════════
//  教材知识库旁批系统（摘要导图卡片批注 / AI 生成旁批 / 批注汇总面板）
//  依赖：core.js（loadData/saveData）、utils.js（escapeHtml/escapeJs）、
//        books.js（booksData/bkGetBookById/bkGetActiveBook/bkGetActiveChapter/_bkPersistNav）、
//        books-ai.js（_bkRenderMd/_bkRequireKey/bkGetActiveChapter）、ai-api.js（callAiApi）、
//        ai-render.js（formatMarkdownBase）
//  数据：localStorage `study_books_annotations_v1`（顶层数组，独立于 chapter.kb，重建知识库不丢失）
//  定位键：key = `type:index`（summary/term/keypoint/pseudo/figure/mindmap）
// ═══════════════════════════════════════════════════════════════════

const BK_ANNOT_STORE_KEY = 'study_books_annotations_v1';
let _bkAnnoMap = null; // Map<`${bookId}|${chapterId}|${key}`, annotation>

// ── 数据层 ──
function _bkAnnoKeyOf(bookId, chapterId, key) {
  return String(bookId) + '|' + String(chapterId) + '|' + String(key);
}

function bkAnnotGetMap() {
  if (_bkAnnoMap) return _bkAnnoMap;
  _bkAnnoMap = new Map();
  try {
    const arr = loadData(BK_ANNOT_STORE_KEY);
    for (const a of arr) {
      if (!a || a.bookId == null || a.chapterId == null || !a.key) continue;
      _bkAnnoMap.set(_bkAnnoKeyOf(a.bookId, a.chapterId, a.key), a);
    }
  } catch (e) {}
  return _bkAnnoMap;
}

function _bkAnnoPersist() {
  saveData(BK_ANNOT_STORE_KEY, [...bkAnnotGetMap().values()]);
}

// 汇总面板用：展开全部批注（附书/章引用）
function bkAnnotGetAll() {
  const list = [];
  bkAnnotGetMap().forEach(a => {
    const book = bkGetBookById(a.bookId);
    const chapter = book ? (book.chapters || []).find(c => String(c.id) === String(a.chapterId)) : null;
    list.push({ ...a, book, chapter });
  });
  return list;
}

function bkAnnotSave(bookId, chapterId, annoKey, text, ai) {
  const map = bkAnnotGetMap();
  const k = _bkAnnoKeyOf(bookId, chapterId, annoKey);
  const now = Date.now();
  const existing = map.get(k);
  if (existing) {
    existing.text = text;
    existing.ai = !!ai;
    existing.updatedAt = now;
  } else {
    map.set(k, {
      id: 'a_' + now + '_' + Math.random().toString(36).slice(2, 8),
      bookId, chapterId, key: annoKey,
      text, ai: !!ai, createdAt: now, updatedAt: now
    });
  }
  _bkAnnoPersist();
}

function bkAnnotDelete(bookId, chapterId, annoKey) {
  bkAnnotGetMap().delete(_bkAnnoKeyOf(bookId, chapterId, annoKey));
  _bkAnnoPersist();
}

// ── 类型元信息 ──
function _bkAnnotTypeMeta(key) {
  const type = String(key || '').split(':')[0];
  const meta = {
    summary:  { icon: 'file-text',     label: '摘要节点' },
    term:     { icon: 'bookmark',      label: '术语' },
    keypoint: { icon: 'list-checks',   label: '重点' },
    pseudo:   { icon: 'code',          label: '伪代码' },
    figure:   { icon: 'image',         label: '图片' },
    mindmap:  { icon: 'network',       label: '知识导图' }
  };
  return meta[type] || { icon: 'message-square', label: '批注' };
}

function _bkAnnotTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 从节点元素提取上下文文本（AI 生成 / 汇总面板快照用）
function _bkAnnotExtractCtx(el) {
  if (!el) return '';
  let text = '';
  if (el.classList && el.classList.contains('bk-summary-node')) {
    text = el.dataset.name || (el.innerText || '').trim();
  } else if (el.classList && el.classList.contains('bk-term-chip')) {
    const b = el.querySelector('b');
    text = b ? ((b.textContent || '') + ' ' + (el.innerText || '')).trim() : (el.innerText || '').trim();
  } else if (el.classList && el.classList.contains('bk-pseudo-item')) {
    text = [el.dataset.bkSrcName, el.dataset.bkSrcCode].filter(Boolean).join('\n');
  } else if (el.classList && el.classList.contains('bk-figure-item')) {
    text = el.dataset.bkSrcName || (el.innerText || '').trim();
  } else {
    text = (el.innerText || '').trim();
  }
  return text.replace(/\s+/g, ' ').slice(0, 200);
}

// ── 卡片注入 ──
// 在 bkRenderSummaryTab 渲染完成后调用：扫描所有 [data-anno-key] 卡片并挂载批注 UI
function bkAnnotInject(book, chapter) {
  if (!book || !chapter) return;
  const body = document.getElementById('bkMainBody');
  if (!body) return;
  body.querySelectorAll('[data-anno-key]').forEach(el => bkAnnotMount(el));
}

function bkAnnotMount(el) {
  if (!el || el.dataset.bkAnnoMounted === '1') return;
  el.dataset.bkAnnoMounted = '1';
  const wrap = document.createElement('div');
  wrap.className = 'bk-anno-wrap';
  wrap.dataset.annoKey = el.dataset.annoKey;
  // 批注入口在右键菜单（添加批注 / AI 生成旁批）；此处仅承载批注展示条与就地编辑器
  wrap.innerHTML = `
    <div class="bk-anno-bar" style="display:none;"></div>
    <div class="bk-anno-editor">
      <textarea class="bk-anno-input" placeholder="写下你的想法…（支持 Markdown）"></textarea>
      <div class="bk-anno-editor-actions">
        <button type="button" class="bk-anno-ai-btn" onclick="bkAnnotAiClick(event, this)"><i data-lucide="wand-2" class="lucide-icon"></i> AI 生成</button>
        <span style="flex:1"></span>
        <button type="button" class="bk-anno-cancel-btn" onclick="bkAnnotCancelEditor(event, this)">取消</button>
        <button type="button" class="bk-anno-save-btn" onclick="bkAnnotSaveClick(event, this)"><i data-lucide="check" class="lucide-icon"></i> 保存</button>
      </div>
    </div>`;
  el.appendChild(wrap);
  bkAnnotRefreshWrap(wrap);
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
}

function _bkAnnotWrap(btn) {
  return btn && btn.closest ? btn.closest('.bk-anno-wrap') : null;
}

// 当前活动书/章下该 wrap 对应的批注（无则 null）
function _bkAnnotAnno(wrap) {
  if (!wrap || !wrap.dataset.annoKey) return null;
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  if (!book || !chapter) return null;
  return bkAnnotGetMap().get(_bkAnnoKeyOf(book.id, chapter.id, wrap.dataset.annoKey)) || null;
}

// 根据存储重绘某 wrap 的按钮状态与气泡条
function bkAnnotRefreshWrap(wrap) {
  if (!wrap) return;
  const anno = _bkAnnotAnno(wrap);
  const bar = wrap.querySelector('.bk-anno-bar');
  const hasText = !!(anno && anno.text && anno.text.trim());
  if (!bar) return;
  if (hasText) {
    bar.style.display = '';
    bar.innerHTML = `
      <span class="bk-anno-bar-icon"><i data-lucide="message-square" class="lucide-icon"></i></span>
      <div class="bk-anno-bar-text">${_bkRenderMd(anno.text)}</div>
      ${anno.ai ? '<span class="bk-anno-ai-tag">AI</span>' : ''}
      <div class="bk-anno-bar-actions">
        <button type="button" class="bk-anno-edit-btn" title="编辑" onclick="bkAnnotEditClick(event, this)"><i data-lucide="pencil" class="lucide-icon"></i></button>
        <button type="button" class="bk-anno-del-btn" title="删除" onclick="bkAnnotDeleteClick(event, this)"><i data-lucide="trash-2" class="lucide-icon"></i></button>
      </div>`;
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
  } else {
    bar.style.display = 'none';
  }
}

// ── 编辑器交互 ──
function _bkAnnotCloseOthers() {
  const body = document.getElementById('bkMainBody');
  if (body) body.querySelectorAll('.bk-anno-editor.open').forEach(e => e.classList.remove('open'));
}

function _bkAnnotOpenEditor(wrap) {
  _bkAnnotCloseOthers();
  const editor = wrap.querySelector('.bk-anno-editor');
  if (!editor) return;
  const input = wrap.querySelector('.bk-anno-input');
  const anno = _bkAnnotAnno(wrap);
  if (input) {
    input.value = anno ? anno.text : '';
    input.style.height = '';
  }
  wrap.dataset.bkAnnoAi = (anno && anno.ai) ? '1' : '0';
  editor.classList.add('open');
  if (input) setTimeout(() => input.focus(), 50);
}

function bkAnnotCancelEditor(event, btn) {
  if (event) event.stopPropagation();
  const wrap = _bkAnnotWrap(btn);
  if (!wrap) return;
  wrap.querySelector('.bk-anno-editor').classList.remove('open');
}

function bkAnnotEditClick(event, btn) {
  if (event) event.stopPropagation();
  const wrap = _bkAnnotWrap(btn);
  if (!wrap) return;
  _bkAnnotOpenEditor(wrap);
}

function bkAnnotSaveClick(event, btn) {
  if (event) event.stopPropagation();
  const wrap = _bkAnnotWrap(btn);
  if (!wrap || !wrap.dataset.annoKey) return;
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  if (!book || !chapter) return;
  const input = wrap.querySelector('.bk-anno-input');
  const text = (input && input.value) ? input.value.trim() : '';
  if (!text) { if (input) input.focus(); return; }
  const ai = wrap.dataset.bkAnnoAi === '1';
  const ctx = _bkAnnotExtractCtx(wrap.parentElement) || '';
  // 保存时一并记录上下文快照（汇总面板不依赖当前渲染状态）
  const map = bkAnnotGetMap();
  const k = _bkAnnoKeyOf(book.id, chapter.id, wrap.dataset.annoKey);
  const now = Date.now();
  const existing = map.get(k);
  const ann = existing || {
    id: 'a_' + now + '_' + Math.random().toString(36).slice(2, 8),
    bookId: book.id, chapterId: chapter.id, key: wrap.dataset.annoKey, createdAt: now
  };
  ann.text = text;
  ann.ai = ai;
  ann.ctx = ctx || ann.ctx || '';
  ann.updatedAt = now;
  map.set(k, ann);
  _bkAnnoPersist();
  wrap.dataset.bkAnnoAi = '0';
  wrap.querySelector('.bk-anno-editor').classList.remove('open');
  bkAnnotRefreshWrap(wrap);
}

function bkAnnotDeleteClick(event, btn) {
  if (event) event.stopPropagation();
  const wrap = _bkAnnotWrap(btn);
  if (!wrap || !wrap.dataset.annoKey) return;
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  if (!book || !chapter) return;
  showCustomConfirm('确定删除这条批注吗？').then(ok => {
    if (!ok) return;
    bkAnnotDelete(book.id, chapter.id, wrap.dataset.annoKey);
    wrap.dataset.bkAnnoAi = '0';
    wrap.querySelector('.bk-anno-editor').classList.remove('open');
    bkAnnotRefreshWrap(wrap);
  });
}

// ── AI 生成旁批 ──
function bkAnnotAiClick(event, btn) {
  if (event) event.stopPropagation();
  const wrap = _bkAnnotWrap(btn);
  if (!wrap) return;
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  if (!book || !chapter) return;
  _bkAnnotOpenEditor(wrap);
  _bkAnnotRunAi(wrap);
}

// 右键菜单入口：从被右键节点生成旁批（编辑后保存）
function bkAnnotAiFromContext() {
  const el = _bkCtxNodeEl;
  bkCloseTermContextMenu();
  if (!el || !el.dataset.annoKey) return;
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  if (!book || !chapter) return;
  const wrap = el.querySelector('.bk-anno-wrap');
  if (!wrap) return;
  _bkAnnotOpenEditor(wrap);
  const input = wrap.querySelector('.bk-anno-input');
  if (input) input.value = '';
  _bkAnnotRunAi(wrap);
}

// 右键菜单入口：手动添加/编辑批注（就地展开编辑器，保留已有内容）
function bkAnnotAddFromContext() {
  const el = _bkCtxNodeEl;
  bkCloseTermContextMenu();
  if (!el || !el.dataset.annoKey) return;
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  if (!book || !chapter) return;
  const wrap = el.querySelector('.bk-anno-wrap');
  if (!wrap) return;
  _bkAnnotOpenEditor(wrap);
  const input = wrap.querySelector('.bk-anno-input');
  if (input) input.focus();
}

function _bkAnnotRunAi(wrap) {
  if (!wrap || !wrap.dataset.annoKey) return;
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  if (!book || !chapter) return;
  const annoKey = wrap.dataset.annoKey;
  const input = wrap.querySelector('.bk-anno-input');
  const btnEl = wrap.querySelector('.bk-anno-ai-btn');
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = '<i data-lucide="loader" class="lucide-icon bk-spinner" style="animation:bk-spin 0.8s linear infinite;"></i> 生成中…';
  }
  const ctx = _bkAnnotExtractCtx(wrap.parentElement);
  if (!ctx) {
    if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = '<i data-lucide="wand-2" class="lucide-icon"></i> AI 生成'; if (typeof lucide !== 'undefined') lucide.createIcons(); }
    return;
  }
  const meta = _bkAnnotTypeMeta(annoKey);
  const cfg = _bkRequireKey();
  if (!cfg) {
    if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = '<i data-lucide="wand-2" class="lucide-icon"></i> AI 生成'; if (typeof lucide !== 'undefined') lucide.createIcons(); }
    return;
  }
  callAiApi([
    { role: 'system', content: '你是学习伙伴。请针对用户提供的教材知识库节点，写一条简短的解释性旁批（1-3 句话），帮助学习者理解这个知识点。用中文直接输出旁批文本本身，不要任何前缀、标题或 Markdown 代码块。' },
    { role: 'user', content: '【节点类型】' + meta.label + '\n【节点内容】\n' + ctx }
  ], cfg, null).then(res => {
    const raw = (res && (res.cleanText || res.rawReply)) || '';
    const clean = String(raw).replace(/```(?:markdown|md)?\s*|```/g, '').trim();
    if (clean) {
      if (input) input.value = clean;
      wrap.dataset.bkAnnoAi = '1';
    }
  }).catch(err => {
    showCustomConfirm('AI 生成失败：' + (err && err.message ? escapeHtml(err.message) : String(err)) + '<br><small>可手动输入批注内容。</small>');
  }).finally(() => {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.innerHTML = '<i data-lucide="wand-2" class="lucide-icon"></i> AI 生成';
      if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
    }
  });
}

// ── 批注 tab（教材界面内，与错题本并列；按章节分组展示当前书的批注）──
function bkRenderAnnotationsTab(book, chapter) {
  const body = document.getElementById('bkMainBody');
  if (!body) return;
  body.classList.remove('bk-body-chat');
  if (!book) {
    body.innerHTML = '<div class="bk-empty-hint"><p>请先选择教材</p></div>';
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
    return;
  }
  const all = bkAnnotGetAll().filter(a => String(a.bookId) === String(book.id));
  if (!all.length) {
    body.innerHTML = `
      <div class="bk-empty-hint">
        <i data-lucide="message-square-plus" class="lucide-icon" style="width:52px;height:52px;"></i>
        <p>本书暂无批注</p>
        <small>在「摘要导图」的节点卡片旁点击批注图标添加，<br>或右键节点让 AI 生成旁批</small>
      </div>`;
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
    return;
  }

  // 按章节分组（保留章节在书中的自然顺序，同章按更新时间倒序）
  const byChapter = {};
  for (const a of all) {
    const ck = String(a.chapterId);
    if (!byChapter[ck]) byChapter[ck] = { chapter: a.chapter, items: [] };
    byChapter[ck].items.push(a);
  }
  const chapterOrder = (book.chapters || []).map(c => String(c.id));
  const chapterKeys = Object.keys(byChapter).sort((x, y) => {
    const ix = chapterOrder.indexOf(x), iy = chapterOrder.indexOf(y);
    return (ix === -1 ? 999 : ix) - (iy === -1 ? 999 : iy);
  });

  let html = `<div class="bk-annot-app">
    <div class="bk-annot-summary-bar">共 ${all.length} 条批注 · 点击条目跳转到原文位置</div>`;
  chapterKeys.forEach(chKey => {
    const cg = byChapter[chKey];
    const chTitle = cg.chapter ? escapeHtml(cg.chapter.title) : '（已删除的章节）';
    const chapterItems = cg.items.slice().sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
    html += `<div class="bk-annot-chapter-group">
      <div class="bk-annot-chapter-head"><i data-lucide="folder" class="lucide-icon"></i> ${chTitle}</div>`;
    for (const it of chapterItems) {
      const meta = _bkAnnotTypeMeta(it.key);
      const ctx = (it.ctx || '').replace(/\s+/g, ' ').slice(0, 40);
      html += `<div class="bk-annot-item" onclick="bkAnnotJumpTo('${it.bookId}','${it.chapterId}','${escapeJs(it.key)}')" title="点击跳转到原文位置">
        <div class="bk-annot-item-top">
          <span class="bk-annot-type"><i data-lucide="${meta.icon}" class="lucide-icon"></i> ${meta.label}</span>
          ${it.ai ? '<span class="bk-anno-ai-tag">AI</span>' : ''}
          <span class="bk-annot-time">${_bkAnnotTime(it.updatedAt)}</span>
        </div>
        <div class="bk-annot-ctx">${ctx ? '节点：' + escapeHtml(ctx) : ''}</div>
        <div class="bk-annot-text">${_bkRenderMd(it.text)}</div>
      </div>`;
    }
    html += `</div>`;
  });
  html += `</div>`;
  body.innerHTML = html;
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
}

// 从批注 tab 跳回原文位置：选中书/章 → 摘要导图 → 滚动 + 高亮
function bkAnnotJumpTo(bookId, chapterId, annoKey) {
  const book = bkGetBookById(bookId);
  if (!book) {
    showCustomConfirm('该书已不存在，无法跳转。<br><small>批注仍保留，可在原书重建后重新定位。</small>');
    return;
  }
  const chapter = (book.chapters || []).find(c => String(c.id) === String(chapterId));
  if (!chapter) {
    showCustomConfirm('该章节已不存在，无法跳转。');
    return;
  }
  bkActiveBookId = book.id;
  bkActiveChapterId = chapter.id;
  bkActiveTab = (chapter.kb && chapter.kb.status === 'done') ? 'summary' : 'explain';
  if (typeof _bkPersistNav === 'function') _bkPersistNav();
  switchTab('books');
  setTimeout(() => {
    const target = document.querySelector('#bkMainBody [data-anno-key="' + String(annoKey).replace(/"/g, '\\"') + '"]');
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('bk-flash');
      setTimeout(() => target.classList.remove('bk-flash'), 2200);
    } else if (bkActiveTab === 'summary' && typeof bkSwitchTab === 'function') {
      // 目标卡片未找到（知识库未构建）时切到章节讲解兜底
      bkSwitchTab('explain');
    }
  }, 150);
}
