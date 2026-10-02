const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPrompts() {
  const values = new Map();
  const context = vm.createContext({
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value)
    },
    todos: [{ id: 1, text: '第一项', done: false, dueDate: '2026-09-24' }],
    getAncestorPath: () => [],
    getTodayFocusItems: () => ({ items: [{ todoId: 1, done: false }] }),
    findTodo: () => ({ text: '第一项' }),
    buildToolsSystemPrompt: () => '默认聊天提示词'
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'prompts.js'), 'utf8'), context);
  return { context, values };
}

test('shared template is saved and live data is resolved at request time', () => {
  const { context } = loadPrompts();
  vm.runInContext("savePromptTemplate('chat', '任务：{{待办信息}}')", context);
  assert.equal(vm.runInContext("getPromptTemplate('chat')", context), '任务：{{待办信息}}');
  assert.match(vm.runInContext("resolvePromptTemplate(getPromptTemplate('chat'))", context), /\[未完成\] 第一项；截止 2026-09-24/);
  vm.runInContext("todos[0].done = true", context);
  assert.match(vm.runInContext("resolvePromptTemplate(getPromptTemplate('chat'))", context), /\[已完成\] 第一项/);
});

test('report template inserts report snapshot and user instruction', () => {
  const { context } = loadPrompts();
  const result = vm.runInContext("resolvePromptTemplate(getPromptTemplate('morning'), { reportData: '今日完成 2 项', userInstruction: '重点看数学' })", context);
  assert.match(result, /今日完成 2 项/);
  assert.match(result, /重点看数学/);
  assert.doesNotMatch(result, /\{\{日报数据\}\}/);
  context.reportSample = '开头\n📊 **数据一览**\n待办 A\n---\n建议';
  assert.equal(vm.runInContext('reportDataFromLegacyPrompt(reportSample)', context), '📊 **数据一览**\n待办 A');
});

test('custom chat templates are listed separately from report templates', () => {
  const { context } = loadPrompts();
  vm.runInContext("localStorage.setItem('study_prompt_templates_v1', JSON.stringify({ customTemplates: [{ id: 'custom-1', name: '数学导师' }], 'custom-1': '请教我数学' }))", context);
  assert.equal(vm.runInContext("getPromptTemplate('custom-1')", context), '请教我数学');
  assert.equal(vm.runInContext("getChatPromptTemplateDefs().map(item => item.id).join(',')", context), 'chat,custom-1');
});

test('report collapse is independent UI state and never filters report data', () => {
  const { context } = loadPrompts();
  context.sample = { todayStr: '2026-10-01', todayNotes: [{ title: 'sample note' }] };
  vm.runInContext("setReportFieldCollapsed('morning', 'todayNotes', true)", context);
  const html = vm.runInContext("friendlyPromptDataHtml('', 'morning', { previewData: sample })", context);
  assert.match(html, /data-report-field="todayNotes" ><summary>/);
  assert.match(html, /sample note/);
  assert.match(vm.runInContext("reportPromptData('morning', sample)", context), /sample note/);
  assert.equal(vm.runInContext("reportPromptData('morning', sample, 'legacy')", context), 'legacy');
  assert.equal(vm.runInContext("getCollapsedReportFields('evening').length", context), 0);
  vm.runInContext("setReportFieldCollapsed('morning', 'todayNotes', false)", context);
  assert.match(vm.runInContext("friendlyPromptDataHtml('', 'morning', { previewData: sample })", context), /data-report-field="todayNotes" open/);
});

test('upgrade restores accidentally hidden fields and template reset preserves collapse state', () => {
  const { context, values } = loadPrompts();
  vm.runInContext("localStorage.setItem('study_prompt_templates_v1', JSON.stringify({ morning: 'custom', hiddenReportFields: { morning: ['todayStr', 'yesterdayStr', 'focusItems'] }, collapsedReportFields: { morning: ['taskline'] } }))", context);
  assert.equal(vm.runInContext("getPromptTemplate('morning')", context), 'custom');
  assert.doesNotMatch(values.get('study_prompt_templates_v1'), /hiddenReportFields/);
  vm.runInContext("const saved = loadPromptTemplates(); delete saved.morning; persistPromptTemplates(saved)", context);
  assert.match(vm.runInContext("getPromptTemplate('morning')", context), /\{\{日报数据\}\}/);
  assert.equal(vm.runInContext("getCollapsedReportFields('morning').join(',')", context), 'taskline');
});
