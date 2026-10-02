import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "src/codexAutoModel.ts"), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { chooseCodexAutoModel, shouldAutoSelectCodexModel } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

let passed = 0;
function check(name, actual, expected) {
  if (actual !== expected) throw new Error(`${name}: ${actual} != ${expected}`);
  passed++;
}

check("짧은 인사", chooseCodexAutoModel("안녕").model, "gpt-6-luna");
check("짧은 인사 추론 강도", chooseCodexAutoModel("안녕").reasoningEffort, "low");
check("간단한 번역", chooseCodexAutoModel("번역: Good morning").model, "gpt-6-luna");
check("보안이 포함된 번역", chooseCodexAutoModel("번역: 보안 취약점 분석").model, "gpt-6-astra");
check("릴리스", chooseCodexAutoModel("KDA 릴리스 빌드와 검증 진행").model, "gpt-6-astra");
check("릴리스 추론 강도", chooseCodexAutoModel("KDA 릴리스 빌드와 검증 진행").reasoningEffort, "high");
check("일반 작업", chooseCodexAutoModel("현재 버그 재현 절차를 조사해줘").model, "gpt-6-sol");
check("긴 맥락", chooseCodexAutoModel("요약 " + "가".repeat(1300)).model, "gpt-6-sol");
check("빈 요청", chooseCodexAutoModel("").model, "gpt-6-sol");
check("자동 모드", shouldAutoSelectCodexModel("auto", "gpt-6-sol"), true);
check("수동 모드", shouldAutoSelectCodexModel("manual", "gpt-6-sol"), false);
check("수동 모드에서 이전 auto 값 무시", shouldAutoSelectCodexModel("manual", "auto"), false);
check("구버전 auto 값 유지", shouldAutoSelectCodexModel(null, "auto"), true);

const app = readFileSync(path.join(root, "src/App.tsx"), "utf8");
const settings = readFileSync(path.join(root, "src/components/Settings.tsx"), "utf8");
check("자동/수동 모드 메뉴", settings.includes('aria-label="Codex 모델 선택 방식"') && settings.includes('<option value="manual">'), true);
check("모드 영속 저장", settings.includes('localStorage.setItem(LS_CODEX_MODEL_MODE, mode)'), true);
check("선택한 방식 적용", app.includes('shouldAutoSelectCodexModel('), true);
check("선택한 모델을 전송", app.includes("const model = autoChoice?.model ?? (resolved.model === \"auto\" ? undefined : resolved.model)"), true);
check("자동 모드에서 수동 추론 강도 무시", app.includes("reasoningEffort: autoChoice?.reasoningEffort ?? loadReasoningEffort()"), true);
check("직접 입력을 분류", app.includes("buildSendSettings(targetId ?? undefined, text)"), true);
check("텔레그램 입력을 분류", app.includes("buildSendSettings(convId, text)"), true);
check("예약 입력을 분류", app.includes('buildSendSettings(convId, `${row.title}'), true);
check("작업감시 입력을 분류", app.includes('buildSendSettings(convId, `${w.title}'), true);
check("재시도 입력을 분류", app.includes("buildSendSettings(convId, userMessage.content)"), true);
console.log(`Codex auto model: ${passed}/${passed} PASS`);
