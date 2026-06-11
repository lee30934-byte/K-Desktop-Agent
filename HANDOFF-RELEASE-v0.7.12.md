# HANDOFF - KDA v0.7.12 Release Prep

Date: 2026-06-11
Repo: `C:\Users\lee30\Documents\K-Desktop-Agent`
Remote: `origin https://github.com/lee30934-byte/K-Desktop-Agent.git`

## Current State

- `origin/main` was fast-forwarded before this prep.
- Latest remote release/tag before this work: `v0.7.11`.
- The old file `HANDOFF-RELEASE-v0.7.5.md` is stale. `v0.7.5` already exists in the remote history, so the correct next release candidate is `v0.7.12`.
- This prep intentionally does not push, tag, or publish. Another LLM can do that after reviewing this file.

## Intended Release

- Version: `0.7.12`
- Tag: `v0.7.12`
- Commit message suggestion: `fix: v0.7.12 memory watchdog and stream unlock hardening`
- Scope: KDA memory watchdog and stuck-stream recovery only.

## Code Changes

`src-tauri/Cargo.toml`
- Adds the Windows crate feature `Win32_System_SystemInformation`.
- Bumps package version to `0.7.12`.

`src-tauri/src/lib.rs`
- Adds `SystemMemoryStatus`.
- Adds the Tauri command `get_system_memory_status`.
- Windows implementation uses `GlobalMemoryStatusEx`.
- Non-Windows implementation returns an explicit unsupported error.
- Registers the command in `invoke_handler`.

`src/App.tsx`
- Polls system memory every 15 seconds.
- Emits status levels:
  - 85%: warn
  - 92%: block new turns
  - 95%: critical recovery
- Blocks new turns immediately at or above 92%, even while another stream is active.
- Clears all stale streaming conversation state after a 12-minute no-event stall.
- Clears all stale streaming conversation state during 95% critical memory recovery.
- Hard Stop now falls back to the active conversation if the turn-to-conversation map is missing.

## Version Files Updated

- `package.json`: `0.7.12`
- `package-lock.json`: `0.7.12`
- `src-tauri/tauri.conf.json`: `0.7.12`
- `src-tauri/Cargo.toml`: `0.7.12`
- `src-tauri/Cargo.lock`: `0.7.12`
- `CHANGELOG.md`: adds `## [0.7.12] - 2026-06-11`

## Verification Already Run

All commands below were run from the repo after updating to `0.7.12`.

```powershell
npm run version:check
```

Result: PASS, `OK versions in sync: 0.7.12`.

```powershell
npm run build
```

Result: PASS, `tsc && vite build` completed.

```powershell
Push-Location src-tauri; cargo check; Pop-Location
```

Result: PASS. Existing Rust unused-import warnings remain, but there were no errors.

```powershell
npm run release:gate:fast
```

Result: PASS, `6 PASS, 0 WARN, 0 FAIL, 3 SKIP`.

```powershell
npm run release:gate
```

Result: PASS, `9 PASS, 0 WARN, 0 FAIL, 0 SKIP`.

## Files To Stage

Do not use `git add -A` blindly. Stage only:

```powershell
git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock CHANGELOG.md src-tauri/src/lib.rs src/App.tsx HANDOFF-RELEASE-v0.7.12.md HANDOFF-RELEASE-v0.7.5.md
```

## Commit / Tag / Push Plan

```powershell
git commit -m "fix: v0.7.12 memory watchdog and stream unlock hardening"
git tag v0.7.12
git push origin main
git push origin v0.7.12
```

After the tag push, GitHub Actions should build and publish signed release artifacts.

## Safety Notes

- Do not rotate the Tauri signing key.
- Do not update secrets with `Get-Content -Raw | gh secret set`; it can inject a UTF-8 BOM.
- Do not start a local Vite dev server as release verification.
- If the installed app shows version `0.7.12` but old behavior, suspect stale WebView2 cache under `%LOCALAPPDATA%\com.k.desktop-agent\EBWebView`.
- Keep unrelated SIGILFALL/OpenClaw files out of this release.

## Minor Follow-Up

- `currentTurnStartedAtRef` is still written but not meaningfully read. It is harmless dead code and was left in place to avoid widening this release.
