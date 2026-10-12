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
    window: { _aiResumeInited: true, addEventListener() {} }, console, localStorage: storage(),
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

const AIStream = require('../js/ai-stream');
const cfg = () => ({ model:'deepseek-flash', baseUrl:'https://api.deepseek.com', apiKey:'fake', deepThink:true, contextBudget:131072 });
const call = (id,name,args) => ({ id,type:'function',function:{name,arguments:typeof args==='string'?args:JSON.stringify(args)} });
const response = (calls,text='') => ({choices:[{message:{content:text,reasoning_content:'原始思考',...(calls?{tool_calls:calls}:{})},finish_reason:calls?'tool_calls':'stop'}]});
function fakeApi(ctx,respond){const bodies=[];ctx.fetch=async(url,options)=>{const body=JSON.parse(options.body);bodies.push(body);return {ok:true,status:200,json:async()=>respond(body,bodies.length)};};return bodies;}

test('library PDF page tool delivers the requested image in the next API request and after history reload', async () => {
  const ctx = harness(), conv = conversation(ctx);
  conv._toolGroups = ['file'];
  ctx.window.aiFileLibrary = {
    list: async () => [{ id: 'file_pdf', kind: 'file', name: '教材.pdf', size: 20 }],
    read: async () => ({ size: 20 })
  };
  const dataUrl = 'data:image/jpeg;base64,AAAA';
  ctx.inspectInlineImageForApi = () => ({ ok: true });
  ctx.renderPdfAttachmentPages = async (file, opts) => {
    assert.equal(opts.startPage, 2);
    assert.equal(opts.endPage, 4);
    return { dataUrls: [dataUrl, dataUrl, dataUrl], pageCount: 5 };
  };
  const bodies = fakeApi(ctx, (body, n) => n === 1
    ? response([call('pdf-page', 'read_library_pdf_page', { fileId: 'file_pdf', startPage: 2, endPage: 4 })])
    : response(null, 'read page'));
  const out = await ctx.runToolCallLoop(cfg(), conv);
  assert.equal(out.outcomes[0].ok, true);
  assert.equal(bodies.length, 2);
  const messages = bodies[1].messages;
  const toolIndex = messages.findIndex(m => m.role === 'tool');
  assert.equal(messages[toolIndex].tool_call_id, 'pdf-page');
  assert.equal(messages[toolIndex].content.includes('base64'), false);
  assert.equal(messages[toolIndex + 1].role, 'user');
  assert.equal(messages[toolIndex + 1].content.find(p => p.type === 'image_url').image_url.url, dataUrl);
  assert.equal(messages[toolIndex + 1].content.filter(p => p.type === 'image_url').length, 3);
  assert.match(messages[toolIndex + 1].content[0].text, /教材.pdf 第2页/);
  assert.match(messages[toolIndex + 1].content[0].text, /教材.pdf 第4页/);
  const restored = JSON.parse(JSON.stringify(conv));
  const replay = ctx.buildApiMessages(restored, null, cfg());
  assert.ok(replay.some(m => Array.isArray(m.content) && m.content.some(p => p.image_url?.url === dataUrl)));
  const selected = ctx.selectAiContext(restored.messages, { ...cfg(), contextLimit: 1 }, 'test').messages;
  assert.ok(selected.some(m => m.tool_calls?.length));
  assert.ok(selected.some(m => m.visionFiles?.length));
});

test('legacy library PDF page calls also deliver images after the text tool receipt', async () => {
  const ctx = harness(), conv = conversation(ctx);
  conv._toolGroups = ['file'];
  ctx.window.aiFileLibrary = { list: async () => [{ id: 'file_pdf', name: '扫描.pdf', size: 10 }], read: async () => ({ size: 10 }) };
  ctx.inspectInlineImageForApi = () => ({ ok: true });
  ctx.renderPdfAttachmentPages = async () => ({ dataUrls: ['data:image/jpeg;base64,AAAA'], pageCount: 1 });
  const bodies = fakeApi(ctx, (body, n) => response(null, n === 1
    ? '<tool_call>{"action":"read_library_pdf_page","params":{"fileId":"file_pdf","pdfPage":1}}</tool_call>' : 'done'));
  await ctx.runToolCallLoop({ ...cfg(), baseUrl: 'https://other.example/v1' }, conv);
  assert.equal(bodies.length, 2);
  assert.ok(bodies[1].messages.some(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(p => p.image_url?.url === 'data:image/jpeg;base64,AAAA')));
});

test('native rounds and an invalid JSON attempt preserve exact IDs and reasoning without UI tags', async()=>{
  const ctx=harness(),conv=conversation(ctx);vm.runInContext('let notes = [];',ctx);
  const executed=[];ctx.executeToolCallStructured=async action=>{executed.push(action);return {ok:true,status:'success',changed:action==='add_note',text:'saved',data:{id:91}};};
  const bodies=fakeApi(ctx,(body,n)=>n===1?response([call('r1','list_notes',{}),call('r2','get_note_tags',{})]):n===2?response([call('bad','add_note','{"title":')]):n===3?response([call('write','add_note',{params:{title:'title',content:'body'}})]):response(null,'finished'));
  const out=await ctx.runToolCallLoop(cfg(),conv);assert.equal(bodies.length,4);assert.equal(out.outcomes[2].code,'INVALID_ARGUMENT_JSON');assert.deepEqual(executed,['list_notes','get_note_tags','add_note']);
  for(const body of bodies.slice(1)){
    assert.deepEqual(body.messages.filter(m=>m.tool_calls).flatMap(m=>m.tool_calls.map(c=>c.id)),body.messages.filter(m=>m.role==='tool').map(m=>m.tool_call_id));
    assert.equal(body.messages.some(m=>m.role==='assistant'&&String(m.content).includes('<tool_call>')),false);
    assert.ok(body.messages.filter(m=>m.role==='assistant').every(m=>Object.hasOwn(m,'reasoning_content')));
  }
  assert.equal(conv.messages.filter(m=>m.role==='tool').length,4);assert.match(conv.messages.find(m=>m.role==='assistant').content,/<tool_call>/);
  assert.equal(conv._rawLogs[1].response.choices[0].message.tool_calls[0].function.arguments,'{"title":');
});

test('native text-tag output is rejected and correction keeps native protocol',async()=>{
  const ctx=harness(),conv=conversation(ctx);let writes=0;ctx.executeToolCallStructured=async()=>{writes++;return {ok:true,text:'unexpected'};};
  const bodies=fakeApi(ctx,(body,n)=>n===1?response(null,'<tool_call>{"action":"add_note","params":{"title":"unsafe"}}</tool_call>'):response(null,'corrected'));
  const out=await ctx.runToolCallLoop(cfg(),conv);assert.equal(writes,0);assert.equal(bodies.length,2);assert.equal(out.outcomes[0].action,'tool_protocol');
  assert.equal(bodies[1].messages.some(m=>String(m.content).includes('<tool_call>')),false);
  assert.match(bodies[1].messages.find(m=>String(m.content).includes('工具指令格式错误')).content,/保持原生协议/);
  assert.ok(bodies[1].tools.some(t=>t.function.name==='add_note'));
});

test('JSON syntax, object types and narrow params-wrapper compatibility are validated',()=>{
  const ctx=harness();
  for(const raw of ['{','[]','null','42','{"params":[]}']){
    const parsed=ctx.parseNativeLocalToolCalls([call('bad','add_note',raw)])[0];assert.ok(parsed.argumentError);assert.equal(parsed.rawArguments,raw);assert.equal(Object.hasOwn(parsed.params,'__invalidNativeArguments'),false);
  }
  const parsed=ctx.parseNativeLocalToolCalls([call('wrapped','add_note',{params:{title:'x',content:'y'}})])[0];assert.equal(parsed.params.title,'x');assert.equal(parsed.argumentError,undefined);
  const mixed=ctx.parseNativeLocalToolCalls([call('mixed','add_note',{params:{title:'x'},title:'other'})])[0];assert.equal(ctx.validateAiToolCall(mixed.action,mixed.params).ok,false);
});

test('unknown or disabled native functions receive paired errors and cannot execute',async()=>{
  const ctx=harness(),conv=conversation(ctx);conv._toolGroups=['note'];let executed=0;ctx.executeToolCallStructured=async()=>{executed++;return {ok:true,text:'unexpected'};};
  const bodies=fakeApi(ctx,(body,n)=>n===1?response([call('unknown','invented_tool',{}),call('disabled','add_todo',{text:'x'})]):response(null,'explained'));
  const out=await ctx.runToolCallLoop(cfg(),conv);assert.equal(executed,0);assert.ok(out.outcomes.every(o=>o.code==='TOOL_NOT_ENABLED'));
  assert.deepEqual(bodies[1].messages.filter(m=>m.role==='tool').map(m=>m.tool_call_id),['unknown','disabled']);
});

test('legacy text batches migrate only in working context and preserve stored records',()=>{
  const ctx=harness(),conv=conversation(ctx);ctx.appendMessage(conv,{role:'assistant',content:'说明\n<tool_call>{"action":"list_notes","params":{},"callId":"legacy"}</tool_call>',reasoning:'original'});
  ctx.appendMessage(conv,{role:'system',content:'result',_toolInfo:{toolNames:'list_notes',results:['result']}});
  const saved=JSON.stringify(conv),messages=ctx.buildApiMessages(conv,null,cfg());
  assert.equal(messages.at(-2).tool_calls[0].id,'legacy');assert.equal(messages.at(-1).tool_call_id,'legacy');assert.equal(messages.at(-2).reasoning_content,'original');assert.equal(JSON.stringify(conv),saved);
});

test('incomplete native history and orphan receipts never form invalid API batches',()=>{
  const ctx=harness(),conv=conversation(ctx);ctx.appendMessage(conv,{role:'assistant',content:'',_apiContent:'',tool_calls:[call('missing','add_note',{title:'x'})]});
  ctx.appendMessage(conv,{role:'user',content:'new request'});ctx.appendMessage(conv,{role:'tool',tool_call_id:'orphan',content:'old result'});
  const messages=ctx.buildApiMessages(conv,null,cfg());assert.equal(messages.some(m=>m.tool_calls?.length),false);assert.equal(messages.some(m=>m.role==='tool'),false);assert.ok(messages.some(m=>String(m.content).includes('查询真实数据')));
});

test('migration and whole-turn trimming retain native API content and tool result IDs',()=>{
  const ctx=harness(),conv={id:'old',messages:[{role:'user',content:'q'},{role:'assistant',content:'UI',_apiContent:'actual',tool_calls:[call('id','list_notes',{})]},{role:'tool',tool_call_id:'id',content:'result'}]};
  ctx.ensureTree(conv);assert.equal(conv.messages.at(-2)._apiContent,'actual');assert.equal(conv.messages.at(-1).tool_call_id,'id');ctx.trimConvMessages(conv,2);assert.equal(conv.messages.length,3);
  const restored=JSON.parse(JSON.stringify(conv));ctx.ensureTree(restored);const messages=ctx.buildApiMessages(restored,null,cfg());assert.equal(messages.at(-2).content,'actual');assert.equal(messages.at(-1).tool_call_id,'id');
});

test('stream request logs preserve schemas, IDs, reasoning and usage while redacting image bytes',async()=>{
  const ctx=harness(),conv=conversation(ctx);ctx.AIStream=AIStream;ctx.buildDeepThinkParams=()=>({thinking:{type:'enabled'}});
  const messages=[{role:'user',content:[{type:'text',text:'q'},{type:'image_url',image_url:{url:'data:image/png;base64,PRIVATE_BYTES'}}]},{role:'assistant',content:'',tool_calls:[call('logged','list_notes',{})],reasoning_content:'思考'},{role:'tool',tool_call_id:'logged',content:'result'}];
  ctx.fetch=async()=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>({...response(null,'answer'),usage:{prompt_tokens:20,completion_tokens:3}})});
  await ctx.callAiApi(messages,cfg(),conv,{forceStream:true,onDelta(){}});
  const log=conv._rawLogs[0];assert.equal(log.request.stream,true);assert.equal(log.request.thinking.type,'enabled');assert.equal(log.request.messages[1].tool_calls[0].id,'logged');assert.equal(log.request.messages[2].tool_call_id,'logged');
  assert.equal(log.request.messages[1].reasoning_content,'思考');assert.ok(log.request.tools.length);assert.equal(JSON.stringify(log).includes('PRIVATE_BYTES'),false);assert.equal(Object.hasOwn(log.request,'headers'),false);
  assert.equal(log.response.compatibilityResponse.usage.prompt_tokens,20);
});

test('network, JSON and HTTP failures log one actual non-stream request each',async()=>{
  for(const type of ['transport','json','http']){
    const ctx=harness(),conv=conversation(ctx);ctx.fetch=async()=>{if(type==='transport')throw Error('network failure');return {ok:type!=='http',status:type==='http'?400:200,json:async()=>{if(type==='json')throw Error('bad JSON');return {error:{message:'HTTP failure'}};}};};
    await assert.rejects(ctx.callAiApi([],cfg(),conv));assert.equal(conv._rawLogs.length,1);assert.ok(conv._rawLogs[0].request.tools.length);assert.ok(conv._rawLogs[0].response.error);
  }
});

test('stream fallback logs each transport once and keeps the same native tool schema',async()=>{
  const ctx=harness(),conv=conversation(ctx);ctx.AIStream=AIStream;let n=0;const bodies=[];
  ctx.fetch=async(url,options)=>{bodies.push(JSON.parse(options.body));return ++n===1?{ok:false,status:400,json:async()=>({error:{message:'stream unsupported'}})}:{ok:true,status:200,json:async()=>response(null,'fallback')};};
  await ctx.callAiApi([],cfg(),conv,{forceStream:true,onDelta(){}});assert.equal(conv._rawLogs.length,2);assert.equal(conv._rawLogs[0].request.stream,true);assert.equal(conv._rawLogs[1].request.stream,undefined);
  assert.deepEqual(conv._rawLogs[0].request.tools,conv._rawLogs[1].request.tools);assert.deepEqual(bodies[0].tools,bodies[1].tools);
});

test('Kimi logs reflect max_completion_tokens and omitted temperature exactly',()=>{
  const ctx=harness(),conv=conversation(ctx),config={model:'kimi-k3',baseUrl:'https://api.moonshot.cn',maxTokens:8000};
  const body=ctx.buildStreamingRequestBody([],config,conv).body;ctx.recordAiRawLog(conv,body,config,'time',{usage:{total_tokens:1}});
  assert.equal(conv._rawLogs[0].request.max_completion_tokens,8000);assert.equal(Object.hasOwn(conv._rawLogs[0].request,'max_tokens'),false);assert.equal(Object.hasOwn(conv._rawLogs[0].request,'temperature'),false);
});

test('diagnostics are bounded and survive normal storage compaction',()=>{
  const ctx=harness(),conv=conversation(ctx);for(let i=0;i<35;i++)ctx.recordAiRawLog(conv,{model:'m',messages:[{role:'user',content:'x'.repeat(10000)}]},cfg(),'t',{usage:{total_tokens:1}});
  assert.ok(conv._rawLogs.length<=20);assert.ok(conv._rawLogDropped>0);ctx.recordAiRawLog(conv,{model:'m',messages:[{role:'user',content:'x'.repeat(900000)}]},cfg(),'t',{});
  assert.ok(JSON.stringify(conv._rawLogs).length<=750000);assert.equal(conv._rawLogs.at(-1).truncated,true);
  const code=source('core');vm.runInContext(code.slice(code.indexOf('function compactAiConversationsForStorage'),code.indexOf('function saveData')),ctx);
  const stored=ctx.compactAiConversationsForStorage([conv])[0];assert.ok(stored._rawLogs.length);assert.equal(stored._rawLogDropped,conv._rawLogDropped);
});

test('early native SSE termination rejects partial tool arguments and logs the interruption',async()=>{
  const ctx=harness(),conv=conversation(ctx);ctx.AIStream=AIStream;
  ctx.fetch=async()=>({ok:true,headers:{get:()=> 'text/event-stream'},body:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"partial","function":{"name":"add_note","arguments":"{\\\"title\\\":"}}]}}]}\n\n'));c.close();}})});
  await assert.rejects(ctx.callAiApi([],cfg(),conv,{forceStream:true,onDelta(){}}),/提前结束/);assert.equal(conv._rawLogs.length,1);assert.match(conv._rawLogs[0].response.error,/提前结束/);assert.equal(conv.messages.length,1);
});

test('native parsers and repair instructions never fall back to text tags, legacy mode remains supported',()=>{
  const ctx=harness(),text='<tool_call>{"action":"add_note","params":{"title":"x"}}</tool_call>';
  assert.equal(ctx.resultFromChatCompletionData(response(null,text),cfg()).toolCalls.length,0);
  assert.equal(ctx.resultFromChatCompletionData(response(null,text),{model:'gateway',baseUrl:'https://gateway.invalid'}).toolCalls.length,1);
  assert.equal(ctx.aiToolProtocolRepair(cfg()).includes('<tool_call>'),false);assert.match(ctx.aiToolProtocolRepair({baseUrl:'https://gateway.invalid'}),/<tool_call>/);
});


test('text tool tags mixed into a real native response are neither executed nor echoed in the next API turn',async()=>{
  const ctx=harness(),conv=conversation(ctx),executed=[];
  ctx.executeToolCallStructured=async action=>{executed.push(action);return {ok:true,status:'success',changed:false,text:'result'};};
  const fake='<tool_call>{"action":"add_todo","params":{"text":"fake"}}</tool_call>';
  const bodies=fakeApi(ctx,(body,n)=>n===1?response([call('real','list_notes',{})],fake):response(null,'done'));
  await ctx.runToolCallLoop(cfg(),conv);
  assert.deepEqual(executed,['list_notes']);assert.equal(bodies[1].messages.some(m=>m.role==='assistant'&&String(m.content).includes('<tool_call>')),false);
  assert.equal(conv._rawLogs[0].response.choices[0].message.content,fake);
  assert.equal(conv.messages.find(m=>m.tool_calls)?.content.includes('add_todo'),false);
});


test('valid DSML in native mode is rejected without switching the corrective protocol',async()=>{
  const ctx=harness(),conv=conversation(ctx);let executed=0;ctx.executeToolCallStructured=async()=>{executed++;return {ok:true,text:'unexpected'};};
  const dsml='<｜DSML｜function_calls><｜DSML｜invoke name="list_notes"></｜DSML｜invoke></｜DSML｜function_calls>';
  const bodies=fakeApi(ctx,(body,n)=>n===1?response(null,dsml):response(null,'corrected'));
  await ctx.runToolCallLoop(cfg(),conv);
  assert.equal(executed,0);assert.equal(bodies.length,2);assert.equal(bodies[1].messages.some(m=>String(m.content).includes('<｜DSML｜')),false);
  assert.match(bodies[1].messages.find(m=>String(m.content).includes('工具指令格式错误')).content,/保持原生协议/);
});

test('quota fallback retains native history and reports omitted diagnostic records',()=>{
  const ctx=harness(),conv=conversation(ctx);ctx.appendMessage(conv,{role:'assistant',content:'UI',_apiContent:'',tool_calls:[call('id','list_notes',{})]});ctx.appendMessage(conv,{role:'tool',tool_call_id:'id',content:'result'});
  conv._rawLogs=[{request:{tools:[{type:'function'}]}}];conv._rawLogDropped=2;ctx.aiConvs=[conv];const saved=storage();
  ctx.localStorage={getItem:saved.getItem,setItem(key,value){if(value.includes('"_rawLogs"'))throw Error('quota');saved.setItem(key,value);}};
  vm.runInContext(source('ai-utils'),ctx);assert.equal(ctx.safeSaveAiConvs(),true);
  const restored=JSON.parse(saved.getItem('study_ai_convs'))[0];ctx.ensureTree(restored);
  assert.equal(restored._rawLogDropped,3);assert.equal(restored.messages.at(-1).tool_call_id,'id');assert.equal(restored.messages.at(-2)._apiContent,'');
});


test('old candidate branches retain complete native pairs and provider reasoning fields',()=>{
  const ctx=harness(),conv={id:'candidate',messages:[{role:'user',content:'q',_activeCandidate:0,_candidates:[{messages:[
    {role:'assistant',content:'UI',_apiContent:'',reasoning_content:'provider reasoning',tool_calls:[call('branch','list_notes',{})]},
    {role:'tool',tool_call_id:'branch',content:'result'}]}]}]};
  ctx.ensureTree(conv);ctx.trimConvMessages(conv,2);const messages=ctx.buildApiMessages(conv,null,cfg());
  assert.equal(messages.at(-2).tool_calls[0].id,'branch');assert.equal(messages.at(-1).tool_call_id,'branch');assert.equal(messages.at(-2).reasoning_content,'provider reasoning');assert.equal(messages.at(-2).content,'');
});

test('native parameter null is an error and old malformed markup cannot re-enter native request history',()=>{
  const ctx=harness();assert.ok(ctx.parseNativeLocalToolCalls([{id:'null',function:{name:'list_notes',arguments:null}}])[0].argumentError);
  const conv=conversation(ctx);ctx.appendMessage(conv,{role:'assistant',content:'<tool_call>{"action":"add_note"',reasoning:'old reasoning'});
  const messages=ctx.buildApiMessages(conv,null,cfg());assert.equal(messages.at(-1).content.includes('<tool_call>'),false);assert.match(messages.at(-1).content,/原生 function tools/);
});


test('builtin search follow-up failures keep a separate actual request with paired IDs',async()=>{
  const ctx=harness(),conv=conversation(ctx);conv._webSearchMode='native';let n=0;
  ctx.fetch=async()=>{if(++n===2)throw Error('follow-up network failure');return {ok:true,status:200,json:async()=>response([call('search-id','$web_search',{query:'q'})])};};
  await assert.rejects(ctx.callAiApi([{role:'user',content:'q'}],{model:'kimi-k3',baseUrl:'https://api.moonshot.cn',apiKey:'fake'},conv),/follow-up network failure/);
  assert.equal(conv._rawLogs.length,2);assert.equal(conv._rawLogs[0].request.tools[0].function.name,'$web_search');
  const follow=conv._rawLogs[1];assert.equal(follow.request.messages.at(-1).tool_call_id,'search-id');assert.equal(follow.request.messages.at(-2).tool_calls[0].id,'search-id');assert.match(follow.response.error,/follow-up network failure/);
});


test('historical legacy corrective system prompts cannot override the current native protocol',()=>{
  for(const marked of [true,false]){
    const ctx=harness(),conv=conversation(ctx);
    ctx.appendMessage(conv,{role:'assistant',content:'<tool_call>{"action":"list_notes","params":{}}</tool_call>',...(marked?{_malformedToolProtocol:true}:{})});
    ctx.appendMessage(conv,{role:'system',content:'必须严格使用 <tool_call>{"action":"工具名","params":{}}</tool_call>，不要使用原生工具。',_toolInfo:{toolNames:'tool_protocol',results:['请改用 <tool_call> 标签']}});
    const saved=JSON.stringify(conv),messages=ctx.buildApiMessages(conv,null,cfg());
    assert.equal(messages.some(m=>String(m.content).includes('<tool_call>')),false);
    assert.equal(messages.some(m=>m.tool_calls?.length),false);
    assert.match(messages.at(-1).content,/保持原生协议/);assert.equal(JSON.stringify(conv),saved);
  }
});
