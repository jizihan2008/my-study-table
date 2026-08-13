// ═══════════════════════════════════════════════════════════════════
//  教材学习 — 学习交互（章节讲解 / 全书问答 / 测验练习 / 摘要导图 + 存笔记）
//  依赖：ai-api.js（callAiApi / formatMarkdownBase）、settings.js（getEffectiveApiConfig）、
//        notes.js（createNewNote / saveData）、books.js（章节/缓存/检索接口）
//  提供接口（books.js 的 bkRenderTabBody 调用）：
//    bkRenderExplainTab(book, chapter)
//    bkRenderQaTab(book, chapter)
//    bkRenderQuizTab(book, chapter)
//    bkRenderSummaryTab(book, chapter)
// ═══════════════════════════════════════════════════════════════════

let _bkAiBusy = false; // 防止并发 AI 调用

function _bkApiCfg() {
  return (typeof getEffectiveApiConfig === 'function') ? getEffectiveApiConfig() : null;
}
function _bkRequireKey() {
  const cfg = _bkApiCfg();
  if (!cfg || !cfg.apiKey) {
    alert('请先在「设置 → AI」中配置 API Key');
    return null;
  }
  return cfg;
}
function _bkRenderMd(text) {
  if (typeof formatMarkdownBase === 'function') return formatMarkdownBase(String(text || ''));
  return escapeHtml(String(text || '')).replace(/\n/g, '<br>');
}

// ── 学习导师 system prompt ──
function _bkTutorSystem(kb) {
  let base = '你是「学习导师」，正在帮助用户学习一本教材。请用清晰、循序渐进的中文讲解，'
    + '拆解概念、补充直觉与例子，必要时用公式或列表。可适当使用 LaTeX（$...$）与 Markdown 排版。';
  if (kb && kb.summary) base += '\n\n【本章知识库摘要】' + kb.summary;
  if (kb && Array.isArray(kb.terms) && kb.terms.length) {
    base += '\n【本章术语表】\n' + kb.terms.map(t => `- ${t.term}：${t.def}`).join('\n');
  }
  if (kb && Array.isArray(kb.keyPoints) && kb.keyPoints.length) {
    base += '\n【本章重点】\n' + kb.keyPoints.map(k => '- ' + k).join('\n');
  }
  return base;
}

// ═══════════ 章节讲解 tab ═══════════
function bkRenderExplainTab(book, chapter) {
  const body = document.getElementById('bkMainBody');
  if (!body) return;
  body.classList.remove('bk-body-chat');
  body.classList.add('bk-body-chat');
  body.innerHTML = `
    <div class="bk-chat-flow" id="bkExplainFlow"></div>
    <div class="bk-qa-input-row">
      <input type="text" class="bk-qa-input" id="bkExplainInput" placeholder="就本章内容提问，例如：解释一下本章的核心概念…" onkeydown="if(event.key==='Enter')bkSendExplain()">
      <button class="bk-qa-send" id="bkExplainSend" onclick="bkSendExplain()"><i data-lucide="send" class="lucide-icon" style="width:14px;height:14px;"></i> 提问</button>
    </div>`;
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);

  const flow = document.getElementById('bkExplainFlow');
  flow.innerHTML = `
    <div class="bk-msg assistant bk-fade-in">
      <div class="bk-msg-row">
        <div class="bk-msg-avatar"><i data-lucide="graduation-cap" class="lucide-icon" style="width:16px;height:16px;"></i></div>
        <div class="bk-msg-bubble">
          <div class="markdown-body"><b>欢迎学习《${escapeHtml(book.title)}》的「${escapeHtml(chapter.title)}」</b><br><br>你可以：</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
            <button class="bk-quiz-btn" style="font-size:12px;padding:5px 10px;" onclick="bkExplainQuick('请深入讲解本章的核心概念与知识点，拆解难点，并给出直觉理解和例子。')">深入讲解</button>
            <button class="bk-quiz-btn" style="font-size:12px;padding:5px 10px;" onclick="bkExplainQuick('请总结本章的学习要点，整理成提纲，并指出需要重点掌握的内容。')">要点提纲</button>
            <button class="bk-quiz-btn" style="font-size:12px;padding:5px 10px;" onclick="bkExplainQuick('请举几个贴近生活的例子帮助我理解本章内容。')">举例说明</button>
          </div>
        </div>
      </div>
    </div>
    ${_bkRenderExplainHistory(chapter.id)}`;
  // 若此前已有讲解请求正在进行（切页返回），恢复「正在讲解」提示与输入按钮 loading 态
  if (_bkExplainBusy) {
    flow.insertAdjacentHTML('beforeend', `
      <div class="bk-msg assistant bk-fade-in" id="bkExplainLoadingMsg">
        <div class="bk-msg-row">
          <div class="bk-msg-avatar"><i data-lucide="graduation-cap" class="lucide-icon" style="width:16px;height:16px;"></i></div>
          <div class="bk-msg-bubble"><i data-lucide="loader" class="lucide-icon bk-spinner" style="width:12px;height:12px;border-width:2px;animation:bk-spin 0.8s linear infinite;"></i> 正在讲解…</div>
        </div>
      </div>`);
    const sendBtn = document.getElementById('bkExplainSend');
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.innerHTML = '<i data-lucide="loader" class="lucide-icon bk-spinner" style="width:14px;height:14px;border-width:2px;animation:bk-spin 0.8s linear infinite;"></i> 讲解中…';
    }
  }
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
}

// 快速提问
function bkExplainQuick(text) {
  const input = document.getElementById('bkExplainInput');
  if (!input) return;
  input.value = text;
  bkSendExplain();
}

// 发送讲解问题（知识库 + 章节原文片段）
async function bkSendExplain() {
  const input = document.getElementById('bkExplainInput');
  const sendBtn = document.getElementById('bkExplainSend');
  const flow = document.getElementById('bkExplainFlow');
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  if (!input || !flow || !book || !chapter || _bkAiBusy) return;
  const q = input.value.trim();
  if (!q) return;
  const cfg = _bkRequireKey();
  if (!cfg) return;

  // 渲染用户消息
  flow.insertAdjacentHTML('beforeend', `
    <div class="bk-msg user bk-fade-in">
      <div class="bk-msg-row">
        <div class="bk-msg-avatar"><i data-lucide="user" class="lucide-icon" style="width:15px;height:15px;"></i></div>
        <div class="bk-msg-bubble">${escapeHtml(q)}</div>
      </div>
    </div>`);
  _bkExplainLogAppend(chapter.id, 'user', q);
  input.value = '';
  _bkAiBusy = true;
  _bkExplainBusy = true;
  sendBtn.disabled = true;
  sendBtn.innerHTML = '<i data-lucide="loader" class="lucide-icon bk-spinner" style="width:14px;height:14px;border-width:2px;animation:bk-spin 0.8s linear infinite;"></i> 讲解中…';

  // 拼装：知识库 + 章节原文片段
  const kb = chapter.kb || {};
  const chapterText = await bkGetChapterText(chapter);
  const snippet = bkSnippet(chapterText, 6000);

  const messages = [
    { role: 'system', content: _bkTutorSystem(kb) + '\n\n【本章原文片段】\n' + snippet },
    { role: 'user', content: q }
  ];

  // 消息始终持久化；UI 只更新当前在讲解页时可见的流（避免切页后对已销毁元素操作）
  const renderIntoCurrent = (html, scrollBottom) => {
    const curFlow = document.getElementById('bkExplainFlow');
    if (curFlow && curFlow.isConnected) {
      curFlow.insertAdjacentHTML('beforeend', html);
      if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
      if (scrollBottom) curFlow.scrollTop = curFlow.scrollHeight;
      return true;
    }
    return false;
  };

  try {
    const res = await callAiApi(messages, cfg, null);
    const answer = (res && res.cleanText) || '（AI 未返回内容，请重试）';
    _bkExplainLogAppend(chapter.id, 'assistant', answer);
    // 记录最近的讲解结果，供"存为笔记"使用
    _bkLastExplain = { title: book.title + ' · ' + chapter.title, content: '**问题：' + q + '**\n\n' + answer };
    const loadingEl = document.getElementById('bkExplainLoadingMsg');
    if (loadingEl) loadingEl.remove();
    renderIntoCurrent(`
      <div class="bk-msg assistant bk-fade-in">
        <div class="bk-msg-row">
          <div class="bk-msg-avatar"><i data-lucide="graduation-cap" class="lucide-icon" style="width:16px;height:16px;"></i></div>
          <div class="bk-msg-bubble"><div class="markdown-body">${_bkRenderMd(answer)}</div></div>
        </div>
        <div class="bk-msg-actions">
          <button class="bk-msg-action" onclick="bkSaveExplainAsNote()"><i data-lucide="save" class="lucide-icon" style="width:12px;height:12px;"></i> 存为笔记</button>
          <button class="bk-msg-action" onclick="bkExplainQuick('${escapeJs('请用更通俗的语言再解释一遍 ' + q)}')"><i data-lucide="refresh-cw" class="lucide-icon" style="width:12px;height:12px;"></i> 再讲一遍</button>
        </div>
      </div>`, true);
  } catch (err) {
    const loadingEl = document.getElementById('bkExplainLoadingMsg');
    if (loadingEl) loadingEl.remove();
    renderIntoCurrent(`
      <div class="bk-msg assistant bk-fade-in">
        <div class="bk-msg-row">
          <div class="bk-msg-avatar"><i data-lucide="alert-triangle" class="lucide-icon" style="width:16px;height:16px;"></i></div>
          <div class="bk-msg-bubble" style="color:var(--danger);">AI 调用失败：${escapeHtml(String((err && err.message) || err))}</div>
        </div>
      </div>`, false);
  } finally {
    _bkAiBusy = false;
    _bkExplainBusy = false;
    const curBtn = document.getElementById('bkExplainSend');
    if (curBtn) {
      curBtn.disabled = false;
      curBtn.innerHTML = '<i data-lucide="send" class="lucide-icon" style="width:14px;height:14px;"></i> 提问';
      if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
    }
  }
}

let _bkLastExplain = null; // 最近一次讲解结果，供存笔记
let _bkExplainBusy = false; // 章节讲解是否正在请求（用于切页后恢复「正在讲解」提示）

// ── 章节讲解记录持久化（按章节存 localStorage，切换页面后不丢失） ──
// key: study_bk_explain_logs_v1 = { [chapterId]: [{role, content, ts}] }，每章上限 60 条
function _bkExplainLogLoad(chapterId) {
  try {
    const store = JSON.parse(localStorage.getItem('study_bk_explain_logs_v1') || '{}');
    const arr = store[chapterId];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function _bkExplainLogSave(chapterId, logs) {
  try {
    const store = JSON.parse(localStorage.getItem('study_bk_explain_logs_v1') || '{}');
    store[chapterId] = logs;
    localStorage.setItem('study_bk_explain_logs_v1', JSON.stringify(store));
  } catch (e) {}
}
function _bkExplainLogAppend(chapterId, role, content) {
  if (!chapterId || !content) return;
  const logs = _bkExplainLogLoad(chapterId);
  logs.push({ role: role, content: String(content), ts: Date.now() });
  if (logs.length > 60) logs.splice(0, logs.length - 60);
  _bkExplainLogSave(chapterId, logs);
}

// 渲染章节讲解的历史记录（持久化消息，供 bkRenderExplainTab 调用）
function _bkRenderExplainHistory(chapterId) {
  const logs = _bkExplainLogLoad(chapterId);
  return logs.map(m => {
    if (m.role === 'user') {
      return `<div class="bk-msg user">
        <div class="bk-msg-row">
          <div class="bk-msg-avatar"><i data-lucide="user" class="lucide-icon" style="width:15px;height:15px;"></i></div>
          <div class="bk-msg-bubble">${escapeHtml(m.content)}</div>
        </div>
      </div>`;
    }
    return `<div class="bk-msg assistant">
      <div class="bk-msg-row">
        <div class="bk-msg-avatar"><i data-lucide="graduation-cap" class="lucide-icon" style="width:16px;height:16px;"></i></div>
        <div class="bk-msg-bubble"><div class="markdown-body">${_bkRenderMd(m.content)}</div></div>
      </div>
      <div class="bk-msg-actions">
        <button class="bk-msg-action" onclick="bkSaveExplainAsNote()"><i data-lucide="save" class="lucide-icon" style="width:12px;height:12px;"></i> 存为笔记</button>
        <button class="bk-msg-action" onclick="bkExplainQuick('${escapeJs('请用更通俗的语言再解释一遍 ' + m.content)}')"><i data-lucide="refresh-cw" class="lucide-icon" style="width:12px;height:12px;"></i> 再讲一遍</button>
      </div>
    </div>`;
  }).join('');
}

// ═══════════ 全书问答 tab ═══════════
function bkRenderQaTab(book, chapter) {
  const body = document.getElementById('bkMainBody');
  if (!body) return;
  body.classList.remove('bk-body-chat');
  body.classList.add('bk-body-chat');
  body.innerHTML = `
    <div class="bk-chat-flow" id="bkQaFlow"></div>
    <div class="bk-qa-input-row">
      <input type="text" class="bk-qa-input" id="bkQaInput" placeholder="针对全书提问，AI 会自动检索相关章节…" onkeydown="if(event.key==='Enter')bkSendQa()">
      <button class="bk-qa-send" id="bkQaSend" onclick="bkSendQa()"><i data-lucide="search" class="lucide-icon" style="width:14px;height:14px;"></i> 提问</button>
    </div>`;
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);

  const flow = document.getElementById('bkQaFlow');
  flow.innerHTML = `
    <div class="bk-msg assistant bk-fade-in">
      <div class="bk-msg-row">
        <div class="bk-msg-avatar"><i data-lucide="message-circle-question" class="lucide-icon" style="width:16px;height:16px;"></i></div>
        <div class="bk-msg-bubble">对《${escapeHtml(book.title)}》全书提问，我会自动检索相关章节并结合原文回答。<br>例如：<br>· "什么是 ${escapeHtml((book.chapters && book.chapters[0] && book.chapters[0].title) || '核心概念')}？"<br>· "讲讲书里关于 XXX 的推导过程"</div>
      </div>
    </div>`;
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
}

async function bkSendQa() {
  const input = document.getElementById('bkQaInput');
  const sendBtn = document.getElementById('bkQaSend');
  const flow = document.getElementById('bkQaFlow');
  const book = bkGetActiveBook();
  if (!input || !flow || !book || _bkAiBusy) return;
  const q = input.value.trim();
  if (!q) return;
  const cfg = _bkRequireKey();
  if (!cfg) return;

  flow.insertAdjacentHTML('beforeend', `
    <div class="bk-msg user bk-fade-in">
      <div class="bk-msg-row">
        <div class="bk-msg-avatar"><i data-lucide="user" class="lucide-icon" style="width:15px;height:15px;"></i></div>
        <div class="bk-msg-bubble">${escapeHtml(q)}</div>
      </div>
    </div>`);
  input.value = '';
  _bkAiBusy = true;
  sendBtn.disabled = true;
  sendBtn.innerHTML = '<i data-lucide="loader" class="lucide-icon bk-spinner" style="width:14px;height:14px;border-width:2px;animation:bk-spin 0.8s linear infinite;"></i> 检索中…';

  // 检索命中章节
  const hitChapters = bkSearchChapters(book, q);
  const hitNames = hitChapters.map(c => c.title);

  // 拼装原文片段（命中章节优先；无命中时取全书前几页）
  let contextParts = [];
  let usedChapters = hitChapters;
  if (hitChapters.length === 0) {
    const all = book.chapters || [];
    usedChapters = all.slice(0, 2);
  }
  for (const ch of usedChapters) {
    const kb = ch.kb || {};
    let part = `【章节：${ch.title}】\n`;
    if (kb.summary) part += `知识库摘要：${kb.summary}\n`;
    const t = await bkGetChapterText(ch);
    if (t) part += `原文片段：\n${bkSnippet(t, 3500)}\n`;
    contextParts.push(part);
  }
  const context = contextParts.join('\n\n---\n\n') || '（未检索到有效原文）';

  try {
    const res = await callAiApi([
      { role: 'system', content: '你是教材问答助手。基于用户教材内容回答问题，优先使用提供的原文与知识库。'
        + '回答用中文、条理清晰，可引用章节出处。若原文不足，明确说明并结合常识补充。\n\n【检索到的教材内容】\n' + context },
      { role: 'user', content: q }
    ], cfg, null);
    const answer = (res && res.cleanText) || '（AI 未返回内容，请重试）';

    flow.insertAdjacentHTML('beforeend', `
      <div class="bk-msg assistant bk-fade-in">
        <div class="bk-msg-row">
          <div class="bk-msg-avatar"><i data-lucide="message-circle-question" class="lucide-icon" style="width:16px;height:16px;"></i></div>
          <div class="bk-msg-bubble">
            ${hitNames.length ? `<div class="bk-msg-meta">命中章节：<b>${escapeHtml(hitNames.join('、'))}</b></div>` : ''}
            <div class="markdown-body">${_bkRenderMd(answer)}</div>
          </div>
        </div>
        <div class="bk-msg-actions">
          <button class="bk-msg-action" onclick="bkSaveQaAsNote()"><i data-lucide="save" class="lucide-icon" style="width:12px;height:12px;"></i> 存为笔记</button>
        </div>
      </div>`);
    _bkLastQa = { title: book.title + ' · 问答', content: '**问题：' + q + '**\n\n' + answer };
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
    flow.scrollTop = flow.scrollHeight;
  } catch (err) {
    flow.insertAdjacentHTML('beforeend', `
      <div class="bk-msg assistant bk-fade-in">
        <div class="bk-msg-row">
          <div class="bk-msg-avatar"><i data-lucide="alert-triangle" class="lucide-icon" style="width:16px;height:16px;"></i></div>
          <div class="bk-msg-bubble" style="color:var(--danger);">AI 调用失败：${escapeHtml(String((err && err.message) || err))}</div>
        </div>
      </div>`);
  } finally {
    _bkAiBusy = false;
    sendBtn.disabled = false;
    sendBtn.innerHTML = '<i data-lucide="search" class="lucide-icon" style="width:14px;height:14px;"></i> 提问';
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
  }
}

let _bkLastQa = null;

// ═══════════ 测验练习 tab ═══════════
let _bkQuiz = null;       // 当前测验题目数组
let _bkQuizType = 'choice'; // choice | mixed
let _bkQuizHistory = null; // 当前书籍测验记录（引用）

// 测验状态持久化：key study_bk_quiz_state_v1 = { [bookId_chapterId]: { type, questions } }
// 切换页面后返回仍保留当前题目与已作答内容
function _bkQuizStateKey(book, chapter) { return (book ? book.id : '') + '_' + (chapter ? chapter.id : ''); }
function _bkQuizSaveState() {
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  if (!book || !chapter || !_bkQuiz) return;
  try {
    const store = JSON.parse(localStorage.getItem('study_bk_quiz_state_v1') || '{}');
    store[_bkQuizStateKey(book, chapter)] = { type: _bkQuizType, questions: _bkQuiz };
    localStorage.setItem('study_bk_quiz_state_v1', JSON.stringify(store));
  } catch (e) {}
}
function _bkQuizLoadState() {
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  if (!book || !chapter) return null;
  try {
    const store = JSON.parse(localStorage.getItem('study_bk_quiz_state_v1') || '{}');
    const s = store[_bkQuizStateKey(book, chapter)];
    return (s && Array.isArray(s.questions) && s.questions.length) ? s : null;
  } catch (e) { return null; }
}

function bkRenderQuizTab(book, chapter) {
  const body = document.getElementById('bkMainBody');
  if (!body) return;
  body.classList.remove('bk-body-chat');
  _bkQuizHistory = book.quizRecords || [];
  // 恢复持久化的当前测验（题目 + 已作答内容），无则从空态开始
  const saved = _bkQuizLoadState();
  _bkQuiz = null;
  if (saved) {
    _bkQuiz = saved.questions;
    _bkQuizType = saved.type === 'mixed' ? 'mixed' : 'choice';
  }

  body.innerHTML = `
    <div class="bk-quiz-toolbar">
      <button class="bk-quiz-btn primary" id="bkQuizGenBtn" onclick="bkGenerateQuiz()">
        <i data-lucide="wand-2" class="lucide-icon" style="width:14px;height:14px;"></i> 生成本章测验
      </button>
      <select class="bk-quiz-select" id="bkQuizTypeSelect" title="题型">
        <option value="choice" ${_bkQuizType === 'choice' ? 'selected' : ''}>选择题</option>
        <option value="mixed" ${_bkQuizType === 'mixed' ? 'selected' : ''}>混合（选择+简答）</option>
      </select>
      <span style="font-size:11.5px;color:var(--text-secondary);">基于「${escapeHtml(chapter.title)}」知识库</span>
    </div>
    <div id="bkQuizArea">
      <div class="bk-empty-hint">
        <i data-lucide="list-checks" class="lucide-icon" style="width:52px;height:52px;"></i>
        <p>点击「生成本章测验」开始练习</p>
      </div>
    </div>
    <div class="bk-quiz-history" id="bkQuizHistory"></div>`;
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
  // 恢复已保存题目时直接渲染（替换空态），保留作答
  if (_bkQuiz && _bkQuiz.length) {
    const area = document.getElementById('bkQuizArea');
    if (area) bkRenderQuizQuestions();
  }
  bkRenderQuizHistory();
}

function bkRenderQuizHistory() {
  const wrap = document.getElementById('bkQuizHistory');
  if (!wrap) return;
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  const all = (book && book.quizRecords) || [];
  // 只显示当前章节的测验记录（保留原始索引供删除定位）
  const items = all
    .map((r, i) => ({ r, origIdx: i }))
    .filter(x => !chapter || String(x.r.chapterId) === String(chapter.id));
  if (items.length === 0) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = `
    <div class="bk-quiz-history-title"><i data-lucide="history" class="lucide-icon" style="width:14px;height:14px;"></i> 本章测验记录</div>
    ${items.slice().reverse().map(x => {
      const r = x.r;
      const pct = r.total ? Math.round((r.score / r.total) * 100) : 0;
      return `<div class="bk-quiz-record ${r.wrong && r.wrong.length ? 'wrong-rec' : ''}">
        <span class="bk-quiz-record-score ${pct >= 60 ? 'good' : 'bad'}">${r.score}/${r.total} (${pct}%)</span>
        <span style="color:var(--text-secondary);font-size:12px;">${escapeHtml(r.chapterTitle || '')}</span>
        ${r.wrong && r.wrong.length ? `<span class="bk-quiz-record-wrong">错 ${r.wrong.length} 题</span>` : ''}
        <span class="bk-quiz-record-date">${escapeHtml((r.date || '').slice(0, 16).replace('T', ' '))}</span>
        <button class="bk-quiz-record-del" onclick="bkDeleteQuizRecord(${x.origIdx})" title="删除这条测验记录"><i data-lucide="trash-2" class="lucide-icon" style="width:11px;height:11px;"></i></button>
      </div>`;
    }).join('')}`;
}

// 删除单条测验记录
function bkDeleteQuizRecord(idx) {
  const book = bkGetActiveBook();
  if (!book || !Array.isArray(book.quizRecords)) return;
  const rec = book.quizRecords[idx];
  if (!rec) return;
  showCustomConfirm(`确定删除这条测验记录吗？<br><small>${escapeHtml(rec.chapterTitle || '')} · ${rec.score}/${rec.total}（${escapeHtml((rec.date || '').slice(0, 16).replace('T', ' '))}）</small>`).then(ok => {
    if (!ok) return;
    book.quizRecords.splice(idx, 1);
    book.updatedAt = new Date().toISOString();
    bkSaveBooks();
    bkRenderQuizHistory();
  });
}

// ═══════════ 错题本系统（每本书独立） ═══════════
// 数据：book.wrongBook = { items: [{ id, chapterId, chapterTitle, type, text, options[], answer, explain, myChoice, myAnswer, date, mastered }] }
// 来源：测验提交批改后自动收录答错/批改不通过的题目（按题干去重，再次做错则重置已掌握状态）

function _bkWrongCollect(book, chapter, wrongQs) {
  if (!book || !Array.isArray(wrongQs) || wrongQs.length === 0) return;
  if (!book.wrongBook || !Array.isArray(book.wrongBook.items)) book.wrongBook = { items: [] };
  const items = book.wrongBook.items;
  for (const q of wrongQs) {
    if (!q || !q.text) continue;
    const myChoice = q.type === 'choice'
      ? (q._userChoice !== undefined ? _bkQuizOptParts(q.options[q._userChoice], q._userChoice).letter : '')
      : '';
    const existing = items.find(it => String(it.text) === String(q.text));
    if (existing) {
      existing.date = new Date().toISOString();
      existing.mastered = false;
      existing.myChoice = myChoice || existing.myChoice;
      existing.myAnswer = q._userAnswer || existing.myAnswer;
    } else {
      items.push({
        id: Date.now() + Math.floor(Math.random() * 1000),
        chapterId: chapter ? chapter.id : '',
        chapterTitle: chapter ? chapter.title : '',
        type: q.type || 'choice',
        text: q.text || '',
        options: Array.isArray(q.options) ? q.options : [],
        answer: q.answer || '',
        explain: q.explain || '',
        myChoice: myChoice,
        myAnswer: q._userAnswer || '',
        date: new Date().toISOString(),
        mastered: false
      });
    }
  }
  if (items.length > 200) items.splice(0, items.length - 200);
  book.updatedAt = new Date().toISOString();
  bkSaveBooks();
}

// 渲染错题本 tab（全书错题按章节分组，未掌握在前）
function bkRenderWrongbookTab(book, chapter) {
  const body = document.getElementById('bkMainBody');
  if (!body) return;
  body.classList.remove('bk-body-chat');
  const items = (book.wrongBook && book.wrongBook.items) || [];
  if (items.length === 0) {
    body.innerHTML = `
      <div class="bk-empty-hint">
        <i data-lucide="book-x" class="lucide-icon" style="width:52px;height:52px;"></i>
        <p>错题本是空的<br><small>测验中答错的题会自动收录到这里</small></p>
      </div>`;
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
    return;
  }
  // 按章节分组
  const groups = {};
  for (const it of items) {
    const key = String(it.chapterId || '');
    if (!groups[key]) groups[key] = { title: it.chapterTitle || '未分章节', list: [] };
    groups[key].list.push(it);
  }
  const total = items.length;
  const undone = items.filter(i => !i.mastered).length;
  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
      <span style="font-size:13px;color:var(--text-secondary);"><b>${undone}</b> 道未掌握 / 共 ${total} 道错题</span>
      <button class="bk-msg-action" style="margin-left:auto;" onclick="bkWrongClearAll()"><i data-lucide="trash-2" class="lucide-icon" style="width:12px;height:12px;"></i> 清空错题本</button>
    </div>
    ${Object.keys(groups).map(key => {
      const g = groups[key];
      const list = g.list.filter(i => !i.mastered).concat(g.list.filter(i => i.mastered));
      return `<div class="bk-kb-card" style="margin-bottom:12px;">
        <div class="bk-kb-card-title"><i data-lucide="book-x" class="lucide-icon" style="width:14px;height:14px;"></i> ${escapeHtml(g.title)}<span style="font-weight:400;font-size:11px;color:var(--text-secondary);">（${g.list.length} 题）</span></div>
        ${list.map(it => bkWrongItemHtml(it)).join('')}
      </div>`;
    }).join('')}`;
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
}

function bkWrongItemHtml(it) {
  const choiceHtml = it.type === 'choice'
    ? `<div class="bk-wrong-options">${(it.options || []).map((o, oi) => {
        const { letter, label } = _bkQuizOptParts(o, oi);
        const isAns = letter === _bkNormAnswer(it.answer);
        const isMine = letter === it.myChoice;
        let cls = 'bk-wrong-opt';
        if (isAns) cls += ' correct-opt';
        else if (isMine) cls += ' wrong-opt';
        return `<div class="${cls}"><span class="bk-quiz-opt-letter">${letter}</span>${escapeHtml(label)}</div>`;
      }).join('')}</div>`
    : `<div class="bk-wrong-mine">我的答案：${escapeHtml(it.myAnswer || '（未作答）')}</div>`;
  return `<div class="bk-wrong-item ${it.mastered ? 'mastered' : ''}">
    <div class="bk-wrong-q">${escapeHtml(it.text)}</div>
    ${choiceHtml}
    <div class="bk-wrong-answer">正确答案：<b>${escapeHtml(it.answer || '')}</b></div>
    ${it.explain ? `<div class="bk-wrong-expl">解析：${escapeHtml(it.explain)}</div>` : ''}
    <div class="bk-wrong-actions">
      <span class="bk-wrong-date">${escapeHtml((it.date || '').slice(0, 16).replace('T', ' '))}</span>
      <button class="bk-msg-action" onclick="bkWrongExplain(${it.id})" title="发给本章讲解 AI"><i data-lucide="message-circle-question" class="lucide-icon" style="width:12px;height:12px;"></i> 讲解此题</button>
      <button class="bk-msg-action" onclick="bkWrongToggleMastered(${it.id})" title="${it.mastered ? '恢复为未掌握' : '标记为已掌握'}"><i data-lucide="${it.mastered ? 'rotate-ccw' : 'check'}" class="lucide-icon" style="width:12px;height:12px;"></i> ${it.mastered ? '恢复' : '已掌握'}</button>
      <button class="bk-msg-action" onclick="bkWrongDelete(${it.id})" title="删除这道错题"><i data-lucide="trash-2" class="lucide-icon" style="width:12px;height:12px;"></i></button>
    </div>
  </div>`;
}

// 把错题发给本章讲解 AI 详细解释
function bkWrongExplain(id) {
  const book = bkGetActiveBook();
  if (!book || !book.wrongBook) return;
  const it = book.wrongBook.items.find(i => i.id === id);
  if (!it) return;
  let text = '这是我做错的一道题，请仔细讲一下解题思路和为什么是这个答案：\n【题干】' + it.text;
  if (it.type === 'choice') {
    text += '\n【选项】' + (Array.isArray(it.options) ? it.options.join('；') : '')
      + '\n【正确答案】' + (it.answer || '未给出') + (it.explain ? '\n【题目解析】' + it.explain : '');
  } else {
    text += '\n【参考答案】' + (it.answer || '未给出') + (it.explain ? '\n【评分要点】' + it.explain : '');
  }
  if (typeof bkSwitchTab === 'function') bkSwitchTab('explain');
  bkExplainQuick(text);
}

// 标记已掌握 / 恢复未掌握
function bkWrongToggleMastered(id) {
  const book = bkGetActiveBook();
  if (!book || !book.wrongBook) return;
  const it = book.wrongBook.items.find(i => i.id === id);
  if (!it) return;
  it.mastered = !it.mastered;
  book.updatedAt = new Date().toISOString();
  bkSaveBooks();
  bkRenderWrongbookTab(book, bkGetActiveChapter());
}

// 删除单道错题
function bkWrongDelete(id) {
  const book = bkGetActiveBook();
  if (!book || !book.wrongBook) return;
  const idx = book.wrongBook.items.findIndex(i => i.id === id);
  if (idx < 0) return;
  book.wrongBook.items.splice(idx, 1);
  book.updatedAt = new Date().toISOString();
  bkSaveBooks();
  bkRenderWrongbookTab(book, bkGetActiveChapter());
}

// 清空错题本
function bkWrongClearAll() {
  const book = bkGetActiveBook();
  if (!book || !book.wrongBook || book.wrongBook.items.length === 0) return;
  showCustomConfirm(`确定清空《${escapeHtml(book.title)}》的错题本吗？<br><small>共 ${book.wrongBook.items.length} 道错题，清空后不可恢复。</small>`).then(ok => {
    if (!ok) return;
    book.wrongBook.items = [];
    book.updatedAt = new Date().toISOString();
    bkSaveBooks();
    bkRenderWrongbookTab(book, bkGetActiveChapter());
  });
}

// 生成测验
async function bkGenerateQuiz() {
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  const btn = document.getElementById('bkQuizGenBtn');
  const area = document.getElementById('bkQuizArea');
  const typeSel = document.getElementById('bkQuizTypeSelect');
  if (!book || !chapter || !btn || !area || _bkAiBusy) return;
  const cfg = _bkRequireKey();
  if (!cfg) return;
  _bkQuizType = (typeSel && typeSel.value) || 'choice';

  _bkAiBusy = true;
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader" class="lucide-icon bk-spinner" style="width:14px;height:14px;border-width:2px;animation:bk-spin 0.8s linear infinite;"></i> 生成中…';

  area.innerHTML = `<div class="bk-loading"><div class="bk-spinner"></div> AI 正在根据本章知识库生成题目…</div>`;

  try {
    const kb = chapter.kb || {};
    const kbText = [
      kb.summary ? '摘要：' + kb.summary : '',
      kb.terms && kb.terms.length ? '术语：' + kb.terms.map(t => `${t.term}(${t.def})`).join('；') : '',
      kb.keyPoints && kb.keyPoints.length ? '重点：' + kb.keyPoints.join('；') : ''
    ].filter(Boolean).join('\n');
    const chapterText = await bkGetChapterText(chapter);
    const snippet = bkSnippet(chapterText, 5000);

    const typeDesc = _bkQuizType === 'choice'
      ? '全部为单项选择题（4 个选项，答案唯一）。'
      : '共 6 题：4 道单项选择题 + 2 道简答题。';

    const res = await callAiApi([
      { role: 'system', content: '你是测验出题老师。根据教材章节内容出题。'
        + '\n规则：'
        + '\n1. 只输出 JSON，不要解释，不要代码块包裹。'
        + '\n2. 输出格式：{"questions":[{"type":"choice","text":"题干","options":["A. ...","B. ...","C. ...","D. ..."],"answer":"A","explain":"解析（一句话）"},{"type":"short","text":"简答题干","answer":"参考答案要点","explain":"评分参考"}]}'
        + '\n3. choice 题 options 用 "A. xxx" 格式，answer 填选项字母；short 题 answer 填参考答案。'
        + `\n4. ${typeDesc}`
        + '\n5. 题目难度循序渐进，覆盖本章核心概念。' },
      { role: 'user', content: `章节：${chapter.title}\n知识库：\n${kbText}\n\n原文片段：\n${snippet}` }
    ], cfg, null);

    const raw = (res && (res.cleanText || res.rawReply)) || '';
    let parsed = bkParseQuizJson(raw);
    if (!parsed || parsed.length === 0) throw new Error('题目解析失败');
    // 选了「选择题」类型时强制过滤掉简答题（AI 偶尔不遵守题型要求）
    if (_bkQuizType === 'choice') parsed = parsed.filter(q => q.type === 'choice');
    if (parsed.length === 0) throw new Error('AI 未生成选择题，请重试');
    _bkQuiz = parsed;
    _bkQuizSaveState();
    bkRenderQuizQuestions();
  } catch (err) {
    area.innerHTML = `<div class="bk-empty-hint"><i data-lucide="alert-triangle" class="lucide-icon" style="width:40px;height:40px;"></i><p>测验生成失败：${escapeHtml(String((err && err.message) || err))}<br><small>请确认知识库已构建完成（可在「摘要导图」中查看），或重试。</small></p></div>`;
  } finally {
    _bkAiBusy = false;
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="wand-2" class="lucide-icon" style="width:14px;height:14px;"></i> 生成本章测验';
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
  }
}

function bkParseQuizJson(raw) {
  const obj = bkSafeParseJson(raw);
  if (!obj || !obj.questions || !Array.isArray(obj.questions)) return null;
  return obj.questions.map((q, i) => ({
    type: q.type === 'short' ? 'short' : 'choice',
    text: String(q.text || ('第 ' + (i + 1) + ' 题')).trim(),
    options: Array.isArray(q.options) ? q.options.map(o => String(o).trim()) : [],
    answer: String(q.answer || '').trim(),
    explain: String(q.explain || '').trim()
  })).filter(q => q.text && q.answer);
}

// 解析选择题选项：提取前缀字母与正文。
// 兼容 "A. xxx" / "A、" / "A：" / "A)" 等格式；无字母前缀时按序号补 A/B/C/D，避免文本重复显示
function _bkQuizOptParts(opt, idx) {
  const s = String(opt || '').trim();
  const m = s.match(/^([A-Za-z])[.、．，,:：)）]\s*(.*)$/);
  if (m) {
    const letter = m[1].toUpperCase();
    const label = m[2].trim();
    return { letter: letter, label: label || s };
  }
  return { letter: String.fromCharCode(65 + (idx || 0)), label: s };
}

// 归一化正确答案为单个大写字母（兼容 "A" / "A. 选项A" / "a" 等）
function _bkNormAnswer(a) {
  const s = String(a || '').trim().toUpperCase();
  const m = s.match(/^([A-Z])/);
  return m ? m[1] : s;
}

// 渲染题目列表
function bkRenderQuizQuestions() {
  const area = document.getElementById('bkQuizArea');
  if (!area || !_bkQuiz) return;
  area.innerHTML = _bkQuiz.map((q, i) => `
    <div class="bk-quiz-card" id="bkQuizCard${i}">
      <div class="bk-quiz-qhead">
        <span class="bk-quiz-qnum">Q${i + 1}</span>
        <span class="bk-quiz-qtype">${q.type === 'choice' ? '单选题' : '简答题'}</span>
      </div>
      <div class="bk-quiz-qtext">${escapeHtml(q.text)}</div>
      ${q.type === 'choice' ? `
        <div style="margin-bottom:8px;">
          ${q.options.map((opt, oi) => {
            const { letter, label } = _bkQuizOptParts(opt, oi);
            // 已判分（恢复时）：标注正确答案/错选；未判分：恢复用户已选样式
            const graded = !!q._resultCls;
            let cls = 'bk-quiz-opt';
            if (graded) {
              const isAnswer = letter === _bkNormAnswer(q.answer);
              const isUser = q._userChoice === oi;
              if (isAnswer) cls += ' correct-opt';
              else if (isUser) cls += ' wrong-opt';
            } else if (q._userChoice === oi) {
              cls += ' selected';
            }
            return `<div class="${cls}" id="bkQuizOpt${i}_${oi}" onclick="bkSelectChoice(${i},${oi})" data-idx="${oi}"${graded ? ' style="pointer-events:none;"' : ''}>
              <span class="bk-quiz-opt-letter">${letter}</span><span>${escapeHtml(label)}</span></div>`;
          }).join('')}
        </div>` : `
        <textarea class="bk-quiz-short-text" id="bkQuizShort${i}" placeholder="写下你的答案…" oninput="bkQuizShortInput(${i}, this.value)" ${q._resultCls ? 'readonly' : ''}>${escapeHtml(q._userAnswer || '')}</textarea>`}
      <div class="${q._resultCls || 'bk-quiz-result'}" id="bkQuizResult${i}">${q._resultHtml || ''}</div>
      <div style="margin-top:8px;display:flex;justify-content:flex-end;">
        <button class="bk-msg-action" onclick="bkExplainQuizQuestion(${i})" title="把这道题发给本章讲解 AI，让它仔细解释">
          <i data-lucide="message-circle-question" class="lucide-icon" style="width:12px;height:12px;"></i> 讲解此题
        </button>
      </div>
    </div>`).join('') + `
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px;">
      <button class="bk-quiz-btn" onclick="bkClearQuizAnswers()">清空答案</button>
      <button class="bk-quiz-btn primary" id="bkQuizSubmitBtn" onclick="bkSubmitQuiz()">
        <i data-lucide="check-check" class="lucide-icon" style="width:14px;height:14px;"></i> 提交批改
      </button>
    </div>`;
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
}

// 选择选择题答案
function bkSelectChoice(qIdx, optIdx) {
  const q = _bkQuiz[qIdx];
  if (!q || q.type !== 'choice') return;
  q._userChoice = optIdx;
  const card = document.getElementById('bkQuizCard' + qIdx);
  if (card) card.querySelectorAll('.bk-quiz-opt').forEach((el, oi) => {
    el.classList.toggle('selected', oi === optIdx);
  });
  _bkQuizSaveState();
}

// 简答题输入实时保存
function bkQuizShortInput(qIdx, value) {
  const q = _bkQuiz[qIdx];
  if (!q || q.type !== 'short') return;
  q._userAnswer = value;
  _bkQuizSaveState();
}

// 把测验题目发给本章讲解 AI 详细解释（跳转章节讲解并自动提问）
function bkExplainQuizQuestion(idx) {
  const q = _bkQuiz && _bkQuiz[idx];
  if (!q) return;
  let text = '这是本章测验中的一道题，请仔细解释一下这道题的做法与思路（包括为什么是这个答案）：\n【题干】' + q.text;
  if (q.type === 'choice') {
    text += '\n【选项】' + (Array.isArray(q.options) ? q.options.join('；') : '')
      + '\n【正确答案】' + (q.answer || '未给出') + (q.explain ? '\n【题目解析】' + q.explain : '');
  } else {
    text += '\n【参考答案】' + (q.answer || '未给出') + (q.explain ? '\n【评分要点】' + q.explain : '');
  }
  if (typeof bkSwitchTab === 'function') bkSwitchTab('explain');
  bkExplainQuick(text);
}

// 清空答案
function bkClearQuizAnswers() {
  if (!_bkQuiz) return;
  for (const q of _bkQuiz) { delete q._userChoice; delete q._userAnswer; delete q._resultCls; delete q._resultHtml; }
  const area = document.getElementById('bkQuizArea');
  if (area) bkRenderQuizQuestions();
  _bkQuizSaveState();
}

// 提交批改
async function bkSubmitQuiz() {
  if (!_bkQuiz || _bkAiBusy) return;
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  if (!book || !chapter) return;

  // 收集答案
  let unanswered = false;
  _bkQuiz.forEach((q, i) => {
    if (q.type === 'choice') {
      if (q._userChoice === undefined) unanswered = true;
    } else {
      const ta = document.getElementById('bkQuizShort' + i);
      q._userAnswer = ta ? ta.value.trim() : '';
      if (!q._userAnswer) unanswered = true;
    }
  });
  if (unanswered) {
    const ok = await showCustomConfirm('还有题目未作答，确定提交吗？');
    if (!ok) return;
  }

  let score = 0;
  const wrong = [];
  const total = _bkQuiz.length;
  const needAiGrade = _bkQuiz.some(q => q.type === 'short');

  _bkAiBusy = true;
  const submitBtn = document.getElementById('bkQuizSubmitBtn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i data-lucide="loader" class="lucide-icon bk-spinner" style="width:14px;height:14px;border-width:2px;animation:bk-spin 0.8s linear infinite;"></i> 批改中…';
  }

  // 选择题本地判分
  _bkQuiz.forEach((q, i) => {
    const resultEl = document.getElementById('bkQuizResult' + i);
    const card = document.getElementById('bkQuizCard' + i);
    if (q.type === 'choice') {
      const userLetter = q._userChoice !== undefined ? _bkQuizOptParts(q.options[q._userChoice], q._userChoice).letter : '';
      const correct = userLetter.toUpperCase() === _bkNormAnswer(q.answer);
      if (correct) { score++; } else { wrong.push(q); }
      if (resultEl) {
        resultEl.className = 'bk-quiz-result show ' + (correct ? 'grade-ok' : 'grade-wrong');
        resultEl.innerHTML = correct
          ? '✅ 回答正确' + (q.explain ? ' — ' + escapeHtml(q.explain) : '')
          : '❌ 正确答案：' + escapeHtml(q.answer) + (q.explain ? '<br>' + escapeHtml(q.explain) : '');
        q._resultCls = resultEl.className;
        q._resultHtml = resultEl.innerHTML;
      }
      if (card) {
        card.classList.toggle('correct', correct);
        card.classList.toggle('wrong', !correct);
        card.querySelectorAll('.bk-quiz-opt').forEach((el, oi) => {
          const letter = _bkQuizOptParts(q.options[oi], oi).letter;
          if (letter === _bkNormAnswer(q.answer)) el.classList.add('correct-opt');
          else if (oi === q._userChoice) el.classList.add('wrong-opt');
          el.style.pointerEvents = 'none';
        });
      }
    }
  });

  // 简答题 AI 批改
  const shortQs = _bkQuiz.filter(q => q.type === 'short');
  if (shortQs.length > 0 && needAiGrade) {
    const cfg = _bkRequireKey();
    if (cfg) {
      try {
        const gradeText = shortQs.map(q => `Q${_bkQuiz.indexOf(q) + 1}: ${q.text}\n我的答案: ${q._userAnswer}\n参考答案: ${q.answer}`).join('\n\n');
        const res = await callAiApi([
          { role: 'system', content: '你是批改老师。逐题评判学生的简答答案，输出 JSON：{"grades":[{"index":题号(从0开始),"score":0或1,"comment":"简短点评"}]}' },
          { role: 'user', content: gradeText }
        ], cfg, null);
        const grades = bkParseGradeJson((res && (res.cleanText || res.rawReply)) || '', shortQs.length);
        shortQs.forEach((q, si) => {
          const g = grades.find(x => x.index === _bkQuiz.indexOf(q)) || null;
          const pass = g ? g.score >= 1 : false;
          if (pass) score++; else wrong.push(q);
          const resultEl = document.getElementById('bkQuizResult' + _bkQuiz.indexOf(q));
          if (resultEl) {
            resultEl.className = 'bk-quiz-result show ' + (pass ? 'grade-ok' : 'grade-wrong');
            resultEl.innerHTML = (pass ? '✅ 回答合理' : '⚠️ 需要补充') + (g && g.comment ? ' — ' + escapeHtml(g.comment) : '')
              + (q.answer ? '<br><small>参考答案：' + escapeHtml(q.answer) + '</small>' : '');
            q._resultCls = resultEl.className;
            q._resultHtml = resultEl.innerHTML;
          }
        });
      } catch (e) {
        // AI 批改失败，简答题不算分但展示参考答案
        shortQs.forEach(q => {
          const resultEl = document.getElementById('bkQuizResult' + _bkQuiz.indexOf(q));
          if (resultEl) {
            resultEl.className = 'bk-quiz-result show note';
            resultEl.innerHTML = '参考答案：' + escapeHtml(q.answer) + '<br><small>（AI 批改失败，请自行对照）</small>';
            q._resultCls = resultEl.className;
            q._resultHtml = resultEl.innerHTML;
          }
        });
      }
    }
  }

  // 记录测验结果
  book.quizRecords = book.quizRecords || [];
  book.quizRecords.push({
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    score: score,
    total: total,
    date: new Date().toISOString(),
    wrong: wrong.map(q => ({ text: q.text, answer: q.answer }))
  });
  book.updatedAt = new Date().toISOString();
  bkSaveBooks();
  bkRenderQuizHistory();
  _bkQuizSaveState(); // 持久化判分结果，切换页面返回仍可见
  _bkWrongCollect(book, chapter, wrong); // 自动收录本次错题到错题本

  // 全对鼓励
  if (total > 0 && score === total) {
    const praise = [
      '🎉 全部答对，太棒了！你对本章掌握得很扎实，继续保持！',
      '🏆 满分！这一章的知识你已经完全拿下了，真厉害！',
      '🌟 全对！看来你学习得非常认真，给自己点个赞！',
      '🚀 满分通关！本章内容已经难不倒你了，可以冲刺下一章啦！'
    ];
    showCustomConfirm('<div style="font-size:15px;font-weight:600;margin-bottom:4px;">' + praise[Math.floor(Math.random() * praise.length)] + '</div>');
  }

  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i data-lucide="check-check" class="lucide-icon" style="width:14px;height:14px;"></i> 提交批改';
  }
  _bkAiBusy = false;
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
}

function bkParseGradeJson(raw, count) {
  try {
    const text = String(raw || '');
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(fenced ? fenced[1] || fenced[0] : text);
    if (!obj.grades || !Array.isArray(obj.grades)) return [];
    return obj.grades.map(g => ({
      index: Number(g.index),
      score: Number(g.score) >= 1 ? 1 : 0,
      comment: String(g.comment || '')
    })).filter(g => !isNaN(g.index));
  } catch (e) { return []; }
}

// ═══════════ 摘要导图 tab ═══════════
// 章节摘要 HTML：summaryNodes 存在时渲染为可右键节点列表（右键显示原书原文），否则回退纯文本
function bkSummaryNodesHtml(kb) {
  const nodes = Array.isArray(kb.summaryNodes) && kb.summaryNodes.length ? kb.summaryNodes : [];
  if (!nodes.length) {
    return `<div class="bk-kb-summary-text">${_bkRenderMd(kb.summary || '（暂无摘要）')}</div>`;
  }
  const items = nodes.map(n => {
    const text = String(n.text || '').trim();
    if (!text) return '';
    const src = String(n.src || '').trim();
    return `<div class="bk-summary-node" data-name="${escapeHtml(text)}" data-src="${escapeHtml(src)}">${_bkRenderMd(text)}</div>`;
  }).join('');
  return `<div class="bk-summary-nodes">${items}</div>`;
}

function bkRenderSummaryTab(book, chapter) {
  const body = document.getElementById('bkMainBody');
  if (!body) return;
  body.classList.remove('bk-body-chat');
  const kb = (chapter && chapter.kb) || {};

  if (kb.status !== 'done') {
    const isFailed = kb.status === 'failed';
    body.innerHTML = `
      <div class="bk-empty-hint">
        <i data-lucide="network" class="lucide-icon" style="width:52px;height:52px;"></i>
        <p>${isFailed ? '本章知识库构建失败' : '本章知识库尚未构建'}<br><small>AI 将为章节生成摘要、术语表、重点与知识导图</small></p>
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
          <button class="bk-quiz-btn primary" onclick="bkBuildChapter(${chapter.id})" style="padding:8px 16px;">
            <i data-lucide="${isFailed ? 'refresh-cw' : 'wand-2'}" class="lucide-icon" style="width:14px;height:14px;"></i> ${isFailed ? '重试本章' : '仅构建本章'}
          </button>
          <button class="bk-quiz-btn" onclick="bkConfirmStartKbBuild()" style="padding:8px 16px;">
            <i data-lucide="layers" class="lucide-icon" style="width:14px;height:14px;"></i> 构建全部章节
          </button>
        </div>
      </div>`;
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
    return;
  }

  // 编程书开关 + 伪代码集（仅当 book 标记为编程书且本章收集到伪代码时展示）
  const progOn = !!(book.pseudocode && book.pseudocode.enabled === true);
  const pseudoItems = Array.isArray(kb.pseudocode) ? kb.pseudocode : [];
  const pseudoSource = (book.pseudocode && book.pseudocode.source === 'ai') ? 'AI 判定为编程书' : '手动标记为编程书';

  const pseudoToggleHtml = `
    <div class="bk-kb-pseudo-toggle">
      <button class="bk-msg-action" onclick="bkToggleProgrammingBook()" title="开启后，构建/重建知识库时将按章收集伪代码及其解释">
        <i data-lucide="code" class="lucide-icon" style="width:12px;height:12px;"></i> 本书为编程书：${progOn ? '开' : '关'}
      </button>
      ${progOn && !pseudoItems.length ? '<span class="bk-kb-pseudo-hint">本章未提取到伪代码（可能本章无伪代码，或需重新构建本章知识库收集）</span>' : ''}
    </div>`;

  const pseudoHtml = (progOn && pseudoItems.length)
    ? `<div class="bk-kb-card">
        <div class="bk-kb-card-title"><i data-lucide="code" class="lucide-icon" style="width:14px;height:14px;"></i> 伪代码集<span style="font-weight:400;font-size:11px;color:var(--text-secondary);">（${pseudoSource}）</span></div>
        ${pseudoItems.map((p, i) => `<div class="bk-pseudo-item">
          <div class="bk-pseudo-title">${i + 1}. ${escapeHtml(p.title || '伪代码')}</div>
          ${p.code ? `<pre class="bk-pseudo-code"><code>${escapeHtml(p.code)}</code></pre>` : ''}
          ${p.explanation ? `<div class="bk-pseudo-expl">${_bkRenderMd(p.explanation)}</div>` : ''}
        </div>`).join('')}
      </div>` : '';

  const termsHtml = (kb.terms && kb.terms.length)
    ? `<div class="bk-kb-card">
        <div class="bk-kb-card-title"><i data-lucide="bookmark" class="lucide-icon" style="width:14px;height:14px;"></i> 术语表<span style="font-weight:400;font-size:11px;color:var(--text-secondary);">（可悬停查看含义 · 右键移除标黄 · 点 × 删除术语）</span></div>
        <div class="bk-term-list">${kb.terms.map(t => `<span class="bk-term-chip"><b>${escapeHtml(t.term)}</b> ${escapeHtml(t.def || '')}<button class="bk-term-chip-del" title="从术语表移除" onclick="bkDeleteTermFromGlossary('${escapeJs(t.term)}')"><i data-lucide="x" class="lucide-icon" style="width:11px;height:11px;"></i></button></span>`).join('')}</div>
      </div>` : '';

  const hasSummaryNodes = Array.isArray(kb.summaryNodes) && kb.summaryNodes.length > 0;
  const keyPointsHtml = (kb.keyPoints && kb.keyPoints.length)
    ? `<div class="bk-kb-card">
        <div class="bk-kb-card-title"><i data-lucide="list-checks" class="lucide-icon" style="width:14px;height:14px;"></i> 重点提纲</div>
        <ul class="bk-keypoint-list">${kb.keyPoints.map(k => `<li>${escapeHtml(k)}</li>`).join('')}</ul>
      </div>` : '';

  const mindmapHtml = (kb.mindmap && kb.mindmap.name)
    ? `<div class="bk-kb-card">
        <div class="bk-kb-card-title"><i data-lucide="network" class="lucide-icon" style="width:14px;height:14px;"></i> 知识导图</div>
        <div class="bk-mindmap-wrap"><div class="bk-mindmap">${bkRenderMindmap(kb.mindmap, 1)}</div></div>
      </div>` : '';

  body.innerHTML = `
    ${pseudoToggleHtml}
    <div class="bk-summary-grid">
      <div class="bk-kb-card">
        <div class="bk-kb-card-title"><i data-lucide="file-text" class="lucide-icon" style="width:14px;height:14px;"></i> 章节摘要<span style="font-weight:400;font-size:11px;color:var(--text-secondary);">（${hasSummaryNodes ? '节点可右键显示原书原文' : '重新生成摘要后，节点可右键显示原书原文'}）</span></div>
        ${bkSummaryNodesHtml(kb)}
        <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;">
          <button class="bk-msg-action" onclick="bkSaveSummaryAsNote()"><i data-lucide="save" class="lucide-icon" style="width:12px;height:12px;"></i> 存为笔记</button>
          <button class="bk-msg-action" id="bkRegenSummaryBtn" onclick="bkRegenerateSummary()"><i data-lucide="refresh-cw" class="lucide-icon" style="width:12px;height:12px;"></i> 重新生成摘要</button>
          <button class="bk-msg-action" id="bkRebuildChapterBtn" onclick="bkRebuildChapter()"><i data-lucide="rotate-cw" class="lucide-icon" style="width:12px;height:12px;"></i> 重新构建本章</button>
        </div>
      </div>
      ${pseudoHtml}
      ${termsHtml}
      ${keyPointsHtml}
      ${mindmapHtml}
    </div>`;

  // 术语标黄：把整本书术语表中出现的词在摘要 / 重点提纲 / 知识导图 / 伪代码标题与解释中标黄（悬停气泡 + 右键添加）
  // 先加载该书籍已移除标记的术语（持久化，刷新后不恢复标黄）
  _bkLoadTermDismissed(book && book.id);
  const termMap = bkBuildBookTermMap(book);
  if (termMap.size > 0) {
    body.querySelectorAll('.bk-kb-summary-text, .bk-keypoint-list, .bk-mindmap, .bk-pseudo-title, .bk-pseudo-expl, .bk-summary-node')
      .forEach(el => bkHighlightTermsInElement(el, termMap));
  }
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
}

// 手动开关「本书为编程书」（覆盖 AI 自动判断），开启后需重建知识库按章收集伪代码
function bkToggleProgrammingBook() {
  const book = bkGetActiveBook();
  if (!book) return;
  const enabled = !(book.pseudocode && book.pseudocode.enabled === true);
  book.pseudocode = { enabled: enabled, source: 'manual', judgedAt: new Date().toISOString() };
  book.updatedAt = new Date().toISOString();
  bkSaveBooks();
  bkRenderSummaryTab(book, bkGetActiveChapter());
  if (enabled) {
    alert('已开启：重新构建本章或全书知识库后，将按章收集伪代码及其解释');
  }
}

// 「重新构建本章」按钮处理：完整重建当前章节知识库（摘要/术语/重点/导图，编程书含伪代码），覆盖现有内容
function bkRebuildChapter() {
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  if (!book || !chapter) return;
  if (_bkAiBusy || (typeof bkKbBuilding !== 'undefined' && bkKbBuilding)) return;
  const btn = document.getElementById('bkRebuildChapterBtn');
  if (btn) btn.disabled = true;
  const collectPseudo = (book.pseudocode && book.pseudocode.enabled === true);
  showCustomConfirm(`确定要重新构建「${escapeHtml(chapter.title)}」的知识库吗？<br><small>将重新生成<b>摘要、术语表、重点、知识导图</b>${collectPseudo ? '与<b>伪代码</b>' : ''}，覆盖现有内容。</small>`).then(ok => {
    if (btn) btn.disabled = false;
    if (!ok) return;
    bkBuildChapter(chapter.id);
  });
}

// 「重新生成摘要」按钮处理：仅重生成当前章节摘要（不动术语表/重点/导图）
async function bkRegenerateSummary() {
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  if (!book || !chapter) return;
  if (_bkAiBusy || (typeof bkKbBuilding !== 'undefined' && bkKbBuilding)) return;
  const cfg = _bkRequireKey();
  if (!cfg) return;

  const btn = document.getElementById('bkRegenSummaryBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader" class="lucide-icon bk-spinner" style="width:12px;height:12px;border-width:2px;animation:bk-spin 0.8s linear infinite;"></i> 生成中…';
  }
  _bkAiBusy = true;

  try {
    let chapterText = '';
    try { chapterText = await bkGetChapterTextWithPages(chapter); } catch (e) { chapterText = ''; }
    const result = await bkBuildChapterSummary(chapter, chapterText, cfg);
    if (!result || !result.summary) throw new Error('AI 未返回有效摘要');
    chapter.kb = chapter.kb || { status: 'pending', summary: '', terms: [], keyPoints: [], mindmap: null };
    chapter.kb.summary = result.summary;
    chapter.kb.summaryNodes = Array.isArray(result.summaryNodes) ? result.summaryNodes : [];
    chapter.kb.status = 'done';
    book.updatedAt = new Date().toISOString();
    bkSaveBooks();
    bkRenderSummaryTab(book, chapter);
    bkRenderToc();
  } catch (err) {
    console.error('重新生成摘要失败:', err);
    alert('摘要生成失败：' + String((err && err.message) || err));
  } finally {
    _bkAiBusy = false;
    const freshBtn = document.getElementById('bkRegenSummaryBtn');
    if (freshBtn) {
      freshBtn.disabled = false;
      freshBtn.innerHTML = '<i data-lucide="refresh-cw" class="lucide-icon" style="width:12px;height:12px;"></i> 重新生成摘要';
      if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
    }
  }
}

// 渲染知识导图树（递归）
function bkRenderMindmap(node, level) {
  if (!node) return '';
  const children = Array.isArray(node.children) && node.children.length
    ? node.children.map(c => bkRenderMindmap(c, level + 1)).join('')
    : '';
  return `<div class="bk-mm-node level-${Math.min(level, 4)}">${escapeHtml(node.name || '')}${children}</div>`;
}

// ═══════════ 存为笔记（联动笔记系统） ═══════════
// 自动创建（或复用）「教材学习」文件夹，把内容存为笔记
function _bkGetBooksNoteFolderId() {
  if (typeof notes === 'undefined') return null;
  let folder = notes.find(n => n.type === 'folder' && n.title === '教材学习');
  if (!folder) {
    if (typeof createNoteFolder === 'function') {
      folder = createNoteFolder('教材学习', null);
    }
  }
  return folder ? folder.id : null;
}

function _bkSaveNote(title, content, summary) {
  try {
    const folderId = _bkGetBooksNoteFolderId();
    // 直接构造笔记对象（避免 createNewNote 触发 renderNotes 的 DOM 依赖）
    const note = {
      id: genId(),
      type: 'note',
      title: title,
      content: content,
      summary: summary || '',
      _summaryFresh: true,
      parentId: folderId || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      _reviewHistory: [],
      _skipReview: true,
      tags: []
    };
    if (typeof notes !== 'undefined' && Array.isArray(notes)) {
      notes.push(note);
      saveData('study_notes_v2', notes);
      alert('已保存到「笔记 → 教材学习」文件夹');
      return true;
    }
    return false;
  } catch (e) {
    console.error('保存笔记失败:', e);
    return false;
  }
}

function bkSaveExplainAsNote() {
  if (!_bkLastExplain) { alert('暂无可保存的讲解内容'); return; }
  _bkSaveNote(_bkLastExplain.title, _bkLastExplain.content, '');
}
function bkSaveQaAsNote() {
  if (!_bkLastQa) { alert('暂无可保存的问答内容'); return; }
  _bkSaveNote(_bkLastQa.title, _bkLastQa.content, '');
}
function bkSaveSummaryAsNote() {
  const chapter = bkGetActiveChapter();
  const book = bkGetActiveBook();
  if (!chapter || !book) return;
  const kb = chapter.kb || {};
  if (!kb.summary) { alert('本章尚无摘要'); return; }
  let content = '# ' + book.title + ' · ' + chapter.title + '\n\n## 摘要\n\n' + kb.summary;
  if (kb.terms && kb.terms.length) {
    content += '\n\n## 术语表\n\n' + kb.terms.map(t => '- **' + t.term + '**：' + t.def).join('\n');
  }
  if (kb.keyPoints && kb.keyPoints.length) {
    content += '\n\n## 重点提纲\n\n' + kb.keyPoints.map(k => '- ' + k).join('\n');
  }
  _bkSaveNote(book.title + ' · ' + chapter.title + ' · 摘要', content, kb.summary.slice(0, 200));
}

// ═══════════ 术语表联动：摘要/重点中的术语标黄 + 悬停气泡 + 右键添加 ═══════════

// 汇总整本书术语表：term → def（跨所有章节）
function bkBuildBookTermMap(book) {
  const map = new Map();
  for (const ch of (book && book.chapters) || []) {
    const terms = (ch.kb && Array.isArray(ch.kb.terms)) ? ch.kb.terms : [];
    for (const t of terms) {
      const term = String((t && t.term) || '').trim();
      const def = String((t && t.def) || '').trim();
      if (term && !map.has(term)) map.set(term, def);
    }
  }
  return map;
}

// 在给定元素内对纯文本节点做术语标黄（避免破坏 HTML 标签）
// 用 TreeWalker 遍历文本节点，把命中的术语包裹为 <span class="bk-term-hl">
function bkHighlightTermsInElement(el, termMap) {
  if (!el || !termMap || termMap.size === 0) return;
  // 按长度降序，长术语优先匹配（避免短词先命中拆坏长词）
  // 过滤掉用户已移除标记的术语（_bkTermDismissed）
  const terms = [...termMap.keys()]
    .filter(t => t && t.length >= 1)
    .filter(t => !_bkTermDismissed.has(t))
    .sort((a, b) => b.length - a.length);
  if (terms.length === 0) return;

  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (node.parentElement && node.parentElement.closest('.bk-term-hl')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  for (const node of textNodes) {
    const original = node.nodeValue;
    // 检查是否包含任一术语（快速预筛）
    const lower = original.toLowerCase();
    if (!terms.some(t => lower.includes(t.toLowerCase()))) continue;
    // 构建替换后的 HTML（保留非术语原文）
    let html = '';
    let rest = original;
    // 用正则逐术语替换，记录所有命中区间
    const hits = [];
    for (const t of terms) {
      const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      let m;
      while ((m = re.exec(rest)) !== null) {
        hits.push({ start: m.index, end: m.index + m[0].length, term: m[0] });
      }
    }
    if (hits.length === 0) continue;
    // 按 start 排序，合并重叠（保留更长命中）
    hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const merged = [];
    for (const h of hits) {
      const prev = merged[merged.length - 1];
      if (prev && h.start < prev.end) {
        // 重叠：保留更长的
        if ((h.end - h.start) > (prev.end - prev.start)) {
          merged[merged.length - 1] = h;
        }
        continue;
      }
      merged.push(h);
    }
    // 重建
    let cursor = 0;
    let out = '';
    for (const h of merged) {
      if (h.start > cursor) out += escapeHtml(rest.slice(cursor, h.start));
      const def = termMap.get(h.term) || '';
      out += `<span class="bk-term-hl" data-term="${escapeHtml(h.term)}" data-def="${escapeHtml(def)}">${escapeHtml(h.term)}</span>`;
      cursor = h.end;
    }
    if (cursor < rest.length) out += escapeHtml(rest.slice(cursor));
    const span = document.createElement('span');
    span.innerHTML = out;
    node.parentNode.replaceChild(span, node);
  }
}

// 悬停气泡
let _bkTermTipHideTimer = null;
function bkShowTermTooltip(e, term, def) {
  const tip = document.getElementById('bkTermTooltip');
  if (!tip) return;
  if (_bkTermTipHideTimer) { clearTimeout(_bkTermTipHideTimer); _bkTermTipHideTimer = null; }
  tip.innerHTML = `<b>${escapeHtml(term)}</b><div class="bk-term-tip-def">${escapeHtml(def || '（暂无释义）')}</div>`;
  // 用布局尺寸（offsetWidth/Height 不受 opacity/transform 影响）
  const tipW = tip.offsetWidth || 200;
  const tipH = tip.offsetHeight || 60;
  const pad = 12;
  let left = e.clientX + pad;
  // 放不下时翻转到鼠标左侧（用实际宽度，保证右侧紧贴鼠标左侧 pad 处）
  if (left + tipW > window.innerWidth - 8) left = e.clientX - tipW - pad;
  left = Math.max(8, left);
  let top = e.clientY + pad;
  if (top + tipH + 8 > window.innerHeight) top = e.clientY - tipH - pad;
  top = Math.max(8, top);
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
  tip.classList.add('visible');
}
function bkHideTermTooltip() {
  const tip = document.getElementById('bkTermTooltip');
  if (!tip) return;
  _bkTermTipHideTimer = setTimeout(() => tip.classList.remove('visible'), 80);
}
// 全局悬停监听（仅在教材摘要/重点区域内生效）
function bkInitTermHover() {
  document.addEventListener('mouseover', (e) => {
    const hl = e.target && e.target.closest ? e.target.closest('.bk-term-hl') : null;
    if (hl) bkShowTermTooltip(e, hl.dataset.term || '', hl.dataset.def || '');
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target && e.target.closest && e.target.closest('.bk-term-hl')) bkHideTermTooltip();
  });
}
// 确保只初始化一次
if (typeof window._bkTermHoverInited === 'undefined') {
  window._bkTermHoverInited = true;
  bkInitTermHover();
}

// 右键菜单：两种模式
//  (a) 右键标黄的术语 → 显示「移除术语标记」（移除高亮，术语保留）
//  (b) 右键选中文字（非标黄术语）→ 显示「添加到术语表」
let _bkCtxTermSelection = ''; // 模式(b)：选中文字
let _bkCtxTerm = '';          // 模式(a)：被右键的标黄术语
let _bkCtxNodeName = '';      // 模式(c)：被右键的摘要节点名
let _bkCtxNodeSrc = '';       // 模式(c)：该节点的原文 src 索引

// 记录被用户移除标记的术语（持久化，按书籍区分，刷新后不恢复标黄）
let _bkTermDismissed = new Set();

// 加载当前书籍的已移除标记术语
function _bkLoadTermDismissed(bookId) {
  _bkTermDismissed = new Set();
  if (!bookId) return;
  try {
    const store = JSON.parse(localStorage.getItem('study_bk_terms_dismissed_v1') || '{}');
    const arr = store[bookId];
    if (Array.isArray(arr)) _bkTermDismissed = new Set(arr);
  } catch (e) {}
}
// 保存当前书籍的已移除标记术语
function _bkSaveTermDismissed(bookId) {
  if (!bookId) return;
  try {
    const store = JSON.parse(localStorage.getItem('study_bk_terms_dismissed_v1') || '{}');
    store[bookId] = [..._bkTermDismissed];
    localStorage.setItem('study_bk_terms_dismissed_v1', JSON.stringify(store));
  } catch (e) {}
}

function bkShowTermContextMenu(e) {
  const body = document.getElementById('bkMainBody');
  if (!body || !body.contains(e.target)) return;
  // 仅在摘要导图各栏目内触发（摘要/摘要节点/重点提纲/知识导图/伪代码标题与解释/术语表）
  if (!e.target.closest('.bk-kb-summary-text, .bk-keypoint-list, .bk-mindmap, .bk-pseudo-title, .bk-pseudo-expl, .bk-term-list, .bk-summary-node')) return;
  const menu = document.getElementById('bkTermContextMenu');
  if (!menu) return;
  // 边界修正 helper：菜单位于鼠标处但不出视口
  const clampMenu = () => {
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    if (rect.right > vw) menu.style.left = Math.max(0, vw - rect.width - 6) + 'px';
    if (rect.bottom > vh) menu.style.top = Math.max(0, vh - rect.height - 6) + 'px';
  };

  // 模式(a)：右键标黄的术语 span
  const hl = e.target.closest ? e.target.closest('.bk-term-hl') : null;
  if (hl) {
    const term = hl.dataset.term || '';
    if (!term) return;
    e.preventDefault();
    _bkCtxTerm = term;
    _bkCtxTermSelection = '';
    document.getElementById('bkTermCtxAdd').style.display = 'none';
    document.getElementById('bkTermCtxRemove').style.display = '';
    document.getElementById('bkTermCtxExplain').style.display = 'none';
    document.getElementById('bkTermCtxExample').style.display = 'none';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.classList.add('visible');
    clampMenu();
    return;
  }

  // 模式(b)：选中文字 → 添加到术语表 / 解释一下 / 举个例子
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) {
    const text = sel.toString().trim();
    if (text && body.contains(sel.anchorNode) && body.contains(sel.focusNode)) {
      e.preventDefault();
      _bkCtxTerm = '';
      _bkCtxTermSelection = text;
      const isTerm = text.length <= 50; // 过长的文字不适合作术语，但仍可解释/举例
      document.getElementById('bkTermCtxAdd').style.display = isTerm ? '' : 'none';
      document.getElementById('bkTermCtxRemove').style.display = 'none';
      document.getElementById('bkTermCtxExplain').style.display = '';
      document.getElementById('bkTermCtxExample').style.display = '';
      menu.style.left = e.clientX + 'px';
      menu.style.top = e.clientY + 'px';
      menu.classList.add('visible');
      clampMenu();
      return;
    }
  }

  // 模式(c)：右键摘要节点（无选中文字）→ 显示原书原文
  const sn = e.target.closest ? e.target.closest('.bk-summary-node') : null;
  if (sn) {
    e.preventDefault();
    _bkCtxNodeName = sn.dataset.name || '';
    _bkCtxNodeSrc = sn.dataset.src || '';
    document.getElementById('bkTermCtxAdd').style.display = 'none';
    document.getElementById('bkTermCtxRemove').style.display = 'none';
    document.getElementById('bkTermCtxExplain').style.display = 'none';
    document.getElementById('bkTermCtxExample').style.display = 'none';
    document.getElementById('bkTermCtxOriginal').style.display = '';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.classList.add('visible');
    clampMenu();
  }
}

// 右键「解释一下 / 举个例子」：把选中文字交给章节讲解 AI 详细解释或举例
function bkExplainSelection(mode) {
  const text = _bkCtxTermSelection || '';
  bkCloseTermContextMenu();
  if (!text) return;
  const q = mode === 'example'
    ? '请围绕下面这段话举几个具体例子，帮助我更好地理解：' + text
    : '请详细解释一下下面这段话，拆解其中的概念、补充直觉与例子：' + text;
  if (typeof bkSwitchTab === 'function') bkSwitchTab('explain');
  bkExplainQuick(q);
}
function bkCloseTermContextMenu() {
  const menu = document.getElementById('bkTermContextMenu');
  if (menu) menu.classList.remove('visible');
  _bkCtxTermSelection = '';
  _bkCtxTerm = '';
  _bkCtxNodeName = '';
  _bkCtxNodeSrc = '';
}
// 全局右键监听：仅在摘要导图各栏目内接管
function bkInitTermContextMenu() {
  document.addEventListener('contextmenu', function(e) {
    const body = document.getElementById('bkMainBody');
    if (body && body.contains(e.target) && e.target.closest && e.target.closest('.bk-kb-summary-text, .bk-keypoint-list, .bk-mindmap, .bk-pseudo-title, .bk-pseudo-expl, .bk-term-list, .bk-summary-node')) {
      bkShowTermContextMenu(e);
    } else {
      bkCloseTermContextMenu();
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#bkTermContextMenu')) bkCloseTermContextMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      bkCloseTermContextMenu();
      if (typeof bkCloseOriginalOverlay === 'function') bkCloseOriginalOverlay();
      if (typeof bkClosePdfReader === 'function') bkClosePdfReader();
    }
  });
}
if (typeof window._bkTermCtxInited === 'undefined') {
  window._bkTermCtxInited = true;
  bkInitTermContextMenu();
}

// ═══════════ 摘要节点 → 显示原书原文 ═══════════
// 用 AI 生成的 src 索引在章节原文中模糊定位，命中展示上下文并高亮原句，未命中回退整章原文

// 文本归一化：去空白、常见标点、转小写，用于模糊匹配
function _bkNormText(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/[，。；：、（）()「」《》“”"'，．！？、；：`·—…\[\]{}<>/\\|=+_\-*&^%$#@!~,.:;?!]/g, '')
    .toLowerCase();
}

// 取命中位置前后各约 400 字符作为上下文
function _bkCtxAround(full, pos, len) {
  const start = Math.max(0, pos - 400);
  const end = Math.min(full.length, pos + (len || 12) + 400);
  return full.slice(start, end).trim();
}

// 用 src 在章节原文 fullText 中定位：返回 { context, match } 或 null
// 三级匹配：①原文原样包含 ②归一化整体包含（按长度比例还原位置）③逐段最长公共前缀
function bkLocateOriginalText(fullText, src) {
  const s = String(src || '').trim();
  const ns = _bkNormText(s);
  const full = String(fullText || '');
  if (!s || ns.length < 6 || !full) return null;

  // ① 原文原样包含
  const idx = full.indexOf(s);
  if (idx >= 0) return { context: _bkCtxAround(full, idx, s.length), match: s };

  // ② 归一化整体包含（段落级）
  const nfull = _bkNormText(full);
  const nidx = nfull.indexOf(ns);
  if (nidx >= 0) {
    const ratio = full.length / Math.max(nfull.length, 1);
    const pos = Math.min(Math.floor(nidx * ratio), Math.max(0, full.length - 1));
    return { context: _bkCtxAround(full, pos, Math.max(s.length, 12)), match: s };
  }

  // ③ 逐段最长公共前缀
  const paras = full.split(/\n{2,}|\n/).filter(p => p.trim());
  let best = null, bestLen = 0;
  for (const p of paras) {
    const np = _bkNormText(p);
    if (!np) continue;
    let lcp = 0;
    const maxL = Math.min(np.length, ns.length);
    while (lcp < maxL && np[lcp] === ns[lcp]) lcp++;
    if (lcp > bestLen) { bestLen = lcp; best = p; }
  }
  if (best && bestLen >= Math.max(8, ns.length * 0.5)) {
    return { context: best.trim(), match: best.trim() };
  }
  return null;
}

// 从完整节点行「- **节点名**：说明」中提取短节点名用于浮层标题
function _bkTrimNodeName(s) {
  let t = String(s || '').trim().replace(/^-\s*/, '').replace(/^\*{2}/, '');
  const m = t.match(/^([^*]+?)\*\*/);
  if (m && m[1]) t = m[1].trim();
  const idx = t.indexOf('：');
  if (idx > 0 && idx <= 24) t = t.slice(0, idx);
  const max = 24;
  return t.length > max ? t.slice(0, max) + '…' : t;
}

// 显示原书原文：src 为 PDF 页码（纯数字，新数据）→ 打开内嵌 PDF 阅读器并跳页；
// src 为原文摘录（旧数据）或空 → 文本定位浮层
async function bkShowOriginalText() {
  const nodeName = _bkCtxNodeName || '';
  const nodeSrc = _bkCtxNodeSrc || '';
  bkCloseTermContextMenu();
  const chapter = bkGetActiveChapter();
  if (!chapter) return;
  if (/^\d+$/.test(nodeSrc)) {
    bkOpenPdfAtPage(parseInt(nodeSrc, 10), nodeName);
    return;
  }
  const title = chapter.title || '';

  let overlay = document.getElementById('bkOriginalOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'bkOriginalOverlay';
    overlay.className = 'bk-original-overlay';
    overlay.addEventListener('click', function(ev) {
      if (ev.target === overlay) bkCloseOriginalOverlay();
    });
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="bk-original-panel">
      <div class="bk-original-head">
        <span class="bk-original-title"><i data-lucide="book-open" class="lucide-icon" style="width:15px;height:15px;vertical-align:-2px;"></i> 原书原文 — ${escapeHtml(title)}${nodeName ? ' · ' + escapeHtml(_bkTrimNodeName(nodeName)) : ''}</span>
        <button class="bk-original-close" onclick="bkCloseOriginalOverlay()" title="关闭 (Esc)"><i data-lucide="x" class="lucide-icon" style="width:16px;height:16px;"></i></button>
      </div>
      <div class="bk-original-body bk-original-loading"><i data-lucide="loader" class="lucide-icon bk-spinner" style="width:14px;height:14px;animation:bk-spin 0.8s linear infinite;"></i> 正在加载原书原文…</div>
    </div>`;
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);

  let chapterText = '';
  try { chapterText = await bkGetChapterText(chapter); } catch (e) { chapterText = ''; }
  const body = overlay.querySelector('.bk-original-body');
  if (!body) return;

  if (!String(chapterText || '').trim()) {
    body.className = 'bk-original-body bk-original-empty';
    body.innerHTML = '本章尚未生成正文缓存，无法显示原书原文。<br><small>请先在「教材学习」中为本书构建正文文本缓存后再试。</small>';
    return;
  }

  const hit = nodeSrc ? bkLocateOriginalText(chapterText, nodeSrc) : null;
  if (hit) {
    body.className = 'bk-original-body';
    const escCtx = escapeHtml(hit.context);
    const escMatch = escapeHtml(hit.match);
    const mi = escCtx.indexOf(escMatch);
    const html = mi >= 0
      ? escCtx.slice(0, mi) + '<mark class="bk-original-hl">' + escMatch + '</mark>' + escCtx.slice(mi + escMatch.length)
      : escCtx;
    body.innerHTML = html;
  } else {
    body.className = 'bk-original-body';
    body.innerHTML = '<div class="bk-original-hint">该节点暂无精确原文索引，已显示整章原文。<br><small>重新构建本章知识库或「重新生成摘要」后，右键节点即可精确定位。</small></div>'
      + '<hr style="border:none;border-top:1px solid var(--border);margin:10px 0;">'
      + escapeHtml(chapterText);
  }
}

// 关闭原书原文浮层并清空节点状态
function bkCloseOriginalOverlay() {
  const overlay = document.getElementById('bkOriginalOverlay');
  if (overlay) overlay.remove();
  _bkCtxNodeName = '';
  _bkCtxNodeSrc = '';
}

// ═══════════ 内嵌 PDF 阅读器（点击「显示原书原文」时打开并跳到指定 PDF 页码） ═══════════
let _bkPdfDoc = null;    // pdf.js 文档对象
let _bkPdfTotal = 1;     // 总页数
let _bkPdfPageNum = 1;   // 当前页

// 打开 PDF 阅读器并定位到指定页（pageNum 为 1 起始的 PDF 物理页码）
async function bkOpenPdfAtPage(pageNum, nodeName, bookOverride) {
  // bookOverride 用于读取已传输到本机的 PDF（WebRTC），不依赖活动书籍
  const book = bookOverride || bkGetActiveBook();
  if (!book) {
    alert('无法定位 PDF：本书不存在');
    return;
  }
  const isPwaRead = (typeof Env !== 'undefined' && Env.isPwa && !!bookOverride);
  if (!bookOverride && !book.filePath) {
    alert('无法定位 PDF：本书缺少文件路径，请重新导入');
    return;
  }
  const chapter = bkGetActiveChapter();
  const chapterTitle = (chapter && chapter.title) || '';
  _bkPdfPageNum = Math.max(1, Math.round(Number(pageNum) || 1));

  let overlay = document.getElementById('bkPdfReaderOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'bkPdfReaderOverlay';
    overlay.className = 'bk-original-overlay';
    overlay.addEventListener('click', function(ev) {
      if (ev.target === overlay) bkClosePdfReader();
    });
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="bk-pdf-panel">
      <div class="bk-pdf-head">
        <span class="bk-pdf-title"><i data-lucide="file-text" class="lucide-icon" style="width:15px;height:15px;vertical-align:-2px;"></i> PDF 原文 — ${escapeHtml(book.title || '')}${chapterTitle ? ' · ' + escapeHtml(chapterTitle) : ''}${nodeName ? ' · ' + escapeHtml(_bkTrimNodeName(nodeName)) : ''}</span>
        <div class="bk-pdf-controls">
          <button class="bk-pdf-btn" onclick="bkPdfPrev()" title="上一页"><i data-lucide="chevron-left" class="lucide-icon" style="width:15px;height:15px;"></i></button>
          <input class="bk-pdf-page-input" id="bkPdfPageInput" type="number" min="1" value="${_bkPdfPageNum}" onchange="bkPdfJump()" onkeydown="if(event.key==='Enter'){this.blur();bkPdfJump();}" title="输入页码后回车跳转">
          <span class="bk-pdf-total" id="bkPdfTotal">/ 加载中…</span>
          <button class="bk-pdf-btn" onclick="bkPdfNext()" title="下一页"><i data-lucide="chevron-right" class="lucide-icon" style="width:15px;height:15px;"></i></button>
        </div>
        <button class="bk-original-close" onclick="bkClosePdfReader()" title="关闭 (Esc)"><i data-lucide="x" class="lucide-icon" style="width:16px;height:16px;"></i></button>
      </div>
      <div class="bk-pdf-body">
        <div class="bk-pdf-page-wrap" id="bkPdfPageWrap"><div class="bk-pdf-loading"><i data-lucide="loader" class="lucide-icon bk-spinner" style="width:14px;height:14px;animation:bk-spin 0.8s linear infinite;"></i> 正在加载 PDF…</div></div>
      </div>
    </div>`;
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);

  try {
    // 浏览器 / PWA 环境（无 Electron）：优先从 IndexedDB（手动导入的 PDF）读取
    const noElectron = !window.electronAPI || typeof window.electronAPI.readPdfFile !== 'function';
    if (noElectron && window.BookPdfStore && typeof window.BookPdfStore.read === 'function') {
      const stored = await window.BookPdfStore.read(book.id);
      if (stored) {
        await _bkLoadPdfBuffer(stored);
        return;
      }
      throw new Error('未找到此教材的 PDF（请先在「教材 → 导入 PDF」选择该文件）');
    }
    if (noElectron) {
      throw new Error('当前环境不支持读取本地 PDF 文件');
    }
    const buffer = await window.electronAPI.readPdfFile(book.filePath);
    if (!buffer) throw new Error('无法读取 PDF 文件（文件可能已被移动或删除）');
    await _bkLoadPdfBuffer(buffer);
  } catch (err) {
    const wrap = document.getElementById('bkPdfPageWrap');
    if (wrap) wrap.innerHTML = '<div class="bk-pdf-loading" style="color:var(--danger);">' + escapeHtml('打开 PDF 失败：' + String((err && err.message) || err)) + '</div>';
  }
}

// 将 PDF 数据载入 _bkPdfDoc 并渲染当前页（Electron Buffer / Uint8Array 通用）
async function _bkLoadPdfBuffer(buffer) {
  const pdfjsLib = window.pdfjsLib || (await ensurePdfJs());
  if (!pdfjsLib) throw new Error('PDF 引擎未加载，请重启应用');
  let data = buffer;
  if (buffer instanceof Uint8Array) data = buffer;
  else if (buffer && buffer.data && typeof buffer.type === 'string') data = new Uint8Array(buffer.data);
  _bkPdfDoc = await pdfjsLib.getDocument({ data: data }).promise;
  _bkPdfTotal = _bkPdfDoc.numPages;
  _bkPdfPageNum = Math.min(Math.max(1, _bkPdfPageNum), _bkPdfTotal);
  const totalEl = document.getElementById('bkPdfTotal');
  if (totalEl) totalEl.textContent = '/ ' + _bkPdfTotal + ' 页';
  const inputEl = document.getElementById('bkPdfPageInput');
  if (inputEl) inputEl.value = _bkPdfPageNum;
  await _bkPdfRenderPage();
}

// 渲染当前页到 canvas（适配容器宽度）
async function _bkPdfRenderPage() {
  if (!_bkPdfDoc) return;
  const wrap = document.getElementById('bkPdfPageWrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="bk-pdf-loading">正在渲染第 ' + _bkPdfPageNum + ' 页…</div>';
  try {
    const page = await _bkPdfDoc.getPage(_bkPdfPageNum);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const containerWidth = wrap.clientWidth || 720;
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(containerWidth / base.width, 2.5);
    const viewport = page.getViewport({ scale });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = canvas.width + 'px';
    canvas.style.height = canvas.height + 'px';
    canvas.className = 'bk-pdf-canvas';
    wrap.innerHTML = '';
    wrap.appendChild(canvas);
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
  } catch (err) {
    wrap.innerHTML = '<div class="bk-pdf-loading" style="color:var(--danger);">' + escapeHtml('渲染失败：' + String((err && err.message) || err)) + '</div>';
  }
  const inputEl = document.getElementById('bkPdfPageInput');
  if (inputEl) inputEl.value = _bkPdfPageNum;
  const totalEl = document.getElementById('bkPdfTotal');
  if (totalEl) totalEl.textContent = '/ ' + _bkPdfTotal + ' 页';
}

function bkPdfPrev() {
  if (_bkPdfPageNum > 1) { _bkPdfPageNum--; _bkPdfRenderPage(); }
}
function bkPdfNext() {
  if (_bkPdfPageNum < _bkPdfTotal) { _bkPdfPageNum++; _bkPdfRenderPage(); }
}
function bkPdfJump() {
  const inputEl = document.getElementById('bkPdfPageInput');
  if (!inputEl) return;
  const n = parseInt(inputEl.value, 10);
  if (!n || n < 1 || n > _bkPdfTotal) { inputEl.value = _bkPdfPageNum; return; }
  _bkPdfPageNum = n;
  _bkPdfRenderPage();
}
function bkClosePdfReader() {
  const overlay = document.getElementById('bkPdfReaderOverlay');
  if (overlay) overlay.remove();
  if (_bkPdfDoc && typeof _bkPdfDoc.destroy === 'function') { try { _bkPdfDoc.destroy(); } catch (e) {} }
  _bkPdfDoc = null;
  _bkCtxNodeName = '';
  _bkCtxNodeSrc = '';
}

// 移除术语标记：仅取消高亮（术语仍留在术语表），记录并持久化后重渲染
function bkRemoveTermMark() {
  const term = _bkCtxTerm || '';
  bkCloseTermContextMenu();
  if (!term) return;
  const book = bkGetActiveBook();
  _bkTermDismissed.add(term);
  _bkSaveTermDismissed(book && book.id);
  bkRenderMain(); // 重渲染摘要，使该术语不再标黄
}

// AI 搜索全书上下文：返回该词出现的若干片段
async function bkSearchTermContext(term, maxSnippets = 4) {
  const snippets = [];
  try {
    const pages = await bkGetAllPages();
    const lower = term.toLowerCase();
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    for (let i = 0; i < pages.length && snippets.length < maxSnippets; i++) {
      const p = pages[i] || '';
      const idx = p.search(re);
      if (idx >= 0) {
        const start = Math.max(0, idx - 60);
        const end = Math.min(p.length, idx + term.length + 120);
        snippets.push(`【第${i + 1}页】…${p.slice(start, end)}…`);
      }
    }
  } catch (err) { console.error('术语上下文搜索失败:', err); }
  return snippets;
}

// AI 生成术语定义
async function bkAiExplainTerm(term) {
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  if (!book || !chapter) return null;
  const cfg = _bkRequireKey();
  if (!cfg) return null;
  let chapterText = '';
  try { chapterText = await bkGetChapterText(chapter); } catch (e) {}
  const chapterSnippet = bkSnippet(chapterText, 4000);
  const contexts = await bkSearchTermContext(term);

  const systemPrompt = '你是教材术语编辑助手。根据给出的章节内容与全书上下文，为术语写一条精炼准确的中文释义（50-120 字）。'
    + '\n规则：只输出 JSON，不要解释与代码块包裹。'
    + '\n输出格式：{"term":"原术语","def":"释义"}';
  const userContent = `术语：${term}\n\n【本章内容片段】\n${chapterSnippet}\n\n【全书出现位置】\n${contexts.length ? contexts.join('\n') : '（全书未找到该词，请仅依据本章内容推断）'}`;

  try {
    const res = await callAiApi([{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }], cfg, null);
    const raw = (res && (res.cleanText || res.rawReply)) || '';
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/\{[\s\S]*\}/);
    const jsonStr = m ? (m[1] || m[0]) : raw;
    const parsed = JSON.parse(jsonStr);
    const def = String((parsed && parsed.def) || '').trim();
    return def ? { term, def } : null;
  } catch (err) {
    console.error('AI 术语释义失败:', err);
    return null;
  }
}

// 添加术语到本章术语表（同时会进入整本书术语表），成功后重渲染
async function bkAddSelectedTermToGlossary() {
  const term = _bkCtxTermSelection || '';
  bkCloseTermContextMenu();
  if (!term) return;
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  if (!book || !chapter) return;
  // 去重：若已在全书术语表中，直接使用既有释义
  const existing = bkBuildBookTermMap(book).get(term);
  if (existing) {
    bkAddTermToChapter(chapter, term, existing);
    return;
  }
  // 否则调用 AI 生成
  const btn = document.querySelector('#bkTermContextMenu .context-menu-item');
  if (btn) btn.innerHTML = '<i data-lucide="loader" class="lucide-icon bk-spinner" style="width:13px;height:13px;border-width:2px;"></i> 生成中…';
  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
  const result = await bkAiExplainTerm(term);
  if (btn) {
    btn.innerHTML = '<i data-lucide="bookmark-plus" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle;"></i> 添加到术语表';
    if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
  }
  if (result && result.def) {
    bkAddTermToChapter(chapter, result.term, result.def);
  } else {
    alert('AI 未能生成该术语释义，请重试。');
  }
}

// 写入术语到章节 kb.terms（去重）+ 重渲染摘要
function bkAddTermToChapter(chapter, term, def) {
  if (!chapter || !term) return;
  chapter.kb = chapter.kb || { status: 'pending', summary: '', terms: [], keyPoints: [], mindmap: null };
  chapter.kb.terms = Array.isArray(chapter.kb.terms) ? chapter.kb.terms : [];
  const existing = chapter.kb.terms.find(t => String(t.term).trim() === term);
  if (existing) existing.def = def;
  else chapter.kb.terms.push({ term: term, def: def });
  // 该术语重新可高亮（若之前被移除标记，恢复）
  if (_bkTermDismissed.has(term)) {
    _bkTermDismissed.delete(term);
    _bkSaveTermDismissed((bkGetActiveBook() || {}).id);
  }
  bkSaveBooks();
  bkRenderMain();
  bkRenderToc();
}

// 从本章术语表删除术语（同时从标黄中消失）
function bkDeleteTermFromGlossary(term) {
  const book = bkGetActiveBook();
  const chapter = bkGetActiveChapter();
  if (!book || !chapter || !term) return;
  showCustomConfirm(`确定从本章术语表移除「${term}」？<br><small>移除后该词将不再标黄。若全书其他章节也有该术语，其他章节不受影响。</small>`).then(ok => {
    if (!ok) return;
    chapter.kb = chapter.kb || { status: 'pending', summary: '', terms: [], keyPoints: [], mindmap: null };
    chapter.kb.terms = (chapter.kb.terms || []).filter(t => String(t.term).trim() !== term);
    // 清理已移除标记记录（该术语已从术语表删除，无需再记录）
    if (_bkTermDismissed.has(term)) {
      _bkTermDismissed.delete(term);
      _bkSaveTermDismissed(book.id);
    }
    bkSaveBooks();
    bkRenderMain();
    bkRenderToc();
  });
}
