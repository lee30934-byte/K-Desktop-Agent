/**
 * 셸 명령으로 화면·입력을 직접 조작하는 우회 시도 감지 (2026-11-09).
 *
 * 화면 입력은 k-personal 도구(ui_* / cc_* / web_*)를 거쳐야 입력 잠금·대상 창 확인·실패 신호가 적용된다.
 * 셸에서 SendKeys / user32 입력 API / pyautogui / UIAutomation 을 직접 쓰면 이 장치를 모두 건너뛴다.
 *
 * 한계: 패턴 기반이라 완전하지 않다(-EncodedCommand, 미리 만든 스크립트 파일, 컴파일된 exe 등은 못 본다).
 *
 * v0.7.83: 명령을 따옴표 밖의 구분자(&& || ; | & 줄바꿈)로 나눠 "구간"별로 판단한다.
 *   - 구간의 첫 명령이 검색·열람 명령(grep, rg, git, Select-String ...)이면 그 구간의 검색어는 검사하지 않는다.
 *     (v0.7.82 는 명령 전체의 첫 단어만 봐서 `cd x && for ...; do grep "SendKeys" ...` 같은 검색을 차단했다)
 *   - 단, 검색 구간 안에 명령 치환($(...), <(...), 백틱 2개 이상)이 있으면 검사한다.
 *   - `powershell -Command "..."`, `bash -c "..."` 같은 감싼 명령은 안쪽 명령을 다시 구간별로 판단한다.
 */

const RULES = [
  { id: "sendkeys", re: /\bSendKeys\b|SendWait\s*\(/i, label: "SendKeys 키 입력" },
  { id: "user32-input", re: /\b(SendInput|keybd_event|mouse_event|SetCursorPos)\b/i, label: "user32 입력 API" },
  { id: "py-input", re: /\b(pyautogui|pynput|pydirectinput)\b/i, label: "Python 입력 자동화 라이브러리" },
  { id: "ahk-nircmd", re: /\b(autohotkey|nircmd)\b|\.ahk\b/i, label: "AutoHotkey/nircmd" },
  { id: "uia-direct", re: /UIAutomationClient|System\.Windows\.Automation\b/i, label: "셸에서 UI Automation 직접 사용" },
];

const READ_ONLY = new Set([
  "grep", "egrep", "fgrep", "rg", "git", "findstr", "select-string", "sls", "cat", "type", "head", "tail",
  "sed", "awk", "less", "more", "ls", "dir", "find", "wc", "diff",
]);

const SHELL_WRAPPERS = new Set(["powershell", "pwsh", "bash", "sh", "cmd"]);
const LEADING_KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "time", "!", "&", "(", "{", "exec"]);
const MAX_DEPTH = 3;

/** 따옴표 밖의 구분자로 명령을 구간으로 나눈다. */
function splitSegments(command) {
  const segs = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"' && i + 1 < command.length) { cur += command[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "\n" || ch === "\r" || ch === ";" || ch === "|" || ch === "&") {
      // `2>&1`, `>&2` 같은 리다이렉션의 & 는 구분자가 아니다.
      if (ch === "&" && /[<>]$/.test(cur)) { cur += ch; continue; }
      if (cur.trim()) segs.push(cur.trim());
      cur = "";
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) i++;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) segs.push(cur.trim());
  return segs;
}

/** 공백 기준 토큰화(따옴표 유지). */
function tokenize(segment) {
  const toks = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"' && i + 1 < segment.length) { cur += segment[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (/\s/.test(ch)) { if (cur) toks.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) toks.push(cur);
  return toks;
}

function unquote(tok) {
  if (tok.length >= 2 && (tok[0] === '"' || tok[0] === "'") && tok[tok.length - 1] === tok[0]) return tok.slice(1, -1);
  return tok;
}

function commandName(tok) {
  const base = unquote(tok).replace(/\\/g, "/").split("/").pop().toLowerCase();
  return base.replace(/\.(exe|cmd|bat)$/, "");
}

/** 구간의 실제 명령 위치(키워드·환경변수 대입·여는 괄호를 건너뜀). */
function commandTokens(segment) {
  let toks = tokenize(segment);
  while (toks.length) {
    let t = toks[0];
    if (/^[({]+./.test(t)) { toks = [t.replace(/^[({]+/, ""), ...toks.slice(1)]; continue; }
    if (LEADING_KEYWORDS.has(t.toLowerCase()) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { toks = toks.slice(1); continue; }
    break;
  }
  return toks;
}

function hasSubstitution(segment) {
  return segment.includes("$(") || segment.includes("<(") || (segment.match(/`/g) ?? []).length >= 2;
}

function matchRules(text) {
  for (const rule of RULES) {
    if (rule.re.test(text)) return { id: rule.id, label: rule.label };
  }
  return null;
}

function analyze(command, depth) {
  for (const seg of splitSegments(command)) {
    const toks = commandTokens(seg);
    if (!toks.length) continue;
    const name = commandName(toks[0]);

    // powershell -Command "..." / bash -c "..." / cmd /c "..." → 안쪽 명령을 다시 판단
    if (SHELL_WRAPPERS.has(name) && depth < MAX_DEPTH) {
      const idx = toks.findIndex((t, i) => i > 0 && /^(-c|-lc|-command|\/c)$/i.test(t));
      if (idx > 0 && idx + 1 < toks.length) {
        const inner = toks.slice(idx + 1).map(unquote).join(" ");
        const before = toks.slice(0, idx + 1).join(" ");
        const hit = matchRules(before) ?? analyze(inner, depth + 1);
        if (hit) return hit;
        continue;
      }
    }

    if (READ_ONLY.has(name) && !hasSubstitution(seg)) continue;
    const hit = matchRules(seg);
    if (hit) return hit;
  }
  return null;
}

/** @returns {{ id: string, label: string } | null} */
export function detectDesktopBypass(command) {
  if (typeof command !== "string" || !command.trim()) return null;
  try {
    return analyze(command, 0);
  } catch {
    // 파서 오류 시 보수적으로 전체 문자열 검사
    return matchRules(command);
  }
}

export const DESKTOP_BYPASS_REMEDY =
  "화면·키보드·마우스 조작은 k-personal 도구를 쓰세요: 컨트롤 조작은 ui_click_by_name / ui_set_text / ui_invoke, " +
  "웹은 web_*, 직접 입력이 꼭 필요하면 cc_keyboard_type / cc_mouse_click (target_window 지정). " +
  "이 도구들은 입력 잠금·대상 창 확인·실패 신호를 적용합니다.";
