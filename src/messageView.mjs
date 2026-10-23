// v0.7.50 — 대화 화면용 메시지 로딩 정책 (순수 모듈: DB/React 의존 없음, sidecar/test-message-view.mjs 가 검증).
//
// 실측(2026-10-23, conversations.db 읽기 전용):
//   최대 대화 41,052행 — SELECT * 410 MB / 2.8초. 대부분 tool_output(373 MB).
//   (conversation_id, timestamp) 인덱스 + 최근 1,500행 + 도구 원문 앞부분만 → 2.2 MB / 17~20 ms.
//
// 규칙
//   1. 화면 목록은 최근 VIEW_PAGE_ROWS 행만 먼저, 이전 행은 위로 스크롤할 때 같은 크기로 추가.
//   2. 도구 입력/출력은 앞부분만 읽는다. 길이는 sidecar summarizeToolItem 이 쓰는 양(입력 800·출력 1500자)보다
//      크게 잡아, 잘린 값으로도 프롬프트 이력이 원문과 똑같이 만들어지게 한다.
//   3. 잘린 값은 절대 DB 에 다시 쓰지 않는다. 잘린 채 그대로인 필드는 저장 시 기존 값을 유지한다.
//   4. 내보내기/백업/분기 등은 기존 getMessages(전체 원문)를 그대로 쓴다 — 이 모듈은 화면 전용.

export const VIEW_PAGE_ROWS = 1500;
export const TOOL_INPUT_PREVIEW_CHARS = 900; // sidecar 입력 절단 800 + 여유
export const TOOL_OUTPUT_PREVIEW_CHARS = 1600; // sidecar 출력 절단 1500 + 여유

/** SELECT 컬럼: 잘렸는지 판정하려고 한계+1 글자까지 읽는다 (length() 는 큰 값을 통째로 읽어 쓰지 않음). */
export const VIEW_SELECT_COLUMNS = `id, conversation_id, role, content, timestamp, streaming, level,
  tool_id, tool_name,
  substr(tool_input, 1, ${TOOL_INPUT_PREVIEW_CHARS + 1}) AS tool_input,
  substr(tool_output, 1, ${TOOL_OUTPUT_PREVIEW_CHARS + 1}) AS tool_output,
  tool_status, tool_risk`;

/**
 * 최근 페이지 / 이전 페이지 SQL. rowid 하위 질의로 정렬 대상을 (timestamp,id) 만으로 좁혀,
 * 정렬 단계에서 큰 도구 원문 컬럼을 읽지 않게 한다 (인덱스가 없을 때도 130ms 대 vs 827ms 실측).
 */
export function buildViewPageQuery(before) {
  const cursor = before
    ? " AND (timestamp < ? OR (timestamp = ? AND id < ?))"
    : "";
  const sql = `SELECT ${VIEW_SELECT_COLUMNS} FROM messages
  WHERE rowid IN (
    SELECT rowid FROM messages WHERE conversation_id = ?${cursor}
    ORDER BY timestamp DESC, id DESC LIMIT ?
  )
  ORDER BY timestamp ASC, id ASC`;
  return { sql, cursorParams: before ? [before.timestamp, before.timestamp, before.id] : [] };
}

/**
 * 도구 입력 미리보기 해석. 잘리지 않았으면 원래처럼 JSON 파싱, 잘렸으면 앞부분 문자열을 그대로 쓴다
 * (잘린 JSON 은 파싱 불가). 잘렸을 때 inputPreview 에 같은 문자열을 남겨 저장 보호의 기준으로 쓴다.
 */
export function decodeToolInputPreview(raw) {
  if (raw == null || raw === "") return { toolInput: undefined };
  if (raw.length > TOOL_INPUT_PREVIEW_CHARS) {
    const preview = raw.slice(0, TOOL_INPUT_PREVIEW_CHARS);
    return { toolInput: preview, inputPreview: preview };
  }
  try {
    return { toolInput: JSON.parse(raw) };
  } catch {
    return { toolInput: raw };
  }
}

export function decodeToolOutputPreview(raw) {
  if (raw == null) return { toolOutput: undefined };
  if (raw.length > TOOL_OUTPUT_PREVIEW_CHARS) {
    const preview = raw.slice(0, TOOL_OUTPUT_PREVIEW_CHARS);
    return { toolOutput: preview, outputPreview: preview };
  }
  return { toolOutput: raw };
}

/**
 * 저장 보호 판정. 미리보기로 읽은 값이 그대로 남아 있으면(=코드가 새 값을 넣지 않았으면) 그 컬럼은 보존.
 * 다른 코드가 toolOutput 을 새로 채웠다면(예: AskUserQuestion 답) 미리보기와 달라지므로 정상 저장된다.
 */
export function toolPayloadPreservation(message) {
  if (!message || message.role !== "tool") return { keepInput: false, keepOutput: false };
  const keepInput = typeof message.inputPreview === "string" && message.toolInput === message.inputPreview;
  const keepOutput = typeof message.outputPreview === "string" && message.toolOutput === message.outputPreview;
  return { keepInput, keepOutput };
}

/**
 * 미리보기 컬럼을 보존하는 UPDATE. 행이 없으면 아무것도 쓰지 않는다(잘린 값으로 INSERT 금지).
 * 파라미터 순서: role, content, timestamp, streaming, level, tool_id, tool_name,
 *   [tool_input], [tool_output], tool_status, tool_risk, id, conversation_id
 */
export function buildPreservingUpdateSql({ keepInput, keepOutput }) {
  const sets = [
    "role=?", "content=?", "timestamp=?", "streaming=?", "level=?", "tool_id=?", "tool_name=?",
    ...(keepInput ? [] : ["tool_input=?"]),
    ...(keepOutput ? [] : ["tool_output=?"]),
    "tool_status=?", "tool_risk=?",
  ];
  return `UPDATE messages SET ${sets.join(", ")} WHERE id=? AND conversation_id=?`;
}

/** messageToDbParams 결과(13개)를 preserving UPDATE 파라미터로 재배열. */
export function preservingUpdateParams(upsertParams, keep) {
  const [id, conversationId, role, content, timestamp, streaming, level, toolId, toolName, toolInput, toolOutput, status, risk] = upsertParams;
  return [
    role, content, timestamp, streaming, level, toolId, toolName,
    ...(keep.keepInput ? [] : [toolInput]),
    ...(keep.keepOutput ? [] : [toolOutput]),
    status, risk, id, conversationId,
  ];
}

/** 이전 페이지를 앞에 붙인다. id 중복은 기존(최신 상태) 쪽을 유지. */
export function prependOlder(current, older) {
  if (!older.length) return current;
  const seen = new Set(current.map((m) => m.id));
  const fresh = older.filter((m) => !seen.has(m.id));
  return fresh.length ? [...fresh, ...current] : current;
}

/** 페이지 결과로 "더 이전 메시지가 있는가"와 다음 커서를 만든다. rows 는 오름차순. */
export function pageCursor(rows, limit) {
  if (!rows.length) return { hasOlder: false, before: null };
  const first = rows[0];
  return { hasOlder: rows.length >= limit, before: { timestamp: first.timestamp, id: first.id } };
}

/**
 * Virtuoso firstItemIndex 계산용: 이전 목록의 첫 항목이 새 목록에서 몇 번째로 밀렸는지.
 * 0 이면 앞에 붙은 게 없음(끝에 추가되거나 동일). 이전 첫 항목이 사라졌으면(대화 전환 등) null.
 */
export function prependedCount(prevFirstId, nextIds) {
  if (prevFirstId == null) return 0;
  const idx = nextIds.indexOf(prevFirstId);
  return idx < 0 ? null : idx;
}

/** 프롬프트 이력에 필요한 최소 본문(user/assistant) 메시지 수. HISTORY_SLICE(12~16)·텔레그램/예약(20)·steer(30) 여유. */
export const HISTORY_MIN_TEXT_MESSAGES = 40;

export function countTextMessages(messages) {
  let n = 0;
  for (const m of messages) if (m && (m.role === "user" || m.role === "assistant")) n++;
  return n;
}

/**
 * 화면에 불러온 목록만으로 이력을 만들어도 되는가.
 * 이전 페이지가 남아 있고 본문이 최소 개수보다 적으면 DB 에서 더 읽어야 한다(이력이 짧아지는 회귀 방지).
 */
export function loadedMessagesSufficeForHistory(messages, hasOlder, minText = HISTORY_MIN_TEXT_MESSAGES) {
  if (!hasOlder) return true;
  return countTextMessages(messages) >= minText;
}
