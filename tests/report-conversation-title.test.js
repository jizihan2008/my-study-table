const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const settings = fs.readFileSync('js/settings.js', 'utf8');
const titleSource = settings.slice(settings.indexOf('async function generateConvTitle('), settings.indexOf('// ═══════════ Debug Mode'));

function load(fetch) {
  const saved = [];
  const context = vm.createContext({
    console: { log() {}, warn() {} },
    isAutoTitleEnabled: () => true,
    getAutoTitleAiKey: () => null,
    getEffectiveApiConfig: () => ({ apiKey: 'test', baseUrl: 'https://example.test', model: 'test' }),
    fetch, saveData: (...args) => saved.push(args), aiConvs: [], renderAiChat() {}
  });
  vm.runInContext(titleSource, context);
  return { context, saved };
}

test('daily report and legacy report titles skip auto-title API requests', async () => {
  const { context, saved } = load(() => { throw new Error('Report must not request a title'); });
  for (const conv of [
    { _dailyReport: true, title: '之前被改过的标题' },
    { title: '📋 每日日报' },
    { title: '☀️ 晨间日报' }
  ]) {
    const original = conv.title;
    await context.generateConvTitle(conv);
    assert.equal(conv.title, original);
  }
  assert.equal(saved.length, 0);
});

test('ordinary chats still receive generated titles', async () => {
  const { context, saved } = load(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '数学复习' } }] }) }));
  const conv = { id: 1, title: '新对话', messages: [{ role: 'user', content: '帮我复习数学' }] };
  await context.generateConvTitle(conv);
  assert.equal(conv.title, '数学复习');
  assert.equal(conv.autoTitled, true);
  assert.equal(saved.length, 1);
});

test('an in-flight title cannot overwrite a restored report conversation', async () => {
  let finish;
  const { context, saved } = load(() => new Promise(resolve => { finish = resolve; }));
  const conv = { id: 1, title: '旧标题', messages: [{ role: 'user', content: '问题' }] };
  const pending = context.generateConvTitle(conv);
  conv._dailyReport = true;
  conv.title = '📋 每日日报';
  finish({ ok: true, json: async () => ({ choices: [{ message: { content: '不应覆盖' } }] }) });
  await pending;
  assert.equal(conv.title, '📋 每日日报');
  assert.equal(saved.length, 0);
});

test('report follow-up chat uses chat prompt while report generation uses report templates', () => {
  const context = vm.createContext({
    getEffectiveApiConfig: () => ({}),
    getChatPromptTemplateDefs: () => [{ id: 'chat' }],
    getPromptTemplate: id => `${id} template`,
    resolvePromptTemplate: value => value
  });
  const api = fs.readFileSync('js/ai-api.js', 'utf8');
  vm.runInContext(api.slice(api.indexOf('function buildConversationSystemPrompt('), api.indexOf('// DeepSeek thinking-mode requests')), context);
  assert.equal(context.buildConversationSystemPrompt({ _dailyReport: true, systemPrompt: '' }), 'chat template');
  assert.match(settings, /getPromptTemplate\('morning'\)/);
  assert.match(settings, /getPromptTemplate\('evening'\)/);
});
