// Context Builder hardening smoke test.
//
// Goal: prevent unbounded prior_conversation growth while preserving recent
// turns and safety memory. Run: node sidecar/test-context-builder.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(__dirname, "src", "index.ts"), "utf-8");

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  OK ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
  }
}

console.log("Context Builder hardening test\n");

check("bounded prompt history item cap", /const PROMPT_HISTORY_MAX_ITEMS = 12;/.test(src));
check("bounded prompt history char cap", /const PROMPT_HISTORY_MAX_CHARS = 12_000;/.test(src));
check("common CompactedHistory type", /interface CompactedHistory \{[\s\S]*?omittedItems: number;[\s\S]*?approxChars: number;[\s\S]*?\}/.test(src));
check("older history summary helper", /function summarizeOmittedHistory\([\s\S]*?\[KDA context summary\][\s\S]*?Ask K before relying on omitted details/.test(src));
check("common compactHistoryForPrompt helper", /function compactHistoryForPrompt\([\s\S]*?selected\.unshift\(\{[\s\S]*?summarizeOmittedHistory/.test(src));
check("Codex compatibility wrapper retained", /function compactHistoryForCodexBootstrap\([\s\S]*?return compactHistoryForCodexBootstrapStats\(history\)\.history;/.test(src));

const claudeBody = src.slice(src.indexOf("async function handleViaClaudeCLI"), src.indexOf("async function handleViaCodexCLI"));
check("Claude path compacts history", /const promptHistory = compactHistoryForPrompt\(msg\.history\);/.test(claudeBody));
check("Claude path sends compacted history", /buildPromptWithHistory\(\s*baseContent,\s*promptHistory\.history,\s*memory\.content,\s*\)/.test(claudeBody));
check("Claude log reports history omitted", /historyOriginal=\$\{promptHistory\.originalItems\}[\s\S]*historyOmitted=\$\{promptHistory\.omittedItems\}/.test(claudeBody));

const codexBody = src.slice(src.indexOf("async function handleViaCodexCLI"), src.indexOf("async function handleViaGeminiCLI"));
check("Codex path uses compact stats", /const codexHistory = effectiveAgentId[\s\S]*compactHistoryForCodexBootstrapStats\(msg\.history\);/.test(codexBody));
check("Codex log reports history omitted", /historyIn=\$\{codexHistory\.originalItems\}[\s\S]*historyOmitted=\$\{codexHistory\.omittedItems\}/.test(codexBody));

const geminiBody = src.slice(src.indexOf("async function handleViaGeminiCLI"), src.indexOf("async function handleViaRestAPI"));
check("Gemini path uses compact stats", /const geminiHistory = compactHistoryForCodexBootstrapStats\(msg\.history\);/.test(geminiBody));
check("Gemini log reports history omitted", /historyIn=\$\{geminiHistory\.originalItems\}[\s\S]*historyOmitted=\$\{geminiHistory\.omittedItems\}/.test(geminiBody));

const restBody = src.slice(src.indexOf("async function handleViaRestAPI"));
check("REST path compacts before flattening", /const restHistory = compactHistoryForPrompt\(msg\.history\);[\s\S]*const history = restHistory\.history \?\? \[\];/.test(restBody));
check("REST log reports history omitted", /historyOriginal=\$\{restHistory\.originalItems\}[\s\S]*historyOmitted=\$\{restHistory\.omittedItems\}/.test(restBody));

console.log(`\nResult: ${pass}/${pass + fail} passed`);
process.exit(fail > 0 ? 1 : 0);
