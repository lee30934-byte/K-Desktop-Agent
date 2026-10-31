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
// v0.7.56 — "승인" 단독은 보고문("승인대로 처리했고")에도 나와 오분류됐다. 요청형 표현만 결정 신호로 본다.
const DECISION_WORD_RE = /(승인(을|이)?\s*(필요|요청|해\s*주|하시겠|부탁|합니다\?)|확인해\s*주|선택해\s*주|골라\s*주|정해\s*주|알려\s*주세요|진행할까요|할까요\?|하시겠|어느 쪽|번호로|번호를)/;
const PROGRESS_RE = /^(⏳|진행 중|작업 중|실행 중|계속 진행|중간 보고|빌드 중)/;

interface ChoiceRun {
  options: ChoiceOption[];
  /** 원문에서 목록이 시작·끝나는 문자 위치 (결정 문구 근접성 판정용). */
  start: number;
  end: number;
}

/**
 * 번호 목록 묶음 찾기. 한 묶음 = 빈 줄 없이 이어진 "1. … / 2. …" 줄들.
 * 굵게 감싼 소제목 줄(**1. 점검 결과**)은 선택지가 아니라 보고 항목이라 제외한다.
 * (2026-10-29 실사용: 소제목 "1. 점검 결과"를 선택지로 잡아 버튼 '1. 점검 결과'가 실제로는 '1 = 삭제 승인'을 보냈다)
 */
function findChoiceRuns(text: string): ChoiceRun[] {
  const circled = "①②③④⑤⑥⑦⑧⑨⑩";
  const runs: ChoiceRun[] = [];
  let cur: ChoiceRun | null = null;
  let pos = 0;
  for (const raw of text.split(/\n/)) {
    const lineStart = pos;
    pos += raw.length + 1;
    const trimmed = raw.trim();
    const isBoldHeading = /^\*\*.+\*\*[:：]?$/.test(trimmed);
    const line = trimmed.replace(/^[-*]\s+/, "");
    let key: string | undefined;
    let body: string | undefined;
    const m = /^(\d{1,2})\s*(?:[.)]|번)\s+(.+)$/.exec(line);
    if (m && !isBoldHeading) {
      key = m[1];
      body = m[2];
    } else if (!isBoldHeading) {
      const c = circled.indexOf(line.charAt(0));
      if (c >= 0 && line.length > 1) {
        key = String(c + 1);
        body = line.slice(1).trim();
      }
    }
    if (key && body) {
      const label0 = body.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
      const opt = { key, label: label0.length > 28 ? label0.slice(0, 27) + "…" : label0 };
      if (cur && key === String(cur.options.length + 1)) {
        cur.options.push(opt);
        cur.end = lineStart + raw.length;
        continue;
      }
      if (cur) runs.push(cur);
      cur = key === "1" ? { options: [opt], start: lineStart, end: lineStart + raw.length } : null;
      continue;
    }
    // 들여쓴 하위 줄(목록 항목의 부연)은 묶음을 끊지 않는다. 빈 줄·일반 문장은 끊는다.
    if (cur && trimmed !== "" && /^\s{2,}\S/.test(raw)) continue;
    if (cur) {
      runs.push(cur);
      cur = null;
    }
  }
  if (cur) runs.push(cur);
  return runs.filter((r) => r.options.length >= 2);
}

/** 선택지 = 마지막 번호 목록 묶음 (앞쪽 보고 항목 번호와 섞지 않는다). */
export function extractChoices(text: string, maxOptions = 6): ChoiceOption[] {
  const runs = findChoiceRuns(text);
  const last = runs[runs.length - 1];
  return last ? last.options.slice(0, maxOptions) : [];
}

/** 회신 등급. 결정 필요 > 오류 > 진행 중 > 결과. */
export function classifyTier(text: string): DigestTier {
  const t = text.trim();
  const runs = findChoiceRuns(t);
  const last = runs[runs.length - 1];
  // 결정 필요 = 마지막 번호 목록이 글 끝부분에 있고, 결정 요청 문구가 그 목록 바로 앞(400자)·뒤에 있을 때.
  if (last && t.length - last.end <= 400) {
    const near = t.slice(Math.max(0, last.start - 400));
    if (DECISION_WORD_RE.test(near)) return "decision";
  }
  if (DECISION_WORD_RE.test(t.slice(-400)) && /\?\s*$/.test(t)) return "decision";
  // A pending approval without numbered choices is still urgent during quiet hours.
  if (/(승인|확인|결정|판단)(이|을|가)?\s*필요(합니다|해요|한|$)|(?:승인|확인)(?:을)?\s*요청(?:합니다|드립니다)/.test(t.slice(-400))) return "decision";
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
