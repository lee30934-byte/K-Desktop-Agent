import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { ConversationControl } from "../src/conversationControl.ts";
import { AutoContinueChain, buildAutoContinuePrompt, classifyTurnEnding } from "../src/autoContinue.ts";

const source = ts.createSourceFile("App.tsx", readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let initializer = "";
const deliveryArgs: string[] = [];
function visit(node: ts.Node): void {
  if (ts.isBinaryExpression(node) && node.left.getText(source) === "autoContinueRunRef.current") initializer = node.right.getText(source);
  if (ts.isCallExpression(node) && node.expression.getText(source) === "hub.deliverResult" && node.arguments[0]) {
    const text = node.arguments[0].getText(source);
    if (text.includes("decisionRequired:") && (text.includes("tg.text") || text.includes("fu.text"))) deliveryArgs.push(text);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(initializer);
const compiled = ts.transpileModule(`return (${initializer});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const drain = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

function fixture(nudge = false, subscribed = true) {
  const control = new ConversationControl();
  control.claim("conv", "turn"); control.release("conv", "turn");
  const sends: any[] = [], notifications: any[] = [], timers: Array<() => void> = [];
  const chain = new AutoContinueChain();
  let flags: Promise<any> = Promise.resolve({ nudge });
  const hub = { activeAbsenceChatFor: () => subscribed ? "chat" : undefined,
    deliverResult: async (r: any) => { notifications.push(r); } };
  const deps = { classifyTurnEnding, buildAutoContinuePrompt,
    conversationTurnGateRef: { current: control }, telegramHubRef: { current: hub }, autoContinueChainRef: { current: chain },
    logger: { log() {} }, invoke: async (method: string) => method === "get_agent_flags" ? await flags : undefined,
    setTimeout: (fn: () => void) => { timers.push(fn); },
    handleSendMessage: async (...args: any[]) => { sends.push(args); } };
  const run = new Function(...Object.keys(deps), compiled)(...Object.values(deps));
  return { run: (text = "추천안으로 진행할까요?") => run("conv", "turn", text), control, sends, notifications, timers, chain,
    subscribe: (v: boolean) => { subscribed = v; }, flags: (p: Promise<any>) => { flags = p; } };
}

test("actual App resumes subscribed work with self-nudge OFF and preserves the conversation", async () => {
  const t = fixture(); t.run(); await drain(); assert.equal(t.timers.length, 1);
  t.timers[0](); await drain(); assert.equal(t.sends.length, 1);
  assert.equal(t.sends[0][2].conversationId, "conv"); assert.match(t.sends[0][0], /자동 이어가기/);
});

test("unsubscribed work with self-nudge OFF is not resumed", async () => {
  const t = fixture(false, false); t.run(); await drain(); assert.equal(t.timers.length, 0);
});

test("ordinary self-nudge ON retains continuation without an absence subscription", async () => {
  const t = fixture(true, false); t.run(); await drain(); assert.equal(t.timers.length, 1);
  t.timers[0](); await drain(); assert.equal(t.sends.length, 1);
});

test("explicit decision waits and does not send a duplicate phone notice", async () => {
  const t = fixture(); t.run("미승인 파일을 삭제할까요?"); await drain();
  assert.equal(t.timers.length, 0); assert.equal(t.notifications.length, 0);
});

test("stop, global pause, new owner and subscription expiry cancel a scheduled continuation", async () => {
  const mutations = [(t: ReturnType<typeof fixture>) => t.control.pause("conv", "user"),
    (t: ReturnType<typeof fixture>) => { t.control.allPaused = true; },
    (t: ReturnType<typeof fixture>) => t.control.claim("conv", "new-turn"),
    (t: ReturnType<typeof fixture>) => t.subscribe(false)];
  for (const mutate of mutations) {
    const t = fixture(); t.run(); await drain(); mutate(t); t.timers[0](); await drain();
    assert.equal(t.sends.length, 0);
  }
});

test("a stop during the flags RPC is preserved", async () => {
  const t = fixture(); let resolve!: (v: unknown) => void;
  t.flags(new Promise(r => { resolve = r; })); t.run(); t.control.pause("conv", "user"); resolve({ nudge: true });
  await drain(); assert.equal(t.timers.length, 0);
});

test("bounded continuation exhaustion sends a phone decision instead of silently stalling", async () => {
  const t = fixture(); t.chain.tryTake("conv"); t.chain.tryTake("conv"); t.run(); await drain();
  assert.equal(t.timers.length, 0); assert.equal(t.notifications.length, 1);
  assert.equal(t.notifications[0].decisionRequired, true); assert.equal(t.notifications[0].noChoices, true);
});

test("actual App completion deliveries flag required absence decisions for immediate delivery", () => {
  assert.equal(deliveryArgs.length, 2);
  for (const arg of deliveryArgs) {
    const text = "미승인 파일을 삭제할까요?", record = { convId: "conv", chatId: "chat", text };
    const js = ts.transpileModule(`return (${arg});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const result = new Function("tg", "fu", "chat", "ev", "hub", "classifyTurnEnding", js)(record, record, "chat", { id: "turn" }, { activeAbsenceChatFor: () => "chat" }, classifyTurnEnding);
    assert.equal(result.decisionRequired, true);
  }
});
