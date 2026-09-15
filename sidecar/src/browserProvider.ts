/**
 * Stage 2 — 대화별 BrowserHost provider 의 턴 수명주기.
 *
 * 이 모듈은 브라우저도 Tauri 도 직접 모르고, 주입된 request/emit/isStopping 만 쓴다.
 * 그래서 로그인 필요, 스트리밍 증분, 취소, 시간 초과, 용량 회수를 브라우저 없이 실측할 수 있다.
 *
 * 하지 않는 것(이 단계에서 조용히 무시하지 않고 명시적으로 거부):
 *   - 첨부 파일, 모델/effort 선택, 도구 실행, history/메모리 주입.
 */

export type BrowserPhase =
  | "login-required" | "ready" | "submitting" | "streaming"
  | "stopping" | "completed" | "cancelled" | "failed" | "closed";

export type BrowserTurnStatus = {
  phase?: string;
  text?: string;
  error?: string | null;
  authenticated?: boolean | null;
  /** native 가 "아직 chatgpt.com 에서 측정하지 못했다"고 알릴 때만 실린다. 미로그인과 구분된다. */
  authState?: "unverified";
  visible?: boolean | null;
};

export type BrowserTurnMessage = {
  id: string;
  content: string;
  conversation_id?: string;
  model?: string;
  reasoningEffort?: string;
  attachments?: Array<{ name: string }>;
  /** Settings 의 카테고리 토글 (id → auto|ask|manual). chatgpt-web 은 도구를 실행하지 않으므로 고지에만 쓴다. */
  permissions?: Record<string, string | undefined>;
  /** 정밀 잠금된 도구 풀네임. 도구 자체가 0회이므로 동작에 영향 없음 — 고지 문구에만 반영. */
  lockedTools?: string[];
};

export type BrowserTurnDeps = {
  /** owner/action/prompt 를 그대로 native 로 넘긴다. 실패는 Error 로 던진다. */
  request: (owner: string, action: string, prompt?: string) => Promise<BrowserTurnStatus>;
  emit: (event: Record<string, unknown>) => void;
  /** 사용자가 이 턴을 정지했는지 — 폴링 사이마다 확인한다. */
  isStopping: () => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  pollIntervalMs?: number;
  /** sidecar 쪽 상한. native watchdog(180초) 보다 길게 둬 native 판정을 먼저 받게 한다. */
  turnLimitMs?: number;
  /** 창이 ready 가 되기를 기다리는 상한. 이 시간 안에 못 재면 "로그인 필요"로 단정하지 않는다. */
  readyTimeoutMs?: number;
  readyPollIntervalMs?: number;
};

export type BrowserTurnOutcome = {
  status: "completed" | "login-required" | "stopped" | "failed" | "rejected";
  owner: string;
  reason?: string;
  emittedChars: number;
  pollCount: number;
  /** ready 를 기다리며 실제로 측정한 횟수 — "한 번 보고 단정했는지" 를 증거로 남긴다. */
  readyChecks?: number;
  leaseReleased: boolean;
  /** 도구 권한이 열린 대화였고, "도구 0회" 를 명시적으로 고지했는지. 조용한 무시가 아님을 증거로 남긴다. */
  toolNoticeSent?: boolean;
};

/**
 * 이 provider 가 낼 수 있는 이벤트의 **전부**.
 *
 * 계약(2026-09-15): chatgpt-web 은 텍스트 왕복만 한다. ChatGPT 가 무슨 텍스트를 뱉든
 * KDA 가 그걸 도구 호출로 해석하는 경로가 있으면 안 된다. 그래서 "도구 이벤트를 안 만든다" 는
 * 관례가 아니라 **실행 시점에 강제되는 화이트리스트**로 둔다. 목록 밖 이벤트는 던져서 실패시킨다.
 */
export const BROWSER_PROVIDER_EVENTS = Object.freeze(
  ["assistant_delta", "error", "done", "provider_notice"] as const,
);

/**
 * 도구 권한이 열려 있는 대화에서 이 provider 를 쓰면 **도구는 0회 실행된다.**
 * 그 사실을 조용히 넘기지 않기 위한 고지 문구. 열린 권한이 없으면 null (고지 자체를 안 만든다).
 *
 * 왜 거부가 아니라 고지인가: Settings 기본값이 이미 여러 카테고리를 auto/ask 로 두기 때문에
 * 거부로 처리하면 정상 사용자가 텍스트 대화조차 못 한다. 기능을 막는 대신 사실을 드러낸다.
 */
export function toolExposureNotice(msg: BrowserTurnMessage): string | null {
  const open = Object.entries(msg.permissions ?? {})
    .filter(([, level]) => level === "auto" || level === "ask")
    .map(([id]) => id)
    .sort();
  const locked = (msg.lockedTools ?? []).length;
  if (open.length === 0) return null;
  const shown = open.slice(0, 5).join(", ") + (open.length > 5 ? ` 외 ${open.length - 5}개` : "");
  return (
    `ChatGPT (브라우저) provider 는 도구를 실행하지 않습니다 — 이번 턴의 도구 호출은 0회입니다. ` +
    `이 대화에 열려 있는 권한 ${open.length}개(${shown})는 적용되지 않습니다` +
    (locked > 0 ? ` (정밀 잠금 ${locked}개도 무의미합니다)` : "") +
    `. 도구·MCP 가 필요하면 다른 provider 를 선택하세요.`
  );
}

export const LOGIN_GUIDANCE =
  "ChatGPT 로그인이 필요합니다. 방금 열린 KDA ChatGPT 창에서 로그인한 뒤 같은 메시지를 다시 보내주세요. " +
  "창을 닫으면 로그인 상태가 확인되지 않습니다.";

const OWNER_MAX = 128;

/** 대화별 owner. 같은 대화는 같은 창, 다른 대화는 절대 같은 창을 쓰지 않는다. */
export function browserOwnerId(conversationId: string | undefined, turnId: string): string {
  const source = (conversationId ?? "").trim() || `turn-${turnId}`;
  const safe = source.replace(/[^A-Za-z0-9_:-]/g, "-").replace(/^-+/, "") || "unknown";
  return `conv-${safe}`.slice(0, OWNER_MAX);
}

/**
 * 브라우저에서 긁어온 텍스트는 **append-only 가 아니다.**
 * 2026-09-15 실측: 첫 스냅샷이 "생각 중..." 자리표시자였고 다음 스냅샷에서 실제 답으로 **교체**됐다.
 * 그걸 그대로 흘려보내면 자리표시자와 안내문구가 모델 답변인 척 섞여 답이 오염된다.
 *
 * 그래서 **확정된 것만** 내보낸다:
 *   관측한 텍스트는 일단 보류하고, 다음 스냅샷이 그 텍스트를 **접두사로 유지한 채 늘어났을 때만** 확정한다.
 *   교체되면(자리표시자) 아직 아무것도 안 내보냈으므로 조용히 버린다.
 *   종료 시점의 최종 텍스트로 남은 부분을 확정한다 → 내보낸 총합 == 최종 텍스트(정확히 한 번).
 */
export class TextDeltaReconciler {
  private sent = "";
  private pending = "";
  rewrites = 0;
  /** 스트리밍 중 스냅샷. 확정된 증분만 반환한다(없으면 null). */
  observe(text: unknown): string | null {
    if (typeof text !== "string" || text.length === 0) return null;
    if (text === this.pending) return null;
    let delta: string | null = null;
    if (this.pending && text.startsWith(this.pending)) {
      // 직전 관측이 접두사로 살아남았다 = 확정 가능.
      if (this.pending.length > this.sent.length) {
        delta = this.pending.slice(this.sent.length);
        this.sent = this.pending;
      }
    } else if (this.pending && !text.startsWith(this.pending)) {
      this.rewrites += 1; // 자리표시자 교체 등 — 아직 안 내보냈으면 손실 없음
    }
    this.pending = text;
    return delta;
  }
  /**
   * 종료 시점 확정. 최종 텍스트가 이미 내보낸 것을 접두사로 갖지 않으면 mismatch 를 알린다
   * (이미 보낸 델타는 회수할 수 없으므로, 조용히 덧붙여 답을 오염시키지 않는다).
   */
  finalize(text: unknown): { delta: string | null; mismatch: boolean; final: string } {
    const final = typeof text === "string" ? text : this.sent;
    this.pending = final;
    if (!final) return { delta: null, mismatch: false, final: this.sent };
    if (!final.startsWith(this.sent)) {
      this.rewrites += 1;
      return { delta: null, mismatch: this.sent.length > 0, final };
    }
    const delta = final.slice(this.sent.length) || null;
    this.sent = final;
    return { delta, mismatch: false, final };
  }
  get emitted(): string { return this.sent; }
}

function phaseOf(status: BrowserTurnStatus | undefined): string {
  return typeof status?.phase === "string" ? status.phase : "unknown";
}

function unsupported(msg: BrowserTurnMessage): string | null {
  if (msg.attachments && msg.attachments.length > 0) {
    return `ChatGPT 브라우저 provider 는 아직 첨부 파일을 보내지 못합니다 (${msg.attachments.length}개). ` +
      "첨부가 필요하면 다른 provider 를 선택하세요.";
  }
  const model = (msg.model ?? "").trim();
  if (model && model !== "default") {
    return `ChatGPT 브라우저 provider 는 모델 선택(${model})을 아직 지원하지 않습니다. ` +
      "모델을 기본값으로 두거나 다른 provider 를 선택하세요.";
  }
  const effort = (msg.reasoningEffort ?? "").trim();
  if (effort && effort !== "default") {
    return `ChatGPT 브라우저 provider 는 추론 강도(${effort}) 설정을 아직 지원하지 않습니다.`;
  }
  return null;
}

/** 한 턴을 끝까지 몰고 간다. 반환 전에 lease 를 반드시 정리한다(로그인 대기 창은 예외). */
export async function runBrowserTurn(
  msg: BrowserTurnMessage,
  deps: BrowserTurnDeps,
): Promise<BrowserTurnOutcome> {
  const owner = browserOwnerId(msg.conversation_id, msg.id);
  const pollIntervalMs = deps.pollIntervalMs ?? 1000;
  const turnLimitMs = deps.turnLimitMs ?? 240_000;
  const readyTimeoutMs = deps.readyTimeoutMs ?? 45_000;
  const readyPollIntervalMs = deps.readyPollIntervalMs ?? 1000;
  const deltas = new TextDeltaReconciler();
  let pollCount = 0;
  let readyChecks = 0;
  let opened = false;
  let keepWindow = false;
  let toolNoticeSent = false;

  // 텍스트 provider 가 도구 이벤트를 낼 수 있는 경로 자체를 런타임에서 차단한다.
  // (목록 밖 type 은 버그다 — 조용히 통과시키면 "텍스트가 도구로 해석" 되는 문을 열어준다.)
  const allowed = new Set<string>(BROWSER_PROVIDER_EVENTS);
  const emit = (event: Record<string, unknown>): void => {
    const type = String(event.type);
    if (!allowed.has(type)) {
      throw new Error(`browser-provider-illegal-event:${type}`);
    }
    deps.emit(event);
  };

  const fail = (reason: string, message: string): BrowserTurnOutcome => {
    emit({ type: "error", id: msg.id, message });
    return { status: "failed", owner, reason, emittedChars: deltas.emitted.length, pollCount, leaseReleased: false };
  };
  /** 스트리밍 중: 확정된 증분만 흘린다. */
  const pushText = (status: BrowserTurnStatus): void => {
    const delta = deltas.observe(status.text);
    if (delta) emit({ type: "assistant_delta", id: msg.id, text: delta });
  };
  /** 종료: 최종 텍스트로 남은 증분을 확정한다. 접두사가 깨졌으면 답을 오염시키지 않고 실패로 알린다. */
  const finalizeText = (status: BrowserTurnStatus): { mismatch: boolean; final: string } => {
    const result = deltas.finalize(status.text);
    if (result.delta) emit({ type: "assistant_delta", id: msg.id, text: result.delta });
    return { mismatch: result.mismatch, final: result.final };
  };

  const rejection = unsupported(msg);
  if (rejection) {
    emit({ type: "error", id: msg.id, message: rejection });
    return { status: "rejected", owner, reason: "unsupported-request", emittedChars: 0, pollCount: 0, leaseReleased: true };
  }
  if (!msg.content || !msg.content.trim()) {
    emit({ type: "error", id: msg.id, message: "빈 메시지는 ChatGPT 브라우저 provider 로 보낼 수 없습니다." });
    return { status: "rejected", owner, reason: "empty-prompt", emittedChars: 0, pollCount: 0, leaseReleased: true };
  }

  // 거부 사유가 없을 때만 고지한다(거부된 턴에 "도구 0회" 고지를 덧붙여도 의미가 없다).
  const toolNotice = toolExposureNotice(msg);
  if (toolNotice) {
    emit({ type: "provider_notice", id: msg.id, provider: "chatgpt-web", message: toolNotice });
    toolNoticeSent = true;
  }

  let outcome: BrowserTurnOutcome;
  try {
    await deps.request(owner, "open");
    opened = true;
    if (deps.isStopping()) {
      outcome = { status: "stopped", owner, reason: "stopped-before-send", emittedChars: 0, pollCount, leaseReleased: false };
    } else {
      const ready = await waitForReady();
      if (ready.kind === "stopped") {
        outcome = { status: "stopped", owner, reason: "stopped-while-opening", emittedChars: 0, pollCount, leaseReleased: false };
      } else if (ready.kind === "login-required") {
        await deps.request(owner, "show");
        emit({ type: "error", id: msg.id, message: LOGIN_GUIDANCE });
        keepWindow = true; // 로그인 중인 창을 닫으면 K 가 로그인할 방법이 없다.
        outcome = { status: "login-required", owner, reason: "login-required", emittedChars: 0, pollCount, leaseReleased: false };
      } else if (ready.kind === "unverified") {
        // 창이 아직 chatgpt.com 을 못 띄운 상태. "로그인 필요"로 단정하면 세션이 멀쩡해도 만료로 오진한다.
        outcome = fail("browser-readiness-unverified",
          "ChatGPT 창이 제한 시간 안에 페이지를 열지 못해 로그인 상태를 확인하지 못했습니다. " +
          "세션 만료로 단정하지 않았습니다. 네트워크를 확인한 뒤 다시 시도하세요.");
      } else if (ready.kind === "failed") {
        outcome = fail(`browser-not-ready:${phaseOf(ready.last)}`,
          `ChatGPT 창이 입력 가능한 상태가 되지 못했습니다 (phase=${phaseOf(ready.last)}). 잠시 후 다시 시도하세요.`);
      } else {
        await deps.request(owner, "hide"); // K 화면을 뺏지 않는다.
        const sent = await deps.request(owner, "send", msg.content);
        pushText(sent);
        outcome = await pollUntilTerminal();
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.log?.("error", `browser provider 실패 id=${msg.id} owner=${owner} reason=${reason}`);
    outcome = fail(reason, describeFailure(reason));
  } finally {
    if (opened && !keepWindow) {
      try {
        await deps.request(owner, "close");
        outcome = { ...outcome!, leaseReleased: true };
      } catch (error) {
        deps.log?.("warn", `browser lease 정리 실패 owner=${owner}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (outcome.status === "completed") emit({ type: "done", id: msg.id, agentId: null });
  return { ...outcome, readyChecks, toolNoticeSent };

  /**
   * 창이 실제로 쓸 수 있게 될 때까지 기다린다.
   *
   * 왜 한 번의 status 로 판정하면 안 되는가(2026-09-15 실측):
   *   open 직후의 창은 아직 about:blank 라 native 가 authState="unverified" 를 준다. 게다가 chatgpt.com
   *   이 떠도 어댑터의 인증 확인은 비동기라 첫 스냅샷은 authenticated=false 로 나온다. 그 순간을
   *   "로그인 필요"로 단정하면 멀쩡한 세션을 만료로 오진한다(턴 시작 0.58초 만에 오진한 기록 있음).
   * 그래서 ready 가 될 때까지 기다리고, 마감 후에야 "측정된 미로그인"과 "측정 자체 실패"를 구분한다.
   */
  async function waitForReady(): Promise<
    | { kind: "ready"; last: BrowserTurnStatus }
    | { kind: "login-required" | "unverified" | "failed"; last: BrowserTurnStatus }
    | { kind: "stopped"; last: BrowserTurnStatus }
  > {
    const deadline = deps.now() + readyTimeoutMs;
    let last: BrowserTurnStatus = {};
    for (;;) {
      if (deps.isStopping()) return { kind: "stopped", last };
      last = await deps.request(owner, "status");
      readyChecks += 1;
      const phase = phaseOf(last);
      if (phase === "ready") return { kind: "ready", last };
      if (phase === "failed" || phase === "closed") return { kind: "failed", last };
      if (deps.now() >= deadline) {
        // authState==="unverified" 는 "아직 못 쟀다"는 뜻이지 "로그인 안 됐다"가 아니다.
        if (last.authState === "unverified") return { kind: "unverified", last };
        if (phase === "login-required") return { kind: "login-required", last };
        return { kind: "failed", last };
      }
      await deps.sleep(readyPollIntervalMs);
    }
  }

  async function pollUntilTerminal(): Promise<BrowserTurnOutcome> {
    const deadline = deps.now() + turnLimitMs;
    let lastStatus: BrowserTurnStatus = {};
    for (;;) {
      if (deps.isStopping()) {
        // 더는 스트리밍이 없으므로 마지막 관측분을 확정해 부분 응답을 잃지 않는다.
        finalizeText(lastStatus);
        await requestStop("stopped-by-user");
        return { status: "stopped", owner, reason: "stopped-by-user", emittedChars: deltas.emitted.length, pollCount, leaseReleased: false };
      }
      if (deps.now() >= deadline) {
        await requestStop("sidecar-turn-limit");
        return fail("browser-turn-limit-no-retry",
          "ChatGPT 브라우저 응답이 제한 시간 안에 끝나지 않아 중단했습니다. 재시도는 자동으로 하지 않습니다.");
      }
      await deps.sleep(pollIntervalMs);
      pollCount += 1;
      const status = await deps.request(owner, "status");
      lastStatus = status;
      const phase = phaseOf(status);
      if (phase === "completed") {
        const done = finalizeText(status);
        if (done.mismatch) {
          // 이미 보낸 델타는 회수할 수 없다. 최종본을 답변인 척 덧붙여 본문을 오염시키지 않는다.
          return fail("browser-answer-rewritten",
            `ChatGPT 가 답변을 도중에 다시 써서 표시된 본문이 최종본과 다릅니다. 최종본: ${done.final}`);
        }
        return { status: "completed", owner, reason: "completed", emittedChars: deltas.emitted.length, pollCount, leaseReleased: false };
      }
      if (phase === "cancelled") {
        finalizeText(status); // 중단도 종료다 — 관측된 부분 응답을 확정해 남긴다.
        return { status: "stopped", owner, reason: "cancelled-by-host", emittedChars: deltas.emitted.length, pollCount, leaseReleased: false };
      }
      pushText(status);
      if (phase === "failed" || phase === "closed") {
        const detail = typeof status.error === "string" && status.error ? status.error : phase;
        return fail(detail, `ChatGPT 브라우저 턴이 실패했습니다: ${detail}`);
      }
    }
  }

  async function requestStop(why: string): Promise<void> {
    try {
      await deps.request(owner, "stop");
    } catch (error) {
      deps.log?.("warn", `browser stop 실패(${why}) owner=${owner}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function describeFailure(reason: string): string {
  switch (reason) {
    case "browser-capacity-reached":
      return "동시에 열 수 있는 ChatGPT 창 수를 넘었습니다. 다른 대화의 브라우저 턴이 끝난 뒤 다시 시도하세요.";
    case "browser-resubmission-blocked":
      return "같은 창에 이미 전송된 요청이 있습니다. 중복 전송은 차단됩니다.";
    case "browser-control-timeout-no-retry":
      return "브라우저 제어 응답이 없어 중단했습니다. 재시도는 자동으로 하지 않습니다.";
    case "browser-not-ready":
      return "ChatGPT 입력창이 준비되지 않았습니다. 로그인 상태를 확인한 뒤 다시 시도하세요.";
    case "browser-host-closed":
    case "browser-control-disconnected":
      return "브라우저 호스트가 종료되어 요청을 처리할 수 없습니다.";
    default:
      return `ChatGPT 브라우저 provider 오류: ${reason}`;
  }
}
