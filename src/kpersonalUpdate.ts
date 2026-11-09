// v0.7.82 — k-personal(MCP 도구) 자동 업그레이드 결과를 화면 알림 문구로 바꾼다.
// Rust `kpersonal_upgrade::run_upgrade` 가 쓰는 상태 JSON 을 입력으로 받는다.
export type KpersonalNotice = { kind: "ok" | "error"; text: string } | null;

export function describeKpersonalUpdate(status: unknown, nowSec: number): KpersonalNotice {
  if (!status || typeof status !== "object" || Array.isArray(status)) return null;
  const s = status as Record<string, unknown>;
  const at = typeof s.at === "number" ? s.at : 0;
  // 오래된 결과(10분 초과)는 다시 띄우지 않는다 — 이번 시작에서 나온 결과만.
  if (!at || nowSec - at > 600) return null;
  if (s.state === "failed") {
    const err = typeof s.error === "string" ? s.error : "원인 미상";
    return { kind: "error", text: `MCP 도구(k-personal) 자동 업데이트 실패 — ${err}` };
  }
  if (s.state === "upgraded") {
    return { kind: "ok", text: `MCP 도구(k-personal) v${s.fromVersion} → v${s.toVersion} 업데이트 완료` };
  }
  return null;
}
