// Execute the actual App handler, extracted by TypeScript AST, with isolated transport/ref dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { TelegramHub } from '../src/telegramHub.ts';
import { RemoteApprovalDispatcher } from '../src/remoteApproval.ts';
import { formatRemoteQuestions } from '../src/telegramAbsence.ts';
import { automaticResponse } from '../src/approvalAutomation.mjs';

const source=ts.createSourceFile('App.tsx',readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let handler='';
function find(node:ts.Node):void {
  if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='handleSidecarEvent'&&node.initializer)handler=node.initializer.getText(source);
  ts.forEachChild(node,find);
}
find(source);assert.ok(handler);
const compiled=ts.transpileModule('const handle='+handler+';', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText+'\nreturn handle;';
const drain=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
const CHAT='7203583138',CONV='background-conversation',TURN='background-turn';
async function fixture(){
  const sent:any[]=[],rpc:any[]=[],notices:any[]=[],store=new Map<string,string>();let mid=100,live=true;
  const hub=new TelegramHub({api:{call:async(method,payload)=>{sent.push({method,payload,mid:++mid});return {ok:true,result:{message_id:mid}};},
    sendFile:async()=>({}),download:async()=>'',oneshot:async()=>''},
    startTurn:async()=>assert.fail('A permission response must not launch a new work turn'),targets:()=>[],defaultTarget:()=>({convId:'default',label:'Telegram'}),
    settings:()=>({routing:true,digest:true,buttons:true,progress:true,inbox:true,approvals:true,quiet:{enabled:false,startHour:23,endHour:7},pcName:''}),
    now:()=>Date.now(),log:()=>{},store:{get:k=>store.get(k)??null,set:(k,v)=>{store.set(k,v);}},
    activeConversations:()=>[{convId:CONV,label:'Background task'}],allowedChat:c=>c===CHAT,setTimeout:()=>0});
  await hub.handleUpdate({message:{chat:{id:CHAT},text:'/부재 36'}});sent.length=0;
  const refs={
    remoteApprovalRef:{current:new RemoteApprovalDispatcher()},taskWatchTurnsRef:{current:new Map()},
    telegramTurnsRef:{current:{touch:()=>{},get:()=>undefined}},turnToConvMap:{current:new Map([[TURN,CONV]])},
    conversationTurnGateRef:{current:{accepts:(c:string,t:string)=>live&&c===CONV&&t===TURN,runs:new Map([[CONV,{state:'running'}]])}},
    activeConversationIdRef:{current:'another-visible-conversation'},telegramHubRef:{current:hub},
    logger:{warn:()=>{}},saveControlNotice:(...a:any[])=>notices.push(a),
    formatRemoteQuestions,automaticResponse,readAutoApproval:()=>false,resolveEventConv:(e:any)=>e.conversation_id,
    invoke:async(...a:any[])=>{rpc.push(a);},setCodexElicitations:()=>assert.fail('Remote request fell through to desktop'),
  };
  const handle=new Function(...Object.keys(refs),compiled)(...Object.values(refs));
  return {handle,sent,rpc,notices,hub,stale:()=>{live=false;},click:async(m:any)=>{
    await hub.handleUpdate({callback_query:{id:'cq',data:m.payload.reply_markup.inline_keyboard[0][0].callback_data,
      message:{chat:{id:CHAT},message_id:m.mid}}});await drain();}};
}

test('actual App background legacy confirmation reaches phone before hidden-dialog guard and returns exact native id',async()=>{
  const t=await fixture();t.handle({type:'elicitation_request',id:'exact-legacy-id',turn_id:TURN,conversation_id:CONV,title:'fixture',message:'confirm'});
  await drain();const m=t.sent.find(x=>x.payload.reply_markup);assert.ok(m);await t.click(m);
  assert.deepEqual(t.rpc,[['elicitation_response',{id:'exact-legacy-id',confirmed:true}]]);
  await t.click(m);assert.equal(t.rpc.length,1);
});

test('actual App background model questions are sent as complete text without stealing visible dialog',async()=>{
  const t=await fixture();t.handle({type:'ask_user_question',id:TURN,conversation_id:CONV,
    questions:[{question:'Pick a mode',options:[{label:'A'},{label:'B'}]}]});
  await drain();const m=t.sent.find(x=>x.method==='sendMessage');assert.match(m.payload.text,/Pick a mode/);
  assert.equal(m.payload.reply_markup,undefined);assert.equal(t.rpc.length,0);assert.equal(t.notices.length,1);
});

test('actual App desktop-origin Codex approval returns exact thread/turn/item RPC once',async()=>{
  const t=await fixture();t.handle({type:'codex_approval_request',id:TURN,token:'exact-token',threadId:'thread-id',turnId:'engine-turn',
    itemId:'item-id',kind:'command',command:['echo','fixture'],cwd:'C:/fixture',conversation_id:CONV,expiresAt:Date.now()+120000});
  await drain();await t.click(t.sent.find(x=>x.payload.reply_markup));
  assert.deepEqual(t.rpc,[['codex_approval_response',{id:TURN,token:'exact-token',threadId:'thread-id',turnId:'engine-turn',itemId:'item-id',decision:'accept'}]]);
});

test('actual App rejects stale/cross-conversation events before any remote request',async()=>{
  const t=await fixture();t.handle({type:'elicitation_request',id:'r',turn_id:TURN,conversation_id:'wrong',title:'x',message:'x'});
  t.stale();t.handle({type:'elicitation_request',id:'r',turn_id:TURN,conversation_id:CONV,title:'x',message:'x'});
  await drain();assert.equal(t.sent.length,0);assert.equal(t.rpc.length,0);
});
