import { build } from 'esbuild';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
const out = process.env.KDA_SIMPLE_UI_EVIDENCE || 'evidence/simple-ui-20261106';
mkdirSync(out, { recursive: true });
mkdirSync(`${out}/audio`, { recursive: true });
copyFileSync('public/audio/voicePitch.worklet.mjs', `${out}/audio/voicePitch.worklet.mjs`);
await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import Sidebar from './src/components/Sidebar';
    import MainChat from './src/components/MainChat';
    import AssistantWidget from './src/components/AssistantWidget';
    import './src/index.css';
    import './src/App.css';
    window.actions=[];window.requests=[];window.replies=[];
    window.info={enabled:false,conversationId:null,session:null,root:'fixture',adapterPath:null};
    window.fixtureInvoke=async(command,args)=>{
      if(command==='voice_control'){window.actions.push({voice:args.action,sessionId:args.sessionId});return;}
      if(command==='dot_bridge_info')return {...window.info};
      if(command==='dot_bridge_pair')return window.info=args.conversationId?
        {...window.info,enabled:true,conversationId:args.conversationId,session:'fixture-session',adapterPath:'fixture'}:
        {...window.info,enabled:false,conversationId:null,session:null};
      if(command==='dot_bridge_poll')return window.requests.splice(0);
      if(command==='dot_bridge_reply'){window.replies.push(args);return;}
      throw Error('Unexpected native operation: '+command);
    };
    const conversations=[{id:'design',title:'KDA 화면 개선',lastActive:3,createdAt:1},
      {id:'other',title:'다른 대화',lastActive:2,createdAt:1}];
    const messages=[{id:'u1',role:'user',timestamp:1,content:'자주 쓰는 기능만 보여주고 나머지는 접어두자.'},
      {id:'a1',role:'assistant',timestamp:2,content:'통화와 현재 작업은 바로 보고, 활동과 설정은 필요할 때 펼칠 수 있습니다.'},
      {id:'t1',role:'tool',timestamp:3,toolName:'Read',toolOutput:'fixture tool result',content:'fixture tool result'}];
    const handlers={status:async id=>({conversationId:id,run:null,queued:0}),
      send:async(id,text,mode)=>window.actions.push({id,text,mode}),stop:async id=>window.actions.push({stop:id})};
    const root=createRoot(document.getElementById('root'));
    window.renderSimpleUI=(id='design')=>root.render(<div className="app">
      <Sidebar conversations={conversations} folders={[]} activeConversationId={id} mcpConnected
        onSelectConversation={id=>window.actions.push({select:id})} onNewConversation={()=>{}}
        onOpenSettings={()=>window.actions.push({settings:true})}/>
      <MainChat conversationId={id} messages={messages} status="connected" isStreaming={false}
        onSendMessage={async text=>{window.actions.push({text})}} onInterrupt={()=>{}}
        activityPanel={<AssistantWidget conversationId={id} conversations={conversations} messages={messages}
          runningIds={new Set()} computerConnected handlers={handlers}
          onSelect={id=>window.actions.push({select:id})} onSettings={()=>window.actions.push({settings:true})}/>}/>
    </div>);
    window.renderSimpleUI();
  ` }, bundle: true, format: 'iife', outfile: `${out}/simple-ui.js`, loader: { '.png': 'file' },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{name:'isolated-native',setup(b){
    b.onResolve({filter:/^@tauri-apps\//},a=>({path:a.path,namespace:'fixture-native'}));
    b.onLoad({filter:/.*/,namespace:'fixture-native'},a=>{
      const modules={
        '@tauri-apps/api/core':'export const invoke=(c,a)=>window.fixtureInvoke(c,a);export const convertFileSrc=()=>"fixture-blocked:";',
        '@tauri-apps/api/event':'export const listen=async(n,f)=>{window.voiceListener=f;return()=>{window.voiceListener=null}};',
        '@tauri-apps/api/app':'export const getVersion=async()=>"0.7.72";',
        '@tauri-apps/plugin-dialog':'export const save=async()=>null;export const open=async()=>null;',
        '@tauri-apps/plugin-shell':'export const open=async url=>window.actions.push({url});',
        '@tauri-apps/plugin-fs':'export const readTextFile=async()=>{throw Error("fixture read blocked")};export const readFile=readTextFile;',
        '@tauri-apps/plugin-sql':'export default {load:async()=>{throw Error("fixture database blocked")}};',
      };
      if(!modules[a.path])throw Error('Unmocked native module: '+a.path);
      return {contents:modules[a.path],loader:'js'};
    });
  }}],
});
writeFileSync(`${out}/review.html`, `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KDA UI 개선 · 예시 데이터</title><link rel="stylesheet" href="simple-ui.css"><div id="root"></div><script src="simple-ui.js"></script></html>`);
console.log(`${out}/review.html`);
