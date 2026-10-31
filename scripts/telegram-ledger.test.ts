// v0.7.69 — 명령 장부 · /현황 순수 로직 테스트.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandLedger, formatBoard, tierToState, LEDGER_KEEP_MS } from "../src/telegramLedger.ts";

const A = { convId: "a-cae", label: "CAE GUI" };
const B = { convId: "b-listen", label: "음악공유방" };

test("열기: 번호 증가, 같은 방 중복 제거, 처음 상태는 전달", () => {
  const l = new CommandLedger();
  const e1 = l.open("c", "Cae d4 진행", [A, B, A], 1000);
  const e2 = l.open("c", "또", [B], 2000);
  assert.equal(e1.id, 1); assert.equal(e2.id, 2);
  assert.deepEqual(e1.legs.map((x) => x.state), ["sent", "sent"]);
  assert.equal(e1.legs.length, 2);
});

test("회신: 그 방이 든 가장 최근 줄만 갱신, 없는 방은 무시", () => {
  const l = new CommandLedger();
  const e1 = l.open("c", "1", [A, B], 1000);
  const e2 = l.open("c", "2", [A], 2000);
  assert.equal(l.report(A.convId, "decision", 3000, "승인이 필요합니다")?.id, e2.id);
  assert.equal(e2.legs[0].state, "decision");
  assert.equal(e1.legs[0].state, "sent", "옛 줄은 그대로");
  assert.equal(l.report(B.convId, "done", 3000)?.id, e1.id);
  assert.equal(l.report("zzz", "done", 3000), undefined);
});

test("등급 → 상태", () => {
  assert.equal(tierToState("decision"), "decision");
  assert.equal(tierToState("error"), "error");
  assert.equal(tierToState("progress"), "running");
  assert.equal(tierToState("result"), "done");
});

test("48시간 지난 줄은 정리, 저장·복원 후 번호가 이어진다", () => {
  const l = new CommandLedger();
  l.open("c", "옛", [A], 0);
  l.open("c", "새", [B], LEDGER_KEEP_MS);
  assert.equal(l.recent(LEDGER_KEEP_MS + 1).length, 1);
  const r = CommandLedger.fromJSON(JSON.parse(JSON.stringify(l.toJSON())), LEDGER_KEEP_MS + 1);
  assert.equal(r.size, 1);
  assert.equal(r.open("c", "다음", [A], LEDGER_KEEP_MS + 2).id, 3, "복원 후 번호 재사용 금지");
  assert.equal(CommandLedger.fromJSON("깨진 값", 0).size, 0);
  assert.equal(CommandLedger.fromJSON({ entries: [{ id: 1, at: 0, legs: [{ convId: 1 }] }] }, 0).size, 0, "형식 틀린 줄 버림");
});

test("/현황 표시: 방별 상태·결정 대기 개수, 비었으면 안내", () => {
  const l = new CommandLedger();
  const e = l.open("c", "Cae d4진행해 음악공유방 아바타 늘려", [A, B], Date.UTC(2026, 10, 1, 1, 30));
  l.mark(e.id, A.convId, "running", Date.UTC(2026, 10, 1, 1, 31));
  l.report(B.convId, "decision", Date.UTC(2026, 10, 1, 1, 40), "1. 지금 반영\n2. 방송 끝나고");
  const txt = formatBoard(l.recent(0), Date.UTC(2026, 10, 1, 1, 50));
  assert.match(txt, /#1 /);
  assert.match(txt, /\[CAE GUI\] ⏳ 진행 · 19분 전/);
  assert.match(txt, /\[음악공유방\] ❓ 결정 대기 · 10분 전 — 1\. 지금 반영 2\. 방송 끝나고/);
  assert.match(txt, /결정 대기 1건/);
  assert.match(formatBoard([], 0), /명령이 없어요/);
});
