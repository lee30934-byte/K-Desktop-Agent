import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const out = 'evidence/avatar-motion-20261106';
mkdirSync(out, { recursive: true });
await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
  import React,{useState} from 'react';
  import {createRoot} from 'react-dom/client';
  import Avatar,{AVATARS,AVATAR_MOODS} from './src/components/AssistantAvatar';
  function Gallery(){const [mood,setMood]=useState('idle'),[motion,setMotion]=useState(true);
    return <><header><div><small>K DESKTOP AGENT / AVATAR STUDIO</small><h1>곁에서 기다리는 작은 비서</h1>
      <p>누르면 인사 → 하트 → 갸웃 → 졸기. 통화와 작업 상태에 맞춰 표정이 바뀝니다.</p></div>
      <div className="controls"><label>상태 <select aria-label="미리보기 상태" value={mood} onChange={e=>setMood(e.target.value)}>{Object.entries(AVATAR_MOODS).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
      <label><input type="checkbox" checked={motion} onChange={e=>setMotion(e.target.checked)}/> 움직임 켜기</label></div></header>
      <main>{AVATARS.map(a=><article key={a.id}><div className="stage"><Avatar kind={a.id} mood={mood} motion={motion}/></div>
        <div className="caption"><div><h2>{a.name}</h2><p>{a.note}</p></div><span>{AVATAR_MOODS[mood]}</span></div></article>)}</main>
      <footer>앱에 포함되는 실제 SVG 컴포넌트 · 외부 이미지 다운로드 없음 · 모션 끄기 및 OS 동작 줄이기 지원<br/>
      <a href="ui/review.html">실제 비서 패널 시안 보기 →</a> <span>개발 시안 / 설치·배포 전</span></footer></>;
  }createRoot(document.getElementById('root')).render(<Gallery/>);
` }, bundle: true, format: 'iife', outfile: `${out}/gallery.js`, define: { 'process.env.NODE_ENV': '"production"' } });
const tokens = readFileSync('src/index.css', 'utf8').split(':root {')[1].split('\n}')[0];
writeFileSync(`${out}/review.html`, `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>KDA 아바타 · 모션 미리보기</title><link rel="stylesheet" href="gallery.css"><style>:root{${tokens}}
*{box-sizing:border-box}body{margin:0;background:var(--bg-1);color:var(--text-primary);font:14px/1.7 var(--font-body);padding:44px max(24px,calc((100vw - 1100px)/2))}
header{display:flex;justify-content:space-between;gap:24px;align-items:center;margin-bottom:34px}header small{color:var(--accent);font-size:10px;letter-spacing:2px}h1{font-size:27px;margin:8px 0}p{margin:0;color:var(--text-secondary)}.controls{display:grid;gap:12px;font-size:12px;flex-shrink:0}select{background:var(--bg-3);color:var(--text-primary);padding:7px;border:1px solid var(--border-default);border-radius:8px}
main{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px}article{background:var(--bg-2);border:1px solid var(--border-subtle);border-radius:24px;overflow:hidden}.stage{height:250px;display:grid;place-items:center;background:radial-gradient(ellipse at center,var(--accent-glow),transparent 75%)}.stage .assistant-avatar{width:180px;height:200px}.caption{padding:22px;border-top:1px solid var(--border-subtle)}h2{font-size:17px;margin:0 0 2px}.caption p{font-size:11px}.caption span{display:block;color:var(--accent);font-size:10px;margin-top:14px}
footer{font-size:11px;color:var(--text-secondary);margin-top:28px}footer a{display:inline-block;margin-top:14px;color:var(--accent)}footer span{float:right}@media(max-width:900px){main{grid-template-columns:repeat(2,minmax(0,1fr))}header{display:block}.controls{margin-top:20px}}@media(max-width:420px){body{padding:20px}main{gap:10px}.stage{height:175px}.stage .assistant-avatar{width:130px;height:150px}.caption{padding:15px}}
</style><div id="root"></div><script src="gallery.js"></script></html>`);
console.log(`${out}/review.html`);
