// v0.7.86 UI 목업 충실도(fidA) — 개발용 화면 비교 픽스처.
// 브라우저 미리보기(vite)에는 DB 가 없어 목록이 비어 있으므로, 목업(evidence/ui-redesign-20261111/mockup.html)과
// 같은 예시 데이터를 메모리 상태에만 채워 캡처·비교한다.
// 켜지는 조건: 개발 빌드(import.meta.env.DEV) + 주소에 ?fixture=mockup. 배포 빌드에서는 항상 null (DEV=false).
// DB·파일·localStorage 에는 아무것도 쓰지 않는다 (App 이 픽스처 중엔 활성 대화 id 저장도 건너뜀).
import type { ChatMessage, Conversation, Folder, RateLimitInfo, SessionMetrics } from "../types";
import type { WaitingWatch } from "../utils/taskWatchRecovery";
import type { PendingSend } from "../conversationControl";
import type { DBLongTask } from "../db";

type ViteEnv = { DEV?: boolean } | undefined;
const viteEnv = (): ViteEnv => (import.meta as unknown as { env?: ViteEnv }).env;
const currentSearch = () => (typeof location === "undefined" ? "" : location.search);

/** 개발 빌드 + ?fixture=mockup 일 때만 true. env/search 는 테스트용 주입. */
export function mockupFixtureEnabled(env: ViteEnv = viteEnv(), search: string = currentSearch()): boolean {
  if (!env?.DEV) return false;
  try { return new URLSearchParams(search).get("fixture") === "mockup"; } catch { return false; }
}

/** 개발 빌드에서만 ?layout=o2|classic 로 화면 배치를 저장 없이 덮어쓴다 (캡처용). */
export function devLayoutOverride(env: ViteEnv = viteEnv(), search: string = currentSearch()): "o2" | "classic" | null {
  if (!env?.DEV) return null;
  try {
    const v = new URLSearchParams(search).get("layout");
    return v === "o2" || v === "classic" ? v : null;
  } catch { return null; }
}

export type DevPanel = "preview" | "tasks" | "session" | "assistant";

/** fidB — 개발 빌드에서만 ?panel=preview|tasks|session|assistant 로 우측 패널을 열어 둔다 (캡처용, 저장 안 함). */
export function devPanelOverride(env: ViteEnv = viteEnv(), search: string = currentSearch()): DevPanel | null {
  if (!env?.DEV) return null;
  try {
    const v = new URLSearchParams(search).get("panel");
    return v === "preview" || v === "tasks" || v === "session" || v === "assistant" ? v : null;
  } catch { return null; }
}

const DEV_SETTINGS_GROUPS = ["general", "ai", "safety", "agent", "tools", "connect", "display", "data", "advanced"] as const;
export type DevSettingsGroup = (typeof DEV_SETTINGS_GROUPS)[number];

/** fidC — 개발 빌드에서만 ?settings=<그룹> 으로 설정 페이지를 그 그룹으로 열어 둔다 (캡처용, 저장 안 함). ?q= 는 검색어. */
export function devSettingsOverride(env: ViteEnv = viteEnv(), search: string = currentSearch()): { group: DevSettingsGroup; query: string } | null {
  if (!env?.DEV) return null;
  try {
    const p = new URLSearchParams(search);
    const v = p.get("settings");
    if (!v || !(DEV_SETTINGS_GROUPS as readonly string[]).includes(v)) return null;
    return { group: v as DevSettingsGroup, query: p.get("q") ?? "" };
  } catch { return null; }
}

/** fidB — 슬라이드오버 탭용 예시 데이터 (목업 '세션·사용량' · '작업' · '미리보기' 와 같은 값). */
export interface MockupPanelFixture {
  model: string;
  maxContextTokens: number;
  maxContextSource: string;
  metrics: SessionMetrics;
  rateLimit: RateLimitInfo;
  runs: { conversationId: string; detail: string }[];
  queue: PendingSend[];
  recoverable: DBLongTask[];
  preview: { pathOrUrl: string; label: string; text: string };
}

export interface MockupFixture {
  conversations: Conversation[];
  folders: Folder[];
  activeConversationId: string;
  currentFolderId: string;
  messages: ChatMessage[];
  streamingIds: string[];
  waiting: WaitingWatch[];
  contextRatio: number;
  engineLabel: string;
  warnings: string[];
  panel: MockupPanelFixture;
}

const T0 = Date.UTC(2026, 10, 11, 6, 0, 0);
const conv = (id: string, title: string, extra: Partial<Conversation> = {}, minutesAgo = 0): Conversation =>
  ({ id, title, lastActive: T0 - minutesAgo * 60_000, messageCount: 4, folderId: "fx-work", ...extra });
const folder = (id: string, name: string, icon: string, parentId: string | null, position: number): Folder =>
  ({ id, name, icon, parentId, position, createdAt: T0 });

function buildFixture(): MockupFixture {
  const active = "fx-c1";
  return {
    activeConversationId: active,
    currentFolderId: "fx-work",
    folders: [
      folder("fx-work", "업무", "📁", null, 0),
      folder("fx-design", "디자인", "📁", "fx-work", 0),
      folder("fx-client", "클라이언트 A · 계약", "📂", "fx-work", 1),
      folder("fx-tax", "세무·영수증", "🧾", "fx-work", 2),
    ],
    conversations: [
      conv(active, "KDA UI 개편 디자인 검토", { isFavorite: true, folderId: "fx-design" }, 0),
      conv("fx-c2", "주간 보고서 자동화", { isFavorite: true }, 3),
      conv("fx-c3", "엑셀 매출 데이터 정리", { icon: "📊" }, 10),
      conv("fx-c4", "회의록 요약 — 11월 10일", { icon: "📝" }, 20),
      conv("fx-c5", "PDF 계약서 두 버전 비교", { icon: "📄" }, 30),
      conv("fx-c6", "텔레그램 알림 설정", { icon: "✈️" }, 40),
      conv("fx-c7", "사진 폴더 날짜별 정리", { icon: "🖼️" }, 50),
      conv("fx-c8", "블로그 초안 — 원격 근무 팁", { icon: "💬" }, 60),
    ],
    streamingIds: [active, "fx-c2"],
    messages: [
      { id: "fx-m1", role: "user", timestamp: T0, content: "설정 창이 너무 복잡해. 섹션이 36개나 돼서 어디에 뭐가 있는지 모르겠어. 어떻게 묶으면 좋을지 정리해 줘." },
      { id: "fx-m2", role: "assistant", timestamp: T0 + 1000, content: [
        "36개 섹션을 사용 목적 기준으로 **9개 그룹**으로 묶는 것을 제안합니다. 블록은 옮기지 않고 `data-tab` 값만 바꾸므로 회귀 위험이 낮습니다.",
        "",
        "1. **일반** — 시작, 단축키, 업데이트, 앱 종료, 정보",
        "2. **AI 엔진** — 엔진 연결, 지금 쓰는 모델, 성능 모드, 사용량·한도",
        "3. **권한과 안전** — 기능별 허용 범위, 실행 확인, 개별 도구 잠금, SafeMode",
        "",
        "나머지 6개 그룹(에이전트 동작, 도구, 연결, 화면·비서, 데이터·백업, 고급·문제 해결)은 표로 정리해 두었습니다.",
        "",
        "[design-spec.md](evidence/ui-redesign-20261111/design-spec.md)",
      ].join("\n") },
      { id: "fx-m3", role: "user", timestamp: T0 + 2000, content: "좋아. '자동 승인'이랑 '세션 초기화'도 헷갈리는데, 이름도 같이 바꿔 줘." },
      { id: "fx-m4", role: "assistant", timestamp: T0 + 3000, content: [
        "두 이름 모두 실제 동작과 맞지 않습니다. 특히 **세션 초기화**는 메시지를 지우지 않고 요약을 넘겨 엔진 세션만 새로 시작하므로 '초기화'가 아닙니다.",
        "",
        "| 대상 | 현재 | 새 이름 |",
        "| --- | --- | --- |",
        "| 전역 확인창 스위치 | ~~자동 승인 ON/OFF~~ | **확인 없이 실행** |",
        "| 기능별 권한 | ~~자동 승인 / 매번 확인 / 수동만~~ | **허용 / 실행 전 묻기 / 차단** |",
        "| 🔄 버튼 | ~~세션 초기화~~ | **새 세션으로 이어가기** |",
        "| 📦 버튼 | ~~대화 압축 & 이어하기~~ | **요약해서 새 대화로 이어가기** |",
        "",
        "버튼 이름만 보고도 대화가 남는지, 새 대화가 생기는지 알 수 있도록 했습니다.",
      ].join("\n") },
    ],
    waiting: [
      { id: "fx-w1", title: "PDF 계약서 두 버전 비교", reason: "requires-user", conversationId: active, resolvable: true },
      { id: "fx-w2", title: "주간 보고서 자동화", reason: "retry-backoff", conversationId: active, resolvable: false },
    ],
    contextRatio: 0.72,
    engineLabel: "Codex · gpt-5",
    warnings: ["5시간 한도 84%"],
    panel: buildPanelFixture(),
  };
}

function buildPanelFixture(): MockupPanelFixture {
  const now = Date.now();
  const at = (h: number, m: number, dayOffset = 0) => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  return {
    model: "gpt-5",
    maxContextTokens: 200_000,
    maxContextSource: "일치 (gpt-5)",
    metrics: {
      totalInputTokens: 1_200_000, totalOutputTokens: 86_000, turnCount: 18, toolCallCount: 42,
      startedAt: now - (1 * 3600 + 12 * 60 + 8) * 1000, maxTurnContextTokens: 144_210, currentContextTokens: 151_002,
    },
    rateLimit: {
      provider: "codex", receivedAt: now - 60_000,
      primary: { used_pct: 84, reset_at: at(15, 40) > now ? at(15, 40) : at(15, 40, 1) },
      secondary: { used_pct: 37, reset_at: at(9, 0, 3) },
    },
    runs: [
      { conversationId: "fx-c2", detail: "엑셀 3개 시트 집계 중 · 3/5단계" },
      { conversationId: "fx-c7", detail: "파일 이동 128 / 402 · D:\\사진\\2026" },
    ],
    queue: [{ id: "fx-q1", conversationId: "fx-c4", text: "액션 아이템만 표로 다시 정리해 줘", queuedAt: now - 120_000, mode: "queue" }],
    recoverable: [{
      id: "fx-l1", kind: "codex", conversation_id: "fx-c8", title: "블로그 초안 — 원격 근무 팁", status: "running",
      started_at: now - 9 * 3600_000, updated_at: now - 7 * 3600_000, last_evidence_at: null, handoff_md: null, manifest_json: null,
    }],
    preview: {
      pathOrUrl: "evidence/ui-redesign-20261111/design-spec.md",
      label: "design-spec.md",
      text: "# KDA UI 개편 디자인 스펙\n조용한 캔버스 + 안전 칩\n\n1. 결정 요약 · 2. 디자인 원칙 · 3. 화면 구조 · 4. 컨트롤 배치표 · 5. 설정 재구성 · 6. 명칭 정리 · 7. 비주얼 토큰 …",
    },
  };
}

/** 픽스처가 켜져 있으면 예시 데이터, 아니면 null. 배포 빌드에서는 항상 null. */
export function readMockupFixture(env: ViteEnv = viteEnv(), search: string = currentSearch()): MockupFixture | null {
  return mockupFixtureEnabled(env, search) ? buildFixture() : null;
}
