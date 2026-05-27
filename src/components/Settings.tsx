import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import CornerBrackets from "./CornerBrackets";
import type { WatchedFolder } from "../types";
// Phase 84 (v0.6.27) — Connector/Tool Safety Layer (Lee #6)
import {
  RISK_BADGES,
  CATEGORY_RISK,
  SAFE_MODE_POLICIES,
  STRICT_BLOCKED_TOOLS,
  riskOfCategory,
  previewSafeModeImpact,
  type SafeMode,
  type RiskLevel,
} from "../utils/toolSafety";
// Phase 91 (v0.6.33) — SafeMode 자동 전환 스케줄
import {
  loadSchedule,
  saveSchedule,
  formatDays,
  formatHourRange,
  newRule,
  DAYS_LIST,
  type SafeModeRule,
  type DayOfWeek,
} from "../utils/safeModeSchedule";

interface SettingsProps {
  open: boolean;
  onClose: () => void;
  mcpConnected: boolean;
}

// API 제공자 타입
interface APIProvider {
  id: string;
  name: string;
  icon: string;
  keyName: string;
  placeholder: string;
  docsUrl: string;
  // 이 provider 는 별도 API 키 없이 동작 (예: Claude Max 구독 OAuth)
  noKeyRequired?: boolean;
  // 모델 ID 후보 — sidecar 의 model 인자로 그대로 전달
  models: { id: string; label: string }[];
  // 비고
  note?: string;
}

// 에이전트 권한 타입
type PermissionLevel = "auto" | "ask" | "manual";

interface AgentPermission {
  id: string;
  name: string;
  description: string;
  icon: string;
  level: PermissionLevel;
  category: "file" | "system" | "network" | "input";
}

// UI 테마 타입
interface Theme {
  id: string;
  name: string;
  preview: string; // 색상 코드
  accent: string;
  background: string;
}

// 안전장치 — 백업 메타데이터 (Tauri command get_latest_backup / list_backups 의 응답 형식과 동일)
interface BackupFile {
  name: string;
  size: number;
  sha256: string | null;
  src: string;
  missing?: boolean;
}
interface BackupInfo {
  timestamp: string;
  label: string;
  createdBy: string;
  files: BackupFile[];
  total_size?: number;
  dir_path?: string;
}

const API_PROVIDERS: APIProvider[] = [
  {
    id: "claude",
    name: "Claude Code (Max OAuth)",
    icon: "💠",
    keyName: "(none)",
    placeholder: "Max 구독 OAuth — claude login",
    docsUrl: "https://docs.claude.com/en/docs/claude-code/quickstart",
    noKeyRequired: true,
    note: "Max 구독을 Claude Code CLI 로 인증해 사용 — K-Personal MCP 도구 (스크린샷·마우스·키보드·앱 실행 등) 풀 사용 가능. API 키 불필요. 아래 [claude login] 버튼으로 터미널에서 OAuth 진행.",
    models: [
      { id: "default", label: "Max 기본 모델 (Opus 5.7 / 1M ctx)" },
    ],
  },
  {
    id: "anthropic",
    name: "Claude API (직접)",
    icon: "🤖",
    keyName: "ANTHROPIC_API_KEY",
    placeholder: "sk-ant-api...",
    docsUrl: "https://console.anthropic.com/",
    note: "Anthropic 콘솔에서 발급받은 API 키로 REST 직접 호출. Max 구독과는 별도 결제. 텍스트 전용 — MCP 도구 미지원.",
    models: [
      { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5 (권장)" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (저렴/빠름)" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI (GPT)",
    icon: "🧠",
    keyName: "OPENAI_API_KEY",
    placeholder: "sk-proj-...",
    docsUrl: "https://platform.openai.com/api-keys",
    note: "ChatGPT Plus/Pro 구독으로는 API 사용 불가 — platform.openai.com 에서 별도 API 키 발급 + 결제 필요. 텍스트 전용 (MCP 도구 미지원).",
    models: [
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4o-mini", label: "GPT-4o mini (저렴/빠름)" },
      { id: "gpt-4-turbo", label: "GPT-4 Turbo" },
      { id: "o1-mini", label: "o1-mini (추론)" },
      { id: "o3-mini", label: "o3-mini (최신 추론)" },
    ],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    icon: "🔮",
    keyName: "GOOGLE_API_KEY",
    placeholder: "AIza...",
    docsUrl: "https://aistudio.google.com/apikey",
    note: "Gemini Advanced 구독으로는 API 사용 불가 — AI Studio (aistudio.google.com) 에서 별도 API 키 발급 필요. 텍스트 전용 (MCP 도구 미지원).",
    models: [
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash (권장)" },
      { id: "gemini-2.0-flash-thinking-exp", label: "Gemini 2.0 Flash Thinking" },
      { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
      { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    icon: "🌐",
    keyName: "OPENROUTER_API_KEY",
    placeholder: "sk-or-v1-...",
    docsUrl: "https://openrouter.ai/keys",
    note: "여러 모델을 한 키로 라우팅 (DeepSeek, Llama, Qwen 등).",
    models: [
      { id: "openai/gpt-4o-mini", label: "OpenAI GPT-4o mini" },
      { id: "anthropic/claude-sonnet-4.5", label: "Anthropic Claude Sonnet 4.5" },
      { id: "google/gemini-2.0-flash-exp:free", label: "Gemini 2.0 Flash (free)" },
      { id: "deepseek/deepseek-chat", label: "DeepSeek V3" },
      { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
      { id: "qwen/qwen-2.5-72b-instruct", label: "Qwen 2.5 72B" },
    ],
  },
  {
    id: "codex",
    name: "Codex (ChatGPT Plus/Pro OAuth)",
    icon: "🟢",
    keyName: "(none)",
    placeholder: "ChatGPT 구독 OAuth — codex login",
    docsUrl: "https://developers.openai.com/codex/cli",
    noKeyRequired: true,
    note: "OpenAI Codex CLI 를 ChatGPT Plus/Pro 구독 OAuth 로 인증해 사용. K-Personal MCP 도구도 그대로 통합 (codex mcp add 한 번 등록 필요). 아래 [codex login] 버튼으로 시스템 브라우저 OAuth 진행 — 외부 PowerShell 안 거침.",
    models: [
      { id: "default", label: "ChatGPT 구독 기본 모델 (자동 최신)" },
      { id: "gpt-5.5", label: "GPT-5.5 (최신 codex)" },
      { id: "gpt-5", label: "GPT-5" },
      { id: "gpt-5-codex", label: "GPT-5 Codex" },
      { id: "gpt-4.1", label: "GPT-4.1" },
      { id: "o3", label: "o3 (추론)" },
    ],
  },
];

// ─── Phase 15 — 외부 webview 사용량 페이지 ────────────────────────
// K-Desktop-Agent 안에서 새 webview 창으로 열어 인증 cookie 가 영속됨.
interface ExternalUsagePage {
  id: string;
  label: string;          // 창 label — 같은 label 은 새 창 대신 focus
  title: string;          // 창 타이틀
  url: string;            // 진입 URL
  icon: string;
  description: string;
}
const EXTERNAL_USAGE_PAGES: ExternalUsagePage[] = [
  {
    id: "anthropic-usage",
    label: "kda-claude-account",
    title: "Claude.ai 계정",
    url: "https://claude.ai/settings",
    icon: "💠",
    description: "Claude Max 구독 상태 + Plan & Usage. (Max 는 공식 사용량 대시보드가 없어 정보 부분적 — 정확한 토큰은 K-Desktop-Agent 컨텍스트 미터.)",
  },
  {
    id: "chatgpt-account",
    label: "kda-chatgpt-account",
    title: "ChatGPT Account",
    url: "https://chatgpt.com/#settings/Account",
    icon: "🟢",
    description: "ChatGPT Plus/Pro 구독 상태 및 사용량.",
  },
  {
    id: "openai-platform-usage",
    label: "kda-openai-usage",
    title: "OpenAI Platform Usage",
    url: "https://platform.openai.com/usage",
    icon: "🧠",
    description: "OpenAI API (별도 결제) 사용량 — Codex/ChatGPT 구독과 무관.",
  },
];

// localStorage 키 — App.tsx 와 공유
const LS_ACTIVE_PROVIDER = "kda_active_provider";
const LS_ACTIVE_MODEL = "kda_active_model";
// 개별 잠금 도구 풀네임 배열 — App.tsx 가 invoke send_message 에 lockedTools 로 전달
const LS_LOCKED_TOOLS = "kda_locked_tools";

// ─── 도구 카탈로그 (정밀 잠금 UI 용) ──────────────────────────────────
// sidecar/src/index.ts 의 PERM_TOOL_MAP 과 동기화 필수.
// 사이드카가 source-of-truth 지만 UI 가 도구 목록을 펼쳐 보여주려면 풀네임이 필요.
// 새 도구를 sidecar 에 추가하면 여기도 같이 추가 (린트/테스트로 자동 감지는 어려우니
// 코드 리뷰 시 양쪽 짝맞추기 체크리스트 유지).
interface ToolCatalogEntry {
  name: string;        // 도구 풀네임 (예: "mcp__k-personal__fm_move_file")
  label: string;       // 사람용 라벨
  desc?: string;       // 짧은 설명
  destructive?: boolean;  // 위험 표시 (적색 강조)
}

interface ToolCategory {
  permId: string;          // 카테고리 토글 ID (PERM_TOOL_MAP 키)
  title: string;           // UI 섹션 제목
  icon: string;
  tools: ToolCatalogEntry[];
}

const TOOL_CATALOG: ToolCategory[] = [
  {
    permId: "file_read",
    title: "파일 읽기",
    icon: "📖",
    tools: [
      { name: "Read", label: "Read", desc: "단일 파일 읽기" },
      { name: "Glob", label: "Glob", desc: "파일 패턴 검색" },
      { name: "Grep", label: "Grep", desc: "내용 grep" },
      { name: "mcp__k-personal__fm_list_directory", label: "fm_list_directory", desc: "폴더 내용 목록" },
      { name: "mcp__k-personal__fm_search_files", label: "fm_search_files", desc: "파일 이름 검색" },
      { name: "mcp__k-personal__fm_recent_files", label: "fm_recent_files", desc: "최근 수정 파일" },
      { name: "mcp__k-personal__fm_file_info", label: "fm_file_info", desc: "파일 정보" },
      { name: "mcp__k-personal__fm_disk_usage", label: "fm_disk_usage", desc: "디스크 사용량" },
      { name: "mcp__k-personal__fm_list_backups", label: "fm_list_backups", desc: "백업 목록" },
      { name: "mcp__k-personal__fm_operation_log", label: "fm_operation_log", desc: "파일 작업 로그" },
    ],
  },
  {
    permId: "file_write",
    title: "파일 쓰기",
    icon: "✏️",
    tools: [
      { name: "Write", label: "Write", desc: "새 파일 작성", destructive: true },
      { name: "Edit", label: "Edit", desc: "단일 치환", destructive: true },
      { name: "MultiEdit", label: "MultiEdit", desc: "다중 치환", destructive: true },
      { name: "mcp__k-personal__fm_copy_file", label: "fm_copy_file", desc: "파일 복사 (비파괴)" },
    ],
  },
  {
    permId: "file_delete",
    title: "파일 삭제 / 이동",
    icon: "🗑️",
    tools: [
      { name: "mcp__k-personal__fm_move_file", label: "fm_move_file", desc: "파일 이동 (사실상 삭제)", destructive: true },
      { name: "mcp__k-personal__fm_organize_folder", label: "fm_organize_folder", desc: "확장자별 자동 정리 (대량 이동)", destructive: true },
      { name: "mcp__k-personal__fm_restore_file", label: "fm_restore_file", desc: "백업 복원 (덮어쓰기)", destructive: true },
    ],
  },
  {
    permId: "app_launch",
    title: "앱 실행",
    icon: "🚀",
    tools: [
      { name: "mcp__k-personal__app_launch", label: "app_launch", desc: "프로그램 실행" },
      { name: "mcp__k-personal__app_kill", label: "app_kill", desc: "프로세스 종료", destructive: true },
      { name: "mcp__k-personal__app_list_running", label: "app_list_running", desc: "실행 중 목록" },
      { name: "mcp__k-personal__app_open_url", label: "app_open_url", desc: "URL 열기" },
      { name: "mcp__k-personal__app_register", label: "app_register", desc: "별명 등록" },
      { name: "mcp__k-personal__app_list_registered", label: "app_list_registered", desc: "별명 목록" },
      { name: "mcp__k-personal__app_launch_preset", label: "app_launch_preset", desc: "프리셋 실행" },
    ],
  },
  {
    permId: "system_control",
    title: "시스템 제어 (마우스/키보드/클립보드)",
    icon: "🖱️",
    tools: [
      { name: "mcp__k-personal__cc_mouse_move", label: "cc_mouse_move", desc: "마우스 이동" },
      { name: "mcp__k-personal__cc_mouse_click", label: "cc_mouse_click", desc: "마우스 클릭" },
      { name: "mcp__k-personal__cc_mouse_position", label: "cc_mouse_position", desc: "마우스 위치 조회" },
      { name: "mcp__k-personal__cc_keyboard_type", label: "cc_keyboard_type", desc: "키보드 입력", destructive: true },
      { name: "mcp__k-personal__cc_keyboard_hotkey", label: "cc_keyboard_hotkey", desc: "단축키 (Ctrl+C 등)", destructive: true },
      { name: "mcp__k-personal__cc_focus_window", label: "cc_focus_window", desc: "창 활성화" },
      { name: "mcp__k-personal__clip_get", label: "clip_get", desc: "클립보드 읽기" },
      { name: "mcp__k-personal__clip_set", label: "clip_set", desc: "클립보드 쓰기" },
      { name: "mcp__k-personal__clip_paste_at", label: "clip_paste_at", desc: "위치에 붙여넣기", destructive: true },
      { name: "mcp__k-personal__clip_snippet_add", label: "clip_snippet_add", desc: "스니펫 저장" },
      { name: "mcp__k-personal__clip_snippet_get", label: "clip_snippet_get", desc: "스니펫 조회" },
      { name: "mcp__k-personal__clip_snippet_list", label: "clip_snippet_list", desc: "스니펫 목록" },
    ],
  },
  {
    permId: "screenshot",
    title: "화면 캡처",
    icon: "📸",
    tools: [
      { name: "mcp__k-personal__cc_screenshot", label: "cc_screenshot", desc: "전체 화면" },
      { name: "mcp__k-personal__cc_screenshot_region", label: "cc_screenshot_region", desc: "영역 캡처" },
      { name: "mcp__k-personal__cc_screen_size", label: "cc_screen_size", desc: "해상도 조회" },
      { name: "mcp__k-personal__cc_list_windows", label: "cc_list_windows", desc: "창 목록" },
    ],
  },
  {
    permId: "ui_automation",
    title: "UI 자동화 (백그라운드, 입력 점유 X)",
    icon: "🪟",
    tools: [
      { name: "mcp__k-personal__ui_dump_tree", label: "ui_dump_tree", desc: "창 트리 텍스트 덤프" },
      { name: "mcp__k-personal__ui_find", label: "ui_find", desc: "이름/role/id 로 검색" },
      { name: "mcp__k-personal__ui_click_by_name", label: "ui_click_by_name", desc: "이름으로 클릭", destructive: true },
      { name: "mcp__k-personal__ui_click_by_id", label: "ui_click_by_id", desc: "AutomationId 로 클릭", destructive: true },
      { name: "mcp__k-personal__ui_set_text", label: "ui_set_text", desc: "입력란에 텍스트", destructive: true },
      { name: "mcp__k-personal__ui_get_text", label: "ui_get_text", desc: "컨트롤 값 읽기" },
      { name: "mcp__k-personal__ui_focus_control", label: "ui_focus_control", desc: "컨트롤 포커스" },
      { name: "mcp__k-personal__ui_invoke", label: "ui_invoke", desc: "InvokePattern 호출", destructive: true },
      { name: "mcp__k-personal__ui_list_windows", label: "ui_list_windows", desc: "창 목록 (상세)" },
    ],
  },
  {
    permId: "web_automation",
    title: "웹 자동화 (헤드리스 브라우저)",
    icon: "🌍",
    tools: [
      { name: "mcp__k-personal__web_open", label: "web_open", desc: "URL 열기" },
      { name: "mcp__k-personal__web_snapshot", label: "web_snapshot", desc: "페이지 a11y 트리 텍스트" },
      { name: "mcp__k-personal__web_click", label: "web_click", desc: "selector/role 로 클릭", destructive: true },
      { name: "mcp__k-personal__web_fill", label: "web_fill", desc: "입력란 채우기", destructive: true },
      { name: "mcp__k-personal__web_get_text", label: "web_get_text", desc: "selector 텍스트" },
      { name: "mcp__k-personal__web_screenshot", label: "web_screenshot", desc: "페이지 PNG (디버그)" },
      { name: "mcp__k-personal__web_evaluate", label: "web_evaluate", desc: "JS 실행", destructive: true },
      { name: "mcp__k-personal__web_url", label: "web_url", desc: "현재 URL" },
      { name: "mcp__k-personal__web_close", label: "web_close", desc: "브라우저 종료" },
    ],
  },
  {
    permId: "web_fetch",
    title: "웹 요청",
    icon: "🌐",
    tools: [
      { name: "WebFetch", label: "WebFetch", desc: "URL 가져오기" },
      { name: "WebSearch", label: "WebSearch", desc: "웹 검색" },
    ],
  },
  {
    permId: "db_access",
    title: "개인 DB",
    icon: "📝",
    tools: [
      { name: "mcp__k-personal__db_todo_add", label: "db_todo_add" },
      { name: "mcp__k-personal__db_todo_list", label: "db_todo_list" },
      { name: "mcp__k-personal__db_todo_done", label: "db_todo_done" },
      { name: "mcp__k-personal__db_todo_delete", label: "db_todo_delete", destructive: true },
      { name: "mcp__k-personal__db_note_add", label: "db_note_add" },
      { name: "mcp__k-personal__db_note_list", label: "db_note_list" },
      { name: "mcp__k-personal__db_note_search", label: "db_note_search" },
      { name: "mcp__k-personal__db_note_delete", label: "db_note_delete", destructive: true },
      { name: "mcp__k-personal__db_habit_add", label: "db_habit_add" },
      { name: "mcp__k-personal__db_habit_check", label: "db_habit_check" },
      { name: "mcp__k-personal__db_habit_list", label: "db_habit_list" },
    ],
  },
  {
    permId: "shell",
    title: "셸 / 코드 실행 (고위험)",
    icon: "💻",
    tools: [
      { name: "Bash", label: "Bash", desc: "셸 명령 실행 (rm/del 포함)", destructive: true },
      { name: "BashOutput", label: "BashOutput", desc: "백그라운드 셸 출력 조회" },
      { name: "KillShell", label: "KillShell", desc: "셸 강제 종료" },
    ],
  },
];

// 기본 에이전트 권한 설정
const DEFAULT_PERMISSIONS: AgentPermission[] = [
  {
    id: "file_read",
    name: "파일 읽기",
    description: "파일 및 폴더 내용 조회",
    icon: "📖",
    level: "auto",
    category: "file",
  },
  {
    id: "file_write",
    name: "파일 쓰기",
    description: "파일 생성, 수정, 이동, 복사",
    icon: "✏️",
    level: "auto",
    category: "file",
  },
  {
    id: "file_delete",
    name: "파일 삭제",
    description: "파일 및 폴더 삭제",
    icon: "🗑️",
    level: "auto",
    category: "file",
  },
  {
    id: "app_launch",
    name: "앱 실행",
    description: "프로그램 실행 및 종료",
    icon: "🚀",
    level: "auto",
    category: "system",
  },
  {
    id: "system_control",
    name: "시스템 제어",
    description: "마우스, 키보드, 클립보드 제어",
    icon: "🖱️",
    level: "auto",
    category: "input",
  },
  {
    id: "screenshot",
    name: "화면 캡처",
    description: "스크린샷 촬영 및 분석",
    icon: "📸",
    level: "auto",
    category: "system",
  },
  {
    id: "web_fetch",
    name: "웹 요청",
    description: "웹페이지 및 API 호출",
    icon: "🌐",
    level: "auto",
    category: "network",
  },
  {
    id: "db_access",
    name: "개인 DB",
    description: "할일, 메모, 습관 관리",
    icon: "📝",
    level: "auto",
    category: "system",
  },
  // Phase 13 — Headless Automation (K님 입력/화면 안 점유)
  {
    id: "ui_automation",
    name: "UI 자동화",
    description: "백그라운드 컨트롤 조작 (마우스 안 움직임)",
    icon: "🪟",
    level: "auto",
    category: "system",
  },
  {
    id: "web_automation",
    name: "웹 자동화",
    description: "헤드리스 브라우저 (화면 안 뜸)",
    icon: "🌍",
    level: "auto",
    category: "network",
  },
];

// 테마 목록
const THEMES: Theme[] = [
  {
    id: "cyber-teal",
    name: "사이버 틸 (기본)",
    preview: "#4FE8E1",
    accent: "79, 232, 225",
    background: "12, 14, 18",
  },
  {
    id: "neon-purple",
    name: "네온 퍼플",
    preview: "#A855F7",
    accent: "168, 85, 247",
    background: "15, 10, 25",
  },
  {
    id: "matrix-green",
    name: "매트릭스 그린",
    preview: "#22C55E",
    accent: "34, 197, 94",
    background: "8, 15, 10",
  },
  {
    id: "sunset-orange",
    name: "선셋 오렌지",
    preview: "#F97316",
    accent: "249, 115, 22",
    background: "20, 12, 8",
  },
  {
    id: "arctic-blue",
    name: "아틱 블루",
    preview: "#3B82F6",
    accent: "59, 130, 246",
    background: "8, 12, 20",
  },
  {
    id: "rose-pink",
    name: "로즈 핑크",
    preview: "#EC4899",
    accent: "236, 72, 153",
    background: "20, 10, 15",
  },
];

// Phase 16: Settings 탭 분리 — 16개 섹션을 5개 카테고리로 그룹핑
type SettingsTabId = "ai" | "agent" | "appearance" | "system" | "tools" | "safety";

const SETTINGS_TABS: { id: SettingsTabId; icon: string; label: string }[] = [
  { id: "ai", icon: "🤖", label: "AI" },
  { id: "agent", icon: "🛡️", label: "에이전트" },
  { id: "appearance", icon: "🎨", label: "외관" },
  { id: "system", icon: "⚙️", label: "시스템" },
  // Phase 67 (v0.6.2) — MCP 도구 인스펙터 + 카탈로그 + 커스텀 plugin 빌더
  { id: "tools", icon: "🔧", label: "MCP 도구" },
  { id: "safety", icon: "🆘", label: "안전장치" },
];

const LS_ACTIVE_SETTINGS_TAB = "kda_active_settings_tab";

// Phase 67 (v0.6.2) — 커스텀 plugin 빌더의 "새 도구" 기본 템플릿.
// K-Personal-MCP/modules/kda_plugins/kda_example.py 와 같은 패턴 — 익숙해지면 빠른 시작 가능.
const KDA_PLUGIN_TEMPLATE = `"""
KDA 커스텀 plugin
"""
from mcp.types import Tool, TextContent


def get_tools() -> list[Tool]:
    return [
        Tool(
            name="kda_my_tool",
            description="여기에 도구 설명 (모델이 이걸 보고 언제 호출할지 판단).",
            inputSchema={
                "type": "object",
                "properties": {
                    "message": {"type": "string", "description": "예시 인자"},
                },
                "required": ["message"],
            },
        ),
    ]


async def handle_tool(name: str, arguments: dict) -> list:
    if name == "kda_my_tool":
        msg = arguments.get("message", "")
        return [TextContent(type="text", text=f"received: {msg}")]
    raise KeyError(name)
`;

// Phase 67b (v0.6.2) — 외부 MCP 서버 카탈로그 (정적 list — 이번 phase 는 명령 안내만).
// 자동 설치 + sidecar multi-MCP spawn 은 다음 phase 후보 (현재 sidecar 는 K-Personal singleton).
interface ExternalMCPCatalogEntry {
  id: string;
  name: string;
  icon: string;
  description: string;
  installCommand: string;
  docsUrl: string;
  note?: string;
}

const EXTERNAL_MCP_CATALOG: ExternalMCPCatalogEntry[] = [
  {
    id: "filesystem",
    name: "Filesystem",
    icon: "📁",
    description:
      "임의 디렉토리에 대한 read/write/list/search. K-Personal MCP 의 fm_* 와 비슷하지만 표준 MCP 형식이라 다른 IDE 와 호환.",
    installCommand: "npx -y @modelcontextprotocol/server-filesystem <path>",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    id: "github",
    name: "GitHub",
    icon: "🐙",
    description:
      "GitHub repo 검색, issue/PR 조회, code search. 개인 access token 필요.",
    installCommand: "npx -y @modelcontextprotocol/server-github",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    note: "GITHUB_PERSONAL_ACCESS_TOKEN 환경변수 필요",
  },
  {
    id: "brave-search",
    name: "Brave Search",
    icon: "🔍",
    description: "웹 검색 (개인정보 보호 검색엔진). Brave API 키 필요 (월 2,000 쿼리 무료).",
    installCommand: "npx -y @modelcontextprotocol/server-brave-search",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
    note: "BRAVE_API_KEY 환경변수 필요",
  },
  {
    id: "slack",
    name: "Slack",
    icon: "💬",
    description:
      "Slack 워크스페이스 메시지 읽기/검색/post. Bot token 필요.",
    installCommand: "npx -y @modelcontextprotocol/server-slack",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
    note: "SLACK_BOT_TOKEN + SLACK_TEAM_ID 필요",
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    icon: "🐘",
    description: "Postgres DB 에 read-only SQL 쿼리. 로컬 / 원격 모두 가능.",
    installCommand: "npx -y @modelcontextprotocol/server-postgres postgresql://...",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
  },
  {
    id: "fetch",
    name: "Fetch",
    icon: "🌐",
    description:
      "임의 URL 의 HTML 을 markdown 변환 후 가져옴. K-Personal 의 web_* 보다 가벼움.",
    installCommand: "uvx mcp-server-fetch",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    note: "Python uv 설치 필요",
  },
  {
    id: "memory",
    name: "Memory (Knowledge Graph)",
    icon: "🧠",
    description:
      "MCP 서버 자체에 entity/relation 영속 — 대화간 지속되는 지식 베이스. K 의 memory/ 와 별도.",
    installCommand: "npx -y @modelcontextprotocol/server-memory",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
  },
];

export default function Settings({ open, onClose, mcpConnected }: SettingsProps) {
  const [autoStart, setAutoStart] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [loading, setLoading] = useState(true);

  // Phase 16: 활성 탭 (localStorage 영속) — 마지막에 K가 본 탭으로 복귀
  const [activeTab, setActiveTab] = useState<SettingsTabId>(() => {
    try {
      const saved = localStorage.getItem(LS_ACTIVE_SETTINGS_TAB) as SettingsTabId | null;
      if (saved && SETTINGS_TABS.some((t) => t.id === saved)) return saved;
    } catch {}
    return "ai";
  });
  useEffect(() => {
    try {
      localStorage.setItem(LS_ACTIVE_SETTINGS_TAB, activeTab);
    } catch {}
  }, [activeTab]);
  const [watchedFolders, setWatchedFolders] = useState<WatchedFolder[]>([]);
  const [addingFolder, setAddingFolder] = useState(false);

  // API 키 상태
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  // UI 탭 (어느 provider 카드를 보고 있는지)
  const [activeProvider, setActiveProvider] = useState<string>("claude");
  // 실제 채팅에 사용되는 active provider/model (sidecar 로 전달됨)
  const [chatProvider, setChatProvider] = useState<string>("claude");
  const [chatModel, setChatModel] = useState<string>("default");

  // 에이전트 권한 상태
  const [permissions, setPermissions] = useState<AgentPermission[]>(DEFAULT_PERMISSIONS);

  // 정밀 잠금된 도구 풀네임 (Set 으로 빠른 조회)
  const [lockedTools, setLockedTools] = useState<Set<string>>(new Set());
  // 카테고리별 펼침/접힘 상태 (UI 만 — 저장 안 함)
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());

  // 테마 상태
  const [currentTheme, setCurrentTheme] = useState<string>("cyber-teal");

  // 말풍선 색상 상태
  const [bubbleColors, setBubbleColors] = useState<{
    userBg: string;
    userBorder: string;
    assistantBg: string;
    assistantBorder: string;
  }>({
    userBg: "79, 232, 225",      // 기본 accent 색상
    userBorder: "79, 232, 225",
    assistantBg: "20, 27, 45",    // bg-3 색상
    assistantBorder: "28, 37, 55", // border-subtle
  });

  // claude login 버튼 상태 (UX feedback 용 — 별도 콘솔에서 OAuth 진행)
  const [loginStatus, setLoginStatus] = useState<"idle" | "running" | "error">("idle");
  const [loginError, setLoginError] = useState<string | null>(null);

  // Phase 15 — Codex 로그인 / MCP 등록 / 인증 상태
  const [codexLoginStatus, setCodexLoginStatus] = useState<"idle" | "running" | "error">("idle");
  const [codexLoginError, setCodexLoginError] = useState<string | null>(null);
  const [codexAuth, setCodexAuth] = useState<{
    authenticated: boolean;
    cli_available: boolean;
    auth_path: string;
  } | null>(null);
  const [codexMcpRegistering, setCodexMcpRegistering] = useState(false);
  const [codexMcpResult, setCodexMcpResult] = useState<string | null>(null);
  // 외부 webview (사용량 페이지 등) 진입 상태
  const [webviewOpening, setWebviewOpening] = useState<string | null>(null);

  // 자동 업데이트 상태
  const [autoUpdate, setAutoUpdate] = useState(true);

  // Phase 59 — Anthropic rate polling (ccusage) toggle.
  // K 의 V3 (안랩) 같은 백신이 ccusage native binary 의 실행을 차단해 매 5분마다 알림 팝업이
  // 뜨는 경우, polling 자체를 끌 수 있어야 함. 영속화: ~/.kda/sidecar-config.json.
  // 변경 후 즉시 효과는 sidecar 재시작 필요.
  const [anthropicRatePolling, setAnthropicRatePolling] = useState(true);
  const [sidecarReloadHint, setSidecarReloadHint] = useState(false);
  const [anthropicRatePollingBusy, setAnthropicRatePollingBusy] = useState(false);
  // Phase 80 (v0.6.24) — Final-Review Gate toggle (default true). 같은 sidecar-config 파일.
  const [finalReviewGate, setFinalReviewGate] = useState(true);
  const [finalReviewGateBusy, setFinalReviewGateBusy] = useState(false);
  // Phase 81 (v0.6.25) — Lee Profile 정보 (예시 template 자동 생성 + path 표시)
  const [leeProfile, setLeeProfile] = useState<{ path: string; bytes: number; justCreated: boolean } | null>(null);
  const [leeProfileBusy, setLeeProfileBusy] = useState(false);
  // Phase 84 (v0.6.27) — Connector/Tool Safety Layer SafeMode toggle.
  // localStorage "kda_safe_mode" 와 동기화. App.tsx 의 send_message 가 동일 키 읽어서 sidecar 전달.
  const [safeMode, setSafeMode] = useState<SafeMode>(() => {
    try {
      const s = localStorage.getItem("kda_safe_mode");
      if (s === "balanced" || s === "strict") return s;
    } catch {
      /* ignore */
    }
    return "off";
  });
  // Phase 87 (v0.6.30) — Git Memory Sync state
  // Phase 89 (v0.6.31) — Hybrid: + team repo + 안내 워크스루 토글
  const [gitSyncEnabled, setGitSyncEnabled] = useState(false);
  const [gitSyncRepoUrl, setGitSyncRepoUrl] = useState("");
  const [gitSyncTeamRepoUrl, setGitSyncTeamRepoUrl] = useState("");
  const [gitSyncPat, setGitSyncPat] = useState(""); // 평문 — Settings 떠 있는 동안만, 저장 후 즉시 비움
  const [gitSyncTeamPat, setGitSyncTeamPat] = useState(""); // team PAT (선택, 같은 PAT 재사용 가능)
  const [gitSyncStatus, setGitSyncStatus] = useState<{
    git_installed: boolean;
    git_version: string | null;
    initialized: boolean;
    has_remote: boolean;
    local_changes: number;
    branch: string | null;
    team_initialized: boolean;
    team_has_remote: boolean;
    team_local_changes: number;
    team_branch: string | null;
    last_sync_at: number;
    last_sync_status: string;
  } | null>(null);
  const [gitSyncBusy, setGitSyncBusy] = useState(false);
  const [gitSyncMessage, setGitSyncMessage] = useState<{ kind: "ok" | "error" | "conflict"; text: string; target?: "personal" | "team" } | null>(null);
  const [gitSyncConflict, setGitSyncConflict] = useState<{ files: string[]; target: "personal" | "team" } | null>(null);
  // Phase 88 — 안내 워크스루 토글 (default 열림, 한 번 닫으면 localStorage 기억)
  const [gitSyncShowGuide, setGitSyncShowGuide] = useState<boolean>(() => {
    try {
      return localStorage.getItem("kda_git_sync_guide_dismissed") !== "1";
    } catch {
      return true;
    }
  });

  // Phase 90 (v0.6.32) — SafeMode 주간 통계
  // Phase 91 (v0.6.33) — buckets 에 byTool 추가 + 막대 클릭 시 펼침 state
  const [safetyStats, setSafetyStats] = useState<{
    total_alerts: number;
    total_blocks: number;
    last7_alerts: number;
    last7_blocks: number;
    by_mode: { off: number; balanced: number; strict: number };
    buckets: Array<{
      date: string;
      alerts: number;
      blocks: number;
      byMode: { off: number; balanced: number; strict: number };
      byTool?: Record<string, number>;
    }>;
    since_at: number;
    last_updated_at: number;
  } | null>(null);
  const [expandedStatDate, setExpandedStatDate] = useState<string | null>(null);
  // Phase 91 — Memory Sync commit history viewer
  const [gitSyncLog, setGitSyncLog] = useState<{
    target: "personal" | "team";
    ok: boolean;
    message: string;
    commits: Array<{ hash: string; date: string; author: string; subject: string }>;
  } | null>(null);
  const [gitSyncLogBusy, setGitSyncLogBusy] = useState(false);
  // Phase 91 — SafeMode 자동 전환 스케줄
  const [scheduleRules, setScheduleRules] = useState<
    import("../utils/safeModeSchedule").SafeModeRule[]
  >([]);
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "available" | "latest" | "downloading" | "error">("idle");
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");

  // 안전장치 (백업/복구) 상태
  const [latestBackup, setLatestBackup] = useState<BackupInfo | null>(null);
  const [backupBusy, setBackupBusy] = useState<"idle" | "backing-up" | "rolling-back">("idle");
  const [backupError, setBackupError] = useState<string | null>(null);
  const [showRollbackConfirm, setShowRollbackConfirm] = useState(false);

  // Phase 18 — 의존성 자동 셋업 상태 (install-deps.ps1 결과 캐시)
  // 결과 JSON 스키마는 install-deps.ps1 의 $result 와 동일.
  type DepsBefore = {
    winget?: boolean;
    node?: boolean;
    npm?: boolean;
    git?: boolean;
    python?: string | null;
    claudeCli?: boolean;
    codexCli?: boolean;
    kPersonalMcp?: string | null;
  };
  type DepsResult = {
    ready: boolean;
    fullyReady: boolean;
    dryRun: boolean;
    before: DepsBefore;
    after: DepsBefore;
    nextSteps?: string[];
    fatal?: string;
    // Phase 24 (v0.5.10): winget 없고 도구도 없을 때 missing[] 으로 명확히 알림
    missing?: string[];
  };
  const [depsResult, setDepsResult] = useState<DepsResult | null>(null);
  const [depsBusy, setDepsBusy] = useState<"idle" | "checking" | "installing">("idle");
  const [depsError, setDepsError] = useState<string | null>(null);
  const [isFirstRun, setIsFirstRun] = useState<boolean>(false);

  // Phase 66 (v0.6.1) — K-Personal MCP 자동 설치 상태
  type KpmcpResult = {
    success: boolean;
    alreadyInstalled: boolean;
    target: string;
    serverPyExists: boolean;
    pythonAvailable: boolean;
    gitAvailable: boolean;
    steps: string[];
    error: string | null;
  };
  const [kpmcpResult, setKpmcpResult] = useState<KpmcpResult | null>(null);
  const [kpmcpBusy, setKpmcpBusy] = useState<"idle" | "installing">("idle");
  const [kpmcpError, setKpmcpError] = useState<string | null>(null);

  // ─── Phase 67 (v0.6.2) — MCP 도구 인스펙터 + 카탈로그 + plugin 빌더 상태 ──────────
  // 67a: 현재 sidecar 에 연결된 K-Personal MCP 가 노출하는 도구 list
  type McpToolInfo = {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  };
  const [mcpTools, setMcpTools] = useState<McpToolInfo[] | null>(null);
  const [mcpToolsError, setMcpToolsError] = useState<string | null>(null);
  const [mcpToolsBusy, setMcpToolsBusy] = useState(false);
  const [toolFilter, setToolFilter] = useState("");
  const [expandedTool, setExpandedTool] = useState<string | null>(null);

  // Phase 75 (v0.6.18) — 좀비 codex process detect.
  // K 다른 PC: "Reconnecting... 2/5 (timeout waiting for child process to exit)" 의 root cause.
  // Phase 76 (v0.6.19) — `suspected` 필드 추가: cmdline 못 읽은 node.exe 도 후보로 포함 시 true.
  type StaleProcess = {
    pid: number;
    name: string;
    start_time: string;
    age_hours: number;
    command_line: string;
    suspected?: boolean;
  };
  const [staleProcesses, setStaleProcesses] = useState<StaleProcess[] | null>(null);
  const [staleProcessesBusy, setStaleProcessesBusy] = useState(false);
  const [staleProcessesError, setStaleProcessesError] = useState<string | null>(null);
  // Phase 68 (v0.6.12) — UI tooltip 의 "source: k-personal@1.27.1" 표시용. sidecar 의 mcp_tools event
  // payload 에 새로 박힌 serverName/serverVersion 받아 저장. cause="auto" / "request" 도 같이 받아
  // 마지막 갱신 출처를 사용자에게 보이게.
  const [mcpServerInfo, setMcpServerInfo] = useState<{ name?: string; version?: string; cause?: string; receivedAt?: number } | null>(null);

  // 67c: KDA 가 K-Personal-MCP/modules/kda_plugins/ 에 박은 커스텀 plugin 목록 + 에디터
  type PluginInfo = { file: string; size: number; modified_ms: number };
  const [pluginList, setPluginList] = useState<PluginInfo[]>([]);
  const [pluginListError, setPluginListError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<"new" | "edit">("new");
  const [editorName, setEditorName] = useState("");
  const [editorCode, setEditorCode] = useState("");
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorMessage, setEditorMessage] = useState<string | null>(null);
  // 모델에게 자연어 요청해서 코드 자동 제안받는 경로 — Composer 에 prompt 흘려보내는 식
  const [builderRequest, setBuilderRequest] = useState("");

  // sidecar event listen 등록 ref (unmount 시 해제)
  const mcpToolsUnlistenRef = useRef<UnlistenFn | null>(null);

  // Phase 25 (v0.5.11): Portable data dir
  type DataDirInfo = {
    data_root: string;
    pointer_path?: string | null;
    pointer_exists: boolean;
    install_dir?: string | null;
    default_data_dir?: string | null;
    data_root_exists: boolean;
    db_path: string;
    db_exists: boolean;
  };
  const [dataDirInfo, setDataDirInfo] = useState<DataDirInfo | null>(null);
  const [dataDirBusy, setDataDirBusy] = useState<boolean>(false);
  const [dataDirMsg, setDataDirMsg] = useState<string | null>(null);
  const [dataDirError, setDataDirError] = useState<string | null>(null);

  async function refreshDataDirInfo() {
    try {
      const info = await invoke<DataDirInfo>("get_data_dir_info");
      setDataDirInfo(info);
    } catch (e) {
      setDataDirError(String(e));
    }
  }

  async function handleChangeDataDir(target: "default" | "pick") {
    setDataDirBusy(true);
    setDataDirError(null);
    setDataDirMsg(null);
    try {
      let newPath: string | undefined;
      if (target === "default") {
        newPath = dataDirInfo?.default_data_dir ?? undefined;
        if (!newPath) {
          setDataDirError("기본 위치를 결정 못 함 (install_dir 인식 실패)");
          return;
        }
      } else {
        const picked = await openDialog({
          directory: true,
          multiple: false,
          title: "K-Desktop-Agent 데이터 폴더 선택",
          defaultPath: dataDirInfo?.data_root ?? undefined,
        });
        if (!picked || Array.isArray(picked)) return; // 취소
        newPath = picked;
      }
      const migrate = window.confirm(
        `데이터 폴더를 다음 위치로 변경합니다:\n\n${newPath}\n\n` +
        `[확인] = 기존 데이터 (DB / 백업 / cwd / 로그) 도 함께 이동\n` +
        `[취소] = 변경 취소\n\n` +
        `※ 변경 후 KDA 를 한 번 재시작해야 새 위치의 DB 가 활성화됩니다.`,
      );
      if (!migrate) return;
      const updated = await invoke<DataDirInfo>("change_data_dir", {
        newPath,
        migrate: true,
      });
      setDataDirInfo(updated);
      setDataDirMsg("✅ 데이터 폴더 변경 완료 — KDA 를 재시작하세요");
    } catch (e) {
      setDataDirError(String(e));
    } finally {
      setDataDirBusy(false);
    }
  }

  // 앱 버전은 한 번만 동적으로 로딩 (tauri.conf.json 의 단일 진실원)
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion("unknown"));
  }, []);

  // Settings 모달이 열릴 때마다 latest 백업 정보 fresh 로드
  useEffect(() => {
    if (!open) return;
    invoke<BackupInfo | null>("get_latest_backup")
      .then((info) => {
        setLatestBackup(info);
        setBackupError(null);
      })
      .catch((e) => {
        console.error("get_latest_backup 실패:", e);
        setBackupError(String(e));
      });
  }, [open]);

  // Phase 18 — Settings 가 열릴 때마다 의존성 상태 + first-run sentinel 검사.
  // 결과는 system 탭의 "필수 도구" 섹션이 사용. fail 해도 silent — UI 만 빈 상태 유지.
  useEffect(() => {
    if (!open) return;
    invoke<boolean>("is_first_run")
      .then(setIsFirstRun)
      .catch(() => setIsFirstRun(false));
    setDepsBusy("checking");
    setDepsError(null);
    invoke<string>("check_dependencies")
      .then((json) => {
        try {
          const parsed = JSON.parse(json) as DepsResult;
          setDepsResult(parsed);
        } catch (e) {
          setDepsError(`JSON 파싱 실패: ${String(e)}`);
        }
      })
      .catch((e) => setDepsError(String(e)))
      .finally(() => setDepsBusy("idle"));

    // Phase 25 (v0.5.11): 데이터 폴더 상태 동기 로드
    refreshDataDirInfo();
  }, [open]);

  // ─── Phase 67 (v0.6.2) — Settings 열림 + tools 탭 활성화 시 도구/plugin list 로드 ──────
  useEffect(() => {
    if (!open) return;

    // Phase 69 (v0.6.13) — 종전 cancelled flag race fix.
    //
    // 종전 코드의 함정:
    //   let cancelled = false;
    //   await listen(...)  // ← await 동안 effect cleanup 이 한 번 호출되면
    //   return () => { cancelled = true; }  // ← cancelled=true 박혀 모든 callback 무시
    //
    // React 가 [open] 의존성 effect 를 같은 cycle 에 두 번 (특히 strict mode 또는 ref 변경) 실행하면
    // 첫 effect 의 cleanup → cancelled=true → 그 effect 의 listener 가 등록은 됐는데 모든 event 무시.
    // 두 번째 effect 의 listener 는 새로 등록되지만 mcpToolsUnlistenRef 에 첫 effect 의 unlisten 만
    // 박혀 있어 leak. 결과: listener 가 두 개 떠 있는데 한 개는 cancelled=true 라 무시, 두 번째는
    // 또 다음 cleanup 에서 같은 함정으로 cancelled=true 박힘.
    //
    // 새 패턴: closure-local unlisten 변수만 사용. cancelled flag 제거. 각 effect 의 cleanup 이
    // 자기 unlisten 만 호출. 새 effect 가 자기 listener 등록. race 없음.
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        unlisten = await listen<{
          type: string;
          server?: string;
          tools?: McpToolInfo[];
          error?: string;
          serverName?: string;
          serverVersion?: string;
          cause?: "request" | "auto";
        }>("sidecar-event", (ev) => {
          const payload = ev.payload;
          if (payload && payload.type === "mcp_tools") {
            const count = payload.tools?.length ?? 0;
            // Phase 69 — frontend 수신 흔적을 sidecar.log 에 echo. K 의 다음 진단이 즉시 가능.
            // frontend_log Tauri command 없는 옛 binary 면 silently swallow.
            invoke("frontend_log", {
              message: `[settings] mcp_tools received cause=${payload.cause ?? "?"} count=${count} hasError=${!!payload.error}`,
            }).catch(() => {});

            setMcpToolsBusy(false);
            if (payload.error) {
              setMcpToolsError(payload.error);
              setMcpTools([]);
            } else {
              setMcpToolsError(null);
              setMcpTools(payload.tools ?? []);
            }
            // Phase 70 — 진단: setMcpTools 직후 payload shape echo. mcpTools=null silent 케이스 추적용.
            invoke("frontend_log", {
              message: `[settings] setMcpTools 호출됨 — payload.tools type=${Array.isArray(payload.tools) ? "array" : typeof payload.tools} length=${count} firstName=${payload.tools?.[0]?.name ?? "?"}`,
            }).catch(() => {});
            // Phase 68 — server identity 도 같이 저장 (UI tooltip 의 source 표시).
            // serverName/Version 가 undefined 면 옛 sidecar (v0.6.11 이하) → name "?" 표시.
            setMcpServerInfo({
              name: payload.serverName,
              version: payload.serverVersion,
              cause: payload.cause,
              receivedAt: Date.now(),
            });
          }
        });
        // Phase 69 — listener 등록 성공 echo. K 의 sidecar.log 에 "frontend ready to receive" 흔적.
        invoke("frontend_log", { message: "[settings] mcp_tools listener registered" }).catch(() => {});
        mcpToolsUnlistenRef.current = unlisten;
      } catch (e) {
        invoke("frontend_log", { message: `[settings] mcp_tools listen 등록 실패: ${String(e)}` }).catch(() => {});
      }
    })();

    return () => {
      if (unlisten) {
        try { unlisten(); } catch {}
      }
      mcpToolsUnlistenRef.current = null;
    };
  }, [open]);

  // 탭이 "tools" 로 활성화될 때마다 fresh 로드.
  useEffect(() => {
    if (!open || activeTab !== "tools") return;
    requestMcpToolsRefresh(false);
    refreshPluginList();
  }, [open, activeTab]);

  // Phase 87 (v0.6.30) — Git Memory Sync: Settings 열릴 때 status 요청 + event listener
  useEffect(() => {
    if (!open) return;
    let unlistenStatus: UnlistenFn | null = null;
    (async () => {
      // status 응답 listener (sidecar 가 emit)
      unlistenStatus = await listen<any>("sidecar_event", (e) => {
        const ev = e.payload;
        if (!ev || typeof ev !== "object") return;
        if (ev.type === "git_sync_status") {
          setGitSyncStatus({
            git_installed: ev.git_installed,
            git_version: ev.git_version,
            initialized: ev.initialized,
            has_remote: ev.has_remote,
            local_changes: ev.local_changes,
            branch: ev.branch,
            team_initialized: !!ev.team_initialized,
            team_has_remote: !!ev.team_has_remote,
            team_local_changes: typeof ev.team_local_changes === "number" ? ev.team_local_changes : 0,
            team_branch: ev.team_branch ?? null,
            last_sync_at: ev.last_sync_at,
            last_sync_status: ev.last_sync_status,
          });
          setGitSyncEnabled(!!ev.enabled);
          setGitSyncRepoUrl(typeof ev.repo_url === "string" ? ev.repo_url : "");
          setGitSyncTeamRepoUrl(typeof ev.team_repo_url === "string" ? ev.team_repo_url : "");
        } else if (ev.type === "git_sync_event") {
          setGitSyncBusy(false);
          setGitSyncMessage({
            kind: ev.kind,
            text: ev.message ?? "",
            target: ev.target,
          });
          if (ev.kind === "conflict") {
            setGitSyncConflict({
              files: ev.conflicted_files ?? [],
              target: ev.target ?? "personal",
            });
          } else if (ev.kind === "ok") {
            setGitSyncConflict(null);
          }
          // status 갱신 (lastSyncAt 반영)
          invoke("git_sync_status_request").catch(() => {});
        } else if (ev.type === "safety_stats_response") {
          setSafetyStats({
            total_alerts: ev.total_alerts,
            total_blocks: ev.total_blocks,
            last7_alerts: ev.last7_alerts,
            last7_blocks: ev.last7_blocks,
            by_mode: ev.by_mode,
            buckets: ev.buckets,
            since_at: ev.since_at,
            last_updated_at: ev.last_updated_at,
          });
        } else if (ev.type === "git_sync_log_response") {
          setGitSyncLogBusy(false);
          setGitSyncLog({
            target: ev.target,
            ok: ev.ok,
            message: ev.message,
            commits: ev.commits ?? [],
          });
        }
      });
      // Phase 91 — 스케줄 규칙 초기 로드 (localStorage)
      setScheduleRules(loadSchedule());
      // 초기 status + stats 요청
      try {
        await invoke("git_sync_status_request");
        await invoke("safety_stats_request");
      } catch {
        /* sidecar 안 떠 있으면 skip */
      }
    })().catch(() => {});
    return () => {
      if (unlistenStatus) unlistenStatus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);

    // 병렬로 설정 로드
    Promise.all([
      isEnabled().catch(() => false),
      invoke<WatchedFolder[]>("get_watched_folders_list").catch(() => []),
      loadAPIKeys(),
      loadPermissions(),
      loadTheme(),
      loadBubbleColors(),
      loadAutoUpdateSetting(),
      loadLockedTools(),
    ])
      .then(([autoStartEnabled, folders, keys, perms, theme, colors, autoUpdateEnabled, locked]) => {
        setAutoStart(autoStartEnabled);
        setWatchedFolders(folders);
        setApiKeys(keys);
        if (perms) setPermissions(perms);
        if (theme) setCurrentTheme(theme);
        if (colors) setBubbleColors(colors);
        setAutoUpdate(autoUpdateEnabled);
        setLockedTools(locked);
        // 활성 provider/model 로드 (저장된 게 있으면 채팅 전환에 사용)
        const savedProvider = localStorage.getItem(LS_ACTIVE_PROVIDER) || "claude";
        const savedModel = localStorage.getItem(LS_ACTIVE_MODEL) || "default";
        setChatProvider(savedProvider);
        setChatModel(savedModel);
        setActiveProvider(savedProvider);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [open]);

  // 활성 provider/model 저장
  // App.tsx 가 같은 탭의 변경을 받기 위해 'kda-active-changed' custom 이벤트도 발행.
  // (브라우저 'storage' 이벤트는 같은 탭에선 발화 안 함)
  function saveActiveProvider(providerId: string, modelId: string) {
    setChatProvider(providerId);
    setChatModel(modelId);
    localStorage.setItem(LS_ACTIVE_PROVIDER, providerId);
    localStorage.setItem(LS_ACTIVE_MODEL, modelId);
    try {
      window.dispatchEvent(new Event("kda-active-changed"));
    } catch {
      // ignore — 발행 실패해도 저장은 됐고 다음 새로고침이면 반영됨
    }
  }

  // provider 바꾸면 해당 provider 의 첫 모델로 자동 선택
  function selectActiveProvider(providerId: string) {
    const provider = API_PROVIDERS.find((p) => p.id === providerId);
    const firstModel = provider?.models[0]?.id ?? "default";
    saveActiveProvider(providerId, firstModel);
  }

  // API 키 로드 (localStorage에서)
  async function loadAPIKeys(): Promise<Record<string, string>> {
    try {
      const stored = localStorage.getItem("kda_api_keys");
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (e) {
      console.error("API 키 로드 실패:", e);
    }
    return {};
  }

  // 권한 설정 로드
  // 스키마 버전 2 (2026-04-30): file_write/file_delete/app_launch/system_control 기본값을 ask → auto 로 승급.
  // 옛 저장본을 가진 사용자는 한 번만 자동 마이그레이션 (이후 K가 직접 다시 ask 로 잠그면 그 값 유지).
  async function loadPermissions(): Promise<AgentPermission[] | null> {
    const SCHEMA_KEY = "kda_permissions_schema_version";
    const CURRENT_SCHEMA = "2";
    const AUTO_UPGRADE_IDS = new Set([
      "file_write",
      "file_delete",
      "app_launch",
      "system_control",
    ]);
    try {
      const stored = localStorage.getItem("kda_permissions");
      const version = localStorage.getItem(SCHEMA_KEY);
      if (!stored) {
        // 첫 실행 — 그대로 DEFAULT_PERMISSIONS 사용. 버전 마킹.
        localStorage.setItem(SCHEMA_KEY, CURRENT_SCHEMA);
        return null;
      }
      const parsed: AgentPermission[] = JSON.parse(stored);
      if (version !== CURRENT_SCHEMA) {
        // 1회 마이그레이션: 위 4개가 "ask" 면 "auto" 로 승급.
        const migrated = parsed.map((p) =>
          AUTO_UPGRADE_IDS.has(p.id) && p.level === "ask"
            ? { ...p, level: "auto" as const }
            : p,
        );
        localStorage.setItem("kda_permissions", JSON.stringify(migrated));
        localStorage.setItem(SCHEMA_KEY, CURRENT_SCHEMA);
        return migrated;
      }
      return parsed;
    } catch (e) {
      console.error("권한 설정 로드 실패:", e);
    }
    return null;
  }

  // 정밀 잠금 도구 목록 로드
  async function loadLockedTools(): Promise<Set<string>> {
    try {
      const stored = localStorage.getItem(LS_LOCKED_TOOLS);
      if (stored) {
        const arr = JSON.parse(stored);
        if (Array.isArray(arr)) {
          return new Set(arr.filter((t: unknown): t is string => typeof t === "string"));
        }
      }
    } catch (e) {
      console.error("정밀 잠금 도구 로드 실패:", e);
    }
    return new Set();
  }

  // 도구 1개 잠금 토글 (즉시 저장 — sidecar 는 다음 메시지부터 반영)
  function toggleLockTool(toolName: string) {
    const next = new Set(lockedTools);
    if (next.has(toolName)) {
      next.delete(toolName);
    } else {
      next.add(toolName);
    }
    setLockedTools(next);
    localStorage.setItem(LS_LOCKED_TOOLS, JSON.stringify([...next]));
  }

  // 카테고리 전체 잠금/해제 (한 번에 토글)
  function toggleLockCategory(category: ToolCategory, lock: boolean) {
    const next = new Set(lockedTools);
    for (const tool of category.tools) {
      if (lock) {
        next.add(tool.name);
      } else {
        next.delete(tool.name);
      }
    }
    setLockedTools(next);
    localStorage.setItem(LS_LOCKED_TOOLS, JSON.stringify([...next]));
  }

  // 모든 잠금 해제
  function clearAllLocks() {
    setLockedTools(new Set());
    localStorage.setItem(LS_LOCKED_TOOLS, JSON.stringify([]));
  }

  // 카테고리 펼침 토글
  function toggleExpand(permId: string) {
    const next = new Set(expandedCategories);
    if (next.has(permId)) {
      next.delete(permId);
    } else {
      next.add(permId);
    }
    setExpandedCategories(next);
  }

  // 테마 로드
  async function loadTheme(): Promise<string | null> {
    try {
      const stored = localStorage.getItem("kda_theme");
      if (stored) {
        return stored;
      }
    } catch (e) {
      console.error("테마 로드 실패:", e);
    }
    return null;
  }

  // 말풍선 색상 로드
  async function loadBubbleColors(): Promise<typeof bubbleColors | null> {
    try {
      const stored = localStorage.getItem("kda_bubble_colors");
      if (stored) {
        const colors = JSON.parse(stored);
        // CSS 변수 적용
        applyBubbleColors(colors);
        return colors;
      }
    } catch (e) {
      console.error("말풍선 색상 로드 실패:", e);
    }
    return null;
  }

  // 말풍선 색상 적용
  function applyBubbleColors(colors: typeof bubbleColors) {
    document.documentElement.style.setProperty("--bubble-user-bg", colors.userBg);
    document.documentElement.style.setProperty("--bubble-user-border", colors.userBorder);
    document.documentElement.style.setProperty("--bubble-assistant-bg", colors.assistantBg);
    document.documentElement.style.setProperty("--bubble-assistant-border", colors.assistantBorder);
  }

  // 말풍선 색상 저장
  function saveBubbleColors(colors: typeof bubbleColors) {
    setBubbleColors(colors);
    localStorage.setItem("kda_bubble_colors", JSON.stringify(colors));
    applyBubbleColors(colors);
  }

  // 말풍선 색상 변경 핸들러
  function handleBubbleColorChange(key: keyof typeof bubbleColors, hexColor: string) {
    // HEX를 RGB로 변환
    const r = parseInt(hexColor.slice(1, 3), 16);
    const g = parseInt(hexColor.slice(3, 5), 16);
    const b = parseInt(hexColor.slice(5, 7), 16);
    const rgbValue = `${r}, ${g}, ${b}`;

    const newColors = { ...bubbleColors, [key]: rgbValue };
    saveBubbleColors(newColors);
  }

  // RGB 문자열을 HEX로 변환 (컬러 피커용)
  function rgbToHex(rgb: string): string {
    const parts = rgb.split(",").map(p => parseInt(p.trim()));
    if (parts.length !== 3) return "#4FE8E1";
    const [r, g, b] = parts;
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  }

  // 자동 업데이트 설정 로드
  async function loadAutoUpdateSetting(): Promise<boolean> {
    try {
      const stored = localStorage.getItem("kda_auto_update");
      if (stored !== null) {
        return stored === "true";
      }
    } catch (e) {
      console.error("자동 업데이트 설정 로드 실패:", e);
    }
    return true; // 기본값: 활성화
  }

  // 자동 업데이트 토글
  function toggleAutoUpdate() {
    const newValue = !autoUpdate;
    setAutoUpdate(newValue);
    localStorage.setItem("kda_auto_update", String(newValue));
  }

  // Phase 59 — Anthropic rate polling 초기값 로드 (~/.kda/sidecar-config.json).
  // open 이 true 가 될 때 한 번 invoke. 토글 자체는 file write + sidecar 재시작 안내.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    invoke<Record<string, unknown>>("get_sidecar_config")
      .then((cfg) => {
        if (cancelled) return;
        const v = cfg?.anthropicRatePollingEnabled;
        // 기본값 true (sidecar 의 readSidecarConfig 와 동기화)
        setAnthropicRatePolling(typeof v === "boolean" ? v : true);
        // Phase 80 (v0.6.24): finalReviewGateEnabled 도 같이 로드
        const g = cfg?.finalReviewGateEnabled;
        setFinalReviewGate(typeof g === "boolean" ? g : true);
      })
      .catch((err) => {
        console.error("get_sidecar_config failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function toggleAnthropicRatePolling() {
    if (anthropicRatePollingBusy) return;
    const newValue = !anthropicRatePolling;
    setAnthropicRatePollingBusy(true);
    setAnthropicRatePolling(newValue); // optimistic
    try {
      await invoke("set_sidecar_config_flag", {
        key: "anthropicRatePollingEnabled",
        value: newValue,
      });
      setSidecarReloadHint(true);
    } catch (err) {
      console.error("set_sidecar_config_flag failed:", err);
      setAnthropicRatePolling(!newValue); // 롤백
    } finally {
      setAnthropicRatePollingBusy(false);
    }
  }

  // Phase 80 (v0.6.24): Final-Review Gate toggle. sidecar 재시작 불필요 (frontend 가 매번 invoke).
  async function toggleFinalReviewGate() {
    if (finalReviewGateBusy) return;
    const newValue = !finalReviewGate;
    setFinalReviewGateBusy(true);
    setFinalReviewGate(newValue);
    try {
      await invoke("set_sidecar_config_flag", {
        key: "finalReviewGateEnabled",
        value: newValue,
      });
    } catch (err) {
      console.error("set_sidecar_config_flag (finalReviewGate) failed:", err);
      setFinalReviewGate(!newValue);
    } finally {
      setFinalReviewGateBusy(false);
    }
  }

  async function handleReloadSidecarNow() {
    try {
      await invoke("reload_sidecar");
      setSidecarReloadHint(false);
    } catch (err) {
      console.error("reload_sidecar failed:", err);
    }
  }

  // 업데이트 확인
  async function checkForUpdate() {
    setUpdateStatus("checking");
    setUpdateError(null);
    setUpdateVersion(null);

    try {
      const update = await check();
      if (update) {
        setUpdateStatus("available");
        setUpdateVersion(update.version);
      } else {
        setUpdateStatus("latest");
      }
    } catch (e) {
      setUpdateStatus("error");
      setUpdateError(e instanceof Error ? e.message : "업데이트 확인 실패");
    }
  }

  // 업데이트 다운로드 및 설치
  async function downloadAndInstallUpdate() {
    setUpdateStatus("downloading");
    setUpdateError(null);
    setUpdateProgress(0);

    let totalSize = 0;
    let downloaded = 0;

    try {
      const update = await check();
      if (!update) {
        setUpdateStatus("latest");
        return;
      }

      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          const data = event.data as { contentLength?: number };
          totalSize = data.contentLength || 0;
          setUpdateProgress(0);
        } else if (event.event === "Progress") {
          const data = event.data as { chunkLength: number };
          downloaded += data.chunkLength;
          if (totalSize > 0) {
            setUpdateProgress(Math.round((downloaded / totalSize) * 100));
          }
        } else if (event.event === "Finished") {
          setUpdateProgress(100);
        }
      });

      // 설치 완료 후 재시작
      await relaunch();
    } catch (e) {
      setUpdateStatus("error");
      setUpdateError(e instanceof Error ? e.message : "업데이트 설치 실패");
    }
  }

  // API 키 저장
  async function saveAPIKey(providerId: string, key: string) {
    setSavingKey(providerId);
    try {
      const newKeys = { ...apiKeys, [providerId]: key };
      setApiKeys(newKeys);
      localStorage.setItem("kda_api_keys", JSON.stringify(newKeys));

      // 환경 변수로도 설정 (Rust 백엔드에 전달)
      const provider = API_PROVIDERS.find(p => p.id === providerId);
      if (provider) {
        await invoke("set_env_var", {
          name: provider.keyName,
          value: key
        }).catch(() => {
          // 명령이 없으면 무시 (나중에 구현)
        });
      }
    } catch (e) {
      console.error("API 키 저장 실패:", e);
    } finally {
      setSavingKey(null);
    }
  }

  // API 키 삭제
  async function removeAPIKey(providerId: string) {
    const newKeys = { ...apiKeys };
    delete newKeys[providerId];
    setApiKeys(newKeys);
    localStorage.setItem("kda_api_keys", JSON.stringify(newKeys));
  }

  // Claude Code CLI OAuth 로그인 — 별도 콘솔 창에서 `claude login` 실행
  async function handleClaudeLogin() {
    setLoginStatus("running");
    setLoginError(null);
    try {
      await invoke("run_claude_login");
      // 콘솔 창은 열렸지만 K 가 OAuth 진행하는 동안 status 는 running 으로 둠.
      // 5초 후 idle 로 복귀 (어차피 콘솔 창에서 결과 확인하므로 UI 는 가벼운 안내만).
      setTimeout(() => setLoginStatus("idle"), 5000);
    } catch (e) {
      setLoginStatus("error");
      setLoginError(typeof e === "string" ? e : (e as Error)?.message || "알 수 없는 오류");
    }
  }

  // Phase 15 — Codex 인증 상태 한 번 조회 + 주기 poll (Settings 열려 있는 동안만)
  async function refreshCodexAuth() {
    try {
      const status = await invoke<{
        authenticated: boolean;
        cli_available: boolean;
        auth_path: string;
      }>("codex_login_status");
      setCodexAuth(status);
    } catch (e) {
      setCodexAuth({
        authenticated: false,
        cli_available: false,
        auth_path: typeof e === "string" ? e : "",
      });
    }
  }

  // Settings 열릴 때 codex 인증 상태 로드 + login 진행 중이면 짧은 주기 poll
  useEffect(() => {
    if (!open) return;
    refreshCodexAuth();
    if (codexLoginStatus !== "running") return;
    const handle = setInterval(refreshCodexAuth, 3000);
    return () => clearInterval(handle);
  }, [open, codexLoginStatus]);

  // Codex 인증 — 백그라운드 codex login spawn (시스템 브라우저 자동 열림)
  async function handleCodexLogin() {
    setCodexLoginStatus("running");
    setCodexLoginError(null);
    try {
      await invoke("codex_login");
      // codex login 은 K 가 브라우저에서 OAuth 끝낼 때까지 시간이 걸림.
      // poll 효과는 위 useEffect 가 처리. 60초 후 자동 idle 복귀 (그 사이 인증 완료 시
      // refreshCodexAuth 가 authenticated=true 로 표시).
      setTimeout(() => {
        setCodexLoginStatus((prev) => (prev === "running" ? "idle" : prev));
        refreshCodexAuth();
      }, 60_000);
    } catch (e) {
      setCodexLoginStatus("error");
      setCodexLoginError(typeof e === "string" ? e : (e as Error)?.message || "알 수 없는 오류");
    }
  }

  // Codex 에 K-Personal MCP 등록 — codex mcp add 한 번 실행 (idempotent — 이미 있으면 ok 메시지)
  async function handleCodexRegisterMcp() {
    setCodexMcpRegistering(true);
    setCodexMcpResult(null);
    try {
      const result = await invoke<string>("codex_register_mcp");
      setCodexMcpResult(result || "✓ 등록 완료");
    } catch (e) {
      setCodexMcpResult("⚠ " + (typeof e === "string" ? e : (e as Error)?.message || "등록 실패"));
    } finally {
      setCodexMcpRegistering(false);
    }
  }

  // 외부 URL 을 새 webview 창으로 — Tauri command open_external_webview
  async function openExternalUsage(page: ExternalUsagePage) {
    setWebviewOpening(page.id);
    try {
      await invoke("open_external_webview", {
        url: page.url,
        label: page.label,
        title: page.title,
      });
    } catch (e) {
      console.error("open_external_webview failed:", e);
    } finally {
      // 짧은 시간 후 idle (UX feedback 용)
      setTimeout(() => setWebviewOpening(null), 800);
    }
  }

  // 권한 레벨 변경
  function updatePermission(permId: string, level: PermissionLevel) {
    const updated = permissions.map(p =>
      p.id === permId ? { ...p, level } : p
    );
    setPermissions(updated);
    localStorage.setItem("kda_permissions", JSON.stringify(updated));
  }

  // 테마 변경
  function changeTheme(themeId: string) {
    const theme = THEMES.find(t => t.id === themeId);
    if (!theme) return;

    setCurrentTheme(themeId);
    localStorage.setItem("kda_theme", themeId);

    // CSS 변수 업데이트
    document.documentElement.style.setProperty("--accent-rgb", theme.accent);
    document.documentElement.style.setProperty("--bg-rgb", theme.background);
    document.documentElement.style.setProperty("--accent", `rgb(${theme.accent})`);
    document.documentElement.style.setProperty("--accent-glow", `rgba(${theme.accent}, 0.35)`);
    document.documentElement.style.setProperty("--accent-strong-glow", `rgba(${theme.accent}, 0.5)`);
    document.documentElement.style.setProperty("--accent-dim", `rgba(${theme.accent}, 0.4)`);
    document.documentElement.style.setProperty("--bg-0", `rgb(${theme.background})`);
  }

  // 앱 시작 시 저장된 테마 및 말풍선 색상 적용
  useEffect(() => {
    const savedTheme = localStorage.getItem("kda_theme");
    if (savedTheme) {
      changeTheme(savedTheme);
    }

    const savedBubbleColors = localStorage.getItem("kda_bubble_colors");
    if (savedBubbleColors) {
      try {
        const colors = JSON.parse(savedBubbleColors);
        applyBubbleColors(colors);
      } catch {
        // ignore
      }
    }
  }, []);

  async function toggleAutoStart() {
    setLoading(true);
    try {
      if (autoStart) {
        await disable();
        setAutoStart(false);
      } else {
        await enable();
        setAutoStart(true);
      }
    } catch (e) {
      console.error("autostart toggle failed:", e);
    } finally {
      setLoading(false);
    }
  }

  async function handleReload() {
    setReloading(true);
    try {
      await invoke("reload_sidecar");
      setTimeout(() => setReloading(false), 2000);
    } catch (e) {
      console.error("reload failed:", e);
      setReloading(false);
    }
  }

  async function handleQuit() {
    try {
      await invoke("quit_app");
    } catch {
      // ignore
    }
  }

  // ─── 안전장치 (백업/복구) 핸들러 ───────────────────────────
  async function handleBackupNow() {
    setBackupBusy("backing-up");
    setBackupError(null);
    try {
      const info = await invoke<BackupInfo>("backup_now", { label: "settings-ui" });
      setLatestBackup(info);
    } catch (e) {
      console.error("backup_now 실패:", e);
      setBackupError(String(e));
    } finally {
      setBackupBusy("idle");
    }
  }

  async function handleRollback() {
    // 1차 확인은 showRollbackConfirm state 로 이미 받음.
    setBackupBusy("rolling-back");
    setBackupError(null);
    try {
      await invoke("rollback_now");
      // 이 시점부터 backend 가 0.5초 뒤 자기 자신 종료 → rollback.ps1 가 옛 바이너리로 재기동.
      // UI 는 아무것도 더 못 함 (프로세스가 곧 죽음). 사용자에게 한 줄 안내.
      setShowRollbackConfirm(false);
    } catch (e) {
      console.error("rollback_now 실패:", e);
      setBackupError(String(e));
      setBackupBusy("idle");
    }
  }

  // ─── Phase 18 — 의존성 자동 셋업 핸들러 ───
  async function handleCheckDeps() {
    setDepsBusy("checking");
    setDepsError(null);
    try {
      const json = await invoke<string>("check_dependencies");
      setDepsResult(JSON.parse(json) as DepsResult);
    } catch (e) {
      setDepsError(String(e));
    } finally {
      setDepsBusy("idle");
    }
  }

  async function handleInstallDeps() {
    setDepsBusy("installing");
    setDepsError(null);
    try {
      // install-deps.ps1 은 winget 호출 → 필요 시 UAC 자동. 길게 걸릴 수 있어
      // K 한테는 spinner 만 보여주고 결과 도착 시 갱신.
      const json = await invoke<string>("run_install_deps");
      setDepsResult(JSON.parse(json) as DepsResult);
    } catch (e) {
      setDepsError(String(e));
    } finally {
      setDepsBusy("idle");
    }
  }

  // Phase 66 (v0.6.1) — K-Personal MCP 자동 설치 핸들러
  async function handleInstallKpersonalMCP() {
    setKpmcpBusy("installing");
    setKpmcpError(null);
    try {
      const json = await invoke<string>("install_kpersonal_mcp");
      const parsed = JSON.parse(json) as KpmcpResult;
      setKpmcpResult(parsed);

      // Phase 66.8 (v0.6.9) — alreadyInstalled 여도 reload_sidecar 호출.
      //
      // 배경: v0.6.8 의 install-kpersonal-mcp.ps1 은 alreadyInstalled path 에서도
      // ~/.kda/kpersonal-mcp-path.txt cache 를 새로 박음 (KnownFolder API 의 정확한 결과).
      // 그런데 sidecar 는 KDA 부팅 시 한 번만 cache 읽으므로, 이미 시작된 sidecar 는
      // 새 cache 못 읽어 server.py 못 찾는 상태 그대로 유지 → MCP 도구 0개.
      //
      // K 보고: v0.6.8 받은 후 버튼 누름 → alreadyInstalled=true + cache 박힘 ✓
      // → 하지만 sidecar 재시작 안 됨 → 도구 탭 여전히 빈 상태.
      //
      // Fix: success 여부만 보고 reload (alreadyInstalled 분기 제거). reload 자체 cost
      // 는 작고 (몇 초), idempotent. 이미 정상이면 같은 도구가 다시 보일 뿐.
      if (parsed.success) {
        try {
          await invoke("reload_sidecar");
        } catch (e) {
          console.warn("sidecar 재시작 실패 (수동 재시작 필요):", e);
        }
      }
    } catch (e) {
      setKpmcpError(String(e));
    } finally {
      setKpmcpBusy("idle");
    }
  }

  // ─── Phase 67a (v0.6.2) — MCP 도구 인스펙터 핸들러 ──────────
  //
  // sidecar 의 mcp_tools event 를 listen + invoke("list_mcp_tools") 로 갱신.
  // 호출 패턴: 탭이 활성화될 때 자동 + "새로고침" 버튼.
  async function requestMcpToolsRefresh(refresh = false) {
    setMcpToolsBusy(true);
    setMcpToolsError(null);
    try {
      await invoke("list_mcp_tools", { refresh });
      // 응답은 sidecar event listener 가 받아 setMcpTools 호출.
      // 5초 안 오면 timeout 으로 busy 해제 (UI 멈춤 회피).
      //
      // Phase 68 (v0.6.12) — timeout 시 단순 busy 해제만 하지 말고:
      //   - mcpTools 가 아직 null = 응답 한 번도 안 받음 → friendly warning + 재시도 안내
      //   - mcpTools 가 이미 있음 = 이미 받았던 cache 유지 (busy 만 해제)
      //
      // 옛 binary (v0.6.11 이하) 의 KDA 에선 list_mcp_tools Rust command 가 invoke 단계에서 throw —
      // 위 catch 로 잡혀 안 옴. 여기 timeout 경로는 sidecar 가 죽었거나 응답이 안 오는 케이스.
      setTimeout(() => {
        setMcpToolsBusy(false);
        // setMcpTools 가 다른 render 사이클에서 바뀔 수 있어 setter 함수 형태로 검사.
        setMcpTools((current) => {
          if (current === null) {
            setMcpToolsError(
              "sidecar 가 5초 안에 응답하지 않았습니다. KDA 의 'Settings → 시스템 → 지금 sidecar 재시작' 클릭 후 다시 시도하세요.",
            );
          }
          return current; // mutation 없음
        });
      }, 5000);
    } catch (e) {
      setMcpToolsError(String(e));
      setMcpToolsBusy(false);
    }
  }

  // ─── Phase 67c (v0.6.2) — 커스텀 plugin 빌더 핸들러 ──────────
  async function refreshPluginList() {
    try {
      const list = await invoke<PluginInfo[]>("list_kda_plugins");
      setPluginList(list);
      setPluginListError(null);
    } catch (e) {
      setPluginListError(String(e));
    }
  }

  function openNewPluginEditor() {
    setEditorMode("new");
    setEditorName("");
    setEditorCode(KDA_PLUGIN_TEMPLATE);
    setEditorMessage(null);
    setBuilderRequest("");
    setEditorOpen(true);
  }

  async function openEditPluginEditor(file: string) {
    try {
      const code = await invoke<string>("read_kda_plugin", { file });
      setEditorMode("edit");
      // 파일명에서 .py 제거 후 이름으로
      setEditorName(file.replace(/\.py$/, ""));
      setEditorCode(code);
      setEditorMessage(null);
      setBuilderRequest("");
      setEditorOpen(true);
    } catch (e) {
      setEditorMessage(`불러오기 실패: ${e}`);
    }
  }

  async function handleSavePlugin() {
    setEditorBusy(true);
    setEditorMessage(null);
    try {
      const name = editorName.trim();
      if (!name) {
        setEditorMessage("plugin 이름이 비어있습니다.");
        setEditorBusy(false);
        return;
      }
      const result = await invoke<string>("save_kda_plugin", {
        name,
        code: editorCode,
      });
      setEditorMessage(`✓ ${result}`);
      // 저장 후 sidecar 자동 재시작 (Rust 측에서) → 도구 list 도 곧 새로고침
      setTimeout(() => {
        refreshPluginList();
        requestMcpToolsRefresh(true);
      }, 2500);
    } catch (e) {
      setEditorMessage(`✗ 저장 실패: ${e}`);
    } finally {
      setEditorBusy(false);
    }
  }

  async function handleDeletePlugin(file: string) {
    if (!confirm(`정말 plugin '${file}' 를 삭제할까요?\n\n.deleted.bak 으로 1회 백업이 남으니 K-Personal-MCP/modules/kda_plugins/ 에서 복구 가능합니다.`)) {
      return;
    }
    try {
      const msg = await invoke<string>("delete_kda_plugin", { file });
      setEditorMessage(`✓ ${msg}`);
      setTimeout(() => {
        refreshPluginList();
        requestMcpToolsRefresh(true);
      }, 2500);
    } catch (e) {
      setEditorMessage(`✗ 삭제 실패: ${e}`);
    }
  }

  // 채팅으로 코드 자동 제안 — Composer 에 prompt 흘려보내고 K 가 응답을 textarea 로 복사하는 흐름.
  // KDA 의 메인 채팅 창에 "이런 도구 만들어줘" prompt 박는 게 가장 자연스러움 (보안 검토 + K 가 직접 코드 확인).
  function handleAskModelToBuild() {
    if (!builderRequest.trim()) return;
    const prompt = [
      "K-Personal-MCP 의 커스텀 plugin 으로 박을 Python 코드를 작성해줘.",
      "",
      "요구 사항:",
      `  • ${builderRequest}`,
      "",
      "규칙:",
      "  • 파일은 modules/kda_plugins/kda_<name>.py 에 박힐 거야 (kda_ prefix 필수)",
      "  • get_tools() -> list[Tool] 과 async handle_tool(name, arguments) -> list 두 함수 export",
      "  • 도구 이름도 kda_ prefix",
      "  • mcp.types 의 Tool / TextContent 만 import",
      "  • 외부 의존성 추가 시 K 가 별도로 pip install 해야 한다는 점 명시",
      "  • 위험 코드 (os.system, subprocess.run, eval, exec, urllib unsafe) 사용 시 명시",
      "",
      "응답은 코드 블록 하나로 — 그 내용 그대로 modules/kda_plugins/ 에 박을 거야.",
    ].join("\n");
    try {
      // 같은 Tauri window 의 main chat 으로 이 prompt 를 흘리는 이벤트 발행.
      // Composer 가 listen 해서 textarea 에 박음. Settings 모달은 자동 닫기 — K 가 채팅 영역을 봐야 응답을 받음.
      window.dispatchEvent(
        new CustomEvent("kda-builder-prompt", { detail: { prompt } })
      );
      setEditorMessage("✓ 메인 채팅에 prompt 박았습니다. Settings 닫고 응답 받은 후 코드 블록 복사 → Settings 다시 열어 textarea 에 붙여넣기.");
      // 모달 닫기 + 다시 열렸을 때 같은 에디터 상태 복원될 수 있게 editorOpen 은 유지
      setTimeout(() => {
        try { onClose(); } catch {}
      }, 400);
    } catch (e) {
      setEditorMessage(`✗ prompt 발송 실패: ${e}`);
    }
  }

  async function handleMarkFirstRunComplete() {
    try {
      await invoke("mark_first_run_complete");
      setIsFirstRun(false);
    } catch (e) {
      console.error("mark_first_run_complete 실패:", e);
    }
  }

  // 백업 시각 yyyy-MM-dd HH:mm:ss 로 표시 (timestamp = "yyyyMMdd-HHmmss")
  function formatBackupTime(ts: string): string {
    const m = ts.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
    if (!m) return ts;
    return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  }
  function formatBytes(n: number | undefined): string {
    if (!n) return "—";
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} bytes`;
  }

  async function handleAddWatchFolder() {
    setAddingFolder(true);
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "감시할 폴더 선택",
      });

      if (selected && typeof selected === "string") {
        await invoke("watch_folder", { path: selected, recursive: true });
        const folders = await invoke<WatchedFolder[]>("get_watched_folders_list");
        setWatchedFolders(folders);
      }
    } catch (e) {
      console.error("폴더 추가 실패:", e);
    } finally {
      setAddingFolder(false);
    }
  }

  async function handleRemoveWatchFolder(path: string) {
    try {
      await invoke("unwatch_folder", { path });
      setWatchedFolders((prev) => prev.filter((f) => f.path !== path));
    } catch (e) {
      console.error("폴더 제거 실패:", e);
    }
  }

  // 권한 레벨 라벨
  function getPermissionLabel(level: PermissionLevel): string {
    switch (level) {
      case "auto": return "자동 승인";
      case "ask": return "매번 확인";
      case "manual": return "수동만";
    }
  }

  // 권한 레벨 순환
  function cyclePermissionLevel(current: PermissionLevel): PermissionLevel {
    switch (current) {
      case "auto": return "ask";
      case "ask": return "manual";
      case "manual": return "auto";
    }
  }

  if (!open) return null;

  const currentProvider = API_PROVIDERS.find(p => p.id === activeProvider);

  // 카테고리별 권한 그룹화
  const permissionsByCategory = {
    file: permissions.filter(p => p.category === "file"),
    system: permissions.filter(p => p.category === "system"),
    input: permissions.filter(p => p.category === "input"),
    network: permissions.filter(p => p.category === "network"),
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <CornerBrackets corners={["tl", "tr", "bl", "br"]} size={12} />

        <div className="settings-header">
          <div>
            <div className="eyebrow">설정</div>
            <h2 className="display settings-title">환경설정</h2>
          </div>
          <button className="settings-close" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </div>

        {/* Phase 16: 5개 탭 nav — 16 섹션이 5 그룹으로 분리됨 */}
        <nav className="settings-tabs" role="tablist" aria-label="환경설정 탭">
          {SETTINGS_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`settings-tabpanel-${tab.id}`}
              className={`settings-tab ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="settings-tab-icon" aria-hidden="true">
                {tab.icon}
              </span>
              <span className="settings-tab-label">{tab.label}</span>
            </button>
          ))}
        </nav>

        <div
          className="settings-body"
          data-active-tab={activeTab}
          role="tabpanel"
          id={`settings-tabpanel-${activeTab}`}
        >
          {/* UI 테마 섹션 */}
          <section className="settings-section" data-tab="appearance">
            <div className="eyebrow">테마</div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-info">
                <div className="settings-row-title">UI 테마</div>
                <div className="settings-row-desc">
                  앱의 색상 테마를 선택합니다
                </div>
              </div>
              <div className="theme-grid">
                {THEMES.map((theme) => (
                  <button
                    key={theme.id}
                    className={`theme-card ${currentTheme === theme.id ? "active" : ""}`}
                    onClick={() => changeTheme(theme.id)}
                  >
                    <div
                      className="theme-preview"
                      style={{ backgroundColor: theme.preview }}
                    />
                    <span className="theme-name">{theme.name}</span>
                    {currentTheme === theme.id && (
                      <span className="theme-check">✓</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* 말풍선 색상 섹션 */}
          <section className="settings-section" data-tab="appearance">
            <div className="eyebrow">말풍선 색상</div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-info">
                <div className="settings-row-title">채팅 말풍선 커스터마이징</div>
                <div className="settings-row-desc">
                  사용자와 AI의 말풍선 색상을 원하는 대로 변경합니다
                </div>
              </div>

              <div className="bubble-color-grid">
                {/* 사용자 말풍선 */}
                <div className="bubble-color-section">
                  <div className="bubble-color-title">👤 내 메시지</div>
                  <div className="bubble-color-row">
                    <span className="bubble-color-label">배경색</span>
                    <input
                      type="color"
                      className="bubble-color-picker"
                      value={rgbToHex(bubbleColors.userBg)}
                      onChange={(e) => handleBubbleColorChange("userBg", e.target.value)}
                    />
                    <span className="bubble-color-hex mono">{rgbToHex(bubbleColors.userBg)}</span>
                  </div>
                  <div className="bubble-color-row">
                    <span className="bubble-color-label">테두리</span>
                    <input
                      type="color"
                      className="bubble-color-picker"
                      value={rgbToHex(bubbleColors.userBorder)}
                      onChange={(e) => handleBubbleColorChange("userBorder", e.target.value)}
                    />
                    <span className="bubble-color-hex mono">{rgbToHex(bubbleColors.userBorder)}</span>
                  </div>
                  <div
                    className="bubble-preview bubble-preview-user"
                    style={{
                      background: `linear-gradient(180deg, rgba(${bubbleColors.userBg}, 0.15) 0%, rgba(${bubbleColors.userBg}, 0.06) 100%)`,
                      borderColor: `rgba(${bubbleColors.userBorder}, 0.25)`,
                    }}
                  >
                    미리보기 텍스트
                  </div>
                </div>

                {/* AI 말풍선 */}
                <div className="bubble-color-section">
                  <div className="bubble-color-title">🤖 AI 메시지</div>
                  <div className="bubble-color-row">
                    <span className="bubble-color-label">배경색</span>
                    <input
                      type="color"
                      className="bubble-color-picker"
                      value={rgbToHex(bubbleColors.assistantBg)}
                      onChange={(e) => handleBubbleColorChange("assistantBg", e.target.value)}
                    />
                    <span className="bubble-color-hex mono">{rgbToHex(bubbleColors.assistantBg)}</span>
                  </div>
                  <div className="bubble-color-row">
                    <span className="bubble-color-label">테두리</span>
                    <input
                      type="color"
                      className="bubble-color-picker"
                      value={rgbToHex(bubbleColors.assistantBorder)}
                      onChange={(e) => handleBubbleColorChange("assistantBorder", e.target.value)}
                    />
                    <span className="bubble-color-hex mono">{rgbToHex(bubbleColors.assistantBorder)}</span>
                  </div>
                  <div
                    className="bubble-preview bubble-preview-assistant"
                    style={{
                      background: `rgb(${bubbleColors.assistantBg})`,
                      borderColor: `rgb(${bubbleColors.assistantBorder})`,
                    }}
                  >
                    미리보기 텍스트
                  </div>
                </div>
              </div>

              <button
                className="settings-btn"
                onClick={() => {
                  const defaultColors = {
                    userBg: "79, 232, 225",
                    userBorder: "79, 232, 225",
                    assistantBg: "20, 27, 45",
                    assistantBorder: "28, 37, 55",
                  };
                  saveBubbleColors(defaultColors);
                }}
              >
                기본값으로 초기화
              </button>
            </div>
          </section>

          {/* 에이전트 권한 섹션 */}
          <section className="settings-section" data-tab="agent">
            <div className="eyebrow">에이전트 권한</div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-info">
                <div className="settings-row-title">기능별 실행 권한</div>
                <div className="settings-row-desc">
                  각 기능의 실행 방식을 설정합니다
                </div>
              </div>

              {/* 권한 게이트 동작 안내 — 실제 sidecar 가 토글을 반영함 (v0.4.1+) */}
              <div
                className="settings-row-info"
                style={{
                  padding: "10px 12px",
                  background: "rgba(79, 232, 225, 0.06)",
                  border: "1px solid rgba(79, 232, 225, 0.25)",
                  borderRadius: "6px",
                  marginBottom: "12px",
                  fontSize: "0.85em",
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: "4px" }}>
                  ✓ 권한 게이트 활성 (Claude Max 모드 한정)
                </div>
                <div style={{ opacity: 0.85, lineHeight: 1.55 }}>
                  • <strong>자동 승인</strong>: 도구를 자유롭게 호출합니다.<br />
                  • <strong>매번 확인</strong>: 도구 호출 전 모델이 K님께 한국어로
                  의도 설명 후 명시적 동의 (예: "응", "진행해")를 받아야만 실행합니다.
                  (sidecar 가 stdin 프로토콜이라 CLI interactive prompt 를 쓸 수 없어
                  모델 협조에 의존하는 <em>soft enforcement</em>.)<br />
                  • <strong>수동만</strong>: Claude CLI 의{" "}
                  <code>--disallowed-tools</code> 에 박혀 호출 자체가 거부됩니다 (hard).<br />
                  • <code>Bash</code> 는 파일 쓰기·삭제·앱 실행 셋이 모두{" "}
                  자동 승인일 때만 허용. 하나라도 ask/manual 이면 차단.<br />
                  • <code>Task</code>, <code>Monitor</code>, <code>Skill</code>,
                  <code> NotebookEdit</code> 같은 우회 통로는 항상 차단.<br />
                  • 더 세밀한 제어가 필요하면 아래 <strong>"정밀 잠금"</strong> 섹션에서
                  도구 단위로 잠그세요.<br />
                  • 외부 API (OpenAI/Gemini/OpenRouter/Anthropic) 모드는 도구 미지원이라
                  이 설정과 무관합니다.
                </div>
              </div>

              <div className="permissions-legend">
                <span className="perm-badge perm-auto">자동 승인</span>
                <span className="perm-badge perm-ask">매번 확인</span>
                <span className="perm-badge perm-manual">수동만</span>
              </div>

              {/* 파일 권한 */}
              <div className="permission-category">
                <div className="permission-category-title">📁 파일 관리</div>
                {permissionsByCategory.file.map((perm) => (
                  <div key={perm.id} className="permission-item">
                    <div className="permission-info">
                      <span className="permission-icon">{perm.icon}</span>
                      <div>
                        <div className="permission-name">
                          {perm.name}
                          {/* Phase 84 — 위험도 배지 (CATEGORY_RISK 기반). */}
                          {(() => {
                            const risk = riskOfCategory(perm.id);
                            const badge = RISK_BADGES[risk.level];
                            return (
                              <span
                                title={risk.summary}
                                style={{
                                  marginLeft: 8,
                                  fontSize: "0.7em",
                                  padding: "0.1em 0.5em",
                                  borderRadius: 4,
                                  background: `${badge.color}22`,
                                  border: `1px solid ${badge.color}66`,
                                  color: badge.color,
                                  fontWeight: 600,
                                  verticalAlign: "middle",
                                }}
                              >
                                {badge.icon} {badge.label}
                              </span>
                            );
                          })()}
                        </div>
                        <div className="permission-desc">{perm.description}</div>
                      </div>
                    </div>
                    <button
                      className={`perm-toggle perm-${perm.level}`}
                      onClick={() => updatePermission(perm.id, cyclePermissionLevel(perm.level))}
                    >
                      {getPermissionLabel(perm.level)}
                    </button>
                  </div>
                ))}
              </div>

              {/* 시스템 권한 */}
              <div className="permission-category">
                <div className="permission-category-title">⚙️ 시스템</div>
                {permissionsByCategory.system.map((perm) => (
                  <div key={perm.id} className="permission-item">
                    <div className="permission-info">
                      <span className="permission-icon">{perm.icon}</span>
                      <div>
                        <div className="permission-name">
                          {perm.name}
                          {/* Phase 84 — 위험도 배지 (CATEGORY_RISK 기반). */}
                          {(() => {
                            const risk = riskOfCategory(perm.id);
                            const badge = RISK_BADGES[risk.level];
                            return (
                              <span
                                title={risk.summary}
                                style={{
                                  marginLeft: 8,
                                  fontSize: "0.7em",
                                  padding: "0.1em 0.5em",
                                  borderRadius: 4,
                                  background: `${badge.color}22`,
                                  border: `1px solid ${badge.color}66`,
                                  color: badge.color,
                                  fontWeight: 600,
                                  verticalAlign: "middle",
                                }}
                              >
                                {badge.icon} {badge.label}
                              </span>
                            );
                          })()}
                        </div>
                        <div className="permission-desc">{perm.description}</div>
                      </div>
                    </div>
                    <button
                      className={`perm-toggle perm-${perm.level}`}
                      onClick={() => updatePermission(perm.id, cyclePermissionLevel(perm.level))}
                    >
                      {getPermissionLabel(perm.level)}
                    </button>
                  </div>
                ))}
              </div>

              {/* 입력 권한 */}
              <div className="permission-category">
                <div className="permission-category-title">🖱️ 입력 제어</div>
                {permissionsByCategory.input.map((perm) => (
                  <div key={perm.id} className="permission-item">
                    <div className="permission-info">
                      <span className="permission-icon">{perm.icon}</span>
                      <div>
                        <div className="permission-name">
                          {perm.name}
                          {/* Phase 84 — 위험도 배지 (CATEGORY_RISK 기반). */}
                          {(() => {
                            const risk = riskOfCategory(perm.id);
                            const badge = RISK_BADGES[risk.level];
                            return (
                              <span
                                title={risk.summary}
                                style={{
                                  marginLeft: 8,
                                  fontSize: "0.7em",
                                  padding: "0.1em 0.5em",
                                  borderRadius: 4,
                                  background: `${badge.color}22`,
                                  border: `1px solid ${badge.color}66`,
                                  color: badge.color,
                                  fontWeight: 600,
                                  verticalAlign: "middle",
                                }}
                              >
                                {badge.icon} {badge.label}
                              </span>
                            );
                          })()}
                        </div>
                        <div className="permission-desc">{perm.description}</div>
                      </div>
                    </div>
                    <button
                      className={`perm-toggle perm-${perm.level}`}
                      onClick={() => updatePermission(perm.id, cyclePermissionLevel(perm.level))}
                    >
                      {getPermissionLabel(perm.level)}
                    </button>
                  </div>
                ))}
              </div>

              {/* 네트워크 권한 */}
              <div className="permission-category">
                <div className="permission-category-title">🌐 네트워크</div>
                {permissionsByCategory.network.map((perm) => (
                  <div key={perm.id} className="permission-item">
                    <div className="permission-info">
                      <span className="permission-icon">{perm.icon}</span>
                      <div>
                        <div className="permission-name">
                          {perm.name}
                          {/* Phase 84 — 위험도 배지 (CATEGORY_RISK 기반). */}
                          {(() => {
                            const risk = riskOfCategory(perm.id);
                            const badge = RISK_BADGES[risk.level];
                            return (
                              <span
                                title={risk.summary}
                                style={{
                                  marginLeft: 8,
                                  fontSize: "0.7em",
                                  padding: "0.1em 0.5em",
                                  borderRadius: 4,
                                  background: `${badge.color}22`,
                                  border: `1px solid ${badge.color}66`,
                                  color: badge.color,
                                  fontWeight: 600,
                                  verticalAlign: "middle",
                                }}
                              >
                                {badge.icon} {badge.label}
                              </span>
                            );
                          })()}
                        </div>
                        <div className="permission-desc">{perm.description}</div>
                      </div>
                    </div>
                    <button
                      className={`perm-toggle perm-${perm.level}`}
                      onClick={() => updatePermission(perm.id, cyclePermissionLevel(perm.level))}
                    >
                      {getPermissionLabel(perm.level)}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* ─── 정밀 잠금 섹션 (개별 도구 단위 차단) ─────────────────── */}
          <section className="settings-section" data-tab="agent">
            <div className="eyebrow">정밀 잠금</div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-info">
                <div className="settings-row-title">개별 도구 잠금 ({lockedTools.size}개 잠김)</div>
                <div className="settings-row-desc">
                  카테고리 토글이 자동 승인이어도 여기서 체크한 도구는 호출 자체가 거부됩니다.
                  카테고리 단위로는 너무 거친 통제가 필요할 때 사용하세요.
                </div>
              </div>

              <div
                style={{
                  padding: "10px 12px",
                  background: "rgba(249, 115, 22, 0.06)",
                  border: "1px solid rgba(249, 115, 22, 0.25)",
                  borderRadius: "6px",
                  marginBottom: "12px",
                  fontSize: "0.85em",
                  lineHeight: 1.55,
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: "4px" }}>
                  💡 사용 예시
                </div>
                <div style={{ opacity: 0.85 }}>
                  • <strong>마우스는 허용, 키보드 입력은 잠금</strong>: 시스템 제어를 자동으로 두고
                  <code> cc_keyboard_type</code> · <code>cc_keyboard_hotkey</code> 만 체크<br />
                  • <strong>읽기는 허용, Bash 만 잠금</strong>: 셸 카테고리에서 <code>Bash</code> 만 체크<br />
                  • <strong>이동은 허용, 자동 정리만 잠금</strong>: 파일 삭제 카테고리에서
                  <code> fm_organize_folder</code> 만 체크
                </div>
              </div>

              {lockedTools.size > 0 && (
                <div style={{ marginBottom: "12px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  <button
                    className="settings-btn settings-btn-danger"
                    onClick={clearAllLocks}
                    title="모든 개별 잠금 해제 (카테고리 토글은 영향 없음)"
                  >
                    🔓 모든 잠금 해제 ({lockedTools.size})
                  </button>
                </div>
              )}

              {TOOL_CATALOG.map((category) => {
                const isExpanded = expandedCategories.has(category.permId);
                const lockedInCat = category.tools.filter((t) => lockedTools.has(t.name)).length;
                const allLocked = lockedInCat === category.tools.length;
                const someLocked = lockedInCat > 0;

                return (
                  <div key={category.permId} className="permission-category">
                    <div
                      className="permission-category-title"
                      style={{
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        userSelect: "none",
                      }}
                      onClick={() => toggleExpand(category.permId)}
                    >
                      <span>
                        <span style={{ display: "inline-block", width: "16px" }}>
                          {isExpanded ? "▼" : "▶"}
                        </span>
                        {" "}{category.icon} {category.title}
                        {someLocked && (
                          <span
                            style={{
                              marginLeft: "8px",
                              fontSize: "0.8em",
                              padding: "1px 8px",
                              borderRadius: "10px",
                              background: allLocked ? "rgba(239, 68, 68, 0.2)" : "rgba(249, 115, 22, 0.2)",
                              color: allLocked ? "#ef4444" : "#f97316",
                              border: `1px solid ${allLocked ? "rgba(239, 68, 68, 0.4)" : "rgba(249, 115, 22, 0.4)"}`,
                            }}
                          >
                            {lockedInCat}/{category.tools.length} 잠김
                          </span>
                        )}
                      </span>
                      <button
                        className="settings-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleLockCategory(category, !allLocked);
                        }}
                        style={{ fontSize: "0.85em", padding: "4px 10px" }}
                        title={allLocked ? "이 카테고리 전체 해제" : "이 카테고리 전체 잠금"}
                      >
                        {allLocked ? "전체 해제" : "전체 잠금"}
                      </button>
                    </div>

                    {isExpanded && (
                      <div style={{ paddingLeft: "8px" }}>
                        {category.tools.map((tool) => {
                          const locked = lockedTools.has(tool.name);
                          return (
                            <label
                              key={tool.name}
                              className="permission-item"
                              style={{
                                cursor: "pointer",
                                opacity: locked ? 1 : 0.85,
                                background: locked ? "rgba(239, 68, 68, 0.05)" : undefined,
                                borderColor: locked ? "rgba(239, 68, 68, 0.3)" : undefined,
                              }}
                            >
                              <div className="permission-info">
                                <input
                                  type="checkbox"
                                  checked={locked}
                                  onChange={() => toggleLockTool(tool.name)}
                                  style={{
                                    width: "18px",
                                    height: "18px",
                                    marginRight: "10px",
                                    cursor: "pointer",
                                    accentColor: "#ef4444",
                                  }}
                                />
                                <div>
                                  <div
                                    className="permission-name mono"
                                    style={{
                                      fontSize: "0.92em",
                                      color: tool.destructive ? "#f97316" : undefined,
                                    }}
                                  >
                                    {tool.label}
                                    {tool.destructive && (
                                      <span
                                        style={{
                                          marginLeft: "6px",
                                          fontSize: "0.75em",
                                          opacity: 0.7,
                                        }}
                                      >
                                        ⚠ 파괴적
                                      </span>
                                    )}
                                  </div>
                                  {tool.desc && (
                                    <div className="permission-desc" style={{ fontSize: "0.8em" }}>
                                      {tool.desc}
                                    </div>
                                  )}
                                </div>
                              </div>
                              {locked && (
                                <span
                                  style={{
                                    fontSize: "0.8em",
                                    color: "#ef4444",
                                    fontWeight: 600,
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  🔒 잠김
                                </span>
                              )}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* API 키 / 인증 섹션 */}
          <section className="settings-section" data-tab="ai">
            <div className="eyebrow">AI 모델 연동</div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-info">
                <div className="settings-row-title">제공자 / 모델</div>
                <div className="settings-row-desc">
                  Claude (Max 구독) 또는 외부 API (OpenAI, Gemini, OpenRouter, Anthropic) 중에서 선택합니다.
                </div>
              </div>

              {/* 제공자 탭 */}
              <div className="api-provider-tabs">
                {API_PROVIDERS.map((provider) => {
                  const usable = provider.noKeyRequired || !!apiKeys[provider.id];
                  return (
                    <button
                      key={provider.id}
                      className={`api-provider-tab ${activeProvider === provider.id ? "active" : ""} ${usable ? "has-key" : ""}`}
                      onClick={() => setActiveProvider(provider.id)}
                      title={chatProvider === provider.id ? "현재 채팅에 사용 중" : "탭으로 전환"}
                    >
                      <span className="api-provider-icon">{provider.icon}</span>
                      <span className="api-provider-name">{provider.name.split(" ")[0]}</span>
                      {usable && <span className="api-key-check">✓</span>}
                      {chatProvider === provider.id && (
                        <span
                          className="api-key-check"
                          style={{ color: "var(--accent)" }}
                        >
                          ●
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* 선택된 제공자 설정 */}
              {currentProvider && (
                <div className="api-key-form">
                  <div className="api-key-header">
                    <span>{currentProvider.icon} {currentProvider.name}</span>
                    <a
                      href={currentProvider.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="api-key-docs"
                    >
                      {currentProvider.noKeyRequired ? "문서 →" : "API 키 발급 →"}
                    </a>
                  </div>

                  {currentProvider.note && (
                    <div
                      style={{
                        fontSize: "0.85em",
                        opacity: 0.75,
                        marginBottom: "10px",
                      }}
                    >
                      {currentProvider.note}
                    </div>
                  )}

                  {/* Codex (ChatGPT OAuth) 전용 — codex login + MCP 등록 + 인증 상태 */}
                  {currentProvider.noKeyRequired && currentProvider.id === "codex" && (
                    <div
                      style={{
                        marginBottom: "12px",
                        padding: "10px 12px",
                        background: "rgba(34, 197, 94, 0.05)",
                        border: "1px solid rgba(34, 197, 94, 0.2)",
                        borderRadius: "4px",
                      }}
                    >
                      {/* CLI / 인증 상태 표시 */}
                      <div style={{ fontSize: "0.85em", marginBottom: "10px" }}>
                        <div style={{ marginBottom: "4px" }}>
                          <span style={{ opacity: 0.7 }}>Codex CLI: </span>
                          <span
                            className="mono"
                            style={{
                              color: codexAuth?.cli_available
                                ? "var(--accent)"
                                : "var(--warn, #ff9800)",
                            }}
                          >
                            {codexAuth?.cli_available ? "✓ 사용 가능" : "✗ 미설치 (npm i -g @openai/codex)"}
                          </span>
                        </div>
                        <div>
                          <span style={{ opacity: 0.7 }}>인증 상태: </span>
                          <span
                            className="mono"
                            style={{
                              color: codexAuth?.authenticated
                                ? "var(--accent)"
                                : "var(--warn, #ff9800)",
                            }}
                          >
                            {codexAuth?.authenticated
                              ? "✓ 로그인됨 (~/.codex/auth.json)"
                              : "✗ 로그인 필요"}
                          </span>
                        </div>
                      </div>

                      <div
                        style={{
                          fontSize: "0.85em",
                          marginBottom: "8px",
                          opacity: 0.85,
                        }}
                      >
                        아래 [codex login] 버튼을 누르면 백그라운드에서 codex login 이 실행되고
                        시스템 브라우저가 자동으로 열려 ChatGPT OAuth 페이지로 이동합니다.
                        브라우저에서 로그인 완료 후 이 화면의 인증 상태가 자동 갱신됩니다.
                      </div>

                      <div className="api-key-actions" style={{ flexWrap: "wrap", gap: 8 }}>
                        <button
                          className="settings-btn settings-btn-primary"
                          onClick={handleCodexLogin}
                          disabled={
                            codexLoginStatus === "running" ||
                            !codexAuth?.cli_available
                          }
                          title={
                            codexAuth?.cli_available
                              ? "백그라운드 codex login + 브라우저 OAuth"
                              : "Codex CLI 가 PATH 에 없음"
                          }
                        >
                          {codexLoginStatus === "running"
                            ? "브라우저 확인 중…"
                            : codexAuth?.authenticated
                            ? "🔄 codex login 다시"
                            : "🔑 codex login 실행"}
                        </button>
                        <button
                          className="settings-btn"
                          onClick={handleCodexRegisterMcp}
                          disabled={
                            codexMcpRegistering ||
                            !codexAuth?.cli_available ||
                            !codexAuth?.authenticated
                          }
                          title="codex mcp add k-personal — Codex 도 K-Personal MCP 도구 사용"
                        >
                          {codexMcpRegistering
                            ? "등록 중…"
                            : "🔌 K-Personal MCP 등록"}
                        </button>
                        <button
                          className="settings-btn"
                          onClick={refreshCodexAuth}
                          title="인증 상태 다시 조회"
                        >
                          ↻ 새로고침
                        </button>
                      </div>

                      {codexLoginStatus === "error" && codexLoginError && (
                        <div
                          style={{
                            marginTop: 8,
                            fontSize: "0.85em",
                            color: "var(--warn, #ff9800)",
                          }}
                        >
                          ⚠ {codexLoginError}
                        </div>
                      )}
                      {codexMcpResult && (
                        <div
                          style={{
                            marginTop: 8,
                            fontSize: "0.85em",
                            opacity: 0.85,
                          }}
                          className="mono"
                        >
                          {codexMcpResult}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Max 구독 (claude provider) 전용: claude login 버튼 */}
                  {currentProvider.noKeyRequired && currentProvider.id === "claude" && (
                    <div
                      style={{
                        marginBottom: "12px",
                        padding: "10px 12px",
                        background: "rgba(79, 232, 225, 0.05)",
                        border: "1px solid rgba(79, 232, 225, 0.2)",
                        borderRadius: "4px",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "0.85em",
                          marginBottom: "8px",
                          opacity: 0.85,
                        }}
                      >
                        Max 구독을 처음 인증하거나 토큰이 만료됐을 때 아래 버튼을 누르면
                        새 콘솔 창에서 <span className="mono">claude login</span> 이
                        실행됩니다. 안내에 따라 브라우저 OAuth 를 완료하세요.
                      </div>
                      <div className="api-key-actions">
                        <button
                          className="settings-btn settings-btn-primary"
                          onClick={handleClaudeLogin}
                          disabled={loginStatus === "running"}
                        >
                          {loginStatus === "running"
                            ? "콘솔 창 확인…"
                            : "🔑 claude login 실행"}
                        </button>
                        {loginStatus === "running" && (
                          <span
                            style={{
                              fontSize: "0.85em",
                              opacity: 0.7,
                              alignSelf: "center",
                            }}
                          >
                            새 콘솔 창에서 OAuth 진행 후 Sidecar 재시작이 필요할 수 있습니다.
                          </span>
                        )}
                        {loginStatus === "error" && loginError && (
                          <span
                            style={{
                              fontSize: "0.85em",
                              color: "var(--warn, #ff9800)",
                              alignSelf: "center",
                            }}
                          >
                            ⚠ {loginError}
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* API 키 입력 (Max 구독 제외) */}
                  {!currentProvider.noKeyRequired && (
                    <>
                      <div className="api-key-input-row">
                        <input
                          type={showKeys[currentProvider.id] ? "text" : "password"}
                          className="api-key-input mono"
                          placeholder={currentProvider.placeholder}
                          value={apiKeys[currentProvider.id] || ""}
                          onChange={(e) => setApiKeys({
                            ...apiKeys,
                            [currentProvider.id]: e.target.value
                          })}
                        />
                        <button
                          className="api-key-toggle"
                          onClick={() => setShowKeys({
                            ...showKeys,
                            [currentProvider.id]: !showKeys[currentProvider.id]
                          })}
                          title={showKeys[currentProvider.id] ? "숨기기" : "보기"}
                        >
                          {showKeys[currentProvider.id] ? "🙈" : "👁"}
                        </button>
                      </div>

                      <div className="api-key-actions">
                        <button
                          className="settings-btn settings-btn-primary"
                          onClick={() => saveAPIKey(currentProvider.id, apiKeys[currentProvider.id] || "")}
                          disabled={savingKey === currentProvider.id || !apiKeys[currentProvider.id]}
                        >
                          {savingKey === currentProvider.id ? "저장 중..." : "저장"}
                        </button>
                        {apiKeys[currentProvider.id] && (
                          <button
                            className="settings-btn settings-btn-danger"
                            onClick={() => removeAPIKey(currentProvider.id)}
                          >
                            삭제
                          </button>
                        )}
                      </div>
                    </>
                  )}

                  {/* 모델 드롭박스 */}
                  <div style={{ marginTop: "14px" }}>
                    <div
                      className="settings-row-title"
                      style={{ fontSize: "0.95em", marginBottom: "6px" }}
                    >
                      모델 선택
                    </div>
                    <select
                      className="api-key-input mono"
                      value={
                        chatProvider === currentProvider.id
                          ? chatModel
                          : currentProvider.models[0]?.id ?? "default"
                      }
                      onChange={(e) =>
                        saveActiveProvider(currentProvider.id, e.target.value)
                      }
                      style={{ width: "100%", padding: "8px 10px" }}
                    >
                      {currentProvider.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* 활성 채팅 provider 로 설정 */}
                  <div className="api-key-actions" style={{ marginTop: "14px" }}>
                    {chatProvider === currentProvider.id ? (
                      <span
                        className="model-badge active"
                        style={{ alignSelf: "center" }}
                      >
                        ● 현재 이 provider 로 채팅 중
                      </span>
                    ) : (
                      <button
                        className="settings-btn settings-btn-primary"
                        onClick={() => selectActiveProvider(currentProvider.id)}
                        disabled={
                          !currentProvider.noKeyRequired &&
                          !apiKeys[currentProvider.id]
                        }
                        title={
                          !currentProvider.noKeyRequired &&
                          !apiKeys[currentProvider.id]
                            ? "먼저 API 키를 저장하세요"
                            : "이 provider 로 채팅 전환"
                        }
                      >
                        이 provider 로 전환
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* 현재 활성 모델 표시 */}
          <section className="settings-section" data-tab="ai">
            <div className="eyebrow">활성 모델</div>
            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-title">
                  {API_PROVIDERS.find((p) => p.id === chatProvider)?.icon}{" "}
                  {API_PROVIDERS.find((p) => p.id === chatProvider)?.name ?? chatProvider}
                </div>
                <div className="settings-row-desc">
                  모델: <span className="mono">{chatModel}</span>
                  {chatProvider === "claude" && " · Max 구독 OAuth · MCP 도구 사용 가능"}
                  {chatProvider === "codex" && " · ChatGPT Plus/Pro OAuth · MCP 도구 통합 가능"}
                  {chatProvider !== "claude" && chatProvider !== "codex" && " · REST API 직접 호출 · 텍스트 전용"}
                </div>
              </div>
              <div className="model-status">
                <span className="model-badge active">활성</span>
              </div>
            </div>
          </section>

          {/* Phase 15 — 외부 사용량 페이지 (새 webview 창으로 K-Desktop-Agent 안에서 그대로 보기) */}
          <section className="settings-section" data-tab="ai">
            <div className="eyebrow">사용량 페이지</div>
            <div
              className="settings-row-desc"
              style={{ marginBottom: 12, opacity: 0.8 }}
            >
              구독 사용량/계정 페이지를 새 창으로 엽니다. 외부 브라우저 안 거치고
              K-Desktop-Agent 안에서 직접 — cookie 가 영속되어 한 번 로그인하면 다음에 자동 입장.
            </div>
            {EXTERNAL_USAGE_PAGES.map((page) => (
              <div className="settings-row" key={page.id}>
                <div className="settings-row-info">
                  <div className="settings-row-title">
                    {page.icon} {page.title}
                  </div>
                  <div className="settings-row-desc">{page.description}</div>
                  <div
                    className="mono"
                    style={{ fontSize: "0.78em", opacity: 0.5, marginTop: 4 }}
                  >
                    {page.url}
                  </div>
                </div>
                <button
                  className="settings-btn"
                  onClick={() => openExternalUsage(page)}
                  disabled={webviewOpening === page.id}
                  title="새 창으로 열기"
                >
                  {webviewOpening === page.id ? "여는 중…" : "🪟 열기"}
                </button>
              </div>
            ))}
          </section>

          {/* Phase 18 — 필수 도구 (의존성) 셋업 섹션 */}
          <section className="settings-section" data-tab="system" data-firstrun={isFirstRun ? "true" : "false"}>
            <div className="eyebrow">
              필수 도구 {isFirstRun && <span style={{ color: "var(--accent)" }}>· 첫 셋업</span>}
            </div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-info">
                <div className="settings-row-title">외부 의존성 자동 설치</div>
                <div className="settings-row-desc">
                  Node.js / Git / Python / Claude CLI / Codex CLI — winget + npm 으로 자동 설치.
                  이미 있으면 skip. OAuth 로그인은 K 가 직접 (보안상 자동화 불가).
                </div>
              </div>

              {depsBusy === "checking" && (
                <div className="update-status update-checking">
                  <span className="update-spinner">⟳</span> 의존성 검사 중...
                </div>
              )}

              {depsBusy === "installing" && (
                <div className="update-downloading-section">
                  <div className="update-status update-downloading">
                    설치 진행 중... (winget UAC 동의 필요할 수 있음 — 잠시 기다려주세요)
                  </div>
                  <div className="update-progress-bar">
                    <div className="update-progress-fill" style={{ width: "100%" }} />
                  </div>
                </div>
              )}

              {depsBusy === "idle" && depsResult && (
                <div className="deps-result">
                  <div
                    className="update-status"
                    style={{
                      color: depsResult.fullyReady
                        ? "var(--success, #4ec9b0)"
                        : depsResult.ready
                          ? "var(--warning, #d7ba7d)"
                          : "var(--danger, #f48771)",
                    }}
                  >
                    {depsResult.fullyReady
                      ? "✓ 모든 의존성 ready"
                      : depsResult.ready
                        ? "⚠ 부분 ready — Claude 또는 Codex 둘 중 하나만 사용 가능"
                        : "✗ 의존성 미흡 — 자동 설치 필요"}
                  </div>
                  <div className="settings-row-desc" style={{ marginTop: "0.4rem" }}>
                    Node: {depsResult.after.node ? "✓" : "✗"} ·
                    {" "}Git: {depsResult.after.git ? "✓" : "✗"} ·
                    {" "}Python: {depsResult.after.python ? `✓ ${depsResult.after.python}` : "✗"} ·
                    {" "}Claude CLI: {depsResult.after.claudeCli ? "✓" : "✗"} ·
                    {" "}Codex CLI: {depsResult.after.codexCli ? "✓" : "✗"} ·
                    {" "}K-Personal MCP: {depsResult.after.kPersonalMcp ? "✓" : "—"}
                  </div>
                  {depsResult.fatal && (
                    <div className="update-error-section" style={{ marginTop: "0.5rem" }}>
                      <div className="update-status update-error">⚠ {depsResult.fatal}</div>
                      {depsResult.missing && depsResult.missing.length > 0 && (
                        <div className="settings-row-desc" style={{ marginTop: "0.3rem" }}>
                          누락된 도구: {depsResult.missing.join(", ")} — winget 또는 직접 다운로드로 설치 필요
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {depsError && (
                <div className="update-error-section">
                  <div className="update-status update-error">⚠ {depsError}</div>
                </div>
              )}

              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
                <button
                  className="settings-btn"
                  onClick={handleCheckDeps}
                  disabled={depsBusy !== "idle"}
                >
                  상태 새로고침
                </button>
                {/* Phase 20 (v0.5.6): depsResult 가 fatal 에러로 null 일 때도 버튼 표시 — K 가
                    [자동 설치 실행] 누를 길 자체가 없었던 함정 회피. fullyReady 일 때만 숨김. */}
                {(!depsResult || !depsResult.fullyReady) && (
                  <button
                    className="settings-btn settings-btn-primary"
                    onClick={handleInstallDeps}
                    disabled={depsBusy !== "idle"}
                    title={depsError ? `의존성 검사 중 에러: ${depsError}\n\n그래도 실행은 가능 — 클릭하면 시도합니다.` : undefined}
                  >
                    자동 설치 실행
                  </button>
                )}
                {/* Claude/Codex 로그인 버튼은 CLI 가 실제 ready 일 때만 표시 (없으면 클릭해봐야 fail) */}
                {depsResult?.after?.claudeCli && (
                  <button
                    className="settings-btn"
                    onClick={handleClaudeLogin}
                    disabled={depsBusy !== "idle"}
                  >
                    Claude 로그인
                  </button>
                )}
                {depsResult?.after?.codexCli && (
                  <button
                    className="settings-btn"
                    onClick={handleCodexLogin}
                    disabled={depsBusy !== "idle"}
                  >
                    Codex 로그인
                  </button>
                )}
                {isFirstRun && depsResult?.ready && (
                  <button
                    className="settings-btn settings-btn-primary"
                    onClick={handleMarkFirstRunComplete}
                  >
                    첫 셋업 완료 표시
                  </button>
                )}
                {/* Phase 20: 마법사 자동 오픈 sessionStorage 가드 강제 초기화 — K 가 닫고 다시 보고 싶을 때 */}
                <button
                  className="settings-btn"
                  onClick={() => {
                    try {
                      sessionStorage.removeItem("kda_firstrun_wizard_seen_v2");
                      console.info("[first-run] sessionStorage 가드 초기화 완료 — KDA 재시작 시 마법사 다시 표시");
                    } catch {}
                  }}
                  title="KDA 재시작 시 first-run 마법사가 다시 자동으로 뜨게 함 (디버그용)"
                >
                  마법사 가드 초기화
                </button>
              </div>
            </div>

            {/* Phase 66 (v0.6.1) — K-Personal MCP 자동 설치 */}
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-info">
                <div className="settings-row-title">K-Personal MCP 도구 설치</div>
                <div className="settings-row-desc">
                  K 의 자동화 도구셋 (ui_*, web_*, fm_*, app_*, clip_*, db_*, cc_*) 을
                  <code style={{ marginLeft: "0.3em", marginRight: "0.3em", padding: "0.1em 0.3em", background: "var(--bg-0)", borderRadius: "3px" }}>
                    ~/Documents/K-Personal-MCP
                  </code>
                  에 git clone + pip install. 다른 PC 에서 KDA 처음 깔 때 1회 클릭으로 셋업.
                  Git + Python 필요 (위 의존성 셋업 먼저).
                </div>
              </div>

              {kpmcpBusy === "installing" && (
                <div className="update-downloading-section">
                  <div className="update-status update-downloading">
                    <span className="update-spinner">⟳</span> git clone + install.bat 진행 중... (수십 초~수 분 소요)
                  </div>
                  <div className="update-progress-bar">
                    <div className="update-progress-fill" style={{ width: "100%" }} />
                  </div>
                </div>
              )}

              {kpmcpBusy === "idle" && kpmcpResult && (
                <div className="deps-result">
                  <div
                    className="update-status"
                    style={{
                      color: kpmcpResult.success
                        ? "var(--success, #4ec9b0)"
                        : "var(--danger, #f48771)",
                    }}
                  >
                    {kpmcpResult.success
                      ? kpmcpResult.alreadyInstalled
                        ? "✓ 이미 설치되어 있음"
                        : "✓ 설치 완료 — sidecar 자동 재시작 됨, MCP 도구 곧 활성화"
                      : `✗ 설치 실패: ${kpmcpResult.error ?? "원인 불명"}`}
                  </div>
                  <div className="settings-row-desc" style={{ marginTop: "0.4rem", fontSize: "0.85em" }}>
                    target: <span style={{ fontFamily: "monospace" }}>{kpmcpResult.target}</span> ·
                    {" "}server.py: {kpmcpResult.serverPyExists ? "✓" : "✗"} ·
                    {" "}git: {kpmcpResult.gitAvailable ? "✓" : "✗"} ·
                    {" "}python: {kpmcpResult.pythonAvailable ? "✓" : "✗"}
                  </div>
                  {kpmcpResult.steps && kpmcpResult.steps.length > 0 && (
                    <details style={{ marginTop: "0.5rem" }}>
                      <summary style={{ cursor: "pointer", fontSize: "0.85em", opacity: 0.75 }}>
                        설치 로그 ({kpmcpResult.steps.length} 줄)
                      </summary>
                      <pre style={{
                        marginTop: "0.4rem",
                        padding: "0.5rem",
                        background: "var(--bg-0)",
                        borderRadius: "4px",
                        fontSize: "0.8em",
                        maxHeight: "240px",
                        overflow: "auto",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                      }}>
                        {kpmcpResult.steps.join("\n")}
                      </pre>
                    </details>
                  )}
                </div>
              )}

              {kpmcpError && (
                <div className="update-error-section">
                  <div className="update-status update-error">⚠ {kpmcpError}</div>
                </div>
              )}

              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
                <button
                  className="settings-btn settings-btn-primary"
                  onClick={handleInstallKpersonalMCP}
                  disabled={kpmcpBusy !== "idle"}
                  title="git clone https://github.com/lee30934-byte/K-Personal-MCP.git ~/Documents/K-Personal-MCP + install.bat"
                >
                  {kpmcpBusy === "installing" ? "설치 중…" : "MCP 도구 자동 설치"}
                </button>
              </div>
            </div>
          </section>

          {/* Phase 25 (v0.5.11) — 데이터 폴더 (portable) */}
          <section className="settings-section" data-tab="system">
            <div className="eyebrow">데이터 폴더</div>
            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-title">📂 현재 위치</div>
                <div className="settings-row-desc" style={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                  {dataDirInfo?.data_root ?? "로딩 중..."}
                </div>
                {dataDirInfo && (
                  <div className="settings-row-desc" style={{ marginTop: "0.4rem", fontSize: "0.85em" }}>
                    DB: {dataDirInfo.db_exists ? "✓" : "—"}{" "}
                    <span style={{ fontFamily: "monospace" }}>{dataDirInfo.db_path}</span>
                    <br />
                    pointer: {dataDirInfo.pointer_exists
                      ? `✓ ${dataDirInfo.pointer_path}`
                      : "없음 (기본 fallback ~/.kda 사용 중)"}
                  </div>
                )}
              </div>
            </div>
            {dataDirMsg && (
              <div className="update-status update-success" style={{ marginTop: "0.3rem" }}>
                {dataDirMsg}
              </div>
            )}
            {dataDirError && (
              <div className="update-error-section" style={{ marginTop: "0.3rem" }}>
                <div className="update-status update-error">⚠ {dataDirError}</div>
              </div>
            )}
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
              <button
                className="settings-btn settings-btn-primary"
                onClick={() => handleChangeDataDir("pick")}
                disabled={dataDirBusy}
                title="폴더 선택 다이얼로그를 열어 새 위치를 고릅니다. 기존 데이터는 자동으로 이동됩니다."
              >
                폴더 변경
              </button>
              {dataDirInfo?.default_data_dir && (
                <button
                  className="settings-btn"
                  onClick={() => handleChangeDataDir("default")}
                  disabled={dataDirBusy || dataDirInfo.data_root === dataDirInfo.default_data_dir}
                  title={`설치 드라이브와 통일된 기본 위치 (${dataDirInfo.default_data_dir})`}
                >
                  기본 위치로 (설치 드라이브)
                </button>
              )}
              <button
                className="settings-btn"
                onClick={refreshDataDirInfo}
                disabled={dataDirBusy}
              >
                상태 새로고침
              </button>
            </div>
            <div className="settings-row-desc" style={{ marginTop: "0.5rem", fontSize: "0.85em", opacity: 0.8 }}>
              ※ 변경 시 기존 데이터 (DB / 백업 / cwd / 로그) 가 새 위치로 자동 복사되고 KDA 재시작 후 활성화됩니다.
              {" "}OneDrive 동기화 폴더 / Program Files 같은 read-only 위치는 피해주세요 (DB lock 충돌 위험).
            </div>
          </section>

          {/* 자동 업데이트 섹션 */}
          <section className="settings-section" data-tab="system">
            <div className="eyebrow">업데이트</div>
            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-title">자동 업데이트</div>
                <div className="settings-row-desc">
                  새 버전이 출시되면 자동으로 알림을 표시합니다
                </div>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={autoUpdate}
                  onChange={toggleAutoUpdate}
                  disabled={loading}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-info">
                <div className="settings-row-title">업데이트 확인</div>
                <div className="settings-row-desc">
                  현재 버전: {appVersion ? `v${appVersion}` : "확인 중..."}
                </div>
              </div>
              <div className="update-status-container">
                {updateStatus === "idle" && (
                  <button className="settings-btn" onClick={checkForUpdate}>
                    업데이트 확인
                  </button>
                )}
                {updateStatus === "checking" && (
                  <div className="update-status update-checking">
                    <span className="update-spinner">⟳</span>
                    확인 중...
                  </div>
                )}
                {updateStatus === "latest" && (
                  <div className="update-latest-section">
                    <div className="update-status update-latest">
                      <span className="update-icon">✓</span>
                      최신 버전입니다!
                    </div>
                    <button className="settings-btn" onClick={checkForUpdate}>
                      다시 확인
                    </button>
                  </div>
                )}
                {updateStatus === "available" && (
                  <div className="update-available-section">
                    <div className="update-status update-available">
                      <span className="update-icon">🎉</span>
                      새 버전 {updateVersion} 사용 가능!
                    </div>
                    <button
                      className="settings-btn settings-btn-primary"
                      onClick={downloadAndInstallUpdate}
                    >
                      지금 업데이트
                    </button>
                  </div>
                )}
                {updateStatus === "downloading" && (
                  <div className="update-downloading-section">
                    <div className="update-status update-downloading">
                      다운로드 중... {updateProgress}%
                    </div>
                    <div className="update-progress-bar">
                      <div
                        className="update-progress-fill"
                        style={{ width: `${updateProgress}%` }}
                      />
                    </div>
                  </div>
                )}
                {updateStatus === "error" && (
                  <div className="update-error-section">
                    <div className="update-status update-error">
                      <span className="update-icon">⚠</span>
                      {updateError}
                    </div>
                    <button className="settings-btn" onClick={checkForUpdate}>
                      다시 시도
                    </button>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="settings-section" data-tab="system">
            <div className="eyebrow">시작</div>
            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-title">Windows 시작 시 자동 실행</div>
                <div className="settings-row-desc">
                  부팅하면 트레이에 숨겨진 채로 자동 실행됩니다
                </div>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={autoStart}
                  onChange={toggleAutoStart}
                  disabled={loading}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>
          </section>

          <section className="settings-section" data-tab="system">
            <div className="eyebrow">런타임</div>
            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-title">Sidecar · MCP 재기동</div>
                <div className="settings-row-desc">
                  응답이 이상하거나 MCP 꼬였을 때 Node 사이드카를 재시작합니다
                  <br />
                  상태: {mcpConnected ? (
                    <span className="status-ok">● K-PERSONAL · 연결됨</span>
                  ) : (
                    <span className="status-warn">● 연결 안됨</span>
                  )}
                </div>
              </div>
              <button
                className="settings-btn"
                onClick={handleReload}
                disabled={reloading}
              >
                {reloading ? "재시작 중..." : "재시작"}
              </button>
            </div>
          </section>

          <section className="settings-section" data-tab="system">
            <div className="eyebrow">리소스</div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-header">
                <div className="settings-row-info">
                  <div className="settings-row-title">파일 시스템 감시</div>
                  <div className="settings-row-desc">
                    폴더 변경 사항을 실시간으로 모니터링합니다
                  </div>
                </div>
                <button
                  className="settings-btn"
                  onClick={handleAddWatchFolder}
                  disabled={addingFolder}
                >
                  {addingFolder ? "..." : "+ 폴더 추가"}
                </button>
              </div>
              {watchedFolders.length > 0 && (
                <div className="watched-folders-list">
                  {watchedFolders.map((folder) => (
                    <div key={folder.path} className="watched-folder-item">
                      <span className="watched-folder-path mono" title={folder.path}>
                        📁 {folder.path.split("\\").pop() || folder.path}
                      </span>
                      <span className="watched-folder-full-path mono">
                        {folder.path}
                      </span>
                      <button
                        className="watched-folder-remove"
                        onClick={() => handleRemoveWatchFolder(folder.path)}
                        title="감시 중단"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* Phase 59 — Anthropic rate polling toggle (ccusage). V3 같은 백신이 ccusage 의 native binary 를 차단해 매 5분마다 알림이 뜨는 경우 off. */}
          <section className="settings-section" data-tab="system">
            <div className="eyebrow">사용량 추적</div>
            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-title">Anthropic 사용량 폴링 (ccusage)</div>
                <div className="settings-row-desc">
                  5분마다 ccusage 를 호출해 Claude Code 토큰 사용량 / 한도 reset 시간을 표시합니다.
                  백신(V3 등)이 ccusage 의 native binary 를 차단하는 환경이면 끄세요.
                  끄면 사용량 카드는 SSE rate_limit_event 만 사용합니다 (토큰 합계는 표시 안 됨).
                </div>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={anthropicRatePolling}
                  onChange={toggleAnthropicRatePolling}
                  disabled={anthropicRatePollingBusy}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>
            {sidecarReloadHint && (
              <div className="settings-row settings-row-vertical">
                <div className="settings-row-info">
                  <div className="settings-row-desc" style={{ color: "var(--warn, #ffb74d)" }}>
                    ⓘ 변경 사항은 sidecar 재시작 시 반영됩니다.
                  </div>
                </div>
                <button className="settings-btn" onClick={handleReloadSidecarNow}>
                  지금 sidecar 재시작
                </button>
              </div>
            )}
          </section>

          {/* Phase 90 (v0.6.32) — 안전장치 탭 최상단 요약 카드.
              SafeMode 현재값 + Memory Sync 상태 + Final-Review Gate + Lee Profile 한눈에. */}
          <section className="settings-section" data-tab="safety">
            <div className="eyebrow">📊 안전 상태 요약</div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-info">
                <div className="settings-row-title">한눈에 보는 안전 layer</div>
                <div className="settings-row-desc">
                  현재 활성화된 안전망과 SafeMode 주간 통계를 한 곳에 모았습니다. 자세한 설정은 아래 각 섹션에서.
                </div>
              </div>
              {/* 1행: SafeMode / Memory Sync / Final-Review Gate / Lee Profile 상태 칩 */}
              <div
                style={{
                  marginTop: 10,
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                  gap: 8,
                  fontSize: "0.82em",
                }}
              >
                <div
                  style={{
                    padding: "8px 10px",
                    background: "var(--bg-1)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: 6,
                  }}
                >
                  <div style={{ opacity: 0.7, marginBottom: 2 }}>🛡️ SafeMode</div>
                  <div style={{ fontWeight: 600 }}>
                    {safeMode === "off"
                      ? "🟢 끔"
                      : safeMode === "balanced"
                        ? "🟡 균형"
                        : "🔴 엄격"}
                  </div>
                </div>
                <div
                  style={{
                    padding: "8px 10px",
                    background: "var(--bg-1)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: 6,
                  }}
                >
                  <div style={{ opacity: 0.7, marginBottom: 2 }}>🔄 Memory Sync</div>
                  <div style={{ fontWeight: 600 }}>
                    {gitSyncEnabled
                      ? gitSyncStatus?.last_sync_at && gitSyncStatus.last_sync_at > 0
                        ? `✓ ${new Date(gitSyncStatus.last_sync_at * 1000).toLocaleString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`
                        : "✓ 활성 (아직 sync 안 함)"
                      : "— 비활성"}
                  </div>
                </div>
                <div
                  style={{
                    padding: "8px 10px",
                    background: "var(--bg-1)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: 6,
                  }}
                >
                  <div style={{ opacity: 0.7, marginBottom: 2 }}>🛡️ Final-Review Gate</div>
                  <div style={{ fontWeight: 600 }}>{finalReviewGate ? "✓ ON" : "— OFF"}</div>
                </div>
                <div
                  style={{
                    padding: "8px 10px",
                    background: "var(--bg-1)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: 6,
                  }}
                >
                  <div style={{ opacity: 0.7, marginBottom: 2 }}>🪪 Lee Profile</div>
                  <div style={{ fontWeight: 600 }}>
                    {leeProfile
                      ? leeProfile.bytes > 0
                        ? `✓ ${leeProfile.bytes}B`
                        : "— 빈 파일"
                      : "— 미로딩"}
                  </div>
                </div>
              </div>

              {/* 2행: SafeMode 주간 통계 카드 */}
              {safetyStats && (safetyStats.total_alerts > 0 || safetyStats.total_blocks > 0) && (
                <div
                  style={{
                    marginTop: 12,
                    padding: "10px 12px",
                    background: "var(--bg-1)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: 6,
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: "0.88em", marginBottom: 6 }}>
                    📊 SafeMode 주간 통계 (지난 7일)
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                      gap: 8,
                      fontSize: "0.82em",
                    }}
                  >
                    <div>
                      ⚠ <strong>{safetyStats.last7_alerts}</strong>회 alert
                      <span style={{ opacity: 0.6 }}>
                        {" "}(누적 {safetyStats.total_alerts})
                      </span>
                    </div>
                    <div>
                      🚫 <strong>{safetyStats.last7_blocks}</strong>회 blocked
                      <span style={{ opacity: 0.6 }}>
                        {" "}(누적 {safetyStats.total_blocks})
                      </span>
                    </div>
                  </div>
                  {(safetyStats.by_mode.balanced > 0 || safetyStats.by_mode.strict > 0) && (
                    <div style={{ marginTop: 6, opacity: 0.85, fontSize: "0.82em" }}>
                      Alert 분포: 🟡 balanced {safetyStats.by_mode.balanced}회 · 🔴 strict{" "}
                      {safetyStats.by_mode.strict}회
                    </div>
                  )}
                  {/* 7-day mini chart (텍스트 막대) — Phase 91: 막대 클릭 시 펼침 */}
                  {safetyStats.buckets.length > 0 && (() => {
                    const maxVal = Math.max(
                      1,
                      ...safetyStats.buckets.map((b) => b.alerts + b.blocks),
                    );
                    return (
                      <div
                        style={{
                          marginTop: 8,
                          display: "flex",
                          alignItems: "flex-end",
                          gap: 4,
                          height: 32,
                          fontFamily: "monospace",
                          fontSize: "0.72em",
                        }}
                      >
                        {safetyStats.buckets.map((b) => {
                          const total = b.alerts + b.blocks;
                          const h = Math.max(2, Math.round((total / maxVal) * 28));
                          const dayLabel = b.date.slice(5); // MM-DD
                          const isExpanded = expandedStatDate === b.date;
                          return (
                            <div
                              key={b.date}
                              title={`${b.date}: ${b.alerts} alerts, ${b.blocks} blocks (클릭하면 도구별 상세)`}
                              onClick={() => setExpandedStatDate(isExpanded ? null : b.date)}
                              style={{
                                flex: 1,
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: 2,
                                cursor: total > 0 ? "pointer" : "default",
                                outline: isExpanded ? "2px solid var(--accent, #4fe8e1)" : "none",
                                borderRadius: 3,
                              }}
                            >
                              <div
                                style={{
                                  width: "100%",
                                  height: h,
                                  background:
                                    total === 0
                                      ? "rgba(255,255,255,0.08)"
                                      : b.blocks > 0
                                        ? "rgba(239,68,68,0.6)"
                                        : "rgba(234,179,8,0.6)",
                                  borderRadius: 2,
                                }}
                              />
                              <div style={{ opacity: 0.55, fontSize: "0.85em" }}>{dayLabel}</div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                  {/* Phase 91 — 펼침 패널: byTool 상세 */}
                  {expandedStatDate && (() => {
                    const bucket = safetyStats.buckets.find((b) => b.date === expandedStatDate);
                    if (!bucket) return null;
                    const tools = bucket.byTool ?? {};
                    const entries = Object.entries(tools).sort((a, b) => b[1] - a[1]);
                    return (
                      <div
                        style={{
                          marginTop: 8,
                          padding: "8px 10px",
                          background: "rgba(79,232,225,0.06)",
                          border: "1px solid rgba(79,232,225,0.25)",
                          borderRadius: 4,
                          fontSize: "0.82em",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <strong>{bucket.date} 상세</strong>
                          <button
                            onClick={() => setExpandedStatDate(null)}
                            style={{
                              background: "transparent",
                              border: "none",
                              color: "inherit",
                              cursor: "pointer",
                              opacity: 0.6,
                            }}
                          >
                            ✕
                          </button>
                        </div>
                        <div style={{ marginTop: 4, opacity: 0.85 }}>
                          ⚠ {bucket.alerts}회 alert · 🚫 {bucket.blocks}회 blocked
                        </div>
                        {entries.length > 0 ? (
                          <div style={{ marginTop: 6, fontFamily: "monospace", fontSize: "0.85em" }}>
                            {entries.map(([tool, count]) => (
                              <div key={tool} style={{ display: "flex", justifyContent: "space-between" }}>
                                <span>{tool}</span>
                                <strong>{count}회</strong>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div style={{ marginTop: 6, opacity: 0.6 }}>도구별 기록 없음 (v0.6.32 이전 데이터)</div>
                        )}
                      </div>
                    );
                  })()}
                  <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
                    <button
                      className="settings-btn"
                      style={{ fontSize: "0.78em", padding: "2px 8px" }}
                      onClick={async () => {
                        try {
                          await invoke("safety_stats_request");
                        } catch {
                          /* ignore */
                        }
                      }}
                    >
                      🔄 새로고침
                    </button>
                    <button
                      className="settings-btn"
                      style={{ fontSize: "0.78em", padding: "2px 8px", opacity: 0.7 }}
                      onClick={async () => {
                        if (!confirm("SafeMode 통계를 모두 지울까요?")) return;
                        try {
                          await invoke("safety_stats_reset");
                        } catch {
                          /* ignore */
                        }
                      }}
                      title="누적 + 7일 history 모두 리셋"
                    >
                      🗑️ 지우기
                    </button>
                  </div>
                </div>
              )}
              {safetyStats &&
                safetyStats.total_alerts === 0 &&
                safetyStats.total_blocks === 0 && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: "10px 12px",
                      background: "var(--bg-1)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: 6,
                      fontSize: "0.82em",
                      opacity: 0.7,
                    }}
                  >
                    📊 SafeMode 통계: 아직 alert/block 기록 없음 (SafeMode 가 off 이거나 위험 도구
                    호출 없음).
                  </div>
                )}
            </div>
          </section>

          {/* Phase 87 (v0.6.30) — Git Memory Sync + Phase 88 가이드 + Phase 89 hybrid (team repo).
              Personal repo: lee-profile.md + memory/.  Team repo (선택): memory/ 만 (lee-profile 절대 X). */}
          <section className="settings-section" data-tab="safety">
            <div className="eyebrow">🔄 Memory Sync (Git)</div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-info">
                <div className="settings-row-title">개인 + 팀 메모리 클라우드 동기화</div>
                <div className="settings-row-desc">
                  <code>lee-profile.md</code> + <code>memory/</code> 폴더를 GitHub private repo 와
                  자동 동기화합니다. 여러 PC 에서 같은 규칙·함정 기록을 공유.
                  팀과 함께 학습할 함정만 별도로 공유하려면 <strong>팀 공유 repo</strong> 도 등록 가능 (선택).
                </div>
              </div>

              {/* Phase 88 — 첫 설정 가이드 (3 단계 워크스루) */}
              {gitSyncShowGuide && (
                <div
                  style={{
                    marginTop: 12,
                    padding: "12px 14px",
                    background: "rgba(79, 232, 225, 0.06)",
                    border: "1px solid rgba(79, 232, 225, 0.3)",
                    borderRadius: 6,
                    fontSize: "0.88em",
                    lineHeight: 1.55,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div style={{ fontWeight: 600 }}>📘 처음 설정 가이드 (3 단계)</div>
                    <button
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "inherit",
                        cursor: "pointer",
                        opacity: 0.6,
                        fontSize: "0.85em",
                      }}
                      title="가이드 닫기 (다시 안 보임)"
                      onClick={() => {
                        setGitSyncShowGuide(false);
                        try {
                          localStorage.setItem("kda_git_sync_guide_dismissed", "1");
                        } catch {
                          /* ignore */
                        }
                      }}
                    >
                      ✕ 닫기
                    </button>
                  </div>
                  <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                    <li>
                      <strong>Private repo 만들기</strong> — GitHub 에서 빈 private repo 생성 (예:{" "}
                      <code>kda-personal-memory</code>). README 추가 X (빈 repo 가 첫 push 깔끔).
                      <button
                        className="settings-btn"
                        style={{ marginLeft: 8, fontSize: "0.85em", padding: "2px 8px" }}
                        onClick={async () => {
                          try {
                            await openExternal("https://github.com/new");
                          } catch {
                            window.open("https://github.com/new", "_blank");
                          }
                        }}
                        title="시스템 브라우저로 열기"
                      >
                        🌐 github.com/new 열기
                      </button>
                    </li>
                    <li>
                      <strong>Personal Access Token 발급</strong> — Developer settings → Tokens (classic
                      또는 fine-grained). <strong>repo scope 만</strong> 체크. 만료기간 길게 (1년+).
                      <button
                        className="settings-btn"
                        style={{ marginLeft: 8, fontSize: "0.85em", padding: "2px 8px" }}
                        onClick={async () => {
                          try {
                            await openExternal("https://github.com/settings/tokens/new");
                          } catch {
                            window.open("https://github.com/settings/tokens/new", "_blank");
                          }
                        }}
                        title="시스템 브라우저로 열기"
                      >
                        🔑 PAT 발급 페이지 열기
                      </button>
                    </li>
                    <li>
                      <strong>아래 폼에 입력</strong> — Repo URL (.git 으로 끝나는 https URL) + PAT.
                      "💾 저장 + credential 등록" 클릭 → PAT 가 Windows Credential Manager 에 저장됩니다
                      (KDA 는 PAT 보관 X).
                    </li>
                  </ol>
                  <div style={{ marginTop: 10, opacity: 0.75, fontSize: "0.82em" }}>
                    💡 팀 공유 메모리는 같은 단계로 별도 repo (예: <code>kda-team-memory</code>) 만들어
                    아래 "팀 공유 repo" 영역에 입력하면 됩니다 — <code>lee-profile.md</code> 는 절대 안 박힘.
                  </div>
                </div>
              )}

              {!gitSyncShowGuide && (
                <button
                  className="settings-btn"
                  style={{ marginTop: 10, fontSize: "0.85em", padding: "4px 10px", alignSelf: "flex-start" }}
                  onClick={() => {
                    setGitSyncShowGuide(true);
                    try {
                      localStorage.removeItem("kda_git_sync_guide_dismissed");
                    } catch {
                      /* ignore */
                    }
                  }}
                >
                  📘 가이드 다시 보기
                </button>
              )}

              <div
                style={{
                  marginTop: 10,
                  padding: "10px 12px",
                  background: "rgba(249, 115, 22, 0.06)",
                  border: "1px solid rgba(249, 115, 22, 0.3)",
                  borderRadius: 6,
                  fontSize: "0.85em",
                  lineHeight: 1.55,
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  📌 중요 — Personal repo 는 혼자만 access
                </div>
                <div style={{ opacity: 0.85 }}>
                  다른 사람과 같은 personal repo 를 쓰면 <code>lee-profile.md</code> (개인 응답 규칙) 까지
                  공유됩니다. 회사 ID/password 같은 비밀이 들어 있으면 위험.
                  팀 공유는 별도 <strong>팀 공유 repo</strong> 사용 — <code>memory/</code> 폴더만 박히고
                  <code>lee-profile</code> 은 .gitignore 로 명시 차단됩니다.
                </div>
              </div>

              {/* git 미설치 안내 */}
              {gitSyncStatus && !gitSyncStatus.git_installed && (
                <div
                  style={{
                    marginTop: 10,
                    padding: "10px 12px",
                    background: "rgba(239, 68, 68, 0.1)",
                    border: "1px solid rgba(239, 68, 68, 0.4)",
                    borderRadius: 6,
                    fontSize: "0.88em",
                  }}
                >
                  ⚠ <strong>git 미설치.</strong>{" "}
                  <a href="https://git-scm.com" target="_blank" rel="noreferrer">
                    git-scm.com
                  </a>{" "}
                  에서 설치 후 KDA 재시작
                </div>
              )}

              {/* Personal repo 입력 폼 */}
              <div
                style={{
                  marginTop: 14,
                  padding: "10px 12px",
                  background: "var(--bg-1)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 6,
                }}
              >
                <div style={{ fontWeight: 600, fontSize: "0.9em", marginBottom: 8 }}>
                  💻 Personal repo (lee-profile + memory/)
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.88em" }}>
                    <span style={{ opacity: 0.85 }}>Repo URL (https)</span>
                    <input
                      type="text"
                      className="settings-input"
                      value={gitSyncRepoUrl}
                      onChange={(e) => setGitSyncRepoUrl(e.target.value)}
                      placeholder="https://github.com/<your-username>/kda-personal-memory.git"
                      disabled={gitSyncBusy || (gitSyncStatus && !gitSyncStatus.git_installed) || false}
                    />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.88em" }}>
                    <span style={{ opacity: 0.85 }}>PAT (repo scope) — 저장 후 즉시 비워짐</span>
                    <input
                      type="password"
                      className="settings-input"
                      value={gitSyncPat}
                      onChange={(e) => setGitSyncPat(e.target.value)}
                      placeholder="ghp_•••••••• 또는 github_pat_••••••••"
                      disabled={gitSyncBusy || (gitSyncStatus && !gitSyncStatus.git_installed) || false}
                    />
                  </label>
                </div>
              </div>

              {/* Phase 89 — Team repo 입력 폼 (선택) */}
              <div
                style={{
                  marginTop: 10,
                  padding: "10px 12px",
                  background: "var(--bg-1)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 6,
                }}
              >
                <div style={{ fontWeight: 600, fontSize: "0.9em", marginBottom: 4 }}>
                  👥 팀 공유 repo (선택) — memory/ 만, lee-profile 절대 X
                </div>
                <div style={{ fontSize: "0.82em", opacity: 0.75, marginBottom: 8, lineHeight: 1.5 }}>
                  팀원과 같이 학습한 함정/규칙을 공유할 때만 등록. 별도 폴더{" "}
                  <code>~/.kda/team-memory/</code> 에 clone 되고, 그 안의{" "}
                  <code>memory/</code> 파일들이 system prompt 의 "팀 공유 메모리" 섹션으로 박힙니다.
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.88em" }}>
                    <span style={{ opacity: 0.85 }}>Team repo URL (선택, 비워두면 비활성)</span>
                    <input
                      type="text"
                      className="settings-input"
                      value={gitSyncTeamRepoUrl}
                      onChange={(e) => setGitSyncTeamRepoUrl(e.target.value)}
                      placeholder="https://github.com/<your-org>/kda-team-memory.git"
                      disabled={gitSyncBusy || (gitSyncStatus && !gitSyncStatus.git_installed) || false}
                    />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.88em" }}>
                    <span style={{ opacity: 0.85 }}>Team PAT (같은 host 면 personal PAT 재사용 가능 — 비워둬도 됨)</span>
                    <input
                      type="password"
                      className="settings-input"
                      value={gitSyncTeamPat}
                      onChange={(e) => setGitSyncTeamPat(e.target.value)}
                      placeholder="(선택) team repo 가 다른 PAT 면 입력"
                      disabled={gitSyncBusy || (gitSyncStatus && !gitSyncStatus.git_installed) || false}
                    />
                  </label>
                </div>
              </div>

              {/* 공통 액션 */}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    cursor: "pointer",
                    fontSize: "0.88em",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={gitSyncEnabled}
                    onChange={(e) => setGitSyncEnabled(e.target.checked)}
                    disabled={gitSyncBusy}
                  />
                  <span>자동 동기화 활성화 (시작 시 1회 + 30분마다)</span>
                </label>

                <button
                  className="settings-btn"
                  disabled={gitSyncBusy || (!gitSyncRepoUrl && !gitSyncTeamRepoUrl)}
                  onClick={async () => {
                    setGitSyncBusy(true);
                    setGitSyncMessage(null);
                    try {
                      // 1) PAT 있으면 각각 credential 박기
                      if (gitSyncPat.trim() && gitSyncRepoUrl) {
                        await invoke("git_sync_store_credential", {
                          repoUrl: gitSyncRepoUrl,
                          pat: gitSyncPat,
                        });
                        setGitSyncPat("");
                      }
                      if (gitSyncTeamPat.trim() && gitSyncTeamRepoUrl) {
                        await invoke("git_sync_store_credential", {
                          repoUrl: gitSyncTeamRepoUrl,
                          pat: gitSyncTeamPat,
                        });
                        setGitSyncTeamPat("");
                      }
                      // 2) config update — 두 repo URL + enabled 한 번에
                      await invoke("git_sync_config_update", {
                        enabled: gitSyncEnabled,
                        repoUrl: gitSyncRepoUrl,
                        teamRepoUrl: gitSyncTeamRepoUrl,
                      });
                    } catch (err) {
                      setGitSyncMessage({ kind: "error", text: String(err) });
                      setGitSyncBusy(false);
                    }
                  }}
                >
                  💾 저장 + credential 등록
                </button>

                <button
                  className="settings-btn"
                  disabled={
                    gitSyncBusy ||
                    (!gitSyncRepoUrl && !gitSyncTeamRepoUrl) ||
                    (gitSyncStatus && !gitSyncStatus.git_installed) ||
                    false
                  }
                  onClick={async () => {
                    setGitSyncBusy(true);
                    setGitSyncMessage(null);
                    try {
                      await invoke("git_sync_now");
                    } catch (err) {
                      setGitSyncMessage({ kind: "error", text: String(err) });
                      setGitSyncBusy(false);
                    }
                  }}
                >
                  🔄 지금 동기화
                </button>
              </div>

              {/* 결과 메시지 */}
              {gitSyncMessage && (
                <div
                  style={{
                    marginTop: 12,
                    padding: "10px 12px",
                    background:
                      gitSyncMessage.kind === "ok"
                        ? "rgba(34, 197, 94, 0.1)"
                        : gitSyncMessage.kind === "conflict"
                          ? "rgba(234, 179, 8, 0.1)"
                          : "rgba(239, 68, 68, 0.1)",
                    border:
                      gitSyncMessage.kind === "ok"
                        ? "1px solid rgba(34, 197, 94, 0.4)"
                        : gitSyncMessage.kind === "conflict"
                          ? "1px solid rgba(234, 179, 8, 0.5)"
                          : "1px solid rgba(239, 68, 68, 0.4)",
                    borderRadius: 6,
                    fontSize: "0.85em",
                    lineHeight: 1.5,
                  }}
                >
                  <strong>
                    {gitSyncMessage.kind === "ok"
                      ? "✓ "
                      : gitSyncMessage.kind === "conflict"
                        ? "🔀 충돌 — "
                        : "⚠ "}
                  </strong>
                  {gitSyncMessage.target ? `[${gitSyncMessage.target}] ` : ""}
                  {gitSyncMessage.text}
                </div>
              )}

              {/* 충돌 파일 + 해결 UI (Phase 89 — target 함께 박음) */}
              {gitSyncConflict && gitSyncConflict.files.length > 0 && (
                <div
                  style={{
                    marginTop: 10,
                    padding: "10px 12px",
                    background: "rgba(234, 179, 8, 0.08)",
                    border: "1px solid rgba(234, 179, 8, 0.4)",
                    borderRadius: 6,
                    fontSize: "0.85em",
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>
                    [{gitSyncConflict.target}] 충돌 파일 ({gitSyncConflict.files.length}개):
                  </div>
                  <ul style={{ margin: "4px 0 8px 18px", padding: 0, fontFamily: "monospace", fontSize: "0.85em" }}>
                    {gitSyncConflict.files.slice(0, 8).map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                    {gitSyncConflict.files.length > 8 && (
                      <li style={{ opacity: 0.7 }}>... 외 {gitSyncConflict.files.length - 8}개</li>
                    )}
                  </ul>
                  <div style={{ marginTop: 6, opacity: 0.85, fontSize: "0.82em" }}>
                    어느 쪽 변경을 유지할까요? (모든 충돌 파일에 동일 적용)
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button
                      className="settings-btn"
                      disabled={gitSyncBusy}
                      onClick={async () => {
                        setGitSyncBusy(true);
                        try {
                          await invoke("git_sync_resolve_conflict", {
                            keep: "local",
                            target: gitSyncConflict.target,
                          });
                        } catch (err) {
                          setGitSyncMessage({ kind: "error", text: String(err) });
                          setGitSyncBusy(false);
                        }
                      }}
                    >
                      💻 이 PC 변경 유지
                    </button>
                    <button
                      className="settings-btn"
                      disabled={gitSyncBusy}
                      onClick={async () => {
                        setGitSyncBusy(true);
                        try {
                          await invoke("git_sync_resolve_conflict", {
                            keep: "remote",
                            target: gitSyncConflict.target,
                          });
                        } catch (err) {
                          setGitSyncMessage({ kind: "error", text: String(err) });
                          setGitSyncBusy(false);
                        }
                      }}
                    >
                      ☁️ remote 변경 유지
                    </button>
                  </div>
                </div>
              )}

              {/* 상태 카드 — personal + team 둘 다 */}
              {gitSyncStatus && (
                <div
                  style={{
                    marginTop: 12,
                    padding: "10px 12px",
                    background: "var(--bg-1)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: 6,
                    fontSize: "0.83em",
                    fontFamily: "monospace",
                    opacity: 0.92,
                  }}
                >
                  <div>
                    git: {gitSyncStatus.git_installed
                      ? `✓ ${gitSyncStatus.git_version ?? ""}`
                      : "❌ 미설치"}
                  </div>
                  <div style={{ marginTop: 4 }}>
                    💻 personal: init {gitSyncStatus.initialized ? "✓" : "—"} · remote{" "}
                    {gitSyncStatus.has_remote ? "✓" : "—"} · branch {gitSyncStatus.branch ?? "(없음)"} · 변경{" "}
                    {gitSyncStatus.local_changes}개
                  </div>
                  <div>
                    👥 team: init {gitSyncStatus.team_initialized ? "✓" : "—"} · remote{" "}
                    {gitSyncStatus.team_has_remote ? "✓" : "—"} · branch {gitSyncStatus.team_branch ?? "(없음)"} · 변경{" "}
                    {gitSyncStatus.team_local_changes}개
                  </div>
                  <div style={{ marginTop: 4 }}>
                    마지막 sync:{" "}
                    {gitSyncStatus.last_sync_at > 0
                      ? new Date(gitSyncStatus.last_sync_at * 1000).toLocaleString("ko-KR")
                      : "(아직 안 함)"}
                  </div>
                  <div>상태: {gitSyncStatus.last_sync_status || "(없음)"}</div>
                </div>
              )}

              {/* Phase 91 — Commit history viewer */}
              <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  className="settings-btn"
                  disabled={gitSyncLogBusy || !gitSyncRepoUrl}
                  onClick={async () => {
                    setGitSyncLogBusy(true);
                    try {
                      await invoke("git_sync_log_request", { target: "personal", limit: 20 });
                    } catch (err) {
                      setGitSyncLogBusy(false);
                      setGitSyncMessage({ kind: "error", text: String(err) });
                    }
                  }}
                  style={{ fontSize: "0.85em" }}
                >
                  📜 Personal history
                </button>
                <button
                  className="settings-btn"
                  disabled={gitSyncLogBusy || !gitSyncTeamRepoUrl}
                  onClick={async () => {
                    setGitSyncLogBusy(true);
                    try {
                      await invoke("git_sync_log_request", { target: "team", limit: 20 });
                    } catch (err) {
                      setGitSyncLogBusy(false);
                      setGitSyncMessage({ kind: "error", text: String(err) });
                    }
                  }}
                  style={{ fontSize: "0.85em" }}
                >
                  📜 Team history
                </button>
                {gitSyncLog && (
                  <button
                    className="settings-btn"
                    onClick={() => setGitSyncLog(null)}
                    style={{ fontSize: "0.85em", opacity: 0.7 }}
                  >
                    ✕ 닫기
                  </button>
                )}
              </div>
              {gitSyncLog && (
                <div
                  style={{
                    marginTop: 10,
                    padding: "10px 12px",
                    background: "var(--bg-1)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: 6,
                    fontSize: "0.82em",
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>
                    📜 {gitSyncLog.target === "personal" ? "💻 Personal" : "👥 Team"} commit history ({gitSyncLog.commits.length}개)
                  </div>
                  {!gitSyncLog.ok && (
                    <div style={{ color: "#f87171", marginBottom: 6 }}>⚠ {gitSyncLog.message}</div>
                  )}
                  {gitSyncLog.commits.length === 0 ? (
                    <div style={{ opacity: 0.6 }}>commit 없음</div>
                  ) : (
                    <div
                      style={{
                        maxHeight: 240,
                        overflowY: "auto",
                        fontFamily: "monospace",
                        fontSize: "0.85em",
                      }}
                    >
                      {gitSyncLog.commits.map((c) => (
                        <div
                          key={c.hash}
                          style={{
                            padding: "4px 0",
                            borderBottom: "1px dashed var(--border-subtle)",
                          }}
                          title={`${c.hash}\n${c.author} @ ${c.date}`}
                        >
                          <div style={{ opacity: 0.7, fontSize: "0.92em" }}>
                            {c.hash.slice(0, 7)} · {c.date.slice(0, 16)} · {c.author}
                          </div>
                          <div style={{ marginTop: 1 }}>{c.subject}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Phase 91 (v0.6.33) — SafeMode 자동 전환 스케줄. */}
          <section className="settings-section" data-tab="safety">
            <div className="eyebrow">🕒 SafeMode 자동 전환 스케줄</div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-info">
                <div className="settings-row-title">요일·시간대별 자동 모드 변경</div>
                <div className="settings-row-desc">
                  설정한 시각에 SafeMode 가 자동 전환됩니다. 매칭 규칙이 없으면 K 의 마지막 수동 선택 유지.
                  여러 규칙이 동시 매칭되면 위에 있는 것이 우선.
                  <br />
                  <span style={{ opacity: 0.7 }}>
                    예: 평일 9-18시 strict (회사) · 주말 종일 off · 야간 22-24시 balanced
                  </span>
                </div>
              </div>

              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                {scheduleRules.length === 0 && (
                  <div
                    style={{
                      padding: "10px 12px",
                      background: "var(--bg-1)",
                      border: "1px dashed var(--border-subtle)",
                      borderRadius: 6,
                      fontSize: "0.85em",
                      opacity: 0.7,
                    }}
                  >
                    아직 규칙 없음 — 아래 "+ 규칙 추가" 로 시작
                  </div>
                )}
                {scheduleRules.map((rule, idx) => (
                  <div
                    key={rule.id}
                    style={{
                      padding: "8px 10px",
                      background: rule.enabled ? "var(--bg-1)" : "rgba(255,255,255,0.02)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: 6,
                      opacity: rule.enabled ? 1 : 0.55,
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      fontSize: "0.85em",
                    }}
                  >
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={(e) => {
                          const next = [...scheduleRules];
                          next[idx] = { ...rule, enabled: e.target.checked };
                          setScheduleRules(next);
                          saveSchedule(next);
                        }}
                        title="활성화 토글"
                      />
                      <input
                        type="text"
                        className="settings-input"
                        placeholder="라벨 (예: 회사 PC)"
                        value={rule.label ?? ""}
                        onChange={(e) => {
                          const next = [...scheduleRules];
                          next[idx] = { ...rule, label: e.target.value };
                          setScheduleRules(next);
                          saveSchedule(next);
                        }}
                        style={{ flex: 1, minWidth: 120, fontSize: "0.92em" }}
                      />
                      <select
                        value={rule.mode}
                        onChange={(e) => {
                          const next = [...scheduleRules];
                          next[idx] = { ...rule, mode: e.target.value as SafeMode };
                          setScheduleRules(next);
                          saveSchedule(next);
                        }}
                        style={{ fontSize: "0.92em" }}
                      >
                        <option value="off">🟢 끔</option>
                        <option value="balanced">🟡 균형</option>
                        <option value="strict">🔴 엄격</option>
                      </select>
                      <button
                        onClick={() => {
                          const next = scheduleRules.filter((_, i) => i !== idx);
                          setScheduleRules(next);
                          saveSchedule(next);
                        }}
                        style={{
                          background: "transparent",
                          border: "1px solid var(--border-subtle)",
                          color: "inherit",
                          cursor: "pointer",
                          fontSize: "0.85em",
                          padding: "2px 8px",
                          borderRadius: 4,
                          opacity: 0.7,
                        }}
                        title="규칙 삭제"
                      >
                        🗑️
                      </button>
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ opacity: 0.7, fontSize: "0.88em" }}>요일:</span>
                      {DAYS_LIST.map((d) => (
                        <label
                          key={d.value}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 2,
                            cursor: "pointer",
                            fontSize: "0.85em",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={rule.days.includes(d.value)}
                            onChange={(e) => {
                              const next = [...scheduleRules];
                              const newDays = e.target.checked
                                ? [...rule.days, d.value]
                                : rule.days.filter((x) => x !== d.value);
                              next[idx] = { ...rule, days: newDays as DayOfWeek[] };
                              setScheduleRules(next);
                              saveSchedule(next);
                            }}
                          />
                          {d.label}
                        </label>
                      ))}
                      <span style={{ marginLeft: 8, opacity: 0.7, fontSize: "0.88em" }}>시간:</span>
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={rule.startHour}
                        onChange={(e) => {
                          const next = [...scheduleRules];
                          const v = Math.max(0, Math.min(23, parseInt(e.target.value) || 0));
                          next[idx] = { ...rule, startHour: v };
                          setScheduleRules(next);
                          saveSchedule(next);
                        }}
                        style={{ width: 54, fontSize: "0.92em" }}
                        title="시작 시 (0-23)"
                      />
                      <span style={{ opacity: 0.6 }}>~</span>
                      <input
                        type="number"
                        min={1}
                        max={24}
                        value={rule.endHour}
                        onChange={(e) => {
                          const next = [...scheduleRules];
                          const v = Math.max(1, Math.min(24, parseInt(e.target.value) || 24));
                          next[idx] = { ...rule, endHour: v };
                          setScheduleRules(next);
                          saveSchedule(next);
                        }}
                        style={{ width: 54, fontSize: "0.92em" }}
                        title="끝 시 (1-24, 배제)"
                      />
                    </div>
                    <div style={{ opacity: 0.6, fontSize: "0.78em" }}>
                      → {formatDays(rule.days)} {formatHourRange(rule.startHour, rule.endHour)} ·{" "}
                      {rule.mode === "off" ? "🟢 끔" : rule.mode === "balanced" ? "🟡 균형" : "🔴 엄격"}
                    </div>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  <button
                    className="settings-btn"
                    onClick={() => {
                      const next = [...scheduleRules, newRule()];
                      setScheduleRules(next);
                      saveSchedule(next);
                    }}
                    style={{ fontSize: "0.85em" }}
                  >
                    + 규칙 추가
                  </button>
                  <button
                    className="settings-btn"
                    onClick={() => {
                      // preset: 평일 9-18 strict / 주말 off / 야간 balanced
                      const preset: SafeModeRule[] = [
                        { ...newRule(), label: "회사 평일", days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18, mode: "strict" },
                        { ...newRule(), label: "주말 자유", days: [0, 6], startHour: 0, endHour: 24, mode: "off" },
                        { ...newRule(), label: "야간", days: [0, 1, 2, 3, 4, 5, 6], startHour: 22, endHour: 24, mode: "balanced" },
                      ];
                      setScheduleRules(preset);
                      saveSchedule(preset);
                    }}
                    style={{ fontSize: "0.85em", opacity: 0.85 }}
                    title="평일 9-18 strict / 주말 off / 야간 balanced"
                  >
                    📋 기본 preset 적용
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* Phase 84 (v0.6.27) — Connector/Tool Safety Layer (Lee #6).
              카테고리별 위험도 schema + SafeMode 토글 (off/balanced/strict).
              balanced: 높음↑ 카테고리를 ask 로. strict: 보통↑ ask, 높음↑ manual + 일부 도구 자동 차단.
              실제 권한 게이트는 sidecar 가 강제 — 이 토글은 매 turn 시작 시 sidecar 로 전달. */}
          <section className="settings-section" data-tab="safety">
            <div className="eyebrow">🛡️ Connector/Tool Safety Layer</div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-info">
                <div className="settings-row-title">위험도 기반 안전 모드</div>
                <div className="settings-row-desc">
                  각 카테고리에 <strong>위험도</strong> (🟢 낮음 / 🟡 보통 / 🟠 높음 / 🔴 치명) 를 부여하고,
                  Safe Mode 가 활성화되면 위험도 높은 카테고리를 자동으로 강등합니다.
                  K 의 개별 권한 설정(에이전트 탭) 위에 적용되는 추가 안전망 — Bash / fm_organize_folder /
                  app_kill 같은 도구는 strict 모드에서 카테고리와 무관하게 자동 차단됩니다.
                </div>
              </div>

              {/* 3-way SafeMode 토글 */}
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                {(["off", "balanced", "strict"] as SafeMode[]).map((mode) => {
                  const policy = SAFE_MODE_POLICIES[mode];
                  const isActive = safeMode === mode;
                  return (
                    <button
                      key={mode}
                      onClick={() => {
                        setSafeMode(mode);
                        try {
                          localStorage.setItem("kda_safe_mode", mode);
                        } catch {
                          /* ignore */
                        }
                      }}
                      style={{
                        flex: 1,
                        minWidth: 140,
                        padding: "8px 12px",
                        background: isActive ? "rgba(79,232,225,0.18)" : "var(--bg-1)",
                        border: isActive
                          ? "1.5px solid var(--accent, #4fe8e1)"
                          : "1px solid var(--border-subtle)",
                        borderRadius: 6,
                        cursor: "pointer",
                        textAlign: "left",
                        fontFamily: "inherit",
                        color: "inherit",
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>{policy.title}</div>
                      <div style={{ fontSize: "0.8em", opacity: 0.8, lineHeight: 1.45 }}>
                        {policy.description}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* 카테고리별 위험도 표 */}
              <div style={{ marginTop: 14 }}>
                <div className="eyebrow" style={{ fontSize: "0.78em", opacity: 0.8 }}>
                  카테고리별 위험도
                </div>
                <div
                  style={{
                    marginTop: 6,
                    display: "grid",
                    gridTemplateColumns: "auto 1fr auto",
                    gap: "4px 12px",
                    fontSize: "0.85em",
                  }}
                >
                  {Object.entries(CATEGORY_RISK)
                    // 위험도 높은 순 정렬
                    .sort((a, b) => {
                      const order: Record<RiskLevel, number> = {
                        critical: 0,
                        high: 1,
                        medium: 2,
                        low: 3,
                      };
                      return order[a[1].level] - order[b[1].level];
                    })
                    .map(([id, row]) => {
                      const badge = RISK_BADGES[row.level];
                      return (
                        <div
                          key={id}
                          style={{
                            display: "contents",
                          }}
                        >
                          <div
                            style={{
                              color: badge.color,
                              fontWeight: 600,
                              fontSize: "0.85em",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {badge.icon} {badge.label}
                          </div>
                          <div style={{ fontFamily: "monospace", opacity: 0.95 }}>
                            {id}
                            <span style={{ marginLeft: 8, opacity: 0.7, fontWeight: "normal" }}>
                              {row.summary}
                            </span>
                          </div>
                          <div style={{ opacity: 0.55, fontSize: "0.78em", whiteSpace: "nowrap" }}>
                            {row.dimensions.join(" · ")}
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>

              {/* 현재 모드의 영향 미리보기 — 사용자가 어떤 카테고리가 강등될지 한눈에 */}
              {safeMode !== "off" && (
                <div
                  style={{
                    marginTop: 14,
                    padding: "10px 12px",
                    background: "rgba(249, 115, 22, 0.06)",
                    border: "1px solid rgba(249, 115, 22, 0.3)",
                    borderRadius: 6,
                    fontSize: "0.85em",
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>
                    📊 현재 모드 ({SAFE_MODE_POLICIES[safeMode].title}) 의 영향
                  </div>
                  <ul style={{ margin: "4px 0 4px 18px", padding: 0, lineHeight: 1.55 }}>
                    {SAFE_MODE_POLICIES[safeMode].effect.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  {/* 현재 K 의 permissions 상태 기반 카테고리 강등 미리보기 */}
                  {(() => {
                    const effective: Record<string, "auto" | "ask" | "manual"> = {};
                    for (const p of permissions) {
                      effective[p.id] = p.level;
                    }
                    const changes = previewSafeModeImpact(effective, safeMode);
                    if (changes.length === 0) {
                      return (
                        <div style={{ marginTop: 6, opacity: 0.75 }}>
                          현재 권한 설정에서 강등될 카테고리는 없습니다 (이미 ask/manual).
                        </div>
                      );
                    }
                    return (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ opacity: 0.8, marginBottom: 4 }}>
                          현재 설정에서 강등되는 카테고리 ({changes.length}개):
                        </div>
                        <div style={{ fontFamily: "monospace", fontSize: "0.82em", lineHeight: 1.6 }}>
                          {changes.map((c) => (
                            <div key={c.id}>
                              {RISK_BADGES[c.risk].icon} <strong>{c.id}</strong> ·{" "}
                              <span style={{ opacity: 0.7 }}>{c.from}</span> →{" "}
                              <span style={{ color: "#f97316", fontWeight: 600 }}>{c.to}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                  {safeMode === "strict" && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ opacity: 0.8, marginBottom: 4 }}>
                        strict 추가 자동 차단 ({STRICT_BLOCKED_TOOLS.length}개):
                      </div>
                      <div style={{ fontFamily: "monospace", fontSize: "0.82em", opacity: 0.85 }}>
                        {STRICT_BLOCKED_TOOLS.map((t) => (
                          <div key={t}>🔴 {t}</div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Phase 81 (v0.6.25) — Lee Profile + Memory Auto-Loader.
              ~/.kda/lee-profile.md 의 내용이 매 turn 시작 시 system prompt 첫머리에 prepend.
              K 본인이 직접 정의한 응답 스타일/규칙 (예: "한국어 우선", "증거 없는 완료 보고 금지" 등). */}
          <section className="settings-section" data-tab="safety">
            <div className="eyebrow">🪪 Lee Profile (개인 응답 규칙)</div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-info">
                <div className="settings-row-title">~/.kda/lee-profile.md</div>
                <div className="settings-row-desc">
                  K 본인이 직접 정의한 응답 스타일 / 작업 규칙 / 금지 사항을 마크다운으로 작성하면,
                  매 turn 시작 시 sidecar 가 system prompt 첫머리에 자동 prepend 합니다.
                  같은 폴더의 <code>memory/*.md</code> (pitfall / feedback) 도 함께 박힙니다
                  (Lee 의 학습효과 패치 #1 — Memory Auto-Loader).
                  <br />
                  <span style={{ opacity: 0.7 }}>
                    파일이 없으면 "지금 편집" 클릭 시 example template 자동 생성.
                    합쳐서 32KB 초과하면 자동 trim (system prompt 폭발 방지).
                  </span>
                </div>
                {leeProfile && (
                  <div className="mono" style={{ fontSize: "0.8em", opacity: 0.75, marginTop: 6 }}>
                    📄 {leeProfile.path} ({leeProfile.bytes} bytes)
                    {leeProfile.justCreated && (
                      <span style={{ color: "#fa0", marginLeft: 8 }}>
                        ⓘ 방금 example template 생성됨 — 편집해서 K 의 규칙을 채우세요
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button
                  className="settings-btn"
                  disabled={leeProfileBusy}
                  onClick={async () => {
                    setLeeProfileBusy(true);
                    try {
                      const result = await invoke<{ path: string; bytes: number; justCreated: boolean }>(
                        "read_lee_profile"
                      );
                      setLeeProfile(result);
                      await invoke("open_lee_profile_in_editor");
                    } catch (e) {
                      alert(`lee-profile.md 열기 실패: ${e}`);
                    } finally {
                      setLeeProfileBusy(false);
                    }
                  }}
                >
                  ✏️ 지금 편집 (OS 기본 에디터)
                </button>
                <button
                  className="settings-btn"
                  disabled={leeProfileBusy}
                  onClick={async () => {
                    try {
                      const result = await invoke<{ path: string; bytes: number; justCreated: boolean }>(
                        "read_lee_profile"
                      );
                      setLeeProfile(result);
                    } catch (e) {
                      alert(`lee-profile.md 읽기 실패: ${e}`);
                    }
                  }}
                >
                  🔄 상태 새로고침
                </button>
              </div>
            </div>
          </section>

          {/* Phase 80 (v0.6.24) — Final-Review Gate toggle. SIGILFALL 등 대량 생성 raw 컷이
              사용자에게 노출되지 않도록 qa-report.json 의 FINAL_CANDIDATE 만 미리보기 허용. */}
          <section className="settings-section" data-tab="safety">
            <div className="eyebrow">🛡️ Final-Review Gate</div>
            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-title">미리보기 전 QA 리포트 검사 (default ON)</div>
                <div className="settings-row-desc">
                  채팅 마크다운의 이미지/비디오/PDF 링크 클릭 시 같은 폴더의 <code>qa-report.json</code> 을
                  검사 → <code>FINAL_CANDIDATE</code> 만 표시. HOLD/FAIL/누락은 차단 + "강제 열기" 옵션 제공.
                  raw 생성 컷이 K 에게 자동 노출되는 걸 방지 (Lee 의 학습효과 패치 #2).
                  <br />
                  <span style={{ opacity: 0.7 }}>
                    qa-report.json 형식:
                    <code>{` { "version": 1, "files": { "<filename>": { "status": "FINAL_CANDIDATE" } } }`}</code>
                  </span>
                  <br />
                  <span style={{ opacity: 0.7 }}>
                    OFF 면 검사 skip — 모든 파일이 그대로 미리보기 됩니다 (v0.6.23 이전 동작).
                  </span>
                </div>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={finalReviewGate}
                  onChange={toggleFinalReviewGate}
                  disabled={finalReviewGateBusy}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>
          </section>

          <section className="settings-section" data-tab="system">
            <div className="eyebrow">단축키</div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-info">
                <div className="settings-row-title">전역 단축키</div>
                <div className="settings-row-desc">
                  어떤 앱에서든 사용할 수 있는 시스템 단축키
                </div>
              </div>
              <div className="shortcuts-list">
                <div className="shortcut-item">
                  <span className="shortcut-key mono">Ctrl+Shift+Space</span>
                  <span className="shortcut-desc">창 표시/숨김 토글</span>
                </div>
                <div className="shortcut-item">
                  <span className="shortcut-key mono">Ctrl+Shift+S</span>
                  <span className="shortcut-desc">스크린샷 캡처 후 분석</span>
                </div>
                <div className="shortcut-item">
                  <span className="shortcut-key mono">Ctrl+Shift+P</span>
                  <span className="shortcut-desc">빠른 명령 팔레트</span>
                </div>
              </div>
            </div>
          </section>

          {/* Phase 75 (v0.6.18) — Codex 좀비 process detect + 안전 정리 */}
          <section className="settings-section" data-tab="system">
            <div className="eyebrow">🧟 좀비 codex 프로세스</div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-info">
                <div className="settings-row-title">오래된 codex / node / powershell 프로세스</div>
                <div className="settings-row-desc">
                  KDA 가 "Reconnecting... 2/5 (timeout waiting for child process to exit)" 같이 막힐 때,
                  이전 세션의 codex 자식 프로세스가 정리 안 된 게 원인. 1시간 이상 떠있고 commandLine 에
                  "codex" 가 포함된 것들을 찾아서 K 가 직접 정리. <strong>자동 kill 안 함</strong> —
                  K 의 다른 PC 작업을 죽일 위험 회피.
                </div>
              </div>
              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                <button
                  className="settings-btn"
                  disabled={staleProcessesBusy}
                  onClick={async () => {
                    setStaleProcessesBusy(true);
                    setStaleProcessesError(null);
                    try {
                      const list = await invoke<StaleProcess[]>("list_stale_codex_processes");
                      setStaleProcesses(list);
                    } catch (e) {
                      setStaleProcessesError(String(e));
                      setStaleProcesses(null);
                    } finally {
                      setStaleProcessesBusy(false);
                    }
                  }}
                  title="현재 K's user 권한의 stale codex 프로세스 검색"
                >
                  {staleProcessesBusy ? "검색 중…" : "🔍 지금 검사"}
                </button>
                {staleProcesses && staleProcesses.length > 0 && (
                  <button
                    className="settings-btn settings-btn-danger"
                    disabled={staleProcessesBusy}
                    onClick={async () => {
                      // Phase 76 (v0.6.19): 의심 후보가 섞여있으면 추가 경고
                      const confirmedCount = staleProcesses.filter((p) => !p.suspected).length;
                      const suspectedCount = staleProcesses.filter((p) => p.suspected).length;
                      const msg =
                        suspectedCount > 0
                          ? `${staleProcesses.length}개의 프로세스를 모두 정리합니다.\n` +
                            `  ✓ 확정 후보 (cmdline 에 "codex"): ${confirmedCount}개\n` +
                            `  ⚠ 의심 후보 (cmdline 못 읽음): ${suspectedCount}개\n\n` +
                            `의심 후보는 다른 도구의 node 일 수도 있습니다. 진행할까요?`
                          : `${staleProcesses.length}개의 좀비 프로세스를 모두 정리합니다. 진행할까요?`;
                      if (!confirm(msg)) return;
                      setStaleProcessesBusy(true);
                      let killed = 0;
                      let failed: string[] = [];
                      for (const p of staleProcesses) {
                        try {
                          await invoke("kill_process_tree", { pid: p.pid });
                          killed++;
                        } catch (e) {
                          failed.push(`PID ${p.pid}: ${e}`);
                        }
                      }
                      // 재검사
                      try {
                        const list = await invoke<StaleProcess[]>("list_stale_codex_processes");
                        setStaleProcesses(list);
                        if (failed.length > 0) {
                          setStaleProcessesError(`정리 완료 ${killed}개, 실패 ${failed.length}개:\n${failed.join("\n")}`);
                        } else {
                          setStaleProcessesError(null);
                        }
                      } finally {
                        setStaleProcessesBusy(false);
                      }
                    }}
                    title="모두 taskkill /F /T 실행"
                  >
                    🧹 모두 정리 ({staleProcesses.length}개)
                  </button>
                )}
              </div>

              {staleProcessesError && (
                <div className="update-error-section" style={{ marginTop: "0.5rem" }}>
                  <div className="update-status update-error" style={{ whiteSpace: "pre-wrap" }}>
                    ⚠ {staleProcessesError}
                  </div>
                </div>
              )}

              {staleProcesses && staleProcesses.length === 0 && !staleProcessesError && (
                <div className="settings-row-desc" style={{ marginTop: "0.5rem", color: "#4a9" }}>
                  ✓ 좀비 프로세스 없음 (1시간 이상 떠있는 codex 관련 프로세스 0개).
                </div>
              )}

              {staleProcesses && staleProcesses.length > 0 && (
                <div style={{ marginTop: "0.7rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                  {staleProcesses.map((p) => (
                    <div
                      key={p.pid}
                      style={{
                        padding: "0.5rem 0.7rem",
                        background: "var(--bg-1)",
                        border: "1px solid var(--border-subtle)",
                        borderRadius: "4px",
                        fontSize: "0.85em",
                      }}
                    >
                      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                        <span className="mono" style={{ fontWeight: 600 }}>PID {p.pid}</span>
                        <span className="mono">{p.name}</span>
                        {/* Phase 76 (v0.6.19): suspected 라벨 — cmdline 못 읽은 후보 (false positive 위험) */}
                        {p.suspected && (
                          <span
                            title="cmdline 못 읽음 (권한 부족) — 다른 도구(IDE, dev server 등)의 node 일 수도 있음. K가 직접 판단."
                            style={{
                              padding: "0.1rem 0.4rem",
                              borderRadius: "3px",
                              background: "rgba(255, 170, 0, 0.15)",
                              color: "#fa0",
                              border: "1px solid rgba(255, 170, 0, 0.4)",
                              fontSize: "0.75em",
                              fontWeight: 600,
                            }}
                          >
                            ⚠ 의심
                          </span>
                        )}
                        <span style={{ opacity: 0.7 }}>{p.start_time}</span>
                        <span style={{ opacity: 0.7, color: p.age_hours > 24 ? "#fa0" : undefined }}>
                          {p.age_hours.toFixed(1)}h 전 시작
                        </span>
                        <button
                          className="settings-btn settings-btn-danger"
                          style={{ marginLeft: "auto", padding: "0.2rem 0.5rem", fontSize: "0.85em" }}
                          disabled={staleProcessesBusy}
                          onClick={async () => {
                            const warn = p.suspected
                              ? `\n⚠ 의심 후보 (cmdline 못 읽음) — 다른 도구의 node 일 수도 있음. 확실하지 않으면 작업관리자에서 먼저 확인하세요.`
                              : "";
                            if (!confirm(`PID ${p.pid} (${p.name}) 및 child tree 를 강제 종료합니다.${warn}`)) return;
                            try {
                              await invoke("kill_process_tree", { pid: p.pid });
                              const list = await invoke<StaleProcess[]>("list_stale_codex_processes");
                              setStaleProcesses(list);
                            } catch (e) {
                              setStaleProcessesError(`PID ${p.pid} kill 실패: ${e}`);
                            }
                          }}
                        >
                          ✕ kill
                        </button>
                      </div>
                      {p.command_line && (
                        <div
                          className="mono"
                          style={{
                            marginTop: "0.3rem",
                            fontSize: "0.8em",
                            opacity: 0.75,
                            wordBreak: "break-all",
                          }}
                        >
                          {p.command_line}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="settings-section" data-tab="system">
            <div className="eyebrow">앱</div>
            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-title">앱 종료</div>
                <div className="settings-row-desc">
                  창을 X로 닫으면 트레이로만 숨기고, 완전 종료는 여기서
                </div>
              </div>
              <button className="settings-btn settings-btn-danger" onClick={handleQuit}>
                종료
              </button>
            </div>
          </section>

          {/* ─── Phase 67 (v0.6.2) — MCP 도구 탭 ──────────────────────── */}

          {/* 67a — 현재 활성 도구 인스펙터 */}
          <section className="settings-section" data-tab="tools">
            <div className="eyebrow">🔧 활성 MCP 도구</div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-info">
                <div className="settings-row-title">
                  K-Personal MCP 노출 도구
                  {mcpTools && mcpTools.length > 0 && (
                    <span style={{ marginLeft: "0.5em", opacity: 0.7, fontSize: "0.85em" }}>
                      ({mcpTools.length}개)
                    </span>
                  )}
                  {/* Phase 68 (v0.6.12) — server identity tooltip (옛 sidecar 면 "?@?" 로 표시되거나 빈 상태) */}
                  {mcpServerInfo && (mcpServerInfo.name || mcpServerInfo.version) && (
                    <span
                      style={{ marginLeft: "0.6em", opacity: 0.55, fontSize: "0.78em", fontFamily: "var(--mono, monospace)" }}
                      title={
                        `source: ${mcpServerInfo.name ?? "?"}@${mcpServerInfo.version ?? "?"}` +
                        (mcpServerInfo.cause === "auto" ? " (sidecar 의 ping 시점에 자동 갱신)" :
                          mcpServerInfo.cause === "request" ? " (Settings 의 명시 요청 응답)" : "")
                      }
                    >
                      {mcpServerInfo.name ?? "?"}@{mcpServerInfo.version ?? "?"}
                    </span>
                  )}
                </div>
                <div className="settings-row-desc">
                  지금 KDA 의 sidecar 가 K-Personal-MCP server.py 로부터 받은 도구 목록입니다.
                  채팅에서 모델 (Claude / Codex / OpenAI / Gemini) 이 호출 가능한 도구의 정확한 set.
                  Claude CLI / Codex CLI 의 경우 권한 정책으로 일부가 잠겼을 수 있어 실제로 호출되는 set 은 더 작을 수 있음.
                </div>
              </div>

              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
                <input
                  type="text"
                  className="settings-input"
                  placeholder="이름/설명으로 필터… (예: web_, db_, kda_)"
                  value={toolFilter}
                  onChange={(e) => setToolFilter(e.target.value)}
                  style={{ flex: 1, minWidth: "200px" }}
                />
                <button
                  className="settings-btn"
                  onClick={() => requestMcpToolsRefresh(true)}
                  disabled={mcpToolsBusy}
                  title="sidecar 에 도구 목록 재조회 요청"
                >
                  {mcpToolsBusy ? "조회 중…" : "🔄 새로고침"}
                </button>
              </div>

              {mcpToolsError && (
                <div className="update-error-section" style={{ marginTop: "0.5rem" }}>
                  <div className="update-status update-error">⚠ {mcpToolsError}</div>
                  <div className="settings-row-desc" style={{ marginTop: "0.3rem", fontSize: "0.85em" }}>
                    K-Personal MCP 가 설치 안 됐거나 Python 이 없는 상태일 수 있습니다.
                    위의 "MCP 도구 자동 설치" 또는 "외부 의존성 자동 설치" 먼저 확인하세요.
                  </div>
                </div>
              )}

              {/* Phase 70 — mcpTools=null 케이스 visible 안내 (이전엔 분기 셋 다 false 라 진짜 빈 화면이었음) */}
              {!mcpTools && !mcpToolsError && (
                <div className="settings-row-desc" style={{ marginTop: "0.5rem", opacity: 0.85, color: "#fa0" }}>
                  ⏳ mcpTools state = null (listener 트리거 됐는데 state 갱신 안 됨).
                  sidecar.log 의 <code>[settings] setMcpTools</code> 라인 확인 + KDA 재시작.
                </div>
              )}

              {mcpTools && mcpTools.length === 0 && !mcpToolsError && (
                <div className="settings-row-desc" style={{ marginTop: "0.5rem", opacity: 0.7 }}>
                  도구가 없습니다. K-Personal-MCP 설치 상태를 확인하세요.
                </div>
              )}

              {mcpTools && mcpTools.length > 0 && (
                <div style={{ marginTop: "0.7rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                  {mcpTools
                    .filter((t) => {
                      if (!toolFilter.trim()) return true;
                      const q = toolFilter.trim().toLowerCase();
                      return (
                        t.name.toLowerCase().includes(q) ||
                        (t.description ?? "").toLowerCase().includes(q)
                      );
                    })
                    .map((tool) => {
                      const expanded = expandedTool === tool.name;
                      const props = (tool.inputSchema?.properties ?? {}) as Record<
                        string,
                        { type?: string; description?: string; enum?: string[]; default?: unknown }
                      >;
                      const required = Array.isArray(tool.inputSchema?.required)
                        ? (tool.inputSchema!.required as string[])
                        : [];
                      const propEntries = Object.entries(props);
                      const isKdaCustom = tool.name.startsWith("kda_");
                      return (
                        <div
                          key={tool.name}
                          className="settings-tool-card"
                          style={{
                            padding: "0.6rem 0.8rem",
                            background: "var(--bg-1)",
                            border: "1px solid var(--border-subtle)",
                            borderLeft: isKdaCustom ? "3px solid var(--accent, #4fe8e1)" : "1px solid var(--border-subtle)",
                            borderRadius: "4px",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              cursor: "pointer",
                              gap: "0.5rem",
                            }}
                            onClick={() => setExpandedTool(expanded ? null : tool.name)}
                          >
                            <span style={{ fontFamily: "monospace", fontWeight: 600 }}>{tool.name}</span>
                            {isKdaCustom && (
                              <span
                                style={{
                                  fontSize: "0.7em",
                                  padding: "0.1em 0.4em",
                                  background: "rgba(79,232,225,0.15)",
                                  border: "1px solid rgba(79,232,225,0.5)",
                                  borderRadius: "3px",
                                  color: "var(--accent, #4fe8e1)",
                                }}
                              >
                                커스텀
                              </span>
                            )}
                            <span style={{ marginLeft: "auto", opacity: 0.5, fontSize: "0.8em" }}>
                              {expanded ? "▼" : "▶"}
                            </span>
                          </div>
                          {tool.description && (
                            <div
                              style={{
                                marginTop: "0.3rem",
                                fontSize: "0.88em",
                                opacity: 0.85,
                                lineHeight: 1.4,
                              }}
                            >
                              {tool.description}
                            </div>
                          )}
                          {expanded && (
                            <div style={{ marginTop: "0.5rem", fontSize: "0.85em" }}>
                              {propEntries.length === 0 ? (
                                <div style={{ opacity: 0.6 }}>인자 없음</div>
                              ) : (
                                <table
                                  style={{
                                    width: "100%",
                                    borderCollapse: "collapse",
                                    fontFamily: "monospace",
                                    fontSize: "0.85em",
                                  }}
                                >
                                  <thead>
                                    <tr style={{ opacity: 0.6, textAlign: "left" }}>
                                      <th style={{ padding: "0.2em 0.4em" }}>이름</th>
                                      <th style={{ padding: "0.2em 0.4em" }}>타입</th>
                                      <th style={{ padding: "0.2em 0.4em" }}>설명</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {propEntries.map(([key, spec]) => (
                                      <tr key={key} style={{ borderTop: "1px dashed var(--border-subtle)" }}>
                                        <td style={{ padding: "0.2em 0.4em" }}>
                                          {key}
                                          {required.includes(key) && (
                                            <span style={{ color: "var(--danger, #f48771)", marginLeft: "0.2em" }}>*</span>
                                          )}
                                        </td>
                                        <td style={{ padding: "0.2em 0.4em", opacity: 0.7 }}>
                                          {spec?.type ?? "?"}
                                          {Array.isArray(spec?.enum) && ` (${spec.enum.length})`}
                                        </td>
                                        <td style={{ padding: "0.2em 0.4em", whiteSpace: "normal", wordBreak: "break-word" }}>
                                          {spec?.description ?? ""}
                                          {spec?.default !== undefined && (
                                            <span style={{ opacity: 0.5 }}> · 기본 {JSON.stringify(spec.default)}</span>
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                              {isKdaCustom && (
                                <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.4rem" }}>
                                  <button
                                    className="settings-btn"
                                    style={{ fontSize: "0.85em", padding: "0.2em 0.6em" }}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      // kda_<name> → kda_<name>.py 파일로 열기
                                      openEditPluginEditor(`${tool.name.replace(/^kda_/, "kda_")}.py`);
                                    }}
                                    title="이 도구의 Python 코드 편집"
                                  >
                                    ✎ 편집
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}

              {!mcpTools && !mcpToolsError && (
                <div className="settings-row-desc" style={{ marginTop: "0.5rem", opacity: 0.6 }}>
                  도구 목록 로딩 중...
                </div>
              )}
            </div>
          </section>

          {/* 67b — 외부 MCP 서버 카탈로그 (명령 안내 형) */}
          <section className="settings-section" data-tab="tools">
            <div className="eyebrow">📦 추가 가능한 MCP 서버</div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-info">
                <div className="settings-row-title">표준 MCP 카탈로그 (참고)</div>
                <div className="settings-row-desc">
                  Anthropic 의 공식 MCP server 들. KDA 의 sidecar 는 현재 K-Personal MCP 한 개만 spawn 하므로,
                  이 서버들을 K 가 사용하려면 Claude Desktop / Cursor / IDE 등에서 별도 등록.
                  Claude CLI 의 <code>claude mcp add</code> 또는 Codex CLI 의 <code>codex mcp add</code> 사용.
                  <br />
                  <strong>(KDA 안에서 직접 사용은 다음 phase 후보 — 현재는 명령 복붙용 안내만)</strong>
                </div>
              </div>
              <div style={{ marginTop: "0.6rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {EXTERNAL_MCP_CATALOG.map((entry) => (
                  <div
                    key={entry.id}
                    style={{
                      padding: "0.6rem 0.8rem",
                      background: "var(--bg-1)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: "4px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <span style={{ fontSize: "1.1em" }}>{entry.icon}</span>
                      <span style={{ fontWeight: 600 }}>{entry.name}</span>
                      <button
                        className="settings-btn"
                        style={{ marginLeft: "auto", fontSize: "0.8em", padding: "0.2em 0.6em" }}
                        onClick={() =>
                          invoke("open_external_webview", {
                            url: entry.docsUrl,
                            label: `mcp-doc-${entry.id}`,
                            title: `${entry.name} docs`,
                          }).catch((e) => console.warn("doc 열기 실패:", e))
                        }
                      >
                        📖 문서
                      </button>
                    </div>
                    <div style={{ marginTop: "0.3rem", fontSize: "0.88em", opacity: 0.85 }}>
                      {entry.description}
                    </div>
                    {entry.note && (
                      <div
                        style={{
                          marginTop: "0.3rem",
                          fontSize: "0.82em",
                          color: "var(--warn, #d4ad4a)",
                        }}
                      >
                        ⚠ {entry.note}
                      </div>
                    )}
                    <div
                      style={{
                        marginTop: "0.4rem",
                        display: "flex",
                        gap: "0.3rem",
                        alignItems: "center",
                      }}
                    >
                      <code
                        style={{
                          flex: 1,
                          padding: "0.3em 0.5em",
                          background: "var(--bg-0)",
                          borderRadius: "3px",
                          fontSize: "0.85em",
                          fontFamily: "monospace",
                          overflowX: "auto",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {entry.installCommand}
                      </code>
                      <button
                        className="settings-btn"
                        style={{ fontSize: "0.8em", padding: "0.2em 0.6em" }}
                        onClick={() => {
                          navigator.clipboard
                            .writeText(entry.installCommand)
                            .then(() => console.info(`[catalog] ${entry.id} 명령 복사됨`))
                            .catch((e) => console.warn("clipboard 실패:", e));
                        }}
                        title="설치 명령 클립보드에 복사"
                      >
                        📋
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* 67c — 커스텀 plugin 빌더 */}
          <section className="settings-section" data-tab="tools">
            <div className="eyebrow">🧪 커스텀 도구 만들기</div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-info">
                <div className="settings-row-title">K-Personal-MCP plugin 빌더</div>
                <div className="settings-row-desc">
                  K 의 K-Personal-MCP/modules/kda_plugins/ 에 Python plugin 을 박아 새 MCP 도구를 추가합니다.
                  도구 이름은 <code>kda_</code> prefix 강제. 저장 시 sidecar 자동 재시작 → 도구가 모델에게 노출.
                  <br />
                  <strong style={{ color: "var(--warn, #d4ad4a)" }}>
                    ⚠ 보안: 이 코드는 K 의 PC 에서 직접 실행됩니다. 저장 전 K 가 모든 줄을 검토하세요.
                    이전 버전은 .bak 으로 자동 백업되어 K-Personal-MCP/modules/kda_plugins/ 에서 복구 가능.
                  </strong>
                </div>
              </div>

              <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                <button
                  className="settings-btn settings-btn-primary"
                  onClick={openNewPluginEditor}
                  disabled={editorOpen}
                >
                  + 새 도구 만들기
                </button>
                <button
                  className="settings-btn"
                  onClick={refreshPluginList}
                  title="modules/kda_plugins/ 디렉토리 재스캔"
                >
                  🔄 plugin 목록 새로고침
                </button>
              </div>

              {pluginListError && (
                <div className="update-status update-error" style={{ marginTop: "0.4rem" }}>
                  ⚠ {pluginListError}
                </div>
              )}

              {pluginList.length === 0 && !pluginListError && !editorOpen && (
                <div className="settings-row-desc" style={{ marginTop: "0.5rem", opacity: 0.6 }}>
                  아직 박은 커스텀 plugin 이 없습니다. "+ 새 도구 만들기" 로 시작하세요.
                </div>
              )}

              {pluginList.length > 0 && (
                <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                  {pluginList.map((p) => (
                    <div
                      key={p.file}
                      style={{
                        padding: "0.5rem 0.7rem",
                        background: "var(--bg-1)",
                        border: "1px solid var(--border-subtle)",
                        borderRadius: "4px",
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5rem",
                      }}
                    >
                      <span style={{ fontFamily: "monospace", fontWeight: 600 }}>{p.file}</span>
                      <span style={{ opacity: 0.5, fontSize: "0.85em" }}>
                        ({(p.size / 1024).toFixed(1)} KB · {new Date(p.modified_ms).toLocaleString("ko-KR")})
                      </span>
                      <button
                        className="settings-btn"
                        style={{ marginLeft: "auto", fontSize: "0.85em", padding: "0.2em 0.6em" }}
                        onClick={() => openEditPluginEditor(p.file)}
                      >
                        ✎ 편집
                      </button>
                      <button
                        className="settings-btn"
                        style={{
                          fontSize: "0.85em",
                          padding: "0.2em 0.6em",
                          color: "var(--danger, #f48771)",
                        }}
                        onClick={() => handleDeletePlugin(p.file)}
                      >
                        🗑 삭제
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {editorOpen && (
                <div
                  style={{
                    marginTop: "0.8rem",
                    padding: "0.8rem",
                    background: "var(--bg-1)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "4px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      marginBottom: "0.5rem",
                    }}
                  >
                    <strong>{editorMode === "new" ? "새 plugin" : "plugin 편집"}</strong>
                    <span style={{ opacity: 0.6, fontSize: "0.85em" }}>
                      → modules/kda_plugins/{editorName || "<name>"}.py
                    </span>
                    <button
                      className="settings-btn"
                      style={{ marginLeft: "auto", fontSize: "0.85em" }}
                      onClick={() => {
                        setEditorOpen(false);
                        setEditorMessage(null);
                      }}
                    >
                      ✕ 닫기
                    </button>
                  </div>

                  <div style={{ marginBottom: "0.5rem" }}>
                    <label
                      style={{ display: "block", fontSize: "0.85em", marginBottom: "0.2rem", opacity: 0.8 }}
                    >
                      plugin 이름 (kda_ prefix, ASCII 영문/숫자/_ 만):
                    </label>
                    <input
                      type="text"
                      className="settings-input"
                      value={editorName}
                      onChange={(e) => setEditorName(e.target.value)}
                      placeholder="kda_my_tool"
                      disabled={editorMode === "edit"}
                      style={{ width: "100%", fontFamily: "monospace" }}
                    />
                  </div>

                  <div style={{ marginBottom: "0.5rem" }}>
                    <label
                      style={{ display: "block", fontSize: "0.85em", marginBottom: "0.2rem", opacity: 0.8 }}
                    >
                      Python 코드:
                    </label>
                    <textarea
                      className="settings-input"
                      value={editorCode}
                      onChange={(e) => setEditorCode(e.target.value)}
                      rows={18}
                      style={{
                        width: "100%",
                        fontFamily: "monospace",
                        fontSize: "0.85em",
                        lineHeight: 1.4,
                        whiteSpace: "pre",
                        overflowWrap: "normal",
                        overflowX: "auto",
                      }}
                      spellCheck={false}
                    />
                  </div>

                  <div
                    style={{
                      marginBottom: "0.5rem",
                      padding: "0.5rem",
                      background: "var(--bg-0)",
                      borderRadius: "4px",
                    }}
                  >
                    <div style={{ fontSize: "0.85em", opacity: 0.8, marginBottom: "0.3rem" }}>
                      🤖 AI 에게 코드 작성 요청 (선택):
                    </div>
                    <textarea
                      className="settings-input"
                      value={builderRequest}
                      onChange={(e) => setBuilderRequest(e.target.value)}
                      rows={2}
                      placeholder="예: '환율 API 호출해서 USD/KRW 가져오는 도구'"
                      style={{ width: "100%", fontSize: "0.85em", marginBottom: "0.3rem" }}
                    />
                    <button
                      className="settings-btn"
                      onClick={handleAskModelToBuild}
                      disabled={!builderRequest.trim()}
                      style={{ fontSize: "0.85em" }}
                      title="K 의 메인 채팅에 prompt 박음 — 응답이 오면 코드 블록을 위 textarea 에 복사"
                    >
                      💬 메인 채팅에 prompt 보내기
                    </button>
                    <div style={{ fontSize: "0.78em", opacity: 0.6, marginTop: "0.3rem" }}>
                      모델 응답 확인 → 코드 검토 → 위 textarea 에 복사 → 저장. (자동 적용 안 함 — K 가 직접 검토 필수)
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                    <button
                      className="settings-btn settings-btn-primary"
                      onClick={handleSavePlugin}
                      disabled={editorBusy || !editorName.trim() || !editorCode.trim()}
                    >
                      {editorBusy ? "저장 중…" : "💾 저장 + sidecar 재시작"}
                    </button>
                    <button
                      className="settings-btn"
                      onClick={() => setEditorCode(KDA_PLUGIN_TEMPLATE)}
                      title="기본 템플릿으로 리셋"
                    >
                      ↩ 템플릿
                    </button>
                  </div>

                  {editorMessage && (
                    <div
                      style={{
                        marginTop: "0.5rem",
                        padding: "0.4rem 0.5rem",
                        fontSize: "0.85em",
                        borderRadius: "3px",
                        background: editorMessage.startsWith("✓") ? "rgba(78, 201, 176, 0.1)" : "rgba(244, 135, 113, 0.1)",
                        color: editorMessage.startsWith("✓") ? "var(--success, #4ec9b0)" : "var(--danger, #f48771)",
                      }}
                    >
                      {editorMessage}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* ─── 안전장치 (백업/복구) ──────────────────────── */}
          <section className="settings-section" data-tab="safety">
            <div className="eyebrow">🛡️ 안전장치</div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-info">
                <div className="settings-row-title">백업 / 복구</div>
                <div className="settings-row-desc">
                  패치·업데이트 전 백업해두면, 동작 불능 시 단일 클릭으로 복원할 수 있습니다.
                  바탕화면 <span className="mono">"K-Desktop-Agent 비상복구"</span> 바로가기는 앱이 안 뜰 때 비상용.
                </div>
              </div>

              {latestBackup ? (
                <div className="settings-meta mono" style={{ marginTop: 8 }}>
                  <div>마지막 백업: {formatBackupTime(latestBackup.timestamp)} ({latestBackup.label})</div>
                  <div>총 크기 : {formatBytes(latestBackup.total_size)} · 파일 {latestBackup.files.length}개</div>
                  {latestBackup.files.map((f) => (
                    <div key={f.name} style={{ opacity: f.missing ? 0.4 : 0.7, fontSize: "0.85em" }}>
                      · {f.name} {f.missing ? "(원본 없음)" : `${formatBytes(f.size)}`}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="settings-meta mono" style={{ marginTop: 8, opacity: 0.6 }}>
                  마지막 백업: 없음 — 아래 버튼으로 첫 백업을 만드세요
                </div>
              )}

              {backupError && (
                <div className="settings-meta mono" style={{ marginTop: 8, color: "var(--warn, #f59e0b)" }}>
                  ⚠️ {backupError}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <button
                  className="settings-btn"
                  onClick={handleBackupNow}
                  disabled={backupBusy !== "idle"}
                >
                  {backupBusy === "backing-up" ? "💾 백업 중..." : "💾 지금 백업하기"}
                </button>

                {!showRollbackConfirm ? (
                  <button
                    className="settings-btn settings-btn-danger"
                    onClick={() => setShowRollbackConfirm(true)}
                    disabled={!latestBackup || backupBusy !== "idle"}
                    title={!latestBackup ? "백업이 없으면 복구 불가" : "마지막 백업 시점으로 되돌립니다"}
                  >
                    ↩️ 이전 백업으로 복구
                  </button>
                ) : (
                  <>
                    <span className="mono" style={{ alignSelf: "center", opacity: 0.8 }}>
                      정말 복구? 앱이 종료되고 자동 재기동됩니다 →
                    </span>
                    <button
                      className="settings-btn settings-btn-danger"
                      onClick={handleRollback}
                      disabled={backupBusy !== "idle"}
                    >
                      {backupBusy === "rolling-back" ? "복원 중..." : "✓ 확인 — 복구"}
                    </button>
                    <button
                      className="settings-btn"
                      onClick={() => setShowRollbackConfirm(false)}
                      disabled={backupBusy !== "idle"}
                    >
                      취소
                    </button>
                  </>
                )}
              </div>
            </div>
          </section>

          <section className="settings-section" data-tab="safety">
            <div className="eyebrow">정보</div>
            <div className="settings-meta mono">
              <div>K Desktop Agent v0.4.0</div>
              <div>Tauri + React + Node sidecar</div>
              <div>
                현재: {chatProvider === "claude" ? "Claude Code CLI (Max 구독)" : `${chatProvider} REST API`}
                {" · "}모델 <span className="mono">{chatModel}</span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
