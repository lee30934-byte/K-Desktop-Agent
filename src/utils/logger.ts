/**
 * 개발 환경에서만 로그를 출력하는 유틸리티
 */

// Vite 환경 변수 - 프로덕션에서는 false
const isDev = (import.meta as unknown as { env: { DEV: boolean } }).env?.DEV ?? false;

export const logger = {
  log: (...args: unknown[]) => {
    if (isDev) console.log(...args);
  },
  warn: (...args: unknown[]) => {
    if (isDev) console.warn(...args);
  },
  error: (...args: unknown[]) => {
    // 에러는 항상 출력 (프로덕션에서도 디버깅 필요)
    console.error(...args);
  },
  debug: (...args: unknown[]) => {
    if (isDev) console.debug(...args);
  },
};

export default logger;
