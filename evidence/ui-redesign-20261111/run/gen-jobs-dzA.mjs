// usage: node gen-jobs-dzA.mjs <tag> <outdir> [set] > jobs.json   (dzA 캡처: 메인 3크기 · 호버/포커스 · 패널 · 메뉴 · classic · 다른 테마)
const [tag, dir, set = "all"] = process.argv.slice(2);
const base = "http://localhost:1499/?fixture=mockup&layout=o2";
const probe = `(()=>{const q=(s)=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.right),Math.round(r.bottom)]};const av=q('.companion-widget');const hits=['.main-header','.chat-notices--top','.chat-col','.composer'].filter(s=>{const a=q(s);return av&&a&&av[0]<a[2]&&av[2]>a[0]&&av[1]<a[3]&&av[3]>a[1]});return {font:document.fonts.check('16px "Pretendard Variable"'),hscroll:document.documentElement.scrollWidth>innerWidth,avatar:av,avatarOverlaps:hits,col:q('.chat-col'),notice:q('.chat-notices--top'),composer:q('.composer'),msgs:document.querySelectorAll('.chat-col > .msg').length}})()`;
const out = (n) => `${dir}/ui-${tag}-${n}-20261112.png`;
const hover = (sel, i = 0) => `(()=>{const e=document.querySelectorAll('${sel}')[${i}];const r=e.getBoundingClientRect();window.__hx=[r.left+r.width/2,r.top+r.height/2];return window.__hx})()`;
const jobs = [{ out: `${dir}/warm.png`, url: base, w: 1280, h: 800, wait: 5000 }];
if (set === "all" || set === "main") {
  jobs.push({ out: out("main"), url: base, w: 1280, h: 800, wait: 9000, probe });
  jobs.push({ out: out("main-1920"), url: base, w: 1920, h: 1080, wait: 9000, probe });
  jobs.push({ out: out("main-960"), url: base, w: 960, h: 640, wait: 9000, probe });
  jobs.push({ out: out("main-hover"), url: base, w: 1280, h: 800, wait: 9000, hover: hover('.sb-tree .explorer-conv', 3), probe });
  jobs.push({ out: out("focus"), url: base, w: 1280, h: 800, wait: 9000, tabs: 3, probe });
  jobs.push({ out: out("composer-focus"), url: base, w: 1280, h: 800, wait: 9000, pre: "document.querySelector('.composer textarea').focus()", probe });
}
if (set === "all" || set === "panel") {
  jobs.push({ out: out("session"), url: `${base}&panel=session`, w: 1280, h: 800, wait: 9000, probe });
  jobs.push({ out: out("session-1920"), url: `${base}&panel=session`, w: 1920, h: 1080, wait: 9000, probe });
  jobs.push({ out: out("tasks"), url: `${base}&panel=tasks`, w: 1280, h: 800, wait: 9000, probe });
  jobs.push({ out: out("menu"), url: base, w: 1280, h: 800, wait: 8000, pre: "document.querySelector('.chat-options > summary').click()", probe });
  jobs.push({ out: out("ctxmenu"), url: base, w: 1280, h: 800, wait: 8000, pre: "(()=>{const e=document.querySelectorAll('.sb-tree .explorer-conv')[3];const r=e.getBoundingClientRect();e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+60,clientY:r.top+20}))})()", probe });
  jobs.push({ out: out("mode-popover"), url: base, w: 1280, h: 800, wait: 8000, pre: "document.querySelector('.safety-chip-wrap--composer .ui-chip').click()", probe });
}
if (set === "all" || set === "themes") {
  jobs.push({ out: out("classic"), url: "http://localhost:1499/?fixture=mockup&layout=classic", w: 1280, h: 800, wait: 8000, probe });
  for (const t of ["terminal-phosphor", "glass-acrylic", "brutalist-bauhaus"])
    jobs.push({ out: out(`theme-${t}`), url: base, w: 1280, h: 800, wait: 8000, pre: `document.documentElement.setAttribute('data-theme','${t}')`, preWait: 1500, probe });
}
console.log(JSON.stringify(jobs));
