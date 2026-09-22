// ═══════════════════════════════════════════════════════════════════
//  全局划词翻译：选中英文后右键，优先显示英英释义，可切换中文释义
//  依赖：settings.js（getEffectiveApiConfig）、ai-api.js（callAiApi）
// ═══════════════════════════════════════════════════════════════════
(function initGlobalTranslation(global) {
  'use strict';

  const MAX_SELECTION_LENGTH = 4000;
  const HISTORY_KEY = 'study_translation_history_v1';
  const MAX_HISTORY_ITEMS = 500;
  const cache = new Map();
  let selectedText = '';
  let anchorPoint = { x: 0, y: 0 };
  let requestId = 0;
  let activeEntryId = '';
  let pageMode = 'history';
  let pageQuery = '';
  let reviewSession = null;

  const REVIEW_INTERVALS = [1, 3, 7, 14, 30, 60, 120];

  function escapeTranslationHtml(value) {
    if (typeof global.escapeHtml === 'function') return global.escapeHtml(String(value || ''));
    return String(value || '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function normalizeSelection(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SELECTION_LENGTH);
  }

  function isEnglishSelection(value) {
    const text = normalizeSelection(value);
    if (!text || !/[A-Za-z]/.test(text) || /[\u3400-\u9fff]/.test(text)) return false;
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    const meaningful = (text.match(/[A-Za-z0-9]/g) || []).length;
    return meaningful > 0 && letters / meaningful >= 0.6;
  }

  function createEntryId() {
    return 'tr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function loadHistory() {
    let value = [];
    try {
      value = typeof global.StudyPlatform !== 'undefined'
        ? global.StudyPlatform.storage.getJson(HISTORY_KEY, [])
        : JSON.parse(global.localStorage.getItem(HISTORY_KEY) || '[]');
    } catch (_) { value = []; }
    return Array.isArray(value) ? value.filter(item => item && item.id && item.sourceText && item.result) : [];
  }

  function findHistoryEntry(text) {
    const normalizedKey = normalizeSelection(text).toLocaleLowerCase('en-US');
    return loadHistory().find(item => (item.normalizedKey || normalizeSelection(item.sourceText).toLocaleLowerCase('en-US')) === normalizedKey) || null;
  }

  function getHistoricalResult(text) {
    const entry = findHistoryEntry(text);
    if (!entry) return null;
    try { return normalizeResult(entry.result); }
    catch (_) { return null; }
  }

  function saveHistory(entries) {
    const safeEntries = Array.isArray(entries) ? entries : [];
    if (typeof global.saveData === 'function') return global.saveData(HISTORY_KEY, safeEntries);
    try {
      const result = typeof global.StudyPlatform !== 'undefined'
        ? global.StudyPlatform.storage.setJson(HISTORY_KEY, safeEntries)
        : (() => { global.localStorage.setItem(HISTORY_KEY, JSON.stringify(safeEntries)); return { ok: true }; })();
      return result.ok !== false;
    } catch (_) { return false; }
  }

  function trimHistory(entries) {
    const saved = entries.filter(item => item.inVocabulary);
    const recent = entries.filter(item => !item.inVocabulary).slice(0, MAX_HISTORY_ITEMS);
    return [...saved, ...recent].sort((a, b) => String(b.lastViewedAt || '').localeCompare(String(a.lastViewedAt || '')));
  }

  function recordTranslation(text, result) {
    const now = new Date().toISOString();
    const normalizedKey = normalizeSelection(text).toLocaleLowerCase('en-US');
    const entries = loadHistory();
    const index = entries.findIndex(item => item.normalizedKey === normalizedKey);
    let entry;
    if (index >= 0) {
      entry = {
        ...entries[index],
        sourceText: text,
        result,
        lastViewedAt: now,
        viewCount: Math.max(0, Number(entries[index].viewCount) || 0) + 1
      };
      entries.splice(index, 1);
    } else {
      entry = {
        id: createEntryId(),
        normalizedKey,
        sourceText: text,
        result,
        createdAt: now,
        lastViewedAt: now,
        viewCount: 1,
        inVocabulary: false,
        vocabularyAddedAt: ''
      };
    }
    const next = trimHistory([entry, ...entries]);
    if (!saveHistory(next)) throw new Error('翻译成功，但保存历史记录失败');
    return entry;
  }

  function setVocabulary(entryId, value) {
    const entries = loadHistory();
    const index = entries.findIndex(item => item.id === String(entryId));
    if (index < 0) return false;
    const inVocabulary = value == null ? !entries[index].inVocabulary : !!value;
    entries[index] = {
      ...entries[index],
      inVocabulary,
      vocabularyAddedAt: inVocabulary ? (entries[index].vocabularyAddedAt || new Date().toISOString()) : '',
      reviewDueAt: inVocabulary ? (entries[index].reviewDueAt || new Date().toISOString()) : entries[index].reviewDueAt
    };
    if (!saveHistory(trimHistory(entries))) return false;
    if (activeEntryId === String(entryId)) updatePanelVocabularyButton(entries[index]);
    const page = document.getElementById('translationApp');
    if (page && page.closest('.section.active')) renderTranslationPage();
    if (typeof global.showAiToast === 'function') global.showAiToast(inVocabulary ? '已加入生词本' : '已移出生词本');
    return true;
  }

  function selectionFromControl(target) {
    const control = target && target.closest ? target.closest('textarea,input') : null;
    // 密码框永不进入翻译链路，避免把凭据发送给模型服务商。
    if (!control || !/^(?:text|search|url|email|tel)?$/i.test(control.type || 'text')) return '';
    if (!Number.isInteger(control.selectionStart) || !Number.isInteger(control.selectionEnd)) return '';
    return normalizeSelection(control.value.slice(control.selectionStart, control.selectionEnd));
  }

  function getSelectedText(target) {
    const controlText = selectionFromControl(target);
    if (controlText) return controlText;
    const selection = global.getSelection ? global.getSelection() : null;
    return normalizeSelection(selection ? selection.toString() : '');
  }

  function ensureUi() {
    if (document.getElementById('globalTranslateMenu')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="context-menu global-translate-menu" id="globalTranslateMenu" role="menu" aria-label="划词翻译">
        <button class="context-menu-item global-translate-action" id="globalTranslateAction" type="button" role="menuitem">
          <i data-lucide="languages" class="lucide-icon" aria-hidden="true"></i>
          <span>翻译所选英文</span>
        </button>
      </div>
      <section class="global-translate-panel" id="globalTranslatePanel" role="dialog" aria-label="翻译结果" aria-modal="false" hidden>
        <header class="global-translate-header">
          <div class="global-translate-heading">
            <i data-lucide="languages" class="lucide-icon" aria-hidden="true"></i>
            <span>划词翻译</span>
          </div>
          <button class="global-translate-close" id="globalTranslateClose" type="button" aria-label="关闭翻译结果" title="关闭 (Esc)">
            <i data-lucide="x" class="lucide-icon" aria-hidden="true"></i>
          </button>
        </header>
        <div class="global-translate-source" id="globalTranslateSource"></div>
        <div class="global-translate-tabs" role="tablist" aria-label="释义语言">
          <button class="global-translate-tab active" id="globalTranslateEnglishTab" type="button" role="tab" aria-selected="true" aria-controls="globalTranslateEnglish">英英释义</button>
          <button class="global-translate-tab" id="globalTranslateChineseTab" type="button" role="tab" aria-selected="false" aria-controls="globalTranslateChinese">中文释义</button>
        </div>
        <div class="global-translate-content" id="globalTranslateContent" aria-live="polite"></div>
        <footer class="global-translate-footer" id="globalTranslateFooter" hidden>
          <button class="global-translate-vocab" id="globalTranslateVocabulary" type="button" aria-pressed="false">
            <i data-lucide="star" class="lucide-icon" aria-hidden="true"></i>
            <span>加入生词本</span>
          </button>
          <button class="global-translate-history-link" id="globalTranslateHistoryLink" type="button">查看翻译列表</button>
        </footer>
      </section>`);

    document.getElementById('globalTranslateAction').addEventListener('click', translateCurrentSelection);
    document.getElementById('globalTranslateClose').addEventListener('click', closePanel);
    document.getElementById('globalTranslateEnglishTab').addEventListener('click', () => switchLanguage('english'));
    document.getElementById('globalTranslateChineseTab').addEventListener('click', () => switchLanguage('chinese'));
    document.getElementById('globalTranslateVocabulary').addEventListener('click', () => setVocabulary(activeEntryId));
    document.getElementById('globalTranslateHistoryLink').addEventListener('click', () => {
      closePanel();
      if (typeof global.switchTab === 'function') global.switchTab('translation');
    });
    document.querySelector('.global-translate-tabs').addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const language = event.target.id === 'globalTranslateEnglishTab' ? 'chinese' : 'english';
      switchLanguage(language, true);
    });
    if (typeof global.lucide !== 'undefined') global.lucide.createIcons();
  }

  function placeFloatingElement(element, x, y, gap) {
    element.style.left = Math.max(8, x) + 'px';
    element.style.top = Math.max(8, y + (gap || 0)) + 'px';
    const rect = element.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, global.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y + (gap || 0), global.innerHeight - rect.height - 8));
    element.style.left = left + 'px';
    element.style.top = top + 'px';
  }

  function closeMenu() {
    document.getElementById('globalTranslateMenu')?.classList.remove('visible');
  }

  function closePanel() {
    const panel = document.getElementById('globalTranslatePanel');
    if (panel) panel.hidden = true;
    requestId += 1;
  }

  function closeOtherContextMenus() {
    document.querySelectorAll('.context-menu.visible').forEach(menu => {
      if (menu.id !== 'globalTranslateMenu') menu.classList.remove('visible');
    });
  }

  function openMenu(event, text) {
    ensureUi();
    selectedText = text;
    anchorPoint = { x: event.clientX, y: event.clientY };
    closeOtherContextMenus();
    const menu = document.getElementById('globalTranslateMenu');
    menu.classList.add('visible');
    placeFloatingElement(menu, anchorPoint.x, anchorPoint.y, 0);
    if (typeof global.lucide !== 'undefined') global.lucide.createIcons();
  }

  function switchLanguage(language, focus) {
    const panel = document.getElementById('globalTranslatePanel');
    if (!panel) return;
    const englishTab = document.getElementById('globalTranslateEnglishTab');
    const chineseTab = document.getElementById('globalTranslateChineseTab');
    const englishPanel = document.getElementById('globalTranslateEnglish');
    const chinesePanel = document.getElementById('globalTranslateChinese');
    const showEnglish = language !== 'chinese';
    englishTab.classList.toggle('active', showEnglish);
    chineseTab.classList.toggle('active', !showEnglish);
    englishTab.setAttribute('aria-selected', String(showEnglish));
    chineseTab.setAttribute('aria-selected', String(!showEnglish));
    if (englishPanel) englishPanel.hidden = !showEnglish;
    if (chinesePanel) chinesePanel.hidden = showEnglish;
    if (focus) (showEnglish ? englishTab : chineseTab).focus();
  }

  function showPanelLoading(text) {
    ensureUi();
    closeMenu();
    const panel = document.getElementById('globalTranslatePanel');
    panel.hidden = false;
    document.getElementById('globalTranslateSource').textContent = text;
    document.getElementById('globalTranslateContent').innerHTML = `
      <div class="global-translate-loading">
        <span class="global-translate-spinner" aria-hidden="true"></span>
        <span>正在理解这段英文…</span>
      </div>`;
    document.getElementById('globalTranslateEnglishTab').disabled = true;
    document.getElementById('globalTranslateChineseTab').disabled = true;
    document.getElementById('globalTranslateFooter').hidden = true;
    activeEntryId = '';
    switchLanguage('english');
    placeFloatingElement(panel, anchorPoint.x, anchorPoint.y, 10);
  }

  function cleanJsonReply(value) {
    const raw = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('翻译结果格式异常');
    return JSON.parse(raw.slice(start, end + 1));
  }

  function normalizeResult(value) {
    const data = typeof value === 'string' ? cleanJsonReply(value) : (value || {});
    const stringValue = key => String(data[key] || '').trim();
    const result = {
      title: stringValue('title'),
      phonetic: stringValue('phonetic'),
      partOfSpeech: stringValue('partOfSpeech'),
      englishDefinition: stringValue('englishDefinition'),
      englishUsage: stringValue('englishUsage'),
      englishExample: stringValue('englishExample'),
      chineseMeaning: stringValue('chineseMeaning'),
      chineseNote: stringValue('chineseNote')
    };
    if (!result.englishDefinition || !result.chineseMeaning) throw new Error('翻译结果不完整');
    return result;
  }

  function updatePanelVocabularyButton(entry) {
    const button = document.getElementById('globalTranslateVocabulary');
    if (!button || !entry) return;
    const saved = !!entry.inVocabulary;
    button.classList.toggle('saved', saved);
    button.setAttribute('aria-pressed', String(saved));
    button.querySelector('span').textContent = saved ? '已加入生词本' : '加入生词本';
    if (typeof global.lucide !== 'undefined') global.lucide.createIcons();
  }

  function renderResult(result, entry) {
    const content = document.getElementById('globalTranslateContent');
    const meta = [result.phonetic, result.partOfSpeech].filter(Boolean);
    const englishExtra = [
      result.englishUsage ? `<div class="global-translate-note"><b>Usage</b>${escapeTranslationHtml(result.englishUsage)}</div>` : '',
      result.englishExample ? `<div class="global-translate-example"><span>Example</span>${escapeTranslationHtml(result.englishExample)}</div>` : ''
    ].join('');
    content.innerHTML = `
      <div class="global-translate-pane" id="globalTranslateEnglish" role="tabpanel" aria-labelledby="globalTranslateEnglishTab">
        ${result.title ? `<div class="global-translate-word">${escapeTranslationHtml(result.title)}</div>` : ''}
        ${meta.length ? `<div class="global-translate-meta">${meta.map(escapeTranslationHtml).join('<span>·</span>')}</div>` : ''}
        <div class="global-translate-definition" lang="en">${escapeTranslationHtml(result.englishDefinition)}</div>
        ${englishExtra}
      </div>
      <div class="global-translate-pane" id="globalTranslateChinese" role="tabpanel" aria-labelledby="globalTranslateChineseTab" hidden>
        <div class="global-translate-definition global-translate-chinese" lang="zh-CN">${escapeTranslationHtml(result.chineseMeaning)}</div>
        ${result.chineseNote ? `<div class="global-translate-note"><b>用法说明</b>${escapeTranslationHtml(result.chineseNote)}</div>` : ''}
      </div>`;
    document.getElementById('globalTranslateEnglishTab').disabled = false;
    document.getElementById('globalTranslateChineseTab').disabled = false;
    activeEntryId = entry ? String(entry.id) : '';
    document.getElementById('globalTranslateFooter').hidden = !entry;
    if (entry) updatePanelVocabularyButton(entry);
    switchLanguage('english');
    placeFloatingElement(document.getElementById('globalTranslatePanel'), anchorPoint.x, anchorPoint.y, 10);
  }

  function renderError(message) {
    document.getElementById('globalTranslateContent').innerHTML = `
      <div class="global-translate-error">
        <i data-lucide="circle-alert" class="lucide-icon" aria-hidden="true"></i>
        <span>${escapeTranslationHtml(message)}</span>
      </div>`;
    document.getElementById('globalTranslateEnglishTab').disabled = true;
    document.getElementById('globalTranslateChineseTab').disabled = true;
    document.getElementById('globalTranslateFooter').hidden = true;
    if (typeof global.lucide !== 'undefined') global.lucide.createIcons();
    placeFloatingElement(document.getElementById('globalTranslatePanel'), anchorPoint.x, anchorPoint.y, 10);
  }

  function formatHistoryTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      }).format(date);
    } catch (_) { return date.toLocaleString(); }
  }

  function renderHistoryCard(entry) {
    const result = entry.result || {};
    const title = result.title || entry.sourceText;
    const showSource = result.title && normalizeSelection(result.title).toLowerCase() !== normalizeSelection(entry.sourceText).toLowerCase();
    const meta = [result.phonetic, result.partOfSpeech].filter(Boolean);
    return `
      <article class="translation-history-card" data-translation-id="${escapeTranslationHtml(entry.id)}">
        <div class="translation-history-main">
          <div class="translation-history-title-row">
            <div class="translation-history-word" lang="en">${escapeTranslationHtml(title)}</div>
            ${meta.length ? `<div class="translation-history-meta">${meta.map(escapeTranslationHtml).join('<span>·</span>')}</div>` : ''}
          </div>
          ${showSource ? `<div class="translation-history-source" lang="en">${escapeTranslationHtml(entry.sourceText)}</div>` : ''}
          <div class="translation-history-meanings">
            <div><span>EN</span><p lang="en">${escapeTranslationHtml(result.englishDefinition || '')}</p></div>
            <div><span>中</span><p lang="zh-CN">${escapeTranslationHtml(result.chineseMeaning || '')}</p></div>
          </div>
          ${result.englishExample ? `<div class="translation-history-example" lang="en"><i data-lucide="quote" class="lucide-icon" aria-hidden="true"></i>${escapeTranslationHtml(result.englishExample)}</div>` : ''}
        </div>
        <aside class="translation-history-side">
          <button class="translation-history-vocab ${entry.inVocabulary ? 'saved' : ''}" type="button" aria-pressed="${String(!!entry.inVocabulary)}" title="${entry.inVocabulary ? '移出生词本' : '加入生词本'}">
            <i data-lucide="star" class="lucide-icon" aria-hidden="true"></i>
            <span>${entry.inVocabulary ? '已收藏' : '加入生词本'}</span>
          </button>
          <div class="translation-history-time">${escapeTranslationHtml(formatHistoryTime(entry.lastViewedAt || entry.createdAt))}</div>
          ${Number(entry.viewCount) > 1 ? `<div class="translation-history-views">查过 ${Number(entry.viewCount)} 次</div>` : ''}
        </aside>
      </article>`;
  }

  function filteredHistory() {
    const query = pageQuery.trim().toLocaleLowerCase('zh-CN');
    return loadHistory()
      .filter(entry => pageMode !== 'vocabulary' || entry.inVocabulary)
      .filter(entry => {
        if (!query) return true;
        const result = entry.result || {};
        return [entry.sourceText, result.title, result.englishDefinition, result.chineseMeaning, result.englishExample]
          .some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(query));
      })
      .sort((a, b) => {
        const aTime = pageMode === 'vocabulary' ? a.vocabularyAddedAt : a.lastViewedAt;
        const bTime = pageMode === 'vocabulary' ? b.vocabularyAddedAt : b.lastViewedAt;
        return String(bTime || '').localeCompare(String(aTime || ''));
      });
  }

  function getReviewQueue(includeFuture) {
    const now = Date.now();
    return loadHistory()
      .filter(entry => entry.inVocabulary)
      .filter(entry => includeFuture || !entry.reviewDueAt || new Date(entry.reviewDueAt).getTime() <= now)
      .sort((a, b) => String(a.reviewDueAt || '').localeCompare(String(b.reviewDueAt || '')));
  }

  function gradeReview(entryId, rating, reviewedAt) {
    const entries = loadHistory();
    const index = entries.findIndex(item => item.id === String(entryId) && item.inVocabulary);
    if (index < 0) return null;
    const now = reviewedAt ? new Date(reviewedAt) : new Date();
    if (Number.isNaN(now.getTime())) return null;
    const previousStage = Math.max(0, Number(entries[index].reviewStage) || 0);
    let nextStage = previousStage;
    let delayMs;
    if (rating === 'again') {
      nextStage = 0;
      delayMs = 10 * 60 * 1000;
    } else if (rating === 'hard') {
      nextStage = Math.max(0, previousStage - 1);
      delayMs = 24 * 60 * 60 * 1000;
    } else {
      nextStage = Math.min(previousStage + 1, REVIEW_INTERVALS.length - 1);
      delayMs = REVIEW_INTERVALS[previousStage] * 24 * 60 * 60 * 1000;
      rating = 'good';
    }
    entries[index] = {
      ...entries[index],
      reviewStage: nextStage,
      reviewDueAt: new Date(now.getTime() + delayMs).toISOString(),
      lastReviewedAt: now.toISOString(),
      reviewCount: Math.max(0, Number(entries[index].reviewCount) || 0) + 1,
      reviewLapses: Math.max(0, Number(entries[index].reviewLapses) || 0) + (rating === 'again' ? 1 : 0),
      lastReviewRating: rating
    };
    if (!saveHistory(trimHistory(entries))) return null;
    return entries[index];
  }

  function startReviewSession(includeFuture) {
    reviewSession = {
      ids: getReviewQueue(!!includeFuture).map(entry => entry.id),
      index: 0,
      revealed: false,
      completed: 0
    };
    renderReviewSession();
  }

  function renderReviewSession() {
    const list = document.getElementById('translationHistoryList');
    if (!list) return;
    if (!reviewSession) {
      reviewSession = { ids: getReviewQueue(false).map(entry => entry.id), index: 0, revealed: false, completed: 0 };
    }
    const history = loadHistory();
    const entry = history.find(item => item.id === reviewSession.ids[reviewSession.index] && item.inVocabulary);
    if (!entry) {
      const vocabularyCount = history.filter(item => item.inVocabulary).length;
      const finished = reviewSession.completed > 0;
      list.innerHTML = `
        <div class="translation-review-empty">
          <i data-lucide="${finished ? 'party-popper' : 'circle-check-big'}" class="lucide-icon" aria-hidden="true"></i>
          <strong>${finished ? '本轮复习完成' : '今天没有待复习闪卡'}</strong>
          <p>${finished ? `你刚刚复习了 ${reviewSession.completed} 张闪卡。` : (vocabularyCount ? '所有生词都在按计划巩固中。' : '先把翻译结果加入生词本，就能开始闪卡复习。')}</p>
          ${vocabularyCount ? '<button type="button" class="translation-review-all">复习全部生词</button>' : ''}
        </div>`;
      list.querySelector('.translation-review-all')?.addEventListener('click', () => startReviewSession(true));
      if (typeof global.lucide !== 'undefined') global.lucide.createIcons();
      return;
    }
    const result = entry.result || {};
    const title = result.title || entry.sourceText;
    const position = reviewSession.index + 1;
    const total = reviewSession.ids.length;
    list.innerHTML = `
      <div class="translation-review-shell">
        <div class="translation-review-progress"><span>第 ${position} / ${total} 张</span><div><i style="width:${Math.round(((position - 1) / total) * 100)}%"></i></div><span>已完成 ${reviewSession.completed}</span></div>
        <button type="button" class="translation-flashcard ${reviewSession.revealed ? 'revealed' : ''}" aria-label="${reviewSession.revealed ? '闪卡答案已显示' : '点击显示闪卡答案'}">
          <span class="translation-flashcard-hint">${reviewSession.revealed ? '答案' : '想一想它的含义'}</span>
          <strong lang="en">${escapeTranslationHtml(title)}</strong>
          ${result.phonetic ? `<span class="translation-flashcard-phonetic">${escapeTranslationHtml(result.phonetic)}</span>` : ''}
          <div class="translation-flashcard-answer" ${reviewSession.revealed ? '' : 'hidden'}>
            <p lang="zh-CN">${escapeTranslationHtml(result.chineseMeaning || '')}</p>
            <p lang="en">${escapeTranslationHtml(result.englishDefinition || '')}</p>
            ${result.englishExample ? `<blockquote lang="en">${escapeTranslationHtml(result.englishExample)}</blockquote>` : ''}
          </div>
          ${reviewSession.revealed ? '' : '<span class="translation-flashcard-reveal"><i data-lucide="rotate-3d"></i> 点击翻面</span>'}
        </button>
        <div class="translation-review-ratings" ${reviewSession.revealed ? '' : 'hidden'} aria-label="复习结果">
          <button type="button" data-rating="again"><i data-lucide="rotate-ccw"></i><span>忘记<small>10 分钟后</small></span></button>
          <button type="button" data-rating="hard"><i data-lucide="brain"></i><span>模糊<small>明天</small></span></button>
          <button type="button" data-rating="good"><i data-lucide="check"></i><span>记得<small>${REVIEW_INTERVALS[Math.max(0, Number(entry.reviewStage) || 0)]} 天后</small></span></button>
        </div>
      </div>`;
    list.querySelector('.translation-flashcard').addEventListener('click', () => {
      if (reviewSession.revealed) return;
      reviewSession.revealed = true;
      renderReviewSession();
    });
    list.querySelector('.translation-review-ratings')?.addEventListener('click', event => {
      const button = event.target.closest('[data-rating]');
      if (!button) return;
      gradeReview(entry.id, button.dataset.rating);
      reviewSession.index += 1;
      reviewSession.completed += 1;
      reviewSession.revealed = false;
      renderReviewSession();
    });
    if (typeof global.lucide !== 'undefined') global.lucide.createIcons();
  }

  function renderTranslationList() {
    const list = document.getElementById('translationHistoryList');
    if (!list) return;
    if (pageMode === 'review') {
      renderReviewSession();
      return;
    }
    const entries = filteredHistory();
    if (!entries.length) {
      const searching = !!pageQuery.trim();
      list.innerHTML = `
        <div class="translation-page-empty">
          <i data-lucide="${searching ? 'search-x' : (pageMode === 'vocabulary' ? 'book-marked' : 'languages')}" class="lucide-icon" aria-hidden="true"></i>
          <strong>${searching ? '没有找到匹配内容' : (pageMode === 'vocabulary' ? '生词本还是空的' : '还没有翻译记录')}</strong>
          <p>${searching ? '换一个英文单词或中文释义试试。' : (pageMode === 'vocabulary' ? '在翻译结果或历史记录中点击“加入生词本”。' : '在任意页面选中英文并右键翻译，结果会自动保存在这里。')}</p>
        </div>`;
    } else {
      list.innerHTML = entries.map(renderHistoryCard).join('');
    }
    if (typeof global.lucide !== 'undefined') global.lucide.createIcons();
  }

  function setPageMode(mode) {
    pageMode = ['vocabulary', 'review'].includes(mode) ? mode : 'history';
    if (pageMode === 'review') reviewSession = null;
    document.querySelectorAll('#translationApp .translation-page-tab').forEach(button => {
      const active = button.dataset.mode === pageMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    renderTranslationList();
  }

  function renderTranslationPage() {
    const app = document.getElementById('translationApp');
    if (!app) return;
    const history = loadHistory();
    const vocabularyCount = history.filter(entry => entry.inVocabulary).length;
    const dueCount = getReviewQueue(false).length;
    app.innerHTML = `
      <header class="translation-page-header">
        <div>
          <div class="translation-page-title"><i data-lucide="languages" class="lucide-icon" aria-hidden="true"></i>划词翻译</div>
          <div class="translation-page-summary">${history.length} 条翻译记录 · ${vocabularyCount} 个生词 · ${dueCount} 张待复习</div>
        </div>
        <div class="translation-page-tip"><i data-lucide="mouse-pointer-2" class="lucide-icon" aria-hidden="true"></i>选中英文后右键即可翻译</div>
      </header>
      <div class="translation-page-toolbar">
        <div class="translation-page-tabs" role="tablist" aria-label="词汇记录类型">
          <button class="translation-page-tab ${pageMode === 'history' ? 'active' : ''}" type="button" role="tab" data-mode="history" aria-selected="${String(pageMode === 'history')}">翻译列表<span>${history.length}</span></button>
          <button class="translation-page-tab ${pageMode === 'vocabulary' ? 'active' : ''}" type="button" role="tab" data-mode="vocabulary" aria-selected="${String(pageMode === 'vocabulary')}">生词本<span>${vocabularyCount}</span></button>
          <button class="translation-page-tab ${pageMode === 'review' ? 'active' : ''}" type="button" role="tab" data-mode="review" aria-selected="${String(pageMode === 'review')}">闪卡复习<span>${dueCount}</span></button>
        </div>
        <label class="translation-page-search" ${pageMode === 'review' ? 'hidden' : ''}>
          <i data-lucide="search" class="lucide-icon" aria-hidden="true"></i>
          <input type="search" id="translationPageSearch" value="${escapeTranslationHtml(pageQuery)}" placeholder="搜索单词或释义…" aria-label="搜索翻译列表">
          <button type="button" class="translation-page-search-clear" aria-label="清除搜索" ${pageQuery ? '' : 'hidden'}><i data-lucide="x" class="lucide-icon" aria-hidden="true"></i></button>
        </label>
      </div>
      <div class="translation-history-list" id="translationHistoryList"></div>`;

    app.querySelector('.translation-page-tabs').addEventListener('click', event => {
      const button = event.target.closest('.translation-page-tab');
      if (button) setPageMode(button.dataset.mode);
    });
    app.querySelector('#translationPageSearch').addEventListener('input', event => {
      pageQuery = event.target.value;
      renderTranslationList();
      const clear = app.querySelector('.translation-page-search-clear');
      if (clear) clear.hidden = !pageQuery;
    });
    app.querySelector('.translation-page-search-clear').addEventListener('click', () => {
      pageQuery = '';
      renderTranslationPage();
      app.querySelector('#translationPageSearch')?.focus();
    });
    app.querySelector('#translationHistoryList').addEventListener('click', event => {
      const button = event.target.closest('.translation-history-vocab');
      const card = event.target.closest('.translation-history-card');
      if (button && card) setVocabulary(card.dataset.translationId);
    });
    renderTranslationList();
    if (typeof global.lucide !== 'undefined') global.lucide.createIcons();
  }

  async function requestTranslation(text) {
    const cfg = typeof global.getEffectiveApiConfig === 'function' ? global.getEffectiveApiConfig() : null;
    if (!cfg || !cfg.apiKey) throw new Error('请先在「设置 → AI」中配置 API Key');
    if (typeof global.callAiApi !== 'function') throw new Error('翻译服务尚未就绪，请稍后重试');
    const messages = [
      {
        role: 'system',
        content: 'You are a concise learner dictionary and translator. Return only valid JSON with exactly these string fields: title, phonetic, partOfSpeech, englishDefinition, englishUsage, englishExample, chineseMeaning, chineseNote. For a word or phrase, title is its canonical form; provide IPA and part of speech when applicable. For a sentence or passage, title, phonetic and partOfSpeech may be empty. englishDefinition must explain or paraphrase the meaning in natural, easy English. chineseMeaning must be an accurate natural Chinese translation. Keep usage notes brief, preserve technical meaning, and do not use Markdown.'
      },
      { role: 'user', content: text }
    ];
    const response = await global.callAiApi(messages, { ...cfg, temperature: 0.2, deepThink: false }, null, { feature: 'translation' });
    return normalizeResult(response && response.cleanText);
  }

  async function getTranslation(text) {
    const normalizedText = normalizeSelection(text);
    const cacheKey = normalizedText.toLocaleLowerCase('en-US');
    let result = cache.get(cacheKey) || getHistoricalResult(normalizedText);
    if (result) {
      cache.set(cacheKey, result);
      return result;
    }
    result = await requestTranslation(normalizedText);
    cache.set(cacheKey, result);
    if (cache.size > 40) cache.delete(cache.keys().next().value);
    return result;
  }

  async function translateCurrentSelection() {
    const text = selectedText;
    if (!text) return;
    showPanelLoading(text);
    const currentRequest = ++requestId;
    try {
      const result = await getTranslation(text);
      if (currentRequest !== requestId) return;
      const entry = recordTranslation(text, result);
      renderResult(result, entry);
    } catch (error) {
      if (currentRequest !== requestId) return;
      renderError(String((error && error.message) || error || '翻译失败，请重试'));
    }
  }

  function onContextMenu(event) {
    if (event.target.closest && event.target.closest('#globalTranslateMenu, #globalTranslatePanel')) return;
    const text = getSelectedText(event.target);
    if (!isEnglishSelection(text)) {
      closeMenu();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    openMenu(event, text);
  }

  function bindEvents() {
    ensureUi();
    document.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('pointerdown', event => {
      if (event.button === 2) return;
      if (!event.target.closest('#globalTranslateMenu')) closeMenu();
      if (!event.target.closest('#globalTranslatePanel, #globalTranslateMenu')) closePanel();
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      closeMenu();
      closePanel();
    });
  }

  global.GlobalTranslation = Object.freeze({
    isEnglishSelection,
    normalizeResult,
    getHistory: loadHistory,
    getCachedResult: getHistoricalResult,
    recordResult: recordTranslation,
    toggleVocabulary: setVocabulary,
    getReviewQueue,
    gradeReview,
    renderPage: renderTranslationPage,
    translate: getTranslation,
    close: closePanel
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindEvents, { once: true });
  else bindEvents();
})(window);
