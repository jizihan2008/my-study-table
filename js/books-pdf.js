// ═══════════════════════════════════════════════════════════════════
//  教材学习 — PDF 解析 / 章节切分 / 正文缓存
//  依赖：window.pdfjsLib（index.html 中以 <script type="module"> 加载 lib/pdfjs/pdf.min.mjs）
//  提供接口（供 books.js / books-kb.js / books-ai.js 调用）：
//    parsePdfFile(buffer, onProgress)  → { pageCount, pages, outline }
//    splitChaptersByOutline(outline, pageCount) → chapters
//    aiSplitChapters(pages, onMsg)      → chapters
//    saveBookTextCache / loadBookTextCache / deleteBookTextCache / getChapterText
// ═══════════════════════════════════════════════════════════════════

// 确保 pdf.js 已加载
// 优先使用 index.html 中 <script type="module"> 预加载挂到 window 的实例；
// 未就绪时用动态 import 兜底。为避免 import() 在经典脚本中的基准路径歧义，
// 显式基于 document.baseURI（index.html 所在目录）构造 file:// URL。
let _pdfjsPromise = null;
function ensurePdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (_pdfjsPromise) return _pdfjsPromise;
  let moduleUrl = './lib/pdfjs/pdf.min.mjs';
  let workerUrl = './lib/pdfjs/pdf.worker.min.mjs';
  try {
    if (typeof document !== 'undefined' && document.baseURI) {
      moduleUrl = new URL('./lib/pdfjs/pdf.min.mjs', document.baseURI).href;
      workerUrl = new URL('./lib/pdfjs/pdf.worker.min.mjs', document.baseURI).href;
    }
  } catch (e) {}
  _pdfjsPromise = import(moduleUrl)
    .then(m => {
      m.GlobalWorkerOptions.workerSrc = workerUrl;
      window.pdfjsLib = m;
      return m;
    })
    .catch(err => {
      console.error('pdf.js 加载失败:', err);
      return null;
    });
  return _pdfjsPromise;
}

// ── 解析 PDF：提取逐页文本 + outline ──
// onProgress({ text, percent })
async function parsePdfFile(buffer, onProgress) {
  const pdfjsLib = await ensurePdfJs();
  if (!pdfjsLib) throw new Error('pdf.js 未加载');
  const report = (text, percent) => { if (typeof onProgress === 'function') onProgress({ text, percent }); };

  let data;
  if (buffer instanceof Uint8Array) data = buffer;
  else if (buffer && buffer.data && typeof buffer.type === 'string') data = new Uint8Array(buffer.data);
  else if (buffer && typeof buffer === 'object') data = buffer;
  else throw new Error('PDF 数据格式不支持');

  let pdf = null;
  try {
    const loadingTask = pdfjsLib.getDocument({ data });
    pdf = await loadingTask.promise;
  } catch (err) {
    throw new Error('无法打开 PDF：' + String((err && err.message) || err));
  }

  const pageCount = pdf.numPages;
  const pages = [];

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    let text = '';
    try {
      const tc = await page.getTextContent();
      text = (tc.items || [])
        .map(it => (it.str !== undefined ? it.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    } catch (e) {
      text = '';
    }
    pages.push(text);
    if (i % 5 === 0 || i === pageCount) {
      report(`已提取第 ${i}/${pageCount} 页`, Math.round((i / pageCount) * 90));
    }
  }

  // outline（书签）
  let outline = [];
  try { outline = (await pdf.getOutline()) || []; } catch (e) { outline = []; }
  outline = await resolveOutlineDest(pdf, outline);

  // 释放
  try { await pdf.destroy(); } catch (e) {}

  return { pageCount, pages, outline };
}

// 递归解析 outline 每项的 dest → 页码（逻辑页，从 1 开始）
async function resolveOutlineDest(pdf, items, level = 0) {
  const result = [];
  for (const item of items || []) {
    let page = null;
    if (item.dest) {
      page = await resolveOutlineDestPage(pdf, item.dest);
    }
    const node = {
      title: String(item.title || '').trim(),
      level: level,
      page: page,
      items: []
    };
    if (item.items && item.items.length) {
      node.items = await resolveOutlineDest(pdf, item.items, level + 1);
    }
    result.push(node);
  }
  return result;
}

// 解析 outline dest → 页码（逻辑页，从 1 开始）
// 方案A：getDestination(dest) 标准做法（适用于 dest 为命名目标/数组引用的旧式 PDF）
// 方案B：dest 已是 [ {num,gen}, {name:"Fit"} ] 形式（pdf.js 已解析的对象引用），
//        此时 getDestination 会报 "Invalid destination request"，直接对 dest[0] 调 getPageIndex。
//        （实测《离散数学及其应用 第8版》等教材 PDF 的 outline 即为此格式）
async function resolveOutlineDestPage(pdf, dest) {
  // 方案A
  try {
    const ref = await pdf.getDestination(dest);
    if (ref) {
      try { return (await pdf.getPageIndex(ref)) + 1; } catch (e) {}
    }
  } catch (e) {}
  // 方案B
  if (Array.isArray(dest) && dest[0] && typeof dest[0] === 'object' && 'num' in dest[0]) {
    try { return (await pdf.getPageIndex(dest[0])) + 1; } catch (e) {}
  }
  return null;
}

// ── outline → 章节树 ──
// 仅取顶层条目作为「章」（若顶层是 Part/Unit 且其下还有章节时自动下钻一层）
function splitChaptersByOutline(outline, pageCount) {
  let top = outline;
  // 若顶层条目过少且都有子级，尝试下钻一层（Part → Chapter）
  if (top.length > 0 && top.length <= 8 && top.every(o => o.items && o.items.length > 0)) {
    top = top.flatMap(o => o.items);
  }
  // 过滤掉无法解析页码的条目 + 常见前置页（封面/目录/前言/致谢等），保留真正的章节
  const isFrontMatter = (t) => {
    const s = String(t || '').toLowerCase().trim();
    if (!s) return true;
    // 常见前置页关键词（不含这些词的条目视为章节）
    const frontKeys = ['cover', 'title page', 'copyright', 'contents', 'about the author',
      'preface', 'acknowledgments', 'acknowledgements', 'online resources', 'to the student',
      'brief contents', 'detailed contents', 'list of', 'foreword', 'introduction to',
      'acknowledgment', 'acknowledgement'];
    return frontKeys.some(k => s === k || s.startsWith(k + ' ') || s.startsWith(k + ':'));
  };
  const entries = top.filter(o => o.page && o.page > 0 && !isFrontMatter(o.title));
  if (entries.length === 0) {
    // 全部无法解析时回退：整本一章
    return null;
  }

  const chapters = entries.map((o, i) => {
    const startPage = o.page;
    const next = entries[i + 1];
    const endPage = next ? next.page - 1 : pageCount;
    return {
      id: genId(),
      title: o.title || ('章节 ' + (i + 1)),
      level: 0,
      startPage: startPage,
      endPage: Math.max(startPage, endPage),
      kb: { status: 'pending', summary: '', terms: [], keyPoints: [], mindmap: null }
    };
  });
  // 仅当相邻章节起始页重叠（同页多个标题）时合并，正常的递增章节各自独立
  const merged = [];
  for (const c of chapters) {
    const prev = merged[merged.length - 1];
    if (prev && c.startPage <= prev.endPage) {
      prev.endPage = Math.max(prev.endPage, c.endPage);
      prev.title = prev.title + ' / ' + c.title;
    } else {
      merged.push(c);
    }
  }
  return merged.length ? merged : null;
}

// ── outline → 章节树（按用户选择的颗粒度层级） ──
// targetLevel: 0=最上层，1=第二层…；返回扁平章节数组
// 所有层级节点（祖先 + 所选层）均实体化为章节：每章含 parentId / children / ancestors / level，
// 因此非叶节点（如 Part、章）也能像叶节点一样被选中、建知识库、参与问答。
function splitChaptersAtLevel(outline, pageCount, targetLevel) {
  targetLevel = Math.max(0, Number(targetLevel) || 0);
  const isFrontMatter = (t) => {
    const s = String(t || '').toLowerCase().trim();
    if (!s) return true;
    const frontKeys = ['cover', 'title page', 'copyright', 'contents', 'about the author',
      'preface', 'acknowledgments', 'acknowledgements', 'online resources', 'to the student',
      'brief contents', 'detailed contents', 'list of', 'foreword', 'introduction to',
      'acknowledgment', 'acknowledgement'];
    return frontKeys.some(k => s === k || s.startsWith(k + ' ') || s.startsWith(k + ':'));
  };
  const nodes = [];
  const byId = new Map();
  const mkNode = (o, level, ancestors) => {
    const t = String(o.title || '').trim();
    const node = {
      id: genId(),
      title: t || ('章节 ' + (nodes.length + 1)),
      level: level,
      ancestors: ancestors.slice(), // 祖先标题链（不含自身）
      parentId: null,
      children: [],                 // 直属子节点 id（非叶节点用）
      startPage: (o.page && o.page > 0) ? o.page : null,
      endPage: null,
      kb: { status: 'pending', summary: '', terms: [], keyPoints: [], mindmap: null }
    };
    nodes.push(node);
    byId.set(node.id, node);
    return node;
  };
  // 深度优先收集 level <= targetLevel 的所有层级节点
  const walk = (items, level, ancestors) => {
    const ids = [];
    for (const o of items || []) {
      if (isFrontMatter(o.title)) continue;
      const node = mkNode(o, level, ancestors);
      ids.push(node.id);
      if (level < targetLevel && o.items && o.items.length) {
        const kids = walk(o.items, level + 1, ancestors.concat(node.title));
        node.children = kids;
        for (const cid of kids) byId.get(cid).parentId = node.id;
      }
    }
    return ids;
  };
  walk(outline, 0, []);
  if (nodes.length === 0) return null;

  // 页码计算分两步：
  //  1) 自底向上：先递归子层，再按同级相邻兄弟计算 endPage（末节点用 parentEnd 或 pageCount 兜底）
  //  2) 自顶向下：父节点 endPage 修正后，把最后一个子节点的 endPage 收敛到父节点 endPage 之内
  const computeEnds = (ids, parentEnd) => {
    for (const id of ids) {
      const n = byId.get(id);
      if (n.children.length) computeEnds(n.children, null);
    }
    for (let i = 0; i < ids.length; i++) {
      const n = byId.get(ids[i]);
      const next = (i + 1 < ids.length) ? byId.get(ids[i + 1]) : null;
      const nextStart = next ? (next.startPage || byId.get(next.children[0]).startPage) : null;
      const myEnd = n.children.length ? byId.get(n.children[n.children.length - 1]).endPage : null;
      let end;
      if (n.children.length) {
        end = myEnd;
      } else {
        end = nextStart ? nextStart - 1 : (parentEnd || pageCount);
      }
      if (nextStart && end > nextStart - 1) end = nextStart - 1;
      if (!n.startPage && n.children.length) n.startPage = byId.get(n.children[0]).startPage;
      if (!n.startPage) n.startPage = end || 1;
      n.endPage = Math.max(n.startPage, end || n.startPage);
    }
  };
  const clampToParent = (ids) => {
    for (const id of ids) {
      const n = byId.get(id);
      if (n.children.length) {
        const lastChild = byId.get(n.children[n.children.length - 1]);
        if (lastChild.endPage > n.endPage) lastChild.endPage = n.endPage;
        clampToParent(n.children);
      }
    }
  };
  const topIds = nodes.filter(n => !n.parentId).map(n => n.id);
  computeEnds(topIds, pageCount);
  clampToParent(topIds);
  return nodes;
}

// ── AI 辅助章节切分（无 outline 时） ──
// 取前若干页文本交 AI 识别章节边界，返回 [{ title, startPage }]
async function aiSplitChapters(pages, onMsg) {
  const cfg = (typeof getEffectiveApiConfig === 'function') ? getEffectiveApiConfig() : null;
  if (!cfg || !cfg.apiKey || typeof callAiApi !== 'function') return null;

  const report = (msg) => { if (typeof onMsg === 'function') onMsg(msg); };
  report('正在调用 AI 识别章节目录…');

  // 拼接前 20 页文本作为目录素材（每页截取前 1200 字符）
  const sample = [];
  for (let i = 0; i < Math.min(20, pages.length); i++) {
    const t = pages[i] || '';
    sample.push(`【第 ${i + 1} 页】${t.slice(0, 1200)}`);
  }
  const sampleText = sample.join('\n');

  const systemPrompt = '你是教材结构识别助手。根据用户给出的教材前若干页文本（含封面、目录、前言、正文），识别出教材的章节结构。'
    + '\n规则：'
    + '\n1. 只输出 JSON，不要任何解释或 Markdown 代码块包裹。'
    + '\n2. 输出格式：{"chapters":[{"title":"章节标题","startPage":起始逻辑页码}]}'
    + '\n3. startPage 为 1 起始的逻辑页号（第 1 页为 1），必须递增。'
    + '\n4. 识别主干章节（如 Chapter 1、第 1 章），跳过封面/版权/前言/目录页。'
    + '\n5. 若无法识别任何章节，输出 {"chapters":[]}。';

  try {
    const res = await callAiApi(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: '教材文本片段：\n' + sampleText }
      ],
      cfg,
      null
    );
    const text = (res && (res.cleanText || res.rawReply)) || '';
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
    const jsonStr = m ? m[1] || m[0] : text;
    const parsed = JSON.parse(jsonStr);
    if (parsed && Array.isArray(parsed.chapters) && parsed.chapters.length > 0) {
      const valid = parsed.chapters
        .map(c => ({ title: String(c.title || '').trim(), startPage: Math.max(1, Math.round(Number(c.startPage) || 0)) }))
        .filter(c => c.title && c.startPage > 0);
      if (valid.length > 0) {
        // 补全每章 endPage 与 kb 字段
        return valid.map((c, i) => {
          const next = valid[i + 1];
          return {
            id: genId(),
            title: c.title,
            level: 0,
            startPage: c.startPage,
            endPage: next ? next.startPage - 1 : pages.length,
            kb: { status: 'pending', summary: '', terms: [], keyPoints: [], mindmap: null }
          };
        });
      }
    }
    return null;
  } catch (err) {
    console.error('AI 章节切分失败:', err);
    return null;
  }
}

// ═══════════ 正文缓存读写（<userData>/books/<bookId>.json） ═══════════
async function saveBookTextCache(bookId, cacheObj) {
  if (!window.electronAPI || !window.electronAPI.booksTextSave) return { ok: false, reason: '环境不支持' };
  const res = await window.electronAPI.booksTextSave({ bookId, data: JSON.stringify(cacheObj) });
  return res || { ok: false };
}
async function loadBookTextCache(bookId) {
  if (!window.electronAPI || !window.electronAPI.booksTextLoad) return null;
  const str = await window.electronAPI.booksTextLoad({ bookId });
  if (!str) return null;
  try { return JSON.parse(str); } catch (e) { return null; }
}
async function deleteBookTextCache(bookId) {
  if (!window.electronAPI || !window.electronAPI.booksTextDelete) return;
  try { await window.electronAPI.booksTextDelete({ bookId }); } catch (e) {}
}
// 从缓存重建章节文本（缓存中 chapterTexts 缺失时兜底）
async function getChapterText(cache, chapter) {
  if (!cache) return '';
  if (cache.chapterTexts && cache.chapterTexts[chapter.id]) return cache.chapterTexts[chapter.id];
  const pages = cache.pages || [];
  const start = Math.max(1, chapter.startPage || 1);
  const end = Math.min(pages.length, chapter.endPage || pages.length);
  const parts = [];
  for (let i = start; i <= end; i++) {
    const t = pages[i - 1];
    if (t && t.trim()) parts.push(t.trim());
  }
  return parts.join('\n\n');
}
