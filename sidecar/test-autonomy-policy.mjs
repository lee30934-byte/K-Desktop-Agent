// v0.7.54 — 자율 진행 원칙 회귀 테스트 (2026-10-29 K 확정: "내 선택이 굳이 필요한 부분이 아니라면 계속 진행").
// 원인 2곳(① "불확실하면 먼저 질문" ② self-nudge "자동 실행하지 말고 제안만")이 되살아나지 않는지,
// 그리고 새 원칙이 모든 엔진 경로가 공유하는 SYSTEM_PROMPT 에 들어 있는지 소스로 검증한다.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// v0.7.57 — CI(windows-latest, autocrlf) 체크아웃은 CRLF 라 줄 경계 정규식(\n}\n)이 로컬(LF)에서만 맞았다.
// 양쪽에서 같게 동작하도록 LF 로 정규화한다 (run 40876089719 실패 원인).
const src = readFileSync(join(here, "src", "index.ts"), "utf8").replace(/\r\n/g, "\n");
let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) fail++;
};

const m = /const SYSTEM_PROMPT = `([\s\S]*?)`;/.exec(src);
check("SYSTEM_PROMPT 추출", !!m);
const sp = m ? m[1] : "";
check("자율 진행 원칙 포함", sp.includes("[자율 진행 원칙"));
check("끝까지 이어서 진행 문구", sp.includes("끝까지 이어서 진행"));
for (const k of ["전원 조작", "되돌리기 어려운", "태그 push", "실자금", "사람 눈", "모순"]) {
  check(`질문 허용 6가지 중 '${k}'`, sp.includes(k));
}
check("옛 '불확실하면 먼저 질문합니다' 제거", !sp.includes("불확실하면 먼저 질문합니다"));
check("파괴 작업 사전 확인 규칙은 유지", sp.includes("dry_run"));

const nudge = /\[턴경계 self-nudge[\s\S]*?\]\.join\("\\n"\)/.exec(src);
check("nudge 블록 추출", !!nudge);
const nb = nudge ? nudge[0] : "";
check("nudge: 이어서 실행", nb.includes("이어서 실행"));
check("nudge: 옛 '자동 실행하지는 말고, 제안만' 제거", !nb.includes("자동 실행하지는 말고, 제안만"));
check("nudge: 새 작업 자가 시작 금지 유지", nb.includes("새 작업을 스스로 시작하지는 않습니다"));

const rest = /const SYSTEM_PROMPT_REST = `([\s\S]*?)`;/.exec(src);
check("REST 프롬프트에도 자율 진행 원칙", !!rest && rest[1].includes("[자율 진행 원칙]"));

// 모든 엔진 경로가 같은 SYSTEM_PROMPT 를 쓰는지 (Claude CLI / 공용 빌더)
check("Claude CLI 경로가 SYSTEM_PROMPT 사용", /SYSTEM_PROMPT \+ soulBlock \+ folderInstructionBlock/.test(src));
check("공용 빌더(Codex 등)가 SYSTEM_PROMPT 사용", /return SYSTEM_PROMPT \+ soulBlock \+ folderBlock/.test(src));

// 엔진별 경로 전수 — 어떤 모델/엔진이든 원칙을 받는지
const body = (fn) => {
  const s = src.indexOf(`async function ${fn}(`);
  if (s < 0) return "";
  const e = src.indexOf("\nasync function ", s + 10);
  return src.slice(s, e < 0 ? undefined : e);
};
check("Codex CLI 가 buildEngineSystemText 사용", /buildEngineSystemText\(/.test(body("handleViaCodexCLI")));
check("Gemini CLI 가 buildEngineSystemText 사용", /buildEngineSystemText\(/.test(body("handleViaGeminiCLI")));
check("buildEngineSystemText 가 SYSTEM_PROMPT 로 시작", /function buildEngineSystemText\([\s\S]*?return SYSTEM_PROMPT \+/.test(src));
check("REST API 가 SYSTEM_PROMPT_REST 사용", /SYSTEM_PROMPT_REST \+/.test(body("handleViaRestAPI")));
check("ChatGPT 웹(BrowserHost)이 원칙 머리말 적용", /content: withAutonomyPreface\(msg\.content\)/.test(body("handleViaBrowserHost")));
const pre = /const AUTONOMY_POLICY_PREFACE = \[([\s\S]*?)\]\.join/.exec(src);
check("머리말에 질문 허용 범위 포함", !!pre && pre[1].includes("실자금") && pre[1].includes("되돌리기 어려운"));
// 새 엔진이 추가됐는데 이 검사 목록에 없으면 실패 — 조용한 누락 방지
const handlers = [...src.matchAll(/^async function (handleVia\w+)\(/gm)].map((m) => m[1]).sort();
const covered = ["handleViaBrowserHost", "handleViaClaudeCLI", "handleViaCodexCLI", "handleViaGeminiCLI", "handleViaRestAPI"];
check(`엔진 핸들러 전수 커버 (발견: ${handlers.join(",")})`, JSON.stringify(handlers) === JSON.stringify(covered));

// v0.7.57 — "기록할까요?" 질문 제거 (2026-10-29 K 승인). 실패 포착 블록이 묻지 않고 기록하도록.
const fc = /\[실패 자동 포착[\s\S]*?\]\.join\("\\n"\)[\s\S]*?\]\.join\("\\n"\)/.exec(src);
check("실패 포착 블록 추출", !!fc);
const fcb = fc ? fc[0] : "";
check("실패 포착: 옛 '기록할까요? 라고 제안' 제거", !fcb.includes("라고 제안하세요"));
check("실패 포착: 옛 '자동 기록 금지' 제거", !fcb.includes("자동 기록 금지"));
check("실패 포착: 묻지 말고 바로 기록", fcb.includes("묻지 말고 바로 기록"));
check("실패 포착: 덮어쓰기는 하지 않음 유지", fcb.includes("덮어쓰기는 하지 않습니다"));
check("실패 포착: memoryWrite OFF 분기", fcb.includes("flags.memoryWrite") || /flags\.memoryWrite\s*\?/.test(src));

// v0.7.57 — 상시 승인 규칙이 모든 엔진 공용 가이던스에 주입되는지
const fg = /function buildAgentFeatureGuidance\([\s\S]*?\n}\n/.exec(src);
check("buildAgentFeatureGuidance 가 상시 승인 규칙 주입", !!fg && fg[0].includes("buildStandingApprovalsBlock()"));
const sa = /function buildStandingApprovalsBlock\([\s\S]*?\n}\n/.exec(src);
check("상시 승인: 파일 없으면 빈 문자열", !!sa && /if \(!existsSync\(p\)\) return "";/.test(sa[0]));
check("상시 승인: 크기 상한", !!sa && sa[0].includes("STANDING_APPROVALS_MAX"));
check("상시 승인: 범위 밖이면 종전대로 확인", !!sa && sa[0].includes("범위를 벗어나면 종전대로"));
for (const fn of ["handleViaClaudeCLI", "handleViaRestAPI"]) {
  check(`${fn} 가 buildAgentFeatureGuidance 사용`, /buildAgentFeatureGuidance\(/.test(body(fn)));
}
check("Codex/Gemini 공용 빌더가 buildAgentFeatureGuidance 사용", /function buildEngineSystemText\([\s\S]*?buildAgentFeatureGuidance\(agentFlags\)/.test(src));

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
