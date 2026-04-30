/**
 * MCP (Model Context Protocol) stdio client.
 *
 * Why this exists (Phase 11 G1):
 *   The sidecar's REST path (OpenAI/Gemini/OpenRouter/Anthropic) historically had no access
 *   to K-Personal MCP — those providers were text-only echo chambers. This client lets the
 *   REST path spawn the same Python MCP server that Claude CLI uses, list its tools, and
 *   call them. Combined with provider-specific function-calling adapters (G1.2~G1.4), it
 *   gives every provider parity with Claude CLI for K's automation workflows.
 *
 * Protocol: JSON-RPC 2.0 over stdio, newline-delimited (one JSON object per line).
 *   - "initialize" handshake on start, then "notifications/initialized" (no response)
 *   - "tools/list" → cached after first success
 *   - "tools/call" → multiplexed by id, concurrent calls supported
 *
 * Lifecycle:
 *   - Lazy: subprocess spawned on first start() (idempotent)
 *   - If subprocess dies, all pending requests reject with a clear error and the next
 *     start() spins up a fresh process. No automatic retry — the caller decides.
 *   - stop() is for tests / shutdown — the sidecar leaves it running for its whole lifetime.
 *
 * Concurrency: each outgoing request gets a monotonic id; responses are routed back via a
 *   pending map. Server-initiated requests/notifications (we don't implement any) are
 *   logged and ignored.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface MCPTool {
  name: string;
  description?: string;
  /** JSON Schema describing the tool's arguments object. */
  inputSchema: Record<string, unknown>;
}

export type MCPContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: string; [k: string]: unknown };

export interface MCPCallResult {
  content: MCPContent[];
  isError?: boolean;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

type Logger = (level: "info" | "warn" | "error", msg: string) => void;

/**
 * MCP protocol version we negotiate. Servers built with reasonably recent `mcp` Python
 * package accept this. If the server returns its own version we just trust it (we don't
 * use any version-gated features yet).
 */
const PROTOCOL_VERSION = "2024-11-05";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const INITIALIZE_TIMEOUT_MS = 15_000;

export class MCPClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private startPromise: Promise<void> | null = null;
  private toolsCache: MCPTool[] | null = null;
  private buffer = "";
  private serverInfo: { name?: string; version?: string } = {};

  constructor(
    public readonly name: string,
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string> = {},
    private readonly logger?: Logger,
  ) {}

  private log(level: "info" | "warn" | "error", msg: string): void {
    this.logger?.(level, `[mcp:${this.name}] ${msg}`);
  }

  /** Subprocess running and handshake complete? */
  isReady(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  /** Server identity from initialize response (name/version). Empty until start() succeeds. */
  getServerInfo(): { name?: string; version?: string } {
    return { ...this.serverInfo };
  }

  /**
   * Spawn subprocess + run initialize handshake. Idempotent — concurrent callers share the
   * same in-flight promise. Throws on spawn failure or initialize timeout.
   */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      // Inherit parent env, layer caller's env on top.
      const childEnv = { ...process.env, ...this.env };

      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = spawn(this.command, this.args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: childEnv,
          // shell: false — we want exact argv passing (paths may contain spaces).
          // On Windows this means `command` must be a real .exe / absolute path or
          // resolvable via PATHEXT extension. The K-Personal config uses "python" which
          // Node resolves via PATH automatically.
        });
      } catch (e) {
        throw new Error(
          `MCP subprocess spawn failed (${this.command}): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      this.proc = proc;
      this.log("info", `subprocess started pid=${proc.pid} cmd="${this.command} ${this.args.join(" ")}"`);

      proc.stdout.setEncoding("utf-8");
      proc.stdout.on("data", (chunk: string) => this.onStdoutData(chunk));

      proc.stderr.setEncoding("utf-8");
      proc.stderr.on("data", (chunk: string) => {
        // MCP servers commonly log diagnostics to stderr (Python `mcp` package does).
        // Capture per line to keep log readable.
        const trimmed = chunk.trimEnd();
        if (trimmed) this.log("info", `stderr: ${trimmed}`);
      });

      proc.on("error", (err) => {
        this.log("error", `subprocess error: ${err.message}`);
      });

      proc.on("exit", (code, signal) => {
        this.log("warn", `subprocess exited code=${code} signal=${signal} (pending=${this.pending.size})`);
        const reason = new Error(
          `MCP subprocess "${this.name}" exited (code=${code}, signal=${signal})`,
        );
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(reason);
        }
        this.pending.clear();
        this.proc = null;
        this.startPromise = null;
        this.toolsCache = null;
        this.buffer = "";
      });

      // Handshake: initialize → wait for response → notifications/initialized (no response).
      const initResult = await this.request<{
        protocolVersion?: string;
        serverInfo?: { name?: string; version?: string };
      }>(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "k-desktop-agent-sidecar", version: "0.4.6" },
        },
        INITIALIZE_TIMEOUT_MS,
      );
      this.serverInfo = initResult.serverInfo ?? {};
      this.log(
        "info",
        `initialized server=${this.serverInfo.name ?? "?"}@${this.serverInfo.version ?? "?"} protocol=${initResult.protocolVersion ?? "?"}`,
      );

      this.notify("notifications/initialized", {});
    })();

    // If start fails, clear the cached promise so the next call retries.
    this.startPromise.catch(() => {
      this.startPromise = null;
      try { this.proc?.kill("SIGTERM"); } catch { /* ignore */ }
      this.proc = null;
    });

    return this.startPromise;
  }

  private onStdoutData(chunk: string): void {
    this.buffer += chunk;
    // Newline-delimited JSON. A single `data` event may contain 0..N complete lines plus a
    // partial tail; we keep the tail in `buffer` for the next event.
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        // Some Python MCP servers occasionally print non-JSON to stdout during startup
        // (warnings about deprecation, etc). Log and skip — don't crash the dispatcher.
        this.log("warn", `non-JSON stdout line ignored: ${line.slice(0, 200)}`);
        continue;
      }
      this.dispatchMessage(msg);
    }
  }

  private dispatchMessage(msg: unknown): void {
    if (typeof msg !== "object" || msg === null) {
      this.log("warn", `non-object stdout message ignored`);
      return;
    }
    const m = msg as { id?: unknown; result?: unknown; error?: unknown; method?: unknown };

    // Response = has id AND (result XOR error). Numeric id only — we generate them.
    if (typeof m.id === "number" && (m.result !== undefined || m.error !== undefined)) {
      const p = this.pending.get(m.id);
      if (!p) {
        this.log("warn", `unsolicited response id=${m.id}`);
        return;
      }
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error !== undefined) {
        const err = m.error as { code?: number; message?: string; data?: unknown };
        p.reject(new Error(
          `MCP ${p.method} error code=${err.code ?? "?"}: ${err.message ?? "(no message)"}${err.data ? " data=" + safeJSON(err.data) : ""}`,
        ));
      } else {
        p.resolve(m.result);
      }
      return;
    }

    // Server-initiated request/notification. We don't implement any (no sampling, no roots,
    // no logging callbacks). Log and ignore.
    if (typeof m.method === "string") {
      this.log("info", `server ${m.id !== undefined ? "request" : "notification"} ignored: ${m.method}`);
      return;
    }

    this.log("warn", `malformed message ignored: ${safeJSON(m).slice(0, 200)}`);
  }

  private write(payload: unknown): void {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error(`MCP subprocess "${this.name}" not ready (write attempted)`);
    }
    this.proc.stdin.write(JSON.stringify(payload) + "\n");
  }

  private request<T = unknown>(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`MCP ${method} timeout after ${timeoutMs}ms (id=${id})`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
        method,
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    try {
      this.write({ jsonrpc: "2.0", method, params });
    } catch (e) {
      this.log("warn", `notify ${method} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Returns the cached tool list, querying the server on first call. Pass refresh=true to
   * re-query (e.g. after the server reloads). Throws if the subprocess can't start.
   */
  async listTools(refresh = false): Promise<MCPTool[]> {
    if (this.toolsCache && !refresh) return this.toolsCache;
    await this.start();
    const result = await this.request<{ tools?: MCPTool[] }>("tools/list", {});
    this.toolsCache = Array.isArray(result.tools) ? result.tools : [];
    this.log("info", `tools/list cached ${this.toolsCache.length} tools`);
    return this.toolsCache;
  }

  /**
   * Invoke a tool by name. Returns the raw MCP result (content array + isError flag).
   * Caller is responsible for translating content blocks to the upstream LLM's tool-result
   * format (text vs image, etc) — the schema translator (G1.2) helpers handle this.
   */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<MCPCallResult> {
    await this.start();
    const result = await this.request<MCPCallResult>(
      "tools/call",
      { name, arguments: args },
      timeoutMs,
    );
    // Some servers omit `content` on success — normalise to empty array so consumers can
    // iterate without null checks.
    return {
      content: Array.isArray(result?.content) ? result.content : [],
      isError: result?.isError === true,
    };
  }

  /**
   * SIGTERM the subprocess (used by tests / sidecar shutdown). Safe to call repeatedly.
   * The 'exit' handler clears state and rejects pending requests.
   */
  stop(): void {
    if (!this.proc) return;
    try { this.proc.kill("SIGTERM"); } catch { /* ignore */ }
  }
}

function safeJSON(v: unknown): string {
  try { return JSON.stringify(v); } catch { return "[unserializable]"; }
}

// ─── Singleton for K-Personal ─────────────────────────────────────────────
// The sidecar uses one MCPClient per server for its whole lifetime. Today we have only
// k-personal; if more servers are added (e.g. an MCP-style web fetch tool) extend this
// to a Map<name, MCPClient>.

let kPersonalSingleton: MCPClient | null = null;

/**
 * Get or create the K-Personal MCP client. The first call wires it up but does NOT start
 * the subprocess — call .start() (or any of the high-level methods, which start lazily)
 * to actually spawn the Python server.
 *
 * Returns null if K-Personal is not configured (server file missing). In that case the
 * REST path should fall back to text-only mode for the request.
 */
export function getKPersonalMCPClient(opts: {
  command: string;
  args: string[];
  env?: Record<string, string>;
  logger?: Logger;
}): MCPClient {
  if (!kPersonalSingleton) {
    kPersonalSingleton = new MCPClient(
      "k-personal",
      opts.command,
      opts.args,
      opts.env,
      opts.logger,
    );
  }
  return kPersonalSingleton;
}

/** Test-only: drop the singleton so the next call gets a fresh client. */
export function resetKPersonalMCPClientForTests(): void {
  if (kPersonalSingleton) {
    kPersonalSingleton.stop();
    kPersonalSingleton = null;
  }
}
