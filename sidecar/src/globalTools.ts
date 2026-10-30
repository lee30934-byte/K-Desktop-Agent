import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export function createToolBridge(baseDir: string, command: string, server: string, denied: string[]) {
  const bridge = path.join(baseDir, 'toolBridge.js');
  if (!existsSync(bridge)) throw new Error('KDA MCP runtime missing');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kda-tools-'));
  const file = path.join(dir, 'policy.json');
  writeFileSync(file, JSON.stringify({ command, args: [server], env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    denied: denied.filter(n => n.startsWith('mcp__k-personal__')).map(n => n.slice('mcp__k-personal__'.length)) }), { flag: 'wx' });
  return { dir, command: process.execPath, args: [bridge, file] };
}

export function codexToolArgs(launch: { command: string; args: string[] }): string[] {
  // TOML strings are JSON-compatible for these generated paths and argv values.
  return ['-c', `mcp_servers.k-personal.command=${JSON.stringify(launch.command)}`,
    '-c', `mcp_servers.k-personal.args=${JSON.stringify(launch.args)}`];
}

export function codexExecutable(cli: string): { command: string; prefix: string[] } {
  if (process.platform !== 'win32' || /\.exe$/i.test(cli)) return { command: cli, prefix: [] };
  // Avoid cmd.exe reinterpreting quotes, spaces and metacharacters in TOML overrides.
  const shim = path.isAbsolute(cli) ? cli : (process.env.PATH ?? '').split(path.delimiter)
    .map(d => path.join(d, cli.endsWith('.cmd') ? cli : cli + '.cmd')).find(p => existsSync(p));
  if (!shim) throw new Error('Codex launcher not found');
  const js = path.join(path.dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (!existsSync(js)) throw new Error('Unsupported Codex launcher; use CODEX_CLI pointing to the native executable');
  return { command: process.execPath, prefix: [js] };
}

export function geminiTurnSettings(launch: { dir: string; command: string; args: string[] }): string {
  const system = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? (process.platform === 'win32'
    ? path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'gemini-cli', 'settings.json')
    : process.platform === 'darwin' ? '/Library/Application Support/GeminiCli/settings.json' : '/etc/gemini-cli/settings.json');
  const settings = existsSync(system) ? JSON.parse(readFileSync(system, 'utf8').replace(/^\uFEFF/, '')) : {};
  // Preserve all system policy and existing server restrictions; only wire the transport.
  const server = settings.mcpServers?.['k-personal'] ?? {};
  settings.mcpServers = { ...settings.mcpServers, 'k-personal': { ...server, command: launch.command, args: launch.args } };
  const file = path.join(launch.dir, 'gemini-settings.json');
  writeFileSync(file, JSON.stringify(settings), { flag: 'wx' });
  return file;
}
