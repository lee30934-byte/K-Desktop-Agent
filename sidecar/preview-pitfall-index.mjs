#!/usr/bin/env node
// Phase 148 dry-run: 새 extractPitfallSummary 결과 미리보기 (재시작 전 검증).
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const memoryDir = process.env.KDA_MEMORY_DIR ?? path.join(os.homedir(), ".kda", "memory");
const budget = 22 * 1024; // PITFALL_INDEX_MAX_CHARS 새 값

const files = readdirSync(memoryDir).filter((f) => f.startsWith("pitfall_") && f.endsWith(".md"));
const raw = [];
for (const f of files) {
  try {
    const filePath = path.join(memoryDir, f);
    const body = readFileSync(filePath, "utf-8");
    const descMatch = body.match(/^description:\s*(.+?)(?:\r?\n|$)/m);
    const st = statSync(filePath);
    raw.push({
      slug: f.replace(/^pitfall_/, "").replace(/\.md$/, ""),
      desc: descMatch ? descMatch[1].trim() : null,
      file: f,
      mtime: st.mtimeMs,
    });
  } catch { /* skip */ }
}

const byPrefix = new Map();
for (const r of raw) {
  const idx = r.slug.indexOf("_");
  const prefix = idx > 0 ? r.slug.slice(0, idx) : "";
  const key = prefix || "(misc)";
  if (!byPrefix.has(key)) byPrefix.set(key, []);
  byPrefix.get(key).push(r);
}
const groups = [];
const misc = [];
for (const [prefix, items] of byPrefix) {
  if (prefix === "(misc)" || items.length < 2) misc.push(...items);
  else groups.push([prefix, items]);
}
groups.sort((a, b) => Math.max(...b[1].map((r) => r.mtime)) - Math.max(...a[1].map((r) => r.mtime)));
for (const [, items] of groups) items.sort((a, b) => b.mtime - a.mtime);
misc.sort((a, b) => b.mtime - a.mtime);

const renderGroup = (prefix, items, limit) => {
  const tails = items.map((r) => {
    const tail = r.slug.slice(prefix.length + 1);
    if (limit > 0 && r.desc) return `${tail} — ${r.desc.slice(0, limit)}`;
    return tail;
  });
  return [`## ${prefix}_ (${items.length})`, tails.join(", "), ""];
};
const renderMisc = (items, limit) => {
  if (items.length === 0) return [];
  const out = [`## (misc, ${items.length})`];
  for (const r of items) {
    if (limit > 0 && r.desc) out.push(`${r.slug} — ${r.desc.slice(0, limit)}`);
    else out.push(r.slug);
  }
  out.push("");
  return out;
};
const render = (limit, gl, ml) => {
  const out = [];
  for (const [prefix, items] of gl) out.push(...renderGroup(prefix, items, limit));
  out.push(...renderMisc(ml, limit));
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
};

const STEPS = [110, 90, 70, 55, 40, 30];
let descLimit = STEPS[0];
let lines = render(descLimit, groups, misc);
for (const limit of STEPS) {
  descLimit = limit;
  lines = render(limit, groups, misc);
  if (lines.join("\n").length <= budget) break;
}
let omitted = 0;
if (lines.join("\n").length > budget) {
  descLimit = 0;
  lines = render(0, groups, misc);
  while (misc.length > 1 && lines.join("\n").length > budget) {
    misc.pop();
    omitted++;
    lines = render(0, groups, misc);
  }
  while (groups.length > 0 && lines.join("\n").length > budget) {
    const [, popped] = groups.pop();
    omitted += popped.length;
    lines = render(0, groups, misc);
  }
}

const totalKept = misc.length + groups.reduce((s, [, it]) => s + it.length, 0);
console.log(`=== Phase 148 pitfall index dry-run ===`);
console.log(`files scanned    = ${raw.length}`);
console.log(`kept             = ${totalKept}`);
console.log(`omitted          = ${omitted}`);
console.log(`descLimit final  = ${descLimit}`);
console.log(`rendered bytes   = ${lines.join("\n").length} / ${budget}`);
console.log(`groups count     = ${groups.length}`);
console.log(`misc count       = ${misc.length}`);
console.log(`\n=== TOP 40 lines preview ===`);
console.log(lines.slice(0, 40).join("\n"));
console.log(`\n... (${lines.length - 40} more lines)`);
