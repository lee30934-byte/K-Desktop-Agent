import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramHub, ABSENCE_DIGEST_WINDOW_MS, APPROVAL_TIMEOUT_MS, type HubSettings } from '../src/telegramHub.ts';
import { FollowUpRegistry, ROUTER_FOLLOWUP_MS } from '../src/telegramRouter.ts';
import { restoreAbsence, formatRemoteQuestions } from '../src/telegramAbsence.ts';
import { RemoteApprovalDispatcher } from '../src/remoteApproval.ts';
import type { ApprovalRequest, ApprovalReply } from '../src/approvalAutomation.mjs';

const CHAT='7203583138', OTHER='12345678', ID='dddd1111-not-a-route', HOUR=3600000;
const drain=async()=>{ for(let i=0;i<8;i++) await Promise.resolve(); };
function fixture(store=new Map<string,string>()) {
  let now=Date.now(), mid=100;
  let allowed=true, failStore=false, failSend=false;
  let sendGate: Promise<void> | undefined;
  let active=[{convId:ID,label:'Existing desktop work'}];
  const sent:Array<{method:string; payload:any; mid:number}>=[];
  const turns:Array<{id:string;text:string}>=[];
  const timers:Array<{at:number;fn:()=>void}>=[];
  const settings:HubSettings={ routing:true,digest:true,buttons:true,progress:true,inbox:true,approvals:true,
    quiet:{enabled:true,startHour:23,endHour:7},pcName:'' };
  const hub=new TelegramHub({
    api:{call:async(method,payload)=>{if(sendGate)await sendGate;if(failSend)throw Error('offline'); const id=++mid;
      sent.push({method,payload,mid:id});return {ok:true,result:{message_id:id}};},
      sendFile:async()=>({}), download:async()=>'', oneshot:async()=>'{"pick":0,"confidence":1}'},
    startTurn:async(id,text)=>{turns.push({id,text});}, targets:()=>[],
    defaultTarget:()=>({convId:'default1',label:'Telegram'}), settings:()=>settings,
    now:()=>now,log:()=>{}, store:{get:k=>store.get(k)??null,set:(k,v)=>{if(failStore)throw Error('quota');store.set(k,v);}},
    activeConversations:()=>active, allowedChat:chat=>allowed&&chat===CHAT,
    setTimeout:(fn,ms)=>{timers.push({at:now+ms,fn});return 0;},
  });
  return {hub,store,sent,turns,settings,
    active:(v:typeof active)=>{active=v;}, allowed:(v:boolean)=>{allowed=v;},
    failStore:(v:boolean)=>{failStore=v;},failSend:(v:boolean)=>{failSend=v;},
    delaySend:(v:Promise<void>)=>{sendGate=v;},
    advance:(ms:number)=>{now+=ms;for(const t of timers.splice(0))if(t.at<=now)t.fn();else timers.push(t);},
    now:()=>now, setNow:(ms:number)=>{now=ms;},
    text:()=>sent.filter(s=>s.method==='sendMessage').map(s=>String(s.payload.text)),
    msg:async(text:string,reply?:number,chat=CHAT)=>hub.handleUpdate({update_id:1,message:{chat:{id:Number(chat)},text,
      ...(reply===undefined?{}:{reply_to_message:{message_id:reply}})}}),
    click:async(data:string,messageId:number,chat=CHAT)=>hub.handleUpdate({update_id:2,callback_query:{id:'cq',data,
      message:{message_id:messageId,chat:{id:Number(chat)}}}}),
  };
}
const request=(patch:Partial<ApprovalRequest>={}):ApprovalRequest=>({type:'codex_approval_request',id:'turn',
  token:'rpc-secret',threadId:'thread',turnId:'engine-turn',itemId:'item',kind:'command',
  command:['echo','safe'],cwd:'C:/test',conversation_id:ID,expiresAt:Date.now()+120000,...patch} as ApprovalRequest);

test('default OFF, explicit 36h freezes existing desktop work and persists across restart',async()=>{
  const t=fixture(); assert.equal(t.hub.chatFor(ID,t.now()),undefined);
  await t.msg('/부재 36');
  assert.equal(t.hub.chatFor(ID,t.now()),CHAT);
  t.active([{convId:'new-work',label:'New work'}]);
  assert.equal(t.hub.chatFor('new-work',t.now()),undefined);
  for(const hours of [7,24,27,35]){
    const restarted=fixture(t.store); restarted.setNow(t.now()+hours*HOUR);
    assert.equal(restarted.hub.chatFor(ID,restarted.now()),CHAT,`${hours}h restored`);
  }
  assert.equal(t.hub.chatFor(ID,t.now()+36*HOUR),undefined);
});

test('recommended-progress instruction is limited to subscribed work/time and preserves approval exceptions',async()=>{
  const t=fixture();assert.equal(t.hub.instructionFor(ID,t.now()),'');await t.msg('/부재 36');
  assert.match(t.hub.instructionFor(ID,t.now()),/이미 승인한 이 대화의 작업만/);
  assert.match(t.hub.instructionFor(ID,t.now()),/미응답은 승인으로 해석하지 않는다/);
  assert.equal(t.hub.instructionFor('unrelated',t.now()),'');assert.equal(t.hub.instructionFor(ID,t.now()+36*HOUR),'');
  t.allowed(false);assert.equal(t.hub.instructionFor(ID,t.now()),'');
});

test('absence batches completion notices while decisions and failures stay immediate',async()=>{
  assert.equal(ABSENCE_DIGEST_WINDOW_MS,10*60*1000);
  const t=fixture();await t.msg('/부재 36');
  await t.hub.deliverResult({convId:ID,chatId:CHAT,text:'첫 작업이 완료되었습니다.'});
  await t.hub.deliverResult({convId:ID,chatId:CHAT,text:'두 번째 작업도 완료되었습니다.'});
  assert.equal(t.text().filter(x=>x.includes('부재중 작업 요약')).length,0);
  t.advance(ABSENCE_DIGEST_WINDOW_MS);
  await drain();
  const digest=t.text().find(x=>x.includes('부재중 작업 요약'))!;
  assert.match(digest,/2건/);assert.match(digest,/첫 작업/);assert.match(digest,/두 번째 작업/);
  await t.hub.deliverResult({convId:ID,chatId:CHAT,text:'결정이 필요합니다.\n1. 보류\n2. 진행\n번호로 선택해 주세요.'});
  assert.match(t.text().at(-1)!,/❓/);
  assert.match(t.text().at(-2)!,/부재중 작업 요약/);
});

test('invalid duration, corrupt/future state, deleted chat and OFF fail closed',async()=>{
  const t=fixture(); await t.msg('/부재 49'); assert.equal(t.hub.chatFor(ID,t.now()),undefined);
  await t.msg('/부재 36'); t.allowed(false); assert.equal(t.hub.chatFor(ID,t.now()),undefined);
  t.allowed(true); await t.msg('/부재 종료'); assert.equal(fixture(t.store).hub.chatFor(ID,t.now()),undefined);
  assert.equal(restoreAbsence({chatId:CHAT,startedAt:t.now()+1,until:t.now()+HOUR,targets:[]},t.now()),null);
  assert.equal(restoreAbsence({chatId:CHAT,startedAt:t.now(),until:t.now()+49*HOUR,targets:[]},t.now()),null);
  assert.equal(restoreAbsence({chatId:'bad',startedAt:t.now(),until:t.now()+HOUR,targets:[]},t.now()),null);
  const broken=new Map([['kda_tg_hub_absence','{bad']]); assert.equal(fixture(broken).hub.chatFor(ID,t.now()),undefined);
});

test('absence persistence failure is visible, not reported as restart-ready',async()=>{
  const t=fixture();t.failStore(true);await t.msg('/부재 36');assert.match(t.text().at(-1)!,/저장 실패/);
});

test('followup 24h/47h and registry recreation, expiry and malformed records',()=>{
  const now=Date.now(),r=new FollowUpRegistry();r.mark(ID,CHAT,now);
  const restored=FollowUpRegistry.fromJSON(JSON.parse(JSON.stringify(r.toJSON())),now+24*HOUR);
  assert.equal(restored.chatFor(ID,now+47*HOUR),CHAT);
  assert.equal(restored.chatFor(ID,now+ROUTER_FOLLOWUP_MS+1),undefined);
  assert.equal(FollowUpRegistry.fromJSON([[ID,{chatId:CHAT,until:NaN}]],now).size,0);
});

test('desktop decision outside routing list is immediate at night; reply/button returns to origin',async()=>{
  const t=fixture();await t.msg('/부재 36');
  t.setNow(new Date(2026,9,31,23,30).getTime());
  await t.hub.deliverResult({convId:ID,chatId:CHAT,text:'선택해 주세요.\n1. 보류\n2. 진행\n\n번호로 알려 주세요.'});
  const m=t.sent.filter(s=>s.method==='sendMessage').at(-1)!;
  assert.match(m.payload.text,/❓/);assert.equal(t.hub.heldCount,0);
  await t.msg('설명해주세요',m.mid);assert.equal(t.turns.at(-1)!.id,ID);
  const data=m.payload.reply_markup.inline_keyboard[1][0].callback_data;
  await t.click(data,m.mid);assert.deepEqual(t.turns.at(-1),{id:ID,text:'2'});
});

test('remote command approval verifies chat/message, only responds once and never starts a new turn',async()=>{
  const t=fixture(),dispatcher=new RemoteApprovalDispatcher(),responses:ApprovalReply[]=[];
  assert.equal(dispatcher.start(request(),CHAT,t.hub,()=>true,async r=>{responses.push(r);},()=>assert.fail()),true);
  assert.equal(dispatcher.start(request(),CHAT,t.hub,()=>true,async()=>assert.fail(),()=>assert.fail()),true);
  await drain(); const m=t.sent[0], data=m.payload.reply_markup.inline_keyboard[0][0].callback_data;
  await t.click(data,m.mid,OTHER);await drain();assert.equal(responses.length,0);
  await t.click(data,m.mid+99);await drain();assert.equal(responses.length,0);
  await t.click(data,m.mid);await drain();await t.click(data,m.mid);await drain();
  assert.equal(responses.length,1);assert.equal(responses[0].action,'accept');assert.equal(t.turns.length,0);
});

test('stopped/expired/resolved request cannot be accepted; timeout declines',async()=>{
  const t=fixture(),d=new RemoteApprovalDispatcher();let live=true;const replies:ApprovalReply[]=[];
  d.start(request(),CHAT,t.hub,()=>live,async r=>{replies.push(r);},()=>assert.fail());await drain();
  const m=t.sent[0]; live=false;await t.click(m.payload.reply_markup.inline_keyboard[0][0].callback_data,m.mid);await drain();
  assert.equal(replies[0].action,'decline');
  assert.equal(d.start(request({expiresAt:Date.now()-1}),CHAT,t.hub,()=>true,async()=>assert.fail(),()=>assert.fail()),false);
  d.start(request({token:'cancel'}),CHAT,t.hub,()=>true,async()=>assert.fail('resolved RPC sent twice'),()=>assert.fail());
  await drain();d.resolved('turn','cancel');await drain();
  d.start(request({token:'timeout'}),CHAT,t.hub,()=>true,async r=>{replies.push(r);},()=>assert.fail());
  await drain();t.advance(APPROVAL_TIMEOUT_MS+1);await drain();assert.equal(replies.at(-1)!.action,'decline');
});

test('MCP boolean approval preserves exact schema field',async()=>{
  const t=fixture(),d=new RemoteApprovalDispatcher(),replies:ApprovalReply[]=[];
  const r=request({type:'codex_elicitation_request',serverName:'test',message:'read permission',
    schema:{type:'object',properties:{confirm_read:{type:'boolean'}},required:['confirm_read']}} as any);
  d.start(r,CHAT,t.hub,()=>true,async r=>{replies.push(r);},()=>assert.fail());await drain();
  const m=t.sent[0];await t.click(m.payload.reply_markup.inline_keyboard[0][0].callback_data,m.mid);await drain();
  assert.deepEqual(replies,[{action:'accept',content:{confirm_read:true}}]);
});

test('structured decision input uses explicit JSON reply; invalid/other-chat input never approves',async()=>{
  const t=fixture(),d=new RemoteApprovalDispatcher(),replies:ApprovalReply[]=[];
  const r=request({type:'codex_elicitation_request',serverName:'test',message:'Pick a mode',
    schema:{type:'object',properties:{mode:{type:'string',enum:['a','b'],default:'a'}},required:['mode']}} as any);
  d.start(r,CHAT,t.hub,()=>true,async r=>{replies.push(r);},()=>assert.fail());await drain();
  const m=t.sent[0];assert.doesNotMatch(m.payload.text,/default/);
  await t.msg('{"mode":"b"}',m.mid,OTHER);await drain();assert.equal(replies.length,0);
  await t.msg('{"mode":"invalid"}',m.mid);await drain();assert.equal(replies.length,0);
  await t.msg('{"mode":"b"}',m.mid);await drain();assert.deepEqual(replies,[{action:'accept',content:{mode:'b'}}]);
});

test('restart does not resurrect old approval buttons or apply them to a new RPC',async()=>{
  const t=fixture();await t.msg('/부재 36'); const old=t.hub.requestApproval({convId:ID,chatId:CHAT,detail:'safe'});await drain();
  const m=t.sent.filter(x=>x.payload.reply_markup).at(-1)!, restarted=fixture(t.store);
  await restarted.click(m.payload.reply_markup.inline_keyboard[0][0].callback_data,m.mid);await drain();
  assert.match(restarted.sent.at(-1)!.payload.text,/만료/);assert.equal(restarted.turns.length,0);
  t.hub.cancelApproval(old.token,false);assert.equal(await old.result,false);
});

test('API failure declines safely; dispatch failure is surfaced',async()=>{
  const t=fixture();t.failSend(true);const d=new RemoteApprovalDispatcher();let failed=0;
  d.start(request(),CHAT,t.hub,()=>true,async r=>{assert.equal(r.action,'decline');throw Error('RPC offline');},()=>{failed++;});
  await drain();assert.equal(failed,1);
});

test('offline decision survives restart and retries immediately during quiet hours',async()=>{
  const t=fixture();await t.msg('/부재 36');t.failSend(true);
  await t.hub.deliverResult({convId:ID,chatId:CHAT,text:'승인 요청\n1. 진행\n2. 보류\n\n번호로 알려 주세요.'});
  assert.equal(JSON.parse(t.store.get('kda_tg_hub_outbox')!).length,1);
  const restarted=fixture(t.store);restarted.setNow(new Date(2026,9,31,23,30).getTime());
  await restarted.hub.tickDigest(CHAT);
  assert.match(restarted.text().at(-1)!,/❓/);
  assert.equal(JSON.parse(t.store.get('kda_tg_hub_outbox')!).length,0);
  await restarted.hub.tickDigest(CHAT);assert.equal(restarted.text().length,1,'not sent twice');
});

test('retries remain durable while API is offline, revoked destination is never sent',async()=>{
  const t=fixture();t.failSend(true);
  await t.hub.deliverResult({convId:ID,chatId:CHAT,forceSend:true,text:'⚠ 오류 확인 필요'});
  await t.hub.tickDigest(CHAT);assert.equal(JSON.parse(t.store.get('kda_tg_hub_outbox')!).length,1);
  t.failSend(false);t.allowed(false);await t.hub.tickDigest(CHAT);assert.equal(t.sent.length,0);
  t.allowed(true);await t.hub.tickDigest(CHAT);assert.equal(t.text().length,1);
});

test('critical-tool request retains its 30-second timeout; no approval at deadline',async()=>{
  const t=fixture();const p=t.hub.requestApproval({convId:ID,chatId:CHAT,detail:'critical',timeoutMs:30000});
  await drain();const m=t.sent[0];assert.match(m.payload.text,/30초/);t.advance(30000);
  await t.click(m.payload.reply_markup.inline_keyboard[0][0].callback_data,m.mid);assert.equal(await p.result,false);
});

test('turn completion cancels a background legacy confirmation; live reply reaches the exact request once',async()=>{
  const t=fixture(), d=new RemoteApprovalDispatcher(), replies:boolean[]=[];
  const req={id:'background-turn',token:'legacy-request',convId:ID,detail:'safe fixture'};
  assert.equal(d.startConfirmation(req,CHAT,t.hub,()=>true,async r=>{replies.push(r);},()=>assert.fail()),true);
  assert.equal(d.startConfirmation(req,CHAT,t.hub,()=>true,async()=>assert.fail('duplicate'),()=>assert.fail()),true);
  await drain();const m=t.sent[0];await t.click(m.payload.reply_markup.inline_keyboard[0][0].callback_data,m.mid);
  await drain();assert.deepEqual(replies,[true]);
  d.startConfirmation({...req,token:'cancelled'},CHAT,t.hub,()=>true,async()=>assert.fail('late RPC'),()=>assert.fail());
  await drain();d.resolvedTurn(req.id);await drain();assert.deepEqual(replies,[true]);
});

test('disabling remote approval after delivery declines both command and structured responses',async()=>{
  const t=fixture();const approval=t.hub.requestApproval({convId:ID,chatId:CHAT,detail:'fixture'});
  await drain();const m=t.sent[0];t.settings.approvals=false;
  await t.click(m.payload.reply_markup.inline_keyboard[0][0].callback_data,m.mid);assert.equal(await approval.result,false);
  t.settings.approvals=true;
  const input=t.hub.requestInput({convId:ID,chatId:CHAT,detail:'mode',schema:{type:'object',properties:{mode:{type:'string'}},required:['mode']}})!;
  await drain();const im=t.sent.filter(s=>s.method==='sendMessage').at(-1)!;t.settings.approvals=false;
  await t.msg('{"mode":"b"}',im.mid);assert.equal(await input.result,null);
});

test('structured input checks deadline even when timer has not fired',async()=>{
  const t=fixture();const p=t.hub.requestInput({convId:ID,chatId:CHAT,detail:'mode',timeoutMs:1000,
    schema:{type:'object',properties:{mode:{type:'string'}},required:['mode']}})!;
  await drain();const m=t.sent[0];t.setNow(t.now()+1000);
  await t.msg('{"mode":"b"}',m.mid);assert.equal(await p.result,null);
});

test('digest tick during a slow initial delivery does not send the same result twice',async()=>{
  const t=fixture();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});t.delaySend(gate);
  const delivery=t.hub.deliverResult({convId:ID,chatId:CHAT,forceSend:true,text:'⚠ slow fixture'});
  await drain();await t.hub.tickDigest(CHAT);release();await delivery;
  assert.equal(t.text().length,1);assert.equal(JSON.parse(t.store.get('kda_tg_hub_outbox')!).length,0);
});

test('phone diagnostic callback reports transport only and never launches a work turn',async()=>{
  const t=fixture();await t.msg('/부재검증');await drain();
  const m=t.sent.find(s=>s.payload.reply_markup)!;assert.match(m.payload.text,/명령·파일·전원 작업을 실행하지 않습니다/);
  await t.click(m.payload.reply_markup.inline_keyboard[0][0].callback_data,m.mid);await drain();
  assert.equal(t.turns.length,0);assert.ok(t.hub.recent.some(r=>r.kind==='ABSENCE-PROBE'&&r.detail==='PASS phone-callback'));
});

test('multiple model questions preserve their context and do not offer a misleading single-number button',async()=>{
  const text=formatRemoteQuestions([{question:'첫 질문',options:[{label:'하나',description:'설명'}]},
    {question:'둘째 질문',options:[{label:'둘'}]}])!;
  assert.match(text,/\[질문 1\] 첫 질문/);assert.match(text,/1\. 하나 — 설명/);assert.match(text,/\[질문 2\] 둘째 질문/);
  assert.equal(formatRemoteQuestions([{invalid:true}]),null);
  const t=fixture();await t.hub.deliverResult({convId:ID,chatId:CHAT,forceSend:true,noChoices:true,text:text+'\n1. a\n2. b'});
  assert.equal(t.sent[0].payload.reply_markup,undefined);
});

test('explicit decisions bypass absence batching and quiet hours with the decision icon',async()=>{
  const t=fixture();await t.msg('/부재 36');t.sent.length=0;
  t.setNow(new Date(2026,9,31,23,30).getTime());
  await t.hub.deliverResult({convId:ID,chatId:CHAT,decisionRequired:true,text:'실행에 필요한 정보가 없습니다. K 확인 필요'});
  assert.equal(t.text().length,1);assert.match(t.text()[0],/^❓/);
  assert.equal(t.hub.heldCount,0);assert.equal(JSON.parse(t.store.get('kda_tg_hub_absence_digest')??'null'),null);
});

test('absence autonomy excludes ordinary followups and stops on expiry, disabled chat or OFF',async()=>{
  const t=fixture();t.hub.followUps.mark(ID,CHAT,t.now());
  assert.equal(t.hub.activeAbsenceChatFor(ID,t.now()),undefined);
  await t.msg('/부재 36');assert.equal(t.hub.activeAbsenceChatFor(ID,t.now()),CHAT);
  assert.equal(t.hub.activeAbsenceChatFor('unsubscribed',t.now()),undefined);
  assert.equal(t.hub.activeAbsenceChatFor(ID,t.now()+36*HOUR),undefined);
  t.allowed(false);assert.equal(t.hub.activeAbsenceChatFor(ID,t.now()),undefined);
  t.allowed(true);await t.msg('/부재 종료');assert.equal(t.hub.activeAbsenceChatFor(ID,t.now()),undefined);
});

test('zero new targets never erase a live subscription or claim activation',async()=>{
  const empty=fixture();empty.active([]);await empty.msg('/부재 36');
  assert.match(empty.text().at(-1)!,/켜지 않았습니다/);
  const t=fixture();await t.msg('/부재 36');t.active([]);await t.msg('/부재 36');
  assert.equal(t.hub.activeAbsenceChatFor(ID,t.now()),CHAT);assert.match(t.text().at(-1)!,/기존 부재 연결/);
});

test('uncertain update notification is a warning and never launches a turn',async()=>{
  const t=fixture();assert.equal(await t.hub.notifyUncertainUpdate(CHAT,42),true);
  assert.match(t.text()[0],/#42/);assert.equal(t.turns.length,0);
  t.failSend(true);assert.equal(await t.hub.notifyUncertainUpdate(CHAT,42),false);
});
