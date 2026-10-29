// v0.7.54 — 텔레그램 자동 분배 순수 로직 회귀 테스트.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideRoute,
  parseAliasPrefix,
  isShortFollowUp,
  parseClassifierReply,
  buildClassifierPrompt,
  ReplyMap,
  FollowUpRegistry,
  sanitizeTargets,
  labelReply,
  ROUTER_STICKY_MS,
  ROUTER_FOLLOWUP_MS,
  type RouteTarget,
} from "../src/telegramRouter.ts";

const CAE: RouteTarget = { convId: "c-cae", label: "CAE GUI", aliases: ["cae", "해석"], description: "설계해석 GUI" };
const KDA: RouteTarget = { convId: "c-kda", label: "KDA 개발", aliases: ["kda"], description: "KDA 앱 개발" };
const TARGETS = [CAE, KDA];
const DEF = { convId: "c-tg", label: "텔레그램" };
const base = { targets: TARGETS, defaultTarget: DEF, now: 1_000_000 };

test("별칭 머리말 파싱", () => {
  assert.deepEqual(parseAliasPrefix("@CAE 화면 밝게"), { alias: "cae", rest: "화면 밝게" });
  assert.deepEqual(parseAliasPrefix("  @kda: 빌드"), { alias: "kda", rest: "빌드" });
  assert.equal(parseAliasPrefix("메일 a@b.com 확인"), null, "중간의 @ 는 별칭 아님");
});

test("짧은 후속답 판정", () => {
  for (const s of ["1", "2번", "3.", "①", "예", "네", "아니요", "ok", "진행", "취소"]) assert.equal(isShortFollowUp(s), true, s);
  for (const s of ["", "5080 상태 알려줘", "CAE 화면이 너무 어두워", "123"]) assert.equal(isShortFollowUp(s), false, s);
});

test("분류기 응답 파싱: 정상/잡음/범위밖/형식오류", () => {
  assert.equal(parseClassifierReply('{"pick":1,"confidence":0.9}', TARGETS)?.target?.convId, "c-cae");
  assert.equal(parseClassifierReply('sure:\n{"pick": 2, "confidence": 0.7}\n', TARGETS)?.target?.convId, "c-kda");
  assert.equal(parseClassifierReply('{"pick":0,"confidence":0.9}', TARGETS)?.target, null, "0 = 기본 대화");
  assert.equal(parseClassifierReply('{"pick":3,"confidence":0.9}', TARGETS), null, "범위 밖");
  assert.equal(parseClassifierReply('{"pick":1,"confidence":1.5}', TARGETS), null, "확신도 범위 밖");
  assert.equal(parseClassifierReply("I think CAE", TARGETS), null);
  assert.equal(parseClassifierReply('{"pick":1.5,"confidence":0.9}', TARGETS), null, "정수 아님");
});

test("분류 프롬프트에 후보 번호와 메시지가 들어간다", () => {
  const p = buildClassifierPrompt("화면 어두워", TARGETS);
  assert.match(p, /1\. CAE GUI/);
  assert.match(p, /2\. KDA 개발/);
  assert.match(p, /화면 어두워/);
  assert.doesNotMatch(p, /c-cae/, "uuid 는 프롬프트에 넣지 않는다");
});

test("우선순위: 답장 > 별칭 > 후속답 > AI > 기본", async () => {
  const classify = async () => '{"pick":2,"confidence":0.95}';
  // 답장이 별칭보다 우선
  let d = await decideRoute({ ...base, text: "@kda 1", replyToConvId: "c-cae", classify });
  assert.equal(d.source, "reply"); assert.equal(d.convId, "c-cae");
  // 별칭: 머리말 제거
  d = await decideRoute({ ...base, text: "@해석 밝기 올려", classify });
  assert.equal(d.source, "alias"); assert.equal(d.convId, "c-cae"); assert.equal(d.text, "밝기 올려");
  // 후속답은 직전 회신 대화로 (AI 호출 안 함)
  let called = 0;
  d = await decideRoute({ ...base, text: "2", lastReply: { convId: "c-cae", at: base.now - 60_000 }, classify: async () => { called++; return ""; } });
  assert.equal(d.source, "sticky"); assert.equal(d.convId, "c-cae"); assert.equal(called, 0);
  // 후속답이라도 시간이 지나면 고정하지 않음
  d = await decideRoute({ ...base, text: "2", lastReply: { convId: "c-cae", at: base.now - ROUTER_STICKY_MS - 1 }, classify });
  assert.notEqual(d.source, "sticky");
  // AI
  d = await decideRoute({ ...base, text: "릴리즈 빌드 어떻게 됐어", classify });
  assert.equal(d.source, "ai"); assert.equal(d.convId, "c-kda"); assert.equal(d.confidence, 0.95);
});

test("AI 실패는 전부 기본 대화로 강등 (유실 없음)", async () => {
  const cases: Array<[() => Promise<string>, string]> = [
    [async () => { throw new Error("codex login expired"); }, "classify-failed"],
    [async () => "garbage", "classify-unparsable"],
    [async () => '{"pick":1,"confidence":0.3}', "low-confidence"],
    [async () => '{"pick":0,"confidence":0.9}', "ai-picked-general"],
  ];
  for (const [classify, note] of cases) {
    const d = await decideRoute({ ...base, text: "아무 말", classify });
    assert.equal(d.convId, "c-tg", note);
    assert.equal(d.source, "default");
    assert.ok(d.note?.startsWith(note), `${note} vs ${d.note}`);
    assert.equal(d.text, "아무 말", "원문 보존");
  }
});

test("허용 목록에 없는 대화로는 답장/후속답이 가지 않는다", async () => {
  let d = await decideRoute({ ...base, text: "hi", replyToConvId: "c-trading" });
  assert.equal(d.convId, "c-tg");
  d = await decideRoute({ ...base, text: "1", lastReply: { convId: "c-trading", at: base.now } });
  assert.equal(d.convId, "c-tg");
});

test("모르는 별칭은 일반 메시지로 취급", async () => {
  const d = await decideRoute({ ...base, text: "@없는별칭 테스트" });
  assert.equal(d.source, "default"); assert.equal(d.text, "@없는별칭 테스트");
});

test("ReplyMap: 상한 FIFO + 직렬화 왕복", () => {
  const m = new ReplyMap(3);
  m.remember(1, "a"); m.remember(2, "b"); m.remember(3, "c"); m.remember(4, "d");
  assert.equal(m.size, 3); assert.equal(m.lookup(1), undefined); assert.equal(m.lookup(4), "d");
  const r = ReplyMap.fromJSON(JSON.parse(JSON.stringify(m.toJSON())), 3);
  assert.equal(r.lookup(2), "b");
  assert.equal(ReplyMap.fromJSON("broken").size, 0, "깨진 저장값은 빈 맵");
});

test("FollowUpRegistry: 기간 내 회신, 만료 시 삭제", () => {
  const f = new FollowUpRegistry();
  f.mark("c-cae", "7203583138", 0);
  assert.equal(f.chatFor("c-cae", ROUTER_FOLLOWUP_MS), "7203583138");
  assert.equal(f.chatFor("c-cae", ROUTER_FOLLOWUP_MS + 1), undefined);
  assert.equal(f.size, 0);
  assert.equal(f.chatFor(undefined, 0), undefined);
});

test("sanitizeTargets: 삭제된 대화·기본 대화·중복 제거, 별칭 정리", () => {
  const out = sanitizeTargets(
    [CAE, { ...CAE }, { ...KDA, aliases: ["@KDA ", ""] }, { convId: "c-gone", label: "x", aliases: [], description: "" }, { convId: "c-tg", label: "t", aliases: [], description: "" }],
    new Set(["c-cae", "c-kda", "c-tg"]),
    "c-tg",
  );
  assert.deepEqual(out.map((t) => t.convId), ["c-cae", "c-kda"]);
  assert.deepEqual(out[1].aliases, ["KDA"]);
});

test("회신 머리표", () => {
  assert.equal(labelReply("완료", "CAE GUI", false), "[CAE GUI] 완료");
  assert.equal(labelReply("완료", "텔레그램", true), "완료");
});
