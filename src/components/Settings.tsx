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

const API_PROVIDERS: APIProvider[] = [
  {
    id: "claude",
    name: "Claude (Max 구독)",
    icon: "💠",
    keyName: "(none)",
    placeholder: "Max 구독 OAuth — claude login",
    docsUrl: "https://docs.claude.com/en/docs/claude-code/quickstart",
    noKeyRequired: true,
    note: "Claude Code CLI 로 K-Personal MCP 도구 사용 가능 (스크린샷·마우스·키보드 등). API 키 불필요.",
    models: [
      { id: "default", label: "Max 기본 모델 (Opus 4.7 / 1M ctx)" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic API",
    icon: "🤖",
    keyName: "ANTHROPIC_API_KEY",
    placeholder: "sk-ant-api...",
    docsUrl: "https://console.anthropic.com/",
    note: "직접 API 호출 (텍스트 전용 — MCP 도구 미지원).",
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
    note: "직접 API 호출 (텍스트 전용).",
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
    note: "AI Studio API 키 사용 (텍스트 전용).",
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
    level: "ask",
    category: "file",
  },
  {
    id: "file_delete",
    name: "파일 삭제",
    description: "파일 및 폴더 삭제",
    icon: "🗑️",
    level: "ask",
    category: "file",
  },
  {
    id: "app_launch",
    name: "앱 실행",
    description: "프로그램 실행 및 종료",
    icon: "🚀",
    level: "ask",
    category: "system",
  },
  {
    id: "system_control",
    name: "시스템 제어",
    description: "마우스, 키보드, 클립보드 제어",
    icon: "🖱️",
    level: "ask",
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

export default function Settings({ open, onClose, mcpConnected }: SettingsProps) {
  const [autoStart, setAutoStart] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [loading, setLoading] = useState(true);
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

  // 자동 업데이트 상태
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "available" | "latest" | "downloading" | "error">("idle");
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");

  // 앱 버전은 한 번만 동적으로 로딩 (tauri.conf.json 의 단일 진실원)
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion("unknown"));
  }, []);

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
  function saveActiveProvider(providerId: string, modelId: string) {
    setChatProvider(providerId);
    setChatModel(modelId);
    localStorage.setItem(LS_ACTIVE_PROVIDER, providerId);
    localStorage.setItem(LS_ACTIVE_MODEL, modelId);
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
  async function loadPermissions(): Promise<AgentPermission[] | null> {
    try {
      const stored = localStorage.getItem("kda_permissions");
      if (stored) {
        return JSON.parse(stored);
      }
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

        <div className="settings-body">
          {/* UI 테마 섹션 */}
          <section className="settings-section">
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
          <section className="settings-section">
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
          <section className="settings-section">
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
          <section className="settings-section">
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
          <section className="settings-section">
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
          <section className="settings-section">
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
                  {chatProvider !== "claude" && " · REST API 직접 호출 · 텍스트 전용"}
                </div>
              </div>
              <div className="model-status">
                <span className="model-badge active">활성</span>
              </div>
            </div>
          </section>

          {/* 자동 업데이트 섹션 */}
          <section className="settings-section">
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
                  <div className="update-status update-latest">
                    <span className="update-icon">✓</span>
                    최신 버전입니다!
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

          <section className="settings-section">
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

          <section className="settings-section">
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

          <section className="settings-section">
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

          <section className="settings-section">
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

          <section className="settings-section">
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

          <section className="settings-section">
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
