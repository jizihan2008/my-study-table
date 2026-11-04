'use strict';
const {test,expect}=require('@playwright/test');
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
test('parallel chapter tasks, parent review and persisted task panel',async()=>{
 test.setTimeout(90000);
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'mst-subagents-'));
 let app;
 try{
  app=await electron.launch({args:[path.resolve('.'),'--no-sandbox','--disable-gpu'],env:{...process.env,MST_E2E:'1',MST_USER_DATA_PATH:profile}});
  const page=await app.firstWindow();await page.waitForSelector('#section-today.active');
  const evidence=await page.evaluate(async()=>{
   switchTab('ai');createNewConv();const conv=getActiveConv();conv._toolGroups=['agents','note'];
   appendMessage(conv,{role:'user',content:'请分别整理教材3.1、3.2章节并检查'});
   const cfg={model:'deepseek-chat',baseUrl:'https://api.deepseek.com',apiKey:'test',contextBudget:131072};
   let active=0,peak=0,parentRounds=0;const fetched=[];
   const originalFetch=window.fetch,originalExecute=executeToolCallStructured;
   executeToolCallStructured=async(action,params,context)=>{
    if(action==='get_note_detail')return {ok:true,text:'教材'+params.id+'：定义、性质、例题。',data:{id:params.id}};
    return originalExecute(action,params,context);
   };
   const tc=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
   window.fetch=async(url,options)=>{
    if(!String(url).includes('api.deepseek.com'))return originalFetch(url,options);
    const body=JSON.parse(options.body);fetched.push(body);
    let content='',calls;
    if(body.messages[0].content.includes('独立子代理')){
     active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,60));active--;
     const chapter=body.messages.find(m=>m.role==='user').content.includes('3.1')?'3.1':'3.2';
     if(!body.messages.some(m=>m.role==='tool'))calls=[tc('source_'+chapter,'get_note_detail',{id:chapter==='3.1'?31:32})];
     else content=chapter+'完整知识点：定义、性质、例题。来源笔记'+(chapter==='3.1'?31:32);
    }else{
     parentRounds++;
     if(parentRounds===1)calls=[tc('spawn','run_subagents',{tasks:[{title:'整理3.1',task:'整理3.1',context:'笔记31'},{title:'整理3.2',task:'整理3.2',context:'笔记32'}]})];
     else if(parentRounds===2)calls=conv.agentRuns.map((r,i)=>tc('result_'+i,'read_subagent_result',{agentId:r.id}));
     else if(parentRounds===3)calls=[tc('verify31','get_note_detail',{id:31}),tc('verify32','get_note_detail',{id:32})];
     else content='已核对原文：3.1与3.2均覆盖定义、性质和例题，无遗漏。';
    }
    return new Response(JSON.stringify({choices:[{message:{content,...(calls?{tool_calls:calls}:{})},finish_reason:calls?'tool_calls':'stop'}]}),{status:200,headers:{'Content-Type':'application/json'}});
   };
   try{
    const result=await runToolCallLoop(cfg,conv);appendMessage(conv,{role:'assistant',content:result.finalCleanText});safeSaveAiConvs();renderAiMessages();
    return {peak,parentRounds,statuses:conv.agentRuns.map(r=>r.status),final:result.finalCleanText,id:conv.id};
   }finally{window.fetch=originalFetch;executeToolCallStructured=originalExecute;}
  });
  expect(evidence.peak).toBe(2);expect(evidence.parentRounds).toBe(4);expect(evidence.statuses).toEqual(['completed','completed']);
  await expect(page.locator('.ai-subagents')).toContainText('整理3.1');
  await page.locator('.ai-subagents > details').first().locator('summary').first().click();
  await expect(page.locator('.ai-subagents')).toContainText('3.1完整知识点');
  await page.screenshot({path:'.tmp-subagents-panel.png',fullPage:false});
  await page.evaluate(()=>{openSettingsModal();switchSettingsTab('api');});
  await page.locator('#settingsAiAgentConcurrency').fill('1');
  await page.locator('#settingsAiAgentConcurrency').blur();
  await page.locator('#settingsAiAgentTotal').fill('3');
  await page.locator('#settingsAiAgentTotal').blur();
  await page.reload();await page.waitForSelector('#section-today.active');
  const restored=await page.evaluate(id=>{
   const conv=aiConvs.find(c=>c.id===id);return conv?.agentRuns?.map(r=>({status:r.status,result:r.result}));
  },evidence.id);
  await page.evaluate(()=>{openSettingsModal();switchSettingsTab('api');});
  await expect(page.locator('#settingsAiAgentConcurrency')).toHaveValue('1');
  await expect(page.locator('#settingsAiAgentTotal')).toHaveValue('3');
  expect(restored).toHaveLength(2);expect(restored[0].status).toBe('completed');expect(restored[1].result).toContain('3.2完整知识点');
 }finally{if(app)await app.close();await fs.rm(profile,{recursive:true,force:true});}
});
