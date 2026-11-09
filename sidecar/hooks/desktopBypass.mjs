/**
 * 셸 명령으로 화면·입력을 직접 조작하는 우회 시도 감지 (2026-11-09).
 *
 * 화면 입력은 k-personal 도구(ui_* / cc_* / web_*)를 거쳐야 입력 잠금·대상 창 확인·실패 신호가 적용된다.
 * 셸에서 SendKeys / user32 입력 API / pyautogui / UIAutomation 을 직접 쓰면 이 장치를 모두 건너뛴다.
 *
 * 한계: 패턴 기반이라 완전하지 않다(-EncodedCommand, 미리 만든 스크립트 파일, 컴파일된 exe 등은 못 본다).
 * 검색·열람 명령(grep, rg, git, cat ...)은 코드 안의 단어를 찾는 경우가 많아 제외한다.
 */

const RULES = [
  { id: "sendkeys", re: /\bSendKeys\b|SendWait\s*\(/i, label: "SendKeys 키 입력" },
  { id: "user32-input", re: /\b(SendInput|keybd_event|mouse_event|SetCursorPos)\b/i, label: "user32 입력 API" },
  { id: "py-input", re: /\b(pyautogui|pynput|pydirectinput)\b/i, label: "Python 입력 자동화 라이브러리" },
  { id: "ahk-nircmd", re: /\b(autohotkey|nircmd)\b|\.ahk\b/i, label: "AutoHotkey/nircmd" },
  { id: "uia-direct", re: /UIAutomationClient|System\.Windows\.Automation\b/i, label: "셸에서 UI Automation 직접 사용" },
];

const READ_ONLY_FIRST = new Set([
  "grep", "rg", "git", "findstr", "select-string", "sls", "cat", "type", "head", "tail",
  "sed", "awk", "less", "more", "ls", "dir", "find", "wc", "diff",
]);

function firstToken(command) {
  const m = String(command).trim().match(/^(?:cd\s+\S+\s*(?:&&|;)\s*)?["']?([^\s"'|;&]+)/i);
  if (!m) return "";
  const base = m[1].replace(/\\/g, "/").split("/").pop().toLowerCase();
  return base.replace(/\.(exe|cmd|bat)$/, "");
}

/** @returns {{ id: string, label: string } | null} */
export function detectDesktopBypass(command) {
  if (typeof command !== "string" || !command.trim()) return null;
  if (READ_ONLY_FIRST.has(firstToken(command))) return null;
  for (const rule of RULES) {
    if (rule.re.test(command)) return { id: rule.id, label: rule.label };
  }
  return null;
}

export const DESKTOP_BYPASS_REMEDY =
  "화면·키보드·마우스 조작은 k-personal 도구를 쓰세요: 컨트롤 조작은 ui_click_by_name / ui_set_text / ui_invoke, " +
  "웹은 web_*, 직접 입력이 꼭 필요하면 cc_keyboard_type / cc_mouse_click (target_window 지정). " +
  "이 도구들은 입력 잠금·대상 창 확인·실패 신호를 적용합니다.";
