'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function source(name) { return fs.readFileSync(path.join(__dirname, '..', 'js', name + '.js'), 'utf8'); }
function storage() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
}
function harness() {
  let id = 0;
  const loading = new Set();
  const stopped = new Set();
  const ctx = {
    window: { _aiResumeInited: true }, console, localStorage: storage(),
    genId: () => ++id, document: { getElementById: () => null, addEventListener() {} },
    getEffectiveApiConfig: () => ({ apiKey: 'fake', name: 'original', model: 'test', contextLimit: 20 }),
    getActiveConvId: () => 'foreground', getActiveConv: () => ({ id: 'foreground', _webSearchMode: 'native' }),
    isAiLoading: id => loading.has(id), setAiLoading: (id, value) => value ? loading.add(id) : loading.delete(id),
    isAiStopRequested: id => stopped.has(id), setAiStopRequested: (id, value) => value ? stopped.add(id) : stopped.delete(id),
    clearAiStreamingDraft() {}, setAiStreamingDraft() {}, safeSaveAiConvs() {}, sendAiNotification() {},
    renderAiMessages() {}, renderTodos() {}, renderLinks() {}, renderNotes() {}, renderToday() {},
    isDebugMode: () => false, buildDeepThinkParams: () => ({}), getMaxFocusCount: () => 3,
    automations: [], saveData() { return true; }, startAutomationTimer() {},
    setTimeout, clearTimeout
  };
  vm.createContext(ctx);
  for (const file of ['ai-tree', 'ai-attach', 'skills', 'ai-tools', 'ai-api', 'ai-send', 'ai-render']) {
    // aiAttachments 在应用里由 js/settings.js 以 let 声明（全局词法绑定），测试里显式补上，
    // 否则对 ctx.aiAttachments 的赋值只会写到宿主对象上，源码里的 push/读改写都看不到
    vm.runInContext(file === 'ai-attach' ? 'let aiAttachments = [];\n' + source(file) : source(file), ctx);
  }
  ctx.showAiToast = () => {};
  // 词法绑定无法从宿主直接读写 → 通过 VM 内代码操作
  ctx.setAiAttachments = list => vm.runInContext('aiAttachments = __list', Object.assign(ctx, { __list: list }));
  ctx.getAiAttachments = () => vm.runInContext('aiAttachments.slice()', ctx);
  ctx.buildToolsSystemPrompt = (conv, cfg) => 'model=' + cfg.model + ';search=' + conv._webSearchMode;
  return ctx;
}
function conversation(ctx) {
  const conv = { id: 'background', systemPrompt: '' };
  ctx.initTreeOnConv(conv);
  ctx.appendMessage(conv, { role: 'user', content: 'question' });
  return conv;
}
const result = (tools = [], text = 'final answer') => ({ toolCalls: tools, cleanText: text, rawReply: text, finishReason: 'stop' });

test('AI skill tools support create, list, read, edit and explicit deletion', async () => {
  const ctx = harness();
  // 接口组由用户在对话设置里勾选，不再按消息关键词筛选
  const groupConv = { id: 'g1', messages: [{ role: 'user', content: '随便聊聊' }], _toolGroups: ['skill'] };
  const selected = ctx.selectAiToolsForConversation(groupConv, false, false);
  for (const name of ['create_skill','list_skills','get_skill','update_skill','delete_skill']) assert.equal(selected.has(name), true);
  assert.equal(selected.has('add_todo'), false);
  assert.equal(ctx.validateAiToolCall('create_skill', { name: '核对事实', content: '先核对来源。' }).ok, true);
  assert.equal(ctx.validateAiToolCall('create_skill', { name: '核对事实', content: ' ' }).ok, false);
  assert.equal(ctx.validateAiToolCall('update_skill', { skillId: 'id' }).ok, false);
  assert.equal(ctx.validateAiToolCall('get_skill', { skillId: 123 }).ok, false);
  assert.equal(ctx.getAiToolJsonSchema('get_skill').properties.skillId.type, 'string');

  const created = await ctx.executeToolCallStructured('create_skill', { name: '核对事实', content: '先核对来源。' });
  assert.equal(created.ok, true);
  const skill = ctx.loadAiSkills()[0];
  assert.equal(typeof skill.id, 'string');
  assert.match((await ctx.executeToolCallStructured('list_skills', {})).text, /核对事实/);
  assert.match((await ctx.executeToolCallStructured('get_skill', { skillId: skill.id })).text, /先核对来源/);
  assert.equal((await ctx.executeToolCallStructured('update_skill', { skillId: skill.id, content: '核对两个来源。' })).ok, true);
  assert.equal(ctx.getAiSkill(skill.id).content, '核对两个来源。');

  // 删除策略取代了过去的「删除意图关键词」判断
  const confirmConv = { id: 'c1', messages: [{ role: 'user', content: '帮我整理这个技能' }], _deletePolicy: 'confirm' };
  assert.equal(ctx.checkAiDeletePolicy('delete_skill', { skillId: skill.id }, confirmConv).ok, true);
  assert.equal(ctx.checkAiDeletePolicy('delete_skill', { skillId: skill.id }, confirmConv).needsConfirm, true);
  assert.equal(ctx.checkAiDeletePolicy('delete_skill', { skillId: skill.id }, { _deletePolicy: 'block' }).ok, false);
  assert.equal(ctx.checkAiDeletePolicy('delete_skill', { skillId: skill.id }, { _deletePolicy: 'allow' }).needsConfirm, false);
  assert.equal(ctx.checkAiDeletePolicy('list_skills', {}, { _deletePolicy: 'block' }).ok, true);
  const snapshot = ctx.beginAiToolTransaction('delete_skill');
  assert.equal((await ctx.executeToolCallStructured('delete_skill', { skillId: skill.id })).ok, true);
  assert.equal(ctx.loadAiSkills().length, 0);
  ctx.rollbackAiToolTransaction(snapshot);
  assert.equal(ctx.loadAiSkills().length, 1);
});

test('note tag tools: create with tags, edit tags, and batch tag by mode', async () => {
  const ctx = harness();
  // 笔记数组在应用里是 core.js 的顶层 let（词法绑定），测试里直接补一个 fixture
  vm.runInContext(`let notes = [
    { id: 101, type: 'note', title: '栈', content: '栈的内容', tags: ['数据结构'], parentId: null },
    { id: 102, type: 'note', title: '并查集', content: '并查集的内容', tags: [], parentId: null },
    { id: 103, type: 'folder', title: '图论', tags: [], parentId: null }
  ];`, ctx);
  const notesInVm = () => JSON.parse(vm.runInContext('JSON.stringify(notes)', ctx));
  const saved = () => vm.runInContext('JSON.stringify(notes)', ctx);

  // schema：新增的参数必须能被原生 function tools 反推出来，否则 AI 根本看不到
  assert.equal(ctx.getAiToolJsonSchema('add_note').properties.tags.type, 'string');
  assert.equal(ctx.getAiToolJsonSchema('update_note').properties.tags.type, 'string');
  const batchSchema = ctx.getAiToolJsonSchema('batch_set_note_tags');
  assert.equal(batchSchema.properties.ids.type, 'array');
  assert.equal(batchSchema.properties.ids.items.type, 'number');
  // 跨 VM realm 的数组原型不同，deepEqual(strict) 会因引用不等而失败，统一用 join 比较
  assert.equal(batchSchema.properties.mode.enum.join(','), 'replace,add');

  // 参数校验：非字符串 tags 直接拒绝，空字符串是合法的「清空」
  assert.equal(ctx.validateAiToolCall('batch_set_note_tags', { ids: [101], tags: '数据结构' }).ok, true);
  assert.equal(ctx.validateAiToolCall('batch_set_note_tags', { ids: [101] }).ok, false);
  assert.equal(ctx.validateAiToolCall('batch_set_note_tags', { ids: [], tags: 'x' }).ok, true); // 空数组在执行层再拦
  assert.equal(ctx.parseAiNoteTags(['数据结构']).ok, false);
  assert.equal(ctx.parseAiNoteTags('数据结构, 图论，数据结构').tags.join(','), '数据结构,图论');
  assert.equal(ctx.parseAiNoteTags('').tags.length, 0);
  assert.equal(ctx.parseAiNoteTags('x'.repeat(25)).ok, false);

  // 新建笔记直接带标签
  const created = await ctx.executeToolCallStructured('add_note', { title: '最短路', content: 'Dijkstra', tags: '图论,最短路' });
  assert.equal(created.ok, true);
  const newNote = notesInVm().find(n => n.title === '最短路');
  assert.deepEqual(newNote.tags, ['图论', '最短路']);

  // 单篇改标签 / 清空
  assert.equal((await ctx.executeToolCallStructured('update_note', { id: 102, tags: '数据结构' })).ok, true);
  assert.deepEqual(notesInVm().find(n => n.id === 102).tags, ['数据结构']);
  assert.match((await ctx.executeToolCallStructured('update_note', { id: 102, tags: '' })).text, /已清空/);
  assert.deepEqual(notesInVm().find(n => n.id === 102).tags, []);

  // 批量：replace 覆盖、add 追加、跳过文件夹与不存在的 ID
  const replaced = await ctx.executeToolCallStructured('batch_set_note_tags', { ids: [101, 102], tags: '算法', mode: 'replace' });
  assert.equal(replaced.ok, true);
  assert.deepEqual(notesInVm().find(n => n.id === 101).tags, ['算法']);
  assert.deepEqual(notesInVm().find(n => n.id === 102).tags, ['算法']);
  assert.match(replaced.text, /已覆盖设置 2 篇笔记/);

  const added = await ctx.executeToolCallStructured('batch_set_note_tags', { ids: [101, 999, 103], tags: '重点', mode: 'add' });
  assert.equal(added.ok, true);
  assert.deepEqual(notesInVm().find(n => n.id === 101).tags, ['算法', '重点']);
  assert.match(added.text, /跳过了 1 个不存在的ID/);
  assert.match(added.text, /跳过了 1 个文件夹/);

  // 读回显：get_note_detail 与 list_notes 都要能看到标签，AI 才能自查
  assert.match((await ctx.executeToolCallStructured('get_note_detail', { id: 101 })).text, /🏷️ 标签：算法、重点/);
  assert.match((await ctx.executeToolCallStructured('list_notes', {})).text, /🏷️算法、重点/);

  // get_note_tags：标签全集 + 每个标签挂几篇 + 未打标签的篇数
  // 此时数据：栈[算法,重点]、并查集[算法]、最短路[图论,最短路] → 4 个标签，3 篇全有标签
  const tagReport = await ctx.executeToolCallStructured('get_note_tags', {});
  assert.equal(tagReport.ok, true);
  assert.match(tagReport.text, /标签全集：共 4 个（3 篇笔记，3 篇已打标签，0 篇未打标签）/);
  assert.match(tagReport.text, /- 【算法】2 篇：栈\[ID:101\]、并查集\[ID:102\]/);
  assert.match(tagReport.text, /- 【重点】1 篇：栈\[ID:101\]/);
  // 计数多的标签排前面，同一份数据输出稳定
  assert.ok(tagReport.text.indexOf('【算法】') < tagReport.text.indexOf('【重点】'));
  // search 命中标签名
  const byTag = await ctx.executeToolCallStructured('get_note_tags', { search: '重点' });
  assert.match(byTag.text, /匹配「重点」的有 1 个/);
  assert.ok(byTag.text.indexOf('【算法】') === -1);
  // search 也能命中标题；includeNotes=false 时只留标签+计数
  const byTitle = await ctx.executeToolCallStructured('get_note_tags', { search: '栈' });
  assert.match(byTitle.text, /【算法】/);
  const countsOnly = await ctx.executeToolCallStructured('get_note_tags', { includeNotes: false });
  assert.match(countsOnly.text, /- 【算法】2 篇\n/);
  assert.ok(countsOnly.text.indexOf('[ID:101]') === -1, 'includeNotes=false 不应列出笔记');
  // 它是只读接口：不参与写事务，也不受「完全拦截删除」影响
  assert.equal(ctx.getAiToolMetadata('get_note_tags').effect, 'read');
  assert.equal(ctx.checkAiDeletePolicy('get_note_tags', {}, { _deletePolicy: 'block' }).ok, true);

  // 写入确实落到 study_notes_v2
  assert.match(saved(), /"tags":\["算法","重点"\]/);
});

test('set_note_review explicitly and idempotently controls review for multiple notes', async () => {
  const ctx = harness();
  vm.runInContext(`let notes = [
    { id: 301, type: 'note', title: '线性代数', content: '矩阵', _skipReview: false, parentId: null },
    { id: 303, type: 'note', title: '概率论', content: '条件概率', _skipReview: false, parentId: null },
    { id: 302, type: 'folder', title: '数学', parentId: null }
  ];`, ctx);
  const readNotes = () => JSON.parse(vm.runInContext('JSON.stringify(notes)', ctx));

  const schema = ctx.getAiToolJsonSchema('set_note_review');
  assert.equal(schema.properties.ids.type, 'array');
  assert.equal(schema.properties.ids.items.type, 'number');
  assert.equal(schema.properties.needsReview.type, 'boolean');
  assert.equal(schema.required.join(','), 'ids,needsReview');
  assert.equal(ctx.validateAiToolCall('set_note_review', { ids: [301, 303], needsReview: false }).ok, true);
  assert.equal(ctx.validateAiToolCall('set_note_review', { ids: [301] }).ok, false);
  assert.equal(ctx.validateAiToolCall('set_note_review', { ids: [301], needsReview: 'false' }).ok, false);

  const disabled = await ctx.executeToolCallStructured('set_note_review', { ids: [301, 303, 999, 302], needsReview: false });
  assert.equal(disabled.ok, true);
  assert.equal(readNotes().find(n => n.id === 301)._skipReview, true);
  assert.equal(readNotes().find(n => n.id === 303)._skipReview, true);
  assert.match(disabled.text, /2 篇笔记设为跳过复习/);
  assert.match(disabled.text, /跳过了 1 个不存在的ID/);
  assert.match(disabled.text, /跳过了 1 个文件夹/);

  const unchanged = await ctx.executeToolCallStructured('set_note_review', { ids: [301, 303], needsReview: false });
  assert.equal(unchanged.ok, true);
  assert.match(unchanged.text, /0 篇发生变更，2 篇原本已是该状态/);

  const enabled = await ctx.executeToolCallStructured('set_note_review', { ids: [301], needsReview: true });
  assert.equal(enabled.ok, true);
  assert.equal(readNotes().find(n => n.id === 301)._skipReview, false);
  assert.match((await ctx.executeToolCallStructured('get_note_detail', { id: 301 })).text, /复习状态：需要复习/);
  assert.match((await ctx.executeToolCallStructured('list_notes', {})).text, /需要复习/);

  const folder = await ctx.executeToolCallStructured('set_note_review', { ids: [302], needsReview: false });
  assert.equal(folder.ok, false);
  assert.match(folder.text, /文件夹/);

  const selected = ctx.selectAiToolsForConversation({ id: 'notes', messages: [], _toolGroups: ['note'] }, false, false);
  assert.equal(selected.has('set_note_review'), true);
});

test('translation tools expose the list, vocabulary membership and flashcard review to AI', async () => {
  const ctx = harness();
  const entries = [{
    id: 'tr-focus', sourceText: 'focus', inVocabulary: false, reviewDueAt: '', reviewCount: 0,
    result: { title: 'focus', englishDefinition: 'the main object of attention', chineseMeaning: '注意力', englishExample: 'Focus on the task.' }
  }];
  ctx.window.GlobalTranslation = {
    getHistory: () => entries.map(entry => ({ ...entry, result: { ...entry.result } })),
    toggleVocabulary: (id, value) => {
      const entry = entries.find(item => item.id === id);
      if (!entry) return false;
      entry.inVocabulary = value;
      entry.reviewDueAt = value ? new Date(0).toISOString() : entry.reviewDueAt;
      return true;
    },
    gradeReview: (id, rating) => {
      const entry = entries.find(item => item.id === id && item.inVocabulary);
      if (!entry) return null;
      entry.reviewCount++;
      entry.lastReviewRating = rating;
      entry.reviewDueAt = '2026-09-23T00:00:00.000Z';
      return { ...entry, result: { ...entry.result } };
    }
  };

  const selected = ctx.selectAiToolsForConversation({ id: 'translations', messages: [], _toolGroups: ['translation'] }, false, false);
  assert.equal([...selected].sort().join(','), 'list_translations,review_translation_flashcard,set_translation_vocabulary');
  assert.equal(ctx.getAiToolMetadata('list_translations').effect, 'read');
  assert.equal(ctx.getAiToolJsonSchema('review_translation_flashcard').properties.rating.enum.join(','), 'again,hard,good');
  assert.equal(ctx.validateAiToolCall('set_translation_vocabulary', { entryIds: ['tr-focus'], inVocabulary: true }).ok, true);
  assert.equal(ctx.validateAiToolCall('set_translation_vocabulary', { entryIds: [], inVocabulary: true }).ok, false);
  assert.equal(ctx.validateAiToolCall('review_translation_flashcard', { entryId: 'tr-focus', rating: 'easy' }).ok, false);

  const initial = await ctx.executeToolCallStructured('list_translations', { search: '注意力' });
  assert.match(initial.text, /翻译列表：共 1 条/);
  assert.match(initial.text, /\[ID:tr-focus\]/);
  assert.match(initial.text, /未加入生词本/);

  const saved = await ctx.executeToolCallStructured('set_translation_vocabulary', { entryIds: ['tr-focus'], inVocabulary: true });
  assert.equal(saved.ok, true);
  assert.equal(entries[0].inVocabulary, true);
  const due = await ctx.executeToolCallStructured('list_translations', { dueOnly: true });
  assert.match(due.text, /待复习/);

  const reviewed = await ctx.executeToolCallStructured('review_translation_flashcard', { entryId: 'tr-focus', rating: 'good' });
  assert.equal(reviewed.ok, true);
  assert.match(reviewed.text, /记得/);
  assert.equal(entries[0].reviewCount, 1);
});

test('required params reject blank input except the parameters where blank means "clear"', () => {
  const ctx = harness();
  // 空字符串在绝大多数接口里是「没填」；只有 tags 这类参数用空串表达「清空」。
  // 这条不变量靠 AI_TOOL_EMPTY_STRING_MEANS_CLEAR 维护，改必填校验时不能悄悄破坏。
  const emptyMeansClear = Array.from(vm.runInContext('Array.from(AI_TOOL_EMPTY_STRING_MEANS_CLEAR)', ctx));
  assert.deepEqual(emptyMeansClear, ['tags']);
  assert.equal(ctx.validateAiToolCall('batch_set_note_tags', { ids: [1], tags: '' }).ok, true);
  assert.equal(ctx.validateAiToolCall('update_note', { id: 1, tags: '' }).ok, true);
  // 必填参数留空仍然被拦下
  assert.equal(ctx.validateAiToolCall('add_note', { title: '   ' }).ok, true); // 标题只查是否为空串，空白由执行层兜底
  assert.equal(ctx.validateAiToolCall('add_note', {}).ok, false);
  assert.equal(ctx.validateAiToolCall('add_todo', { text: '' }).ok, false);
  assert.equal(ctx.validateAiToolCall('search_notes', { query: '' }).ok, false);
  assert.equal(ctx.validateAiToolCall('search_chat_messages', { query: '' }).ok, false);
  assert.equal(ctx.validateAiToolCall('web_search', { query: '' }).ok, false);
  // 非必填的 text 传空串仍然合法（等价于只改其他字段/空操作）
  assert.equal(ctx.validateAiToolCall('update_todo', { id: 5, text: '' }).ok, true);
});

test('get_note_tags explains an empty tag vocabulary instead of returning nothing', async () => {
  const ctx = harness();
  vm.runInContext(`let notes = [
    { id: 201, type: 'note', title: '未归类', content: 'x', tags: [], parentId: null }
  ];`, ctx);
  const empty = await ctx.executeToolCallStructured('get_note_tags', {});
  assert.equal(empty.ok, true);
  assert.match(empty.text, /暂无标签（共 1 篇笔记，全部未打标签）/);
  assert.match(empty.text, /batch_set_note_tags/);
});

test('tool groups are chosen by the conversation and cover every tool', () => {
  const ctx = harness();
  const inVm = expr => Array.from(vm.runInContext(expr, ctx));
  const groupKeys = inVm('AI_TOOL_GROUPS.map(g => g.key)');
  const allTools = inVm('Object.keys(AI_TOOLS)');
  const grouped = inVm('AI_TOOL_GROUPS.flatMap(g => g.tools)');
  // 每个工具恰好属于一个组；接口组目录 = 全部工具
  assert.deepEqual([...grouped].sort(), [...allTools].sort());
  assert.equal(new Set(grouped).size, grouped.length);

  // 未设置过 → 沿用记住的选择；再没有 → 全部开放
  const fresh = { id: 'f1', messages: [] };
  assert.deepEqual(inVm('getConversationToolGroups({ id: "f1", messages: [] })'), groupKeys);
  vm.runInContext(`localStorage.setItem('study_ai_tool_prefs', JSON.stringify({ groups: ['note'] }))`, ctx);
  assert.deepEqual(inVm('getConversationToolGroups({ id: "f1", messages: [] })'), ['note']);
  const explicit = { id: 'f2', messages: [], _toolGroups: [] };
  assert.deepEqual(Array.from(ctx.getConversationToolGroups(explicit)), []);
  assert.equal(ctx.selectAiToolsForConversation(explicit, false, false).size, 0);
  // 保存勾选会同时记住，供之后未配置的对话沿用
  const target = { id: 'f3', messages: [] };
  ctx.setConversationToolGroups(target, ['quest', 'web', '不存在的组']);
  assert.deepEqual(Array.from(target._toolGroups), ['quest', 'web']);
  assert.deepEqual(inVm('getConversationToolGroups({ id: "f1", messages: [] })'), ['quest', 'web']);
});

test('blocking deletes hides the delete-capable tools while confirm/allow keep them', () => {
  const ctx = harness();
  const all = vm.runInContext('AI_TOOL_GROUPS.map(g => g.key)', ctx);
  const confirmTools = ctx.selectAiToolsForConversation({ _toolGroups: all, _deletePolicy: 'confirm' }, false, false);
  for (const name of ['delete_todo','delete_note','delete_skill','delete_link','delete_automation','batch_update_todos']) {
    assert.equal(confirmTools.has(name), true, name + ' 应在 confirm 策略下下发');
  }
  const blockedTools = ctx.selectAiToolsForConversation({ _toolGroups: all, _deletePolicy: 'block' }, false, false);
  for (const name of ['delete_todo','delete_note','delete_skill','delete_link','delete_automation','batch_update_todos']) {
    assert.equal(blockedTools.has(name), false, name + ' 应在 block 策略下隐藏');
  }
  assert.equal(blockedTools.has('list_todos'), true);
  assert.equal(blockedTools.has('add_todo'), true);
  // 原生模式与文本模式共用同一集合
  const nativeBlocked = ctx.selectedNativeLocalTools({ _toolGroups: all, _deletePolicy: 'block' }, { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' });
  const nativeNames = nativeBlocked.map(item => item.function.name);
  assert.equal(nativeNames.includes('delete_todo'), false);
  assert.equal(nativeNames.includes('list_todos'), true);
});

test('toggle_todo is gone: neither defined nor executable', async () => {
  const ctx = harness();
  assert.equal(vm.runInContext('typeof AI_TOOLS.toggle_todo', ctx), 'undefined');
  const result = await ctx.executeToolCallStructured('toggle_todo', { id: 1 });
  assert.equal(result.ok, false);
  assert.match(String(result.text || result.error || ''), /未知工具|未找到|不支持/);
});

test('tree normalization repairs stale message cache from the active path', () => {
  const ctx = harness();
  const conv = conversation(ctx);
  ctx.appendMessage(conv, { role: 'assistant', content: 'answer' });
  conv.messages = conv.messages.slice(0, 1);
  ctx.ensureTree(conv);
  assert.deepEqual(Array.from(conv.messages, m => m.content), ['question', 'answer']);
});

test('identical edited user branches merge without dropping either reply chain', () => {
  const ctx = harness();
  const conv = { id: 'duplicates' };
  ctx.initTreeOnConv(conv);
  const firstUser = ctx.appendMessage(conv, { role: 'user', content: 'same question' });
  const firstReply = ctx.appendMessage(conv, { role: 'assistant', content: 'first answer' });
  const duplicateUser = ctx.createBranchFromEdit(conv, firstUser, 'same question');
  const secondReply = ctx.appendMessage(conv, { role: 'assistant', content: 'second answer' });

  ctx.ensureTree(conv);

  const userChildren = conv.tree.root.children.filter(id => conv.tree[id]?.role === 'user');
  assert.equal(userChildren.length, 1);
  const merged = conv.tree[userChildren[0]];
  assert.deepEqual(new Set(merged.children), new Set([firstReply, secondReply]));
  assert.equal(conv.activePath.includes(duplicateUser), true);
  assert.equal(conv.messages.at(-1).content, 'second answer');
});

test('exported missing-message shape reconnects the stopped reply before continue', () => {
  const ctx = harness();
  const conv = { id: 'reported-log' };
  ctx.initTreeOnConv(conv);
  const originalUser = ctx.appendMessage(conv, { role: 'user', content: 'plan linear algebra' });
  ctx.appendMessage(conv, { role: 'assistant', content: 'checking your todos' });
  const toolResult = ctx.appendMessage(conv, { role: 'system', content: 'tool results' });
  const continueUser = ctx.appendMessage(conv, { role: 'user', content: 'continue' });

  const duplicateUser = ctx.createBranchFromEdit(conv, originalUser, 'plan linear algebra');
  const hiddenReply = ctx.appendMessage(conv, { role: 'assistant', content: 'the long stopped reply\n\n> stopped: ⏹️' });
  ctx.switchBranch(conv, continueUser);
  conv.messages = [conv.tree[originalUser]];

  ctx.ensureTree(conv);

  assert.equal(conv.tree.root.children.length, 1);
  const canonicalUser = conv.tree.root.children[0];
  assert.equal(conv.activePath.at(-1), continueUser);
  assert.deepEqual(Array.from(conv.messages, m => m.content), [
    'plan linear algebra', 'checking your todos', 'tool results',
    'the long stopped reply\n\n> stopped: ⏹️', 'continue'
  ]);
  assert.equal([originalUser, duplicateUser].includes(canonicalUser), true);
  assert.equal(conv.tree[hiddenReply].parentId, toolResult);
  assert.equal(conv.tree[continueUser].parentId, hiddenReply);
  assert.equal(conv.tree[canonicalUser].children.length, 1);
});

test('editing a user message without changing its text does not create a branch', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  const userId = conv.activePath.at(-1);
  ctx.getActiveConv = () => conv;
  await ctx.sendEditedMessage(userId, '  question  ');
  assert.equal(conv.tree.root.children.length, 1);
  assert.equal(conv.tree[userId].children.length, 0);
});

test('candidate arrows follow sibling order and restore the full chosen branch', () => {
  const ctx = harness();
  const conv = { id: 'arrows' };
  ctx.initTreeOnConv(conv);
  const userId = ctx.appendMessage(conv, { role: 'user', content: 'question' });
  const first = ctx.appendMessage(conv, { role: 'assistant', content: 'first' });
  ctx.appendMessage(conv, { role: 'system', content: 'first tool result' });
  const second = ctx.createBranch(conv, userId, { role: 'assistant', content: 'second' });
  ctx.appendMessage(conv, { role: 'system', content: 'second tool result' });
  const third = ctx.createBranch(conv, userId, { role: 'assistant', content: 'third' });
  ctx.appendMessage(conv, { role: 'system', content: 'third tool result' });
  ctx.getActiveConv = () => conv;

  ctx.switchBranch(conv, second);
  ctx.navigateCandidateBranch(second, 1);
  assert.equal(conv.activePath.includes(third), true);
  assert.equal(conv.messages.at(-1).content, 'third tool result');
  ctx.navigateCandidateBranch(third, 1);
  assert.equal(conv.activePath.includes(first), true);
  assert.equal(conv.messages.at(-1).content, 'first tool result');
});

test('edited user version arrows keep the selected version reply and continuation', () => {
  const ctx = harness();
  const conv = { id: 'versions' };
  ctx.initTreeOnConv(conv);
  const first = ctx.appendMessage(conv, { role: 'user', content: 'first question' });
  ctx.appendMessage(conv, { role: 'assistant', content: 'first answer' });
  const second = ctx.createBranchFromEdit(conv, first, 'second question');
  ctx.appendMessage(conv, { role: 'assistant', content: 'second answer' });
  const third = ctx.createBranchFromEdit(conv, first, 'third question');
  ctx.appendMessage(conv, { role: 'assistant', content: 'third answer' });
  ctx.appendMessage(conv, { role: 'user', content: 'follow up' });
  ctx.getActiveConv = () => conv;

  ctx.switchUserVersion(second, 1);
  assert.equal(conv.activePath.includes(third), true);
  assert.equal(conv.messages.at(-1).content, 'follow up');
});

test('last save fallback retains every tree branch without the redundant message cache', () => {
  const ctx = harness();
  const conv = { id: 'fallback', title: 'branched', systemPrompt: '', _dailyReport: true };
  ctx.initTreeOnConv(conv);
  const userId = ctx.appendMessage(conv, { role: 'user', content: 'question' });
  const first = ctx.appendMessage(conv, { role: 'assistant', content: 'first answer' });
  const second = ctx.createBranch(conv, userId, { role: 'assistant', content: 'second answer' });
  conv._rawLogs = { circular: conv };
  vm.runInContext(source('ai-utils'), ctx);
  ctx.aiConvs = [conv];
  const saved = storage();
  let attempts = 0;
  ctx.localStorage = {
    getItem: saved.getItem,
    setItem(key, value) {
      if (++attempts === 1) throw new Error('storage quota');
      saved.setItem(key, value);
    }
  };

  assert.equal(ctx.safeSaveAiConvs(), true);
  const restored = JSON.parse(saved.getItem('study_ai_convs'))[0];
  assert.equal(restored.messages, undefined);
  assert.equal(restored._dailyReport, true);
  assert.deepEqual(restored.tree[userId].children, [first, second]);
  ctx.ensureTree(restored);
  assert.equal(restored.messages.at(-1).content, 'second answer');
});

test('missing policy settings use 60 seconds, two retries and exponential backoff', async () => {
  const delays = [];
  const window = {};
  let attempts = 0;
  vm.runInNewContext(source('ai-client'), {
    window, localStorage: storage(), AbortController, DOMException,
    setTimeout(fn, ms) { delays.push(ms); if (ms < 60000) queueMicrotask(fn); return 1; }, clearTimeout() {},
    fetch: async () => { attempts++; return { status: 503, headers: { get: () => null } }; }
  });
  await window.AIClient.fetchWithPolicy('/fake');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [60000, 500, 60000, 1000, 60000]);
});

test('stop during retry backoff cancels without sending another request', async () => {
  const window = {};
  let attempts = 0;
  let onBackoff;
  const backoff = new Promise(resolve => { onBackoff = resolve; });
  vm.runInNewContext(source('ai-client'), {
    window, localStorage: storage(), AbortController, DOMException,
    setTimeout(fn, ms) { if (ms === 500) onBackoff(); return setTimeout(fn, ms); }, clearTimeout,
    fetch: async () => { attempts++; return { status: 503, headers: { get: () => null } }; }
  });
  const request = window.AIClient.fetchWithPolicy('/fake', {}, { scope: 'background' });
  await backoff;
  assert.equal(window.AIClient.cancel('background'), 1);
  await assert.rejects(request, /已取消/);
  assert.equal(attempts, 1);
  assert.equal(window.AIClient.cancel('background'), 0);
});

test('JSON body consumption releases request control even on failure', async () => {
  const ctx = harness();
  let released = 0;
  await assert.rejects(ctx.readAiResponseJson({ json: async () => { throw Error('broken body'); }, _aiRequestControl: { release() { released++; }, controller: new AbortController() } }), /broken body/);
  assert.equal(released, 1);
});

test('regeneration saves exactly one final answer after a tool chain', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  const userId = conv.activePath.at(-1);
  let calls = 0;
  ctx.callAiApi = async () => ++calls === 1 ? result([{ action: 'list_todos', params: {} }], 'query') : result();
  ctx.executeToolCall = async () => 'tasks';
  await ctx.regenerateFromUserNode(conv, userId);
  assert.equal(conv.messages.filter(m => m.content === 'final answer').length, 1);
  assert.equal(conv.messages.at(-1).role, 'assistant');
  assert.equal(conv.messages.at(-2).role, 'system');
  assert.equal(conv.messages.at(-1).keyName, 'original');
  assert.equal(ctx.isAiLoading(conv.id), false);
});

test('background request uses its own stop flag and original model across rounds', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  conv._webSearchMode = 'external';
  ctx.setAiStopRequested('foreground', true);
  const seen = [];
  const cfg = { apiKey: 'fake', model: 'original', contextLimit: 20 };
  ctx.callAiApi = async (messages, current) => {
    seen.push({ prompt: messages[0].content, model: current.model });
    cfg.model = 'changed';
    conv._webSearchMode = 'native';
    return seen.length === 1 ? result([{ action: 'list_todos', params: {} }]) : result();
  };
  ctx.executeToolCall = async () => 'tasks';
  const output = await ctx.runToolCallLoop(cfg, conv);
  assert.equal(output.stopped, false);
  assert.equal(seen.length, 2);
  assert.ok(seen.every(row => row.model === 'original' && row.prompt.includes('search=external')));
});

test('background stop prevents its API call', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  ctx.setAiStopRequested(conv.id, true);
  ctx.callAiApi = async () => { throw Error('must not call'); };
  assert.equal((await ctx.runToolCallLoop({}, conv)).stopped, true);
});

test('unified quest condition tool creates, updates and deletes every condition type', async () => {
  const ctx = harness();
  const clone = value => JSON.parse(JSON.stringify(value));
  let persisted = { quests: [{ id: 101, title: 'chapter', conditions: [] }] };
  ctx.loadTaskLineStore = () => clone(persisted);
  ctx.saveTaskLineStore = store => { persisted = clone(store); return true; };
  // Reproduce the old split-read behavior: this returns a different object from
  // the one saveTaskLineStore would receive if the tool loaded the store again.
  ctx.tlGetQuest = id => ctx.loadTaskLineStore().quests.find(q => q.id === id) || null;
  ctx.findTodo = id => id === 201 ? { id, text: 'finish exercises' } : null;
  ctx.notes = [{ id: 301, type: 'note', title: 'chapter notes' }];
  ctx.tlMakeTodoCond = id => ({ type: 'todo', todoId: id, label: 'finish exercises' });
  ctx.tlMakeNoteCond = id => ({ type: 'note', noteId: id, label: 'chapter notes' });
  ctx.tlMakeTimerCond = (id, minutes, targetType) => ({ type: 'timer', targetId: id, minutes, targetType, label: 'focus 30 min' });
  ctx.tlRefreshQuestStatus = () => {};
  ctx.renderTaskLine = () => {};

  assert.match(await ctx.executeToolCall('quest_edit_condition', { action: 'create', questId: 101, type: 'todo', todoId: 201 }), /^\u2705/);
  assert.match(await ctx.executeToolCall('quest_edit_condition', { action: 'create', questId: 101, type: 'note', noteId: 301 }), /^\u2705/);
  assert.match(await ctx.executeToolCall('quest_edit_condition', { action: 'create', questId: 101, type: 'timer', targetId: 201, minutes: 30 }), /^\u2705/);
  assert.match(await ctx.executeToolCall('quest_edit_condition', { action: 'create', questId: 101, type: 'manual', label: 'manual check' }), /^\u2705/);

  assert.deepEqual(persisted.quests[0].conditions.map(c => c.type), ['todo', 'note', 'timer', 'manual']);
  assert.deepEqual(ctx.loadTaskLineStore().quests[0].conditions.map(c => c.label), [
    'finish exercises', 'chapter notes', 'focus 30 min', 'manual check'
  ]);

  assert.match(await ctx.executeToolCall('quest_edit_condition', { action: 'update', questId: 101, conditionIndex: 4, label: 'updated check', done: true }), /^\u2705/);
  assert.equal(persisted.quests[0].conditions[3].label, 'updated check');
  assert.equal(persisted.quests[0].conditions[3].done, true);
  assert.match(await ctx.executeToolCall('quest_edit_condition', { action: 'update', questId: 101, conditionIndex: 3, minutes: 45 }), /^\u2705/);
  assert.equal(persisted.quests[0].conditions[2].minutes, 45);
  assert.match(await ctx.executeToolCall('quest_edit_condition', { action: 'delete', questId: 101, conditionIndex: 2 }), /^\u2705/);
  assert.deepEqual(persisted.quests[0].conditions.map(c => c.type), ['todo', 'timer', 'manual']);

  const schema = ctx.getAiToolJsonSchema('quest_edit_condition');
  assert.equal(schema.properties.action.enum.join(','), 'create,update,delete');
  assert.equal(schema.properties.type.enum.join(','), 'todo,note,timer,manual');
  for (const removed of ['quest_link_todo','quest_link_note','quest_link_timer','quest_add_manual_cond']) {
    assert.equal(vm.runInContext(`typeof AI_TOOLS.${removed}`, ctx), 'undefined');
  }
  assert.equal(ctx.validateAiToolCall('quest_edit_condition', { action: 'create', questId: 101, type: 'timer', targetId: 201, minutes: 0 }).ok, false);
  assert.equal(ctx.validateAiToolCall('quest_edit_condition', { action: 'update', questId: 101, conditionIndex: 99, label: 'x' }).ok, false);
  assert.equal(ctx.getAiToolMetadata('quest_edit_condition', { action: 'create' }).risk, 'write');
  assert.equal(ctx.getAiToolMetadata('quest_edit_condition', { action: 'delete' }).risk, 'write');
  assert.equal(ctx.checkAiDeletePolicy('quest_edit_condition', { action: 'delete', questId: 101, conditionIndex: 1 }, { _deletePolicy: 'block' }).ok, true);
  const blockedSelection = ctx.selectAiToolsForConversation({ id: 'blocked-quest', messages: [], _toolGroups: ['quest'], _deletePolicy: 'block' }, false, false);
  assert.equal(blockedSelection.has('quest_edit_condition'), true);
});

test('quest condition tools do not report success when persistence fails', async () => {
  const ctx = harness();
  ctx.loadTaskLineStore = () => ({ quests: [{ id: 101, conditions: [] }] });
  ctx.saveTaskLineStore = () => false;
  ctx.renderTaskLine = () => { throw Error('must not render an unsaved condition'); };

  assert.equal(
    await ctx.executeToolCall('quest_edit_condition', { action: 'create', questId: 101, type: 'manual', label: 'manual check' }),
    '❌ 完成条件保存失败'
  );
});

test('malformed tool protocol detector recognizes DSML, escaped tags and naked known actions', () => {
  const ctx = harness();
  assert.equal(ctx.detectMalformedToolProtocol('<｜DSML｜function_calls><｜DSML｜invoke name="quest_create">').kind, 'dsml');
  assert.equal(ctx.detectMalformedToolProtocol('\\<tool\\_call>{"action":"quest\\_create","params":{}}').kind, 'tool_tag');
  assert.equal(ctx.detectMalformedToolProtocol('{"action":"quest_create","params":{}}').kind, 'bare_json');
  assert.equal(ctx.detectMalformedToolProtocol('DSML 是一种工具调用协议。'), null);
  assert.equal(ctx.detectMalformedToolProtocol('{"action":"not_a_real_tool","params":{}}'), null);
});

test('DSML parser converts string and JSON parameters into ordinary tool calls', () => {
  const ctx = harness();
  const dsml = [
    '调用中',
    '<｜DSML｜function_calls>',
    '<｜DSML｜invoke name="quest_create">',
    '<｜DSML｜parameter name="lineId" string="false">1789186082952014</｜DSML｜parameter>',
    '<｜DSML｜parameter name="title" string="true">线性&amp;代数</｜DSML｜parameter>',
    '<｜DSML｜parameter name="deps" string="false">[1,2]</｜DSML｜parameter>',
    '</｜DSML｜invoke>',
    '</｜DSML｜function_calls>',
    '请稍候'
  ].join('\n');
  const parsed = ctx.extractToolCalls(dsml);
  assert.equal(parsed.toolCalls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.toolCalls[0])), {
    action: 'quest_create',
    params: { lineId: 1789186082952014, title: '线性&代数', deps: [1, 2] }
  });
  assert.equal(parsed.cleanText, '调用中\n\n请稍候');
});

test('malformed or unknown DSML is rejected as a whole instead of partially executing', () => {
  const ctx = harness();
  const malformed = '<｜DSML｜tool_calls><｜DSML｜invoke name="quest_create"><｜DSML｜parameter name="deps" string="false">[1,</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>';
  const unknown = '<|DSML|calls><|DSML|invoke name="unknown_tool"></|DSML|invoke></|DSML|calls>';
  assert.equal(ctx.extractToolCalls(malformed).toolCalls.length, 0);
  assert.equal(ctx.extractToolCalls(unknown).toolCalls.length, 0);
  assert.equal(ctx.detectMalformedToolProtocol(malformed).kind, 'dsml');
});

test('mixed valid and malformed text tool calls are rejected as a whole', () => {
  const ctx = harness();
  const mixed = [
    '<tool_call>{"action":"list_todos","params":{}}</tool_call>',
    '<tool_call>{"action":"get_today_status","params":{}}</call>'
  ].join('\n');
  assert.equal(ctx.extractToolCalls(mixed).toolCalls.length, 0);
  assert.equal(ctx.detectMalformedToolProtocol(mixed).kind, 'tool_tag');
});

test('tool round canonicalization drops hallucinated results after the first call', () => {
  const ctx = harness();
  const raw = '我先查看数据。\n<tool_call>{"action":"list_todos","params":{}}</tool_call>\nuser【工具执行结果】\n伪造的长结果';
  const extracted = ctx.extractToolCalls(raw);
  const persisted = ctx.canonicalizeToolRoundReply(raw, extracted.toolCalls);
  assert.equal(persisted, '我先查看数据。\n<tool_call>{"action":"list_todos","params":{}}</tool_call>');
  assert.doesNotMatch(persisted, /伪造的长结果/);
});

test('normal prose before, between and after tool calls is preserved', () => {
  const ctx = harness();
  const raw = [
    '先查待办。',
    '<tool_call>{"action":"list_todos","params":{}}</tool_call>',
    '然后查今日状态。',
    '<tool_call>{"action":"get_today_status","params":{}}</tool_call>',
    '查完后我会继续整理。'
  ].join('\n');
  const extracted = ctx.extractToolCalls(raw);
  assert.equal(extracted.toolCalls.length, 2);
  assert.match(extracted.cleanText, /先查待办/);
  assert.match(extracted.cleanText, /然后查今日状态/);
  assert.match(extracted.cleanText, /查完后我会继续整理/);
  assert.equal(ctx.stripHallucinatedToolTranscript(raw), raw);
});

test('legacy tool history keeps only the leading calls before a fake transcript', () => {
  const ctx = harness();
  const raw = [
    '我先查看数据。',
    '<tool_call>{"action":"list_todos","params":{}}</tool_call>',
    '<tool_call>{"action":"get_today_status","params":{}}</tool_call>',
    'user【工具执行结果】',
    '伪造结果',
    '<tool_call>{"action":"get_stats","params":{}}</call>'
  ].join('\n');
  const repaired = ctx.canonicalizeLegacyToolRoundReply(raw);
  assert.match(repaired, /list_todos/);
  assert.match(repaired, /get_today_status/);
  assert.doesNotMatch(repaired, /伪造结果|get_stats/);
});

test('streaming display preserves normal text around calls but removes a fake result tail', () => {
  const renderCtx = {
    document: { addEventListener() {} },
    setTimeout, clearTimeout, console
  };
  vm.createContext(renderCtx);
  vm.runInContext(source('ai-render'), renderCtx);
  const raw = '正在查看。\n<tool_call>{"action":"list_todos","params":{}}</tool_call>\nuser【工具执行结果】\n巨大的伪结果';
  assert.equal(renderCtx.sanitizeAiStreamingText(raw), '正在查看。');
  const normal = '调用前\n<tool_call>{"action":"list_todos","params":{}}</tool_call>\n调用后';
  assert.equal(renderCtx.sanitizeAiStreamingText(normal), '调用前\n\n调用后');
});

test('valid DSML executes through the existing tool loop without protocol failure', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  let calls = 0;
  let executions = 0;
  ctx.callAiApi = async () => {
    calls++;
    if (calls === 1) {
      const rawReply = '<｜DSML｜function_calls><｜DSML｜invoke name="list_todos"></｜DSML｜invoke></｜DSML｜function_calls>';
      const extracted = ctx.extractToolCalls(rawReply);
      return { ...result(extracted.toolCalls, extracted.cleanText), rawReply };
    }
    return result([], '完成。');
  };
  ctx.executeToolCall = async () => { executions++; return 'tasks'; };
  const output = await ctx.runToolCallLoop({}, conv);
  assert.equal(calls, 2);
  assert.equal(executions, 1);
  assert.equal(output.outcomes.some(item => item.action === 'tool_protocol'), false);
  assert.equal(conv.messages.some(m => /DSML/.test(String(m.content))), true);
  assert.equal(conv.messages.some(m => m._toolRoundCleanText === ''), true);
});

test('DSML response is corrected automatically before the tool chain continues', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  const seenMessages = [];
  let calls = 0;
  let executions = 0;
  ctx.callAiApi = async messages => {
    seenMessages.push(messages);
    calls++;
    if (calls === 1) {
      const dsml = '<｜DSML｜function_calls><｜DSML｜invoke name="list_todos"></｜DSML｜invoke></｜DSML｜function_calls>';
      return result([], dsml);
    }
    if (calls === 2) return result([{ action: 'list_todos', params: {} }], 'query');
    return result([], '已经查看完成。');
  };
  ctx.executeToolCall = async () => { executions++; return 'tasks'; };

  const output = await ctx.runToolCallLoop({}, conv);

  assert.equal(calls, 3);
  assert.equal(executions, 1);
  assert.match(output.finalCleanText, /^已经查看完成。/);
  assert.match(output.finalCleanText, /成功 1 项，失败 1 项/);
  assert.ok(seenMessages[1].some(m => m.role === 'system' && /工具指令格式错误/.test(m.content)));
  assert.equal(conv.messages.some(m => m._malformedToolProtocol && /DSML/.test(String(m.content))), true);
  assert.equal(output.outcomes[0].action, 'tool_protocol');
  assert.equal(output.outcomes[0].status, 'failed');
});

test('repeated malformed tool output uses the ordinary tool-loop limit', async () => {
  const ctx = harness();
  let calls = 0;
  ctx.callAiApi = async () => {
    calls++;
    return result([], '{"action":"quest_create","params":{}}');
  };
  const output = await ctx.runToolCallLoop({}, conversation(ctx));
  assert.equal(calls, 3);
  assert.match(output.finalCleanText, /已达到工具调用轮次上限/);
  assert.equal(output.outcomes.filter(item => item.action === 'tool_protocol' && item.status === 'failed').length, 3);
});

test('pending requests are isolated and legacy entries migrate without storing credentials', () => {
  const ctx = harness();
  ctx.localStorage.setItem('study_ai_pending', JSON.stringify({ convId: 'a', userNodeId: 1 }));
  ctx.setAiPendingRequest('b', 2, 'key-id');
  ctx.clearAiPendingRequest('a');
  assert.equal(ctx.getAiPendingRequests().b.userNodeId, 2);
  assert.equal(Object.keys(ctx.getAiPendingRequests()).length, 1);
  ctx.clearAiPendingRequest('b');
  assert.equal(ctx.localStorage.getItem('study_ai_pending'), null);
});

test('reordered JSON parameters cannot repeat a write within or across rounds', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  let writes = 0;
  let calls = 0;
  ctx.callAiApi = async () => ++calls <= 2 ? result([
    { action: 'add_todo', params: { text: 'one', tags: 'two' } },
    { action: 'add_todo', params: { tags: 'two', text: 'one' } }
  ]) : result();
  ctx.executeToolCall = async () => { writes++; return '✅ saved'; };
  const output = await ctx.runToolCallLoop({}, conv);
  assert.equal(writes, 1);
  assert.equal(output.outcomes.filter(o => o.status === 'duplicate').length, 3);
});

test('dependent tools run sequentially and exceptions are recorded without hiding later results', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  let created = false;
  let calls = 0;
  ctx.callAiApi = async () => ++calls === 1 ? result([
    { action: 'add_todo', params: { text: 'created' } }, { action: 'update_todo', params: { id: 1 } }, { action: 'list_todos', params: {} }
  ]) : result();
  ctx.executeToolCall = async action => {
    if (action === 'add_todo') { await Promise.resolve(); created = true; return '✅ created'; }
    assert.equal(created, true);
    if (action === 'update_todo') throw Error('write failed');
    return 'tasks';
  };
  const output = await ctx.runToolCallLoop({}, conv);
  assert.match(output.finalCleanText, /失败 2 项/);
  assert.deepEqual(Array.from(output.outcomes, o => o.status), ['rolled_back', 'failed', 'success']);
  assert.ok(output.outcomes.every(o => typeof o.callId === 'string' && o.callId.length > 0));
});

test('tool parameters are rejected before a handler can mutate data', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  let executions = 0;
  let calls = 0;
  ctx.callAiApi = async () => ++calls === 1
    ? result([{ action: 'update_todo', params: { id: 'not-a-number', text: 'unsafe' } }])
    : result();
  ctx.executeToolCall = async () => { executions++; return '✅ changed'; };
  const output = await ctx.runToolCallLoop({}, conv);
  assert.equal(executions, 0);
  assert.equal(output.outcomes[0].status, 'failed');
  assert.match(conv.messages.at(-1).content, /结构化状态/);
});

test('tool validation rejects unknown fields, invalid dates and quest dependency cycles', () => {
  const ctx = harness();
  assert.equal(ctx.validateAiToolCall('add_todo', { text: 'x', surprise: true }).ok, false);
  assert.equal(ctx.validateAiToolCall('add_todo', { text: 'x', dueDate: '2026-02-30' }).ok, false);
  ctx.loadTaskLineStore = () => ({
    lines: [{ id: 10 }],
    quests: [{ id: 1, deps: [] }, { id: 2, deps: [1] }]
  });
  assert.equal(ctx.validateAiToolCall('quest_update', { id: 1, deps: [2] }).ok, false);
  assert.equal(ctx.validateAiToolCall('quest_create', { lineId: 10, title: 'new', deps: [999] }).ok, false);
});

test('delete policy (block / confirm / allow) decides whether destructive tools can run', async () => {
  const okResult = { ok: true, status: 'success', text: '✅ deleted', durationMs: 0 };
  async function runWithPolicy(policy, confirmAnswer) {
    const ctx = harness();
    const conv = conversation(ctx);
    if (policy) conv._deletePolicy = policy;
    let calls = 0;
    let executions = 0;
    let asked = 0;
    ctx.callAiApi = async () => ++calls === 1 ? result([{ action: 'delete_todo', params: { id: 1 } }]) : result();
    ctx.executeToolCallStructured = async () => { executions++; return okResult; };
    ctx.sendNotification = (title, body, tag, target) => {
      asked++;
      assert.match(title, /删除操作待确认/);
      assert.equal(target.convId, conv.id);
      setTimeout(() => ctx.resolveAiDeleteConfirmation(conv.id, confirmAnswer), 0);
    };
    const output = await ctx.runToolCallLoop({}, conv);
    return { output, executions, asked };
  }

  // 完全拦截：不询问、不执行，直接失败
  const blocked = await runWithPolicy('block', true);
  assert.equal(blocked.executions, 0);
  assert.equal(blocked.asked, 0);
  assert.equal(blocked.output.outcomes[0].status, 'failed');
  assert.match(blocked.output.outcomes[0].error, /完全拦截删除/);

  // 询问后用户拒绝：不执行
  const declined = await runWithPolicy('confirm', false);
  assert.equal(declined.executions, 0);
  assert.equal(declined.asked, 1);
  assert.equal(declined.output.outcomes[0].status, 'failed');
  assert.match(declined.output.outcomes[0].error, /用户拒绝/);

  // 询问后用户同意：执行
  const approved = await runWithPolicy('confirm', true);
  assert.equal(approved.executions, 1);
  assert.equal(approved.asked, 1);
  assert.equal(approved.output.outcomes[0].status, 'success');

  const bannerCtx = harness();
  const pending = bannerCtx.confirmAiDestructiveCalls(
    [{ tc: { action: 'delete_todo', params: { id: 9 } }, index: 0 }],
    { id: 'banner-conv', title: '测试对话' }
  );
  const bannerHtml = bannerCtx.getAiDeleteConfirmationHtml('banner-conv');
  assert.match(bannerHtml, /AI 请求删除权限/);
  assert.match(bannerHtml, /delete_todo/);
  bannerCtx.resolveAiDeleteConfirmation('banner-conv', false);
  assert.equal((await pending).ok, false);

  // 完全放开：不询问，直接执行
  const allowed = await runWithPolicy('allow', true);
  assert.equal(allowed.executions, 1);
  assert.equal(allowed.asked, 0);
  assert.equal(allowed.output.outcomes[0].status, 'success');
});

test('native function tools use strict schemas and native calls preserve call IDs', () => {
  const ctx = harness();
  const conv = conversation(ctx);
  conv.tree[conv.activePath.at(-1)].content = '创建一个待办';
  conv.messages.at(-1).content = '创建一个待办';
  const built = ctx.buildStreamingRequestBody([], {
    model: 'gpt-5', baseUrl: 'https://api.openai.com/v1', temperature: 0.2
  }, conv);
  const addTodo = built.body.tools.find(tool => tool.function?.name === 'add_todo');
  assert.ok(addTodo);
  assert.equal(addTodo.function.parameters.additionalProperties, false);
  assert.ok(addTodo.function.parameters.required.includes('text'));
  // 默认（未配置）全组开放 + 默认删除策略 confirm：删除类接口照常下发
  assert.equal(built.body.tools.some(tool => tool.function?.name === 'delete_todo'), true);
  assert.equal(built.body.tools.some(tool => tool.function?.name === 'toggle_todo'), false);
  assert.equal(built.body.tools.some(tool => tool.function?.name === 'set_todo_completed'), true);
  // 「完全拦截删除」时删除类接口不下发（含批量删除入口）
  const blockedConv = conversation(ctx);
  blockedConv._deletePolicy = 'block';
  const blockedBuilt = ctx.buildStreamingRequestBody([], {
    model: 'gpt-5', baseUrl: 'https://api.openai.com/v1', temperature: 0.2
  }, blockedConv);
  assert.equal(blockedBuilt.body.tools.some(tool => tool.function?.name === 'delete_todo'), false);
  assert.equal(blockedBuilt.body.tools.some(tool => tool.function?.name === 'batch_update_todos'), false);
  assert.equal(blockedBuilt.body.tools.some(tool => tool.function?.name === 'list_todos'), true);

  const calls = ctx.parseNativeLocalToolCalls([{ id: 'call-123', function: { name: 'add_todo', arguments: '{"text":"read"}' } }]);
  assert.equal(calls[0].action, 'add_todo');
  assert.equal(calls[0].params.text, 'read');
  assert.equal(calls[0].callId, 'call-123');
});

test('tool result budgets cap individual and aggregate context growth', () => {
  const ctx = harness();
  assert.ok(ctx.boundAiToolResult('x'.repeat(20000)).length < 12500);
});

test('consecutive read tools run concurrently while preserving result order', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  ctx.callAiApi = async () => ++calls === 1 ? result([
    { action: 'list_todos', params: {} }, { action: 'list_notes', params: {} }, { action: 'list_links', params: {} }
  ]) : result();
  ctx.executeToolCall = async action => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, action === 'list_todos' ? 12 : 2));
    active--;
    return action;
  };
  await ctx.runToolCallLoop({}, conv);
  assert.equal(maxActive, 3);
  assert.deepEqual(Array.from(conv.messages.at(-1)._toolInfo.results), ['list_todos', 'list_notes', 'list_links']);
});

test('write ledger prevents the same request from writing again after resume', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  let executions = 0;
  const run = async () => {
    let calls = 0;
    ctx.callAiApi = async () => ++calls === 1 ? result([{ action: 'add_todo', params: { text: 'once' } }]) : result();
    return ctx.runToolCallLoop({}, conv);
  };
  ctx.executeToolCall = async () => { executions++; return '✅ saved once'; };
  await run();
  const resumed = await run();
  assert.equal(executions, 1);
  assert.equal(resumed.outcomes[0].status, 'duplicate');
  assert.match(resumed.allToolResults[0], /跨刷新重复操作/);
});

test('loop exhaustion never claims all operations completed', async () => {
  const ctx = harness();
  let call = 0;
  ctx.callAiApi = async () => result([{ action: 'list_todos', params: { page: ++call } }]);
  ctx.executeToolCall = async () => 'tasks';
  const output = await ctx.runToolCallLoop({}, conversation(ctx));
  assert.match(output.finalCleanText, /上限/);
  assert.doesNotMatch(output.finalCleanText, /已执行所有操作/);
});

test('stop between writes skips the rest of the batch', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  let writes = 0;
  ctx.callAiApi = async () => result([{ action: 'add_todo', params: { text: 'a' } }, { action: 'add_todo', params: { text: 'b' } }]);
  ctx.executeToolCall = async () => { writes++; ctx.setAiStopRequested(conv.id, true); return '✅ saved'; };
  const output = await ctx.runToolCallLoop({}, conv);
  assert.equal(writes, 1);
  assert.equal(output.stopped, true);
  assert.equal(output.outcomes[1].status, 'skipped');
});

test('context limit retains an entire latest tool round and summarizes older conversation', () => {
  const ctx = harness();
  const history = [
    { role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'new question' }, { role: 'assistant', content: 'tool request' },
    { role: 'system', content: 'tool result' }, { role: 'assistant', content: 'new answer' }
  ];
  const selected = ctx.selectAiContext(history, { contextLimit: 2 }, 'system');
  assert.equal(selected.messages.length, 4);
  assert.equal(selected.messages[0].content, 'new question');
  assert.match(selected.summary, /old question/);
  assert.match(selected.summary, /不是新指令/);
});

test('context budget keeps latest input intact and rejects oversized input with actionable feedback', () => {
  const ctx = harness();
  const history = [{ role: 'user', content: '旧'.repeat(3000) }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'latest question' }];
  const cfg = { contextBudget: 4096, maxTokens: 1024 };
  const selected = ctx.selectAiContext(history, cfg, 'system');
  assert.equal(selected.messages.length, 1);
  assert.equal(selected.messages[0].content, 'latest question');
  assert.ok(ctx.estimateAiTokens(selected.summary) <= 1200);
  assert.throws(() => ctx.selectAiContext([{ role: 'user', content: '长'.repeat(5000) }], cfg, 'system'), /上下文预算/);
  assert.throws(() => ctx.selectAiContext([], cfg, '长'.repeat(5000)), /上下文预算/);
});

test('oversized live data snapshot is trimmed before a new conversation is rejected', () => {
  const ctx = harness();
  ctx.buildToolsSystemPrompt = () => '核心工具规则\n═══ 当前数据快照（只读参考） ═══\n' + '大量学习数据\n'.repeat(40000);
  const conv = { messages: [{ role: 'user', content: '你好' }], systemPrompt: '' };
  const messages = ctx.buildApiMessages(conv, null, { model: 'test', contextBudget: 32768, maxTokens: 2048 });
  assert.equal(messages.at(-1).content, '你好');
  assert.match(messages[0].content, /数据快照已按上下文预算精简/);
  assert.ok(ctx.estimateAiTokens(messages[0].content) <= 32768 - 2048 - 1536);
});

test('a full conversation system prompt override replaces the built-in prompt', () => {
  const ctx = harness();
  const conv = { messages: [{ role: 'user', content: '你好' }], systemPrompt: '当前对话专属系统提示词', systemPromptMode: 'full' };
  const messages = ctx.buildApiMessages(conv, null, { model: 'test', contextBudget: 32768, maxTokens: 2048 });
  assert.equal(messages[0].content, '当前对话专属系统提示词');
});

test('a legacy custom role is still appended to the built-in prompt', () => {
  const ctx = harness();
  const conv = { messages: [], systemPrompt: '请使用简洁语气', _webSearchMode: 'native' };
  const messages = ctx.buildApiMessages(conv, null, { model: 'test', contextBudget: 32768, maxTokens: 2048 });
  assert.match(messages[0].content, /^model=test;search=native/);
  assert.match(messages[0].content, /【用户自定义角色】请使用简洁语气$/);
});

test('context errors do not incorrectly blame API keys or network', () => {
  const ctx = harness();
  const text = ctx.formatAiRequestError(new Error('当前问题超过上下文预算'));
  assert.match(text, /更多设置/);
  assert.doesNotMatch(text, /API Key|网络连接/);
});

test('regeneration retains completed tool results when a subsequent request fails', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  const userId = conv.activePath.at(-1);
  let calls = 0;
  ctx.callAiApi = async () => {
    if (++calls === 1) return result([{ action: 'add_todo', params: { text: 'saved' } }]);
    throw Error('connection lost');
  };
  ctx.executeToolCall = async () => '✅ saved';
  await ctx.regenerateFromUserNode(conv, userId);
  assert.equal(conv.messages.at(-2).role, 'system');
  assert.match(conv.messages.at(-2).content, /saved/);
  assert.match(conv.messages.at(-1).content, /connection lost/);
});

test('native tool call IDs survive history construction and display names are not sent as API names', () => {
  const ctx = harness();
  const tool = { id: 'call-1', type: 'function', function: { name: '$web_search', arguments: '{}' } };
  const conv = { messages: [{ role: 'user', content: 'search' }, { role: 'assistant', content: '', tool_calls: [tool], keyName: '中文 Key 名称' }, { role: 'tool', content: '{}', tool_call_id: 'call-1' }] };
  const messages = ctx.buildApiMessages(conv, null, { model: 'kimi' });
  assert.equal(messages.at(-1).tool_call_id, 'call-1');
  assert.equal(messages.at(-2).tool_calls[0].id, 'call-1');
  assert.equal(messages.at(-2).name, undefined);
});

test('DeepSeek thinking history echoes reasoning_content for every assistant turn', () => {
  const ctx = harness();
  const conv = {
    messages: [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer', reasoning: 'full first reasoning' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'second answer' }
    ],
    systemPrompt: ''
  };
  const cfg = { model: 'deepseek-flash', deepThink: true, contextBudget: 32768, maxTokens: 2048 };
  const assistants = ctx.buildApiMessages(conv, null, cfg).filter(message => message.role === 'assistant');
  assert.equal(assistants[0].reasoning_content, 'full first reasoning');
  assert.equal(assistants[1].reasoning_content, '');
});

test('reasoning_content is omitted outside DeepSeek thinking mode', () => {
  const ctx = harness();
  const conv = { messages: [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'answer', reasoning: 'private reasoning' }], systemPrompt: '' };
  const disabled = ctx.buildApiMessages(conv, null, { model: 'deepseek-flash', deepThink: false });
  const other = ctx.buildApiMessages(conv, null, { model: 'other-model', deepThink: true });
  assert.equal(Object.hasOwn(disabled.at(-1), 'reasoning_content'), false);
  assert.equal(Object.hasOwn(other.at(-1), 'reasoning_content'), false);
});

test('model capability checks use supplied configuration rather than active selection', () => {
  const ctx = harness();
  ctx.getEffectiveApiConfig = () => ({ model: 'kimi' });
  assert.equal(ctx.isKimiModel({ model: 'other' }), false);
  const { body } = ctx.buildStreamingRequestBody([], { model: 'other', temperature: 0.5 });
  assert.equal(body.temperature, 0.5);
  assert.equal(body.max_tokens, 2048);
});

test('single reminders default to once and roll the next occurrence over local midnight', () => {
  const ctx = harness();
  const schedule = ctx.normalizeAutomationSchedule({ at: '08:00' }, new Date(2026, 8, 11, 23, 0));
  assert.equal(schedule.repeat, 'once');
  assert.equal(schedule.date, '2026-09-12');
});

test('reminders reject invalid times, impossible dates and past dates', () => {
  const ctx = harness();
  const now = new Date(2026, 8, 11, 12, 0);
  for (const params of [{ at: '25:00' }, { at: '12:99' }, { at: '15:00', date: '2026-02-30' }, { at: '08:00', date: '2026-09-11' }]) {
    assert.ok(ctx.normalizeAutomationSchedule(params, now).error);
  }
});

test('future one-time reminders do not fire early and overdue reminders catch up once', () => {
  const ctx = harness();
  const auto = { repeat: 'once', date: '2026-09-12', at: '08:00', enabled: true };
  assert.equal(ctx.isAutomationDue(auto, new Date(2026, 8, 11, 8, 0)), false);
  assert.equal(ctx.isAutomationDue(auto, new Date(2026, 8, 12, 9, 0)), true);
  auto.enabled = false;
  assert.equal(ctx.isAutomationDue(auto, new Date(2026, 8, 13, 9, 0)), false);
});

test('daily reminders respect last run date and legacy one-time schedules remain supported', () => {
  const ctx = harness();
  const now = new Date(2026, 8, 11, 9, 0);
  assert.equal(ctx.isAutomationDue({ repeat: 'daily', at: '08:00', lastRun: '2026-09-11 08:00' }, now), false);
  assert.equal(ctx.isAutomationDue({ repeat: 'once', at: '09:00' }, now), true);
});

test('reminder writes retain origin conversation, date and source and deduplicate across requests', async () => {
  const ctx = harness();
  const conv = conversation(ctx);
  const params = { at: '09:00', date: '2099-09-12', prompt: '交作业', reason: '用户要求明天提醒' };
  await ctx.executeToolCall('schedule_automation', params, { conv });
  await ctx.executeToolCall('schedule_automation', params, { conv });
  assert.equal(ctx.automations.length, 1);
  assert.equal(ctx.automations[0].convId, 'background');
  assert.equal(ctx.automations[0].repeat, 'once');
  assert.equal(ctx.automations[0].date, '2099-09-12');
  assert.equal(ctx.automations[0].sourceText, 'question');
});

// ═══════════ 图片（视觉）附件适配 ═══════════

test('PDF attachments are accepted for every model and expose user-selectable local modes', () => {
  const ctx = harness();
  const pdf = { name: '讲义.pdf', type: 'application/pdf', size: 1024 };
  const alerts = [];
  ctx.renderAttachPreview = () => {};
  ctx.alert = message => alerts.push(message);
  ctx.getEffectiveApiConfig = () => ({ apiKey: 'fake', model: 'deepseek-v4-pro' });
  ctx.setAiAttachments([]);
  ctx.addAiAttachmentFiles([pdf]);
  let attach = ctx.getAiAttachments()[0];
  assert.equal(ctx.isPdfFile(pdf), true);
  assert.equal(attach.pdfMode, 'text');
  assert.equal(attach.pdfStartPage, null);
  assert.equal(attach.pdfEndPage, null);

  ctx.updateAttachPdfRange(0, 'start', '3');
  ctx.updateAttachPdfRange(0, 'end', '8');
  attach = ctx.getAiAttachments()[0];
  assert.equal(attach.pdfStartPage, 3);
  assert.equal(attach.pdfEndPage, 8);

  // 非视觉模型仍可提取文字，但不能误选页面图片。
  ctx.toggleAttachPdfMode(0);
  assert.equal(ctx.getAiAttachments()[0].pdfMode, 'text');
  assert.equal(alerts.length, 1);

  // 切换到视觉模型后，用户可在两种模式之间切换。
  ctx.getEffectiveApiConfig = () => ({ apiKey: 'fake', model: 'deepseek-flash' });
  ctx.toggleAttachPdfMode(0);
  attach = ctx.getAiAttachments()[0];
  assert.equal(attach.pdfMode, 'image');
  ctx.toggleAttachPdfMode(0);
  assert.equal(ctx.getAiAttachments()[0].pdfMode, 'text');

  // PDF 不再沿用普通附件的 20MB 客户端限制，实际能力由本地内存或服务端决定。
  ctx.setAiAttachments([]);
  ctx.addAiAttachmentFiles([{ name: '大型讲义.pdf', type: 'application/pdf', size: 250 * 1024 * 1024 }]);
  assert.equal(ctx.getAiAttachments().length, 1);
  assert.equal(alerts.length, 1); // 仅保留前面非视觉模型切换页面图片时的提示
});

test('PDF text mode extracts page-labelled text and reports truncation', async () => {
  const ctx = harness();
  let destroyed = false;
  const pageTexts = [['第一页', ' 内容'], [], ['第三页很长的内容']];
  ctx.openPdfAttachment = async () => ({
    pdf: {
      numPages: pageTexts.length,
      async getPage(pageNo) {
        return { async getTextContent() { return { items: pageTexts[pageNo - 1].map(str => ({ str })) }; } };
      },
      async destroy() { destroyed = true; }
    }
  });
  const full = await ctx.extractPdfAttachmentText({}, { maxChars: 200 });
  assert.match(full.text, /\[第 1 页\]\n第一页 内容/);
  assert.doesNotMatch(full.text, /第 2 页/);
  assert.match(full.text, /\[第 3 页\]/);
  assert.equal(full.textPageCount, 2);
  assert.equal(full.truncated, false);
  assert.equal(destroyed, true);

  const short = await ctx.extractPdfAttachmentText({}, { maxChars: 15 });
  assert.equal(short.truncated, true);

  const selected = await ctx.extractPdfAttachmentText({}, { startPage: 2, endPage: 3, maxChars: 200 });
  assert.doesNotMatch(selected.text, /第 1 页/);
  assert.match(selected.text, /第 3 页/);
  assert.equal(selected.startPage, 2);
  assert.equal(selected.endPage, 3);
});

test('PDF image mode renders ordered JPEG pages and caps oversized documents', async () => {
  const ctx = harness();
  let destroyed = false;
  const rendered = [];
  ctx.openPdfAttachment = async () => ({
    pdf: {
      numPages: 4,
      async getPage(pageNo) {
        return {
          getViewport({ scale }) { return { width: 800 * scale, height: 1000 * scale }; },
          render() { rendered.push(pageNo); return { promise: Promise.resolve() }; }
        };
      },
      async destroy() { destroyed = true; }
    }
  });
  ctx.document.createElement = () => ({
    width: 0, height: 0,
    getContext: () => ({ fillRect() {} })
  });
  ctx.canvasToBlob = async canvas => ({ width: canvas.width, height: canvas.height });
  let imageNo = 0;
  ctx.blobToDataUrl = async () => `data:image/jpeg;base64,page-${++imageNo}`;
  const output = await ctx.renderPdfAttachmentPages({}, { maxPages: 2, maxWidth: 1600 });
  assert.deepEqual(rendered, [1, 2]);
  assert.equal(output.dataUrls.length, 2);
  assert.equal(output.pageCount, 4);
  assert.equal(output.renderedPages, 2);
  assert.equal(output.truncated, true);
  assert.equal(destroyed, true);

  rendered.length = 0;
  const selected = await ctx.renderPdfAttachmentPages({}, { startPage: 2, endPage: 3, maxPages: 24, maxWidth: 1600 });
  assert.deepEqual(rendered, [2, 3]);
  assert.deepEqual(Array.from(selected.pageNumbers), [2, 3]);
  assert.equal(selected.truncated, false);
});

// 逐页渲染是主线程重活：必须逐页回报进度，并且能在页间被取消，
// 否则用户只会看到"点了发送界面卡住"。
test('PDF image mode reports per-page progress and stops between pages when cancelled', async () => {
  const ctx = harness();
  const rendered = [];
  const installCanvas = () => {
    ctx.document.createElement = () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {} }) });
    ctx.canvasToBlob = async canvas => ({ width: canvas.width, height: canvas.height, size: 1000 });
    ctx.blobToDataUrl = async () => 'data:image/jpeg;base64,page';
  };
  const pdfStub = pages => ({
    pdf: {
      numPages: pages,
      async getPage(pageNo) {
        return {
          getViewport({ scale }) { return { width: 800 * scale, height: 1000 * scale }; },
          render() { rendered.push(pageNo); return { promise: Promise.resolve() }; }
        };
      },
      async destroy() {}
    }
  });

  // 进度：每渲染完一页回调一次，顺序与页码一致，并回报最终体积与耗时。
  installCanvas();
  ctx.openPdfAttachment = async () => pdfStub(3);
  const progress = [];
  const done = await ctx.renderPdfAttachmentPages({}, {
    maxPages: 3,
    onPage: info => progress.push(`${info.done}/${info.total}@${info.pageNo}`)
  });
  assert.deepEqual(progress, ['1/3@1', '2/3@2', '3/3@3']);
  assert.equal(done.aborted, false);
  assert.equal(done.renderedPages, 3);
  assert.equal(done.bytes, 3000);
  assert.equal(typeof done.ms, 'number');

  // 取消：在第 2 页完成之后中断，不产生第 3 页，并标记 aborted 以便调用方放弃该附件。
  installCanvas();
  rendered.length = 0;
  let abortFlag = false;
  ctx.openPdfAttachment = async () => pdfStub(3);
  const stopped = await ctx.renderPdfAttachmentPages({}, {
    maxPages: 3,
    onPage: info => { if (info.done === 2) abortFlag = true; },
    isAborted: () => abortFlag
  });
  assert.deepEqual(rendered, [1, 2]);
  assert.equal(stopped.aborted, true);
  assert.equal(stopped.renderedPages, 2);
  assert.deepEqual(Array.from(stopped.pageNumbers), [1, 2]);
});

// 预览徽标是"为什么慢"的唯一可见线索，必须如实反映渲染中/已完成/已取消与体积。
test('PDF attachment preview badge reports rendering progress, size and cancellation', () => {
  const ctx = harness();
  ctx.escapeHtml = value => String(value == null ? '' : value);
  const badges = {
    rendering: ctx.formatPdfAttachStatus({ _pdfRender: { rendering: true, done: 6, total: 12 } }, 2),
    done: ctx.formatPdfAttachStatus({ _pdfRender: { rendering: false, done: 3, total: 3, bytes: 2 * 1024 * 1024, ms: 2400 } }, 0),
    capped: ctx.formatPdfAttachStatus({ _pdfRender: { rendering: false, done: 12, total: 12, truncated: true, selectedPages: 40, bytes: 1024, ms: 900 } }, 1),
    aborted: ctx.formatPdfAttachStatus({ _pdfRender: { rendering: false, aborted: true, done: 2, total: 12 } }, 1),
    none: ctx.formatPdfAttachStatus({}, 0)
  };
  assert.match(badges.rendering, /渲染中 6\/12/);
  assert.match(badges.rendering, /aiPdfRenderStatus2/);
  assert.match(badges.rendering, /width:50%/);
  assert.match(badges.done, /本次发 3 页/);
  assert.match(badges.done, /2\.0MB/);
  assert.match(badges.done, /2\.4s/);
  assert.match(badges.capped, /所选 40 页超出单次上限/);
  assert.match(badges.aborted, /已取消（2\/12 页）/);
  // 无状态时返回一个隐藏的空容器：它是实时更新的挂载点，不能整个省掉。
  assert.match(badges.none, /id="aiPdfRenderStatus0"/);
  assert.match(badges.none, /preview-render-status idle/);
  assert.equal(badges.none.replace(/<[^>]*>/g, '').trim(), '');

  // 逐页进度写回附件对象，徽标随下一帧显示最新页数。
  ctx.setAiAttachments([{ name: '讲义.pdf', _pdfRender: { rendering: true, done: 1, total: 4 } }]);
  ctx.updatePdfRenderStatus(0, { rendering: true, done: 2, total: 4 });
  assert.deepEqual(ctx.getAiAttachments()[0]._pdfRender, { rendering: true, done: 2, total: 4 });
  ctx.updatePdfRenderStatus(0, { rendering: false, aborted: true });
  assert.deepEqual(ctx.getAiAttachments()[0]._pdfRender, { rendering: false, done: 2, total: 4, aborted: true });
  ctx.updatePdfRenderStatus(9, { rendering: true, done: 1, total: 4 }); // 越界索引不应抛错
});

// 发送路径必须把进度回调 / 取消判断真正接到渲染上，否则界面上什么都看不到。
test('sending a PDF in page-image mode wires progress callbacks and drops a cancelled attachment', async () => {
  const sendHarness = async ({ apiKeyId, pieces, stopAfter }) => {
    const ctx = harness();
    let renderCalls = 0;
    let renderOpts = null;
    let sawAbort = false;
    const doc = {
      getElementById: id => (id === 'aiInput' ? { value: '看看这几页', style: {} } : null),
      addEventListener() {},
      createElement: () => ({ getContext: () => ({ fillRect() {} }) })
    };
    ctx.document = doc;
    ctx.getActiveConv = () => ctx.__conv;
    ctx.getActiveConvId = () => ctx.__conv.id;
    ctx.getAiAttachmentsSnapshot = () => ctx.getAiAttachments();
    ctx.renderAiMessages = () => {};
    ctx.clearAiDraft = () => {};
    ctx.openSettingsModal = () => {};
    ctx.updateAiSendButton = () => {};
    ctx.runToolCallLoop = async () => ({ finalCleanText: '收到', finalRawReply: '收到', stopped: false, finishReason: 'stop' });
    ctx.parseMemoryTags = () => {};
    const conv = { id: 'conv-pdf', title: '已有标题', systemPrompt: '' };
    ctx.initTreeOnConv(conv);
    ctx.__conv = conv;

    const file = { name: '讲义.pdf', type: 'application/pdf', size: 4096 };
    const attach = { name: file.name, file, size: file.size, pdfMode: 'image', pdfStartPage: null, pdfEndPage: null };
    ctx.setAiAttachments([attach]);

    // 用桩替换逐页渲染，只验证发送路径是否把进度回调 / 取消判断接上，以及取消后附件是否被丢弃。
    // 真实渲染函数的进度与取消行为由上面的 renderPdfAttachmentPages 单测覆盖。
    ctx.renderPdfAttachmentPages = async (f, opts) => {
      renderCalls++;
      renderOpts = opts;
      for (let pageNo = 1; pageNo <= pieces; pageNo++) {
        if (typeof opts.isAborted === 'function' && opts.isAborted()) {
          sawAbort = true;
          return { dataUrls: [], pageCount: 40, renderedPages: pageNo - 1, pageNumbers: [], truncated: false, aborted: true, startPage: 1, endPage: 24, selectedPages: 24 };
        }
        if (typeof opts.onPage === 'function') opts.onPage({ done: pageNo, total: pieces, pageNo });
      }
      return { dataUrls: ['data:image/jpeg;base64,x'], pageCount: 40, renderedPages: pieces, pageNumbers: [1], truncated: true, aborted: false, startPage: 1, endPage: 24, selectedPages: 24 };
    };

    if (stopAfter) {
      const baseStub = ctx.renderPdfAttachmentPages;
      ctx.renderPdfAttachmentPages = async (f, opts) => {
        const stopAt = stopAfter;
        const wrapped = Object.assign({}, opts, {
          onPage: info => {
            if (typeof opts.onPage === 'function') opts.onPage(info);
            if (info.done >= stopAt) ctx.setAiStopRequested(conv.id, true);
          }
        });
        return baseStub(f, wrapped);
      };
    }
    if (apiKeyId) ctx.getEffectiveApiConfig = () => ({ apiKey: 'fake', keyId: apiKeyId, name: '视觉', model: 'deepseek-flash' });

    let sendError = null;
    // 与界面一致：不带参数调用，正文与附件都取自编辑器状态
    try { await ctx.sendAiMessage(); } catch (e) { sendError = String(e && e.stack || e); }
    const userMsg = conv.messages.find(m => m.role === 'user' && m.content.includes('看看这几页'));
    return {
      userMsg,
      renderCalls,
      renderOpts,
      sawAbort,
      sendError,
      msgRoles: conv.messages.map(m => m.role).join(',')
    };
  };

  // 正常：渲染出的页面进入 visionFiles，并提示受上限截断。
  const ok = await sendHarness({ apiKeyId: 'visual', pieces: 3 });
  assert.equal(ok.sendError, null, 'sendAiMessage 抛错: ' + ok.sendError);
  assert.equal(ok.renderCalls, 1, 'PDF 渲染未被调用');
  // 渲染必须同时拿到进度回调与取消判断，否则界面既无进度也无法中断。
  assert.equal(typeof ok.renderOpts.onPage, 'function');
  assert.equal(typeof ok.renderOpts.isAborted, 'function');
  assert.equal(ok.userMsg.visionFiles.length, 1);
  assert.match(ok.userMsg.visionFiles[0].name, /PDF 第 1\/40 页/);
  assert.match(ok.userMsg.content, /受上限限制本次发送 3 页/);

  // 取消：不发送半份页面，只在正文里说明，附件图片不进入请求。
  const cancelled = await sendHarness({ apiKeyId: 'visual', pieces: 12, stopAfter: 2 });
  assert.equal(cancelled.sawAbort, true, '取消信号未传到渲染循环');
  assert.equal(cancelled.userMsg.visionFiles, undefined);
  assert.match(cancelled.userMsg.content, /页面渲染已取消，本次未发送/);
});

test('deepseek-flash counts as an image-capable model while deepseek-v4-pro does not', () => {
  const ctx = harness();
  // 官方文档：deepseek-flash（DeepSeek-V4.1-Flash）图像理解支持；deepseek-v4-pro 不支持
  for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    assert.equal(ctx.modelSupportsVision({ model }), true, model);
    assert.equal(ctx.isMultimodalModel({ model }), true, model);
  }
  // Kimi 走独立分支（文件上传 / OCR），不依赖 vision 关键词
  assert.equal(ctx.modelSupportsVision({ model: 'kimi-k2' }), false);
  assert.equal(ctx.isMultimodalModel({ model: 'kimi-k2' }), true);
  assert.equal(ctx.isKimiModel({ model: 'kimi-k2' }), true);
  for (const model of ['deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner', 'gpt-3.5-turbo', '']) {
    assert.equal(ctx.modelSupportsVision({ model }), false, model);
    assert.equal(ctx.isVisionModel({ model }), false, model);
    assert.equal(ctx.isMultimodalModel({ model }), false, model);
  }
});

test('image attachments are accepted for deepseek-flash and preprocessed to an inline data URL', async () => {
  const ctx = harness();
  const png = { name: 'preprocess-me.png', type: 'image/png', size: 11 };
  const exe = { name: 'reject-me.exe', type: 'application/octet-stream', size: 2 };
  const alerts = [];
  ctx.setAiAttachments([]);
  ctx.renderAttachPreview = () => {};
  ctx.alert = message => alerts.push(message);
  ctx.isDebugMode = () => false;
  ctx.getEffectiveApiConfig = () => ({ apiKey: 'fake', model: 'deepseek-flash' });
  ctx.downscaleImageForApi = async file => ({
    file,
    dataUrl: 'data:image/png;base64,AAAA',
    info: { width: 8, height: 8, format: 'png', converted: false, resized: false, original: true }
  });
  ctx.addAiAttachmentFiles([png, exe]);
  // 视觉模型：图片放行，可执行文件等非文本附件仍被拒
  assert.equal(ctx.isMultimodalModel({ model: 'deepseek-flash' }), true);
  assert.equal(ctx.isTextFile(png), false);
  assert.deepEqual(Array.from(ctx.getAiAttachments(), a => a.name), ['preprocess-me.png']);
  assert.equal(alerts.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  const attach = ctx.getAiAttachments()[0];
  assert.equal(attach.dataUrl, 'data:image/png;base64,AAAA');
  assert.equal(attach.imageProcessing, false);
  assert.equal(attach.imageInfo.format, 'png');
});

test('very tall images are split into ordered API-safe parts without shrinking document text to thumbnail size', async () => {
  const ctx = harness();
  const draws = [];
  let closed = false;
  ctx.decodeImageBitmap = async () => ({
    bitmap: { width: 1782, height: 15888, close() { closed = true; } },
    revoke: false
  });
  ctx.document.createElement = tag => {
    assert.equal(tag, 'canvas');
    return {
      width: 0,
      height: 0,
      getContext: () => ({ fillRect() {}, drawImage: (...args) => draws.push(args) })
    };
  };
  ctx.canvasToBlob = async canvas => ({ width: canvas.width, height: canvas.height });
  ctx.blobToDataUrl = async blob => `data:image/png;base64,${blob.width}x${blob.height}`;

  const output = await ctx.splitTallImageForApi({ name: '教材长图.png' });
  assert.equal(output.dataUrls.length, 8);
  assert.equal(output.info.sourceWidth, 1782);
  assert.equal(output.info.sourceHeight, 15888);
  assert.equal(output.info.width, 1782);
  assert.equal(output.info.parts, 8);
  assert.equal(draws.length, 8);
  assert.equal(draws[0][2], 0); // 第一段从图片顶部开始
  assert.equal(draws[1][2], 2048); // 第二段紧接第一段，保持阅读顺序
  assert.equal(closed, true);
});

test('Kimi image attachments use the same local preprocessing pipeline as other vision models', async () => {
  const ctx = harness();
  let processed = 0;
  ctx.getEffectiveApiConfig = () => ({ apiKey: 'fake', model: 'kimi-k2' });
  ctx.preprocessAiImageAttachment = attach => {
    processed++;
    attach._processPromise = Promise.resolve(attach);
    return attach._processPromise;
  };
  ctx.renderAttachPreview = () => {};
  ctx.addAiAttachmentFiles([{ name: 'long.png', type: 'image/png', size: 1024 }]);
  assert.equal(processed, 1);
});

test('inline images are sent as base64 image_url blocks for the vision model', () => {
  const ctx = harness();
  const conv = { id: 'foreground', messages: [], systemPrompt: '' };
  ctx.initTreeOnConv(conv);
  ctx.appendMessage(conv, {
    role: 'user',
    content: '这张图里有什么？',
    time: '2026-09-13 10:00',
    attachments: [{ name: 'shot.png', size: 12 }],
    visionFiles: [{ type: 'image_url', name: 'shot.png', dataUrl: 'data:image/png;base64,AAAA' }]
  });
  const cfg = { apiKey: 'fake', model: 'deepseek-flash', contextLimit: 20, contextBudget: 32768 };
  const messages = ctx.buildApiMessages(conv, null, cfg);
  const userMessage = messages[messages.length - 1];
  assert.equal(userMessage.role, 'user');
  assert.equal(Array.isArray(userMessage.content), true);
  assert.equal(userMessage.content[0].type, 'text');
  assert.match(userMessage.content[0].text, /^\[当前时间：2026-09-13 10:00\]/);
  // 内容块来自 VM realm，逐字段断言而非 deepEqual
  assert.equal(userMessage.content[1].type, 'image_url');
  assert.equal(userMessage.content[1].image_url.url, 'data:image/png;base64,AAAA');
  // 非视觉模型不携带图片块，只保留文本（避免服务端 400）
  const plain = ctx.buildApiMessages(conv, null, { apiKey: 'fake', model: 'deepseek-v4-pro', contextLimit: 20, contextBudget: 32768 });
  assert.equal(typeof plain[plain.length - 1].content, 'string');
});

test('legacy oversized PNG images are omitted from later requests instead of poisoning the conversation forever', () => {
  const ctx = harness();
  ctx.atob = atob;
  // PNG signature + IHDR length/type + width=1782 + height=15888，后续 CRC/像素无需读取。
  const header = Buffer.from([
    0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, 0,0,0,13, 0x49,0x48,0x44,0x52,
    0,0,0x06,0xf6, 0,0,0x3e,0x10, 8,2,0,0,0
  ]).toString('base64');
  const dataUrl = 'data:image/png;base64,' + header;
  const inspected = ctx.inspectInlineImageForApi(dataUrl);
  assert.equal(inspected.ok, false);
  assert.equal(inspected.width, 1782);
  assert.equal(inspected.height, 15888);

  const conv = { messages: [{ role: 'user', content: '旧图片', visionFiles: [{ type: 'image_url', name: 'old.png', dataUrl }] }], systemPrompt: '' };
  const messages = ctx.buildApiMessages(conv, null, { apiKey: 'fake', model: 'deepseek-flash', contextLimit: 20, contextBudget: 32768 });
  const content = messages.at(-1).content;
  assert.equal(content.some(part => part.type === 'image_url'), false);
  assert.match(content[0].text, /历史图片.+已跳过/);
});

test('a file_id from a previously rejected image message is removed from later conversation history', () => {
  const ctx = harness();
  const conv = {
    messages: [
      {
        role: 'user', content: '分析旧长图',
        visionFiles: [{ type: 'file', fileId: 'file-api-bad-long-image', name: 'old.png', dataUrl: 'data:image/jpeg;base64,AAAA' }]
      },
      { role: 'assistant', content: '❌ 图片发送失败：.messages[1].image[0]: You have uploaded an unsupported image.' },
      { role: 'user', content: '分析这次新上传的图片', visionFiles: [{ type: 'image_url', name: 'new.jpg', dataUrl: 'data:image/jpeg;base64,AAAA' }] }
    ],
    systemPrompt: ''
  };
  const messages = ctx.buildApiMessages(conv, null, { apiKey: 'fake', model: 'deepseek-flash', contextLimit: 20, contextBudget: 32768 });
  const oldMessage = messages.find(message => typeof message.content === 'string' && message.content.includes('分析旧长图'));
  assert.ok(oldMessage);
  assert.match(oldMessage.content, /不再重复发送/);
  assert.equal(JSON.stringify(messages).includes('file-api-bad-long-image'), false);
  const currentMessage = messages.at(-1);
  assert.equal(currentMessage.content.some(part => part.type === 'image_url'), true);
});

test('oversized inline images are dropped from the pending attachments before sending', () => {
  const ctx = harness();
  // Blob.size 只读，用同形状的普通对象模拟 File 即可（代码只读 name/type/size）
  const huge = { name: 'huge.png', type: 'image/png', size: 25 * 1024 * 1024 }; // 内联后约 34MB > 20MB 上限
  const small = { name: 'small.png', type: 'image/png', size: 1024 };
  const pending = [{ name: huge.name, file: huge, size: huge.size }, { name: small.name, file: small, size: small.size }];
  ctx.setAiAttachments(pending.slice());
  ctx.renderAttachPreview = () => {};
  const snapshot = pending.slice();
  const dropped = ctx.pruneOversizedImageAttachments(snapshot, { model: 'deepseek-flash' });
  // 返回被剔除的文件名，并清掉编辑器里的待发附件（sendAiMessage 再按名单过滤自己的快照）
  assert.deepEqual(Array.from(dropped), ['huge.png']);
  assert.deepEqual(Array.from(ctx.getAiAttachments(), a => a.name), ['small.png']);
  const kept = snapshot.filter(a => dropped.indexOf(a.name) < 0);
  assert.deepEqual(Array.from(kept, a => a.name), ['small.png']);
});

test('raw request logs keep a placeholder instead of the whole inline image', () => {
  const ctx = harness();
  const huge = 'data:image/png;base64,' + 'A'.repeat(200000);
  const redacted = ctx.redactInlineImages([
    { type: 'text', text: '这张图里有什么？' },
    { type: 'image_url', image_url: { url: huge } }
  ]);
  assert.equal(redacted[0].text, '这张图里有什么？');
  assert.match(redacted[1].image_url.url, /^<内联图片 image\/png，约 \d+KB>$/);
  assert.ok(redacted[1].image_url.url.length < 60);
  // 纯文本消息原样返回，不产生额外对象
  assert.equal(ctx.redactInlineImages('普通文本'), '普通文本');
});

// ═══════════ DeepSeek Files API：图片上传一次后按 file_id 复用 ═══════════

test('files api strategy applies to deepseek only and by size threshold', () => {
  const ctx = harness();
  const image = size => ({ name: 'photo.jpg', type: 'image/jpeg', size });
  const ds = { apiKey: 'k', keyId: 'key1', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' };
  const other = { apiKey: 'k', model: 'deepseek-flash', baseUrl: 'https://gateway.example.com/v1' };
  assert.equal(ctx.supportsDeepSeekFilesApi(ds), true);
  assert.equal(ctx.supportsDeepSeekFilesApi(other), false); // 非官方端点不保证有 Files API
  assert.equal(ctx.supportsDeepSeekFilesApi({ model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com' }), false);
  // auto（默认）：小图内联、大图上传
  assert.equal(ctx.shouldUploadImageToFiles({ file: image(300 * 1024), size: 300 * 1024 }, ds), false);
  assert.equal(ctx.shouldUploadImageToFiles({ file: image(4 * 1024 * 1024), size: 4 * 1024 * 1024 }, ds), true);
  assert.equal(ctx.shouldUploadImageToFiles({ file: image(4 * 1024 * 1024), size: 4 * 1024 * 1024 }, other), false);
  // 用户设置：always / never
  ctx.setAiImageUploadMode('always');
  assert.equal(ctx.shouldUploadImageToFiles({ file: image(1024), size: 1024 }, ds), true);
  ctx.setAiImageUploadMode('never');
  assert.equal(ctx.shouldUploadImageToFiles({ file: image(4 * 1024 * 1024), size: 4 * 1024 * 1024 }, ds), false);
  ctx.setAiImageUploadMode('auto');
  // 已上传过的附件不重复判定上传；非图片文件一律不走 Files API
  assert.equal(ctx.shouldUploadImageToFiles({ file: image(4 * 1024 * 1024), size: 4 * 1024 * 1024, uploadFileId: 'file-api-x', uploadKeyId: 'key1' }, ds), false);
  assert.equal(ctx.shouldUploadImageToFiles({ file: { name: 'a.txt', type: 'text/plain', size: 4 * 1024 * 1024 }, size: 4 * 1024 * 1024 }, ds), false);
  // 超过 64 MiB 的图片上传也会失败 → 交给内联路径处理
  assert.equal(ctx.shouldUploadImageToFiles({ file: image(70 * 1024 * 1024), size: 70 * 1024 * 1024 }, ds), false);
});

test('uploaded images are reused by file_id within the same api key only', () => {
  const ctx = harness();
  const cfg = { keyId: 'key1', model: 'deepseek-flash' };
  const fingerprint = 'sha256-photo-content';
  ctx.aiConvs = [{
    id: 'c1',
    messages: [
      { role: 'user', content: '看图', attachments: [{ name: 'photo.jpg', size: 10 }], visionFiles: [
        { type: 'file', fileId: 'file-api-abc', uploadKeyId: 'key1', imageFingerprint: fingerprint, name: 'photo.jpg', dataUrl: 'data:image/jpeg;base64,TINY' }
      ] }
    ]
  }];
  const hit = ctx.findReusableUploadedImage({ name: 'photo.jpg', imageFingerprint: fingerprint }, cfg);
  assert.equal(hit.fileId, 'file-api-abc');
  assert.equal(hit.thumb, 'data:image/jpeg;base64,TINY');
  // 同名但内容不同、或旧记录没有指纹，都不得复用。
  assert.equal(ctx.findReusableUploadedImage({ name: 'photo.jpg', imageFingerprint: 'different-content' }, cfg), null);
  assert.equal(ctx.findReusableUploadedImage({ name: 'photo.jpg' }, cfg), null);
  // 换了 API Key → 归属不同，不能复用
  assert.equal(ctx.findReusableUploadedImage({ name: 'photo.jpg', imageFingerprint: fingerprint }, { keyId: 'key2', model: 'deepseek-flash' }), null);
  assert.equal(ctx.collectReferencedFileIds().has('file-api-abc'), true);
});

test('file_id references and tiny thumbnails are sent as separate content blocks', () => {
  const ctx = harness();
  const conv = { id: 'foreground', messages: [], systemPrompt: '' };
  ctx.initTreeOnConv(conv);
  ctx.appendMessage(conv, {
    role: 'user',
    content: '这张图里有什么？',
    time: '2026-09-13 11:00',
    attachments: [{ name: 'photo.jpg', size: 10, displayUrl: 'data:image/jpeg;base64,TINY' }],
    visionFiles: [{ type: 'file', fileId: 'file-api-abc', uploadKeyId: 'key1', name: 'photo.jpg', dataUrl: 'data:image/jpeg;base64,TINY' }]
  });
  const messages = ctx.buildApiMessages(conv, null, { apiKey: 'fake', keyId: 'key1', model: 'deepseek-flash', contextLimit: 20, contextBudget: 32768 });
  const content = messages[messages.length - 1].content;
  assert.equal(Array.isArray(content), true);
  assert.equal(content[0].type, 'text');
  assert.equal(content[1].type, 'file');
  assert.equal(content[1].file_id, 'file-api-abc');
  assert.equal(content[1].file_data, undefined); // file_id 与 file_data 互斥
  assert.equal(content[2].type, 'file');
  assert.equal(content[2].file_data, 'data:image/jpeg;base64,TINY');
  assert.equal(content[2].filename, 'photo.jpg');
});

test('uploaded images are not dropped by the inline size limit', () => {
  const ctx = harness();
  const big = { name: 'big.jpg', type: 'image/jpeg', size: 40 * 1024 * 1024 };
  const bigInline = { name: 'big2.jpg', type: 'image/jpeg', size: 40 * 1024 * 1024 };
  const pending = [
    { name: 'big.jpg', file: big, size: big.size, uploadFileId: 'file-api-x', uploadKeyId: 'key1', imageStrategy: 'file' },
    { name: 'big2.jpg', file: bigInline, size: bigInline.size }
  ];
  ctx.setAiAttachments([]);
  ctx.renderAttachPreview = () => {};
  const dropped = ctx.pruneOversizedImageAttachments(pending.slice(), { model: 'deepseek-flash' });
  assert.deepEqual(Array.from(dropped), ['big2.jpg']); // 只有走内联的那张被剔除
});
