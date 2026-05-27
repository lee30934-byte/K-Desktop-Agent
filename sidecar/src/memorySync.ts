/**
 * Git Memory Sync — Phase 87 (v0.6.30) + Phase 89 (v0.6.31).
 *
 * Phase 87: lee-profile.md + memory/ 폴더만 GitHub private repo 와 동기화 (personal).
 * Phase 89: + 선택적 team repo (~/.kda/team-memory/, memory/ 만, lee-profile 절대 X) hybrid sync.
 *
 * 두 sync 모두 같은 인프라 (SyncTarget 패턴) — kind + cwd + repoUrl + gitignore 만 다름.
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
 *   - team repo 는 .gitignore 에서 lee-profile.md 절대 제외 → 실수로 commit 불가
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Types ─────────────────────────────────────────────────────────────────

export type SyncKind = "personal" | "team";

/**
 * SyncTarget — 한 sync 의 모든 영역 (cwd + repo + gitignore 내용).
 * personal / team 둘 다 동일 함수로 처리 — kind 로만 구분.
 */
export interface SyncTarget {
  kind: SyncKind;
  cwd: string;
  repoUrl: string;
  /** 박을 .gitignore 내용 (gitignore 의 라인들) */
  gitignoreContent: string;
}

export interface GitSyncConfig {
  enabled: boolean;
  /** Personal repo URL — lee-profile.md + memory/ 동기화 */
  repoUrl: string;
  /**
   * Phase 89 — Team repo URL (선택). 빈 string 이면 team sync 비활성.
   * Team repo 는 lee-profile.md 절대 안 박힘 — 회사 ID/password 같은 비밀 보호.
   * 별도 폴더 ~/.kda/team-memory/ 안에 clone, sidecar 가 memory/ 로 prompt 에 추가.
   */
  teamRepoUrl: string;
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
  teamRepoUrl: "",
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
  /** Phase 89 — 어느 SyncTarget 의 결과인지 (frontend 가 personal/team 구분) */
  kind?: SyncKind;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** ~/.kda/ — sidecar-config + lee-profile.md + memory/ 가 사는 폴더. git working dir (personal). */
export function getKdaRoot(): string {
  return path.join(os.homedir(), ".kda");
}

/** Phase 89 — ~/.kda/team-memory/ — team repo 의 working dir. memory/ 만 추적, lee-profile 절대 X. */
export function getTeamMemoryRoot(): string {
  return path.join(os.homedir(), ".kda", "team-memory");
}

/**
 * .gitignore 내용 — kind 별로 다름.
 *   personal: lee-profile.md + memory/ 만 추적
 *   team:     memory/ 만 추적 (lee-profile.md 명시적 무시 — 실수 commit 차단)
 */
const PERSONAL_GITIGNORE = [
  "# KDA Personal Memory Sync — lee-profile.md + memory/ 만 추적",
  "*",
  "!lee-profile.md",
  "!memory/",
  "!memory/**",
  "!.gitignore",
  "",
].join("\n");

const TEAM_GITIGNORE = [
  "# KDA Team Memory Sync — memory/ 만 추적, lee-profile 절대 X (개인 비밀 보호)",
  "*",
  "!memory/",
  "!memory/**",
  "!.gitignore",
  "# 명시적 차단 (실수로 박혀도 무시):",
  "lee-profile.md",
  "sidecar-config.json",
  "conversations.db",
  "",
].join("\n");

/** Phase 89 — 한 SyncTarget 만들기 helper */
export function makeSyncTarget(kind: SyncKind, repoUrl: string): SyncTarget {
  if (kind === "personal") {
    return {
      kind,
      cwd: getKdaRoot(),
      repoUrl,
      gitignoreContent: PERSONAL_GITIGNORE,
    };
  }
  return {
    kind,
    cwd: getTeamMemoryRoot(),
    repoUrl,
    gitignoreContent: TEAM_GITIGNORE,
  };
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

/** 지정 cwd 에 .git 이 있는지. */
function isGitRepo(cwd: string): boolean {
  return existsSync(path.join(cwd, ".git"));
}

/**
 * .gitignore 박음 — target.gitignoreContent 그대로.
 * 멱등 (이미 동일하면 skip).
 */
function ensureGitignore(target: SyncTarget): void {
  const ignorePath = path.join(target.cwd, ".gitignore");
  const content = target.gitignoreContent;
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
function ensureRepoSetup(target: SyncTarget): GitSyncResult {
  if (!existsSync(target.cwd)) {
    mkdirSync(target.cwd, { recursive: true });
  }
  // Team 인 경우 memory/ 하위 폴더가 처음엔 없을 수 있음 → 빈 폴더 만들어서 git 이 인식하게
  if (target.kind === "team") {
    const memDir = path.join(target.cwd, "memory");
    if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });
  }
  ensureGitignore(target);
  if (!isGitRepo(target.cwd)) {
    const init = runGit(["init", "-b", "main"], { cwd: target.cwd });
    if (!init.ok) {
      // 구 git 은 -b 옵션 없음 → 기본 branch 후 rename
      const fallback = runGit(["init"], { cwd: target.cwd });
      if (!fallback.ok) {
        return {
          ok: false,
          action: "init",
          message: `git init 실패: ${init.stderr || fallback.stderr}`,
          kind: target.kind,
        };
      }
      runGit(["checkout", "-b", "main"], { cwd: target.cwd });
    }
    // user.name / user.email 은 commit 에 필수. K 가 global 로 안 박았을 수 있어 local 설정.
    const host = os.hostname() || "kda-host";
    runGit(["config", "user.email", `kda@${host}.local`], { cwd: target.cwd });
    runGit(["config", "user.name", `KDA Sync (${host})`], { cwd: target.cwd });
  }
  // remote 설정 — 이미 있으면 set-url, 없으면 add
  const remoteShow = runGit(["remote", "get-url", "origin"], { cwd: target.cwd });
  if (remoteShow.ok) {
    if (remoteShow.stdout.trim() !== target.repoUrl) {
      const setUrl = runGit(["remote", "set-url", "origin", target.repoUrl], { cwd: target.cwd });
      if (!setUrl.ok) {
        return {
          ok: false,
          action: "init",
          message: `remote set-url 실패: ${setUrl.stderr}`,
          kind: target.kind,
        };
      }
    }
  } else {
    const addRemote = runGit(["remote", "add", "origin", target.repoUrl], { cwd: target.cwd });
    if (!addRemote.ok) {
      return {
        ok: false,
        action: "init",
        message: `remote add 실패: ${addRemote.stderr}`,
        kind: target.kind,
      };
    }
  }
  return {
    ok: true,
    action: "init",
    message: `repo setup 완료 (kind=${target.kind}, root=${target.cwd})`,
    kind: target.kind,
  };
}

/**
 * 충돌 파일 검출 — `git diff --name-only --diff-filter=U`.
 */
function detectConflictFiles(cwd: string): string[] {
  const r = runGit(["diff", "--name-only", "--diff-filter=U"], { cwd });
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
export function syncPull(target: SyncTarget): GitSyncResult {
  if (!isGitRepo(target.cwd)) {
    return { ok: false, action: "pull", message: "git repo not initialized", kind: target.kind };
  }
  // fetch 먼저 — 빈 remote 면 여기서 reject 안 함
  const fetch = runGit(["fetch", "origin"], { cwd: target.cwd, timeoutMs: 60_000 });
  if (!fetch.ok) {
    const benign = /couldn't find remote ref|remote ref does not exist|empty repository/i.test(
      fetch.stderr,
    );
    if (!benign) {
      return {
        ok: false,
        action: "pull",
        message: `git fetch 실패: ${fetch.stderr.slice(0, 300)}`,
        kind: target.kind,
      };
    }
    return { ok: true, action: "pull", message: "empty remote (첫 push 전) — skip", kind: target.kind };
  }
  // origin/main 이 있는지 확인
  const remoteRef = runGit(["rev-parse", "--verify", "origin/main"], { cwd: target.cwd });
  if (!remoteRef.ok) {
    return { ok: true, action: "pull", message: "remote main 없음 (empty repo) — skip", kind: target.kind };
  }
  // 로컬에 commit 이 없으면 reset --hard
  const head = runGit(["rev-parse", "--verify", "HEAD"], { cwd: target.cwd });
  if (!head.ok) {
    const reset = runGit(["reset", "--hard", "origin/main"], { cwd: target.cwd });
    if (!reset.ok) {
      return { ok: false, action: "pull", message: `초기 reset 실패: ${reset.stderr}`, kind: target.kind };
    }
    return { ok: true, action: "pull", message: "초기 동기화 (remote → local)", kind: target.kind };
  }
  // rebase pull
  const rebase = runGit(["rebase", "--autostash", "origin/main"], { cwd: target.cwd, timeoutMs: 60_000 });
  if (!rebase.ok) {
    const conflicts = detectConflictFiles(target.cwd);
    runGit(["rebase", "--abort"], { cwd: target.cwd });
    return {
      ok: false,
      action: "conflict",
      message: `pull rebase 충돌 — ${conflicts.length}개 파일`,
      conflictedFiles: conflicts,
      kind: target.kind,
    };
  }
  return { ok: true, action: "pull", message: `pull 성공 ${rebase.stdout.slice(0, 200)}`, kind: target.kind };
}

/**
 * 로컬 변경이 있는지 검사. 있으면 commit + push.
 */
export function syncCommitAndPush(target: SyncTarget): GitSyncResult {
  if (!isGitRepo(target.cwd)) {
    return { ok: false, action: "commit-push", message: "git repo not initialized", kind: target.kind };
  }
  const add = runGit(["add", "-A"], { cwd: target.cwd });
  if (!add.ok) {
    return {
      ok: false,
      action: "commit-push",
      message: `git add 실패: ${add.stderr.slice(0, 200)}`,
      kind: target.kind,
    };
  }
  const status = runGit(["status", "--porcelain"], { cwd: target.cwd });
  if (!status.ok) {
    return { ok: false, action: "commit-push", message: `git status 실패: ${status.stderr}`, kind: target.kind };
  }
  if (status.stdout.trim().length === 0) {
    return { ok: true, action: "no-change", message: "변경 없음 — push 생략", kind: target.kind };
  }
  const hostname = os.hostname() || "host";
  const iso = new Date().toISOString();
  const msg = `auto: ${hostname} ${iso}`;
  const commit = runGit(["commit", "-m", msg], { cwd: target.cwd });
  if (!commit.ok) {
    return {
      ok: false,
      action: "commit-push",
      message: `git commit 실패: ${commit.stderr.slice(0, 200)}`,
      kind: target.kind,
    };
  }
  const push = runGit(["push", "-u", "origin", "main"], { cwd: target.cwd, timeoutMs: 60_000 });
  if (!push.ok) {
    return {
      ok: false,
      action: "commit-push",
      message: `git push 실패 (remote 가 앞서 있을 수 있음 — 다음 sync 가 pull 후 재시도): ${push.stderr.slice(0, 200)}`,
      kind: target.kind,
    };
  }
  return { ok: true, action: "commit-push", message: `commit + push 완료: ${msg}`, kind: target.kind };
}

/**
 * Full sync — repo setup + pull + commit/push. 호출자 (sidecar) 가 enabled 인지 미리 확인.
 *
 * 충돌 시 conflictedFiles 박은 결과 리턴. 호출자가 frontend 에 elicit 발사 책임.
 */
export function syncFull(target: SyncTarget): GitSyncResult {
  const setup = ensureRepoSetup(target);
  if (!setup.ok) return setup;
  const pull = syncPull(target);
  if (!pull.ok && pull.action === "conflict") return pull;
  if (!pull.ok) return pull;
  const push = syncCommitAndPush(target);
  return push;
}

/**
 * 충돌 해결 — 한 파일에 대해 K 의 결정 ("local" | "remote") 을 받아 적용.
 */
export function syncResolveConflict(target: SyncTarget, keepSide: "local" | "remote"): GitSyncResult {
  if (!isGitRepo(target.cwd)) {
    return { ok: false, action: "conflict", message: "git repo not initialized", kind: target.kind };
  }
  const flag = keepSide === "local" ? "--ours" : "--theirs";
  const checkout = runGit(["checkout", flag, "."], { cwd: target.cwd });
  if (!checkout.ok) {
    return {
      ok: false,
      action: "conflict",
      message: `checkout ${flag} 실패: ${checkout.stderr.slice(0, 200)}`,
      kind: target.kind,
    };
  }
  runGit(["add", "-A"], { cwd: target.cwd });
  const rebaseMerge = existsSync(path.join(target.cwd, ".git", "rebase-merge"));
  const rebaseApply = existsSync(path.join(target.cwd, ".git", "rebase-apply"));
  if (rebaseMerge || rebaseApply) {
    const cont = runGit(["rebase", "--continue"], { cwd: target.cwd, timeoutMs: 30_000 });
    if (!cont.ok) {
      return {
        ok: false,
        action: "conflict",
        message: `rebase --continue 실패: ${cont.stderr.slice(0, 200)}`,
        kind: target.kind,
      };
    }
  } else {
    const hostname = os.hostname() || "host";
    const cm = runGit(["commit", "-m", `resolve: keep ${keepSide} (${hostname})`], { cwd: target.cwd });
    if (!cm.ok) {
      return {
        ok: false,
        action: "conflict",
        message: `merge resolve commit 실패: ${cm.stderr.slice(0, 200)}`,
        kind: target.kind,
      };
    }
  }
  return { ok: true, action: "conflict", message: `충돌 해결 — keep ${keepSide}`, kind: target.kind };
}

/**
 * Phase 91 (v0.6.33) — Commit history viewer.
 * `git log --pretty=format:"%H|%ai|%an|%s" -n {limit}` 결과 파싱.
 * UI 의 "📜 history 보기" 펼침 패널에 표시.
 *
 * @returns 최신 commit 부터 limit 개 (기본 20).
 */
export interface CommitEntry {
  hash: string;
  /** ISO author date (예: "2026-05-27 12:34:56 +0900") */
  date: string;
  author: string;
  subject: string;
}

export function syncLog(target: SyncTarget, limit = 20): {
  ok: boolean;
  message: string;
  commits: CommitEntry[];
  kind: SyncKind;
} {
  if (!isGitRepo(target.cwd)) {
    return {
      ok: false,
      message: "git repo not initialized",
      commits: [],
      kind: target.kind,
    };
  }
  const safeLimit = Math.max(1, Math.min(200, limit));
  // 구분자에 잘 안 들어가는 문자열 사용 ("\x1f" = unit separator). subject 의 "|" 깨짐 회피.
  const SEP = "\x1f";
  const r = runGit(
    ["log", `--pretty=format:%H${SEP}%ai${SEP}%an${SEP}%s`, "-n", String(safeLimit)],
    { cwd: target.cwd, timeoutMs: 15_000 },
  );
  if (!r.ok) {
    // 빈 repo (commit 0) — fatal: your current branch ... has no commits
    if (/no commits|does not have any commits|unknown revision/i.test(r.stderr)) {
      return { ok: true, message: "commit 없음 (빈 repo)", commits: [], kind: target.kind };
    }
    return {
      ok: false,
      message: `git log 실패: ${r.stderr.slice(0, 200)}`,
      commits: [],
      kind: target.kind,
    };
  }
  const commits: CommitEntry[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(SEP);
    if (parts.length < 4) continue;
    commits.push({
      hash: parts[0],
      date: parts[1],
      author: parts[2],
      subject: parts.slice(3).join(SEP), // subject 에 SEP 들어가도 graceful
    });
  }
  return { ok: true, message: `${commits.length}개 commit`, commits, kind: target.kind };
}

/**
 * Status 요약 — UI 에 "마지막 sync: 2분 전 ✓" 표시용.
 */
export function syncStatus(target: SyncTarget): {
  initialized: boolean;
  hasRemote: boolean;
  localChanges: number;
  branch: string | null;
} {
  if (!isGitRepo(target.cwd)) {
    return { initialized: false, hasRemote: false, localChanges: 0, branch: null };
  }
  const status = runGit(["status", "--porcelain"], { cwd: target.cwd });
  const localChanges = status.ok
    ? status.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0).length
    : 0;
  const remote = runGit(["remote", "get-url", "origin"], { cwd: target.cwd });
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: target.cwd });
  return {
    initialized: true,
    hasRemote: remote.ok && remote.stdout.trim().length > 0,
    localChanges,
    branch: branch.ok ? branch.stdout.trim() : null,
  };
}
