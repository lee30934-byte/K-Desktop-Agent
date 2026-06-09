#!/usr/bin/env node
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function runGit(args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd: rootPath,
      encoding: "utf8",
      stdio: options.quiet ? ["ignore", "pipe", "ignore"] : ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (options.optional) return "";
    throw error;
  }
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootPath, relativePath), "utf8"));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(rootPath, relativePath), "utf8");
}

function parseSemver(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) fail(`invalid semantic version: ${version}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    text: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`,
  };
}

function compareSemver(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  return 0;
}

function bumpVersion(base, kind) {
  const v = { ...parseSemver(base) };
  if (kind === "patch") v.patch += 1;
  else if (kind === "minor") {
    v.minor += 1;
    v.patch = 0;
  } else if (kind === "major") {
    v.major += 1;
    v.minor = 0;
    v.patch = 0;
  } else if (/^\d+\.\d+\.\d+$/.test(kind)) {
    return parseSemver(kind).text;
  } else {
    fail(`invalid bump argument: ${kind} (use patch, minor, major, or x.y.z)`);
  }
  return `${v.major}.${v.minor}.${v.patch}`;
}

function getCargoVersion() {
  const cargo = readText("src-tauri/Cargo.toml");
  const match = /\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/.exec(cargo);
  if (!match) fail("cannot find [package] version in src-tauri/Cargo.toml");
  return match[1];
}

function getVersions() {
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  const tauri = readJson("src-tauri/tauri.conf.json");
  return {
    "package.json": pkg.version,
    "package-lock.json": lock.version,
    "package-lock.json packages[\"\"]": lock.packages?.[""]?.version,
    "src-tauri/Cargo.toml": getCargoVersion(),
    "src-tauri/tauri.conf.json": tauri.version,
  };
}

function assertVersionsInSync() {
  const versions = getVersions();
  const entries = Object.entries(versions);
  const base = entries[0][1];
  const mismatched = entries.filter(([, version]) => version !== base);
  if (mismatched.length > 0) {
    console.error("version file mismatch:");
    for (const [file, version] of entries) console.error(`  - ${file}: ${version}`);
    fail("all release version files must use the same version");
  }
  parseSemver(base);
  return base;
}

function fetchRemoteTags() {
  runGit(["fetch", "origin", "main", "--tags", "--prune"], { quiet: true });
}

function latestTagVersion() {
  const tags = runGit(["tag", "--list", "v[0-9]*.[0-9]*.[0-9]*"], { quiet: true, optional: true })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((tag) => parseSemver(tag));
  if (tags.length === 0) return null;
  tags.sort(compareSemver);
  return tags.at(-1).text;
}

function assertMainUpToDate() {
  const branch = runGit(["branch", "--show-current"], { quiet: true });
  if (branch !== "main") fail(`version bump is allowed only on main; current branch: ${branch || "(detached)"}`);

  const head = runGit(["rev-parse", "HEAD"], { quiet: true });
  const originMain = runGit(["rev-parse", "origin/main"], { quiet: true });
  if (head !== originMain) {
    fail(`local HEAD differs from origin/main; pull or rebase first. HEAD=${head.slice(0, 7)}, origin/main=${originMain.slice(0, 7)}`);
  }
}

function assertCleanWorktree() {
  const status = runGit(["status", "--porcelain"], { quiet: true });
  if (status) fail("worktree must be clean before version bump; commit or stash changes first");
}

function assertChangelog(version) {
  const changelog = readText("CHANGELOG.md");
  const pattern = new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}`, "m");
  if (!pattern.test(changelog)) fail(`CHANGELOG.md is missing: ## [${version}] - YYYY-MM-DD`);
}

function cmdCheck() {
  const version = assertVersionsInSync();
  console.log(`OK versions in sync: ${version}`);
}

function cmdNext(kind) {
  if (!kind) fail("next requires patch, minor, major, or x.y.z");
  fetchRemoteTags();
  assertMainUpToDate();
  assertCleanWorktree();
  const current = assertVersionsInSync();
  const latest = latestTagVersion();
  if (!latest) fail("no vX.Y.Z tags found");
  if (compareSemver(parseSemver(current), parseSemver(latest)) < 0) {
    fail(`local version ${current} is lower than latest tag ${latest}; sync main first`);
  }
  const next = bumpVersion(latest, kind);
  if (compareSemver(parseSemver(next), parseSemver(latest)) <= 0) {
    fail(`new version ${next} must be greater than latest release ${latest}`);
  }
  const existing = runGit(["tag", "--list", `v${next}`], { quiet: true, optional: true });
  if (existing) fail(`tag already exists: v${next}`);
  process.stdout.write(next);
}

function cmdRelease(tagArg) {
  const tag = tagArg || process.env.GITHUB_REF_NAME || "";
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) fail(`release requires a vX.Y.Z tag; got: ${tag || "(empty)"}`);
  const version = assertVersionsInSync();
  if (`v${version}` !== tag) fail(`tag ${tag} does not match version files ${version}`);
  assertChangelog(version);
  const head = runGit(["rev-parse", "HEAD"], { quiet: true });
  const tagCommit = runGit(["rev-list", "-n", "1", tag], { quiet: true });
  if (head !== tagCommit) fail(`HEAD ${head.slice(0, 7)} is not tag ${tag} commit ${tagCommit.slice(0, 7)}`);
  console.log(`OK release tag matches version files and changelog: ${tag}`);
}

const [command = "check", arg] = process.argv.slice(2);

if (command === "check") cmdCheck();
else if (command === "next") cmdNext(arg);
else if (command === "release") cmdRelease(arg);
else fail(`unknown command: ${command}`);
