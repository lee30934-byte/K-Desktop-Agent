// Dev-only motion demo page: every mood animating live + scripted reactions (for video capture).
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';

const out = process.env.KDA_MOTION_DEMO;
if (!out) throw new Error('KDA_MOTION_DEMO is required');
mkdirSync(out, { recursive: true });
await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import Avatar from './src/components/CompanionAvatar';
    import {AVATAR_MOODS} from './src/components/AssistantAvatar';
    const MOODS=['idle','listening','speaking','thinking','working','connecting','muted','error'];
    function Demo(){
      const [hero,setHero]=useState({mood:'idle',style:'mint',label:'대기'});
      const [request,setRequest]=useState();
      window.demo={setHero,react:(frame)=>setRequest({frame,key:Date.now()})};
      return <div className="wrap">
        <section className="hero"><div className="big"><Avatar mood={hero.mood} motion style={hero.style} compact={false} expanded={false} request={request} onActivate={()=>{}}/></div>
          <div className="cap" data-testid="hero-cap">{hero.label}</div></section>
        <section className="grid">{MOODS.map(m=><figure key={m}><div className="cell"><Avatar mood={m} motion style="mint" compact={false} expanded={false} onActivate={()=>{}}/></div>
          <figcaption>{AVATAR_MOODS[m]}</figcaption></figure>)}</section>
        <section className="small"><div className="tiny"><Avatar mood="working" motion style="mint" compact expanded={false} onActivate={()=>{}}/></div><span>최소 크기 112px · 작업 중</span></section>
      </div>;
    }
    createRoot(document.getElementById('root')).render(<Demo/>);
  ` },
  bundle: true, format: 'iife', outfile: `${out}/demo.js`, loader: { '.png': 'file', '.webp': 'file' },
  assetNames: 'assets/[name]-[hash]', define: { 'process.env.NODE_ENV': '"production"' },
});
writeFileSync(`${out}/demo.html`, `<!doctype html><html lang="ko"><meta charset="utf-8"><title>KDA avatar motion demo</title>
<link rel="stylesheet" href="demo.css"><style>
*{box-sizing:border-box}body{margin:0;background:#10171f;color:#dfeeed;font:13px/1.5 "Segoe UI","Malgun Gothic",sans-serif;width:1280px;height:720px;overflow:hidden}
.wrap{display:grid;grid-template-columns:420px 1fr;grid-template-rows:1fr 120px;height:720px;padding:20px;gap:14px}
.hero{grid-row:1/3;background:radial-gradient(ellipse at 50% 45%,#254e4950,transparent 70%);border:1px solid #ffffff10;border-radius:22px;display:flex;flex-direction:column;align-items:center;justify-content:center}
.big .companion-avatar{width:360px;height:360px}.cap{margin-top:18px;color:#a9e3cf;font-size:18px;border:1px solid #a9e3cf30;border-radius:100px;padding:4px 20px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}figure{margin:0;background:#17212c;border:1px solid #ffffff0c;border-radius:16px;display:flex;flex-direction:column;align-items:center;justify-content:center}
.cell .companion-avatar{width:190px;height:190px}figcaption{color:#9fb6bc;font-size:12px;margin-top:2px}
.small{background:#17212c;border:1px solid #ffffff0c;border-radius:16px;display:flex;align-items:center;gap:16px;padding:0 20px}.tiny .companion-avatar{width:112px;height:112px}
</style><div id="root"></div><script src="demo.js"></script></html>`, 'utf8');
console.log(`${out}/demo.html`);
