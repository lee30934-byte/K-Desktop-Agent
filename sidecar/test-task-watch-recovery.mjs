import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
const root = fileURLToPath(new URL("../", import.meta.url));
const target = path.join(root, "evidence", "taskwatch-test-target");
mkdirSync(target, { recursive: true });
const homeCargo = path.join(os.homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
const cargo = existsSync(homeCargo) ? homeCargo : "cargo";
const build = spawnSync(cargo, ["build", "--locked", "--manifest-path", "scripts/task-watch-harness/Cargo.toml", "--target-dir", target], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000 });
if (build.status !== 0) { console.error(build.stderr || build.error); process.exit(1); }
const driver = path.join(target, "debug", "kda-task-watch-test-driver" + (process.platform === "win32" ? ".exe" : ""));
const test = spawnSync(process.execPath, [path.join(root, "sidecar/node_modules/tsx/dist/cli.mjs"), "scripts/task-watch-recovery.test.ts"], {
  cwd: root, encoding: "utf8", windowsHide: true, timeout: 60_000, env: { ...process.env, KDA_TEST_WATCH_DRIVER: driver },
});
process.stdout.write(test.stdout ?? ""); process.stderr.write(test.stderr ?? "");
if (test.error) console.error(test.error);
process.exit(test.status ?? 1);
