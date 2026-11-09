// v0.7.84 — 설치 완료 검사 결과 → 화면 알림 / 자동 재설치 판정 (순수 함수).
// Rust(install_integrity.rs)가 install-complete.txt 표시로 complete / incomplete / dev 를 판정한다.

export interface InstallIntegrity {
  state: "complete" | "incomplete" | "dev";
  appVersion?: string;
  markerVersion?: string | null;
  reason?: string;
  autoAttempts?: number;
  maxAutoAttempts?: number;
  lastRepairError?: string | null;
}

export type InstallNotice = { text: string; detail?: string } | null;

export function parseIntegrity(v: unknown): InstallIntegrity | null {
  if (!v || typeof v !== "object") return null;
  const s = (v as { state?: unknown }).state;
  if (s !== "complete" && s !== "incomplete" && s !== "dev") return null;
  return v as InstallIntegrity;
}

export function describeInstallIntegrity(v: unknown): InstallNotice {
  const st = parseIntegrity(v);
  if (!st || st.state !== "incomplete") return null;
  const ver = st.appVersion ? `v${st.appVersion} ` : "";
  const detail = [st.reason, st.lastRepairError ? `지난 재설치 오류: ${st.lastRepairError}` : ""].filter(Boolean).join(" · ");
  return {
    text: `${ver}설치가 끝까지 완료되지 않았습니다. 일부 파일이 이전 버전일 수 있습니다.`,
    detail: detail || undefined,
  };
}

/** 자동 설치 요청 흐름에서 버전은 맞는데 설치가 불완전할 때: 한도 안이면 자동 재설치, 넘으면 중단·기록. */
export function decideIncompleteAction(v: unknown): "complete" | "auto-repair" | "give-up" {
  const st = parseIntegrity(v);
  if (!st || st.state !== "incomplete") return "complete";
  const max = st.maxAutoAttempts ?? 2;
  return (st.autoAttempts ?? 0) < max ? "auto-repair" : "give-up";
}
