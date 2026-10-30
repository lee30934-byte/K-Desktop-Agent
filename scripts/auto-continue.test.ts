// v0.7.57 — 자동 이어가기(턴 끝 질문 검사기) 테스트.
// 픽스처: 2026-10-29 16:15~21:20 실제 답변 끝부분 13개 (conversations.db 에서 추출).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  classifyTurnEnding, buildAutoContinuePrompt, AutoContinueChain, isAutoContinueMessage,
  AUTO_CONTINUE_MARK, AUTO_CONTINUE_MAX_CHAIN,
} from "../src/autoContinue.ts";

const FX: Array<{ at: string; conv: string; tail: string }> = JSON.parse(
  fs.readFileSync(new URL("./fixtures/auto-continue-20261029.json", import.meta.url), "utf8"),
);
const at = (t: string) => {
  const f = FX.find((x) => x.at === t);
  assert.ok(f, `fixture ${t} 없음`);
  return f!.tail;
};

test("실측: 확인 사유가 있는 질문은 allowed (K 를 기다림)", () => {
  assert.equal(classifyTurnEnding(at("16:15")).kind, "allowed"); // 0.7.56 태그 push
  assert.match(classifyTurnEnding(at("16:15")).category!, /③/);
  // v0.7.60: CAE 설치본 제거·빌드 삭제 승인 질문은 2026-10-29 K 상시 승인 규칙 1 범위 → 기다리지 않고
  // 조건 재확인 문구와 함께 이어가기 (규칙 밖이면 모델이 주입 문구 지시대로 사유를 밝히고 멈춘다).
  for (const t of ["16:18", "17:01", "18:15"]) {
    const v = classifyTurnEnding(at(t));
    assert.equal(v.kind, "unneeded", t);
    assert.match(v.standing!, /상시 승인 1/, t);
    assert.match(buildAutoContinuePrompt(v), /dry-run exit 0/, t);
  }
  assert.equal(classifyTurnEnding(at("18:01")).kind, "allowed"); // 크롬 디버그 포트로 로그인 세션 제어 (보안 권한)
  assert.equal(classifyTurnEnding(at("17:22")).kind, "allowed"); // 프리미엄 약관·저작권 선택
});

test("실측: 확인 사유 없는 질문은 unneeded (자동 이어가기 대상)", () => {
  assert.equal(classifyTurnEnding(at("16:51")).kind, "unneeded"); // "pitfall 로 기록할까요?" (앞 문장의 '업로드' 에 속지 않음)
  assert.equal(classifyTurnEnding(at("18:05")).kind, "unneeded"); // CAE P4 다음 항목 선택 (추천 있음)
  assert.equal(classifyTurnEnding(at("21:20")).kind, "unneeded"); // "추천은 1+2+3, 번호로 골라 주시면"
});

test("실측: 질문으로 끝나지 않은 보고는 none", () => {
  for (const t of ["20:53", "21:08", "17:03", "16:45"]) assert.equal(classifyTurnEnding(at(t)).kind, "none", t);
});

// v0.7.60 — 2026-10-30 실측 16건 (auto-continue.log 의 판정 + conversations.db 답변 끝 1500자).
// 0.7.59 는 12건을 WAIT 로 멈췄고 그중 7건이 오판이었다 (인용 문구, 보고 문장의 push/공개, PowerShell 의 Power,
// "강제 종료하는 실행기", 상시 승인된 CAE 칸 정리, 묻지 않기로 한 함정 기록).
const FX30: Array<{ at: string; conv: string; logged: string; tail: string }> = JSON.parse(
  fs.readFileSync(new URL("./fixtures/auto-continue-20261030.json", import.meta.url), "utf8"),
);
const at30 = (t: string, conv: string) => {
  const f = FX30.find((x) => x.at === t && x.conv === conv && (x.logged === "WAIT" || FX30.filter((y) => y.at === t && y.conv === conv).length === 1));
  assert.ok(f, `fixture ${t} ${conv} 없음`);
  return f!.tail;
};

test("실측 10-30: 진짜 확인 사유는 여전히 allowed", () => {
  for (const [t, conv, cat] of [
    ["08:26", "4c0c79e0", "③"], // 친구 입장 링크가 바뀌는 보안 방안 선택
    ["08:43", "64d71ea9", "⑤"], // A/B 직접 청취 비교
    ["09:35", "4c0c79e0", "④"], // 생방송 중 반영 시점 + 보안 방안
    ["12:54", "4c0c79e0", "①"], // 생방송 중 서버 재시작
    ["13:20", "4c0c79e0", "③"], // 생방송 중 배포·테스트 시점
  ] as const) {
    const v = classifyTurnEnding(at30(t, conv));
    assert.equal(v.kind, "allowed", t);
    assert.ok(v.category!.startsWith(cat), `${t} → ${v.category}`);
  }
});

test("실측 10-30: 오판 7건은 더 이상 멈추지 않는다", () => {
  assert.equal(classifyTurnEnding(at30("00:03", "5256a6b2")).kind, "none");      // 인용 문구 "기록할까요?"
  for (const [t, conv] of [
    ["00:44", "64d71ea9"], // "이미 공개 완료됐고" 보고 문장
    ["08:50", "5256a6b2"], // "PowerShell" 의 Power
    ["09:11", "9956f153"], // "push/tag/release는 하지 않았습니다"
  ] as const) assert.equal(classifyTurnEnding(at30(t, conv)).kind, "unneeded", t);
  for (const [t, conv, re] of [
    ["09:11", "7e8845d0", /상시 승인 1/], // 오래된 빌드 지우는 승인
    ["10:25", "7e8845d0", /상시 승인 1/], // 오래된 빌드 삭제 승인
    ["08:54", "9956f153", /실패 자동 포착/], // 함정 기록 3건 승인 대기
  ] as const) {
    const v = classifyTurnEnding(at30(t, conv));
    assert.equal(v.kind, "unneeded", t);
    assert.match(v.standing!, re, t);
  }
});

test("합성 10-30: 오판 패턴과 진짜 사유 구분", () => {
  for (const txt of [
    "감시기는 PowerShell 로 띄웠습니다.\n\n1번과 3번 중 어느 쪽으로 진행할지 번호로 알려 주세요.",
    "가드가 강제 종료하는 실행기로 감싸지 않는다.\n\n기록하려면 번호로 답해 주시면 됩니다.",
    "**결과**\n- 00:02:03 재시작\n- 완료\n\n다음 단계 순서를 어떻게 할까요?\n1. A\n2. B",
    "\"기록할까요?\" 라고 묻지 않습니다.",
  ]) assert.notEqual(classifyTurnEnding(txt).kind, "allowed", txt);
  for (const [txt, cat] of [
    ["준비했습니다. 5080 PC를 종료할까요?", "①"],
    ["오래된 빌드 3개와 보호 설치본 a45를 삭제할까요? 보안 키도 교체합니다.", "②"], // 다른 사유(④)가 섞이면 상시 승인으로 넘기지 않음
    ["빌드는 끝났습니다. 태그 push 를 할까요?", "③"],
  ] as const) {
    const v = classifyTurnEnding(txt);
    assert.equal(v.kind, "allowed", txt);
    assert.ok(v.category!.startsWith(cat), `${txt} → ${v.category}`);
  }
});

test("합성: 앞쪽 보고 문장의 위험 단어가 질문 판정을 오염시키지 않는다", () => {
  const txt = "빌드 결과입니다.\n\n- 삭제는 하지 않았습니다. 배포도 안 했습니다.\n\n다음 단계 순서를 어떻게 할까요?\n1. A 먼저\n2. B 먼저";
  assert.equal(classifyTurnEnding(txt).kind, "unneeded");
});

test("합성: 끝의 '?' + 번호 목록도 질문으로 본다", () => {
  const txt = "정리했습니다.\n\n어느 방식이 나을지?\n1. 표\n2. 그래프";
  assert.equal(classifyTurnEnding(txt).kind, "unneeded");
});

test("합성: 질문 문장 안에 확인 사유 단어가 있으면 allowed", () => {
  for (const [txt, cat] of [
    ["준비했습니다. 5080을 재부팅할까요?", "①"],
    ["정리 대상 12개입니다. 삭제를 진행할까요?", "②"],
    ["테스트 통과. 태그를 push 할까요?", "③"],
    ["유료 플랜 결제가 필요합니다. 진행할까요?", "④"],
    ["샘플을 만들었습니다. 직접 들어 보시고 어느 쪽이 좋은지 골라 주세요.", "⑤"],
  ] as const) {
    const v = classifyTurnEnding(txt);
    assert.equal(v.kind, "allowed", txt);
    assert.ok(v.category!.startsWith(cat), `${txt} → ${v.category}`);
  }
});

test("빈 응답·질문 없는 응답은 none", () => {
  assert.equal(classifyTurnEnding("").kind, "none");
  assert.equal(classifyTurnEnding(undefined).kind, "none");
  assert.equal(classifyTurnEnding("완료했습니다. 테스트 12/12 통과.").kind, "none");
});

test("주입 문구: 표식·6가지 사유·재확인 문장 포함", () => {
  const p = buildAutoContinuePrompt({ kind: "unneeded", ask: "골라 주시면" });
  assert.ok(p.startsWith(AUTO_CONTINUE_MARK));
  for (const n of ["①", "②", "③", "④", "⑤", "⑥"]) assert.ok(p.includes(n), n);
  assert.match(p, /추천안으로 정하고/);
  assert.match(p, /진행하지 말고/);
  assert.ok(isAutoContinueMessage(p));
  assert.equal(isAutoContinueMessage("그냥 진행해"), false);
  // 주입 문구가 다음 답변 끝에 인용돼도 그 자체로 질문 판정을 만들지 않는다
  assert.equal(classifyTurnEnding("진행 완료.\n" + p.split("\n")[0].replace("직전 응답이 K님께 선택을 묻고 끝났습니다", "처리")).kind, "none");
});

test("연속 주입 한도: 대화별 최대 횟수 후 중단, reset 후 다시 허용", () => {
  const c = new AutoContinueChain();
  for (let i = 0; i < AUTO_CONTINUE_MAX_CHAIN; i++) assert.equal(c.tryTake("A"), true);
  assert.equal(c.tryTake("A"), false);
  assert.equal(c.tryTake("B"), true); // 다른 대화는 독립
  c.reset("A");
  assert.equal(c.count("A"), 0);
  assert.equal(c.tryTake("A"), true);
});

test("App 배선: 텍스트 수집·done 판정·실제 메시지 reset·nudge 토글 게이트·로그", () => {
  const app = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /autoContinueTextRef\.current\.set\(ev\.id, ev\.text\)/);
  assert.match(app, /autoContinueRunRef\.current\(convForTurn, ev\.id, finalText\)/);
  // stale done 판정 이후에만 실행 (stale 은 break 로 빠져야 함)
  assert.ok(app.indexOf("stale done 무시") < app.indexOf("autoContinueRunRef.current(convForTurn"));
  assert.match(app, /if \(targetId && !isAutoContinueMessage\(text\)\) autoContinueChainRef\.current\.reset\(targetId\)/);
  assert.match(app, /if \(!flags\?\.nudge\) return;/);
  assert.match(app, /append_auto_continue_log/);
  const rs = fs.readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(rs, /fn append_auto_continue_log\(/);
  assert.match(rs, /^\s*append_auto_continue_log,\s*$/m); // invoke_handler 등록
});
