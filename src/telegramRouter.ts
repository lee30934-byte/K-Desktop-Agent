/**
 * v0.7.54 — 텔레그램 자동 분배(라우터) 순수 로직.
 *
 * React/Tauri 에 의존하지 않는다(scripts/telegram-router.test.ts 로 검증).
 * 분배 순서: 답장(reply-to) → @별칭 → 짧은 후속답 고정 → AI 분류(확신도 임계) → 기본 대화.
 * AI 분류가 실패/시간초과/형식오류여도 메시지는 기본 대화로 처리된다(유실 없음).
 */

export interface RouteTarget {
  convId: string;
  /** 회신 머리표·안내에 쓰는 짧은 이름 (예: "CAE GUI"). */
  label: string;
  /** "@CAE" 처럼 머리말로 지정할 별칭들 (대소문자 무시, @ 제외). */
  aliases: string[];
  /** 분류기에 줄 한두 줄 설명 (폴더 지침 요약). */
  description: string;
}

export type RouteSource = "reply" | "alias" | "sticky" | "ai" | "default" | "pinned";

export interface RouteDecision {
  convId: string;
  label: string;
  source: RouteSource;
  /** 실제로 대상 대화에 보낼 본문 (별칭 머리말 제거됨). */
  text: string;
  confidence?: number;
  /** 기본 대화로 떨어진 이유 (ai 실패 등) — 로그/안내용. */
  note?: string;
}

/** AI 분류 결과 확신도 임계값. 미만이면 기본 대화. */
export const ROUTER_MIN_CONFIDENCE = 0.6;
/** 짧은 후속답을 직전 대화로 고정하는 시간. */
export const ROUTER_STICKY_MS = 10 * 60 * 1000;
/** 텔레그램발 대화의 후속 결과(task-watch 등)를 텔레그램으로 회신하는 기간. */
export const ROUTER_FOLLOWUP_MS = 48 * 60 * 60 * 1000;
/** 답장 매핑 보관 개수 상한 (메모리 무한 증가 방지). */
export const ROUTER_REPLY_MAP_MAX = 500;

/** "@CAE 화면 밝게 해줘" → { alias: "cae", rest: "화면 밝게 해줘" }. 머리말이 없으면 null. */
export function parseAliasPrefix(text: string): { alias: string; rest: string } | null {
  const m = /^\s*@([^\s:：,]+)[\s:：,]*([\s\S]*)$/.exec(text);
  if (!m) return null;
  return { alias: m[1].toLowerCase(), rest: m[2].trim() };
}

export function findTargetByAlias(alias: string, targets: RouteTarget[]): RouteTarget | undefined {
  const a = alias.toLowerCase();
  return targets.find((t) => t.aliases.some((x) => x.toLowerCase() === a));
}

/**
 * 직전 질문에 대한 짧은 답인지: "1", "2번", "①", "예", "네", "아니", "ok", "ㅇㅇ", "취소" 등.
 * 새 주제 문장은 false (길이·내용으로 판정).
 */
export function isShortFollowUp(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length === 0 || t.length > 12) return false;
  if (/^[0-9]{1,2}\s*(번)?\s*[.)]?$/.test(t)) return true;
  if (/^[①-⑩]$/.test(t)) return true;
  return /^(예|네|넵|응|ㅇㅇ|ㅇㅋ|좋아|좋아요|아니|아니요|아뇨|ok|okay|yes|no|y|n|진행|진행해|취소|중지|보류)[.!]?$/.test(t);
}

/** 분류기 프롬프트. 후보 id 는 짧은 번호 키로 바꿔 모델이 긴 uuid 를 틀리게 쓰지 않게 한다. */
export interface RouteExample {
  text: string;
  convId: string;
}

export function buildClassifierPrompt(message: string, targets: RouteTarget[], examples: RouteExample[] = []): string {
  const lines = targets.map((t, i) => `${i + 1}. ${t.label} — ${t.description.replace(/\s+/g, " ").slice(0, 200)}`);
  // ③ K 가 /이동 으로 바로잡은 기록 — 최근 것 위주로 최대 8개만 (프롬프트 비대 방지)
  const ex = examples
    .map((e) => ({ e, idx: targets.findIndex((t) => t.convId === e.convId) }))
    .filter((x) => x.idx >= 0)
    .slice(-8)
    .map((x) => `- "${x.e.text.replace(/\s+/g, " ").slice(0, 80)}" -> ${x.idx + 1}`);
  return [
    "You route a user's Telegram message to the best matching work session.",
    "Sessions:",
    "0. General — anything that fits none of the others, remote PC power/status, small talk",
    ...lines,
    ...(ex.length > 0 ? ["", "Past corrections by the user (follow these):", ...ex] : []),
    "",
    "Message:",
    message.slice(0, 1500),
    "",
    'Answer with ONLY one JSON object, no prose: {"pick": <session number>, "confidence": <0..1>}',
    // v0.7.68 — 한 메시지에 여러 작업 지시가 섞인 경우 (2026-10-31 실측: "Cae는 … 음악공유방은 … Treblo는 …" 가
    // 한 곳만 고르는 형식 때문에 General 로 떨어졌다).
    "If the message gives separate instructions for two or more different sessions, split it instead:",
    '{"parts": [{"pick": <session number>, "text": "<that instruction, copied in the original language>", "confidence": <0..1>}, ...]}',
  ].join("\n");
}

export interface ClassifiedPart {
  target: RouteTarget | null;
  text: string;
  confidence: number;
}

/**
 * v0.7.68 — 분할 응답 파싱. {"parts":[...]} 형식만 처리한다(단일 형식은 parseClassifierReply).
 * 항목 하나라도 형식이 틀리면 null → 호출측이 단일 형식으로 재해석/기본 대화로 강등.
 */
export function parseClassifierParts(raw: string, targets: RouteTarget[]): ClassifiedPart[] | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start || !/"parts"\s*:/.test(raw)) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const parts = (obj as { parts?: unknown }).parts;
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const out: ClassifiedPart[] = [];
  for (const p of parts) {
    const o = p as { pick?: unknown; text?: unknown; confidence?: unknown };
    const pick = typeof o.pick === "number" ? o.pick : Number(o.pick);
    const conf = typeof o.confidence === "number" ? o.confidence : Number(o.confidence);
    const text = typeof o.text === "string" ? o.text.trim() : "";
    if (!Number.isInteger(pick) || pick < 0 || pick > targets.length) return null;
    if (!Number.isFinite(conf) || conf < 0 || conf > 1) return null;
    if (!text) return null;
    out.push({ target: pick === 0 ? null : targets[pick - 1], text, confidence: conf });
  }
  return out;
}

/** 나눠 보낸 몫에 붙이는 원문 참고 (대상 대화가 전체 맥락을 잃지 않게). */
export function splitPartText(part: string, original: string): string {
  const o = original.replace(/\s+/g, " ").trim();
  return `${part}\n\n[텔레그램 복합 명령에서 이 대화 몫만 나눠 보냈습니다. 원문: "${o.length > 300 ? o.slice(0, 300) + "…" : o}"]`;
}

/** 분류기 응답 파싱. 형식이 틀리거나 범위 밖이면 null (→ 기본 대화). pick 0 은 기본 대화. */
export function parseClassifierReply(
  raw: string,
  targets: RouteTarget[],
): { target: RouteTarget | null; confidence: number } | null {
  const m = /\{[^{}]*"pick"[^{}]*\}/.exec(raw);
  if (!m) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const o = obj as { pick?: unknown; confidence?: unknown };
  const pick = typeof o.pick === "number" ? o.pick : Number(o.pick);
  const conf = typeof o.confidence === "number" ? o.confidence : Number(o.confidence);
  if (!Number.isInteger(pick) || pick < 0 || pick > targets.length) return null;
  if (!Number.isFinite(conf) || conf < 0 || conf > 1) return null;
  return { target: pick === 0 ? null : targets[pick - 1], confidence: conf };
}

export interface RouteInput {
  text: string;
  /** 텔레그램 답장 대상 메시지가 어느 대화의 회신이었는지 (ReplyMap 조회 결과). */
  replyToConvId?: string;
  /** 마지막으로 회신을 보낸 대화와 시각 (sticky 판정용). */
  lastReply?: { convId: string; at: number };
  now: number;
  targets: RouteTarget[];
  defaultTarget: { convId: string; label: string };
  /** AI 분류기. 실패 시 throw 해도 된다(기본 대화로 강등). 없으면 AI 단계 생략. */
  classify?: (prompt: string) => Promise<string>;
  /** /이동 으로 바로잡은 예시 (분류 프롬프트에 포함). */
  examples?: RouteExample[];
}

function asDecision(t: { convId: string; label: string }, source: RouteSource, text: string, extra: Partial<RouteDecision> = {}): RouteDecision {
  return { convId: t.convId, label: t.label, source, text, ...extra };
}

/**
 * v0.7.68 — 여러 대상 분배. 답장·@별칭·짧은 후속답은 decideRoute 와 똑같이 1개.
 * AI 분류가 {"parts":[...]} 로 2개 이상의 서로 다른 대상을 확신도 이상으로 고른 경우에만 여러 개를 돌려준다.
 * 확신도 미달·General 몫은 기본 대화 한 건으로 모은다. 결과가 대상 1개로 줄면 원문 전체를 그 대상에 보낸다.
 */
export async function decideRoutes(input: RouteInput): Promise<RouteDecision[]> {
  const { text, targets, defaultTarget } = input;
  // AI 단계 전의 결정(답장·별칭·후속답)이나 분류기 없음 → 기존 단일 결정
  const pre = await decideRoute({ ...input, classify: undefined });
  if (pre.source !== "default" || !input.classify || targets.length === 0) {
    return [input.classify && pre.source === "default" ? await decideRoute(input) : pre];
  }
  let raw: string;
  try {
    raw = await input.classify(buildClassifierPrompt(text, targets, input.examples ?? []));
  } catch (e) {
    return [asDecision(defaultTarget, "default", text, { note: `classify-failed: ${String(e).slice(0, 120)}` })];
  }
  const parts = parseClassifierParts(raw, targets);
  if (!parts) return [await decideRoute({ ...input, classify: async () => raw })];

  const groups = new Map<string, { t: { convId: string; label: string }; texts: string[]; conf: number }>();
  const add = (t: { convId: string; label: string }, part: string, conf: number) => {
    const g = groups.get(t.convId) ?? { t, texts: [], conf: 1 };
    g.texts.push(part);
    g.conf = Math.min(g.conf, conf);
    groups.set(t.convId, g);
  };
  for (const p of parts) {
    if (p.target && p.confidence >= ROUTER_MIN_CONFIDENCE) add(p.target, p.text, p.confidence);
    else add(defaultTarget, p.text, p.confidence);
  }
  const list = [...groups.values()];
  const routed = list.filter((g) => g.t.convId !== defaultTarget.convId);
  if (routed.length === 0) {
    return [asDecision(defaultTarget, "default", text, { note: "ai-picked-general" })];
  }
  if (list.length === 1) {
    // 한 대상뿐 — 나눌 필요 없이 원문 전체를 보낸다.
    return [asDecision(list[0].t, "ai", text, { confidence: list[0].conf })];
  }
  return list.map((g, i) => {
    const isDef = g.t.convId === defaultTarget.convId;
    return asDecision(g.t, isDef ? "default" : "ai", splitPartText(g.texts.join("\n"), text), {
      confidence: g.conf,
      note: `split ${i + 1}/${list.length}${isDef ? " general-part" : ""}`,
    });
  });
}

export async function decideRoute(input: RouteInput): Promise<RouteDecision> {
  const { text, targets, defaultTarget, now } = input;
  const all = [...targets, { ...defaultTarget, aliases: [], description: "" }];
  const byId = (id?: string) => (id ? all.find((t) => t.convId === id) : undefined);

  // 1) 답장 — 허용 목록(또는 기본 대화)에 있는 대화로만.
  const replied = byId(input.replyToConvId);
  if (replied) return asDecision(replied, "reply", text);

  // 2) @별칭
  const ap = parseAliasPrefix(text);
  if (ap) {
    const t = findTargetByAlias(ap.alias, targets);
    if (t) return asDecision(t, "alias", ap.rest.length > 0 ? ap.rest : text);
  }

  // 3) 짧은 후속답 → 직전 회신 대화
  if (input.lastReply && now - input.lastReply.at <= ROUTER_STICKY_MS && isShortFollowUp(text)) {
    const t = byId(input.lastReply.convId);
    if (t) return asDecision(t, "sticky", text);
  }

  // 4) AI 분류
  if (input.classify && targets.length > 0) {
    let raw: string;
    try {
      raw = await input.classify(buildClassifierPrompt(text, targets, input.examples ?? []));
    } catch (e) {
      return asDecision(defaultTarget, "default", text, { note: `classify-failed: ${String(e).slice(0, 120)}` });
    }
    const parsed = parseClassifierReply(raw, targets);
    if (!parsed) return asDecision(defaultTarget, "default", text, { note: "classify-unparsable" });
    if (parsed.target && parsed.confidence >= ROUTER_MIN_CONFIDENCE) {
      return asDecision(parsed.target, "ai", text, { confidence: parsed.confidence });
    }
    return asDecision(defaultTarget, "default", text, {
      confidence: parsed.confidence,
      note: parsed.target ? "low-confidence" : "ai-picked-general",
    });
  }

  return asDecision(defaultTarget, "default", text);
}

/** 봇이 보낸 텔레그램 message_id → 그 회신을 만든 대화. 답장 라우팅용 (상한 있는 FIFO). */
export class ReplyMap {
  private readonly map = new Map<number, string>();
  constructor(private readonly max: number = ROUTER_REPLY_MAP_MAX) {}
  remember(messageId: number, convId: string): void {
    this.map.delete(messageId);
    this.map.set(messageId, convId);
    while (this.map.size > this.max) {
      const first = this.map.keys().next().value as number;
      this.map.delete(first);
    }
  }
  lookup(messageId: number | undefined): string | undefined {
    return messageId === undefined ? undefined : this.map.get(messageId);
  }
  get size(): number {
    return this.map.size;
  }
  toJSON(): Array<[number, string]> {
    return [...this.map.entries()];
  }
  static fromJSON(rows: unknown, max?: number): ReplyMap {
    const m = new ReplyMap(max);
    if (Array.isArray(rows)) {
      for (const r of rows) {
        if (Array.isArray(r) && typeof r[0] === "number" && typeof r[1] === "string") m.remember(r[0], r[1]);
      }
    }
    return m;
  }
}

/** 텔레그램발 대화 등록부 — 이 기간 안에 그 대화에서 끝난 비텔레그램 턴(task-watch 등)도 회신한다. */
export class FollowUpRegistry {
  private readonly map = new Map<string, { chatId: string; until: number }>();
  constructor(private readonly ttlMs: number = ROUTER_FOLLOWUP_MS) {}
  mark(convId: string, chatId: string, now: number): void {
    this.map.set(convId, { chatId, until: now + this.ttlMs });
  }
  /** 회신할 chatId, 기간이 지났으면 지우고 undefined. */
  chatFor(convId: string | undefined, now: number): string | undefined {
    if (!convId) return undefined;
    const e = this.map.get(convId);
    if (!e) return undefined;
    if (now > e.until) {
      this.map.delete(convId);
      return undefined;
    }
    return e.chatId;
  }
  forget(convId: string): void {
    this.map.delete(convId);
  }
  toJSON(): Array<[string, { chatId: string; until: number }]> {
    return [...this.map.entries()];
  }
  static fromJSON(rows: unknown, now: number): FollowUpRegistry {
    const registry = new FollowUpRegistry();
    if (Array.isArray(rows)) for (const row of rows.slice(-500)) {
      if (!Array.isArray(row) || typeof row[0] !== "string") continue;
      const e = row[1];
      if (!e || typeof e.chatId !== "string" || !/^-?\d+$/.test(e.chatId) ||
          !Number.isFinite(e.until) || e.until <= now || e.until > now + ROUTER_FOLLOWUP_MS) continue;
      registry.map.set(row[0], { chatId: e.chatId, until: e.until });
    }
    return registry;
  }
  get size(): number {
    return this.map.size;
  }
}

/** 허용 목록 정리: 존재하지 않는(삭제된) 대화·기본 대화·중복 제거. 유지보수용. */
export function sanitizeTargets(targets: RouteTarget[], existingConvIds: Set<string>, defaultConvId: string): RouteTarget[] {
  const seen = new Set<string>();
  const out: RouteTarget[] = [];
  for (const t of targets) {
    if (!t || typeof t.convId !== "string") continue;
    if (t.convId === defaultConvId || !existingConvIds.has(t.convId) || seen.has(t.convId)) continue;
    seen.add(t.convId);
    out.push({
      convId: t.convId,
      label: (t.label || "").trim() || t.convId.slice(0, 8),
      aliases: Array.isArray(t.aliases) ? t.aliases.map((a) => String(a).replace(/^@/, "").trim()).filter(Boolean) : [],
      description: String(t.description || ""),
    });
  }
  return out;
}

/** 회신 머리표: 기본 대화는 그대로, 분배된 대화는 "[CAE GUI] " 를 붙인다. */
export function labelReply(text: string, label: string, isDefault: boolean): string {
  return isDefault ? text : `[${label}] ${text}`;
}

/**
 * v0.7.54 — 분배 대상 기본값 (2026-10-29 K 확정: CAE GUI·CAE Solver·KDA 개발·쇼츠·SIGILFALL, 트레이딩 봇 제외).
 * 대화 id 를 고정 저장하지 않고 매번 폴더/제목으로 다시 찾는다 → 새 대화를 만들어도 그 폴더의
 * 최신 대화로 자동 연결되고, 삭제된 대화는 자연히 빠진다(유지보수 부담 0).
 * K 가 설정에서 직접 목록을 지정하면(customTargets) 그것을 우선한다.
 */
export interface RouteSpec {
  folder: RegExp;
  title?: RegExp;
  label: string;
  aliases: string[];
}

export const DEFAULT_ROUTE_SPECS: RouteSpec[] = [
  { folder: /설계해석|CAE/i, title: /\[CAE GUI\]/i, label: "CAE GUI", aliases: ["cae", "gui", "해석"] },
  { folder: /설계해석|CAE/i, title: /\[CAE Solver\]/i, label: "CAE Solver", aliases: ["solver", "솔버"] },
  { folder: /^KDA/i, label: "KDA 개발", aliases: ["kda"] },
  { folder: /쇼츠|shorts/i, label: "쇼츠", aliases: ["쇼츠", "shorts"] },
  { folder: /SIGILFALL/i, label: "SIGILFALL", aliases: ["sigil", "시길"] },
];

export function seedRouteTargets(
  folders: Array<{ id: string; name: string; systemPrompt?: string | null }>,
  /** 최근 갱신 순(앞이 최신)으로 정렬된 대화 목록. */
  conversations: Array<{ id: string; title: string; folderId?: string | null }>,
  defaultConvId: string,
  specs: RouteSpec[] = DEFAULT_ROUTE_SPECS,
): RouteTarget[] {
  const out: RouteTarget[] = [];
  for (const spec of specs) {
    const folder = folders.find((f) => spec.folder.test(f.name));
    if (!folder) continue;
    const conv = conversations.find(
      (c) => c.folderId === folder.id && c.id !== defaultConvId && (!spec.title || spec.title.test(c.title)) && !out.some((o) => o.convId === c.id),
    );
    if (!conv) continue;
    const desc = `${folder.name}: ${(folder.systemPrompt ?? "").replace(/\s+/g, " ").slice(0, 160)} / 대화: ${conv.title.slice(0, 40)}`;
    out.push({ convId: conv.id, label: spec.label, aliases: spec.aliases, description: desc });
  }
  return out;
}
