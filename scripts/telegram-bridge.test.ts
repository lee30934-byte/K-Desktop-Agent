// v0.7.53 — 텔레그램 브리지 견고화 회귀 테스트 (2026-10-29 장애 4건).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TelegramTurnTracker,
  TELEGRAM_TURN_STALE_MS,
  buildTelegramReplyChunks,
  sendWithRetry,
  shouldRetryWithFreshSession,
  stripTrailingUserEcho,
  type TelegramTurnEntry,
} from "../src/telegramBridge.ts";

const entry = (over: Partial<TelegramTurnEntry> = {}): TelegramTurnEntry => ({
  chatId: "7203583138",
  text: "",
  userText: "5080 상태",
  convId: "conv-tg",
  startedAt: 0,
  lastActivityAt: 0,
  retried: false,
  ...over,
});

test("(1) resume_session_missing 은 1회만 새 세션 재시도", () => {
  assert.equal(shouldRetryWithFreshSession(entry(), "resume_session_missing"), true);
  assert.equal(shouldRetryWithFreshSession(entry({ retried: true }), "resume_session_missing"), false, "재시도 turn 이 또 실패하면 무한 반복 금지");
  assert.equal(shouldRetryWithFreshSession(entry(), "rate_limit"), false, "다른 오류는 재시도 대상 아님");
  assert.equal(shouldRetryWithFreshSession(undefined, "resume_session_missing"), false);
});

test("(1) 재시도 history 에서 끝의 원 메시지 중복 제거, 다른 메시지는 보존", () => {
  const h = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "CAE 보고해줘" },
  ];
  assert.deepEqual(stripTrailingUserEcho(h, "CAE 보고해줘").map((m) => m.content), ["a", "b"]);
  assert.deepEqual(stripTrailingUserEcho(h, "다른 문장"), h, "다르면 건드리지 않음");
  const tailAssistant = [...h, { role: "assistant", content: "x" }];
  assert.deepEqual(stripTrailingUserEcho(tailAssistant, "CAE 보고해줘").map((m) => m.content), ["a", "b", "x"]);
  assert.deepEqual(stripTrailingUserEcho([], "z"), []);
});

test("(2) 무이벤트 STALE_MS 지난 turn 만 해제, heartbeat(touch) 받은 turn 은 유지", () => {
  const t = new TelegramTurnTracker();
  t.set("hung", entry({ lastActivityAt: 0 }));
  t.set("alive", entry({ lastActivityAt: 0 }));
  t.touch("alive", TELEGRAM_TURN_STALE_MS - 1000); // 장기 작업이지만 heartbeat 수신 중
  assert.deepEqual(t.reapStale(TELEGRAM_TURN_STALE_MS - 1).map((x) => x.turnId), [], "경계 전엔 아무것도 해제 안 함");
  const reaped = t.reapStale(TELEGRAM_TURN_STALE_MS);
  assert.deepEqual(reaped.map((x) => x.turnId), ["hung"]);
  assert.equal(reaped[0].convId, "conv-tg", "대화 잠금 해제에 쓸 convId 포함");
  assert.equal(t.size, 1);
  assert.ok(t.get("alive"));
  t.touch("unknown", 5); // 미등록 turn touch 는 무해
  t.touch(undefined, 5);
});

test("(3) 대기열: 상한까지 순서대로 받고 초과분만 거절, requeueFront 는 순서 보존", () => {
  const t = new TelegramTurnTracker(1000, 2);
  assert.deepEqual(t.enqueue({ text: "m1", chatId: "c", receivedAt: 1 }), { accepted: true, position: 1 });
  assert.deepEqual(t.enqueue({ text: "m2", chatId: "c", receivedAt: 2 }), { accepted: true, position: 2 });
  assert.equal(t.enqueue({ text: "m3", chatId: "c", receivedAt: 3 }).accepted, false);
  const first = t.dequeue();
  assert.equal(first?.text, "m1");
  t.requeueFront(first!); // 다시 막혔을 때
  assert.equal(t.dequeue()?.text, "m1");
  assert.equal(t.dequeue()?.text, "m2");
  assert.equal(t.dequeue(), undefined);
  assert.equal(t.queueLength, 0);
});

test("기존 Map 의미 유지: get/set/delete/size", () => {
  const t = new TelegramTurnTracker();
  assert.equal(t.size, 0);
  t.set("x", entry());
  assert.equal(t.size, 1);
  assert.equal(t.delete("x"), true);
  assert.equal(t.delete("x"), false);
  assert.equal(t.delete(undefined), false);
  assert.equal(t.get(undefined), undefined);
});

test("회신 분할: 라벨 + 빈 응답 + 4000자 경계", () => {
  assert.deepEqual(buildTelegramReplyChunks("ok", "미니PC"), ["[미니PC] ok"]);
  assert.deepEqual(buildTelegramReplyChunks("  ", ""), ["(빈 응답)"]);
  const long = "x".repeat(8001);
  const parts = buildTelegramReplyChunks(long, "");
  assert.deepEqual(parts.map((p) => p.length), [4000, 4000, 1]);
  assert.equal(parts.join(""), long);
});

test("(4) 회신 재시도: 1회 실패 후 성공 / 연속 실패 시 오류 보고", async () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  let n = 0;
  const r1 = await sendWithRetry(async () => { if (++n === 1) throw new Error("HTTP 502"); }, { attempts: 2, delayMs: 3000, sleep });
  assert.deepEqual(r1, { ok: true, attempts: 2 });
  assert.deepEqual(sleeps, [3000]);
  const r2 = await sendWithRetry(async () => { throw new Error("HTTP 요청 실패: timeout"); }, { attempts: 2, delayMs: 10, sleep });
  assert.equal(r2.ok, false);
  assert.equal(r2.attempts, 2);
  assert.match(r2.error ?? "", /timeout/);
  const r3 = await sendWithRetry(async () => {}, { sleep });
  assert.deepEqual(r3, { ok: true, attempts: 1 });
});

test("v0.7.54 대화별 동시성: hasConv / dequeueReady 는 바쁜 대화 건너뛰고 대화별 순서 보존", () => {
  const t = new TelegramTurnTracker();
  t.set("t1", entry({ convId: "cae" }));
  assert.equal(t.hasConv("cae"), true);
  assert.equal(t.hasConv("kda"), false);
  t.enqueue({ text: "a", chatId: "c", receivedAt: 1, convId: "cae" });
  t.enqueue({ text: "b", chatId: "c", receivedAt: 2, convId: "kda" });
  t.enqueue({ text: "c", chatId: "c", receivedAt: 3, convId: "cae" });
  const busy = (id?: string) => t.hasConv(id ?? "tg");
  assert.equal(t.dequeueReady(busy)?.text, "b");
  assert.equal(t.dequeueReady(busy), undefined, "cae 는 바쁨 → a,c 대기");
  t.delete("t1");
  assert.equal(t.dequeueReady(busy)?.text, "a", "같은 대화는 순서대로");
});
