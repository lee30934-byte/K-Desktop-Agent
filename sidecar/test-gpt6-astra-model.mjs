#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const settings = fs.readFileSync(path.join(root, "src", "components", "Settings.tsx"), "utf8");
const sidecar = fs.readFileSync(path.join(root, "sidecar", "src", "index.ts"), "utf8");
const bridge = fs.readFileSync(path.join(root, "sidecar", "src", "codex-app-server-bridge.mjs"), "utf8");

const failures = [];
const codexStart = settings.indexOf('id: "codex"');
const geminiCliStart = settings.indexOf('id: "gemini-cli"', codexStart);
const openAiStart = settings.indexOf('id: "openai"');
const geminiStart = settings.indexOf('id: "gemini"', openAiStart);

const codexBlock = settings.slice(codexStart, geminiCliStart);
const openAiBlock = settings.slice(openAiStart, geminiStart);

// GPT-6 계열은 Codex(ChatGPT 구독 OAuth) 경로에만 노출한다.
// legacy OpenAI REST 경로는 별도 유료 API 키가 필요하고 실호출로 확인하지 못했으므로
// 추측으로 목록에 올리지 않는다 (올리면 K 가 골랐을 때 원인 불명 에러만 본다).
const GPT6_CODEX_ONLY = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];
for (const id of GPT6_CODEX_ONLY) {
  if (!codexBlock.includes(`{ id: "${id}"`)) {
    failures.push(`Codex model picker is missing ${id}`);
  }
  if (openAiBlock.includes(`{ id: "${id}"`)) {
    failures.push(`${id} must not be advertised on the legacy OpenAI REST path`);
  }
}
// CLI 버전 요구를 라벨에 남겨야 한다 — 0.156 미만에서는 존재하지 않는 모델과 똑같은
// 400 이 떠서 원인 판별이 불가능하다 (2026-09-23 실측).
for (const id of ["gpt-6-sol", "gpt-6-luna"]) {
  const m = new RegExp(`\{ id: "${id}", label: "([^"]*)"`).exec(codexBlock);
  if (!m) {
    failures.push(`${id} label not found`);
  } else if (!/0\.156\+/.test(m[1])) {
    failures.push(`${id} label must state the CLI 0.156+ requirement (got: ${m[1]})`);
  }
}
if (!sidecar.includes('model: msg.model && msg.model !== "default" ? msg.model : null,')) {
  failures.push("Codex model passthrough to the app-server bridge is missing");
}
if (!sidecar.includes('msg.model !== "default"')) {
  failures.push("Codex explicit-model guard is missing");
}
if (!bridge.includes('...(input.model ? { model: input.model } : {})')) {
  failures.push("Codex app-server model forwarding is missing");
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

console.log("PASS: GPT-6 (Astra/Sol/Luna) Codex picker + CLI 버전 표기 + model passthrough invariants");
