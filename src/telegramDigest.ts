/**
 * v0.7.54 — 텔레그램 회신 가공 순수 로직 (요약 등급 / 선택지 버튼 / 이미지 추출 / 조용한 시간).
 * React/Tauri 무의존 — scripts/telegram-digest.test.ts 로 검증.
 *
 * 원칙: "결정 필요"와 "오류"는 규칙으로 판정해 AI 판단 실수로 빠지지 않게 한다.
 */

export type DigestTier = "decision" | "error" | "result" | "progress";

export interface ChoiceOption {
  /** 버튼에 표시·회신할 키 ("1", "2", ...). */
  key: string;
  /** 버튼 라벨(짧게 자름). */
  label: string;
}

const ERROR_RE = /(❌|⚠️?\s*(오류|실패|에러)|\b(error|failed|failure|exception|traceback)\b|실패했|오류가|에러가|rc\s*=\s*[1-9]|exit code\s*[1-9])/i;
const DECISION_WORD_RE = /(승인|확인해\s*주|선택해\s*주|골라\s*주|정해\s*주|알려\s*주세요|진행할까요|할까요\?|하시겠|어느 쪽|번호로|번호를)/;
const PROGRESS_RE = /^(⏳|진행 중|작업 중|실행 중|계속 진행|중간 보고|빌드 중)/;

/** 줄 머리 번호 선택지: "1. xxx", "1) xxx", "① xxx", "1번 xxx". 2개 이상 연속일 때만 선택지로 본다. */
export function extractChoices(text: string, maxOptions = 6): ChoiceOption[] {
  const circled = "①②③④⑤⑥⑦⑧⑨⑩";
  const out: ChoiceOption[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*]\s+/, "").replace(/^\*\*|\*\*$/g, "");
    let m = /^(\d{1,2})\s*(?:[.)]|번)\s+(.+)$/.exec(line);
    let key: string | undefined;
    let body: string | undefined;
    if (m) {
      key = m[1];
      body = m[2];
    } else {
      const c = circled.indexOf(line.charAt(0));
      if (c >= 0 && line.length > 1) {
        key = String(c + 1);
        body = line.slice(1).trim();
      }
    }
    if (!key || !body || seen.has(key)) continue;
    seen.add(key);
    const label = body.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    out.push({ key, label: label.length > 28 ? label.slice(0, 27) + "…" : label });
  }
  // 1부터 시작하는 연속 번호여야 선택지 (본문 번호 목록 오탐 줄이기 위해 결정 문구와 함께 쓴다)
  const seq = out.filter((o, i) => o.key === String(i + 1));
  return seq.length >= 2 ? seq.slice(0, maxOptions) : [];
}

/** 회신 등급. 결정 필요 > 오류 > 진행 중 > 결과. */
export function classifyTier(text: string): DigestTier {
  const t = text.trim();
  const tail = t.slice(-1500);
  const hasChoices = extractChoices(tail).length >= 2;
  if ((hasChoices && DECISION_WORD_RE.test(tail)) || (DECISION_WORD_RE.test(tail) && /\?\s*$/.test(t))) return "decision";
  if (ERROR_RE.test(t.slice(0, 2000))) return "error";
  if (PROGRESS_RE.test(t) && t.length < 400) return "progress";
  return "result";
}

const IMG_EXT = /\.(png|jpe?g|webp|gif)$/i;

/** 회신 본문의 로컬 이미지 경로(Windows 드라이브 경로만). 마크다운 이미지 + 맨 경로. 중복 제거, 순서 유지. */
export function extractImagePaths(text: string): string[] {
  const found: string[] = [];
  const push = (p: string) => {
    const norm = p.trim().replace(/^<|>$/g, "").replace(/\\/g, "/");
    if (!/^[A-Za-z]:\//.test(norm) || !IMG_EXT.test(norm)) return;
    const key = norm.toLowerCase();
    if (!found.some((f) => f.toLowerCase() === key)) found.push(norm);
  };
  for (const m of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) push(m[1]);
  for (const m of text.matchAll(/`([A-Za-z]:[\\/][^`]+?\.(?:png|jpe?g|webp|gif))`/gi)) push(m[1]);
  for (const m of text.matchAll(/(?<![\w(`/])([A-Za-z]:[\\/][^\s"'`()<>|*?]+?\.(?:png|jpe?g|webp|gif))(?![\w])/gi)) push(m[1]);
  return found;
}

/** 원격에서 못 읽는 경로 판별 (WSL/VM POSIX 경로 등) — 실패 안내용. */
export function unreachableImageRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\w:])(\/(?:home|mnt|tmp|root)\/[^\s"'`()<>]+?\.(?:png|jpe?g|webp|gif))/gi)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export interface QuietHours {
  enabled: boolean;
  /** 0~23 시작 시각(포함). */
  startHour: number;
  /** 0~23 끝 시각(미포함). start > end 면 자정을 넘는 구간. */
  endHour: number;
}

export function inQuietHours(q: QuietHours | undefined, date: Date): boolean {
  if (!q || !q.enabled) return false;
  const h = date.getHours();
  if (q.startHour === q.endHour) return false;
  return q.startHour < q.endHour ? h >= q.startHour && h < q.endHour : h >= q.startHour || h < q.endHour;
}

/** 지금 즉시 보낼지: 결정 필요·오류는 항상, 진행 중은 안 보냄, 결과는 조용한 시간이면 보류(아침 요약). */
export function deliveryPlan(tier: DigestTier, quiet: boolean): "send" | "hold" | "skip" {
  if (tier === "decision" || tier === "error") return "send";
  if (tier === "progress") return "skip";
  return quiet ? "hold" : "send";
}

/** 요약 프롬프트 (도구 없이 Luna 1회). */
export function buildSummaryPrompt(label: string, tier: DigestTier, text: string): string {
  const rule =
    tier === "decision"
      ? "Summarize the situation in at most 2 short lines. Do NOT include the option list; it is attached separately."
      : "Summarize in 3-5 short lines: outcome (success/failure), key numbers, next action. Keep numbers, file names and error codes exactly.";
  return [
    `You condense a work-session report for a phone notification. Session: ${label}.`,
    rule,
    "Write in Korean. Plain text only, no markdown headings, no preamble.",
    "",
    "Report:",
    text.slice(0, 12000),
  ].join("\n");
}

/** 요약 실패 시 대체 본문. */
export function fallbackSummary(text: string, limit = 800): string {
  const t = text.trim();
  return t.length <= limit ? t : t.slice(0, limit) + "\n…(요약 실패 — '자세히'로 답장하면 전문)";
}

/** 인라인 버튼 callback_data (텔레그램 64바이트 제한). 대화 id 앞 8자 + 키. */
export function encodeChoiceCallback(convId: string, key: string): string {
  return `c:${convId.slice(0, 8)}:${key}`.slice(0, 64);
}

export function decodeChoiceCallback(data: string): { convPrefix: string; key: string } | null {
  const m = /^c:([0-9a-f-]{1,8}):([0-9]{1,2})$/i.exec(data);
  return m ? { convPrefix: m[1], key: m[2] } : null;
}

/** 승인 버튼 callback_data: a:<token8>:y|n */
export function encodeApprovalCallback(token: string, approve: boolean): string {
  return `a:${token.slice(0, 16)}:${approve ? "y" : "n"}`;
}

export function decodeApprovalCallback(data: string): { token: string; approve: boolean } | null {
  const m = /^a:([A-Za-z0-9_-]{4,16}):([yn])$/.exec(data);
  return m ? { token: m[1], approve: m[2] === "y" } : null;
}
