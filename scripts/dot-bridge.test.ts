import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import ts from 'typescript';
import { DotDispatcher, type DotRequest } from '../src/dotBridge.ts';
// @ts-ignore JavaScript adapter intentionally has no runtime dependency.
import { connect, request, receipt, rpc } from './dot-bridge.mjs';

const tick = () => new Promise(r => setTimeout(r, 5));
const req = (action: DotRequest['action'], extra = {}): DotRequest => ({ id:randomUUID(),session:randomUUID(),conversationId:randomUUID(),action,createdAt:Date.now(),text:'change',mode:'steer',...extra });
test('status stays available during work, and stop cancels older waiting instructions', async () => {
  let finish!: () => void;const waiting=new Promise<void>(r=>{finish=r;});const calls:string[]=[];
  const d=new DotDispatcher({status:async()=>({state:'running'}),send:async(_id,text)=>{calls.push(text);if(text==='first') await waiting;},stop:async()=>{calls.push('stop');}},async()=>true);
  const t=Date.now();const a=d.dispatch(req('send',{text:'first',createdAt:t}));await tick();
  const b=d.dispatch(req('send',{text:'old',createdAt:t+1}));
  const stop=d.dispatch(req('stop',{createdAt:t+2}));
  assert.deepEqual(await d.dispatch(req('status')),{state:'running'});
  assert.equal((await Promise.race([stop,new Promise((_,reject)=>setTimeout(()=>reject(Error('stop blocked by send')),300))]) as any).state,'stopped');
  finish();await a;assert.equal((await b as any).state,'cancelled');await stop;
  assert.deepEqual(calls,['first','stop']);
});
test('revocation, handler errors and duplicate ids never dispatch another mutation', async () => {
  let valid=true,count=0;const r=req('send');
  const d=new DotDispatcher({status:async()=>null,send:async()=>{count++;throw Error('engine blocked');},stop:async()=>{}},async()=>valid);
  await assert.rejects(d.dispatch(r),/blocked/);await d.dispatch(r);assert.equal(count,1);
  valid=false;await assert.rejects(d.dispatch(req('stop')),/revoked/);
});
test('requests that expire before execution cannot mutate work', async()=>{
  const d=new DotDispatcher({status:async()=>null,send:async()=>{throw Error('must not execute');},stop:async()=>{throw Error('must not execute');}},async()=>true);
  await assert.rejects(d.dispatch(req('send',{createdAt:1})),/expired/);
});
test('a later manual stop cancels an unpolled voice instruction',async()=>{
  const d=new DotDispatcher({canSend:()=>false,status:async()=>null,send:async()=>{throw Error('must not execute');},stop:async()=>{}},async()=>true);
  assert.equal((await d.dispatch(req('send')) as any).state,'cancelled');
});
async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'kda-dot-node-'));
  const session=randomUUID(), conversationId=randomUUID();
  await fs.mkdir(path.join(root,session));
  const c={enabled:true,session,conversationId,heartbeatMs:Date.now()};
  await fs.writeFile(path.join(root,'connection.json'),JSON.stringify(c));
  return {root,c,dir:path.join(root,session)};
}
test('disabled, stale, wrong-conversation and wrong-session calls fail before enqueue', async()=>{
  const {root,c,dir}=await fixture();
  await assert.rejects(request(root,{action:'send',text:'hello',id:randomUUID(),session:c.session,conversationId:randomUUID()}),/match/);
  await assert.rejects(request(root,{action:'stop',id:randomUUID(),conversationId:c.conversationId,session:randomUUID()}),/session/);
  assert.equal((await fs.readdir(dir)).length,0);
  await fs.writeFile(path.join(root,'connection.json'),JSON.stringify({...c,heartbeatMs:1}));
  await assert.rejects(connect(root),/stale/);
  await fs.writeFile(path.join(root,'connection.json'),JSON.stringify({enabled:false}));
  await assert.rejects(connect(root),/disabled/);
});
test('real file adapter preserves one request across retries and rejects conflicting reuse',async()=>{
  const {root,c,dir}=await fixture();const id=randomUUID();
  const input={action:'send',id,session:c.session,conversationId:c.conversationId,text:'안녕',mode:'steer'};
  const first=await request(root,input,{timeoutMs:1});assert.equal(first.state,'pending');
  const bytes=await fs.readFile(path.join(dir,`${id}.request.json`),'utf8');
  await request(root,input,{timeoutMs:1});assert.equal(await fs.readFile(path.join(dir,`${id}.request.json`),'utf8'),bytes);
  await assert.rejects(request(root,{...input,text:'different'}),/another command/);
  await fs.writeFile(path.join(dir,`${id}.claim.json`),'{}');
  assert.equal((await receipt(root,c.session,id)).state,'outcome_unknown');
  await fs.writeFile(path.join(dir,`${id}.response.json`),JSON.stringify({id,ok:true,result:{state:'submitted'}}));
  assert.equal((await request(root,input)).result.state,'submitted');
  assert.equal((await fs.readdir(dir)).filter(x=>x.endsWith('.request.json')).length,1);
});
test('MCP errors are explicit; initialization and tool discovery need no live connection',async()=>{
  assert.equal((await rpc('/offline',{id:1,method:'initialize'})).result.serverInfo.name,'kda-dot-bridge');
  assert.equal((await rpc('/offline',{id:2,method:'tools/list'})).result.tools.length,4);
  assert.equal(await rpc('/offline',{method:'notifications/initialized'}),null);
  const r=await rpc('/offline',{id:3,method:'tools/call',params:{name:'kda_send',arguments:{}}});assert.equal(r.result.isError,true);
});
test('failed native receipts reach callers promptly as errors',async()=>{
  const {root,c,dir}=await fixture();const id=randomUUID();
  await fs.writeFile(path.join(dir,`${id}.response.json`),JSON.stringify({id,ok:false,error:'stop unconfirmed',result:{state:'failed'}}));
  const r=await rpc(root,{id:9,method:'tools/call',params:{name:'kda_stop',arguments:{session:c.session,conversationId:c.conversationId,requestId:id}}});
  assert.equal(r.result.isError,true);assert.match(r.result.content[0].text,/stop unconfirmed/);
});
test('MCP stdio subprocess returns discovery JSON without banners or account access',async()=>{
  const child=spawn(process.execPath,['scripts/dot-bridge.mjs','mcp','--root',path.join(os.tmpdir(),'kda-dot-offline')],{stdio:['pipe','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>{out+=b;});child.stderr.on('data',b=>{err+=b;});
  child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/list'})+'\n');
  const code=await new Promise(r=>child.on('close',r));assert.equal(code,0);assert.equal(err,'');assert.equal(JSON.parse(out).result.tools.length,4);
});

// Resolve the real JSX binding, including a shared object used by desktop and mobile.
async function appHandlers(deps: Record<string,unknown>) {
  const source=ts.createSourceFile('App.tsx',await fs.readFile(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let expression='';function walk(node: ts.Node) {
    if(ts.isJsxSelfClosingElement(node) && node.tagName.getText(source)==='AssistantWidget') {
      const prop=node.attributes.properties.find(p=>ts.isJsxAttribute(p) && p.name.getText(source)==='handlers') as ts.JsxAttribute;
      expression=(prop.initializer as ts.JsxExpression).expression!.getText(source);
    }ts.forEachChild(node,walk);
  }walk(source);assert.ok(expression);
  if (/^[A-Za-z_$][\w$]*$/.test(expression)) {
    const binding = expression; let initializer = '';
    function resolve(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === binding && node.initializer)
        initializer = node.initializer.getText(source);
      ts.forEachChild(node, resolve);
    }
    resolve(source); assert.ok(initializer, 'JSX handlers must resolve to a real App initializer'); expression = initializer;
  }
  const js=ts.transpile(`(${expression})`,{target:ts.ScriptTarget.ES2020});
  const scope={codexElicitations:[],...deps};
  return new Function(...Object.keys(scope),`return ${js}`)(...Object.values(scope));
}
test('actual App handlers pin target id and propagate an unconfirmed stop as failure',async()=>{
  const sent:any[]=[];let active=true;
  const control={runs:new Map(),paused:new Set(),allPaused:false,queues:new Map(),isActive:()=>active};
  const h=await appHandlers({conversationTurnGateRef:{current:control},handleSendMessage:async(...a:any[])=>{sent.push(a);},stopConversation:async()=>{},activeConversationIdRef:{current:'other-tab'},getMessagesForView:async()=>({messages:[]}),messagesRef:{current:[]}});
  await h.send('paired','hello','steer');assert.deepEqual(sent,[['hello',[],{conversationId:'paired',mode:'steer'}]]);
  await assert.rejects(h.stop('paired'),/정지 확인 실패/);
  active=false;control.paused.add('paired');await h.stop('paired');
});

test('desktop avatar and mobile bridge use the same actual App handler object', async () => {
  const source = ts.createSourceFile('App.tsx', await fs.readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bindings = new Map<string, string>();
  function walk(node: ts.Node) {
    if (ts.isJsxSelfClosingElement(node) && ['AssistantWidget', 'MobileDesktopBridge'].includes(node.tagName.getText(source))) {
      const prop = node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(source) === 'handlers') as ts.JsxAttribute;
      bindings.set(node.tagName.getText(source), (prop.initializer as ts.JsxExpression).expression!.getText(source));
    }
    ts.forEachChild(node, walk);
  }
  walk(source);
  assert.equal(bindings.size, 2); assert.equal(bindings.get('AssistantWidget'), bindings.get('MobileDesktopBridge'));
});
test('actual App status exposes only the pinned conversation and marks streaming output',async()=>{
  const control={runs:new Map(),paused:new Set(),allPaused:false,queues:new Map()};
  const h=await appHandlers({conversationTurnGateRef:{current:control},activeConversationIdRef:{current:'paired'},messagesRef:{current:[{id:'answer',role:'assistant',timestamp:1,streaming:true,content:'partial'}]},getMessagesForView:async()=>{throw Error('unexpected other-chat read');}});
  const s=await h.status('paired');assert.equal(s.conversationId,'paired');assert.equal(s.latestAssistant.streaming,true);assert.equal(s.latestAssistant.text,'partial');
});
test('actual App manual/global stop timestamps invalidate older queued voice work',async()=>{
  const h=await appHandlers({dotGlobalStopAtRef:{current:20},dotStoppedAtRef:{current:new Map([['paired',30]])}});
  assert.equal(h.canSend(req('send',{conversationId:'paired',createdAt:29})),false);
  assert.equal(h.canSend(req('send',{conversationId:'paired',createdAt:31})),true);
  assert.equal(h.canSend(req('send',{conversationId:'other',createdAt:19})),false);
});

test('actual voice global stop uses the same App stop handler without changing approvals',async()=>{
  let calls=0;
  const h=await appHandlers({handleHardStop:async()=>{calls++;}});
  await h.stopAll();assert.equal(calls,1);
});

test('actual status identifies pending approval only for the pinned conversation',async()=>{
  const control={runs:new Map(),paused:new Set(),allPaused:false,queues:new Map()};
  const h=await appHandlers({conversationTurnGateRef:{current:control},activeConversationIdRef:{current:'paired'},messagesRef:{current:[]},
    getMessagesForView:async()=>({messages:[]}),codexElicitations:[{conversation_id:'paired',expiresAt:Date.now()+60000}]});
  assert.equal((await h.status('paired')).approvalPending,true);
  assert.equal((await h.status('other')).approvalPending,false);
});
