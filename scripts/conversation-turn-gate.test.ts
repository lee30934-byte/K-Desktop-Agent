import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ConversationTurnGate } from "../src/conversationTurnGate.ts";

const gate = new ConversationTurnGate();
assert.equal(gate.claim("conv-a", "turn-1"), true);
assert.equal(gate.claim("conv-a", "turn-2"), false, "same conversation must stay single-flight");
assert.equal(gate.claim("conv-b", "turn-3"), true, "different conversations may run concurrently");
assert.deepEqual([...gate.activeConversationIds()].sort(), ["conv-a", "conv-b"]);
assert.equal(gate.release("conv-a", "wrong-turn"), false, "stale completion must not unlock a newer turn");
assert.equal(gate.release("conv-a", "turn-1"), true);
assert.equal(gate.claim("conv-a", "turn-4"), true, "completion must allow the next turn");
assert.equal(gate.release("conv-a", "turn-1"), false, "late completion must not release the current owner");
assert.equal(gate.claim("conv-a", "turn-5"), false, "current owner must survive a late completion");
gate.clear();
assert.equal(gate.isActive("conv-a"), false);
assert.equal(gate.isActive("conv-b"), false);

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const sidecarSource = readFileSync(new URL("../sidecar/src/index.ts", import.meta.url), "utf8");

assert.match(appSource, /const conversationTurnGateRef = useRef\(new ConversationTurnGate\(\)\)/);
assert.match(appSource, /stale done 무시/);
assert.match(appSource, /stale error 무시/);
assert.ok(
  (appSource.match(/claimConversationTurn\(/g) ?? []).length >= 6,
  "all frontend root-turn entry paths must claim the conversation gate",
);
assert.match(sidecarSource, /const activeConversationTurns = new Map<string, string>\(\)/);
assert.match(sidecarSource, /case "user_message":\s*dispatchRootTurn\(msg as UserMessage, handleUserMessage\)/s);
assert.match(sidecarSource, /case "orchestrate_message":\s*dispatchRootTurn\(msg as OrchestrateMessage, handleOrchestrateMessage\)/s);
assert.match(sidecarSource, /obj\.type === "done" \|\| obj\.type === "error"/);
assert.match(sidecarSource, /case "interrupt": \{\s*releaseConversationTurnById\(msg\.id\)/s);
console.log("conversation-turn-gate: PASS");
