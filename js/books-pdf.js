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
  const tocTexts = [];   // 目录（Contents）各页，按行保存（保留换行，供目录层级解析）
  let tocActive = false; // 是否正处目录区（目录可能跨多页，只有第一页含 "Contents"）
  let tocStarted = false; // 是否已识别过目录（防止正文中再次出现 "contents" 单词重新激活收集）

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

    // 进入目录区：某页含 "Contents"（含间隔式 "C O N T E N T S"）即标记开始收集。
    // 注意 tocStarted 守卫：一旦目录区结束（isBody 触发）就永久关闭，
    // 避免正文中出现的 "contents" 单词（如 "the contents of..."）重新激活收集，
    // 否则会误收集到正文/书末 Index 页。
    if (!tocStarted && !tocActive && /c[\s.]*o[\s.]*n[\s.]*t[\s.]*e[\s.]*n[\s.]*t[\s.]*s/i.test(text)) {
      tocActive = true;
      tocStarted = true;
    }
    // 目录区收集（最多 12 页）。遇正文明显特征（Preface / Chapter N 正文）立即停止。
    // 注意：不能把 "CONTENTS" 当停止信号——目录续页也以 "CONTENTS"+页码 开头，
    // 否则会漏掉后续目录（如含 3.2/4/5/6 的页被误跳过，导致章节缺失）。
    if (tocActive && tocTexts.length < 12) {
      // preface 可能是间隔式 "P R E F A C E" 或带页码前缀 "xii PREFACE"，均需停止；
      // 否则会收集到 Preface 正文页（其内容可能混入带编号的伪章节，如 "2.2 PUSHDOWN AUTOMATA"）
      // 停止条件（仅在已收集至少 1 页目录后才判定，避免误伤目录首页）：
      //  - 正文页眉 "CHAPTER 2 / TITLE"（含斜杠，目录页无此格式，最可靠）
      //  - 间隔式 Preface "P R E F A C E"
      //  - 版权页 Copyright / 致谢 / 参考书目 / 索引
      // 这些都是目录区结束、进入正文/前言/版权区的信号，混入会带来伪章节。
      const isBody = tocTexts.length > 0 && (
        /chapter\s+\d+\s*\/\s*[a-z]/i.test(text) ||
        /p\s*r\s*e\s*f\s*a\s*c\s*e/i.test(text) ||
        /acknowledg/i.test(text) ||
        /^\s*copyright/i.test(text) ||
        /^\s*selected\s+bibliography/i.test(text) ||
        /^\s*index\b/i.test(text)
      );
      // 目录区结束：停止收集；tocStarted 永久保持 true，防止正文中再次出现 "contents" 重新激活
      if (isBody) { tocActive = false; }
      else {
        try {
          const tc = await page.getTextContent();
          const byY = {};
          for (const it of tc.items || []) {
            const y = Math.round(it.transform[5]);
            const x = Math.round(it.transform[4]);
            if (!byY[y]) byY[y] = [];
            byY[y].push({ x, str: it.str });
          }
          const ys = Object.keys(byY).map(Number).sort((a, b) => b - a); // 顶→底
          // 每行保留其最小 x（原始缩进坐标），供 parseContentsFromToc 统一聚类判断层级。
          // 不在此处归一化，避免页脚/页码等噪声坐标污染整页基准。
          const tocLines = ys.map(y => {
            const items = byY[y].sort((a, b) => a.x - b.x);
            const text = items.map(t => t.str).join('');
            const minX = items[0].x;
            // tab 前缀编码原始 x（非层级），解析时再聚类
            return '\t' + minX + '\t' + text;
          });
          tocTexts.push(tocLines.join('\n'));
        } catch (e) {}
      }
    }
    // 已收集够目录页后停止
    if (tocTexts.length >= 10) tocActive = false;

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

  return { pageCount, pages, outline, tocTexts };
}

// 清洗/过滤 outline 标题：
// - 去尾部换行 \n、开头 *、两端空白
// - 过滤「乱码标题」（公式碎片）：数学教材的书签里会混入大量被拆碎的公式符号
//   （如 -Qt^n-k^ 2、CM-、(;)r)(-D'+1、4 48 ).），这些应丢弃；
//   正常章节标题（Chapter/Example/Solution/1.1 等）保留。
// 判定规则：含章节关键词 / 标准章节数字 / 中文 直接保留；
//   否则要求「≥4 个英文字母 + 字母占比≥40% + 含≥4字母的单词」才保留（正常句子），
//   纯公式碎片（字母少、夹杂大量符号）被丢弃。
const BK_OUTLINE_KEYWORDS = ['Chapter','Example','Solution','Introduction','Summary','Problems','Contents','Preface',
  'Notation','Definition','Theorem','Proposition','Lemma','Figure','Historical','Theoretical','Exercises',
  'Combinatorial','Binomial','Proof','Permutations','Combinations','Random','Variable','Distributions',
  'Distribution','Conditional','Expectation','Probability','Limit','Law','Hint','Self-Test','Generalized',
  'Basic','Sampling','Counting','Independent','Coefficient','Note','Data','Preface','Notes','Brief','Problems'];
function _cleanOutlineTitle(raw) {
  let t = String(raw || '');
  t = t.replace(/[\r\n]+/g, '').replace(/^\*+/, '').trim();
  if (!t) return null; // 空标题
  // 标准章节数字 X.Y / X.Y.Z（如 1.1, 2.3.4）→ 保留
  if (/^\d+(\.\d+){1,2}$/.test(t)) return t;
  // 含中文（CJK 字符）→ 保留
  if (/[\u4e00-\u9fff]/.test(t)) return t;
  // 含章节关键词 → 保留
  if (BK_OUTLINE_KEYWORDS.some(k => t.includes(k))) return t;
  // 否则：要求 ≥4 个英文字母、字母占比 ≥40%、且含 ≥4 字母的单词（正常句子特征）
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  const total = t.replace(/\s/g, '').length || 1;
  if (letters >= 4 && letters / total >= 0.4 && /[A-Za-z]{4,}/.test(t)) return t;
  // 纯公式碎片：丢弃
  return null;
}

// 递归解析 outline 每项的 dest → 页码（逻辑页，从 1 开始）
async function resolveOutlineDest(pdf, items, level = 0) {
  const result = [];
  for (const item of items || []) {
    const cleaned = _cleanOutlineTitle(item.title);
    if (cleaned === null) continue; // 过滤乱码标题
    let page = null;
    if (item.dest) {
      page = await resolveOutlineDestPage(pdf, item.dest);
    }
    const node = {
      title: cleaned,
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

// ── 从原书目录页（Contents）解析完整章节树 ──
// 目录页文本每行形如「章节号 标题 页号」或「标题 页号」：
//   1 Combinatorial Analysis 1
//   1.1 Introduction 1
//   1.1.1 ... 5
//   Summary 15
// 解析规则：
//   - 章节号判断层级：1（章）、1.1（节）、1.1.1（小节）
//   - 无编号条目（Summary/Problems/...）视为上一章尾部，不作为独立章节
//   - 章内小节（1.1/1.1.1）合并归属到章，作为章的子章节
// 返回 outline 兼容的「树结构」：章节点含 items（节），节含 items（小节）。
// 每个节点 {title, level, page, items}，与 splitChaptersAtLevel / bkCollectOutlineLevels 兼容，
// 因此目录页解析后同样可以走「选择章节划分颗粒度」流程。
// 从标题开头提取章节编号（"1"、"1.1"、"2.3.4"），兼容 "Chapter 1"/"Chapter1" 前缀；无编号返回 null
function _extractTocNum(title) {
  const s = String(title || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d+(?:\.\d+)*)\b/);
  if (m) return m[1];
  m = s.match(/^chapter\s*(\d+)/i);
  if (m) return m[1];
  return null;
}

// 用 outline（书签）的物理页码校准目录解析出的「印刷页码」。
// 目录页解析得到的 page 是书页上印的页码（印刷页码），而章节 startPage 需为
// PDF 物理页码（1 起始，从封面算起）。两者间存在恒定偏移 offset（封面/扉页/前言/目录
// 等前置页数量）。outline 的 page 由 pdf.js getPageIndex+1 得到，是真实物理页码，可作基准。
// 策略：按章节编号匹配 outline 与 toc 条目，计算 offset=物理-印刷，取众数，再把整棵
//       toc 树的 page 统一加上 offset。
function calibrateTocPagesByOutline(tocTree, outline, pageCount) {
  if (!tocTree || !outline) return;
  const outlinePages = new Map();
  (function walk(items) {
    for (const o of items || []) {
      const num = _extractTocNum(o.title);
      if (num && o.page > 0 && !outlinePages.has(num)) outlinePages.set(num, o.page);
      if (o.items) walk(o.items);
    }
  })(outline);
  const tocPages = new Map();
  (function walk(items) {
    for (const o of items || []) {
      const num = _extractTocNum(o.title);
      if (num && o.page > 0 && !tocPages.has(num)) tocPages.set(num, o.page);
      if (o.items) walk(o.items);
    }
  })(tocTree);
  const offsets = [];
  for (const [num, physical] of outlinePages) {
    const printed = tocPages.get(num);
    if (printed != null) offsets.push(physical - printed);
  }
  if (!offsets.length) return;
  const freq = new Map();
  for (const o of offsets) freq.set(o, (freq.get(o) || 0) + 1);
  let best = 0, bestCount = -1;
  for (const [o, c] of freq) if (c > bestCount) { best = o; bestCount = c; }
  if (best <= 0) return; // offset 为 0（无需校准）或负值（异常），不校准
  (function apply(items) {
    for (const o of items || []) {
      if (o.page > 0) {
        o.page += best;
        if (pageCount && o.page > pageCount) o.page = pageCount;
      }
      if (o.items) apply(o.items);
    }
  })(tocTree);
}

function parseContentsFromToc(tocTexts, pageCount, outline) {
  // 每行可能是收集阶段编码的「\t<原始x坐标>\t文本」，也可能是旧版纯文本。
  // 原始 x 坐标来自目录原文，需先全局聚类成缩进级别，辅助推断层级。
  const rawLines = []; // { x, text }
  for (const txt of tocTexts || []) {
    for (const raw of txt.split('\n')) {
      if (!raw.trim()) continue;
      // 提取 x 前缀（若存在）；无前缀时 x=null（未知，退回纯编号判断）
      let x = null;
      let content = raw;
      const im = raw.match(/^\t(-?\d+)\t(.*)$/);
      if (im) {
        x = parseInt(im[1], 10);
        content = im[2];
      }
      const line = content.trim();
      if (!line) continue;
      rawLines.push({ x, text: line });
    }
  }
  if (rawLines.length < 2) return null;

  // ── 缩进聚类：把所有行的 x 按间隙分组（同一层级的 x 相近），组序号即缩进深度 indent ──
  // 仅对「有 x」的行参与聚类；间隙阈值 6px 用于区分不同缩进层级。
  const X_GAP = 6;
  const xs = rawLines.map(l => l.x).filter(x => x != null);
  const xToIndent = new Map();
  if (xs.length) {
    const sorted = [...new Set(xs)].sort((a, b) => a - b);
    const clusters = [];
    let cur = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] > X_GAP) { clusters.push(cur); cur = [sorted[i]]; }
      else cur.push(sorted[i]);
    }
    clusters.push(cur);
    clusters.forEach((cls, idx) => cls.forEach(v => xToIndent.set(v, idx)));
  }
  const lines = rawLines.map(l => ({ indent: l.x == null ? null : (xToIndent.get(l.x) ?? 0), text: l.text }));

  // 无意义孤立词（目录区可能混入正文/换行残留，需过滤）
  const STOP_WORDS = new Set(['of','and','the','a','an','in','on','to','for','or','preface','contents','index',
    'acknowledgments','acknowledgements','references','appendix','appendices','notes','bibliography','errata']);

  // 每行：末尾数字 = 页号；前面是「章节号 标题」+ 可能的目录点线（dot leaders，如 "1.1 Title ..... 31"）
  const parseLine = (line, indent) => {
    // 行尾页号
    const m = line.match(/^(.*?)[\s.]+(\d+)$/);
    if (!m) return null;
    let head = m[1].trim();
    const page = parseInt(m[2], 10);
    // 去掉目录点线：从第一个 ". ." 开始是点线，截断（标题本身不含连续点线）
    const dotIdx = head.search(/\.\s+\./);
    if (dotIdx >= 0) head = head.slice(0, dotIdx).trim();
    // 过滤孤立介词/无意义词（如 "of 848"、"Preface x" 的残留）
    if (STOP_WORDS.has(head.toLowerCase())) return null;
    // Part 分组：如 "Part One: Automata and Languages" / "Part II ..." / "PART ONE"
    const partMatch = head.match(/^Part\s+(One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|\d+|[IVX]+)\s*:?\s*(.*)$/i);
    if (partMatch) {
      // 保留原始大小写（如 "One" 而非 "ONE"），罗马数字统一大写（ii → II）
      let partLabel = partMatch[1];
      if (/^[ivx]+$/i.test(partLabel)) partLabel = partLabel.toUpperCase();
      const partTitle = (partMatch[2] || '').trim();
      // 完整标题带 Part 前缀：如 "Part One: Automata and Languages" 或 "Part One"
      return { kind: 'part', num: 'Part ' + partLabel, title: 'Part ' + partLabel + (partTitle ? ': ' + partTitle : ''), page, indent };
    }
    const secMatch = head.match(/^(\d+(?:\.\d+)*)\s+(.*)$/);
    if (secMatch) return { num: secMatch[1], title: secMatch[2].trim(), page, indent };
    // 无编号条目（章内尾部如 Summary/Problems 保留；章外前置内容如 Preface/Index/Bibliography 过滤）
    const lc = head.toLowerCase();
    if (/^(preface|contents|index|selected\s+bibliography|acknowledg|about\s+the\s+author|list\s+of\s+|brief\s+contents|detailed\s+contents)/.test(lc)) return null;
    return { num: null, title: head, page, indent }; // 无编号（章内尾部）
  };

  // 收集所有条目（含 Part / 章 / 节 / 小节 / 章内尾部）
  const entries = [];
  for (const { indent, text } of lines) {
    const p = parseLine(text, indent);
    if (!p) continue;
    entries.push(p);
  }
  if (entries.length === 0) return null;

  const isPart = (e) => e && e.kind === 'part';
  const isChapter = (num) => num && /^\d+$/.test(num);
  const isSection = (num) => num && /^\d+\.\d+$/.test(num);
  const isSubsection = (num) => num && /^\d+\.\d+\.\d+$/.test(num);
  // 章标题至少含一个 ≥3 字母的完整单词（排除 of/and/the 等孤立词误判）
  const hasRealTitle = (t) => /[A-Za-z]{3,}/.test(String(t || ''));

  // 标题带章节标号（如 "1.1 Introduction"、"4.6.1 Properties..."），无标号时用纯标题
  const withNum = (num, title) => (num ? num + ' ' + title : title);

  // 是否包含 Part 分组（如 Sipser 的 Part One/Two/Three）
  const hasParts = entries.some(isPart);

  // ── 缩进辅助层级判定 ──
  // 收集阶段为每行标注了目录原文的缩进深度 indent（全局聚类，0 最左，越大越右）。
  // 编号（1 / 1.1 / 1.1.1）是最可靠的层级信号，优先采用；
  // 缩进作为补充，解决「无编号条目」（如 Sipser 目录里缩进更深的小节标题）
  // 层级不清的问题：无编号条目若缩进比「节」还深，则归属到当前节下作为更深小节，
  // 否则（与节平级或更浅，如 Summary/Problems）归属当前章下作为章的子节点。
  // 用带编号条目校准「缩进 → 语义层级」的参照（chapterIndent/sectionIndent）。
  let chapterIndent = null;  // 章的典型缩进（编号为纯整数的条目）
  let sectionIndent = null;  // 节的典型缩进（编号为 x.y 的条目）
  for (const e of entries) {
    if (e.indent == null) continue;
    if (isChapter(e.num) && chapterIndent === null) chapterIndent = e.indent;
    else if (isSection(e.num) && sectionIndent === null) sectionIndent = e.indent;
  }
  // 无编号条目若比「节」缩进还深（存在节参照时），归属到当前节下作为更深小节
  const deeperThanSection = (e) => e.indent != null && sectionIndent !== null && e.indent > sectionIndent;

  // 构建树：
  //  有 Part：Part(level0) → 章(1) → 节(2) → 小节(3)
  //  无 Part：章(0) → 节(1) → 小节(2)
  const root = [];
  let curPart = null;
  let curChapter = null;
  let curSection = null;
  const partOffset = hasParts ? 1 : 0;

  for (const e of entries) {
    if (isPart(e)) {
      curPart = { title: e.title, level: 0, page: e.page, items: [] };
      curChapter = null;
      curSection = null;
      root.push(curPart);
    } else if (isChapter(e.num) && hasRealTitle(e.title)) {
      curChapter = { title: withNum(e.num, e.title), level: partOffset, page: e.page, items: [] };
      curSection = null;
      if (curPart) curPart.items.push(curChapter);
      else root.push(curChapter);
    } else if (curChapter && isSection(e.num)) {
      curSection = { title: withNum(e.num, e.title), level: partOffset + 1, page: e.page, items: [] };
      curChapter.items.push(curSection);
    } else if (curSection && isSubsection(e.num)) {
      curSection.items.push({ title: withNum(e.num, e.title), level: partOffset + 2, page: e.page, items: [] });
    } else if (curChapter && isSubsection(e.num)) {
      // 章下直接出现小节（无一级节）：作为章的二级节点
      curChapter.items.push({ title: withNum(e.num, e.title), level: partOffset + 2, page: e.page, items: [] });
    } else if (curChapter && !e.num && hasRealTitle(e.title)) {
      // 无章节编号条目（Summary / Problems / Theoretical Exercises / 缩进较深的章内小节等）。
      // 依据缩进决定层级：
      //   缩进比「节」还深（存在节参照时）→ 归属当前节下，作为更深小节；
      //   否则（与章平级或仅比章深）→ 归属当前章下，作为章的子节点。
      if (curSection && deeperThanSection(e)) {
        curSection.items.push({ title: e.title, level: partOffset + 2, page: e.page, items: [] });
      } else {
        curSection = { title: e.title, level: partOffset + 1, page: e.page, items: [] };
        curChapter.items.push(curSection);
      }
    }
    // 无编号且缩进不深（与章平级）的纯尾部条目已由上面处理；其他无法归属的忽略
  }
  if (!root.length) return null;
  // 目录里的页码是「印刷页码」，需校准为 PDF 物理页码（用 outline 书签的物理页码作基准）
  if (outline && outline.length) {
    calibrateTocPagesByOutline(root, outline, pageCount);
  }
  return root;
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
    // endPage = 下一章起始页（**包含共享边界页**）。
    // 教材章节边界可能共享同一 PDF 页（上一章最后一页 = 下一章第一页，如新章从右页起），
    // 该页同时含上一章结尾与下一章开头，两章都应包含 → endPage 用 next.page（而非 next.page-1）。
    const endPage = next ? next.page : pageCount;
    return {
      id: genId(),
      title: o.title || ('章节 ' + (i + 1)),
      level: 0,
      startPage: startPage,
      endPage: Math.max(startPage, endPage),
      kb: { status: 'pending', summary: '', terms: [], keyPoints: [], mindmap: null }
    };
  });
  // 仅当相邻章节起始页重叠（同页多个标题：startPage 相同或更早）时合并，
  // 正常的递增章节（含共享边界页）各自独立。
  const merged = [];
  for (const c of chapters) {
    const prev = merged[merged.length - 1];
    if (prev && c.startPage <= prev.startPage) {
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
        // endPage = 下一章起始页（**包含共享边界页**，理由见 splitChaptersByOutline）
        end = nextStart ? nextStart : (parentEnd || pageCount);
      }
      if (nextStart && end > nextStart) end = nextStart;
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
        // 补全每章 endPage 与 kb 字段。
        // endPage = 下一章起始页（包含共享边界页，理由见 splitChaptersByOutline）
        return valid.map((c, i) => {
          const next = valid[i + 1];
          return {
            id: genId(),
            title: c.title,
            level: 0,
            startPage: c.startPage,
            endPage: next ? next.startPage : pages.length,
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

// ═══════════ 正文缓存读写（Electron 存 <userData>/books/<bookId>.json；PWA 存 IndexedDB） ═══════════
const _bookTextIDB = { name: 'mst-booktext', store: 'texts' };
function _bookTextOpenDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no-idb')); return; }
    const req = indexedDB.open(_bookTextIDB.name, 1);
    req.onupgradeneeded = function () {
      const db = req.result;
      if (!db.objectStoreNames.contains(_bookTextIDB.store)) db.createObjectStore(_bookTextIDB.store, { keyPath: 'bookId' });
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}
async function saveBookTextCache(bookId, cacheObj) {
  if (window.electronAPI && window.electronAPI.booksTextSave) {
    const res = await window.electronAPI.booksTextSave({ bookId, data: JSON.stringify(cacheObj) });
    return res || { ok: false };
  }
  // PWA：存 IndexedDB
  try {
    const db = await _bookTextOpenDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(_bookTextIDB.store, 'readwrite');
      tx.objectStore(_bookTextIDB.store).put({ bookId: String(bookId), data: JSON.stringify(cacheObj), savedAt: Date.now() });
      tx.oncomplete = function () { db.close(); resolve({ ok: true }); };
      tx.onerror = function () { db.close(); resolve({ ok: false }); };
    });
  } catch (e) { return { ok: false }; }
}
async function loadBookTextCache(bookId) {
  if (window.electronAPI && window.electronAPI.booksTextLoad) {
    const str = await window.electronAPI.booksTextLoad({ bookId });
    if (!str) return null;
    try { return JSON.parse(str); } catch (e) { return null; }
  }
  // PWA：从 IndexedDB 读
  try {
    const db = await _bookTextOpenDB();
    return await new Promise((resolve) => {
      const req = db.transaction(_bookTextIDB.store, 'readonly').objectStore(_bookTextIDB.store).get(String(bookId));
      req.onsuccess = function () {
        db.close();
        const rec = req.result;
        if (!rec || !rec.data) { resolve(null); return; }
        try { resolve(JSON.parse(rec.data)); } catch (e) { resolve(null); }
      };
      req.onerror = function () { db.close(); resolve(null); };
    });
  } catch (e) { return null; }
}
async function deleteBookTextCache(bookId) {
  if (window.electronAPI && window.electronAPI.booksTextDelete) {
    try { await window.electronAPI.booksTextDelete({ bookId }); } catch (e) {}
    return;
  }
  // PWA：从 IndexedDB 删除
  try {
    const db = await _bookTextOpenDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(_bookTextIDB.store, 'readwrite');
      tx.objectStore(_bookTextIDB.store).delete(String(bookId));
      tx.oncomplete = function () { db.close(); resolve(); };
      tx.onerror = function () { db.close(); resolve(); };
    });
  } catch (e) {}
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

// 带页码标记的章节文本：每页文本前插入「〔第 N 页〕」，供知识库构建时让 AI 输出摘要节点对应的 PDF 页码。
// 与 getChapterText 不同：不读 chapterTexts 缓存（缓存为纯文本无页码），始终按 pages 重建。
async function getChapterTextWithPages(cache, chapter) {
  if (!cache || !chapter) return '';
  const pages = cache.pages || [];
  const start = Math.max(1, chapter.startPage || 1);
  const end = Math.min(pages.length, chapter.endPage || pages.length);
  const parts = [];
  for (let i = start; i <= end; i++) {
    const t = pages[i - 1];
    if (t && t.trim()) parts.push('〔第 ' + i + ' 页〕' + t.trim());
  }
  return parts.join('\n\n');
}

// books.js 风格包装：基于当前活动书的内存缓存，返回带页码标记的章节文本
async function bkGetChapterTextWithPages(chapter) {
  const cache = await bkEnsureTextCache();
  if (!cache) return '';
  if (cache.pages && cache.pages.length && typeof getChapterTextWithPages === 'function') {
    try { return await getChapterTextWithPages(cache, chapter); } catch (e) { return ''; }
  }
  return '';
}

// ═══════════ 教材图片提取（供「图片集」模块：收集教材中的图片及其解释） ═══════════
// 依赖：window.pdfjsLib（pdf.min.mjs），仅 Chromium/浏览器可用（依赖 canvas）
// 图注（caption）识别：坐标行首锚定（方案 A）+ 正文引用动词过滤（方案 B）
// 图片获取：对含图注的页面渲染为 canvas → JPEG dataURL（限宽压缩）

// 从文本坐标 items 中提取图注（caption）。返回 [{ num, text }]
// 方案 A（坐标行首锚定）：按 transform[5]（y）容差聚合成真实行 → 行内按 transform[4]（x）排序
//   → 再按 x gap 拆分为栏片段（双栏/多栏排版）→ 每片段行首锚定 Figure/Fig/图 + 编号。
//   图注长度不做硬限制（教材图注可能很长）；行中引用（"...In Figure 1.1 the..."）因不在行首而天然排除。
// 方案 B（正文引用过滤）：核心判据是**编号后首词必须大写**（图注 \caption 是标题性大写名词短语；
//   跨行拆词导致的"行首 Figure"如 "Figure 13.1 with key 36..." 编号后紧跟小写介词 → 丢弃）。
//   补充：动词黑名单（shows/illustrates...）处理首词恰为大写动词的真正文引用，
//   中文词（表示/说明...）仅用于中文图注。
function bkExtractCaptionsFromText(items) {
  const caps = [];
  if (!items || !items.length) return caps;
  const valid = items.filter(it => it && it.str && it.str.trim() !== '' && Array.isArray(it.transform));
  if (!valid.length) return caps;

  // 1) 按 y 容差聚合成行（同一视觉行的词可能相差几像素基线）
  const rows = [];
  const sorted = valid.slice().sort((a, b) => a.transform[5] - b.transform[5]);
  for (const it of sorted) {
    const y = it.transform[5];
    const last = rows[rows.length - 1];
    if (!last || y - last.y > 4) rows.push({ y, xs: [] });
    rows[rows.length - 1].xs.push(it);
  }
  for (const row of rows) row.xs.sort((a, b) => a.transform[4] - b.transform[4]);

  // 2) 行内按 x gap 拆分为栏片段，每栏独立做行首判断
  // gap 用「上一 item 右边界 x+width 与当前 item 起始 x 的差」，不能用 item 起始 x 之差——
  // pdf.js 会把整句合并成一个大 item（宽可达上百 px），紧邻的下一 item 起始 x 会因此差很大。
  const segs = [];
  for (const row of rows) {
    let seg = { parts: [] };
    let prevEnd = null;
    for (const it of row.xs) {
      const x = it.transform[4];
      const xEnd = x + (it.width || 0);
      if (prevEnd !== null && x - prevEnd > 40 && seg.parts.length > 0) {
        segs.push(seg);
        seg = { parts: [] };
      }
      seg.parts.push(it.str);
      prevEnd = xEnd;
    }
    if (seg.parts.length > 0) segs.push(seg);
  }

  // 3) 行首锚定 + 正文引用过滤
  // 判据（按可靠性）：
  //   a) 编号后首词是英文小写字母 → 正文引用（含跨行拆词导致的"行首 Figure"），丢弃。
  //      真图注 \caption 是标题性大写名词短语（"Figure 12.3 Inserting a node..."）；
  //      首词非字母（数字/符号/中文）不触发，交由 b/c 判据。
  //   b) 动词黑名单 shows/illustrates...（处理首词恰好大写动词的真正文引用）。
  //   c) 中文词 表示/说明...（仅中文图注）。
  const seen = new Set();
  for (const seg of segs) {
    const t = seg.parts.join(' ').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const m = BK_CAPTION_START_RE.exec(t);
    if (!m) continue;
    const num = m[1];
    const rest = t.slice(m[0].length).trim();
    if (!rest) continue;
    if (bkFirstWordLowercase(rest) || bkIsBodyRefCaption(rest)) continue;
    const key = num + '|' + rest.slice(0, 20);
    if (seen.has(key)) continue;
    seen.add(key);
    caps.push({ num, text: rest });
  }
  return caps;
}

// 图注行首模式：Figure 1.2 / Fig. 1-2 / Fig 1.2 / 图1.2 / 图 1-2
const BK_CAPTION_START_RE = /^(?:Figure|Fig(?:ure)?\.?|图)\s*(\d+(?:[.-]\d+)*)\s*[:：,，]?\s*/i;
// 编号后首词是英文小写字母 → 判正文引用（图注 \caption 编号后是大写标题短语）
function bkFirstWordLowercase(rest) {
  const m = /^([A-Za-z])/.exec(rest);
  if (!m) return false; // 非字母开头（数字/符号/中文），不触发小写判据
  return m[1] === m[1].toLowerCase();
}
// 英文正文引用动词（头部区命中即视为"Figure 1.1 shows/illustrates..." 句式）
const BK_BODY_REF_EN_RE = /(?:^|[\s,.;:!?（(])(?:shows?|shown|showing|illustrates?|illustrating|depicts?|depicting|displays?|demonstrates?|demonstrating|presents?|presenting|summarizes?|summarizing|outlines?|outlining|compares?|comparing|describes?|describing)(?=$|[\s,.;:!?）)])/i;
// 中文正文引用词（"图1-2 说明了/显示了/表示..."）
const BK_BODY_REF_CN = ['表示', '展示', '示意', '说明', '如下', '显示', '给出', '描述', '列举', '比较', '总结'];
function bkIsBodyRefCaption(rest) {
  const head = rest.slice(0, 80); // 只看编号后头部区，长图注后部的动词不影响
  if (BK_BODY_REF_EN_RE.test(head)) return true;
  return BK_BODY_REF_CN.some(w => head.includes(w));
}

// 渲染指定 PDF 页为 JPEG dataURL（最大宽 maxW，默认 720px，质量 0.82）
async function bkRenderPageToDataUrl(pdfjsLib, page, maxW) {
  maxW = maxW || 720;
  const viewport = page.getViewport({ scale: 1 });
  const baseW = viewport.width;
  const scale = Math.min(1.5, maxW / baseW); // 放大上限 1.5x，限制输出尺寸
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas.toDataURL('image/jpeg', 0.82);
}

// 从 PDF 中提取指定章节范围的图片（渲染含图注的页面）
// 返回 [{ page, caption, dataUrl }]
async function extractChapterFigurePages(pdfData, chapter, maxCount) {
  const pdfjsLib = await ensurePdfJs();
  if (!pdfjsLib) return [];
  maxCount = maxCount || 8;
  let data;
  if (pdfData instanceof Uint8Array) data = pdfData;
  else if (pdfData && pdfData.data && typeof pdfData.type === 'string') data = new Uint8Array(pdfData.data);
  else if (pdfData && typeof pdfData === 'object') data = pdfData;
  else return [];

  let pdf = null;
  try {
    const loadingTask = pdfjsLib.getDocument({ data });
    pdf = await loadingTask.promise;
  } catch (err) {
    console.error('图片提取：PDF 打开失败', err);
    return [];
  }

  const results = [];
  const start = Math.max(1, chapter.startPage || 1);
  const end = Math.min(pdf.numPages, chapter.endPage || pdf.numPages);
  try {
    for (let p = start; p <= end && results.length < maxCount; p++) {
      try {
        const page = await pdf.getPage(p);
        // 先提取文本层图注；无图注的页跳过（避免整页文字当图片收集）
        const tc = await page.getTextContent();
        const captions = bkExtractCaptionsFromText(tc.items);
        if (captions.length === 0) continue;
        const dataUrl = await bkRenderPageToDataUrl(pdfjsLib, page, 720);
        if (!dataUrl) continue;
        for (const cap of captions.slice(0, 2)) {
          if (results.length >= maxCount) break;
          results.push({ page: p, caption: cap.num + (cap.text ? ' ' + cap.text : ''), dataUrl });
        }
      } catch (e) { /* 单页失败跳过 */ }
    }
  } finally {
    try { await pdf.destroy(); } catch (e) {}
  }
  return results;
}
