// ═══════════════════════════════════════════════════════════════
// SQLite Database Helper for K Desktop Agent
// Phase 4: 대화 히스토리 영구 저장
// ═══════════════════════════════════════════════════════════════

import Database from "@tauri-apps/plugin-sql";
import type { ChatMessage, Conversation } from "./types";
import logger from "./utils/logger";

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

  logger.log("[DB] 초기화 완료");
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

// ─────────────────────────────────────────────────────────────────
// Export / Import (백업 & 복구)
// ─────────────────────────────────────────────────────────────────

export interface ExportedConversation {
  version: "1.0";
  exportedAt: string;
  conversation: {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    agentId: string | null;
  };
  messages: ChatMessage[];
}

export interface ExportedBackup {
  version: "1.0";
  exportedAt: string;
  conversations: ExportedConversation[];
}

/**
 * 단일 대화 내보내기용 데이터 생성
 */
export async function exportConversation(conversationId: string): Promise<ExportedConversation | null> {
  const database = await initDB();

  // 대화 정보 가져오기
  const convRows = await database.select<DBConversation[]>(
    `SELECT * FROM conversations WHERE id = ?`,
    [conversationId]
  );

  if (convRows.length === 0) {
    return null;
  }

  const conv = convRows[0];
  const messages = await getMessages(conversationId);

  return {
    version: "1.0",
    exportedAt: new Date().toISOString(),
    conversation: {
      id: conv.id,
      title: conv.title,
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
      agentId: conv.agent_id,
    },
    messages,
  };
}

/**
 * 모든 대화 내보내기용 데이터 생성
 */
export async function exportAllConversations(): Promise<ExportedBackup> {
  const database = await initDB();

  const convRows = await database.select<DBConversation[]>(
    `SELECT * FROM conversations ORDER BY updated_at DESC`
  );

  const conversations: ExportedConversation[] = [];

  for (const conv of convRows) {
    const messages = await getMessages(conv.id);
    conversations.push({
      version: "1.0",
      exportedAt: new Date().toISOString(),
      conversation: {
        id: conv.id,
        title: conv.title,
        createdAt: conv.created_at,
        updatedAt: conv.updated_at,
        agentId: conv.agent_id,
      },
      messages,
    });
  }

  return {
    version: "1.0",
    exportedAt: new Date().toISOString(),
    conversations,
  };
}

/**
 * 단일 대화 가져오기
 * @param data 내보낸 대화 데이터
 * @param newId 새 ID 사용 여부 (true면 새 ID 생성, false면 기존 ID 유지)
 */
export async function importConversation(
  data: ExportedConversation,
  newId: boolean = true
): Promise<string> {
  const database = await initDB();

  const convId = newId ? crypto.randomUUID() : data.conversation.id;
  const now = Date.now();

  // 기존 대화가 있으면 삭제 (newId가 false일 때만 해당)
  if (!newId) {
    await database.execute(`DELETE FROM messages WHERE conversation_id = ?`, [convId]);
    await database.execute(`DELETE FROM conversations WHERE id = ?`, [convId]);
  }

  // 대화 생성
  await database.execute(
    `INSERT INTO conversations (id, title, created_at, updated_at, agent_id) VALUES (?, ?, ?, ?, ?)`,
    [
      convId,
      data.conversation.title + (newId ? " (imported)" : ""),
      newId ? now : data.conversation.createdAt,
      now,
      null, // agentId는 복구 시 초기화 (세션 만료됨)
    ]
  );

  // 메시지 삽입 (ID도 새로 생성)
  for (const msg of data.messages) {
    const newMsg = { ...msg, id: newId ? crypto.randomUUID() : msg.id };
    const params = messageToDbParams(convId, newMsg);
    await database.execute(
      `INSERT INTO messages
       (id, conversation_id, role, content, timestamp, streaming, level,
        tool_id, tool_name, tool_input, tool_output, tool_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params
    );
  }

  logger.log(`[DB] 대화 가져오기 완료: ${convId} (${data.messages.length}개 메시지)`);
  return convId;
}

/**
 * 전체 백업 가져오기
 */
export async function importAllConversations(data: ExportedBackup): Promise<number> {
  let imported = 0;

  for (const conv of data.conversations) {
    try {
      await importConversation(conv, true);
      imported++;
    } catch (e) {
      logger.error(`[DB] 대화 가져오기 실패:`, e);
    }
  }

  logger.log(`[DB] 전체 백업 가져오기 완료: ${imported}/${data.conversations.length}개`);
  return imported;
}

// ─────────────────────────────────────────────────────────────────
// Context Compression (대화 압축)
// ─────────────────────────────────────────────────────────────────

/**
 * 대화를 요약 형식으로 압축
 * 실제 요약은 Claude에게 요청하므로, 여기서는 요약 요청용 프롬프트 생성
 */
export function generateSummaryPrompt(messages: ChatMessage[]): string {
  // user/assistant 메시지만 추출
  const relevantMessages = messages.filter(
    (m) => m.role === "user" || m.role === "assistant"
  );

  // 메시지를 텍스트로 변환
  const transcript = relevantMessages
    .map((m) => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 500)}${m.content.length > 500 ? "..." : ""}`)
    .join("\n\n");

  return `다음은 이전 대화 내용입니다. 핵심 내용을 3-5문장으로 요약해주세요:

---
${transcript}
---

요약:`;
}

/**
 * 압축된 대화로 새 세션 시작을 위한 시스템 메시지 생성
 */
export function createCompressedSessionMessage(
  summary: string,
  originalMessageCount: number,
  originalTurnCount: number
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "system",
    content: `[이전 대화 요약 - ${originalMessageCount}개 메시지, ${originalTurnCount}턴]\n\n${summary}\n\n---\n위 내용은 이전 대화의 요약입니다. 이 맥락을 참고하여 대화를 이어가세요.`,
    timestamp: Date.now(),
    level: "info",
  };
}

/**
 * 대화 압축 후 새 대화 생성
 * @param originalConvId 원본 대화 ID
 * @param summary 요약 내용
 * @returns 새 대화 ID
 */
export async function createCompressedConversation(
  originalConvId: string,
  summary: string,
  originalTitle: string
): Promise<string> {
  const database = await initDB();
  const originalMessages = await getMessages(originalConvId);

  // 원본 대화 정보
  const userMessages = originalMessages.filter((m) => m.role === "user");
  const turnCount = userMessages.length;

  // 새 대화 생성
  const newConvId = crypto.randomUUID();
  const now = Date.now();

  await database.execute(
    `INSERT INTO conversations (id, title, created_at, updated_at, agent_id) VALUES (?, ?, ?, ?, ?)`,
    [
      newConvId,
      `${originalTitle} (continued)`,
      now,
      now,
      null, // 새 세션이므로 agentId 초기화
    ]
  );

  // 요약 시스템 메시지 저장
  const summaryMessage = createCompressedSessionMessage(
    summary,
    originalMessages.length,
    turnCount
  );

  await saveMessage(newConvId, summaryMessage);

  logger.log(`[DB] 압축 대화 생성: ${newConvId} (원본: ${originalConvId}, ${originalMessages.length}개 → 1개 요약)`);

  return newConvId;
}

/**
 * 대화 통계 계산 (압축 필요 여부 판단용)
 */
export async function getConversationStats(conversationId: string): Promise<{
  messageCount: number;
  turnCount: number;
  estimatedTokens: number;
  needsCompression: boolean;
}> {
  const messages = await getMessages(conversationId);

  const userMessages = messages.filter((m) => m.role === "user");
  const turnCount = userMessages.length;

  // 토큰 추정 (대략 4자 = 1토큰)
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  const estimatedTokens = Math.ceil(totalChars / 4);

  // 200k 컨텍스트 기준, 80% (160k) 넘으면 압축 권장
  const COMPRESSION_THRESHOLD = 160000;

  return {
    messageCount: messages.length,
    turnCount,
    estimatedTokens,
    needsCompression: estimatedTokens > COMPRESSION_THRESHOLD,
  };
}
