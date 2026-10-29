// v0.7.57 — 릴리즈 후 자동 설치 (요청 파일 방식).
//
// 배경 (2026-10-29): 태그 push 와 CI 감시까지는 에이전트가 끝내는데, 마지막 "업데이트 설치" 를
// 매번 K 에게 넘겨 그 사이 검증이 멈췄다. K 가 릴리즈를 승인했으면 설치·재기동·설치 후 검증까지
// 이어서 하기로 확정 (같은 날 K 승인 "추천 진행").
//
// 동작:
//   1. 에이전트가 릴리즈 성공을 확인한 뒤 `~/.kda/auto-update-request.json` 을 쓴다:
//        { "version": "0.7.57", "requestedAt": "<ISO>", "reason": "...", "conversationId": "..." }
//   2. KDA 가 30초마다 이 파일을 보고, **진행 중 턴이 하나도 없는 상태가 90초 이상** 이어지면
//      인앱 업데이터(@tauri-apps/plugin-updater — 서명 검증 포함)로 그 버전을 설치하고 재기동한다.
//      업데이터가 찾은 버전이 요청 버전과 다르면 설치하지 않는다.
//   3. 재기동한 KDA 가 현재 버전 ≥ 요청 버전을 확인하면 `~/.kda/auto-update.done.json` 을 쓰고 요청을 지운다.
//      에이전트는 이 done 파일을 task-watch 로 감시해 설치 후 검증을 이어간다.
//   요청은 3시간이 지나면 만료(설치 안 함, expired 로 done 기록). 요청 버전보다 낮은 버전으로는 절대 내리지 않는다.
//
// 이 파일은 판정만 하는 순수 함수다 (App 이 파일 I/O·업데이터 호출을 담당).

export const AUTO_UPDATE_IDLE_MS = 90_000;
export const AUTO_UPDATE_EXPIRE_MS = 3 * 60 * 60 * 1000;
export const AUTO_UPDATE_POLL_MS = 30_000;

export interface AutoUpdateRequest {
  version: string;
  requestedAt: string;
  reason?: string;
  conversationId?: string;
}

export type AutoUpdateDecision =
  | { action: "none" }
  | { action: "invalid"; why: string }
  | { action: "installed"; current: string }
  | { action: "expired" }
  | { action: "wait"; why: "busy" | "idle" }
  | { action: "install"; version: string };

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseAutoUpdateRequest(raw: string | null | undefined): AutoUpdateRequest | { invalid: string } | null {
  if (raw == null) return null;
  const text = raw.replace(/^﻿/, "").trim();
  if (!text) return null;
  let obj: any;
  try { obj = JSON.parse(text); } catch { return { invalid: "JSON 파싱 실패" }; }
  const version = typeof obj?.version === "string" ? obj.version.replace(/^v/, "").trim() : "";
  if (!SEMVER.test(version)) return { invalid: `version 형식 오류: ${String(obj?.version)}` };
  const requestedAt = typeof obj?.requestedAt === "string" ? obj.requestedAt : "";
  if (!requestedAt || Number.isNaN(Date.parse(requestedAt))) return { invalid: "requestedAt 없음/형식 오류" };
  return {
    version,
    requestedAt,
    reason: typeof obj.reason === "string" ? obj.reason : undefined,
    conversationId: typeof obj.conversationId === "string" ? obj.conversationId : undefined,
  };
}

/** a<b → -1, a==b → 0, a>b → 1. 형식이 틀리면 NaN 취급으로 0 이 아닌 -1 (설치 판정 쪽으로 기울지 않게 호출부가 검증). */
export function compareSemver(a: string, b: string): number {
  const ma = SEMVER.exec(a.replace(/^v/, "")), mb = SEMVER.exec(b.replace(/^v/, ""));
  if (!ma || !mb) return -1;
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function decideAutoUpdate(input: {
  raw: string | null | undefined;
  current: string;
  now: number;
  busy: boolean;
  idleSince: number | null;
}): AutoUpdateDecision {
  const parsed = parseAutoUpdateRequest(input.raw);
  if (parsed == null) return { action: "none" };
  if ("invalid" in parsed) return { action: "invalid", why: parsed.invalid };
  if (compareSemver(input.current, parsed.version) >= 0) return { action: "installed", current: input.current };
  if (input.now - Date.parse(parsed.requestedAt) > AUTO_UPDATE_EXPIRE_MS) return { action: "expired" };
  if (input.busy) return { action: "wait", why: "busy" };
  if (input.idleSince == null || input.now - input.idleSince < AUTO_UPDATE_IDLE_MS) return { action: "wait", why: "idle" };
  return { action: "install", version: parsed.version };
}

/** 업데이터가 찾은 버전이 요청과 정확히 같을 때만 설치 (더 높은 버전·다른 버전 자동 설치 금지). */
export function updaterVersionMatches(found: string | null | undefined, requested: string): boolean {
  if (!found) return false;
  return compareSemver(found, requested) === 0;
}
