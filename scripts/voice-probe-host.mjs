// Test host uses the product transport, never exports auth or SDP into evidence.
import readline from 'node:readline';
import { VoiceHost } from '../sidecar/src/codex-voice.mjs';
import { join } from 'node:path';
const host = new VoiceHost(process.env.CODEX_CLI || join(process.env.APPDATA, 'npm', 'codex.cmd'),
  event => process.stdout.write(JSON.stringify(event) + '\n'));
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => host.receive(JSON.parse(line)));
input.on('close', () => { host.dispose(); process.exit(0); });
