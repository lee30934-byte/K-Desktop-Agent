/**
 * Git Memory Sync — Phase 87 (v0.6.30).
 *
 * lee-profile.md + memory/ 폴더만 GitHub private repo 와 동기화.
 * conversations.db, first-run-completed.flag, sidecar-config.json 등 K 의 다른 파일은 .gitignore 로 제외.
 *
 * 설계 원칙 (memory/feedback_root_cause):
 *   - K 의 system git CLI 사용 (별도 dependency 0)
 *   - PAT 는 KDA 가 저장 안 함 — Windows Credential Manager (git credential helper) 에 한 번 박음
 *   - 충돌 시 elicitation_request 발사 (Phase 86 인프라 재사용)
 *   - 모든 git 호출은 timeout + ok/error 명시
 *
 * memory/pitfall_powershell_secret_bom + pitfall_av_blocks_bundled_native_binary 의 정신:
 *   - PAT 같은 secret 은 절대 평문 디스크 저장 X
 *   - K 가 명시적으로 enabled 안 한 sync 는 발사 안 함 (Settings 토글 — user affordance)
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface GitSyncConfig {
  enabled: boolean;
  /** GitHub repo URL — e.g. "https://github.com/lee30934-byte/kda-personal-memory.git" */
  repoUrl: string;
  /** Sync 간격 (ms) — 기본 30분. 0 이면 시작/명시만 (interval 없음) */
  intervalMs: number;
  /** 마지막 sync 의 unix timestamp (sec). 0 = 아직 안 함 */
  lastSyncAt: number;
  /** 마지막 sync 결과 라벨 ("ok" | "conflict" | "error: <msg>"). UI 표시용. */
  lastSyncStatus: string;
}

export const GIT_SYNC_CONFIG_DEFAULTS: GitSyncConfig = {
  enabled: false,
  repoUrl: "",
  intervalMs: 30 * 60 * 1000, // 30 minutes
  lastSyncAt: 0,
  lastSyncStatus: "",
};

export interface GitSyncResult {
  ok: boolean;
  /** "init" | "pull" | "commit-push" | "no-change" | "conflict" | "error" */
  action: string;
  message: string;
  /** 충돌 발생 시 conflicted file paths (relative to repo root) */
  conflictedFiles?: string[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** ~/.kda/ — sidecar-config + lee-profile.md + memory/ 가 사는 폴더. git working dir. */
export function getKdaRoot(): string {
  return path.join(os.homedir(), ".kda");
}

/** 모든 git CLI 호출의 공통 wrapper. cwd 고정, timeout 강제. */
function runGit(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; stdin?: string } = {},
): { stdout: string; stderr: string; code: number; ok: boolean } {
  const cwd = opts.cwd ?? getKdaRoot();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const result = spawnSync("git", args, {
    cwd,
    timeout: timeoutMs,
    encoding: "utf-8",
    input: opts.stdin,
    // Windows 에서 git.exe 를 찾기 위해 shell 옵션 X — 너무 위험. PATH 에 git 있어야 함.
  });
  const stdout = (result.stdout ?? "").toString();
  const stderr = (result.stderr ?? "").toString();
  const code = typeof result.status === "number" ? result.status : -1;
  return { stdout, stderr, code, ok: code === 0 };
}

/** K 의 PC 에 git 이 설치돼 있는지 검사. 없으면 sync 자체 비활성. */
export function checkGitInstalled(): { ok: boolean; version?: string; reason?: string } {
  const r = runGit(["--version"], { cwd: os.homedir() });
  if (!r.ok) {
    return {
      ok: false,
      reason: "git CLI 가 PATH 에 없습니다. https://git-scm.com 설치 후 KDA 재시작.",
    };
  }
  return { ok: true, version: r.stdout.trim() };
}

/**
 * URL 의 host 추출 (예: "https://github.com/x/y.git" → "github.com").
 * credential helper 에 host 키로 박을 때 사용.
 */
function extractHost(repoUrl: string): string | null {
  try {
    const u = new URL(repoUrl);
    return u.host || null;
  } catch {
    return null;
  }
}

/**
 * PAT 를 Windows Credential Manager 에 박음 (git credential approve).
 * KDA 자체엔 저장 안 함. 다음부터 git 이 자동 사용.
 *
 * username 은 GitHub PAT 의 경우 "x-access-token" 도 OK. 또는 K 의 github id.
 * 보통 둘 다 작동하나 표준은 "x-access-token".
 */
export function storeGitCredential(repoUrl: string, pat: string, username = "x-access-token"): {
  ok: boolean;
  message: string;
} {
  const host = extractHost(repoUrl);
  if (!host) {
    return { ok: false, message: `repo URL 파싱 실패: ${repoUrl}` };
  }
  // git credential approve 는 stdin 으로 protocol/host/username/password 받음
  const credInput = [
    `protocol=https`,
    `host=${host}`,
    `username=${username}`,
    `password=${pat}`,
    ``, // 빈 줄로 종료
    ``,
  ].join("\n");
  const r = runGit(["credential", "approve"], {
    cwd: os.homedir(),
    stdin: credInput,
    timeoutMs: 10_000,
  });
  if (!r.ok) {
    return {
      ok: false,
      message: `git credential approve 실패 (code=${r.code}): ${r.stderr.slice(0, 200)}`,
    };
  }
  return { ok: true, message: `credential 저장됨 (host=${host}, username=${username})` };
}

/** ~/.kda/ 에 .git 이 있는지. */
function isGitRepo(): boolean {
  return existsSync(path.join(getKdaRoot(), ".git"));
}

/**
 * .gitignore 박음 — lee-profile.md + memory/ 만 추적. 나머지 (conversations.db 등) 제외.
 * 멱등 (이미 동일하면 skip).
 */
function ensureGitignore(): void {
  const ignorePath = path.join(getKdaRoot(), ".gitignore");
  // K 의 ~/.kda/ 의 모든 파일을 default 제외 → lee-profile.md + memory/ + .gitignore 만 추적.
  // sidecar-config.json 도 제외 — PAT 가 절대 commit 되지 않음.
  const content = [
    "# Auto-generated by KDA Phase 87 (Git Memory Sync)",
    "# lee-profile.md + memory/ 만 추적, 나머지는 전부 제외.",
    "*",
    "!lee-profile.md",
    "!memory/",
    "!memory/**",
    "!.gitignore",
    "",
  ].join("\n");
  if (existsSync(ignorePath)) {
    try {
      const existing = readFileSync(ignorePath, "utf-8");
      if (existing === content) return; // 이미 같음
    } catch {
      // 읽기 실패 시 그냥 덮어쓰기
    }
  }
  writeFileSync(ignorePath, content, "utf-8");
}

/**
 * 초기 setup — .git 없으면 init + .gitignore + user.name/email + remote 설정.
 * 멱등. 이미 setup 됐으면 remote URL 만 update.
 */
function ensureRepoSetup(repoUrl: string): GitSyncResult {
  const root = getKdaRoot();
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  ensureGitignore();
  if (!isGitRepo()) {
    const init = runGit(["init", "-b", "main"]);
    if (!init.ok) {
      // 구 git 은 -b 옵션 없음 → 기본 branch 후 rename
      const fallback = runGit(["init"]);
      if (!fallback.ok) {
        return { ok: false, action: "init", message: `git init 실패: ${init.stderr || fallback.stderr}` };
      }
      runGit(["checkout", "-b", "main"]); // 기존 master/main 정리는 자동 (빈 repo)
    }
    // user.name / user.email 은 commit 에 필수. K 가 global 로 안 박았을 수 있어 local 설정.
    const host = os.hostname() || "kda-host";
    runGit(["config", "user.email", `kda@${host}.local`]);
    runGit(["config", "user.name", `KDA Sync (${host})`]);
  }
  // remote 설정 — 이미 있으면 set-url, 없으면 add
  const remoteShow = runGit(["remote", "get-url", "origin"]);
  if (remoteShow.ok) {
    if (remoteShow.stdout.trim() !== repoUrl) {
      const setUrl = runGit(["remote", "set-url", "origin", repoUrl]);
      if (!setUrl.ok) {
        return { ok: false, action: "init", message: `remote set-url 실패: ${setUrl.stderr}` };
      }
    }
  } else {
    const addRemote = runGit(["remote", "add", "origin", repoUrl]);
    if (!addRemote.ok) {
      return { ok: false, action: "init", message: `remote add 실패: ${addRemote.stderr}` };
    }
  }
  return { ok: true, action: "init", message: `repo setup 완료 (root=${root}, remote=${repoUrl})` };
}

/**
 * 충돌 파일 검출 — `git diff --name-only --diff-filter=U`.
 */
function detectConflictFiles(): string[] {
  const r = runGit(["diff", "--name-only", "--diff-filter=U"]);
  if (!r.ok) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Pull — 시작 시 1회 + 매 sync 직전.
 * 빈 remote (첫 push 전) 의 경우 graceful — repo 가 비어있으면 fetch 가 빈 결과.
 *
 * 충돌 처리: --rebase --autostash 로 자동 stash + replay. 충돌 시 rebase abort + 충돌 파일 리포트.
 */
export function syncPull(): GitSyncResult {
  if (!isGitRepo()) {
    return { ok: false, action: "pull", message: "git repo not initialized" };
  }
  // fetch 먼저 — 빈 remote 면 여기서 reject 안 함
  const fetch = runGit(["fetch", "origin"], { timeoutMs: 60_000 });
  if (!fetch.ok) {
    // 첫 push 전이면 main branch 가 remote 에 없어 fetch 가 0 으로 끝나는 경우 있음.
    // stderr 에 "couldn't find remote ref" 같은 메시지가 보이면 graceful skip.
    const benign = /couldn't find remote ref|remote ref does not exist|empty repository/i.test(
      fetch.stderr,
    );
    if (!benign) {
      return { ok: false, action: "pull", message: `git fetch 실패: ${fetch.stderr.slice(0, 300)}` };
    }
    return { ok: true, action: "pull", message: "empty remote (첫 push 전) — skip" };
  }
  // origin/main 이 있는지 확인
  const remoteRef = runGit(["rev-parse", "--verify", "origin/main"]);
  if (!remoteRef.ok) {
    return { ok: true, action: "pull", message: "remote main 없음 (empty repo) — skip" };
  }
  // 로컬에 commit 이 없으면 reset --hard
  const head = runGit(["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) {
    const reset = runGit(["reset", "--hard", "origin/main"]);
    if (!reset.ok) {
      return { ok: false, action: "pull", message: `초기 reset 실패: ${reset.stderr}` };
    }
    return { ok: true, action: "pull", message: "초기 동기화 (remote → local)" };
  }
  // rebase pull
  const rebase = runGit(["rebase", "--autostash", "origin/main"], { timeoutMs: 60_000 });
  if (!rebase.ok) {
    const conflicts = detectConflictFiles();
    // rebase abort — K 가 elicit 결정 전까진 깨끗한 상태 유지
    runGit(["rebase", "--abort"]);
    return {
      ok: false,
      action: "conflict",
      message: `pull rebase 충돌 — ${conflicts.length}개 파일`,
      conflictedFiles: conflicts,
    };
  }
  return { ok: true, action: "pull", message: `pull 성공 ${rebase.stdout.slice(0, 200)}` };
}

/**
 * 로컬 변경이 있는지 검사. 있으면 commit + push.
 *
 * commit 메시지: "auto: <hostname> <ISO>"
 * push 실패 시 (remote 가 앞서 있으면) — 호출자가 syncPull() 먼저 호출 보장.
 */
export function syncCommitAndPush(): GitSyncResult {
  if (!isGitRepo()) {
    return { ok: false, action: "commit-push", message: "git repo not initialized" };
  }
  // add 먼저 — .gitignore 가 lee-profile.md + memory/ 만 통과시킴
  const add = runGit(["add", "-A"]);
  if (!add.ok) {
    return { ok: false, action: "commit-push", message: `git add 실패: ${add.stderr.slice(0, 200)}` };
  }
  // 변경 있는지 확인
  const status = runGit(["status", "--porcelain"]);
  if (!status.ok) {
    return { ok: false, action: "commit-push", message: `git status 실패: ${status.stderr}` };
  }
  if (status.stdout.trim().length === 0) {
    return { ok: true, action: "no-change", message: "변경 없음 — push 생략" };
  }
  // commit
  const hostname = os.hostname() || "host";
  const iso = new Date().toISOString();
  const msg = `auto: ${hostname} ${iso}`;
  const commit = runGit(["commit", "-m", msg]);
  if (!commit.ok) {
    return { ok: false, action: "commit-push", message: `git commit 실패: ${commit.stderr.slice(0, 200)}` };
  }
  // push
  const push = runGit(["push", "-u", "origin", "main"], { timeoutMs: 60_000 });
  if (!push.ok) {
    return {
      ok: false,
      action: "commit-push",
      message: `git push 실패 (remote 가 앞서 있을 수 있음 — 다음 sync 가 pull 후 재시도): ${push.stderr.slice(0, 200)}`,
    };
  }
  return { ok: true, action: "commit-push", message: `commit + push 완료: ${msg}` };
}

/**
 * Full sync — repo setup + pull + commit/push. 호출자 (sidecar) 가 enabled 인지 미리 확인.
 *
 * 충돌 시 conflictedFiles 박은 결과 리턴. 호출자가 frontend 에 elicit 발사 책임.
 */
export function syncFull(repoUrl: string): GitSyncResult {
  const setup = ensureRepoSetup(repoUrl);
  if (!setup.ok) return setup;
  const pull = syncPull();
  if (!pull.ok && pull.action === "conflict") return pull; // 충돌 시 push 하지 말고 elicit
  if (!pull.ok) return pull;
  const push = syncCommitAndPush();
  return push;
}

/**
 * 충돌 해결 — 한 파일에 대해 K 의 결정 ("local" | "remote") 을 받아 적용.
 * 모든 충돌 해결 후 rebase --continue 또는 commit 하나로 마무리.
 *
 * v1: 단순히 "양쪽 모두 local 채택" 또는 "양쪽 모두 remote 채택" 만 지원.
 * 파일 단위 / 라인 단위 세밀 해결은 다음 phase.
 *
 * 동작: detectConflictFiles() 가 비어있으면 no-op. 비어있지 않으면:
 *   - keepSide = "local" → `git checkout --ours .`
 *   - keepSide = "remote" → `git checkout --theirs .`
 *   그 후 `git add -A && git rebase --continue` (rebase 중이면) 또는 `git commit`
 */
export function syncResolveConflict(keepSide: "local" | "remote"): GitSyncResult {
  if (!isGitRepo()) {
    return { ok: false, action: "conflict", message: "git repo not initialized" };
  }
  const flag = keepSide === "local" ? "--ours" : "--theirs";
  const checkout = runGit(["checkout", flag, "."]);
  if (!checkout.ok) {
    return {
      ok: false,
      action: "conflict",
      message: `checkout ${flag} 실패: ${checkout.stderr.slice(0, 200)}`,
    };
  }
  runGit(["add", "-A"]);
  // rebase 진행 중인지 확인 — .git/rebase-merge 또는 rebase-apply 폴더
  const rebaseMerge = existsSync(path.join(getKdaRoot(), ".git", "rebase-merge"));
  const rebaseApply = existsSync(path.join(getKdaRoot(), ".git", "rebase-apply"));
  if (rebaseMerge || rebaseApply) {
    const cont = runGit(["rebase", "--continue"], { timeoutMs: 30_000 });
    if (!cont.ok) {
      return { ok: false, action: "conflict", message: `rebase --continue 실패: ${cont.stderr.slice(0, 200)}` };
    }
  } else {
    // 일반 merge 상태 — commit
    const hostname = os.hostname() || "host";
    const cm = runGit(["commit", "-m", `resolve: keep ${keepSide} (${hostname})`]);
    if (!cm.ok) {
      return { ok: false, action: "conflict", message: `merge resolve commit 실패: ${cm.stderr.slice(0, 200)}` };
    }
  }
  return { ok: true, action: "conflict", message: `충돌 해결 — keep ${keepSide}` };
}

/**
 * Status 요약 — UI 에 "마지막 sync: 2분 전 ✓" 표시용.
 * 빠른 헬스 체크 (network 호출 없음).
 */
export function syncStatus(): {
  initialized: boolean;
  hasRemote: boolean;
  localChanges: number;
  branch: string | null;
} {
  if (!isGitRepo()) {
    return { initialized: false, hasRemote: false, localChanges: 0, branch: null };
  }
  const status = runGit(["status", "--porcelain"]);
  const localChanges = status.ok
    ? status.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0).length
    : 0;
  const remote = runGit(["remote", "get-url", "origin"]);
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  return {
    initialized: true,
    hasRemote: remote.ok && remote.stdout.trim().length > 0,
    localChanges,
    branch: branch.ok ? branch.stdout.trim() : null,
  };
}
