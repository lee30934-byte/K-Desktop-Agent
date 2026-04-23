/**
 * K Desktop Agent — Node Sidecar (Phase 1)
 *
 * Claude Agent SDK를 감싸서 stdin/stdout JSON 프로토콜로 Rust와 통신.
 *
 * ▶ 프로토콜 (한 줄 = 한 JSON)
 *
 * Rust → Sidecar (stdin):
 *   {"type":"user_message","id":"<uuid>","content":"<string>","conversation_id":"<uuid|null>"}
 *   {"type":"interrupt","id":"<uuid>"}    // 현재 응답 중단
 *   {"type":"ping"}
 *
 * Sidecar → Rust (stdout):
 *   {"type":"ready","version":"0.1.0"}                        // 기동 완료
 *   {"type":"assistant_delta","id":"<uuid>","text":"..."}     // 텍스트 토큰 스트림
 *   {"type":"tool_use","id":"<uuid>","tool_id":"<string>","name":"...","input":{...}}
 *   {"type":"tool_result","id":"<uuid>","tool_id":"<string>","output":"..."}
 *   {"type":"done","id":"<uuid>","usage":{...}}               // 한 턴 끝
 *   {"type":"error","id":"<uuid?>","message":"..."}
 *   {"type":"log","level":"info|warn|error","message":"..."}
 *
 * 설치: cd sidecar && npm install
 * 실행: node dist/index.js  (빌드 후) 또는 npx tsx src/index.ts (개발)
 */

import process from "node:process";
import readline from "node:readline";
import { query } from "@anthropic-ai/claude-agent-sdk";

// ───────────────────────────────────────────────────────────────
// 설정
// ───────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `당신은 K님의 개인 Windows 컴퓨터를 자동화하는 조수입니다.
K님이 한국어로 자연스럽게 명령하면, 적절한 도구를 선택해 실행하고 결과를 간결히 보고합니다.
불확실하면 먼저 질문하고, 파괴적인 작업(파일 삭제·덮어쓰기)은 반드시 확인을 받습니다.`;

// Phase 3에서 k-personal MCP 서버가 여기에 추가됩니다.
// Phase 1에서는 MCP 없이 순수 대화만 작동.
const MCP_SERVERS: Record<string, unknown> = {};

// ───────────────────────────────────────────────────────────────
// I/O 헬퍼
// ───────────────────────────────────────────────────────────────

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function log(level: "info" | "warn" | "error", message: string): void {
  // 사이드카의 로그도 Rust 쪽으로 JSON으로 보내서 파일에 기록되도록
  emit({ type: "log", level, message });
}

// ───────────────────────────────────────────────────────────────
// 메시지 처리
// ───────────────────────────────────────────────────────────────

type UserMessage = {
  type: "user_message";
  id: string;
  content: string;
  conversation_id?: string | null;
};

// 대화 상태: conversation_id별로 SDK 세션 유지
// Phase 4(SQLite)에서 이 맵이 DB로 확장됨
const activeTurns = new Map<string, AbortController>();

async function handleUserMessage(msg: UserMessage): Promise<void> {
  const abort = new AbortController();
  activeTurns.set(msg.id, abort);

  try {
    // Claude Agent SDK의 query() 호출
    // 반환: AsyncGenerator<SDKMessage>
    //
    // 참고: API 형태는 @anthropic-ai/claude-agent-sdk 버전에 따라 약간 다를 수 있음
    //       공식 README 기준: https://docs.claude.com/en/api/agent-sdk/overview
    const stream = query({
      prompt: msg.content,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        mcpServers: MCP_SERVERS,
        abortController: abort,
        // maxTurns: 10,       // 기본값으로 두되 필요시 조정
        // allowedTools: [...] // Phase 3에서 k-personal 도구만 허용하려면 여기서
      },
    });

    for await (const event of stream) {
      // SDK 이벤트 타입에 따라 분기
      // 아래 분기는 현재 SDK 메시지 구조 기준. 실제 필드명이 다르면 여기만 수정.
      switch (event.type) {
        case "assistant": {
          // event.message.content는 보통 content block 배열
          const blocks = (event as any).message?.content ?? [];
          for (const block of blocks) {
            if (block.type === "text") {
              emit({
                type: "assistant_delta",
                id: msg.id,
                text: block.text,
              });
            } else if (block.type === "tool_use") {
              emit({
                type: "tool_use",
                id: msg.id,
                tool_id: block.id,
                name: block.name,
                input: block.input,
              });
            }
          }
          break;
        }
        case "user": {
          // tool_result 메시지
          const blocks = (event as any).message?.content ?? [];
          for (const block of blocks) {
            if (block.type === "tool_result") {
              emit({
                type: "tool_result",
                id: msg.id,
                tool_id: block.tool_use_id,
                output: normalizeToolOutput(block.content),
              });
            }
          }
          break;
        }
        case "result": {
          emit({
            type: "done",
            id: msg.id,
            usage: (event as any).usage ?? null,
          });
          break;
        }
        default:
          log("info", `unhandled SDK event type: ${(event as any).type}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: "error", id: msg.id, message });
  } finally {
    activeTurns.delete(msg.id);
  }
}

function normalizeToolOutput(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (c?.type === "text" ? c.text : JSON.stringify(c)))
      .join("\n");
  }
  return JSON.stringify(content);
}

// ───────────────────────────────────────────────────────────────
// stdin 라인 리더 (JSON per line)
// ───────────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    emit({
      type: "error",
      message: `Invalid JSON on stdin: ${String(err)}`,
    });
    return;
  }

  switch (msg.type) {
    case "user_message":
      // 비동기로 실행, 다음 라인 받을 수 있게
      void handleUserMessage(msg as UserMessage);
      break;
    case "interrupt": {
      const ac = activeTurns.get(msg.id);
      if (ac) {
        ac.abort();
        log("info", `interrupted turn ${msg.id}`);
      }
      break;
    }
    case "ping":
      emit({ type: "pong" });
      break;
    default:
      emit({
        type: "error",
        message: `Unknown stdin message type: ${msg.type}`,
      });
  }
});

rl.on("close", () => {
  log("info", "stdin closed, exiting");
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  emit({
    type: "error",
    message: `uncaughtException: ${err.message}`,
  });
});

process.on("unhandledRejection", (reason) => {
  emit({
    type: "error",
    message: `unhandledRejection: ${String(reason)}`,
  });
});

// 기동 완료 신호
emit({ type: "ready", version: "0.1.0" });
log("info", "sidecar ready, waiting for stdin");
