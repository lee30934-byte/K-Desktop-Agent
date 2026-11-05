import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const runner = fileURLToPath(new URL('./node_modules/tsx/dist/cli.mjs', import.meta.url));
const file = fileURLToPath(new URL('../scripts/voice.test.ts', import.meta.url));
const result = spawnSync(process.execPath, [runner, file], { encoding: 'utf8', windowsHide: true });
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
assert.equal(result.status, 0, 'voice regression checks must pass');
