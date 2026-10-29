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
