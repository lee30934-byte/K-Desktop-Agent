/**
 * Phase 73 (v0.6.16) — logger 의 isDev gate 제거 + sidecar.log echo.
 *
 * 이전 동작 (~v0.6.15): log/warn/debug 모두 `if (isDev)` 가드 → prod build 에선 silent.
 * 함정: Phase 44 의 SidePanel 등 곳곳에 박힌 `logger.log("[SidePanel] ...")` 같은
 * 진단 로그가 K 의 prod 환경에선 한 줄도 안 박혀서 "preview 빈 화면" 같은 증상의
 * 원인을 영원히 못 좁혔음. error 만 항상 출력이라 진단 불가 함정.
 *
 * 새 동작: 모든 레벨 항상 console 출력 (KDA 는 K 의 개인 도구라 noisy 무관).
 * 추가: log/warn/error 는 sidecar.log 에도 echo (frontend_log Tauri command).
 * - 옛 binary (frontend_log 없음) 면 .catch(() => {}) 로 silent swallow.
 * - debug 는 console 만 (sidecar.log 노이즈 방지).
 *
 * 이걸로 K 의 DevTools 안 열어도 sidecar.log 에서 grep 으로 진단 가능.
 */

// frontend_log 가 dynamic-loaded — import cycle 위험 회피.
type InvokeFn = typeof import("@tauri-apps/api/core").invoke;
let _invokeFn: InvokeFn | null = null;
async function _ensureInvoke(): Promise<InvokeFn | null> {
  if (_invokeFn) return _invokeFn;
  try {
    const core = await import("@tauri-apps/api/core");
    _invokeFn = core.invoke;
    return _invokeFn;
  } catch {
    return null;
  }
}

function _echoToSidecar(level: "log" | "warn" | "error", args: unknown[]) {
  // 직렬화 — Error 객체는 별도 처리 (JSON.stringify 가 {} 로 만드는 함정 회피).
  const msg = args
    .map((x) => {
      if (x instanceof Error) return `[${x.name}: ${x.message}]${x.stack ? "\n" + x.stack : ""}`;
      if (typeof x === "object" && x !== null) {
        try {
          return JSON.stringify(x);
        } catch {
          return String(x);
        }
      }
      return String(x);
    })
    .join(" ");
  _ensureInvoke()
    .then((invoke) => {
      if (invoke) invoke("frontend_log", { message: `[${level}] ${msg}` }).catch(() => {});
    })
    .catch(() => {});
}

export const logger = {
  log: (...args: unknown[]) => {
    console.log(...args);
    _echoToSidecar("log", args);
  },
  warn: (...args: unknown[]) => {
    console.warn(...args);
    _echoToSidecar("warn", args);
  },
  error: (...args: unknown[]) => {
    console.error(...args);
    _echoToSidecar("error", args);
  },
  debug: (...args: unknown[]) => {
    // debug 만 sidecar.log echo 제외 (노이즈 회피). console 은 항상.
    console.debug(...args);
  },
};

export default logger;
