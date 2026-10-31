import assert from "node:assert/strict";
import { ConversationControl } from "../src/conversationControl.ts";
import { restoreWorkspace, saveWorkspace, startupRecoveryCandidates, recoveryAttachments, WORKSPACE_KEY } from "../src/conversationWorkspace.ts";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log("PASS " + name); }
const storage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};
const task = (id: string, conversation_id = "a") => ({ id, kind: "conversation_turn", conversation_id, status: "running", manifest_json: JSON.stringify({ recoveryVersion: 1, request: "원래 작업을 완료" }) });

test("목록·예약·첨부 복원과 프로세스 소유권 분리", () => {
  const c = new ConversationControl(); c.claim("a", "t1"); c.tracked.add("idle");
  c.enqueue({ id: "q", conversationId: "a", text: "예약", mode: "queue", queuedAt: 1,
    files: [{ id: "file", name: "f.png", type: "image/png", size: 3, base64: "YWJj", preview: "blob:expired" }] });
  const s = storage(); saveWorkspace(c, s);
  const restored = new ConversationControl(); restoreWorkspace(restored, s, new Set(["a", "idle"]));
  assert.equal(restored.runs.get("a")?.state, "interrupted"); assert.equal(restored.isActive("a"), false);
  assert.ok(restored.tracked.has("idle")); assert.equal(restored.peek("a")?.files?.[0].base64, "YWJj");
  assert.equal(restored.peek("a")?.files?.[0].preview, undefined);
});
test("정지 확인 없이 재시작해도 완료로 표시하거나 자동 재개하지 않음", () => {
  const c = new ConversationControl(); c.claim("a", "t1"); c.stopping("a");
  const s = storage(); saveWorkspace(c, s);
  const restored = new ConversationControl(); restoreWorkspace(restored, s, new Set(["a"]));
  assert.equal(restored.runs.get("a")?.state, "interrupted"); assert.equal(restored.canAutoRun("a"), false);
  assert.deepEqual(startupRecoveryCandidates([task("t1")], restored, new Set(["a"])), []);
});
test("완료·실패 또는 최신 턴과 다른 오래된 DB 행의 재실행 차단", () => {
  const c = new ConversationControl(); c.claim("a", "latest"); c.finish("a", "latest", "completed");
  assert.deepEqual(startupRecoveryCandidates([task("old"), task("latest")], c, new Set(["a"])), []);
});
test("여러 대화 복구 후보 보존·대화별 중복 제거", () => {
  const c = new ConversationControl();
  assert.deepEqual(startupRecoveryCandidates([task("a1"), task("a0"), task("b1", "b")], c, new Set(["a", "b"])).map(t => t.id), ["a1", "b1"]);
  c.allPaused = true;
  assert.deepEqual(startupRecoveryCandidates([task("a1")], c, new Set(["a"])), []);
});
test("과거 모호한 작업·삭제된 대화·잘못된 manifest 자동 재개 금지", () => {
  const c = new ConversationControl();
  assert.deepEqual(startupRecoveryCandidates([{ ...task("a1"), kind: "codex" }, { ...task("a2"), manifest_json: "broken" }, task("z", "deleted")], c, new Set(["a"])), []);
});
test("손상된 스냅샷 무시 및 삭제된 대화 예약 복원 금지", () => {
  const s = storage(); s.setItem(WORKSPACE_KEY, "broken");
  const c = new ConversationControl(); restoreWorkspace(c, s, new Set(["a"])); assert.equal(c.tracked.size, 0);
  s.setItem(WORKSPACE_KEY, JSON.stringify({ version: 1, tracked: ["deleted"], runs: [{ conversationId: "a" }], queues: [{ conversationId: "deleted", text: "x" }] }));
  restoreWorkspace(c, s, new Set(["a"])); assert.equal(c.runs.size, 0); assert.equal(c.queues.size, 0);
});
test("정지 실패·늦은 이전 응답에도 잠금 유지", () => {
  const c = new ConversationControl(); c.claim("a", "old"); c.stopping("a"); c.stopFailed("a", "old", "timeout");
  assert.equal(c.claim("a", "new"), false); assert.ok(c.runs.get("a")?.stopError);
  c.finish("a", "old", "stopped"); c.claim("a", "new"); c.stopFailed("a", "old", "late error");
  assert.equal(c.runs.get("a")?.state, "running"); assert.equal(c.runs.get("a")?.stopError, undefined);
});
test("실행·예약은 닫기 불가, 목록 닫기는 사용자 정지 해제하지 않음", () => {
  const c = new ConversationControl(); c.claim("a", "t"); assert.equal(c.forget("a"), false);
  c.pause("a"); c.finish("a", "t", "stopped"); assert.ok(c.forget("a")); assert.ok(c.paused.has("a"));
  c.enqueue({ id: "q", conversationId: "b", text: "예약", mode: "queue", queuedAt: 1 }); assert.equal(c.forget("b"), false);
});
test("중단된 요청의 원래 첨부 바이트 재사용, 유실된 첨부로 자동 진행 금지", () => {
  const withFiles = { ...task("a"), manifest_json: JSON.stringify({ attachments: [{ name: "ref.png", type: "image/png", size: 3, base64: "YWJj" }] }) };
  assert.equal(recoveryAttachments(withFiles)[0].base64, "YWJj");
  assert.throws(() => recoveryAttachments({ ...withFiles, manifest_json: JSON.stringify({ attachments: [{ name: "lost.png", type: "image/png", size: 3 }] }) }), /보류/);
});
console.log(`conversation-workspace: ${passed}/${passed} PASS`);
