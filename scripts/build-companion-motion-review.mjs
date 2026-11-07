import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';

const out = process.env.KDA_MOTION_EVIDENCE || 'evidence/companion-articulation-20261106/motion-v1';
mkdirSync(out, { recursive: true });
await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import Avatar from './src/components/CompanionAvatar';
    import {AVATAR_MOODS} from './src/components/AssistantAvatar';
    function Review(){
      const [mood,setMood]=useState('idle'),[motion,setMotion]=useState(true),[request,setRequest]=useState();
      window.setMotionReviewMood=setMood;
      return <><header><div><small>K DESKTOP AGENT / MOTION STUDY</small><h1>고개를 기울이고, 이야기에 반응하고.</h1>
        <p>기존 세라믹 캐릭터에 머리와 몸통을 따로 움직이는 모션을 더했습니다.</p></div><span className="badge">개발 시안 · 설치 전</span></header>
        <main><section className="hero"><div className="stage" data-testid="hero-stage">
          <Avatar mood={mood} motion={motion} style="mint" compact={false} expanded={false} request={request} onActivate={()=>{}}/>
          <span className="state">{AVATAR_MOODS[mood]}</span></div>
          <div className="hint">캐릭터 위에서 커서를 움직여 보세요. 클릭하면 인사해요.</div></section>
        <section className="settings"><small>작은 움직임의 차이</small><h2>그림에 생기를 더하다</h2>
          <p>머리는 갸웃하고, 몸은 호흡하듯 움직여요. 듣고 말할 때는 서로 다른 리듬으로 반응합니다.</p>
          <label>미리보기 상태<select aria-label="미리보기 상태" value={mood} onChange={e=>setMood(e.target.value)}>
          {Object.entries(AVATAR_MOODS).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
          <label className="toggle"><span>움직임 켜기<small>OS의 동작 줄이기 설정을 함께 따릅니다.</small></span><input type="checkbox" checked={motion} onChange={e=>setMotion(e.target.checked)}/></label>
          <div className="reactions">{[{frame:4,label:'인사'},{frame:5,label:'기쁨'},{frame:2,label:'갸웃'},{frame:6,label:'졸기'}].map(r=><button key={r.frame} disabled={mood!=='idle'||!motion} onClick={()=>setRequest({frame:r.frame,key:Date.now()})}>{r.label}</button>)}</div>
          <a href="../ui-v1/review.html">실제 비서 메뉴와 함께 보기 →</a></section></main>
        <footer>기존 원본 이미지 + 실시간 2D 관절 모션 · 음소별 립싱크는 미구현 · 이 페이지는 마이크나 계정을 사용하지 않습니다.</footer></>;
    }
    createRoot(document.getElementById('root')).render(<Review/>);
  ` },
  bundle: true, format: 'iife', outfile: `${out}/review.js`, loader: { '.png': 'file', '.webp': 'file' },
  assetNames: 'assets/[name]-[hash]', define: { 'process.env.NODE_ENV': '"production"' },
});
writeFileSync(`${out}/review.html`, `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KDA · 생동감 있는 아바타</title><link rel="stylesheet" href="review.css"><style>
*{box-sizing:border-box}body{margin:0;background:#10171f;color:#edf4f3;font:14px/1.7 "Segoe UI","Malgun Gothic",sans-serif;padding:48px max(24px,calc((100vw - 1080px)/2))}header{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:32px}small{color:#a9e3cf;font-size:11px;letter-spacing:1px}h1{font-size:28px;letter-spacing:-1px;margin:8px 0}p{color:#a2b4bc;margin:8px 0}.badge{white-space:nowrap;border:1px solid #a9e3cf30;border-radius:100px;padding:6px 13px;color:#a9e3cf;font-size:11px}main{display:grid;grid-template-columns:1.1fr 1fr;border:1px solid #ffffff10;border-radius:28px;overflow:hidden;background:#17212c}.hero{background:radial-gradient(ellipse at 50% 48%,#254e493b,transparent 70%);padding:30px}.stage{height:380px;display:flex;align-items:center;justify-content:center;position:relative}.stage .companion-avatar{width:320px;height:320px}.state{position:absolute;bottom:0;color:#a9e3cf;font-size:12px;background:#a9e3cf0c;border:1px solid #a9e3cf20;padding:3px 14px;border-radius:100px}.hint{text-align:center;color:#82979f;font-size:11px;margin-top:26px}.settings{padding:42px 38px;border-left:1px solid #ffffff0b}h2{margin:8px 0 12px;font-size:23px;letter-spacing:-.7px}.settings p{font-size:13px;max-width:340px}label{display:block;margin:24px 0 0;font-size:12px;color:#d7e5e7}select{display:block;margin-top:8px;width:100%;background:#101922;color:#e0f1ee;border:1px solid #ffffff16;border-radius:10px;padding:11px;font:inherit}.toggle{display:flex;align-items:center;justify-content:space-between}.toggle small{display:block;color:#82979f;font-size:10px;letter-spacing:0;margin-top:3px}input{accent-color:#a9e3cf;width:17px;height:17px}.reactions{display:flex;gap:8px;margin-top:24px}.reactions button{flex:1;border:1px solid #ffffff13;background:#ffffff05;border-radius:10px;color:#bfd8d6;padding:9px;font:inherit;font-size:12px;cursor:pointer}.reactions button:hover{background:#a9e3cf15}.reactions button:disabled{opacity:.35;cursor:default}a{display:inline-block;margin-top:26px;color:#a9e3cf;text-decoration:none;font-size:12px}footer{font-size:11px;color:#718b94;margin-top:24px}@media(max-width:760px){body{padding:24px 16px}header{display:block}h1{font-size:23px}.badge{display:inline-block;margin-top:14px}main{grid-template-columns:1fr}.stage{height:300px}.stage .companion-avatar{width:260px;height:260px}.settings{border-left:0;border-top:1px solid #ffffff0b;padding:28px}.hero{padding:20px}.hint{margin-top:18px}}
</style><div id="root"></div><script src="review.js"></script></html>`, 'utf8');
console.log(`${out}/review.html`);
