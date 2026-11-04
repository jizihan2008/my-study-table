'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function harness(native=true) {
  const map = new Map(); let stopped=false;
  const ctx={console,setTimeout,clearTimeout,window:{},document:{getElementById:()=>null},
    localStorage:{getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v)},
    getMaxFocusCount:()=>3,getApiHostname:url=>new URL(url).hostname,
    getEffectiveApiConfig:()=>({}), getActiveConvId:()=>'',isAiStopRequested:()=>stopped,
    safeSaveAiConvs(){},isKimiModel:()=>false,buildDeepThinkParams:()=>({}),isDebugMode:()=>false,
    escapeHtml:s=>String(s).replaceAll('<','&lt;').replaceAll('>','&gt;'),
  };
  vm.createContext(ctx);
  for(const file of ['ai-tools','ai-api','ai-agents']) vm.runInContext(fs.readFileSync('js/'+file+'.js','utf8'),ctx);
  ctx.cfg={baseUrl:native?'https://api.deepseek.com':'https://example.com',model:'deepseek-chat',apiKey:'fake',contextBudget:131072};
  ctx.conv={id:'parent',messages:[{id:'user_1',role:'user',content:'整理3.1和3.2'}],_toolGroups:['agents','note']};
  ctx.stop=()=>{stopped=true;};
  return ctx;
}
const tasks=[{title:'3.1',task:'整理3.1',context:'noteId=31'},{title:'3.2',task:'整理3.2',context:'noteId=32'}];
const response=(content,calls)=>({ok:true,json:async()=>({choices:[{message:{content,tool_calls:calls},finish_reason:calls?'tool_calls':'stop'}]})});
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});

test('two workers overlap, execute independent reads, preserve native pairs and complete chapter artifacts',async()=>{
 const ctx=harness(); let active=0,peak=0; const bodies=[];
 ctx.fetch=async(url,options)=>{
  const b=JSON.parse(options.body);bodies.push(b);active++;peak=Math.max(peak,active);
  await new Promise(r=>setTimeout(r,15));active--;
  assert.ok(b.tools.every(t=>!['run_subagents','add_note','update_note'].includes(t.function.name)));
  const chapter=b.messages.find(m=>m.role==='user').content.includes('3.1')?'3.1':'3.2';
  const receipt=b.messages.find(m=>m.role==='tool');
  if(!receipt)return response('',[call('read_'+chapter,'get_note_detail',{id:chapter==='3.1'?31:32})]);
  assert.equal(receipt.tool_call_id,'read_'+chapter);
  return response(chapter+'知识点：定义、例题、结论。来源：noteId='+ (chapter==='3.1'?31:32));
 };
 ctx.executeToolCallStructured=async(action,params,context)=>{
  assert.equal(action,'get_note_detail');assert.equal(context.conv.messages[0].id,'user_1');
  return {ok:true,text:'章节原文 '+params.id};
 };
 const result=await ctx.runAiSubagents({tasks},{conv:ctx.conv,apiCfg:ctx.cfg});
 assert.equal(result.ok,true);assert.equal(peak,2);assert.equal(bodies.length,4);
 assert.ok(ctx.conv.agentRuns.every(r=>r.status==='completed'&&r.sources.length===1));
 for(const r of ctx.conv.agentRuns){
  let text='',offset=0,data;
  do{data=ctx.readAiSubagentResult({agentId:r.id,offset,limit:37},{conv:ctx.conv}).data;text+=data.content;offset=data.nextOffset;}while(!data.complete);
  assert.equal(JSON.parse(text).result,r.result);
 }
 const reloaded=JSON.parse(JSON.stringify(ctx.conv));
 assert.equal(ctx.readAiSubagentResult({agentId:reloaded.agentRuns[0].id},{conv:reloaded}).ok,true);
 reloaded.messages=[{id:'other',role:'user',content:'other branch'}];
 assert.equal(ctx.readAiSubagentResult({agentId:reloaded.agentRuns[0].id},{conv:reloaded}).ok,false);
});

test('worker cannot write, recurse or use a tool outside parent permissions',async()=>{
 const ctx=harness();let executed=0;
 ctx.executeToolCallStructured=async()=>{executed++;return {ok:true,text:'bad'};};
 ctx.fetch=async(url,o)=>{const b=JSON.parse(o.body);return b.messages.some(m=>m.role==='tool')?response('无法读取所需资料'):response('',[call('x','add_note',{title:'bad'})]);};
 await ctx.runAiSubagents({tasks},{conv:ctx.conv,apiCfg:ctx.cfg});
 assert.equal(executed,0);assert.ok(ctx.conv.agentRuns.every(r=>r.sources[0].ok===false));
 const rejected=await ctx.runAiSubagents({tasks},{conv:{...ctx.conv,_agentAllowedTools:[]},apiCfg:ctx.cfg});
 assert.equal(rejected.ok,false);
});

test('parent stop prevents queued tasks and ignores late replies',async()=>{
 const ctx=harness();let requests=0;
 ctx.fetch=async()=>{requests++;ctx.stop();return response('late result');};
 await ctx.runAiSubagents({tasks:[...tasks,...tasks]},{conv:ctx.conv,apiCfg:ctx.cfg});
 assert.ok(requests<=2);assert.ok(ctx.conv.agentRuns.every(r=>r.status==='stopped'&&!r.result));
});

test('per-request cap, invalid params and stale jobs never auto execute',async()=>{
 const ctx=harness();ctx.fetch=async()=>response('done');
 assert.equal(ctx.validateAiToolCall('run_subagents',{tasks:[]}).ok,false);
 assert.equal(ctx.validateAiToolCall('run_subagents',{tasks}).ok,true);
 assert.equal(ctx.validateAiToolCall('read_subagent_result',{agentId:'a',limit:9000}).ok,false);
 for(let i=0;i<3;i++)await ctx.runAiSubagents({tasks},{conv:ctx.conv,apiCfg:ctx.cfg});
 assert.equal((await ctx.runAiSubagents({tasks},{conv:ctx.conv,apiCfg:ctx.cfg})).ok,false);
 ctx.conv.agentRuns[0].status='running';ctx.interruptStaleAiSubagents(ctx.conv);
 assert.equal(ctx.conv.agentRuns[0].status,'interrupted');
});

test('legacy protocol tools remain permission checked and receipts stay independent',async()=>{
 const ctx=harness(false);
 ctx.fetch=async(url,o)=>{const b=JSON.parse(o.body);return b.messages.some(m=>m.role==='system'&&m.content.startsWith('工具返回资料'))?response('已整理原文'):response('<tool_call>{"action":"get_note_detail","params":{"id":31}}</tool_call>');};
 ctx.executeToolCallStructured=async()=>({ok:true,text:'原文'});
 await ctx.runAiSubagents({tasks},{conv:ctx.conv,apiCfg:ctx.cfg});
 assert.ok(ctx.conv.agentRuns.every(r=>r.status==='completed'&&r.result==='已整理原文'));
});

test('different information types run in parallel with inherited tool permissions',async()=>{
 const ctx=harness();ctx.conv._toolGroups=['agents','note','todo'];let active=0,peak=0;
 ctx.fetch=async(url,o)=>{
  const b=JSON.parse(o.body),task=b.messages.find(m=>m.role==='user').content;
  if(b.messages.some(m=>m.role==='tool'))return response(task.includes('待办')?'待办汇总':'笔记汇总');
  return response('',[call('collect',task.includes('待办')?'list_todos':'list_notes',{})]);
 };
 ctx.executeToolCallStructured=async action=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,15));active--;return {ok:true,text:action+'资料'};};
 await ctx.runAiSubagents({tasks:[{title:'笔记',task:'收集笔记'},{title:'待办',task:'收集待办'}]},{conv:ctx.conv,apiCfg:ctx.cfg});
 assert.equal(peak,2);assert.equal(ctx.conv.agentRuns[0].sources[0].action,'list_notes');assert.equal(ctx.conv.agentRuns[1].sources[0].action,'list_todos');
});

test('one failed worker does not discard the successful sibling',async()=>{
 const ctx=harness();ctx.fetch=async(url,o)=>{const b=JSON.parse(o.body);if(b.messages[1].content.includes('3.1'))throw new Error('network unavailable');return response('3.2成果');};
 await ctx.runAiSubagents({tasks},{conv:ctx.conv,apiCfg:ctx.cfg});
 assert.equal(ctx.conv.agentRuns[0].status,'failed');assert.equal(ctx.conv.agentRuns[1].status,'completed');
 assert.equal(ctx.conv.agentRuns[1].result,'3.2成果');
});

test('round exhaustion reports incomplete work instead of success',async()=>{
 const ctx=harness();ctx.fetch=async()=>response('',[call('again','list_notes',{})]);
 ctx.executeToolCallStructured=async()=>({ok:true,text:'资料'});
 await ctx.runAiSubagents({tasks},{conv:ctx.conv,apiCfg:ctx.cfg});
 assert.ok(ctx.conv.agentRuns.every(r=>r.status==='partial'&&r.sources.length===8));
});

test('native workers do not mistake text tool commands for completed work',async()=>{
 const ctx=harness();let executed=0;
 ctx.fetch=async()=>response('<tool_call>{"action":"get_note_detail","params":{"id":31}}</tool_call>');
 ctx.executeToolCallStructured=async()=>{executed++;return {ok:true,text:'bad'};};
 await ctx.runAiSubagents({tasks},{conv:ctx.conv,apiCfg:ctx.cfg});
 assert.equal(executed,0);assert.ok(ctx.conv.agentRuns.every(r=>r.status==='failed'&&!r.result));
});

test('saved concurrency and total control scheduling, schema and cumulative task cap',async()=>{
 const ctx=harness();ctx.localStorage.setItem('study_ai_agent_concurrency','3');ctx.localStorage.setItem('study_ai_agent_total','4');
 assert.equal(ctx.getAiToolJsonSchema('run_subagents').properties.tasks.maxItems,4);
 let active=0,peak=0;
 ctx.fetch=async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,10));active--;return response('成果');};
 await ctx.runAiSubagents({tasks:[...tasks,...tasks]},{conv:ctx.conv,apiCfg:ctx.cfg});
 assert.equal(peak,3);assert.equal(ctx.conv.agentRuns.length,4);
 assert.equal((await ctx.runAiSubagents({tasks:[tasks[0]]},{conv:ctx.conv,apiCfg:ctx.cfg})).ok,false);
 ctx.conv.messages=[{id:'user_2',role:'user',content:'新的请求'}];
 ctx.localStorage.setItem('study_ai_agent_concurrency','1');peak=0;
 await ctx.runAiSubagents({tasks},{conv:ctx.conv,apiCfg:ctx.cfg});assert.equal(peak,1);
});

test('invalid stored settings use defaults and invalid form edits do not overwrite saved values',()=>{
 const ctx=harness();
 for(const v of ['', '0', '-1', '2.5', 'NaN', '999']){
  ctx.localStorage.setItem('study_ai_agent_concurrency',v);ctx.localStorage.setItem('study_ai_agent_total',v);
  assert.equal(ctx.getAiAgentLimits().concurrency,2);assert.equal(ctx.getAiAgentLimits().total,6);
 }
 let message='',reports=0,writes=0;
 const input={value:'0',setCustomValidity:v=>{message=v;},reportValidity:()=>{reports++;}};
 ctx.document.getElementById=()=>input;ctx.setSyncedSetting=(key,value)=>{writes++;ctx.localStorage.setItem(key,value);};
 ctx.saveAiAgentSetting('concurrency');assert.equal(writes,0);assert.equal(reports,1);assert.ok(message);
 input.value='4';ctx.saveAiAgentSetting('concurrency');assert.equal(writes,1);assert.equal(message,'');assert.equal(ctx.getAiAgentLimits().concurrency,4);
});
