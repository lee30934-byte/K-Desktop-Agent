export const REA_SERVER_NAME: "rea";
export const REA_PINNED_VERSION: string;
export const REA_NODE_MIN: number[];
export const REA_SERVER_ENV: Readonly<Record<string, string>>;
export const REA_RUNTIME_TOOLS: readonly string[];

export type ReaInstall =
  | { ok: true; entry: string; version: string }
  | { ok: false; reason: string; version?: string };

export interface ReaDecision {
  enabled: boolean;
  requested: boolean;
  allowRuntime: boolean;
  reason: string;
  entry?: string;
}

export function reaInstallRoot(home: string): string;
export function detectReaInstall(
  home: string,
  fs?: { existsSync(p: string): boolean; readFileSync(p: string, enc: string): string | Buffer },
): ReaInstall;
export function nodeSatisfiesRea(nodeVersion: string): boolean;
export function pickReaNode(
  candidates: Array<{ path: string; version: string | null }>,
): { path: string; version: string } | null;
export function profileRequestsRea(profile: unknown): boolean;
export function decideRea(input: {
  flags: { reaMcp?: boolean; projectMode?: boolean };
  profile?: unknown;
  install: ReaInstall | null | undefined;
  nodeVersion: string;
  provider: string;
}): ReaDecision;
export function buildReaClaudeServer(
  nodeExe: string,
  entry: string,
): { type: "stdio"; command: string; args: string[]; env: Record<string, string> };
export function reaClaudeDisallowed(allowRuntime: boolean): string[];
export function buildReaCodexConfig(
  nodeExe: string,
  entry: string,
  allowRuntime: boolean,
): { mcp_servers: Record<string, unknown> };
export function buildReaGuidance(decision: ReaDecision | null | undefined): string;
