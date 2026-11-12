// usage: node gen-jobs-dzC.mjs <tag> <outdir> [set] > jobs.json   (dzC 캡처: 설정 9그룹 · 권한과 안전 3크기 · 호버/포커스 · 명령 팔레트 · ⋯ 메뉴 · 최종 점검 · 테마 · classic)
const [tag, dir, set = "all"] = process.argv.slice(2);
const G = ["general", "ai", "safety", "agent", "tools", "connect", "display", "data", "advanced"];
const base = "http://localhost:1499/?fixture=mockup&layout=o2";
const probe = `(()=>{const q=(s)=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.right),Math.round(r.bottom)]};const av=q('.companion-widget');const hits=['.main-header','.chat-notices--top','.chat-col','.composer'].filter(s=>{const a=q(s);return av&&a&&av[0]<a[2]&&av[2]>a[0]&&av[1]<a[3]&&av[3]>a[1]});const over=[...document.querySelectorAll('.settings-body *, .command-palette *, .chat-options-body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.right>innerWidth+1}).slice(0,4).map(e=>String(e.className).slice(0,40)+':'+Math.round(e.getBoundingClientRect().right));const emo=[...document.querySelectorAll('.settings-body, .command-palette, .chat-options-body')].map(e=>(e.innerText.match(/\\p{Extended_Pictographic}/gu)||[]).join('')).join('|');return {font:document.fonts.check('16px "Pretendard Variable"'),hscroll:document.documentElement.scrollWidth>innerWidth,avatarOverlaps:hits,msgs:document.querySelectorAll('.chat-col > *').length,over,emo}})()`;
const out = (n) => `${dir}/ui-${tag}-${n}-20261112.png`;
const ctrlK = [{ key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 2 }];
const tab = { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 };
const down = { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 };
const center = (sel, i = 0) => `(()=>{const e=document.querySelectorAll('${sel}')[${i}];if(!e)return [0,0];e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`;
const scrollTo = (sel) => `(()=>{const e=document.querySelector('${sel}');if(e)e.scrollIntoView({block:'start'});})()`;
const jobs = [{ out: `${dir}/warm.png`, url: base, w: 1280, h: 800, wait: 5000 }];
if (set === "all" || set === "settings") {
  for (const g of G) jobs.push({ out: out(`settings-${g}`), url: `${base}&settings=${g}`, w: 1280, h: 800, wait: 6500, probe });
  jobs.push({ out: out("settings-safety-1920"), url: `${base}&settings=safety`, w: 1920, h: 1080, wait: 6500, probe });
  jobs.push({ out: out("settings-safety-960"), url: `${base}&settings=safety`, w: 960, h: 640, wait: 6500, probe });
  jobs.push({ out: out("settings-safety-scroll"), url: `${base}&settings=safety`, w: 1280, h: 800, wait: 6500, pre: scrollTo("#settings-sec-approval"), probe });
  jobs.push({ out: out("settings-safety-lock"), url: `${base}&settings=safety`, w: 1280, h: 800, wait: 6500, pre: "(()=>{const b=[...document.querySelectorAll('#settings-sec-precise-lock button')].filter(x=>x.textContent.includes('전체 잠금'));b[0]&&b[0].click();b[9]&&b[9].click();setTimeout(()=>document.querySelector('#settings-sec-precise-lock').scrollIntoView({block:'start'}),300);})()", preWait: 1500, probe });
  for (const g of ["tools", "data", "ai", "connect"]) jobs.push({ out: out(`settings-${g}-scroll`), url: `${base}&settings=${g}`, w: 1280, h: 800, wait: 6500, pre: "document.querySelector('.settings-body').scrollTop=640", probe });
  jobs.push({ out: out("settings-hover"), url: `${base}&settings=safety`, w: 1280, h: 800, wait: 6500, hover: center(".settings-tab", 4), probe });
  jobs.push({ out: out("settings-seg-hover"), url: `${base}&settings=safety`, w: 1280, h: 800, wait: 6500, hover: center(".o2s-seg__opt:not(.is-on)", 1), probe });
  jobs.push({ out: out("settings-focus"), url: `${base}&settings=safety`, w: 1280, h: 800, wait: 6500, tabs: 4, probe });
}
if (set === "all" || set === "palette") {
  jobs.push({ out: out("palette"), url: base, w: 1280, h: 800, wait: 7500, keys: ctrlK, probe });
  jobs.push({ out: out("palette-query"), url: base, w: 1280, h: 800, wait: 7500, keys: ctrlK, text: "세션", probe });
  jobs.push({ out: out("palette-scope"), url: base, w: 1280, h: 800, wait: 7500, keys: ctrlK, keys2: [tab, tab, tab, down], probe: `(()=>{const l=document.querySelector(".command-item-label");return {w:getComputedStyle(l).fontWeight,scope:document.querySelector(".command-palette-scope.is-on")?.textContent}})()` });
  jobs.push({ out: out("palette-960"), url: base, w: 960, h: 640, wait: 7500, keys: ctrlK, probe });
  jobs.push({ out: out("menu"), url: base, w: 1280, h: 800, wait: 8000, pre: "document.querySelector('.chat-options > summary').click()", hover2: center(".chat-options-body button", 2), probe });
}
if (set === "all" || set === "review") {
  jobs.push({ out: out("main"), url: base, w: 1280, h: 800, wait: 9000, probe });
  jobs.push({ out: out("content"), url: `${base}&content=rich`, w: 1280, h: 800, wait: 9000, pre: scrollTo(".md-table-wrap"), probe });
  jobs.push({ out: out("session"), url: `${base}&panel=session`, w: 1280, h: 800, wait: 9000, probe });
  jobs.push({ out: out("main-1920"), url: base, w: 1920, h: 1080, wait: 9000, probe });
  jobs.push({ out: out("main-960"), url: base, w: 960, h: 640, wait: 9000, probe });
}
if (set === "all" || set === "themes") {
  jobs.push({ out: out("classic"), url: "http://localhost:1499/?fixture=mockup&layout=classic", w: 1280, h: 800, wait: 8000, probe });
  jobs.push({ out: out("classic-settings"), url: "http://localhost:1499/?fixture=mockup&layout=classic&settings=safety", w: 1280, h: 800, wait: 7000, probe });
  jobs.push({ out: out("classic-palette"), url: "http://localhost:1499/?fixture=mockup&layout=classic", w: 1280, h: 800, wait: 7500, keys: ctrlK, probe });
  for (const t of ["terminal-phosphor", "glass-acrylic", "brutalist-bauhaus"]) {
    jobs.push({ out: out(`theme-${t}-settings`), url: `${base}&settings=safety`, w: 1280, h: 800, wait: 6500, pre: `document.documentElement.setAttribute('data-theme','${t}')`, preWait: 1200, probe });
    jobs.push({ out: out(`theme-${t}-palette`), url: base, w: 1280, h: 800, wait: 7000, pre: `document.documentElement.setAttribute('data-theme','${t}')`, preWait: 800, keys: ctrlK, probe });
  }
}
console.log(JSON.stringify(jobs));
