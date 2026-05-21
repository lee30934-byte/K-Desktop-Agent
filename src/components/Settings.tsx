import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import CornerBrackets from "./CornerBrackets";
import type { WatchedFolder } from "../types";

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
type SettingsTabId = "ai" | "agent" | "appearance" | "system" | "safety";

const SETTINGS_TABS: { id: SettingsTabId; icon: string; label: string }[] = [
  { id: "ai", icon: "🤖", label: "AI" },
  { id: "agent", icon: "🛡️", label: "에이전트" },
  { id: "appearance", icon: "🎨", label: "외관" },
  { id: "system", icon: "⚙️", label: "시스템" },
  { id: "safety", icon: "🆘", label: "안전장치" },
];

const LS_ACTIVE_SETTINGS_TAB = "kda_active_settings_tab";

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
      if (parsed.success && !parsed.alreadyInstalled) {
        // 새로 설치됐으니 sidecar 재시작 → MCP detect
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
                        <div className="permission-name">{perm.name}</div>
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
                        <div className="permission-name">{perm.name}</div>
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
                        <div className="permission-name">{perm.name}</div>
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
                        <div className="permission-name">{perm.name}</div>
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
