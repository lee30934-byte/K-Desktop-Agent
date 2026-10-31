"""Record reproducible local validation without touching the running KDA instance."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
out = root / "evidence" / "conversation-recovery-final"
out.mkdir(parents=True, exist_ok=True)

def run(name, command):
    log = out / f"{name}.log"
    with log.open("wb") as stream:
        result = subprocess.run(command, cwd=root, stdout=stream, stderr=subprocess.STDOUT, timeout=600)
    record = {"name": name, "exit": result.returncode, "log": str(log)}
    print(f"{name}: exit {result.returncode}", flush=True)
    return record

steps = []
steps.append(run("frontend-build", ["cmd.exe", "/d", "/c", "npm run build"]))
steps.append(run("sidecar-build", ["cmd.exe", "/d", "/c", "npm run sidecar:build"]))
if any(step["exit"] for step in steps):
    sys.exit(1)
steps.append(run("ui-bundle", ["node", "scripts/build-conversation-control-preview.mjs"]))
commands = [
    ("preflight", ["powershell.exe", "-NoProfile", "-Command", "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); & './scripts/check.ps1'"]),
    ("release-gate", ["node", "scripts/release-gate.mjs", "--fast"]),
    ("headless-ui", [sys.executable, "scripts/verify-conversation-control-ui.py"]),
    ("process-smoke", ["node", "scripts/smoke-conversation-control.mjs"]),
    ("rust-recovery", ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "execution_recovery::tests", "--lib", "--", "--nocapture"]),
]
with ThreadPoolExecutor(max_workers=5) as pool:
    steps.extend(pool.map(lambda item: run(*item), commands))
files = [
    "src/App.tsx", "src/db.ts", "src/conversationControl.ts", "src/conversationWorkspace.ts",
    "src/components/TaskActivityPanel.tsx", "src/components/ActionConfirmation.tsx",
    "src-tauri/src/lib.rs", "src-tauri/src/execution_recovery.rs", "sidecar/src/codex-app-server-bridge.mjs",
    "scripts/conversation-workspace.test.ts", "scripts/verify-conversation-control-ui.py",
    "scripts/smoke-conversation-control.mjs", "scripts/validate-conversation-recovery.py",
]
record = {
    "checkedAt": datetime.now(timezone.utc).isoformat(), "sourceRoot": str(root),
    "baseline": "v0.7.62 / b7f489c2762d5d81125b47c0b99a20644bb474b9",
    "status": "PASS" if all(step["exit"] == 0 for step in steps) else "HOLD",
    "steps": steps, "installedGuiVerified": False, "releaseStatus": "NOT_RELEASED",
    "scope": "Isolated fixtures and headless components; no live engine interruption",
    "sourceSha256": {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in files},
}
(out / "validation.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
print(record["status"] + " " + str(out / "validation.json"), flush=True)
sys.exit(0 if record["status"] == "PASS" else 1)
