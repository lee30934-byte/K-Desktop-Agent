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

import { seedRouteTargets } from "../src/telegramRouter.ts";

test("기본 분배 대상: 폴더·제목으로 찾고, 트레이딩 봇 제외, 최신 대화 선택", () => {
  const folders = [
    { id: "f-cae", name: "설계해석 자동화", systemPrompt: "CAE 지침" },
    { id: "f-kda", name: "KDA 개발" },
    { id: "f-tr", name: "트레이딩 봇" },
    { id: "f-tg", name: "텔레그램" },
  ];
  const convs = [
    { id: "kda-new", title: "새 작업", folderId: "f-kda" },
    { id: "cae-exec", title: "[CAE Exec] 수집", folderId: "f-cae" },
    { id: "cae-gui", title: "[CAE GUI] UI", folderId: "f-cae" },
    { id: "cae-sol", title: "[CAE Solver] 엔진", folderId: "f-cae" },
    { id: "kda-old", title: "옛 작업", folderId: "f-kda" },
    { id: "trade", title: "봇", folderId: "f-tr" },
    { id: "tg", title: "📱 텔레그램", folderId: "f-tg" },
  ];
  const t = seedRouteTargets(folders, convs, "tg");
  assert.deepEqual(t.map((x) => [x.label, x.convId]), [["CAE GUI", "cae-gui"], ["CAE Solver", "cae-sol"], ["KDA 개발", "kda-new"]]);
  assert.ok(!t.some((x) => x.convId === "trade"), "트레이딩 봇 제외");
  assert.match(t[0].description, /CAE 지침/);
});

// ── v0.7.68 여러 대상 분배 ─────────────────────────────────────────
import { decideRoutes, parseClassifierParts, splitPartText } from "../src/telegramRouter.ts";

// 2026-10-31 실제로 General 로 떨어진 복합 명령 (telegram-bridge.log 17:07~17:20, by=default ai-picked-general)
const REAL_COMPOUND = "Cae d4진행해 음악공유방 아바타 리스트를 늘려 Treblo 정확히 어디까지 진행됐는지 보고해";
const LISTEN: RouteTarget = { convId: "c-listen", label: "음악공유방", aliases: ["방"], description: "음악 공유방" };
const TREBLO: RouteTarget = { convId: "c-treblo", label: "Treblo", aliases: ["treblo"], description: "음악 생성" };
const T4 = [CAE, KDA, LISTEN, TREBLO];
const base4 = { targets: T4, defaultTarget: DEF, now: 1_000_000 };

test("분할 응답 파싱: 정상 / 항목 하나라도 틀리면 null / 단일 형식은 null", () => {
  const ok = parseClassifierParts('{"parts":[{"pick":1,"text":"d4진행해","confidence":0.9},{"pick":4,"text":"어디까지","confidence":0.8}]}', T4);
  assert.equal(ok?.length, 2);
  assert.equal(ok?.[0].target?.convId, "c-cae");
  assert.equal(ok?.[1].text, "어디까지");
  assert.equal(parseClassifierParts('{"parts":[{"pick":9,"text":"x","confidence":0.9}]}', T4), null, "범위 밖");
  assert.equal(parseClassifierParts('{"parts":[{"pick":1,"text":"","confidence":0.9}]}', T4), null, "빈 몫");
  assert.equal(parseClassifierParts('{"parts":[{"pick":1,"text":"a","confidence":2}]}', T4), null, "확신도 범위 밖");
  assert.equal(parseClassifierParts('{"pick":1,"confidence":0.9}', T4), null, "단일 형식");
  assert.equal(parseClassifierParts("{broken", T4), null);
});

test("프롬프트가 분할 형식을 안내한다", () => {
  assert.match(buildClassifierPrompt(REAL_COMPOUND, T4), /"parts"/);
});

test("실측 복합 명령: 세 대상으로 나눠 각각 자기 몫 + 원문 참고", async () => {
  const classify = async () => JSON.stringify({ parts: [
    { pick: 1, text: "Cae d4진행해", confidence: 0.92 },
    { pick: 3, text: "음악공유방 아바타 리스트를 늘려", confidence: 0.95 },
    { pick: 4, text: "Treblo 정확히 어디까지 진행됐는지 보고해", confidence: 0.9 },
  ] });
  const ds = await decideRoutes({ ...base4, text: REAL_COMPOUND, classify });
  assert.deepEqual(ds.map((d) => d.convId), ["c-cae", "c-listen", "c-treblo"]);
  assert.ok(ds.every((d) => d.source === "ai"));
  assert.match(ds[1].text, /^음악공유방 아바타 리스트를 늘려\n\n\[텔레그램 복합 명령/);
  assert.ok(ds.every((d) => d.text.includes(REAL_COMPOUND)), "원문 참고 포함");
  assert.equal(ds[2].note, "split 3/3");
});

test("분할: 확신도 미달·General 몫은 기본 대화 한 건으로 모은다", async () => {
  const classify = async () => JSON.stringify({ parts: [
    { pick: 1, text: "d4 진행", confidence: 0.9 },
    { pick: 0, text: "5080 상태", confidence: 0.9 },
    { pick: 4, text: "음악 확인", confidence: 0.3 },
  ] });
  const ds = await decideRoutes({ ...base4, text: "d4 진행, 5080 상태, 음악 확인", classify });
  assert.deepEqual(ds.map((d) => d.convId), ["c-cae", "c-tg"]);
  assert.match(ds[1].text, /^5080 상태\n음악 확인\n\n\[/);
  assert.match(ds[1].note!, /general-part/);
});

test("분할했지만 대상이 하나뿐이면 원문 전체를 그 대상에 / 전부 General 이면 기본 대화", async () => {
  let ds = await decideRoutes({ ...base4, text: "CAE 두 가지", classify: async () =>
    '{"parts":[{"pick":1,"text":"a","confidence":0.9},{"pick":1,"text":"b","confidence":0.8}]}' });
  assert.equal(ds.length, 1); assert.equal(ds[0].convId, "c-cae"); assert.equal(ds[0].text, "CAE 두 가지");
  ds = await decideRoutes({ ...base4, text: "안녕", classify: async () => '{"parts":[{"pick":0,"text":"안녕","confidence":0.9}]}' });
  assert.equal(ds.length, 1); assert.equal(ds[0].convId, "c-tg"); assert.equal(ds[0].note, "ai-picked-general");
});

test("기존 단일 형식·답장·별칭·분류 실패는 예전과 같은 1건", async () => {
  let ds = await decideRoutes({ ...base4, text: "화면 어두워", classify: async () => '{"pick":1,"confidence":0.9}' });
  assert.equal(ds.length, 1); assert.equal(ds[0].convId, "c-cae"); assert.equal(ds[0].source, "ai");
  ds = await decideRoutes({ ...base4, text: "@kda 빌드", classify: async () => { throw new Error("must not call"); } });
  assert.equal(ds[0].source, "alias"); assert.equal(ds[0].text, "빌드");
  ds = await decideRoutes({ ...base4, text: "1", replyToConvId: "c-listen", classify: async () => { throw new Error("x"); } });
  assert.equal(ds[0].source, "reply");
  ds = await decideRoutes({ ...base4, text: "뭔가", classify: async () => { throw new Error("timeout"); } });
  assert.equal(ds[0].convId, "c-tg"); assert.match(ds[0].note!, /classify-failed/);
});

test("splitPartText: 긴 원문은 300자로 자른다", () => {
  const s = splitPartText("몫", "가".repeat(400));
  assert.ok(s.includes("가".repeat(300) + "…"));
  assert.ok(!s.includes("가".repeat(301)));
});

// 2026-11-01 실제 분류 모델(codex_oneshot, gpt-6-luna, reasoning low) 응답 그대로 — 10-31 복합 명령 2건
const LIVE_REPLY_0 = "{\"parts\":[{\"pick\":1,\"text\":\"Cae d4진행해\",\"confidence\":0.99},{\"pick\":3,\"text\":\"음악공유방 아바타 리스트를 늘려\",\"confidence\":0.99},{\"pick\":4,\"text\":\"Treblo 정확히 어디까지 진행됐는지 보고해\",\"confidence\":0.99}]}";
const LIVE_REPLY_1 = "{\"parts\":[{\"pick\":1,\"text\":\"Cae는 슬롯정리 승인\",\"confidence\":0.98},{\"pick\":3,\"text\":\"음악공유방은 아바타케릭 진행중일텐데?? 다했다면 캐릭터 커스터 마이징 가능하게 헤어스타일이나 얼굴모양 종류들 늘이기\",\"confidence\":0.99},{\"pick\":4,\"text\":\"Treblo는 오늘자 음악이 완성됐는지 확인해\",\"confidence\":0.99}]}";
test("실측 모델 응답: 복합 명령 2건 모두 CAE·음악공유방·Treblo 3곳으로 분배", async () => {
  const T = [CAE, { ...KDA, label: "CAE Solver" }, LISTEN, TREBLO];
  for (const raw of [LIVE_REPLY_0, LIVE_REPLY_1]) {
    const ds = await decideRoutes({ targets: T, defaultTarget: DEF, now: 1, text: "원문", classify: async () => raw });
    assert.deepEqual(ds.map((d) => d.label), ["CAE GUI", "음악공유방", "Treblo"]);
  }
});
