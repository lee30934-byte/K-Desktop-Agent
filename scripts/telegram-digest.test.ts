// v0.7.54 — 텔레그램 회신 가공 순수 로직 회귀 테스트.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractChoices,
  classifyTier,
  extractImagePaths,
  unreachableImageRefs,
  inQuietHours,
  deliveryPlan,
  fallbackSummary,
  encodeChoiceCallback,
  decodeChoiceCallback,
  encodeApprovalCallback,
  decodeApprovalCallback,
} from "../src/telegramDigest.ts";

const DECISION = `빌드 결과를 확인했습니다.

**정해 주실 것**
1. 권장 묶음 그대로
2. 4까지 포함
3. 지금 계획만

번호로 알려 주세요.`;

test("선택지 추출: 연속 번호 / 원문자 / 비연속은 제외", () => {
  assert.deepEqual(extractChoices(DECISION).map((c) => c.key), ["1", "2", "3"]);
  assert.deepEqual(extractChoices("① 예\n② 아니오").map((c) => c.label), ["예", "아니오"]);
  assert.deepEqual(extractChoices("3. 셋\n4. 넷"), [], "1부터 시작 안 하면 선택지 아님");
  assert.deepEqual(extractChoices("1. 하나만"), [], "1개는 선택지 아님");
  const long = extractChoices("1. " + "가".repeat(60) + "\n2. b");
  assert.ok(long[0].label.length <= 28);
});

test("등급: 결정 > 오류 > 진행 > 결과", () => {
  assert.equal(classifyTier(DECISION), "decision");
  assert.equal(classifyTier("진행할까요?"), "decision");
  assert.equal(classifyTier("❌ 빌드 실패: rc=1"), "error");
  assert.equal(classifyTier("Traceback (most recent call last): ..."), "error");
  assert.equal(classifyTier("⏳ 진행 중 7분"), "progress");
  assert.equal(classifyTier("v0.7.53 릴리즈 빌드 성공. 12분 소요."), "result");
  // 오류 내용이 있어도 마지막에 결정을 요구하면 결정 (질문 누락 방지)
  assert.equal(classifyTier("❌ 테스트 실패\n\n1. 재시도\n2. 중단\n\n번호로 알려 주세요."), "decision");
  // 번호 목록만 있고 결정 문구가 없으면 결과
  assert.equal(classifyTier("확인한 내용\n1. 빌드 성공\n2. 서명 확인"), "result");
});

test("이미지 경로 추출: 마크다운/백틱/맨 경로, 역슬래시 정규화, 중복 제거", () => {
  const t = [
    "![미리보기](C:/Users/lee30/.kda/previews/a.png)",
    "결과: `C:\\Users\\lee30\\out\\b.jpg`",
    "또 C:/Users/lee30/.kda/previews/a.png 와 D:/x/c.webp",
    "문서 C:/docs/report.pdf 는 제외",
  ].join("\n");
  assert.deepEqual(extractImagePaths(t), [
    "C:/Users/lee30/.kda/previews/a.png",
    "C:/Users/lee30/out/b.jpg",
    "D:/x/c.webp",
  ]);
  assert.deepEqual(extractImagePaths("이미지 없음"), []);
});

test("원격 경로는 별도로 잡아 실패 안내", () => {
  assert.deepEqual(unreachableImageRefs("VM: /home/lee/mhap/out/scene1.png 생성"), ["/home/lee/mhap/out/scene1.png"]);
  assert.deepEqual(unreachableImageRefs("C:/a/b.png"), []);
});

test("조용한 시간: 자정 넘는 구간 / 일반 구간 / 꺼짐", () => {
  const q = { enabled: true, startHour: 23, endHour: 7 };
  const at = (h: number) => new Date(2026, 9, 29, h, 30);
  assert.equal(inQuietHours(q, at(23)), true);
  assert.equal(inQuietHours(q, at(3)), true);
  assert.equal(inQuietHours(q, at(7)), false);
  assert.equal(inQuietHours(q, at(12)), false);
  assert.equal(inQuietHours({ enabled: true, startHour: 13, endHour: 14 }, at(13)), true);
  assert.equal(inQuietHours({ ...q, enabled: false }, at(3)), false);
});

test("전송 계획: 결정/오류는 조용한 시간에도 즉시", () => {
  assert.equal(deliveryPlan("decision", true), "send");
  assert.equal(deliveryPlan("error", true), "send");
  assert.equal(deliveryPlan("result", true), "hold");
  assert.equal(deliveryPlan("result", false), "send");
  assert.equal(deliveryPlan("progress", false), "skip");
});

test("요약 실패 대체본", () => {
  assert.equal(fallbackSummary("짧음"), "짧음");
  const f = fallbackSummary("x".repeat(2000));
  assert.ok(f.length < 900 && f.includes("요약 실패"));
});

test("버튼 callback 인코딩 왕복 + 64바이트 + 변조 거부", () => {
  const cb = encodeChoiceCallback("7e8845d0-aaaa-bbbb", "2");
  assert.ok(Buffer.byteLength(cb) <= 64);
  assert.deepEqual(decodeChoiceCallback(cb), { convPrefix: "7e8845d0", key: "2" });
  assert.equal(decodeChoiceCallback("c:zzz;rm:1"), null);
  const ap = encodeApprovalCallback("tok_ABC123xyz", true);
  assert.deepEqual(decodeApprovalCallback(ap), { token: "tok_ABC123xyz", approve: true });
  assert.equal(decodeApprovalCallback("a:tok:maybe"), null);
  assert.equal(decodeApprovalCallback(ap.replace(":y", ":n"))?.approve, false);
});
