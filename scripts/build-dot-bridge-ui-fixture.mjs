import { build } from 'esbuild';
await build({
  stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import DotBridgePanel from './src/components/DotBridgePanel';
    const root=createRoot(document.getElementById('root'));
    window.renderDotFixture=(conversationId)=>root.render(<DotBridgePanel conversationId={conversationId} handlers={{
      status:async id=>({conversationId:id,state:window.running?'running':'stopped'}),
      send:async(id,text,mode)=>{window.actions.push({id,text,mode});window.running=true;},
      stop:async id=>{window.actions.push({id,stop:true});await new Promise(r=>setTimeout(r,120));window.running=false;}
    }}/>);
    window.renderDotFixture('11111111-1111-4111-8111-111111111111');
  `},
  bundle:true,format:'iife',outfile:'evidence/dot-bridge-20261105/ui-fixture.js',
  define:{'process.env.NODE_ENV':'"production"'},
  plugins:[{name:'fixture-tauri-only',setup(build){
    build.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'fixture',namespace:'mock'}));
    build.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const invoke=(command,args)=>window.dotInvoke(command,args);',loader:'js'}));
  }}],
});
