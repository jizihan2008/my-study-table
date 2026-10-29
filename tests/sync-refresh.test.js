'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = name => fs.readFileSync(require.resolve('../js/' + name), 'utf8');

function booksHarness() {
  const values = new Map([['study_books_v1', JSON.stringify([{ id: 1, title: 'cloud' }])]]);
  const input = { id: 'bkExplainInput', value: '还没发送的问题', selectionStart: 2, selectionEnd: 4,
    matches: () => true,
    focus() {}, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; } };
  const nodes = new Map([['bkExplainInput', input]]);
  const root = { contains: () => true, querySelectorAll: () => [] };
  nodes.set('booksApp', root);
  let renders = 0;
  const scheduled = [];
  const ctx = vm.createContext({
    localStorage: { getItem: k => values.get(k) ?? null },
    loadData: k => JSON.parse(values.get(k) || '[]'), booksData: [{ id: 1, title: 'old' }],
    bkActiveBookId: 1, bkActiveChapterId: 2, _bkAiBusy: false,
    document: { activeElement: input, getElementById: id => nodes.get(id) || null },
    setTimeout: fn => { scheduled.push(fn); return scheduled.length; },
    renderBooks() { renders++; input.value = ''; }
  });
  const code = source('books.js');
  vm.runInContext(code.slice(code.indexOf('let bkSyncedViewSignature'), code.indexOf('function renderBooks()')), ctx);
  return { ctx, values, input, scheduled, renders: () => renders };
}

test('books reload cloud data before rendering and preserve question draft and selection', () => {
  const h = booksHarness();
  h.ctx.refreshSyncedBooks();
  assert.equal(h.ctx.booksData[0].title, 'cloud');
  assert.equal(h.input.value, '还没发送的问题');
  assert.deepEqual([h.input.selectionStart, h.input.selectionEnd], [2, 4]);
  assert.equal(h.renders(), 1);
  h.ctx.refreshSyncedBooks();
  assert.equal(h.renders(), 1);
  h.values.set('study_bk_qa_logs_v1', '{"1":[]}');
  h.ctx.refreshSyncedBooks();
  assert.equal(h.renders(), 2);
});

test('busy books coalesce refreshes and consume the newest data after generation', () => {
  const h = booksHarness();
  const originalBook = h.ctx.booksData[0];
  h.ctx._bkAiBusy = true;
  h.ctx.refreshSyncedBooks(); h.ctx.refreshSyncedBooks();
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.renders(), 0);
  assert.equal(h.ctx.booksData[0], originalBook);
  assert.equal(originalBook.title, 'cloud');
  h.values.set('study_books_v1', '[{"id":1,"title":"latest"}]');
  h.ctx._bkAiBusy = false;
  h.scheduled.shift()();
  assert.equal(h.renders(), 1);
  assert.equal(h.ctx.booksData[0].title, 'latest');
});

test('quiz editing delays redraw until blur but reloads the book model immediately', () => {
  const h = booksHarness();
  let blur;
  h.ctx.document.activeElement = { id: 'bkQuizShort0', matches: () => true,
    addEventListener: (event, fn) => { assert.equal(event, 'blur'); blur = fn; } };
  h.ctx.refreshSyncedBooks();
  assert.equal(h.ctx.booksData[0].title, 'cloud');
  assert.equal(h.renders(), 0);
  h.ctx.document.activeElement = null;
  blur(); h.scheduled.shift()();
  assert.equal(h.renders(), 1);
});

function promptHarness() {
  const values = new Map([['study_prompt_templates_v1', '{"chat":"cloud"}']]);
  const area = { value: 'old', selectionStart: 1, selectionEnd: 2, scrollTop: 20,
    focus() {}, setSelectionRange() {} };
  let notice = null, renders = 0;
  const handlers = {};
  const root = { prepend: node => { notice = node; } };
  const ctx = vm.createContext({
    localStorage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) },
    document: { activeElement: area,
      getElementById: id => ({ promptStudio: root, promptTemplateText: area, promptSyncNotice: notice })[id] || null,
      createElement: () => ({ style: {}, setAttribute() {}, querySelector: selector => ({ addEventListener: (_, fn) => { handlers[selector] = fn; } }) })
    }
  });
  vm.runInContext(source('prompts.js'), ctx);
  vm.runInContext(`promptRenderedId = 'chat'; promptRenderedDef = {id:'chat', name:'普通聊天'}; promptRenderedValue = 'old';`, ctx);
  ctx.renderPromptStudio = () => {
    renders++;
    area.value = vm.runInContext("promptSyncedDrafts.get('chat')?.value ?? getPromptTemplate('chat')", ctx);
    notice = null;
  };
  return { ctx, values, area, handlers, notice: () => notice, renders: () => renders };
}

test('clean prompt editor loads cloud text, while a dirty editor keeps a reviewable draft', () => {
  const clean = promptHarness();
  clean.ctx.refreshSyncedPromptStudio();
  assert.equal(clean.area.value, 'cloud');
  assert.equal(clean.renders(), 1);
  const dirty = promptHarness();
  dirty.area.value = 'my draft';
  dirty.ctx.refreshSyncedPromptStudio();
  assert.equal(dirty.renders(), 0);
  assert.equal(dirty.area.value, 'my draft');
  assert.ok(dirty.notice());
  assert.equal(JSON.parse(dirty.values.get('study_prompt_templates_v1')).chat, 'cloud');
  dirty.handlers['[data-keep]']();
  assert.equal(JSON.parse(dirty.values.get('study_prompt_templates_v1')).chat, 'my draft');
  assert.equal(dirty.renders(), 1);
});

test('cloud prompt choice discards only the preserved draft; composition is not replaced', () => {
  const h = promptHarness();
  h.area.value = 'my draft';
  h.ctx.refreshSyncedPromptStudio();
  h.handlers['[data-cloud]']();
  assert.equal(h.area.value, 'cloud');
  const composing = promptHarness();
  vm.runInContext('promptComposing = true', composing.ctx);
  composing.ctx.refreshSyncedPromptStudio();
  assert.equal(composing.renders(), 0);
  assert.equal(composing.area.value, 'old');
  assert.ok(composing.notice());
});

function translationHarness() {
  const values = new Map();
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      id, value: '', innerHTML: '', textContent: '', scrollTop: 30, selectionStart: 1, selectionEnd: 2,
      listeners: {}, classList: { toggle() {}, add() {}, remove() {} },
      addEventListener(event, fn) { this.listeners[event] = fn; },
      querySelector: selector => node(selector.startsWith('#') ? selector.slice(1) : selector),
      querySelectorAll: () => [], focus() {}, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
    });
    return nodes.get(id);
  }
  let today = 0;
  const window = { localStorage: { getItem: k => values.get(k) ?? null }, renderTodayFlashcards: () => today++ };
  const document = { readyState: 'loading', addEventListener() {}, activeElement: node('translationPageSearch'), getElementById: node };
  const ctx = vm.createContext({ window, document, console });
  const code = source('translation.js').replace('  global.GlobalTranslation = Object.freeze({', `
    global.testTranslation = {
      setup(query, mode, session) { pageQuery = query; pageMode = mode; reviewSession = session; },
      state() { return { pageQuery, pageMode, reviewSession }; }
    };
    global.GlobalTranslation = Object.freeze({`);
  vm.runInContext(code, ctx);
  return { values, node, api: window.GlobalTranslation, state: window.testTranslation, today: () => today };
}

test('translation sync refreshes cloud rows and counts while preserving query and selection', () => {
  const h = translationHarness();
  h.state.setup('cloud', 'history', null);
  h.values.set('study_translation_history_v1', JSON.stringify([{ id: 'a', sourceText: 'cloud word', result: { title: 'cloud word' } }]));
  h.api.refreshSyncedData();
  assert.match(h.node('translationHistoryList').innerHTML, /cloud word/);
  assert.match(h.node('translationApp').innerHTML, /value="cloud"/);
  assert.equal(h.state.state().pageQuery, 'cloud');
  assert.deepEqual([h.node('translationPageSearch').selectionStart, h.node('translationPageSearch').selectionEnd], [1, 2]);
  const count = h.today();
  h.api.refreshSyncedData();
  assert.equal(h.today(), count);
  h.values.set('study_translation_cet4_progress_v1', '[{"id":"cet4:test","c":1}]');
  h.api.refreshSyncedData();
  assert.equal(h.today(), count + 1);
});

test('flashcard sync keeps the current revealed card and removes already reviewed upcoming cards', () => {
  const h = translationHarness();
  const entry = id => ({ id, sourceText: id, inVocabulary: true, result: { title: id } });
  h.values.set('study_translation_history_v1', JSON.stringify([
    entry('a'), { ...entry('b'), reviewDueAt: '2099-01-01T00:00:00Z' }, entry('c')
  ]));
  h.state.setup('', 'review', { ids: ['a', 'b', 'c'], index: 0, revealed: true, completed: 1 });
  h.api.refreshSyncedData();
  assert.equal(JSON.stringify(h.state.state().reviewSession.ids), '["a","c"]');
  assert.equal(h.state.state().reviewSession.revealed, true);
  h.values.set('study_translation_history_v1', JSON.stringify([entry('c')]));
  h.api.refreshSyncedData();
  assert.equal(JSON.stringify(h.state.state().reviewSession.ids), '["c"]');
  assert.equal(h.state.state().reviewSession.revealed, false);
  assert.equal(h.state.state().reviewSession.completed, 1);
});

test('translation defers remote redraw during search composition and refreshes at composition end', () => {
  const h = translationHarness();
  h.api.renderPage();
  const search = h.node('translationPageSearch');
  search.listeners.compositionstart();
  h.values.set('study_translation_history_v1', '[{"id":"a","sourceText":"remote","result":{"title":"remote"}}]');
  const before = h.node('translationHistoryList').innerHTML;
  h.api.refreshSyncedData();
  assert.equal(h.node('translationHistoryList').innerHTML, before);
  search.listeners.compositionend();
  assert.match(h.node('translationHistoryList').innerHTML, /remote/);
});

test('unified sync refresh reaches books, prompts and translation through their draft-aware hooks', () => {
  const calls = [];
  let patching = false;
  const hook = name => () => { assert.equal(patching, false); calls.push(name); };
  const window = { refreshSyncedBooks: hook('books'), refreshSyncedPromptStudio: hook('prompts'),
    GlobalTranslation: { refreshSyncedData: hook('translation') },
    SyncDOM: { run(fn) { patching = true; try { fn(); } finally { patching = false; } } } };
  const code = source('sync.js');
  const ctx = vm.createContext({ window, global: window, skillDraftBeforeRemoteApply: null });
  vm.runInContext(code.slice(code.indexOf('  function _refreshUI()'), code.indexOf('  // ── 状态通知')) + '\n_refreshUI();', ctx);
  assert.deepEqual(calls.sort(), ['books', 'prompts', 'translation']);
});
