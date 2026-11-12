// usage: node gen-jobs-dzB.mjs <tag> <outdir> [set] > jobs.json   (dzB 캡처: 메시지 콘텐츠 rich · 빈 화면 · 펼친 도구 카드 · 호버 · classic · 테마)
const [tag, dir, set = "all"] = process.argv.slice(2);
const base = "http://localhost:1499/?fixture=mockup&layout=o2";
const rich = `${base}&content=rich`;
const probe = `(()=>{const q=(s)=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.right),Math.round(r.bottom)]};const av=q('.companion-widget');const hits=['.main-header','.chat-notices--top','.chat-col','.composer'].filter(s=>{const a=q(s);return av&&a&&av[0]<a[2]&&av[2]>a[0]&&av[1]<a[3]&&av[3]>a[1]});return {font:document.fonts.check('16px "Pretendard Variable"'),hscroll:document.documentElement.scrollWidth>innerWidth,avatarOverlaps:hits,msgs:document.querySelectorAll('.chat-col > *').length,tools:document.querySelectorAll('.msg-tool-o2').length,code:!!document.querySelector('.md-code-head')}})()`;
const out = (n) => `${dir}/ui-${tag}-${n}-20261112.png`;
const scrollTo = (sel) => `(()=>{const e=document.querySelector('${sel}');if(e)e.scrollIntoView({block:'start'});})()`;
const hover = (sel, i = 0) => `(()=>{const e=document.querySelectorAll('${sel}')[${i}];const r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`;
const jobs = [{ out: `${dir}/warm.png`, url: base, w: 1280, h: 800, wait: 5000 }];
if (set === "all" || set === "rich") {
  jobs.push({ out: out("content-top"), url: rich, w: 1280, h: 800, wait: 9000, pre: "(()=>{const s=document.querySelector('[data-virtuoso-scroller]');if(s)s.scrollTop=0;})()", preWait: 1500, probe });
  jobs.push({ out: out("content-code"), url: rich, w: 1280, h: 800, wait: 9000, pre: scrollTo('.md-table-wrap'), probe });
  jobs.push({ out: out("content-tools"), url: rich, w: 1280, h: 800, wait: 9000, probe });
  jobs.push({ out: out("content-tools-open"), url: rich, w: 1280, h: 800, wait: 9000, pre: "(()=>{const d=document.querySelectorAll('.msg-tool-o2 details');d[1]&&(d[1].open=true);})()", probe });
  jobs.push({ out: out("content-1920"), url: rich, w: 1920, h: 1080, wait: 9000, pre: scrollTo('.md-table-wrap'), probe });
  jobs.push({ out: out("content-960"), url: rich, w: 960, h: 640, wait: 9000, pre: scrollTo('.md-code-head'), probe });
}
if (set === "all" || set === "empty") {
  jobs.push({ out: out("empty"), url: `${base}&content=empty`, w: 1280, h: 800, wait: 9000, probe });
  jobs.push({ out: out("empty-hover"), url: `${base}&content=empty`, w: 1280, h: 800, wait: 9000, hover: hover('.empty-suggestion', 0), probe });
  jobs.push({ out: out("empty-960"), url: `${base}&content=empty`, w: 960, h: 640, wait: 9000, probe });
}
if (set === "all" || set === "main") {
  jobs.push({ out: out("main"), url: base, w: 1280, h: 800, wait: 9000, probe });
}
if (set === "all" || set === "themes") {
  jobs.push({ out: out("classic-rich"), url: "http://localhost:1499/?fixture=mockup&layout=classic&content=rich", w: 1280, h: 800, wait: 9000, probe });
  jobs.push({ out: out("classic"), url: "http://localhost:1499/?fixture=mockup&layout=classic", w: 1280, h: 800, wait: 8000, probe });
  for (const t of ["terminal-phosphor", "glass-acrylic", "brutalist-bauhaus"])
    jobs.push({ out: out(`theme-${t}`), url: rich, w: 1280, h: 800, wait: 8000, pre: `document.documentElement.setAttribute('data-theme','${t}')`, preWait: 1500, probe });
}
console.log(JSON.stringify(jobs));
