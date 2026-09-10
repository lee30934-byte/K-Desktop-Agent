import assert from "node:assert/strict";
import { ConversationTurnGate } from "../src/conversationTurnGate.ts";

const gate = new ConversationTurnGate();
assert.equal(gate.claim("conv-a", "turn-1"), true);
assert.equal(gate.claim("conv-a", "turn-2"), false, "same conversation must stay single-flight");
assert.equal(gate.claim("conv-b", "turn-3"), true, "different conversations may run concurrently");
assert.deepEqual([...gate.activeConversationIds()].sort(), ["conv-a", "conv-b"]);
assert.equal(gate.release("conv-a", "wrong-turn"), false, "stale completion must not unlock a newer turn");
assert.equal(gate.release("conv-a", "turn-1"), true);
assert.equal(gate.claim("conv-a", "turn-4"), true, "completion must allow the next turn");
gate.clear();
assert.equal(gate.isActive("conv-a"), false);
assert.equal(gate.isActive("conv-b"), false);
console.log("conversation-turn-gate: PASS");
