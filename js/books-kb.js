// ═══════════════════════════════════════════════════════════════════
//  教材学习 — 知识库构建（逐章 AI 生成摘要 / 术语表 / 重点 / 知识导图 / 伪代码）
//  依赖：ai-api.js（callAiApi）、settings.js（getEffectiveApiConfig）、
//        books.js（bkGetActiveBook / bkGetChapterText / bkSaveBooks / bkRenderToc）
//  提供接口：
//    bkRenderKbPanel()     — 渲染中栏知识库进度面板
//    bkConfirmStartKbBuild() — 全书构建二次确认（弹窗标注费 token 提示）
//    bkStartKbBuild()      — 开始/继续构建（含断点续跑）
//    bkStopKbBuild()       — 停止构建
//    bkRetryChapter(id)    — 单章重试（委托 bkBuildChapter）
//    bkBuildChapter(id)    — 单独构建指定章节知识库（不影响其他章节）
//    bkRebuildKb()         — 重新构建全书知识库（全部章节重置 pending 后全量重建）
//    bkBuildChapterSummary(chapter, text, cfg) — 仅重新生成单章摘要（不动术语/重点/导图）
//    bkShouldCollectPseudocode(book) / bkJudgeProgrammingBook(book,cfg) / bkEnsurePseudocodeJudged(book,cfg)
//                          — 编程书判断与伪代码收集开关（book.pseudocode）
// ═══════════════════════════════════════════════════════════════════

let bkKbBuilding = false;      // 是否正在构建
let bkBuildStopRequested = false; // 请求停止标志

// 渲染知识库进度面板（进度条 + 操作按钮），由 books.js 的 bkRenderToc 调用
function bkRenderKbPanel() {
  const book = bkGetActiveBook();
  const panel = document.getElementById('bkKbPanel');
  if (!book || !panel) return;

  const st = bkDeriveBookKbState(book);
  const pct = st.total ? Math.round((st.doneCount / st.total) * 100) : 0;

  let actions = '';
  if (bkKbBuilding) {
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

  panel.innerHTML = `
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

// 更新「当前构建章节」提示条
function bkUpdateKbCurrent(text) {
  const el = document.getElementById('bkKbCurrent');
  if (!el) return;
  if (text) {
    el.style.display = 'block';
    el.innerHTML = '<i data-lucide="loader" class="lucide-icon" style="width:12px;height:12px;"></i> ' + escapeHtml(text);
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
  } else {
    el.style.display = 'none';
    el.innerHTML = '';
  }
}

// 全书构建二次确认（点「构建知识库 / 继续构建」时弹出，标注费 token 提示）
function bkConfirmStartKbBuild() {
  const book = bkGetActiveBook();
  if (!book || bkKbBuilding) return;
  const todo = (book.chapters || []).filter(c => !(c.kb && c.kb.status === 'done'));
  if (todo.length === 0) { bkRenderKbPanel(); return; }
  showCustomConfirm(`确定要开始构建《${escapeHtml(book.title)}》的知识库吗？<br><small>将处理 <b>${todo.length}</b> 个章节的摘要、术语表、重点与知识导图${bkShouldCollectPseudocode(book) ? '及伪代码' : ''}，耗时较长，构建过程中可随时停止。<br><span style="color:var(--danger);font-weight:600;">⚠️ 全书构建比较费 token，建议仅构建需要的章节（选中章节 → 摘要导图 → 仅构建本章）。</span></small>`).then(ok => {
    if (!ok) return;
    bkStartKbBuild();
  });
}

// ── 构建主流程（断点续跑：跳过已 done 章节） ──
async function bkStartKbBuild() {
  const book = bkGetActiveBook();
  if (!book) return;
  if (bkKbBuilding) return;

  const cfg = (typeof getEffectiveApiConfig === 'function') ? getEffectiveApiConfig() : null;
  if (!cfg || !cfg.apiKey || typeof callAiApi !== 'function') {
    alert('请先在「设置 → AI」中配置 API Key，再构建知识库');
    return;
  }

  // 需要构建的章节（pending / failed）
  const todo = (book.chapters || []).filter(c => !(c.kb && c.kb.status === 'done'));
  if (todo.length === 0) { bkRenderKbPanel(); return; }

  // 编程书判断（AI 自动，用户可手动覆盖）：决定构建时是否顺带收集伪代码
  let collectPseudocode = false;
  try { collectPseudocode = await bkEnsurePseudocodeJudged(book, cfg); } catch (e) { collectPseudocode = false; }

  bkKbBuilding = true;
  bkBuildStopRequested = false;
  bkRenderKbPanel();
  bkRenderToc();

  try {
    for (let i = 0; i < todo.length; i++) {
      if (bkBuildStopRequested) break;
      const ch = todo[i];
      bkUpdateKbCurrent(`正在构建「${ch.title}」 (${i + 1}/${todo.length})`);
      await _bkBuildChapterCore(ch, cfg, collectPseudocode);
      bkRenderKbPanel();
    }
  } finally {
    bkKbBuilding = false;
    bkBuildStopRequested = false;
    bkUpdateKbCurrent('');
    bkRenderKbPanel();
    bkRenderToc();
  }
}

// 停止构建
function bkStopKbBuild() {
  if (!bkKbBuilding) return;
  bkBuildStopRequested = true;
  bkUpdateKbCurrent('正在停止…');
  bkRenderKbPanel();
}

// ── 单章构建核心 ──
// 构建单个章节：置 building 状态 → AI 生成 → 落盘结果（done/failed），并刷新目录徽章
// 供 bkStartKbBuild（全量）与 bkBuildChapter（单章）共用
// collectPseudocode=true 时顺带提取该章伪代码（编程书）
async function _bkBuildChapterCore(ch, cfg, collectPseudocode) {
  ch.kb = ch.kb || { status: 'pending', summary: '', terms: [], keyPoints: [], mindmap: null, pseudocode: [] };
  ch.kb.status = 'building';
  bkSaveBooks();
  bkRenderToc();

  let chapterText = '';
  try { chapterText = await bkGetChapterText(ch); } catch (e) { chapterText = ''; }

  try {
    const kb = await bkBuildChapterKb(ch, chapterText, cfg, collectPseudocode);
    if (kb) {
      ch.kb.status = 'done';
      ch.kb.summary = kb.summary || '';
      ch.kb.terms = Array.isArray(kb.terms) ? kb.terms : [];
      ch.kb.keyPoints = Array.isArray(kb.keyPoints) ? kb.keyPoints : [];
      ch.kb.mindmap = kb.mindmap || null;
      ch.kb.pseudocode = Array.isArray(kb.pseudocode) ? kb.pseudocode : [];
    } else {
      ch.kb.status = 'failed';
    }
  } catch (err) {
    console.error('章节知识库构建失败:', err);
    ch.kb.status = 'failed';
  }
  bkSaveBooks();
  bkRenderToc();
}

// 单独构建一个章节的知识库（不影响其他章节）
async function bkBuildChapter(chapterId) {
  const book = bkGetActiveBook();
  if (!book || bkKbBuilding) return;
  const ch = (book.chapters || []).find(c => c.id === chapterId);
  if (!ch) return;
  const cfg = (typeof getEffectiveApiConfig === 'function') ? getEffectiveApiConfig() : null;
  if (!cfg || !cfg.apiKey || typeof callAiApi !== 'function') {
    alert('请先在「设置 → AI」中配置 API Key，再构建知识库');
    return;
  }

  // 编程书判断（AI 自动，用户可手动覆盖）：决定构建时是否顺带收集伪代码
  let collectPseudocode = false;
  try { collectPseudocode = await bkEnsurePseudocodeJudged(book, cfg); } catch (e) { collectPseudocode = false; }

  bkKbBuilding = true;
  bkBuildStopRequested = false;
  bkUpdateKbCurrent(`正在构建「${ch.title}」`);
  bkRenderKbPanel();

  try {
    await _bkBuildChapterCore(ch, cfg, collectPseudocode);
    // 若当前正选中该章，刷新右栏以展示新生成的知识库
    if (typeof bkActiveChapterId !== 'undefined' && ch.id === bkActiveChapterId && typeof bkRenderMain === 'function') {
      bkRenderMain();
    }
  } finally {
    bkKbBuilding = false;
    bkBuildStopRequested = false;
    bkUpdateKbCurrent('');
    bkRenderKbPanel();
    bkRenderToc();
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
    const m = raw.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : raw);
    return obj.isProgramming === true;
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

// 重新构建全书知识库：所有章节重置为 pending 后全量重建（保留旧数据，构建成功即覆盖）
function bkRebuildKb() {
  const book = bkGetActiveBook();
  if (!book || bkKbBuilding) return;
  const chapters = book.chapters || [];
  if (chapters.length === 0) return;
  showCustomConfirm(`确定要重新构建《${escapeHtml(book.title)}》的完整知识库吗？<br><small>将重新生成全部 <b>${chapters.length}</b> 个章节的摘要、术语表、重点与知识导图，耗时较长，构建过程中可随时停止。<br><span style="color:var(--danger);font-weight:600;">⚠️ 全书构建比较费 token，建议仅构建需要的章节（选中章节 → 摘要导图 → 仅构建本章）。</span></small>`).then(ok => {
    if (!ok) return;
    for (const ch of chapters) {
      ch.kb = ch.kb || { status: 'pending', summary: '', terms: [], keyPoints: [], mindmap: null };
      ch.kb.status = 'pending';
    }
    book.updatedAt = new Date().toISOString();
    bkSaveBooks();
    bkRenderKbPanel();
    bkRenderToc();
    bkStartKbBuild();
  });
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

async function bkBuildChapterKb(chapter, chapterText, cfg, collectPseudocode) {
  const c = cfg || ((typeof getEffectiveApiConfig === 'function') ? getEffectiveApiConfig() : null);
  if (!c || !c.apiKey) return null;

  // 控制 token：正文过长时取头尾关键片段
  const text = typeof chapterText === 'string' ? chapterText : '';
  let content = text;
  if (text.length > 9000) {
    content = text.slice(0, 6500) + '\n\n[中间内容省略，约 ' + (text.length - 13000) + ' 字符]…\n\n' + text.slice(-6500);
  }
  if (content.trim().length < 50) content = '（该章节正文较短或无有效文本）';

  // 编程书：构建知识库时顺带提取该章伪代码及其解释（每条 title/code/explanation）
  const pseudoField = collectPseudocode
    ? '"pseudocode":[{"title":"伪代码/算法名称","code":"伪代码或程序代码原文（保留原始缩进与换行）","explanation":"解释（作用/输入输出/关键步骤，中文）"}]'
    : '"pseudocode":[]';

  const systemPrompt = '你是「学习导师」，负责为教材章节建立知识库。请基于给出的章节原文，输出结构化知识卡片。'
    + '\n规则：'
    + '\n1. 只输出 JSON，不要任何解释，不要用 Markdown 代码块包裹。'
    + '\n2. 输出格式：'
    + '{"summary":"250-450 字中文摘要（按节点分条）","terms":[{"term":"术语/概念","def":"一句话定义"}],"keyPoints":["重点1","重点2","重点3"],"mindmap":{"name":"章节标题","children":[{"name":"子主题","children":[{"name":"更细节"}]}]},' + pseudoField + '}'
    + '\n3. terms 给出 5-12 个关键术语；keyPoints 给出 4-8 条重点。'
    + '\n4. mindmap 为知识结构树（2-4 层），name 用中文。'
    + '\n5. summary 的节点化输出规范：\n' + BK_SUMMARY_NODE_RULE
    + (collectPseudocode
      ? '\n6. pseudocode：提取本章出现的所有伪代码/算法/程序片段，每条含 title（算法或片段名称）、code（原文，保留缩进换行）、explanation（中文解释，说明作用/输入输出/关键步骤）。若本章无伪代码，输出 []。'
      : '');

  const res = await callAiApi(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `章节标题：${chapter.title}\n\n章节原文：\n${content}` }
    ],
    c,
    null
  );
  const raw = (res && (res.cleanText || res.rawReply)) || '';
  return bkParseKbJson(raw);
}

// 仅重新生成单章摘要（不影响 terms/keyPoints/mindmap），失败返回 null
async function bkBuildChapterSummary(chapter, chapterText, cfg) {
  const c = cfg || ((typeof getEffectiveApiConfig === 'function') ? getEffectiveApiConfig() : null);
  if (!c || !c.apiKey) return null;

  // 控制 token：正文过长时取头尾关键片段（与 bkBuildChapterKb 一致）
  const text = typeof chapterText === 'string' ? chapterText : '';
  let content = text;
  if (text.length > 9000) {
    content = text.slice(0, 6500) + '\n\n[中间内容省略，约 ' + (text.length - 13000) + ' 字符]…\n\n' + text.slice(-6500);
  }
  if (content.trim().length < 50) content = '（该章节正文较短或无有效文本）';

  const systemPrompt = '你是「学习导师」，负责为教材章节撰写摘要。请基于给出的章节原文，按节点分条输出章节摘要。'
    + '\n规则：'
    + '\n1. 只输出 JSON，不要任何解释，不要用 Markdown 代码块包裹。'
    + '\n2. 输出格式：{"summary":"250-450 字中文摘要（按节点分条）"}'
    + '\n3. summary 的节点化输出规范：\n' + BK_SUMMARY_NODE_RULE;

  const res = await callAiApi(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `章节标题：${chapter.title}\n\n章节原文：\n${content}` }
    ],
    c,
    null
  );
  const raw = (res && (res.cleanText || res.rawReply)) || '';
  const obj = bkParseKbJson(raw);
  const summary = (obj && obj.summary) ? obj.summary.trim() : '';
  return summary || null;
}

// 从 AI 回复中提取知识库 JSON
function bkParseKbJson(raw) {
  if (!raw) return null;
  const text = String(raw);
  // 去除可能的代码块围栏
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  let jsonStr = fenced ? fenced[1] : text;
  // 尝试从第一个 { 到最后一个 } 截取
  const first = jsonStr.indexOf('{');
  const last = jsonStr.lastIndexOf('}');
  if (first >= 0 && last > first) jsonStr = jsonStr.slice(first, last + 1);
  try {
    const obj = JSON.parse(jsonStr);
    if (!obj || typeof obj !== 'object') return null;
    return {
      summary: String(obj.summary || '').trim(),
      terms: Array.isArray(obj.terms) ? obj.terms.slice(0, 15) : [],
      keyPoints: Array.isArray(obj.keyPoints) ? obj.keyPoints.slice(0, 10) : [],
      mindmap: (obj.mindmap && typeof obj.mindmap === 'object') ? obj.mindmap : null,
      pseudocode: Array.isArray(obj.pseudocode)
        ? obj.pseudocode
            .filter(p => p && typeof p === 'object')
            .map(p => ({
              title: String(p.title || '').trim(),
              code: String(p.code || '').trim(),
              explanation: String(p.explanation || '').trim()
            }))
            .filter(p => p.title || p.code)
            .slice(0, 30)
        : []
    };
  } catch (e) {
    console.error('知识库 JSON 解析失败:', e, jsonStr.slice(0, 300));
    return null;
  }
}
