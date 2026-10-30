// Stdio MCP adapter. The per-turn policy is enforced at both discovery and dispatch.
import { readFileSync } from 'node:fs';
import readline from 'node:readline';
import { MCPClient } from './mcpClient.js';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const denied = new Set<string>(config.denied);
const client = new MCPClient('k-personal', config.command, config.args, config.env);
let known = new Set<string>();
const output = (v: unknown) => process.stdout.write(JSON.stringify(v) + '\n');
async function handle(request: any) {
  if (request.id === undefined) return;
  try {
    let result: unknown;
    switch (request.method) {
      case 'initialize':
        result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'kda-tool-bridge', version: '1.0.0' } };
        break;
      case 'ping': result = {}; break;
      case 'tools/list': {
        const tools = (await client.listTools()).filter(t => !denied.has(t.name));
        known = new Set(tools.map(t => t.name));
        result = { tools };
        break;
      }
      case 'tools/call': {
        const name = request.params?.name;
        if (denied.has(name) || !known.has(name)) throw new Error('Tool not permitted in this KDA turn');
        result = await client.callTool(name, request.params.arguments ?? {});
        break;
      }
      default: throw new Error('Unsupported MCP method');
    }
    output({ jsonrpc: '2.0', id: request.id, result });
  } catch (e) {
    output({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: e instanceof Error ? e.message : 'Tool bridge failed' } });
  }
}
// Serialize requests: deterministic catalog and action ordering.
let queue = Promise.resolve();
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  try { const request = JSON.parse(line); queue = queue.then(() => handle(request)); }
  catch { output({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); }
});
input.on('close', () => { client.stop(); process.exit(0); });
