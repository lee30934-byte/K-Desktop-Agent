import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
const out = 'evidence/mobile-companion-20261106/ui-v1';
mkdirSync(out, { recursive: true });
const bridge = `
  const handlers=new Set(); let seq=0;
  setInterval(async()=>{try{const r=await fetch('/fixture/events?after='+seq);const v=await r.json();seq=v.cursor;for(const e of v.events)for(const h of handlers)h({payload:e});}catch{}},80);
  export async function listen(_name,handler){handlers.add(handler);return()=>handlers.delete(handler);}
  export async function invoke(command,args){if(!['mobile_control','voice_control'].includes(command))throw Error('fixture blocks native '+command);const r=await fetch('/fixture/native',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command,args})});if(!r.ok)throw Error('fixture invocation failed');}
`;
await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
  import React from 'react'; import {createRoot} from 'react-dom/client';
  import MobileDesktopBridge from './src/components/MobileDesktopBridge';
  import MobileSettings from './src/components/MobileSettings';
  const one='11111111-1111-4111-8111-111111111111',two='22222222-2222-4222-8222-222222222222';
  const conversations=[{id:one,title:'KDA 개발',provider:'claude',model:'fixture-claude',lastActive:0,messageCount:0},{id:two,title:'설계 검토',provider:'codex',model:'fixture-codex',lastActive:0,messageCount:0}];
  window.fixtureTrace=[];let answer='PC의 최근 결과 · 대화별 설정 유지',run=null,paused=false;
  const handlers={status:async id=>({conversationId:id,run,queued:0,paused,approvalPending:answer.includes('승인'),latestAssistant:{text:answer,streaming:false}}),
    send:async(id,text,mode)=>{window.fixtureTrace.push({action:'send',id,text,mode});answer='모의 PC 결과: '+text;run={state:'running'};},
    stop:async id=>{window.fixtureTrace.push({action:'stop',id});run=null;paused=true;}};
  createRoot(document.getElementById('root')).render(<><h1>격리된 PC 연결 검증</h1><p>실제 DB·모델·장치 접근 없음</p><MobileDesktopBridge conversations={conversations} handlers={handlers}/><MobileSettings/></>);
` }, bundle: true, format: 'esm', outfile: `${out}/desktop.js`,
  plugins: [{ name: 'isolated-native', setup(b) {
    b.onResolve({ filter: /^@tauri-apps\/api\/(core|event)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: bridge, loader: 'js' }));
  } }], define: { 'process.env.NODE_ENV': '"production"' } });
writeFileSync(`${out}/desktop.html`, '<!doctype html><html lang="ko"><meta charset="utf-8"><title>Mobile isolated desktop fixture</title><style>body{font:15px/1.7 Segoe UI,sans-serif;margin:40px;max-width:800px;background:#15242d;color:#ecf6f4}button,input{font:inherit;padding:10px;border-radius:8px}button{cursor:pointer}code{background:#29434a;padding:10px;display:block}</style><div id="root"></div><script type="module" src="desktop.js"></script></html>');
console.log(out);
