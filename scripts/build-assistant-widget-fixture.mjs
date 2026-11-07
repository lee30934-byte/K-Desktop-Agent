import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const evidence = process.env.KDA_WIDGET_EVIDENCE || 'evidence/assistant-widget-20261105';
mkdirSync(evidence, { recursive: true });
mkdirSync(`${evidence}/audio`, { recursive: true });
copyFileSync('public/audio/voicePitch.worklet.mjs', `${evidence}/audio/voicePitch.worklet.mjs`);
await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import AssistantWidget from './src/components/AssistantWidget';
    import CompanionAvatar from './src/components/CompanionAvatar';
    import { setVoiceLevelSource } from './src/voiceLevel';
    window.fixtureLevel=null;
    window.setFixtureLevel=v=>{window.fixtureLevel=v;if(v===null){window.releaseFixtureLevel?.();window.releaseFixtureLevel=null;}else if(!window.releaseFixtureLevel)window.releaseFixtureLevel=setVoiceLevelSource(()=>window.fixtureLevel??0);};
    window.actions=[];window.requests=[];window.replies=[];window.running=false;
    window.info={enabled:false,conversationId:null,session:null,root:'C:/fixture/dot-bridge',adapterPath:null};
    window.dotInvoke=async(command,args)=>{
      if(command==='voice_control'){
        window.actions.push({voice:args.action,...args});
        if(args.action==='list')queueMicrotask(()=>window.voiceListener?.({payload:{type:'voice_event',kind:'voices',sessionId:args.sessionId,
          ...(window.voiceCatalogError?{message:'fixture catalog unavailable'}:{voices:window.voiceCatalog??['marin','cedar','coral']})}}));
        return;
      }
      if(command==='dot_bridge_info')return {...window.info};
      if(command==='dot_bridge_pair'){
        window.info=args.conversationId?{...window.info,enabled:true,conversationId:args.conversationId,
          session:'22222222-2222-4222-8222-222222222222',adapterPath:'C:/fixture/adapter.mjs'}:
          {...window.info,enabled:false,conversationId:null,session:null};
        return {...window.info};
      }
      if(command==='dot_bridge_poll')return window.requests.splice(0);
      if(command==='dot_bridge_reply'){window.replies.push(args);return null;}
      if(command==='open_external_webview'){
        window.actions.push({open:args.url});
        if(window.failOpen)throw Error('fixture open failure');
        return;
      }
      throw Error('unexpected command: '+command);
    };
    const root=createRoot(document.getElementById('widget-root'));
    window.renderAssistantFixture=(id='11111111-1111-4111-8111-111111111111',empty=false,working=false)=>root.render(
      <AssistantWidget conversationId={id} computerConnected={true} runningIds={new Set(working?[id]:[])}
        conversations={empty?[]:[{id:'11111111-1111-4111-8111-111111111111',title:'비서 화면 디자인',lastActive:3},
          {id:'telegram-fixture',title:'Telegram 원격 대화',lastActive:2},
          {id:'release-fixture',title:'KDA 연결 상태 점검',lastActive:1}]}
        messages={empty?[]:[{id:'answer-1',role:'assistant',timestamp:1,content:'오른쪽 비서 패널을 준비했습니다. 상단을 드래그해 이동하고 작은 단축창으로 최소화할 수 있어요.'}]}
        onSelect={id=>window.actions.push({select:id})} onSettings={()=>window.actions.push({settings:true})}
        handlers={{status:async id=>({conversationId:id,state:window.running?'running':'stopped'}),
          send:async(id,text,mode)=>{window.actions.push({id,text,mode});window.running=true;},
          stop:async id=>{window.actions.push({id,stop:true});window.running=false;},
          stopAll:async()=>{window.actions.push({stopAll:true});window.running=false;}}}/>);
    window.renderAssistantFixture();
    // Standalone avatars for per-state/per-tone checks (not part of the product UI).
    let galleryRoot=null;
    window.renderAvatarGallery=(items,compact=false)=>{
      let host=document.getElementById('avatar-gallery');
      if(!host){host=document.createElement('div');host.id='avatar-gallery';document.body.appendChild(host);galleryRoot=createRoot(host);}
      galleryRoot.render(<div className="gallery">{items.map((it,i)=><figure key={i} data-item={i}><CompanionAvatar mood={it.mood} motion={it.motion??true} style={it.style??'mint'} compact={compact} expanded={false} request={it.request} onActivate={()=>{}}/><figcaption>{it.label??(it.mood+' · '+(it.style??'mint'))}</figcaption></figure>)}</div>);
    };
  ` },
  bundle: true, format: 'iife', outfile: `${evidence}/widget-fixture.js`, loader: { '.png': 'file', '.webp': 'file' },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'native-fixture', setup(build) {
    build.onResolve({filter:/^@tauri-apps\/api\/event$/},()=>({path:'event',namespace:'mock-event'}));
    build.onLoad({filter:/.*/,namespace:'mock-event'},()=>({contents:'const listeners=new Set();window.voiceListener=e=>listeners.forEach(fn=>fn(e));export const listen=async(name,fn)=>{listeners.add(fn);return()=>listeners.delete(fn)};',loader:'js'}));
    build.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'fixture',namespace:'mock'}));
    build.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const invoke=(command,args)=>window.dotInvoke(command,args);',loader:'js'}));
  }}],
});
const tokens = readFileSync('src/index.css', 'utf8').split(':root {')[1].split('\n}')[0];
writeFileSync(`${evidence}/review.html`, `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KDA 비서 패널 · 개발 시안</title><style>:root {${tokens}\n}
*{box-sizing:border-box}body{margin:0;background:var(--bg-1);color:var(--text-primary);font:14px/1.6 var(--font-body)}
.shell{display:grid;grid-template-columns:224px 1fr;height:100vh;padding:12px;gap:12px}.sidebar,.chat{border:1px solid var(--border-subtle);border-radius:12px;background:var(--bg-2)}
.sidebar{padding:24px 16px}.brand{font:700 18px var(--font-display);color:var(--accent)}.caption{color:var(--text-secondary);font-size:11px}.new{margin:28px 0;padding:10px;border:1px solid var(--border-default);border-radius:8px;color:var(--accent)}
.item{padding:10px 8px;color:var(--text-secondary)}.item.active{background:var(--accent-glow);color:var(--accent);border-radius:6px}.main-chat{display:flex;flex-direction:column;min-width:0}.top{padding:18px 24px;border-bottom:1px solid var(--border-subtle)}
.messages{flex:1;overflow:auto;padding:var(--space-lg) var(--space-xl)}.messages>.bubble{max-width:760px}.bubble{padding:18px 22px;background:var(--bg-3);border-radius:14px;margin-bottom:28px}.bubble.user{margin-left:60px;background:var(--accent-glow)}.agent{color:var(--accent);font-size:11px;margin-bottom:8px}
.composer-wrapper{margin:0 var(--space-xl) var(--space-xl)}.composer{border:1px solid var(--border-default);border-radius:12px;padding:18px;color:var(--text-secondary)}.composer span{float:right;color:var(--accent)}.footer{margin-top:12px;font-size:11px;color:var(--text-secondary)}
@media(max-width:720px){.shell{grid-template-columns:1fr}.sidebar{display:none}}
#avatar-gallery{position:fixed;inset:0;z-index:100;background:#11161d;overflow:auto;padding:24px}#avatar-gallery:empty{display:none}.gallery{display:flex;flex-wrap:wrap;gap:28px 18px}.gallery figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:6px;padding:40px 8px 8px;border:1px solid #ffffff10;border-radius:12px}.gallery figcaption{font-size:11px;color:var(--text-secondary)}
</style><link rel="stylesheet" href="widget-fixture.css">
<div class="shell"><nav class="sidebar"><div class="brand">K DESKTOP AGENT</div><div class="caption">PERSONAL ASSISTANT</div><div class="new">＋ 새 대화</div><div class="caption">프로젝트</div><div class="item active">KDA 개발 / 릴리스</div><div class="item">Telegram</div><br><div class="caption">최근 대화</div><div class="item">비서 화면 디자인</div><div class="item">KDA 연결 상태 점검</div></nav>
<main class="main-chat"><div class="top">비서 화면 디자인 <div class="caption">개발 시안 · 연결 상태와 대화는 예시 데이터</div></div><div class="messages"><div class="bubble user">메인화면 우측에 두고 움직일 수 있게, 최소화 단축창도 만들어줘.</div><div class="bubble"><div class="agent">K 비서</div>오른쪽 비서 카드를 준비했습니다.<br>상단을 잡아 원하는 곳으로 이동하고,<br>− 버튼으로 작게 접어둘 수 있어요.<div class="footer">통화하기 · Telegram · 연결 컴퓨터 · 최근 활동 · 결과물</div></div></div><div class="composer-wrapper"><div class="composer">메시지를 입력하세요 <span>↑</span></div></div></main></div>
<div id="widget-root"></div><script src="widget-fixture.js"></script></html>`, 'utf8');
console.log(`${evidence}/review.html`);
