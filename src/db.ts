// ═══════════════════════════════════════════════════════════════
// SQLite Database Helper for K Desktop Agent
// Phase 4: 대화 히스토리 영구 저장
// ═══════════════════════════════════════════════════════════════

import Database from "@tauri-apps/plugin-sql";
import type { ChatMessage, Conversation } from "./types";

// 싱글톤 DB 인스턴스
let db: Database | null = null;

/**
 * DB 초기화 및 스키마 마이그레이션
 * %APPDATA%/K Desktop Agent/conversations.db에 저장됨
 */
export async function initDB(): Promise<Database> {
  if (db) return db;

  // Tauri SQL 플러그인이 자동으로 앱 데이터 디렉토리에 저장
  db = await Database.load("sqlite:conversations.db");

  // 스키마 마이그레이션 (테이블이 없으면 생성)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      agent_id TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      streaming INTEGER DEFAULT 0,
      level TEXT,
      tool_id TEXT,
      tool_name TEXT,
      tool_input TEXT,
      tool_output TEXT,
      tool_status TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `);

  // 인덱스 (조회 성능 개선)
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(conversation_id)
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_conversations_updated
    ON conversations(updated_at DESC)
  `);

  console.log("[DB] 초기화 완료");
  return db;
}

// ─────────────────────────────────────────────────────────────────
// Conversations CRUD
// ─────────────────────────────────────────────────────────────────

export interface DBConversation {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  agent_id: string | null;
}

/**
 * 모든 대화 목록 가져오기 (최신순)
 */
export async function getAllConversations(): Promise<Conversation[]> {
  const database = await initDB();

  const rows = await database.select<DBConversation[]>(`
    SELECT c.*,
           (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count
    FROM conversations c
    ORDER BY c.updated_at DESC
  `);

  return rows.map((row: any) => ({
    id: row.id,
    title: row.title,
    lastActive: row.updated_at,
    messageCount: row.message_count ?? 0,
    agentId: row.agent_id,
  }));
}

/**
 * 새 대화 생성
 */
export async function createConversation(
  id: string,
  title: string = "New Conversation"
): Promise<Conversation> {
  const database = await initDB();
  const now = Date.now();

  await database.execute(
    `INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    [id, title, now, now]
  );

  return {
    id,
    title,
    lastActive: now,
    messageCount: 0,
  };
}

/**
 * 대화 제목 업데이트
 */
export async function updateConversationTitle(
  id: string,
  title: string
): Promise<void> {
  const database = await initDB();
  await database.execute(
    `UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`,
    [title, Date.now(), id]
  );
}

/**
 * 대화의 agent_id 업데이트 (resume 지원용)
 * agentId가 null이면 agent_id를 초기화 (세션 갱신 시 사용)
 */
export async function updateConversationAgentId(
  id: string,
  agentId: string | null
): Promise<void> {
  const database = await initDB();
  await database.execute(
    `UPDATE conversations SET agent_id = ?, updated_at = ? WHERE id = ?`,
    [agentId, Date.now(), id]
  );
}

/**
 * 대화 삭제 (CASCADE로 메시지도 삭제)
 */
export async function deleteConversation(id: string): Promise<void> {
  const database = await initDB();
  // SQLite에서 외래 키 CASCADE가 기본적으로 비활성화되어 있으므로 수동 삭제
  await database.execute(`DELETE FROM messages WHERE conversation_id = ?`, [id]);
  await database.execute(`DELETE FROM conversations WHERE id = ?`, [id]);
}

/**
 * 대화의 updated_at 갱신
 */
export async function touchConversation(id: string): Promise<void> {
  const database = await initDB();
  await database.execute(
    `UPDATE conversations SET updated_at = ? WHERE id = ?`,
    [Date.now(), id]
  );
}

/**
 * 대화의 agent_id 가져오기
 */
export async function getConversationAgentId(id: string): Promise<string | null> {
  const database = await initDB();
  const rows = await database.select<{ agent_id: string | null }[]>(
    `SELECT agent_id FROM conversations WHERE id = ?`,
    [id]
  );
  return rows[0]?.agent_id ?? null;
}

// ─────────────────────────────────────────────────────────────────
// Messages CRUD
// ─────────────────────────────────────────────────────────────────

interface DBMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  timestamp: number;
  streaming: number;
  level: string | null;
  tool_id: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_output: string | null;
  tool_status: string | null;
}

/**
 * 특정 대화의 모든 메시지 가져오기
 */
export async function getMessages(conversationId: string): Promise<ChatMessage[]> {
  const database = await initDB();

  const rows = await database.select<DBMessage[]>(
    `SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC`,
    [conversationId]
  );

  return rows.map(dbRowToMessage);
}

/**
 * 메시지 저장 (upsert)
 */
export async function saveMessage(
  conversationId: string,
  message: ChatMessage
): Promise<void> {
  const database = await initDB();

  const params = messageToDbParams(conversationId, message);

  await database.execute(
    `INSERT OR REPLACE INTO messages
     (id, conversation_id, role, content, timestamp, streaming, level,
      tool_id, tool_name, tool_input, tool_output, tool_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params
  );

  // 대화 updated_at 갱신
  await touchConversation(conversationId);
}

/**
 * 여러 메시지 한번에 저장 (배치)
 */
export async function saveMessages(
  conversationId: string,
  messages: ChatMessage[]
): Promise<void> {
  const database = await initDB();

  for (const message of messages) {
    const params = messageToDbParams(conversationId, message);
    await database.execute(
      `INSERT OR REPLACE INTO messages
       (id, conversation_id, role, content, timestamp, streaming, level,
        tool_id, tool_name, tool_input, tool_output, tool_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params
    );
  }

  await touchConversation(conversationId);
}

/**
 * 메시지 업데이트 (스트리밍 완료 등)
 */
export async function updateMessage(
  conversationId: string,
  message: ChatMessage
): Promise<void> {
  await saveMessage(conversationId, message);
}

// ─────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────

function dbRowToMessage(row: DBMessage): ChatMessage {
  const base = {
    id: row.id,
    content: row.content,
    timestamp: row.timestamp,
  };

  switch (row.role) {
    case "user":
      return { ...base, role: "user" };

    case "assistant":
      return {
        ...base,
        role: "assistant",
        streaming: row.streaming === 1,
      };

    case "system":
      return {
        ...base,
        role: "system",
        level: (row.level as "info" | "warn" | "error") ?? "info",
      };

    case "tool":
      return {
        ...base,
        role: "tool",
        toolId: row.tool_id ?? "",
        toolName: row.tool_name ?? "",
        toolInput: row.tool_input ? JSON.parse(row.tool_input) : undefined,
        toolOutput: row.tool_output ?? undefined,
        status: (row.tool_status as "pending" | "success" | "error") ?? "pending",
      };

    default:
      return { ...base, role: "system" };
  }
}

function messageToDbParams(
  conversationId: string,
  message: ChatMessage
): (string | number | null)[] {
  const base = [
    message.id,
    conversationId,
    message.role,
    message.content,
    message.timestamp,
  ];

  if (message.role === "assistant") {
    return [
      ...base,
      message.streaming ? 1 : 0,
      null, // level
      null, // tool_id
      null, // tool_name
      null, // tool_input
      null, // tool_output
      null, // tool_status
    ];
  }

  if (message.role === "system") {
    return [
      ...base,
      0, // streaming
      message.level ?? "info",
      null,
      null,
      null,
      null,
      null,
    ];
  }

  if (message.role === "tool") {
    return [
      ...base,
      0,
      null,
      message.toolId,
      message.toolName,
      message.toolInput ? JSON.stringify(message.toolInput) : null,
      message.toolOutput ?? null,
      message.status,
    ];
  }

  // user
  return [...base, 0, null, null, null, null, null, null];
}

/**
 * 첫 번째 user 메시지에서 대화 제목 자동 생성
 */
export function generateTitleFromMessage(content: string): string {
  // 첫 50자 또는 첫 줄만 사용
  const firstLine = content.split("\n")[0].trim();
  const truncated = firstLine.length > 40
    ? firstLine.slice(0, 37) + "..."
    : firstLine;
  return truncated || "New Conversation";
}
