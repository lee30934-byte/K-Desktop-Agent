# Phase 4 상세 — SQLite 대화 히스토리

## 목표

창을 닫아도 대화 기록이 남고, 사이드바에 이전 대화들 목록이 뜨며, 클릭하면 해당 대화가 복원됨. Claude에게 이전 컨텍스트를 이어서 대화 가능.

## DB 설계

### 경로
`%APPDATA%\K Desktop Agent\conversations.db` (Tauri의 `app_data_dir()`)

### 스키마

```sql
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    sdk_session_id TEXT  -- Claude Agent SDK 의 resume 용
);

CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    metadata TEXT,  -- JSON: tool info, streaming flag, usage 등
    turn_id TEXT    -- 같은 턴 안의 메시지들 묶기용
);

CREATE INDEX idx_messages_conv ON messages(conversation_id, timestamp);
CREATE INDEX idx_messages_turn ON messages(turn_id);
```

## 변경 대상 파일

| 파일 | 변경 |
|---|---|
| `src-tauri/src/lib.rs` | DB 초기화 (마이그레이션 실행) |
| `src-tauri/capabilities/default.json` | SQL permissions (이미 있음) |
| `src/db.ts` (새 파일) | DB 쿼리 헬퍼 |
| `src/App.tsx` | 저장/로드 로직, 사이드바 실제 데이터 연결 |
| `src/components/Sidebar.tsx` | 기존 conversations prop 그대로 사용 |
| `sidecar/src/index.ts` | `resume` 지원 (대화 재개) |

## 구현 단계

### 1단계: DB 마이그레이션

**`src-tauri/src/lib.rs`** 에서:

```rust
use tauri_plugin_sql::{Migration, MigrationKind};

let migrations = vec![
    Migration {
        version: 1,
        description: "create_conversations_and_messages",
        sql: "
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                message_count INTEGER NOT NULL DEFAULT 0,
                sdk_session_id TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                metadata TEXT,
                turn_id TEXT,
                FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, timestamp);
        ",
        kind: MigrationKind::Up,
    },
];

.plugin(
    tauri_plugin_sql::Builder::default()
        .add_migrations("sqlite:conversations.db", migrations)
        .build(),
)
```

### 2단계: 프론트 DB 헬퍼

**`src/db.ts`** (새 파일):

```ts
import Database from "@tauri-apps/plugin-sql";
import type { ChatMessage, Conversation } from "./types";

let dbPromise: Promise<Database> | null = null;

function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:conversations.db");
  }
  return dbPromise;
}

export async function listConversations(limit = 20): Promise<Conversation[]> {
  const db = await getDb();
  const rows = await db.select<any[]>(
    `SELECT id, title, updated_at, message_count
     FROM conversations ORDER BY updated_at DESC LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    lastActive: r.updated_at,
    messageCount: r.message_count,
  }));
}

export async function createConversation(title: string): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.execute(
    `INSERT INTO conversations (id, title, created_at, updated_at, message_count)
     VALUES ($1, $2, $3, $4, 0)`,
    [id, title, now, now]
  );
  return id;
}

export async function loadMessages(conversationId: string): Promise<ChatMessage[]> {
  const db = await getDb();
  const rows = await db.select<any[]>(
    `SELECT id, role, content, timestamp, metadata FROM messages
     WHERE conversation_id = $1 ORDER BY timestamp ASC`,
    [conversationId]
  );
  return rows.map((r) => {
    const meta = r.metadata ? JSON.parse(r.metadata) : {};
    return {
      id: r.id,
      role: r.role,
      content: r.content,
      timestamp: r.timestamp,
      ...meta,
    };
  });
}

export async function saveMessage(
  conversationId: string,
  msg: ChatMessage,
  turnId?: string
): Promise<void> {
  const db = await getDb();
  const { id, role, content, timestamp, ...meta } = msg as any;
  await db.execute(
    `INSERT OR REPLACE INTO messages (id, conversation_id, role, content, timestamp, metadata, turn_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, conversationId, role, content, timestamp, JSON.stringify(meta), turnId ?? null]
  );

  // 대화 메타 업데이트
  await db.execute(
    `UPDATE conversations
     SET updated_at = $1, message_count = message_count + 1
     WHERE id = $2`,
    [timestamp, conversationId]
  );
}

export async function updateConversationTitle(
  id: string,
  title: string
): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE conversations SET title = $1 WHERE id = $2`, [title, id]);
}

export async function deleteConversation(id: string): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM conversations WHERE id = $1`, [id]);
}
```

### 3단계: App.tsx 에 저장 로직 추가

- 앱 시작 시 `listConversations()` 호출 → 사이드바에 표시
- `handleNewConversation()` → `createConversation()` 후 ID 저장
- `handleSendMessage()` → user 메시지를 DB에도 저장
- sidecar 이벤트 핸들러에서 assistant 메시지 최종 완성 시 (done 이벤트) DB 저장
- `handleSelectConversation(id)` → `loadMessages(id)` → setState

### 4단계: 자동 제목 생성

첫 번째 user 메시지로 대화 제목 추론:
- 30자 이하면 그대로
- 길면 첫 30자 + "..."
- 나중에 "제목 자동 생성" 버튼으로 Claude에게 요약 요청 가능

### 5단계: Sidecar 의 resume 지원

`sidecar/src/index.ts` 의 `query()` 옵션에 `resume` 추가:

```ts
const stream = query({
  prompt: msg.content,
  options: {
    systemPrompt: SYSTEM_PROMPT,
    mcpServers,
    abortController: abort,
    permissionMode: "bypassPermissions",
    resume: msg.sdk_session_id,  // 추가 — 이전 세션 이어받기
  },
});
```

Rust→Sidecar 프로토콜에 `sdk_session_id` 추가:
```ts
type UserMessage = {
  type: "user_message";
  id: string;
  content: string;
  sdk_session_id?: string;  // 추가
};
```

프론트에서 메시지 보낼 때 현재 대화의 sdk_session_id 같이 전달. sidecar에서 응답 오면 새로 할당된 session_id 를 저장 (첫 턴일 때).

## 성공 기준

- [ ] 창 재시작 후 사이드바에 이전 대화 10개 표시
- [ ] 대화 클릭 시 메시지 로드, 이어서 대화 가능
- [ ] 새 메시지 추가되면 자동으로 DB 저장
- [ ] DB 파일이 `%APPDATA%\K Desktop Agent\conversations.db` 에 생성됨
- [ ] 대화 제목이 첫 user 메시지로 자동 설정됨

## 주의점

- **DB 락**: 프론트에서 여러 write 동시 발생 시 serialize 필요. 단순하게 `await` 로 순차 처리.
- **tool 메시지 저장**: tool_use + tool_result 각각 별도 row? 아니면 하나로 묶어서? → `turn_id` 로 묶어서 로드 시 합성.
- **마이그레이션**: 나중에 스키마 바꿀 때 `Migration { version: 2, ... }` 추가하는 것 잊지 말기.
- **사이즈 관리**: 수천 개 대화 쌓이면 사이드바에 최근 N개만 표시, 나머지는 Archive 뷰.
