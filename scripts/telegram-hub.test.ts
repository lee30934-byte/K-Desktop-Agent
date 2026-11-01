// v0.7.54 — TelegramHub 통합 로직 테스트 (가짜 Bot API / 가짜 Luna).
import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramHub, PROGRESS_FIRST_MS, APPROVAL_TIMEOUT_MS, type HubSettings } from "../src/telegramHub.ts";
import type { RouteTarget } from "../src/telegramRouter.ts";

const CHAT = "7203583138";
const CAE: RouteTarget = { convId: "7e8845d0-cae-gui", label: "CAE GUI", aliases: ["cae"], description: "설계해석 GUI" };
const KDA: RouteTarget = { convId: "aaaa1111-kda-dev", label: "KDA 개발", aliases: ["kda"], description: "KDA 앱" };
const DEF = { convId: "5256a6b2-telegram", label: "텔레그램" };

function mk(over: Partial<HubSettings> = {}, opts: { oneshot?: (p: string) => Promise<string>; failSend?: (m: string, p: any) => boolean } = {}) {
  let now = new Date(2026, 9, 29, 12, 0).getTime();
  let mid = 100;
  const sent: Array<{ method: string; payload: any }> = [];
  const files: Array<{ path: string; caption: string }> = [];
  const turns: Array<{ convId: string; text: string }> = [];
  const store = new Map<string, string>();
  const logs: string[] = [];
  const timers: Array<{ fn: () => void; at: number }> = [];
  const settings: HubSettings = {
    routing: true, digest: true, buttons: true, progress: true, inbox: true, approvals: true,
    quiet: { enabled: true, startHour: 23, endHour: 7 }, pcName: "", ...over,
  };
  const hub = new TelegramHub({
    api: {
      call: async (method, payload) => {
        if (opts.failSend?.(method, payload)) throw new Error("HTTP 400 — bad");
        sent.push({ method, payload });
        return { ok: true, result: { message_id: ++mid } };
      },
      sendFile: async (_c, path, caption) => {
        if (path.includes("missing")) throw new Error("not_found: " + path);
        files.push({ path, caption });
        return { ok: true, result: { message_id: ++mid } };
      },
      download: async (_id, name, day) => `C:/Users/lee30/.kda/inbox/${day}/${name}`,
      oneshot: opts.oneshot ?? (async () => '{"pick":1,"confidence":0.9}'),
    },
    startTurn: async (convId, text) => { turns.push({ convId, text }); },
    targets: () => [CAE, KDA],
    defaultTarget: () => DEF,
    settings: () => settings,
    now: () => now,
    log: (l) => { logs.push(l); },
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v) },
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms }); return 0; },
  });
  return {
    hub, sent, files, turns, store, settings, logs,
    advance: (ms: number) => { now += ms; for (const t of timers.splice(0)) { if (t.at <= now) t.fn(); else timers.push(t); } },
    setNow: (d: Date) => { now = d.getTime(); },
    texts: () => sent.filter((s) => s.method === "sendMessage").map((s) => String(s.payload.text)),
  };
}
const msgU = (text: string, extra: any = {}) => ({ update_id: 1, message: { message_id: 1, chat: { id: Number(CHAT) }, text, ...extra } });

test("AI 분배: CAE 로 전달 + 안내", async () => {
  const t = mk();
  await t.hub.handleUpdate(msgU("UI 가 너무 어둡다"));
  assert.deepEqual(t.turns, [{ convId: CAE.convId, text: "UI 가 너무 어둡다" }]);
  assert.match(t.texts()[0], /→ \[CAE GUI\]로 전달/);
});

test("분배 꺼짐이면 항상 텔레그램 대화 (v0.7.53 동작)", async () => {
  const t = mk({ routing: false });
  await t.hub.handleUpdate(msgU("UI 가 너무 어둡다"));
  assert.equal(t.turns[0].convId, DEF.convId);
  assert.equal(t.texts().length, 0, "안내 메시지 없음");
});

test("분류 실패해도 메시지는 텔레그램 대화로 처리 + 사유 안내", async () => {
  const t = mk({}, { oneshot: async () => { throw new Error("timeout: 20초 초과"); } });
  await t.hub.handleUpdate(msgU("아무거나"));
  assert.equal(t.turns[0].convId, DEF.convId);
  assert.match(t.texts()[0], /자동 분류 실패/);
});

test("결과 회신: 짧은 결과는 원문 + 라벨 + 답장 매핑 → 답장은 같은 대화로", async () => {
  const t = mk();
  await t.hub.deliverResult({ convId: CAE.convId, chatId: CHAT, text: "밝기 대비 측정 완료" });
  const last = t.sent.at(-1)!;
  assert.match(String(last.payload.text), /^✅ \[CAE GUI\] 밝기 대비 측정 완료/);
  const mid = 101;
  await t.hub.handleUpdate(msgU("그럼 2안으로", { reply_to_message: { message_id: mid } }));
  assert.equal(t.turns.at(-1)!.convId, CAE.convId);
});

test("결정 필요: 버튼 붙음 → 버튼 누르면 그 대화에 번호 전달 + 버튼 제거", async () => {
  const t = mk();
  await t.hub.deliverResult({ convId: KDA.convId, chatId: CHAT, text: "릴리즈 준비 완료\n\n1. 지금 태그 push\n2. 내일 push\n\n번호로 알려 주세요." });
  const m = t.sent.at(-1)!;
  assert.match(String(m.payload.text), /^❓/);
  const kb = (m.payload.reply_markup as any).inline_keyboard;
  assert.equal(kb.length, 2);
  await t.hub.handleUpdate({ update_id: 2, callback_query: { id: "cq1", data: kb[1][0].callback_data, message: { message_id: 101, chat: { id: Number(CHAT) } } } });
  assert.deepEqual(t.turns.at(-1), { convId: KDA.convId, text: "2" });
  assert.ok(t.sent.some((s) => s.method === "editMessageReplyMarkup"));
  assert.ok(t.sent.some((s) => s.method === "answerCallbackQuery"));
});

test("버튼 전송이 거부되면 버튼 없이 재전송 (텍스트 유실 없음)", async () => {
  const t = mk({}, { failSend: (m, p) => m === "sendMessage" && !!p.reply_markup });
  await t.hub.deliverResult({ convId: KDA.convId, chatId: CHAT, text: "1. 가\n2. 나\n\n번호로 알려 주세요." });
  assert.equal(t.texts().length, 1);
  assert.equal(t.sent[0].payload.reply_markup, undefined);
});

test("긴 결과는 Luna 요약 + '자세히' 답장으로 원문", async () => {
  const long = "빌드 로그 ".repeat(200) + "\n성공";
  const t = mk({}, { oneshot: async (p) => (p.startsWith("You condense") ? "빌드 성공, 12분" : '{"pick":0,"confidence":1}') });
  await t.hub.deliverResult({ convId: CAE.convId, chatId: CHAT, text: long });
  assert.match(t.texts()[0], /빌드 성공, 12분/);
  assert.match(t.texts()[0], /자세히/);
  await t.hub.handleUpdate(msgU("자세히", { reply_to_message: { message_id: 101 } }));
  assert.equal(t.texts().at(-1), long.slice(0, 4000));
});

test("요약 실패 → 원문 앞부분 대체본", async () => {
  const t = mk({}, { oneshot: async () => { throw new Error("codex_failed"); } });
  await t.hub.deliverResult({ convId: CAE.convId, chatId: CHAT, text: "x".repeat(3000) });
  assert.match(t.texts()[0], /요약 실패/);
});

test("오류는 조용한 시간에도 즉시, 일반 결과는 보류 후 아침에 한 번에", async () => {
  const t = mk();
  t.setNow(new Date(2026, 9, 30, 2, 0));
  await t.hub.deliverResult({ convId: CAE.convId, chatId: CHAT, text: "❌ 빌드 실패: rc=1" });
  await t.hub.deliverResult({ convId: KDA.convId, chatId: CHAT, text: "테스트 12개 통과" });
  assert.equal(t.texts().length, 1);
  assert.match(t.texts()[0], /^❌/);
  assert.equal(t.hub.heldCount, 1);
  await t.hub.tickDigest(CHAT);
  assert.equal(t.texts().length, 1, "아직 조용한 시간");
  t.setNow(new Date(2026, 9, 30, 7, 1));
  await t.hub.tickDigest(CHAT);
  assert.match(t.texts().at(-1)!, /밤사이 결과 1건[\s\S]*KDA 개발/);
  assert.equal(t.hub.heldCount, 0);
});

test("보류분 전송 실패 시 유실 없이 다음 틱 재시도", async () => {
  let fail = true;
  const t = mk({}, { failSend: () => fail });
  t.setNow(new Date(2026, 9, 30, 2, 0));
  await t.hub.deliverResult({ convId: KDA.convId, chatId: CHAT, text: "완료" });
  t.setNow(new Date(2026, 9, 30, 8, 0));
  await t.hub.tickDigest(CHAT);
  assert.equal(t.hub.heldCount, 1);
  fail = false;
  await t.hub.tickDigest(CHAT);
  assert.equal(t.hub.heldCount, 0);
});

test("진행 중 보고는 보내지 않음", async () => {
  const t = mk();
  await t.hub.deliverResult({ convId: CAE.convId, chatId: CHAT, text: "⏳ 진행 중 7분" });
  assert.equal(t.texts().length, 0);
});

test("이미지: 있는 파일 전송, 없는 파일·VM 경로는 사유 안내, 최대 5장", async () => {
  const t = mk();
  const imgs = Array.from({ length: 6 }, (_, i) => `C:/out/s${i}.png`).join("\n");
  await t.hub.deliverResult({ convId: CAE.convId, chatId: CHAT, text: `완료\n${imgs}\nC:/out/missing.png\n/home/lee/x.png` });
  assert.equal(t.files.length, 5);
  assert.equal(t.files[0].caption, "[CAE GUI] s0.png");
  assert.match(t.texts().at(-1)!, /2장 더 있음|더 있음/);
  assert.match(t.texts().at(-1)!, /VM\/WSL/);
});

test("진행 메시지: 5분 전엔 없음 → 1개 생성 → 이후 수정 → 완료 시 종료 표시", async () => {
  const t = mk();
  const start = Date.now();
  t.setNow(new Date(start));
  await t.hub.tickProgress("turn1", CAE.convId, CHAT, start);
  assert.equal(t.sent.length, 0);
  t.advance(PROGRESS_FIRST_MS + 1000);
  await t.hub.tickProgress("turn1", CAE.convId, CHAT, start);
  t.advance(60_000);
  await t.hub.tickProgress("turn1", CAE.convId, CHAT, start);
  assert.equal(t.sent.filter((s) => s.method === "sendMessage").length, 1, "새 메시지는 1개만");
  assert.equal(t.sent.filter((s) => s.method === "editMessageText").length, 1);
  await t.hub.deliverResult({ convId: CAE.convId, chatId: CHAT, text: "끝", turnId: "turn1" });
  assert.ok(t.sent.some((s) => s.method === "editMessageText" && /진행 종료/.test(s.payload.text)));
});

test("/이동: 직전 메시지 재분배 + 학습 예시가 다음 분류 프롬프트에 들어감", async () => {
  let lastPrompt = "";
  const t = mk({}, { oneshot: async (p) => { lastPrompt = p; return '{"pick":1,"confidence":0.9}'; } });
  await t.hub.handleUpdate(msgU("릴리즈 로그 봐줘"));
  assert.equal(t.turns.at(-1)!.convId, CAE.convId);
  await t.hub.handleUpdate(msgU("/이동 kda"));
  assert.deepEqual(t.turns.at(-1), { convId: KDA.convId, text: "릴리즈 로그 봐줘" });
  assert.equal(t.hub.examplesCount, 1);
  await t.hub.handleUpdate(msgU("빌드 상태는?"));
  assert.match(lastPrompt, /Past corrections[\s\S]*릴리즈 로그 봐줘" -> 2/);
});

test("사진 수신: inbox 저장 후 경로를 붙여 분배 / 꺼짐이면 안내", async () => {
  const t = mk();
  await t.hub.handleUpdate(msgU(undefined as any, { text: undefined, caption: "@cae 이 형상 검토", photo: [{ file_id: "s" }, { file_id: "L" }] }));
  assert.equal(t.turns.at(-1)!.convId, CAE.convId);
  assert.match(t.turns.at(-1)!.text, /이 형상 검토[\s\S]*\[텔레그램 첨부 파일\] C:\/Users\/lee30\/.kda\/inbox\/\d{8}\/photo_1\.jpg/);
  const off = mk({ inbox: false });
  await off.hub.handleUpdate(msgU(undefined as any, { text: undefined, photo: [{ file_id: "L" }] }));
  assert.equal(off.turns.length, 0);
  assert.match(off.texts()[0], /파일 받기가 꺼져/);
});

test("원격 승인: 승인 버튼 → true, 재클릭은 무효", async () => {
  const t = mk();
  const { result } = t.hub.requestApproval({ convId: CAE.convId, chatId: CHAT, detail: "명령: npm test" });
  await new Promise((r) => setTimeout(r, 0));
  const kb = (t.sent.at(-1)!.payload.reply_markup as any).inline_keyboard[0];
  await t.hub.handleUpdate({ update_id: 3, callback_query: { id: "a", data: kb[0].callback_data, message: { message_id: 101, chat: { id: Number(CHAT) } } } });
  assert.equal(await result, true);
  await t.hub.handleUpdate({ update_id: 4, callback_query: { id: "b", data: kb[0].callback_data, message: { message_id: 101, chat: { id: Number(CHAT) } } } });
  assert.match(String(t.sent.at(-1)!.payload.text), /이미 처리됐거나 만료/);
});

test("원격 승인: 5분 무응답이면 거절 / 설정 꺼짐이면 즉시 거절 / 데스크톱 우선", async () => {
  const t = mk();
  const a = t.hub.requestApproval({ convId: CAE.convId, chatId: CHAT, detail: "rm -rf x" });
  await new Promise((r) => setTimeout(r, 0));
  t.advance(APPROVAL_TIMEOUT_MS + 1);
  assert.equal(await a.result, false);
  const off = mk({ approvals: false });
  assert.equal(await off.hub.requestApproval({ convId: CAE.convId, chatId: CHAT, detail: "x" }).result, false);
  const b = t.hub.requestApproval({ convId: CAE.convId, chatId: CHAT, detail: "y" });
  await new Promise((r) => setTimeout(r, 0));
  t.hub.cancelApproval(b.token, true);
  assert.equal(await b.result, true);
});

test("명령: /상태 /도움 /분배 는 턴을 만들지 않음", async () => {
  const t = mk();
  for (const c of ["/상태", "/도움", "/분배"]) await t.hub.handleUpdate(msgU(c));
  assert.equal(t.turns.length, 0);
  assert.match(t.texts()[0], /KDA 텔레그램 상태/);
  assert.match(t.texts()[2], /@cae/);
});

test("깨진 저장값에서도 시작 (자가 복구)", () => {
  const t = mk();
  t.store.set("kda_tg_hub_replymap", "{broken");
  t.store.set("kda_tg_hub_held", "nope");
  // 새 허브가 예외 없이 생성되는지
  const h2 = new TelegramHub({ ...(t.hub as any).d });
  assert.equal(h2.heldCount, 0);
});

test("v0.7.56 성공 전송·요약·사진도 로그에 남는다 (감시 증거)", async () => {
  const long = "결과 ".repeat(400);
  const t = mk({}, { oneshot: async (p) => (p.startsWith("You condense") ? "요약본" : '{"pick":0,"confidence":1}') });
  await t.hub.deliverResult({ convId: CAE.convId, chatId: CHAT, text: long + "\nC:/out/a.png\nC:/out/missing.png" });
  assert.ok(t.logs.some((l) => /^HUB SENT conv=7e8845d0 mid=\d+ part=1\/1/.test(l)), t.logs.join("\n"));
  assert.ok(t.logs.some((l) => /^HUB SUMMARY ok tier=result/.test(l)));
  assert.ok(t.logs.some((l) => /^HUB PHOTO ok conv=7e8845d0 file=a\.png/.test(l)));
  assert.ok(t.logs.some((l) => /^HUB PHOTO failed conv=7e8845d0 file=missing\.png/.test(l)));
});

// ── v0.7.68 여러 대상 분배 ─────────────────────────────────────────
test("복합 명령: 대상별로 나눠 턴 2개 + 접수 확인 1건 + 후속 회신 등록", async () => {
  const t = mk({}, { oneshot: async () => JSON.stringify({ parts: [
    { pick: 1, text: "Cae d4진행해", confidence: 0.9 },
    { pick: 2, text: "KDA 빌드 확인해", confidence: 0.9 },
  ] }) });
  await t.hub.handleUpdate(msgU("Cae d4진행해 KDA 빌드 확인해"));
  assert.deepEqual(t.turns.map((x) => x.convId), [CAE.convId, KDA.convId]);
  assert.match(t.turns[0].text, /^Cae d4진행해\n\n\[텔레그램 복합 명령/);
  const acks = t.texts().filter((x) => x.startsWith("→ 나눠서 전달"));
  assert.equal(acks.length, 1);
  assert.match(acks[0], /\[CAE GUI\] Cae d4진행해/);
  assert.match(acks[0], /\[KDA 개발\] KDA 빌드 확인해/);
  assert.ok(!acks[0].includes("[텔레그램 복합 명령"), "접수 확인에는 원문 참고 꼬리를 넣지 않는다");
  assert.equal(t.logs.filter((l) => l.includes("HUB ROUTE") && l.includes("split")).length, 2);
});

test("복합 명령: 한 대상 시작 실패가 다른 대상을 막지 않는다", async () => {
  const t = mk({}, { oneshot: async () => JSON.stringify({ parts: [
    { pick: 1, text: "a 해", confidence: 0.9 },
    { pick: 2, text: "b 해", confidence: 0.9 },
  ] }) });
  const orig = (t.hub as any).d.startTurn;
  (t.hub as any).d.startTurn = async (convId: string, text: string) => {
    if (convId === CAE.convId) throw new Error("busy");
    return orig(convId, text);
  };
  await t.hub.handleUpdate(msgU("a 해 b 해"));
  assert.deepEqual(t.turns.map((x) => x.convId), [KDA.convId]);
  assert.ok(t.texts().some((x) => /⚠ \[CAE GUI\] 처리 시작 실패/.test(x)));
});

// ── v0.7.68 방 고르기: 번호 별칭 · /방 버튼 ─────────────────────────────
const cbU = (data: string, mid = 500) => ({ update_id: 3, callback_query: { id: "cqr", data, message: { message_id: mid, chat: { id: Number(CHAT) } } } });
const noClassify = async () => { throw new Error("분류기를 부르면 안 됨"); };

test("/분배: 번호와 @번호 별칭이 보이고 기존 별칭도 유지", async () => {
  const t = mk();
  await t.hub.handleUpdate(msgU("/분배"));
  const txt = t.texts()[0];
  assert.match(txt, /- 1\. CAE GUI — @1 @cae/);
  assert.match(txt, /- 2\. KDA 개발 — @2 @kda/);
  assert.equal(t.turns.length, 0);
});

test("@번호: 분류기 없이 그 방으로, 머리말은 떼고 전달", async () => {
  const t = mk({}, { oneshot: noClassify });
  await t.hub.handleUpdate(msgU("@2 빌드 상태 봐줘"));
  assert.deepEqual(t.turns, [{ convId: KDA.convId, text: "빌드 상태 봐줘" }]);
});

test("/방: 버튼 목록(0=기본 대화) → 누르면 다음 메시지 1건만 그 방으로", async () => {
  let calls = 0;
  const t = mk({}, { oneshot: async () => { calls++; return '{"pick":2,"confidence":0.9}'; } });
  await t.hub.handleUpdate(msgU("/방"));
  const kb = (t.sent.at(-1)!.payload.reply_markup as any).inline_keyboard;
  assert.deepEqual(kb.map((r: any) => r[0].text), ["0. 텔레그램", "1. CAE GUI", "2. KDA 개발"]);
  assert.equal(t.turns.length, 0, "/방 자체는 턴을 만들지 않음");
  await t.hub.handleUpdate(cbU(kb[1][0].callback_data));
  assert.ok(t.texts().some((x) => /📌 다음 메시지는 \[CAE GUI\]로/.test(x)));
  assert.ok(t.sent.some((s) => s.method === "editMessageReplyMarkup"), "버튼 제거");
  await t.hub.handleUpdate(msgU("KDA 얘기처럼 보이는 내용"));
  assert.deepEqual(t.turns.at(-1), { convId: CAE.convId, text: "KDA 얘기처럼 보이는 내용" });
  assert.equal(calls, 0, "고른 방이 있으면 분류기를 부르지 않음");
  await t.hub.handleUpdate(msgU("그 다음 메시지"));
  assert.equal(t.turns.at(-1)!.convId, KDA.convId, "1건 쓰고 나면 다시 자동 분류");
  assert.equal(calls, 1);
});

test("/방 2: 번호로 바로 고르기 / 없는 번호는 안내만", async () => {
  const t = mk({}, { oneshot: noClassify });
  await t.hub.handleUpdate(msgU("/방 9"));
  assert.match(t.texts().at(-1)!, /'9' 번 방이 없어요/);
  await t.hub.handleUpdate(msgU("/방 2"));
  await t.hub.handleUpdate(msgU("이거 해줘"));
  assert.deepEqual(t.turns, [{ convId: KDA.convId, text: "이거 해줘" }]);
});

test("/방: 10분 지나면 고른 방은 풀리고, 답장은 고른 방보다 우선", async () => {
  const t = mk({}, { oneshot: async () => '{"pick":2,"confidence":0.9}' });
  await t.hub.handleUpdate(msgU("/방 1"));
  t.advance(11 * 60 * 1000);
  await t.hub.handleUpdate(msgU("늦게 보낸 메시지"));
  assert.equal(t.turns.at(-1)!.convId, KDA.convId, "만료 → 자동 분류");
  // 답장 우선: 봇이 KDA 대화로 보낸 메시지에 답장
  await t.hub.handleUpdate(msgU("/방 1"));
  const mid = await t.hub.sendText(CHAT, "KDA 결과", KDA.convId);
  await t.hub.handleUpdate(msgU("이건 KDA 로", { reply_to_message: { message_id: mid } }));
  assert.equal(t.turns.at(-1)!.convId, KDA.convId);
});

test("/방: 목록이 바뀐 뒤의 옛 버튼은 무시", async () => {
  const t = mk({}, { oneshot: noClassify });
  await t.hub.handleUpdate(cbU("room:1:zzzzzzzz"));
  assert.equal(t.turns.length, 0);
  assert.ok(!t.texts().some((x) => x.startsWith("📌 다음 메시지는")));
});

// ── v0.7.69 명령 장부 · /현황 ───────────────────────────────────────
test("/현황: 복합 명령 #번호 → 각 방 회신에 따라 진행/결정 대기/완료로 바뀜", async () => {
  const t = mk({}, { oneshot: async () => JSON.stringify({ parts: [
    { pick: 1, text: "Cae d4진행해", confidence: 0.9 },
    { pick: 2, text: "KDA 빌드 확인해", confidence: 0.9 },
  ] }) });
  await t.hub.handleUpdate(msgU("Cae d4진행해 KDA 빌드 확인해"));
  assert.ok(t.texts().some((x) => x.startsWith("→ 나눠서 전달 #1")));
  await t.hub.handleUpdate(msgU("/현황"));
  assert.match(t.texts().at(-1)!, /\[CAE GUI\] ⏳ 진행[\s\S]*\[KDA 개발\] ⏳ 진행/);
  await t.hub.deliverResult({ convId: CAE.convId, chatId: CHAT, text: "D4 완료했습니다. 시험 12/12 통과." });
  await t.hub.deliverResult({ convId: KDA.convId, chatId: CHAT, text: "릴리즈 준비 완료\n\n1. 지금 태그 push\n2. 내일 push\n\n번호로 알려 주세요." });
  await t.hub.handleUpdate(msgU("/현황"));
  const board = t.texts().at(-1)!;
  assert.match(board, /\[CAE GUI\] ✅ 완료/);
  assert.match(board, /\[KDA 개발\] ❓ 결정 대기/);
  assert.match(board, /결정 대기 1건/);
  assert.equal(t.turns.length, 2, "/현황 은 턴을 만들지 않음");
});

test("장부: 단일 명령은 '→ [방]로 전달 #n', 답장으로 이어 보내면 같은 #n 유지", async () => {
  const t = mk();
  await t.hub.handleUpdate(msgU("UI 가 너무 어둡다"));
  assert.match(t.texts()[0], /→ \[CAE GUI\]로 전달 #1/);
  const mid = await t.hub.sendText(CHAT, "어두운 원인 확인했습니다. 진행할까요?", CAE.convId);
  await t.hub.handleUpdate(msgU("응 진행해", { reply_to_message: { message_id: mid } }));
  const now = (t.hub as any).d.now();
  assert.deepEqual(t.hub.ledger.recent(now).map((e) => e.id), [1], "답장은 새 줄을 만들지 않음");
  assert.equal(t.hub.ledger.recent(now)[0].legs[0].state, "running", "답장으로 다시 시작 → 진행");
});

test("장부: 시작 실패는 오류로 남고, KDA 재시작(새 허브) 뒤에도 /현황 유지", async () => {
  const t = mk({}, { oneshot: async () => '{"pick":2,"confidence":0.9}' });
  (t.hub as any).d.startTurn = async () => { throw new Error("engine down"); };
  await t.hub.handleUpdate(msgU("빌드해"));
  await t.hub.handleUpdate(msgU("/현황"));
  assert.match(t.texts().at(-1)!, /\[KDA 개발\] ⚠ 오류 · 0분 전 — 시작 실패: Error: engine down/);
  const saved = t.store.get("kda_tg_hub_ledger");
  assert.ok(saved && saved.includes("engine down"), "장부가 저장소에 저장됨");
});

// ── v0.7.69 묶음 보고 ─────────────────────────────────────────────
const splitTwo = () => mk({ quiet: { enabled: false, startHour: 23, endHour: 7 } }, { oneshot: async (p: string) => p.includes("You route")
  ? JSON.stringify({ parts: [{ pick: 1, text: "Cae d4진행해", confidence: 0.9 }, { pick: 2, text: "KDA 빌드 확인해", confidence: 0.9 }] })
  : "요약" });

test("묶음: 두 방 결과가 다 오면 한 메시지로 (개별 결과는 따로 안 보냄)", async () => {
  const t = splitTwo();
  await t.hub.handleUpdate(msgU("Cae d4진행해 KDA 빌드 확인해"));
  const before = t.texts().length;
  await t.hub.deliverResult({ convId: CAE.convId, chatId: CHAT, text: "D4 완료했습니다. 시험 12/12 통과." });
  assert.equal(t.texts().length, before, "첫 결과는 모아 둠");
  await t.hub.deliverResult({ convId: KDA.convId, chatId: CHAT, text: "빌드 정상입니다. exit 0." });
  const sentNow = t.texts().slice(before);
  assert.equal(sentNow.length, 1);
  assert.match(sentNow[0], /📦 #1 결과 묶음 \(2개 방\)/);
  assert.match(sentNow[0], /\[CAE GUI\]\nD4 완료했습니다/);
  assert.match(sentNow[0], /\[KDA 개발\]\n빌드 정상입니다/);
  assert.ok(!t.store.get("kda_tg_hub_bundles")!.includes("D4"), "보낸 뒤 묶음 비움");
});

test("묶음: 결정 요청은 즉시 따로, 그 방으로 끝났으면 모아 둔 결과도 바로", async () => {
  const t = splitTwo();
  await t.hub.handleUpdate(msgU("Cae d4진행해 KDA 빌드 확인해"));
  const before = t.texts().length;
  await t.hub.deliverResult({ convId: CAE.convId, chatId: CHAT, text: "D4 완료했습니다." });
  await t.hub.deliverResult({ convId: KDA.convId, chatId: CHAT, text: "릴리즈 준비 완료\n\n1. 지금 태그 push\n2. 내일 push\n\n번호로 알려 주세요." });
  const sentNow = t.texts().slice(before);
  assert.equal(sentNow.length, 2);
  assert.match(sentNow[0], /^❓/, "결정 요청 먼저 즉시");
  assert.match(sentNow[1], /📦 #1 결과 묶음 \(1개 방\)[\s\S]*\[CAE GUI\]/);
});

test("묶음: 20분 지나도 안 끝난 방이 있으면 모인 것만 보내고 남은 방 표시 / 오류는 즉시", async () => {
  const t = splitTwo();
  await t.hub.handleUpdate(msgU("Cae d4진행해 KDA 빌드 확인해"));
  const before = t.texts().length;
  await t.hub.deliverResult({ convId: CAE.convId, chatId: CHAT, text: "D4 완료했습니다." });
  assert.ok(t.store.get("kda_tg_hub_bundles")!.includes("D4"), "모아 둔 결과는 저장(재시작 대비)");
  t.advance(19 * 60 * 1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(t.texts().length, before, "19분엔 아직");
  t.advance(2 * 60 * 1000);
  await new Promise((r) => setImmediate(r));
  const sentNow = t.texts().slice(before);
  assert.equal(sentNow.length, 1);
  assert.match(sentNow[0], /📦 #1 결과 묶음 \(1개 방 · 아직 진행: KDA 개발\)/);
  await t.hub.deliverResult({ convId: KDA.convId, chatId: CHAT, text: "❌ 빌드 실패: exit code 1" });
  assert.match(t.texts().at(-1)!, /^❌/, "오류는 묶지 않고 즉시");
});

test("묶음: 한 방짜리 명령은 예전처럼 즉시 회신", async () => {
  const t = mk({ quiet: { enabled: false, startHour: 23, endHour: 7 } });
  await t.hub.handleUpdate(msgU("UI 가 너무 어둡다"));
  const before = t.texts().length;
  await t.hub.deliverResult({ convId: CAE.convId, chatId: CHAT, text: "밝기 올렸습니다." });
  assert.equal(t.texts().length, before + 1);
  assert.match(t.texts().at(-1)!, /^✅/);
});

// ── v0.7.69 커맨드센터 전달 (텔레그램 방 → 다른 방) ──────────────────────
test("전달: 텔레그램 방이 넘긴 지시 → 결과 회신 등록 + #번호 + 접수 확인, 같은 마커 재시도는 1번만", async () => {
  const t = mk({ quiet: { enabled: false, startHour: 23, endHour: 7 } }, { oneshot: async () => '{"pick":0,"confidence":0.95}' });
  await t.hub.handleUpdate(msgU("5080 상태 알려줘", {}));
  assert.equal(t.turns.at(-1)!.convId, DEF.convId, "전제: 5080 질문은 텔레그램 방으로");            // 텔레그램 방(기본)과 대화한 적이 있어야 채팅을 안다
  assert.equal(t.hub.chatFor(CAE.convId, (t.hub as any).d.now()), undefined, "전달 전엔 CAE 결과가 텔레그램으로 안 감");
  const n1 = await t.hub.noteDispatch(CAE.convId, "D4 진행해", "cc-dispatch-1");
  const n2 = await t.hub.noteDispatch(CAE.convId, "D4 진행해", "cc-dispatch-1");
  assert.equal(n1, n2, "재시도는 같은 #번호");
  assert.equal(t.texts().filter((x) => x.includes("텔레그램 방에서 넘김")).length, 1);
  assert.ok(t.texts().at(-1)!.includes(`→ [CAE GUI]로 전달 #${n1} (텔레그램 방에서 넘김): D4 진행해`), t.texts().at(-1));
  assert.equal(t.hub.chatFor(CAE.convId, (t.hub as any).d.now()), CHAT, "전달 후 CAE 결과가 텔레그램으로 돌아옴");
  await t.hub.deliverResult({ convId: CAE.convId, chatId: CHAT, text: "D4 완료했습니다." });
  await t.hub.handleUpdate(msgU("/현황"));
  { const b = t.texts().at(-1)!; assert.ok(b.includes(`#${n1} `) && b.includes("[CAE GUI] ✅ 완료"), b); }
});

test("전달: 텔레그램을 한 번도 안 쓴 상태면 기록하지 않고 null", async () => {
  const t = mk();
  assert.equal(await t.hub.noteDispatch(CAE.convId, "x", "cc-dispatch-2"), null);
  assert.equal(t.sent.length, 0);
});
