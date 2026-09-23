/** Phase 149 — 실제 주입 바이트 예산 측정. Tier A/B 가 40KB cap 안에 들어가는지 확인. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path"; import os from "node:os";
import { selectPitfallInjection, buildV2Index, pitfallOneLiner,
         INJECT_FULL_K, INJECT_INDEX_K, TRIGGERED_BODY_MAX_CHARS } from "./dist/memoryRelevance.js";
const DIR = path.join(os.homedir(), ".kda", "memory");
const cands = readdirSync(DIR).filter(f=>f.startsWith("pitfall_")&&f.endsWith(".md"))
  .map(f=>({file:f, body:readFileSync(path.join(DIR,f),"utf8")}));
const idx = buildV2Index(cands);
const G = JSON.parse(readFileSync("./golden.tmp.json","utf8"));
console.log(`FULL_K=${INJECT_FULL_K} INDEX_K=${INJECT_INDEX_K} BODY_MAX=${TRIGGERED_BODY_MAX_CHARS}`);
console.log("─".repeat(64));
let worst=0;
for (const g of G) {
  const q=`${g.query}\n${g.context}`;
  const {full,index}=selectPitfallInjection(cands,q,idx);
  const bodyBytes=full.reduce((n,s)=>{
    const b=(cands.find(c=>c.file===s.file)?.body??"").replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/,"").trim();
    return n+Math.min(b.length,TRIGGERED_BODY_MAX_CHARS)+s.file.length+60;},0);
  const idxBytes=index.reduce((n,s)=>n+pitfallOneLiner(cands.find(c=>c.file===s.file)?.body??"").length+s.file.length+8,0)+300;
  const tot=bodyBytes+idxBytes;
  worst=Math.max(worst,tot);
  console.log(`[${g.id}] TierA ${String(full.length).padStart(2)}개 ${String(bodyBytes).padStart(6)}B | TierB ${String(index.length).padStart(2)}개 ${String(idxBytes).padStart(5)}B | 합계 ${(tot/1024).toFixed(1)}KB`);
}
console.log("─".repeat(64));
console.log(`최대 ${(worst/1024).toFixed(1)}KB / cap 40KB  → ${worst < 40*1024 ? "OK" : "초과!"}`);
console.log(`(lee-profile + pitfall 슬러그 인덱스 + feedback/skill 이 같은 40KB 를 나눠 쓴다는 점 유의)`);
