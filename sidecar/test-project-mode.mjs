// Phase 138 (v0.7.10) — #3 대화별 프로젝트 모드 정적 회귀 테스트.
//
// 검증 대상: 폴더(프로젝트)에 부여된 projectProfile 이 agent-flags 의 projectMode 게이트
// 하에서 (1) 도구 게이트(금지 도구) (2) 메모리 스코프 필터 (3) 시스템 텍스트 블록
// 으로 흐르는지, 그리고 frontend(db/App)/Rust 까지 배선이 연결됐는지 소스 레벨로 확인.
// 핵심 불변식: projectMode OFF (또는 profile 부재) 면 종전 동작 100% 유지 (zero-regression).
// 실행: node test-project-mode.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const src = readFileSync(path.join(__dirname, "src", "index.ts"), "utf-8");
const db = readFileSync(path.join(root, "src", "db.ts"), "utf-8");
const app = readFileSync(path.join(root, "src", "App.tsx"), "utf-8");
const lib = readFileSync(path.join(root, "src-tauri", "src", "lib.rs"), "utf-8");
const dialog = readFileSync(
  path.join(root, "src", "components", "FolderInstructionsDialog.tsx"),
  "utf-8",
);
const settings = readFileSync(path.join(root, "src", "components", "Settings.tsx"), "utf-8");

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
}

console.log("Phase 138 — #3 프로젝트 모드 회귀 테스트\n");

// ── 1. agent-flags 게이트 ────────────────────────────────────────────────
console.log("[1] agent-flags projectMode 게이트");
check("AgentFlags 인터페이스에 projectMode", /interface AgentFlags \{[\s\S]*?projectMode: boolean;[\s\S]*?\}/.test(src));
check("AGENT_FLAGS_DEFAULT 에 projectMode: false (기본 OFF)",
  /AGENT_FLAGS_DEFAULT: AgentFlags = \{[\s\S]*?projectMode: false,[\s\S]*?\}/.test(src));
check("FLAG_GATED_TOOLS 에 projectMode: [] (정적 게이트 없음 — 동적 결정)",
  /projectMode: \[\],/.test(src));

// ── 2. ProjectProfile 타입 + UserMessage 배선 ───────────────────────────
console.log("\n[2] ProjectProfile 타입 / UserMessage");
check("sidecar ProjectProfile 인터페이스", /interface ProjectProfile \{[\s\S]*?forbiddenTools\?: string\[\];[\s\S]*?memoryTags\?: string\[\];[\s\S]*?\}/.test(src));
check("UserMessage 에 projectProfile?", /projectProfile\?: ProjectProfile;/.test(src));

// ── 3. 금지 도구 게이트 ──────────────────────────────────────────────────
console.log("\n[3] 프로젝트 금지 도구 → disallowed 병합");
check("resolveProjectForbidden 헬퍼 (projectMode OFF 면 빈 배열)",
  /function resolveProjectForbidden\([\s\S]*?if \(!flags\.projectMode[\s\S]*?return \[\];/.test(src));
check("buildToolFlags 가 projectForbiddenTools param 받음",
  /function buildToolFlags\([\s\S]*?projectForbiddenTools\?: string\[\],\s*\): ToolFlags/.test(src));
check("buildToolFlags 가 projectForbiddenTools 를 disallowed 로 push",
  /if \(projectForbiddenTools && Array\.isArray\(projectForbiddenTools\)\) \{[\s\S]*?disallowed\.push\(t\.trim\(\)\);/.test(src));
check("Claude 경로가 projectForbidden 전달",
  /buildToolFlags\(\s*msg\.permissions,\s*msg\.lockedTools,\s*msg\.safeMode \?\? "off",\s*projectForbidden,\s*\)/.test(src));
check("REST 경로가 restProjectForbidden 전달",
  /buildToolFlags\(\s*msg\.permissions,\s*msg\.lockedTools,\s*msg\.safeMode \?\? "off",\s*restProjectForbidden,\s*\)/.test(src));

// ── 4. 시스템 텍스트 블록 ────────────────────────────────────────────────
console.log("\n[4] 프로젝트 모드 시스템 텍스트 블록");
check("buildProjectProfileBlock 헬퍼 (OFF 면 빈 문자열)",
  /function buildProjectProfileBlock\([\s\S]*?if \(!flags\.projectMode \|\| !profile\) return "";/.test(src));
check("블록 헤더 [프로젝트 모드]", /\[프로젝트 모드\]/.test(src));
check("buildEngineSystemText 가 opts.projectProfile 받음", /opts\?: \{ compact\?: boolean; projectProfile\?: ProjectProfile \}/.test(src));
check("Codex 가 projectProfile 전달", /compact: !!effectiveAgentId,\s*projectProfile: msg\.projectProfile,/.test(src));
check("Gemini CLI 가 projectProfile 전달", /buildEngineSystemText\(msg\.folderSystemPrompt, geminiAgentFlags, \{\s*projectProfile: msg\.projectProfile,/.test(src));

// ── 5. 메모리 스코프 필터 ────────────────────────────────────────────────
console.log("\n[5] 메모리 스코프 필터 (memoryTags)");
check("MemoryFileMeta 에 projects: string[]", /interface MemoryFileMeta \{[\s\S]*?projects: string\[\];[\s\S]*?\}/.test(src));
check("parseMemoryFrontmatter 가 projects 파싱", /projects: extractYamlList\(block, "projects"\)/.test(src));
check("loadMemoryContext 가 projectMemoryTags param 받음", /function loadMemoryContext\([\s\S]*?projectMemoryTags\?: string\[\],\s*\): MemoryContext/.test(src));
check("교집합 없는 타 프로젝트 메모리 본문 생략 (stub)",
  /activeTags\.length > 0 &&[\s\S]*?meta\.projects\.length > 0 &&[\s\S]*?!meta\.projects\.some\(\(p\) => activeTags\.includes\(p\)\)/.test(src));
check("isCore/공용 메모리는 필터 면제 (항상 로딩)",
  /activeTags\.length > 0 &&\s*!isCore &&\s*meta\.projects\.length > 0/.test(src));

// ── 6. zero-regression 불변식 ────────────────────────────────────────────
console.log("\n[6] zero-regression (projectMode OFF = 종전 동작)");
check("resolveProjectMemoryTags OFF 가드", /function resolveProjectMemoryTags\([\s\S]*?if \(!flags\.projectMode[\s\S]*?return \[\];/.test(src));
// activeTags 비면 메모리 필터 자체가 동작 안 함 (length>0 조건). buildProjectProfileBlock 도 OFF 면 "".
check("메모리 필터는 activeTags 비면 미적용", /activeTags\.length > 0 &&/.test(src));

// ── 7. frontend DB 배선 ──────────────────────────────────────────────────
console.log("\n[7] db.ts 프로젝트 프로필 영속");
check("project_profile_json 마이그레이션 컬럼", /ALTER TABLE folders ADD COLUMN project_profile_json TEXT/.test(db));
check("DBFolder 에 project_profile_json", /project_profile_json: string \| null;/.test(db));
check("ProjectProfile export 인터페이스", /export interface ProjectProfile \{/.test(db));
check("FolderRecord 에 projectProfile", /projectProfile: ProjectProfile \| null;/.test(db));
check("parseProjectProfile 방어적 파서", /function parseProjectProfile\(/.test(db));
check("rowToFolder 가 projectProfile 매핑", /projectProfile: parseProjectProfile\(row\.project_profile_json\)/.test(db));
check("updateFolderProjectProfile 갱신 함수", /export async function updateFolderProjectProfile\(/.test(db));

// ── 8. App.tsx + Rust 플러밍 ─────────────────────────────────────────────
console.log("\n[8] App.tsx → Rust 플러밍");
check("App 이 folder.projectProfile 읽음", /projectProfile = folder\.projectProfile;/.test(app));
check("App send_message 가 projectProfile 전달", /folderAttachmentPaths,\s*projectProfile,/.test(app));
check("App 저장 핸들러가 updateFolderProjectProfile 호출", /await updateFolderProjectProfile\(folderId, projectProfile\)/.test(app));
check("Rust send_message 가 project_profile 파라미터", /project_profile: Option<serde_json::Value>,/.test(lib));
check("Rust 가 projectProfile 키로 payload 박음", /payload\["projectProfile"\] = profile;/.test(lib));
check("Rust AGENT_FLAG_KEYS 에 projectMode", /const AGENT_FLAG_KEYS: \[&str; 6\] = \[[\s\S]*?"projectMode",[\s\S]*?\]/.test(lib));

// ── 9. UI ────────────────────────────────────────────────────────────────
console.log("\n[9] UI (Dialog + Settings 토글)");
check("Dialog onSave 가 projectProfile 3번째 인자", /projectProfile: ProjectProfile \| null,\s*\) => Promise/.test(dialog));
check("Dialog 에 프로젝트 모드 프로필 섹션", /프로젝트 모드 프로필 \(#3\)/.test(dialog));
check("Dialog 가 금지 도구/메모리 태그 입력", /금지 도구/.test(dialog) && /메모리 범위 태그/.test(dialog));
check("Settings agentFlags state 에 projectMode", /skillRegistry: false,\s*projectMode: false,/.test(settings));
check("Settings get_agent_flags 로드에 projectMode", /skillRegistry: !!f\?\.skillRegistry,\s*projectMode: !!f\?\.projectMode,/.test(settings));
check("Settings 토글 카드 projectMode", /key: "projectMode",/.test(settings));

console.log(`\n결과: ${pass}/${pass + fail} 통과`);
process.exit(fail > 0 ? 1 : 0);
