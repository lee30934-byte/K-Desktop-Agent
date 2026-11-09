// 화면 작업 턴 멈춤 감시 (2026-11-09).
//
// 기존 idle watchdog 은 60분 기준이라 "화면을 조작하다 가만히 서 있는" 상태를 알아채지 못한다.
// 이 모니터는 턴 안에서 화면 도구(ui_/cc_/web_)가 한 번이라도 쓰인 뒤에만 켜지고,
//   - 실행 중인 도구가 있으면 "작업 중"(ok),
//   - 승인/입력 요청을 기다리면 "사용자 대기"(waiting_user),
//   - 도구도 출력도 없이 warnMs 를 넘기면 "진행 없음"(no_progress),
//   - stallMs 를 넘기면 "멈춤"(stalled)
// 으로 판정한다. 자동 종료는 하지 않는다 — 중단은 사용자가 정지 버튼으로 결정한다.

export type DesktopStallState = "ok" | "waiting_user" | "no_progress" | "stalled";

export const DESKTOP_STALL_WARN_MS = Number(process.env.KDA_DESKTOP_STALL_WARN_MS) || 90_000;
export const DESKTOP_STALL_STOP_MS = Number(process.env.KDA_DESKTOP_STALL_STOP_MS) || 180_000;

const DESKTOP_TOOL_RE = /^(?:mcp__k-personal__)?(?:ui|cc|web)_[a-z_]+$/;

export function isDesktopTool(name: unknown): boolean {
  return typeof name === "string" && DESKTOP_TOOL_RE.test(name);
}

export interface DesktopStallEvaluation {
  changed: boolean;
  state: DesktopStallState;
  idleMs: number;
}

export class DesktopStallMonitor {
  private desktopActive = false;
  private lastProgressAt: number;
  private readonly activeTools = new Set<string>();
  private readonly waiting = new Set<string>();
  private state: DesktopStallState = "ok";

  constructor(
    private readonly warnMs = DESKTOP_STALL_WARN_MS,
    private readonly stallMs = DESKTOP_STALL_STOP_MS,
    now = Date.now(),
  ) {
    this.lastProgressAt = now;
  }

  get active(): boolean { return this.desktopActive; }

  progress(now = Date.now()): void { this.lastProgressAt = now; }

  toolStarted(id: string, name: unknown, now = Date.now()): void {
    if (isDesktopTool(name)) this.desktopActive = true;
    this.activeTools.add(id);
    this.progress(now);
  }

  toolDone(id: string, now = Date.now()): void {
    this.activeTools.delete(id);
    this.progress(now);
  }

  waitStarted(token: string, now = Date.now()): void {
    this.waiting.add(token);
    this.progress(now);
  }

  waitEnded(token: string, now = Date.now()): void {
    this.waiting.delete(token);
    this.progress(now);
  }

  evaluate(now = Date.now()): DesktopStallEvaluation {
    const idleMs = Math.max(0, now - this.lastProgressAt);
    let next: DesktopStallState = "ok";
    if (this.desktopActive) {
      if (this.waiting.size > 0) next = "waiting_user";
      else if (this.activeTools.size > 0) next = "ok";
      else if (idleMs >= this.stallMs) next = "stalled";
      else if (idleMs >= this.warnMs) next = "no_progress";
    }
    const changed = next !== this.state;
    this.state = next;
    return { changed, state: next, idleMs };
  }
}

export function desktopStallMessage(state: DesktopStallState, idleMs: number): string | null {
  const sec = Math.round(idleMs / 1000);
  switch (state) {
    case "waiting_user":
      return "화면 작업이 승인 또는 입력을 기다리고 있습니다. 요청 창을 확인해 주세요.";
    case "no_progress":
      return `화면 작업이 ${sec}초째 도구 호출도 응답도 없습니다. 조금 더 기다리거나 정지할 수 있습니다.`;
    case "stalled":
      return `화면 작업이 ${sec}초째 멈춰 있습니다. 정지 버튼으로 중단한 뒤 다시 지시해 주세요.`;
    default:
      return null;
  }
}
