import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
const out = process.env.KDA_VOICE_PROBE_OUT || 'evidence/voice-implementation-20261106';
mkdirSync(out, { recursive: true });
await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
  import {VoiceSession} from './src/voiceSession';
  window.views=[];window.actions=[];window.rawEvents=[];window.voiceReplies=[];window.fixtureRunning=true;window.fixtureQueued=0;
  window.voiceStart=async()=>{
    window.voice=new VoiceSession('11111111-1111-4111-8111-111111111111',{
      status:async id=>{window.actions.push({action:'status',id});return {conversationId:id,run:window.fixtureRunning?{state:'running'}:null,queued:window.fixtureQueued,paused:!window.fixtureRunning,latestAssistant:{id:'fixture-progress',timestamp:1,streaming:true,text:'기준 진행률 37%. 빌드 진행 중.'}}},
      send:async(id,text,mode)=>{window.actions.push({action:'send',id,text,mode});window.fixtureQueued++},
      stop:async id=>{window.actions.push({action:'stop',id});window.fixtureRunning=false},
      stopAll:async()=>{window.actions.push({action:'stop_all'})}
    },{
      listen:async handler=>{window.voiceEvent=handler;return()=>{window.voiceEvent=()=>{}}},
      start:async(id,conv,sdp)=>window.nativeStart(id,conv,sdp),
      stop:async id=>window.nativeStop(id),
      reply:async(id,token,result)=>{window.voiceReplies.push({token,result});return window.nativeReply(id,token,result)},
      speak:async(id,text)=>window.nativeSpeak(id,text)
    },view=>{window.views.push(view);document.getElementById('state').textContent=JSON.stringify(view)});
    await window.voice.start();
    if(window.voice.channel){
      window.voice.channel.addEventListener('message',e=>{try{const v=JSON.parse(e.data);window.rawEvents.push({type:v.type,sessionKeys:v.session?Object.keys(v.session):[],error:v.type==='error'?{code:v.error?.code,param:v.error?.param,message:v.error?.message}:null})}catch{}});
    }
  };
` }, bundle: true, format: 'esm', outfile: `${out}/voice-fixture.js` });
writeFileSync(`${out}/voice-fixture.html`, '<!doctype html><meta charset="utf-8"><title>KDA voice transport probe</title><pre id="state"></pre><script type="module" src="./voice-fixture.js"></script>');
