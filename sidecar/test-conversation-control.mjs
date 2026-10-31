import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
for (const script of ["scripts/conversation-control.test.ts", "scripts/conversation-workspace.test.ts"]) {
const result = spawnSync(process.execPath, [fileURLToPath(new URL("node_modules/tsx/dist/cli.mjs", import.meta.url)), script], { cwd: root, encoding: "utf8", timeout: 30_000, windowsHide: true });
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error) console.error(result.error.message);
if (result.status !== 0) process.exit(result.status ?? 1);
}
