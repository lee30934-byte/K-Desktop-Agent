#!/usr/bin/env node
/**
 * preToolUse-desktopGuard.mjs 회귀 테스트 (2026-11-09).
 *  - 셸로 화면/입력을 직접 조작하는 명령은 exit 2 (차단)
 *  - 검색/열람 명령, 일반 명령, 다른 도구, 가드 비활성은 exit 0 (통과)
 *  - 설치 묶음(tauri.conf.json)에 hooks 폴더가 포함되어야 설치본에서도 훅이 실행된다
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(__dirname, "hooks", "preToolUse-desktopGuard.mjs");
if (!existsSync(HOOK)) { console.error(`hook not found: ${HOOK}`); process.exit(1); }

function runHook(payload, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, stderr: r.stderr ?? "" };
}
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

const cases = [
  { name: "PowerShell SendKeys 차단", payload: bash(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('hi')"`), expectCode: 2, expectStderrContains: "SendKeys" },
  { name: "WScript.Shell SendKeys 차단", payload: bash(`powershell -c "(New-Object -ComObject WScript.Shell).SendKeys('x')"`), expectCode: 2 },
  { name: "user32 SetCursorPos 차단", payload: bash(`powershell -c "Add-Type '[DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int x,int y);'"`), expectCode: 2, expectStderrContains: "user32" },
  { name: "python pyautogui 차단", payload: bash(`py -c "import pyautogui; pyautogui.click(10,10)"`), expectCode: 2, expectStderrContains: "Python" },
  { name: "셸 UIAutomationClient 직접 사용 차단 (11/06 Codex 우회 재현)", payload: bash(`powershell -Command 'Add-Type -AssemblyName UIAutomationClient; [System.Windows.Automation.AutomationElement]::RootElement'`), expectCode: 2, expectStderrContains: "UI Automation" },
  { name: "AutoHotkey 실행 차단", payload: bash(`AutoHotkey.exe click.ahk`), expectCode: 2 },
  { name: "PowerShell 도구 이름도 검사", payload: { tool_name: "PowerShell", tool_input: { command: "[System.Windows.Forms.SendKeys]::SendWait('a')" } }, expectCode: 2 },
  { name: "rg 로 코드 검색은 통과", payload: bash(`rg -n "pyautogui|SendKeys" modules`), expectCode: 0 },
  { name: "git grep 은 통과", payload: bash(`git grep -n SetCursorPos`), expectCode: 0 },
  { name: "cd 후 grep 도 통과", payload: bash(`cd /c/x && grep -n pyautogui modules/computer_control.py`), expectCode: 0 },
  { name: "일반 테스트 실행은 통과", payload: bash(`py test_uia_actions.py`), expectCode: 0 },
  { name: "다른 도구(Read)는 무관", payload: { tool_name: "Read", tool_input: { file_path: "pyautogui.py" } }, expectCode: 0 },
  { name: "KDA_DESKTOP_GUARD=0 이면 비활성", payload: bash(`py -c "import pyautogui"`), env: { KDA_DESKTOP_GUARD: "0" }, expectCode: 0 },
  { name: "깨진 입력은 통과(fail-open)", payload: "not json", expectCode: 0 },
];

let passed = 0;
let failed = 0;
for (const c of cases) {
  const { code, stderr } = typeof c.payload === "string"
    ? (() => { const r = spawnSync(process.execPath, [HOOK], { input: c.payload, encoding: "utf8" }); return { code: r.status, stderr: r.stderr ?? "" }; })()
    : runHook(c.payload, c.env);
  const ok = code === c.expectCode && (!c.expectStderrContains || stderr.includes(c.expectStderrContains));
  if (ok) { console.log(`✓ ${c.name}  (exit=${code})`); passed++; }
  else { console.log(`✗ ${c.name}\n  expected exit=${c.expectCode} actual exit=${code} stderr=${JSON.stringify(stderr.slice(0, 200))}`); failed++; }
}

const conf = JSON.parse(readFileSync(path.resolve(__dirname, "..", "src-tauri", "tauri.conf.json"), "utf8"));
const resources = JSON.stringify(conf.bundle?.resources ?? conf);
const bundled = resources.includes("../sidecar/hooks/**/*");
if (bundled) { console.log("✓ 설치 묶음에 sidecar/hooks 포함"); passed++; }
else { console.log("✗ 설치 묶음에 sidecar/hooks 없음 — 설치본에서 훅이 실행되지 않음"); failed++; }

const src = readFileSync(path.resolve(__dirname, "src", "index.ts"), "utf8");
const wired = src.includes('"preToolUse-desktopGuard.mjs"') && src.includes('command: `node "${desktopGuardPath}"`') && src.includes("reportCodexDesktopBypass(msg, it.command ?? it.text)");
if (wired) { console.log("✓ Claude 훅 등록 + Codex 감지 연결"); passed++; }
else { console.log("✗ Claude 훅 등록 또는 Codex 감지 연결 누락"); failed++; }

console.log(`\n결과: ${passed} passed, ${failed} failed (총 ${cases.length + 2})`);
process.exit(failed === 0 ? 0 : 1);
