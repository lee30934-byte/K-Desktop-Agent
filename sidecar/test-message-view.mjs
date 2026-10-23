// v0.7.50 — 대화 전환 성능(화면용 페이지 로딩) 회귀 테스트. DB·네트워크 없이 돈다.
//
// 불변식
//   1. 화면 목록은 최근 페이지만, 도구 원문은 앞부분만 읽는다 (최대 대화 410MB/2.8s → 2.3MB/21ms 실측).
//   2. 잘린 도구 원문은 DB 에 다시 쓰지 않는다 (UPDATE 로 컬럼 보존, 잘린 값 INSERT 금지).
//   3. 앞부분만으로 만든 프롬프트 이력 == 원문으로 만든 이력 (미리보기 길이 > sidecar 절단 길이).
//   4. 내보내기·백업·분기는 전체 원문(getMessages)을 그대로 쓴다.
//   5. 대화 전체를 읽던 전송 경로는 최근 페이지(본문 40개 확보까지)로 바뀐다.
// 실데이터 검증(27개 대화 페이지 완전성, 도구 78,336건 이력 동등성)은 evidence/conv-switch-20261023 에 별도 기록.
// 실행: node test-message-view.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as mv from "../src/messageView.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf-8").replace(/\r\n/g, "\n");

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${e instanceof Error ? e.message : String(e)}`); }
}

// sidecar summarizeToolItem 과 동일 (아래 [3] 에서 소스의 절단 길이와 일치하는지도 검사)
function summarize(toolName, toolInput, toolOutput) {
  const inputStr = (() => {
    if (toolInput == null) return "";
    const s = typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput);
    return s.length > 800 ? s.slice(0, 800) + "…(truncated)" : s;
  })();
  const outputStr = !toolOutput ? "(no output / interrupted)"
    : toolOutput.length > 1500 ? toolOutput.slice(0, 1500) + "…(truncated)" : toolOutput;
  return `[Tool] ${toolName}${inputStr ? `(${inputStr})` : ""}\n→ ${outputStr}`;
}
// SQLite substr(x, 1, n) 흉내 (코드포인트 단위)
const substr = (s, n) => (s == null ? s : Array.from(s).slice(0, n).join(""));

console.log("\n[1] 미리보기 해석");
check("짧은 입력은 JSON 그대로 파싱, 미리보기 표시 없음", () => {
  const r = mv.decodeToolInputPreview('{"a":1}');
  assert.deepEqual(r, { toolInput: { a: 1 } });
});
check("긴 입력은 앞부분 문자열 + inputPreview (잘린 JSON 은 파싱하지 않음)", () => {
  const raw = JSON.stringify({ text: "x".repeat(5000) });
  const r = mv.decodeToolInputPreview(substr(raw, mv.TOOL_INPUT_PREVIEW_CHARS + 1));
  assert.equal(typeof r.toolInput, "string");
  assert.equal(r.inputPreview, r.toolInput);
  assert.equal(r.toolInput.length, mv.TOOL_INPUT_PREVIEW_CHARS);
});
check("깨진 짧은 JSON 은 문자열 그대로 (예외 없음)", () => {
  assert.deepEqual(mv.decodeToolInputPreview("{bad"), { toolInput: "{bad" });
  assert.deepEqual(mv.decodeToolInputPreview(null), { toolInput: undefined });
});
check("출력: 짧으면 그대로, 길면 앞부분 + outputPreview", () => {
  assert.deepEqual(mv.decodeToolOutputPreview("ok"), { toolOutput: "ok" });
  const r = mv.decodeToolOutputPreview("y".repeat(mv.TOOL_OUTPUT_PREVIEW_CHARS + 1));
  assert.equal(r.toolOutput.length, mv.TOOL_OUTPUT_PREVIEW_CHARS);
  assert.equal(r.outputPreview, r.toolOutput);
});

console.log("\n[2] 저장 보호 (잘린 원문을 DB 에 쓰지 않음)");
const truncated = (() => {
  const i = mv.decodeToolInputPreview(substr(JSON.stringify({ q: "z".repeat(3000) }), mv.TOOL_INPUT_PREVIEW_CHARS + 1));
  const o = mv.decodeToolOutputPreview("w".repeat(mv.TOOL_OUTPUT_PREVIEW_CHARS + 1));
  return { role: "tool", id: "t1", toolInput: i.toolInput, inputPreview: i.inputPreview, toolOutput: o.toolOutput, outputPreview: o.outputPreview };
})();
check("미리보기 그대로면 두 컬럼 모두 보존", () => {
  assert.deepEqual(mv.toolPayloadPreservation(truncated), { keepInput: true, keepOutput: true });
});
check("코드가 toolOutput 을 새 값으로 채우면(예: AskUserQuestion 답) 출력은 정상 저장", () => {
  assert.deepEqual(mv.toolPayloadPreservation({ ...truncated, toolOutput: "K 의 답" }), { keepInput: true, keepOutput: false });
});
check("잘리지 않은 메시지/비도구 메시지는 보존 대상 아님 (기존 upsert)", () => {
  assert.deepEqual(mv.toolPayloadPreservation({ role: "tool", toolInput: { a: 1 }, toolOutput: "x" }), { keepInput: false, keepOutput: false });
  assert.deepEqual(mv.toolPayloadPreservation({ role: "assistant", content: "x" }), { keepInput: false, keepOutput: false });
  assert.deepEqual(mv.toolPayloadPreservation(null), { keepInput: false, keepOutput: false });
});
check("보존 UPDATE: 자리표시자 수 == 파라미터 수, 보존 컬럼은 SET 에 없음, INSERT 없음 (4가지 조합)", () => {
  const upsert = ["id1", "conv1", "tool", "", 1, 0, null, "tid", "tname", "IN", "OUT", "success", null];
  for (const keepInput of [true, false]) for (const keepOutput of [true, false]) {
    const keep = { keepInput, keepOutput };
    const sql = mv.buildPreservingUpdateSql(keep);
    const params = mv.preservingUpdateParams(upsert, keep);
    assert.equal((sql.match(/\?/g) ?? []).length, params.length, JSON.stringify(keep));
    assert.ok(!/INSERT/i.test(sql));
    assert.equal(/tool_input=\?/.test(sql), !keepInput);
    assert.equal(/tool_output=\?/.test(sql), !keepOutput);
    assert.equal(params.includes("IN"), !keepInput);
    assert.equal(params.includes("OUT"), !keepOutput);
    assert.deepEqual(params.slice(-2), ["id1", "conv1"]);
    assert.match(sql, /WHERE id=\? AND conversation_id=\?$/);
  }
});

console.log("\n[3] 이력 동등성 (미리보기 길이 > sidecar 절단 길이)");
check("sidecar 절단 길이(800/1500)보다 미리보기가 길다 — 소스에서 직접 확인", () => {
  const side = read("sidecar/src/index.ts");
  const m = /function summarizeToolItem[\s\S]*?s\.length > (\d+)[\s\S]*?toolOutput\.length > (\d+)/.exec(side);
  assert.ok(m, "summarizeToolItem 절단 길이를 찾지 못함");
  assert.ok(mv.TOOL_INPUT_PREVIEW_CHARS > Number(m[1]), `입력 ${mv.TOOL_INPUT_PREVIEW_CHARS} <= ${m[1]}`);
  assert.ok(mv.TOOL_OUTPUT_PREVIEW_CHARS > Number(m[2]), `출력 ${mv.TOOL_OUTPUT_PREVIEW_CHARS} <= ${m[2]}`);
});
check("합성 데이터: 원문 vs 미리보기 이력 문자열 동일 (경계·이모지 포함)", () => {
  const cases = [
    [{ a: "x".repeat(10) }, "short"],
    [{ a: "x".repeat(799) }, "o".repeat(1500)],
    [{ a: "x".repeat(800) }, "o".repeat(1501)],
    [{ a: "가".repeat(5000) }, "출".repeat(9000)],
    [{ a: "😀".repeat(2000) }, "🎵".repeat(2000)],
    [undefined, undefined],
  ];
  for (const [input, output] of cases) {
    const rawIn = input === undefined ? null : JSON.stringify(input);
    const pi = mv.decodeToolInputPreview(substr(rawIn, mv.TOOL_INPUT_PREVIEW_CHARS + 1));
    const po = mv.decodeToolOutputPreview(substr(output ?? null, mv.TOOL_OUTPUT_PREVIEW_CHARS + 1));
    assert.equal(summarize("T", pi.toolInput, po.toolOutput), summarize("T", input, output));
  }
});

console.log("\n[4] 페이지 조회/병합");
check("최근 페이지 SQL: rowid 하위질의 + (timestamp,id) 정렬, 파라미터 수", () => {
  const a = mv.buildViewPageQuery(null);
  assert.match(a.sql, /rowid IN \(\s*SELECT rowid FROM messages WHERE conversation_id = \?/);
  assert.match(a.sql, /ORDER BY timestamp DESC, id DESC LIMIT \?/);
  assert.match(a.sql, /ORDER BY timestamp ASC, id ASC\s*$/);
  assert.equal((a.sql.match(/\?/g) ?? []).length, 2);
  const b = mv.buildViewPageQuery({ timestamp: 5, id: "m5" });
  assert.equal((b.sql.match(/\?/g) ?? []).length, 2 + b.cursorParams.length);
  assert.deepEqual(b.cursorParams, [5, 5, "m5"]);
  assert.ok(!/SELECT \*/.test(a.sql));
  assert.match(mv.VIEW_SELECT_COLUMNS, /substr\(tool_output, 1, \d+\)/);
});
check("pageCursor: limit 꽉 차면 hasOlder, 커서는 가장 오래된 행", () => {
  const rows = [{ id: "a", timestamp: 1 }, { id: "b", timestamp: 2 }];
  assert.deepEqual(mv.pageCursor(rows, 2), { hasOlder: true, before: { timestamp: 1, id: "a" } });
  assert.equal(mv.pageCursor(rows, 3).hasOlder, false);
  assert.deepEqual(mv.pageCursor([], 3), { hasOlder: false, before: null });
});
check("prependOlder: 앞에 붙이고 id 중복은 기존 쪽 유지", () => {
  const cur = [{ id: "c", v: "new" }, { id: "d" }];
  assert.deepEqual(mv.prependOlder(cur, [{ id: "a" }, { id: "c", v: "old" }]).map((m) => m.id + (m.v ?? "")), ["a", "cnew", "d"]);
  assert.equal(mv.prependOlder(cur, []), cur);
});
check("prependedCount: 앞에 붙은 수 / 끝 추가는 0 / 사라지면 null", () => {
  assert.equal(mv.prependedCount("c", ["a", "b", "c", "d"]), 2);
  assert.equal(mv.prependedCount("a", ["a", "b", "z"]), 0);
  assert.equal(mv.prependedCount("q", ["a"]), null);
  assert.equal(mv.prependedCount(null, ["a"]), 0);
});
check("이력용 목록 충분성: 이전 페이지가 남았고 본문이 모자라면 DB 보충", () => {
  const few = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "user" : "tool" }));
  assert.equal(mv.loadedMessagesSufficeForHistory(few, false), true);
  assert.equal(mv.loadedMessagesSufficeForHistory(few, true), false);
  const many = Array.from({ length: 50 }, () => ({ role: "assistant" }));
  assert.equal(mv.loadedMessagesSufficeForHistory(many, true), true);
  assert.ok(mv.HISTORY_MIN_TEXT_MESSAGES >= 30, "steer 30 / 텔레그램 20 / HISTORY_SLICE 16 을 덮어야 함");
});

console.log("\n[5] 배선");
const db = read("src/db.ts");
const app = read("src/App.tsx");
const chat = read("src/components/MainChat.tsx");
const msgView = read("src/components/Message.tsx");
const types = read("src/types.ts");
check("인덱스 (conversation_id, timestamp)", () => {
  assert.match(db, /CREATE INDEX IF NOT EXISTS idx_messages_conv_ts\s*\n\s*ON messages\(conversation_id, timestamp\)/);
});
check("getMessages 는 여전히 전체 원문 (내보내기·백업·분기용)", () => {
  assert.match(db, /export async function getMessages\(conversationId: string\)[\s\S]{0,200}SELECT \* FROM messages WHERE conversation_id = \? ORDER BY timestamp ASC/);
  const exp = /export async function exportConversation[\s\S]*?\n\}/.exec(db)?.[0] ?? "";
  assert.match(exp, /await getMessages\(conversationId\)/);
  assert.match(db, /const originalMessages = await getMessages\(originalConvId\)/);
});
check("saveMessage: 보존 판정이 upsert 보다 먼저, 행 없으면 저장 안 함", () => {
  const save = /export async function saveMessage\([\s\S]*?\n\}/.exec(db)?.[0] ?? "";
  const iKeep = save.indexOf("toolPayloadPreservation(message)");
  const iUpsert = save.indexOf("MESSAGE_UPSERT_SQL");
  assert.ok(iKeep > 0 && iUpsert > iKeep, "보존 판정이 upsert 앞에 없음");
  assert.match(save, /if \(updated\.rowsAffected !== 1\) \{[\s\S]*?return;/);
});
check("화면용 행 변환은 미리보기 해석 사용, ToolMessage 에 preview 필드", () => {
  assert.match(db, /function dbViewRowToMessage[\s\S]*?decodeToolInputPreview\(row\.tool_input\)[\s\S]*?decodeToolOutputPreview\(row\.tool_output\)/);
  assert.match(types, /inputPreview\?: string;\n\s*outputPreview\?: string;/);
});
check("대화 전환: 전체 조회 대신 최근 페이지 + 즉시 비우기 + 로딩 해제", () => {
  const sel = /const handleSelectConversation = useStableCallback\([\s\S]*?\n {2}\}\);/.exec(app)?.[0] ?? "";
  assert.ok(sel, "handleSelectConversation 블록 탐지 실패");
  assert.match(sel, /getMessagesForView\(id\)/);
  assert.doesNotMatch(sel, /getMessages\(id\)/);
  assert.match(sel, /setMessages\(\[\]\);\n\s*setOlderPaging\(null\);\n\s*setLoadingConversationId\(id\);/);
  assert.match(sel, /finally \{\n\s*setLoadingConversationId\(\(cur\) => \(cur === id \? null : cur\)\);/);
});
check("전송/텔레그램/예약/작업감시 경로에 대화 전체 조회 없음", () => {
  const fullReads = (app.match(/await getMessages\(/g) ?? []).length;
  assert.equal(fullReads, 1, `App.tsx 의 getMessages 전체 조회 ${fullReads}건 (압축 새 대화 1건만 허용)`);
  assert.match(app, /const newMessages = await getMessages\(newConvId\)/);
  assert.equal((app.match(/getRecentMessagesForHistory\(convId\)/g) ?? []).length, 4);
  assert.match(app, /loadedMessagesSufficeForHistory\(sourceMessages, loadedHasOlder\)/);
  assert.equal((app.match(/inDb = \(await getConversationMetrics\(convId\)\) !== null/g) ?? []).length, 3);
});
check("이전 페이지 로딩: 활성 대화 확인 + prependOlder", () => {
  const h = /const handleLoadOlderMessages = useStableCallback\([\s\S]*?\n {2}\}\);/.exec(app)?.[0] ?? "";
  assert.match(h, /paging\.convId !== convId/);
  assert.match(h, /if \(activeConversationIdRef\.current !== convId\) return;/);
  assert.match(h, /setMessages\(\(prev\) => prependOlder\(prev, page\.messages\)\)/);
});
check("MainChat: firstItemIndex·startReached·context, 대화별 key, 로딩 표시, 전체 복사", () => {
  assert.match(chat, /firstItemIndex=\{firstItemIndex\}/);
  assert.match(chat, /startReached=\{startReached\}/);
  assert.match(chat, /context=\{listContext\}/);
  assert.match(chat, /<MessageList\n\s*key=\{conversationId\}/);
  assert.match(chat, /대화를 불러오는 중…/);
  assert.match(chat, /source = await onLoadAllForCopy\(\)/);
  assert.match(chat, /components=\{VIRTUOSO_COMPONENTS\}/);
});
check("도구 카드: 잘린 원문 '전체 불러오기' (메시지 객체는 그대로)", () => {
  assert.match(msgView, /import \{ getToolMessagePayload \} from "\.\.\/db";/);
  assert.match(msgView, /setFullPayload\(payload\)/);
  assert.match(msgView, /전체 불러오기/);
  assert.doesNotMatch(msgView, /message\.toolOutput\s*=/);
});

console.log(`\n결과: ${pass}/${pass + fail} 통과`);
process.exit(fail === 0 ? 0 : 1);
