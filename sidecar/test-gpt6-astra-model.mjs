#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const settings = fs.readFileSync(path.join(root, "src", "components", "Settings.tsx"), "utf8");
const sidecar = fs.readFileSync(path.join(root, "sidecar", "src", "index.ts"), "utf8");

const failures = [];
const codexStart = settings.indexOf('id: "codex"');
const geminiCliStart = settings.indexOf('id: "gemini-cli"', codexStart);
const openAiStart = settings.indexOf('id: "openai"');
const geminiStart = settings.indexOf('id: "gemini"', openAiStart);

const codexBlock = settings.slice(codexStart, geminiCliStart);
const openAiBlock = settings.slice(openAiStart, geminiStart);

if (!codexBlock.includes('{ id: "gpt-6-astra"')) {
  failures.push("Codex model picker is missing gpt-6-astra");
}
if (openAiBlock.includes('{ id: "gpt-6-astra"')) {
  failures.push("gpt-6-astra must not be advertised on the legacy OpenAI REST path");
}
if (!sidecar.includes('args.unshift(`model="${msg.model}"`);')) {
  failures.push("Codex model passthrough wiring is missing");
}
if (!sidecar.includes('msg.model !== "default"')) {
  failures.push("Codex explicit-model guard is missing");
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

console.log("PASS: GPT-6 Astra Codex picker and model passthrough invariants");
