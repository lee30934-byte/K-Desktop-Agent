// ═══════════════════════════════════════════════════════════════
// SQLite Database Helper for K Desktop Agent
// Phase 4: 대화 히스토리 영구 저장
// Phase 25 (v0.5.11): Portable data dir — DB path 는 lib.rs 의 data_root()
// 가 결정. invoke('get_data_dir_info') 로 절대 경로 받아 sqlite:<abs> 형식 사용.
// ═══════════════════════════════════════════════════════════════

import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage, Conversation } from "./types";
import logger from "./utils/logger";

// 싱글톤 DB 인스턴스
let db: Database | null = null;

interface DataDirInfo {
  data_root: string;
  db_path: string;
  db_exists: boolean;
}

/**
 * DB 초기화 및 스키마 마이그레이션
 * data_root()/conversations.db 에 저장됨 (Phase 25 — K 가 Settings 에서 변경 가능)
 */
export async function initDB(): Promise<Database> {
  if (db) return db;

  // Phase 25: data_root() 의 절대 경로 사용. invoke fail 시 옛 default 폴백.
  let dbUrl = "sqlite:conversations.db"; // legacy fallback
  try {
    const info = await invoke<DataDirInfo>("get_data_dir_info");
    if (info?.db_path) {
      // Windows path 의 backslash 는 SQLite URI 에서도 허용 (Tauri plugin 이 처리)
      dbUrl = `sqlite:${info.db_path}`;
      logger.log(`[db] using portable DB path: ${info.db_path}`);
    }
  } catch (e) {
    logger.warn(`[db] get_data_dir_info 실패 — legacy default 사용: ${String(e)}`);
  }
  db = await Database.load(dbUrl);

  // 스키마 마이그레이션 (테이블이 없으면 생성)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      agent_id TEXT,
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      turn_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0
    )
  `);

  // 기존 테이블에 컬럼 추가 (마이그레이션)
  try {
    await db.execute(`ALTER TABLE conversations ADD COLUMN total_input_tokens INTEGER DEFAULT 0`);
  } catch { /* 이미 존재하면 무시 */ }
  try {
    await db.execute(`ALTER TABLE conversations ADD COLUMN total_output_tokens INTEGER DEFAULT 0`);
  } catch { /* 이미 존재하면 무시 */ }
  try {
    await db.execute(`ALTER TABLE conversations ADD COLUMN turn_count INTEGER DEFAULT 0`);
  } catch { /* 이미 존재하면 무시 */ }
  try {
    await db.execute(`ALTER TABLE conversations ADD COLUMN tool_call_count INTEGER DEFAULT 0`);
  } catch { /* 이미 존재하면 무시 */ }

  // Phase 32 (v0.5.20) — 폴더 트리 + 즐겨찾기 + 색상/아이콘
  // folders: 폴더 자체 테이블. parent_id 가 null = root 폴더, 아니면 다른 folder.id 참조 (N단계 중첩)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id TEXT,
      color TEXT,
      icon TEXT,
      position INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE SET NULL
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id)
  `);
  // conversations 에 folder_id / position / is_favorite / color / icon 컬럼 추가
  try { await db.execute(`ALTER TABLE conversations ADD COLUMN folder_id TEXT`); } catch {}
  try { await db.execute(`ALTER TABLE conversations ADD COLUMN position INTEGER DEFAULT 0`); } catch {}
  try { await db.execute(`ALTER TABLE conversations ADD COLUMN is_favorite INTEGER DEFAULT 0`); } catch {}
  try { await db.execute(`ALTER TABLE conversations ADD COLUMN color TEXT`); } catch {}
  try { await db.execute(`ALTER TABLE conversations ADD COLUMN icon TEXT`); } catch {}
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_conversations_folder ON conversations(folder_id)
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

  // Phase 79 (v0.6.22) — Task State Manager: 장기 작업 (Codex spawn, 큰 tool call 등) 의
  // lifecycle 을 DB 에 atomic 기록. KDA 재시작 / disconnect / reconnect 시 "복구 가능한 작업"
  // 으로 K 에게 알려줘 작업 중단 → 끊김으로 이어지지 않게 함 (Lee 의 7개 큰 그림 중 #3).
  //
  // 컬럼:
  // - id           : UUID. sidecar 가 emit 시 발급
  // - kind         : "codex" | "claude" | "tool_call" 등 (작업 종류)
  // - conversation_id : 그 작업이 속한 대화 ID (null 가능 — 대화 밖 작업 케이스 위함)
  // - title        : K 가 알아볼 한 줄 (예: "Codex: 사이드 패널 fix push", first user message 일부)
  // - status       : "running" | "completed" | "failed" | "abandoned"
  // - started_at   : epoch ms
  // - updated_at   : epoch ms (마지막 갱신 시각 — evidence 마다 갱신)
  // - last_evidence_at : 마지막 token_count 또는 progress event 시각 — recovery 후보 판정용
  // - handoff_md   : K 가 작업 재개할 때 참고할 마크다운 (v1 엔 sidecar 가 안 채움 — K 가 직접 또는 다음 phase)
  // - manifest_json: 자유로운 metadata JSON (예: 모델, 토큰 합계, child PID 등)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS long_tasks (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      conversation_id TEXT,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_evidence_at INTEGER,
      handoff_md TEXT,
      manifest_json TEXT
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_long_tasks_status_updated
    ON long_tasks(status, updated_at DESC)
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_long_tasks_conversation
    ON long_tasks(conversation_id)
  `);

  logger.log("[DB] 초기화 완료");
  return db;
}

// ─────────────────────────────────────────────────────────────────
// Long Tasks CRUD (Phase 79 / v0.6.22)
// ─────────────────────────────────────────────────────────────────

export interface DBLongTask {
  id: string;
  kind: string;
  conversation_id: string | null;
  title: string | null;
  status: "running" | "completed" | "failed" | "abandoned";
  started_at: number;
  updated_at: number;
  last_evidence_at: number | null;
  handoff_md: string | null;
  manifest_json: string | null;
}

/**
 * 새 long task 시작 — sidecar 가 emit 한 long_task_started event 의 listener 에서 호출.
 * upsert 패턴: 같은 id 가 있으면 status='running' 으로 reset (재시작 케이스).
 */
export async function insertLongTask(input: {
  id: string;
  kind: string;
  conversationId?: string | null;
  title?: string | null;
  manifest?: Record<string, unknown> | null;
}): Promise<void> {
  const db = await initDB();
  const now = Date.now();
  await db.execute(
    `INSERT OR REPLACE INTO long_tasks
       (id, kind, conversation_id, title, status, started_at, updated_at, last_evidence_at, handoff_md, manifest_json)
     VALUES (?, ?, ?, ?, 'running', ?, ?, NULL, NULL, ?)`,
    [
      input.id,
      input.kind,
      input.conversationId ?? null,
      input.title ?? null,
      now,
      now,
      input.manifest ? JSON.stringify(input.manifest) : null,
    ]
  );
}

/**
 * 진행 evidence 갱신 — token_count 같은 event 마다 호출. updated_at + last_evidence_at 둘 다 갱신.
 * manifest 가 있으면 merge (전체 교체).
 */
export async function updateLongTaskEvidence(
  id: string,
  manifest?: Record<string, unknown> | null
): Promise<void> {
  const db = await initDB();
  const now = Date.now();
  if (manifest) {
    await db.execute(
      `UPDATE long_tasks SET updated_at = ?, last_evidence_at = ?, manifest_json = ? WHERE id = ?`,
      [now, now, JSON.stringify(manifest), id]
    );
  } else {
    await db.execute(
      `UPDATE long_tasks SET updated_at = ?, last_evidence_at = ? WHERE id = ?`,
      [now, now, id]
    );
  }
}

/**
 * 종결 — turn.completed (성공) / error (실패) / K manual (abandoned) 시 호출.
 */
export async function finalizeLongTask(
  id: string,
  status: "completed" | "failed" | "abandoned",
  handoffMd?: string | null
): Promise<void> {
  const db = await initDB();
  const now = Date.now();
  await db.execute(
    `UPDATE long_tasks SET status = ?, updated_at = ?, handoff_md = COALESCE(?, handoff_md) WHERE id = ?`,
    [status, now, handoffMd ?? null, id]
  );
}

/**
 * 복구 후보 = status='running' 이고 updated_at 이 staleMs 이상 지난 row.
 * KDA 가 startup 시 호출 — sidecar 가 정상 종결한 작업은 이미 completed/failed 로 update 됐을 것이므로
 * 여기 안 잡힘. 끊긴 (KDA 강제 종료 / OS reboot / sidecar crash) 작업만 남음.
 *
 * 기본 staleMs = 30초 — sidecar 의 normal completion 이 그 안에 안 들어오면 끊겼다고 판정.
 */
export async function listRecoverableLongTasks(staleMs = 30_000): Promise<DBLongTask[]> {
  const db = await initDB();
  const threshold = Date.now() - staleMs;
  const rows = await db.select<DBLongTask[]>(
    `SELECT * FROM long_tasks
     WHERE status = 'running' AND updated_at < ?
     ORDER BY updated_at DESC
     LIMIT 20`,
    [threshold]
  );
  return rows;
}

/**
 * K 가 UI 에서 "버림" 선택 — status='abandoned' 로 mark.
 */
export async function discardLongTask(id: string): Promise<void> {
  await finalizeLongTask(id, "abandoned");
}

/**
 * (옵션) 오래된 long_tasks 정리 — status != 'running' 이고 N일 지난 것 삭제.
 * 호출자가 명시적으로 부를 때만 (자동 prune 안 함, 데이터 보존 우선).
 */
export async function pruneOldLongTasks(olderThanDays = 30): Promise<number> {
  const db = await initDB();
  const threshold = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const result = await db.execute(
    `DELETE FROM long_tasks WHERE status != 'running' AND updated_at < ?`,
    [threshold]
  );
  return result.rowsAffected ?? 0;
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
  total_input_tokens: number;
  total_output_tokens: number;
  turn_count: number;
  tool_call_count: number;
  // Phase 32
  folder_id?: string | null;
  position?: number;
  is_favorite?: number;
  color?: string | null;
  icon?: string | null;
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
    totalInputTokens: row.total_input_tokens ?? 0,
    totalOutputTokens: row.total_output_tokens ?? 0,
    turnCount: row.turn_count ?? 0,
    toolCallCount: row.tool_call_count ?? 0,
    // Phase 32
    folderId: row.folder_id ?? null,
    position: row.position ?? 0,
    isFavorite: row.is_favorite === 1,
    color: row.color ?? null,
    icon: row.icon ?? null,
  }));
}

// ─────────────────────────────────────────────────────────────────
// Phase 32 — Folders + Tree + Drag&Drop + Favorites + Color/Icon
// ─────────────────────────────────────────────────────────────────

export interface DBFolder {
  id: string;
  name: string;
  parent_id: string | null;
  color: string | null;
  icon: string | null;
  position: number;
  created_at: number;
}

export interface FolderRecord {
  id: string;
  name: string;
  parentId: string | null;
  color: string | null;
  icon: string | null;
  position: number;
  createdAt: number;
}

function rowToFolder(row: DBFolder): FolderRecord {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id ?? null,
    color: row.color ?? null,
    icon: row.icon ?? null,
    position: row.position ?? 0,
    createdAt: row.created_at,
  };
}

export async function getAllFolders(): Promise<FolderRecord[]> {
  const database = await initDB();
  const rows = await database.select<DBFolder[]>(
    `SELECT * FROM folders ORDER BY parent_id, position ASC, created_at ASC`,
  );
  return rows.map(rowToFolder);
}

export async function createFolder(
  name: string,
  parentId: string | null = null,
  color: string | null = null,
  icon: string | null = null,
): Promise<FolderRecord> {
  const database = await initDB();
  const id = crypto.randomUUID();
  const now = Date.now();
  // 같은 부모의 마지막 position +1 로 append
  const rows = await database.select<{ max_pos: number | null }[]>(
    `SELECT MAX(position) as max_pos FROM folders WHERE ${parentId === null ? "parent_id IS NULL" : "parent_id = ?"}`,
    parentId === null ? [] : [parentId],
  );
  const nextPos = (rows[0]?.max_pos ?? -1) + 1;
  await database.execute(
    `INSERT INTO folders (id, name, parent_id, color, icon, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, name, parentId, color, icon, nextPos, now],
  );
  return { id, name, parentId, color, icon, position: nextPos, createdAt: now };
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const database = await initDB();
  await database.execute(`UPDATE folders SET name = ? WHERE id = ?`, [name, id]);
}

export async function setFolderColor(id: string, color: string | null): Promise<void> {
  const database = await initDB();
  await database.execute(`UPDATE folders SET color = ? WHERE id = ?`, [color, id]);
}

export async function setFolderIcon(id: string, icon: string | null): Promise<void> {
  const database = await initDB();
  await database.execute(`UPDATE folders SET icon = ? WHERE id = ?`, [icon, id]);
}

/**
 * 폴더 삭제. 기본 동작: 안 든 대화/하위폴더는 부모(또는 root)로 옮긴 뒤 폴더만 제거.
 * mode === "deleteAll" 이면 안에 있는 대화도 같이 삭제 (cascade — messages 까지).
 */
export async function deleteFolder(
  id: string,
  mode: "moveToParent" | "deleteAll" = "moveToParent",
): Promise<void> {
  const database = await initDB();

  // 자기 자신의 parent_id 알아내기
  const rows = await database.select<DBFolder[]>(
    `SELECT * FROM folders WHERE id = ?`,
    [id],
  );
  if (rows.length === 0) return;
  const parentId = rows[0].parent_id ?? null;

  if (mode === "deleteAll") {
    // 재귀적으로 자손 폴더 다 모은 뒤 그 폴더들의 conversation 다 삭제
    const allFolders = await getAllFolders();
    const descendants: string[] = [];
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      descendants.push(cur);
      for (const f of allFolders) {
        if (f.parentId === cur) stack.push(f.id);
      }
    }
    // 그 폴더들에 든 대화 ID 모음 → CASCADE 삭제
    for (const fid of descendants) {
      const convRows = await database.select<{ id: string }[]>(
        `SELECT id FROM conversations WHERE folder_id = ?`,
        [fid],
      );
      for (const cr of convRows) {
        await database.execute(`DELETE FROM messages WHERE conversation_id = ?`, [cr.id]);
        await database.execute(`DELETE FROM conversations WHERE id = ?`, [cr.id]);
      }
      await database.execute(`DELETE FROM folders WHERE id = ?`, [fid]);
    }
  } else {
    // 자식 폴더의 parent_id 를 내 parent 로 승격
    await database.execute(
      `UPDATE folders SET parent_id = ? WHERE parent_id = ?`,
      [parentId, id],
    );
    // 안의 대화는 내 parent 로 이동
    await database.execute(
      `UPDATE conversations SET folder_id = ? WHERE folder_id = ?`,
      [parentId, id],
    );
    // 폴더 자체 삭제
    await database.execute(`DELETE FROM folders WHERE id = ?`, [id]);
  }
}

/**
 * 폴더 이동 — 새 부모 + 새 position 으로.
 * 사이클 방지: newParentId 가 자기 자신 또는 자손이면 reject (sidebar 가 호출 전 검증해도, 여기서도 안전망).
 */
export async function moveFolder(
  id: string,
  newParentId: string | null,
  newPosition: number,
): Promise<void> {
  const database = await initDB();

  // 사이클 방지
  if (newParentId === id) throw new Error("폴더를 자기 자신 안에 넣을 수 없습니다");
  if (newParentId !== null) {
    const allFolders = await getAllFolders();
    const descendants = new Set<string>();
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      descendants.add(cur);
      for (const f of allFolders) {
        if (f.parentId === cur) stack.push(f.id);
      }
    }
    if (descendants.has(newParentId)) {
      throw new Error("폴더를 자기 자손 폴더 안에 넣을 수 없습니다");
    }
  }

  await database.execute(
    `UPDATE folders SET parent_id = ?, position = ? WHERE id = ?`,
    [newParentId, newPosition, id],
  );
}

/**
 * 대화 → 폴더 이동 (folderId = null 이면 root)
 */
export async function moveConversationToFolder(
  conversationId: string,
  folderId: string | null,
  position: number = 0,
): Promise<void> {
  const database = await initDB();
  await database.execute(
    `UPDATE conversations SET folder_id = ?, position = ? WHERE id = ?`,
    [folderId, position, conversationId],
  );
}

export async function toggleConversationFavorite(id: string): Promise<boolean> {
  const database = await initDB();
  const rows = await database.select<{ is_favorite: number }[]>(
    `SELECT is_favorite FROM conversations WHERE id = ?`,
    [id],
  );
  if (rows.length === 0) return false;
  const next = rows[0].is_favorite === 1 ? 0 : 1;
  await database.execute(
    `UPDATE conversations SET is_favorite = ? WHERE id = ?`,
    [next, id],
  );
  return next === 1;
}

export async function setConversationColor(id: string, color: string | null): Promise<void> {
  const database = await initDB();
  await database.execute(`UPDATE conversations SET color = ? WHERE id = ?`, [color, id]);
}

export async function setConversationIcon(id: string, icon: string | null): Promise<void> {
  const database = await initDB();
  await database.execute(`UPDATE conversations SET icon = ? WHERE id = ?`, [icon, id]);
}

/**
 * 대화 검색 — 제목 + 메시지 본문 매칭. SQLite LIKE 기반 (case-insensitive).
 * 결과: 일치한 대화의 id 셋 (sidebar 에서 필터링 시 사용).
 */
export async function searchConversations(query: string): Promise<Set<string>> {
  const database = await initDB();
  const trimmed = query.trim();
  if (!trimmed) return new Set();
  const pat = `%${trimmed.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  // 제목 매칭
  const titleRows = await database.select<{ id: string }[]>(
    `SELECT id FROM conversations WHERE title LIKE ? ESCAPE '\\'`,
    [pat],
  );
  // 메시지 본문 매칭 (distinct conversation_id)
  const msgRows = await database.select<{ conversation_id: string }[]>(
    `SELECT DISTINCT conversation_id FROM messages WHERE content LIKE ? ESCAPE '\\'`,
    [pat],
  );
  const set = new Set<string>();
  for (const r of titleRows) set.add(r.id);
  for (const r of msgRows) set.add(r.conversation_id);
  return set;
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

/**
 * 대화의 메트릭 업데이트 (컨텍스트 추적용)
 */
export async function updateConversationMetrics(
  id: string,
  metrics: {
    totalInputTokens: number;
    totalOutputTokens: number;
    turnCount: number;
    toolCallCount: number;
  }
): Promise<void> {
  const database = await initDB();
  await database.execute(
    `UPDATE conversations SET
      total_input_tokens = ?,
      total_output_tokens = ?,
      turn_count = ?,
      tool_call_count = ?,
      updated_at = ?
     WHERE id = ?`,
    [
      metrics.totalInputTokens,
      metrics.totalOutputTokens,
      metrics.turnCount,
      metrics.toolCallCount,
      Date.now(),
      id,
    ]
  );
}

/**
 * 대화의 메트릭 가져오기
 */
export async function getConversationMetrics(id: string): Promise<{
  totalInputTokens: number;
  totalOutputTokens: number;
  turnCount: number;
  toolCallCount: number;
} | null> {
  const database = await initDB();
  const rows = await database.select<DBConversation[]>(
    `SELECT total_input_tokens, total_output_tokens, turn_count, tool_call_count
     FROM conversations WHERE id = ?`,
    [id]
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    totalInputTokens: row.total_input_tokens ?? 0,
    totalOutputTokens: row.total_output_tokens ?? 0,
    turnCount: row.turn_count ?? 0,
    toolCallCount: row.tool_call_count ?? 0,
  };
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
