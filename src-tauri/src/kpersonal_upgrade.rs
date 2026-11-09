//! v0.7.82 — K-Personal-MCP 버전 관리.
//!
//! 문제: KDA 설치 파일에는 k-personal 사본(`bundled-mcp`)이 들어가지만, 예전에는 새 PC 에
//! 폴더가 없을 때만 복사했다. 이미 설치된 PC 의 k-personal 은 KDA 를 업데이트해도 옛 코드로 남았다.
//!
//! 해결: 앱 시작 시 실제로 쓰이는 k-personal 폴더의 `KPM_VERSION` 을 번들의 값과 비교한다.
//!   - 낮으면: git 저장소이고 추적 파일 변경이 없으면 `kpersonal.lock.json` 의 커밋으로 fast-forward.
//!     git 이 아니거나 ff 가 안 되면 번들 파일로 덮어쓰되, 덮어쓸 파일은 먼저 `~/.kda/backups/` 에 백업.
//!     추적 파일에 로컬 변경이 있으면 건드리지 않고 실패로 보고한다.
//!   - 그 다음 `py -m pip install -r requirements.txt` 로 의존성 버전(uiautomation 고정 등)을 맞춘다.
//!   - 복사 방식에서는 pip 이 성공한 뒤에만 `KPM_VERSION` 을 쓴다 → 실패하면 다음 시작 때 재시도.
//!   - 결과는 `~/.kda/kpersonal-update-status.json` 에 기록하고 프론트에 이벤트로 알린다.
//! `data/`, `*.db`, 사용자 plugin 등 번들에 없는 파일은 절대 건드리지 않는다.

use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;

pub const LOCK_JSON: &str = include_str!("../../kpersonal.lock.json");

pub fn lock_commit() -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(LOCK_JSON).ok()?;
    v.get("commit")?.as_str().map(|s| s.to_string())
}

/// `KPM_VERSION` 파일 값. 파일이 없으면 1 (버전 관리 이전 설치본).
pub fn read_kpm_version(dir: &Path) -> u32 {
    std::fs::read_to_string(dir.join("KPM_VERSION"))
        .ok()
        .and_then(|s| s.trim_start_matches('\u{feff}').trim().parse::<u32>().ok())
        .unwrap_or(1)
}

pub fn status_path() -> Option<PathBuf> {
    // KPM_STATUS_DIR: E2E 테스트용 (USERPROFILE 을 바꾸면 py launcher 가 exit 109 로 깨짐)
    if let Ok(d) = std::env::var("KPM_STATUS_DIR") {
        return Some(PathBuf::from(d).join("kpersonal-update-status.json"));
    }
    std::env::var("USERPROFILE")
        .ok()
        .map(|h| PathBuf::from(h).join(".kda").join("kpersonal-update-status.json"))
}

pub fn read_status() -> serde_json::Value {
    status_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok())
        .unwrap_or(serde_json::Value::Null)
}

fn write_status(v: &serde_json::Value) {
    if let Some(p) = status_path() {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(p, serde_json::to_string_pretty(v).unwrap_or_default());
    }
}

/// sidecar `resolveKPersonalPath()` 와 같은 우선순위로 실제 사용되는 k-personal 폴더를 찾는다.
pub fn resolve_active_dir(home: &Path, env_override: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = env_override {
        let p = PathBuf::from(p);
        if p.exists() {
            return p.parent().map(|d| d.to_path_buf());
        }
    }
    let cache = home.join(".kda").join("kpersonal-mcp-path.txt");
    if let Ok(raw) = std::fs::read_to_string(&cache) {
        let first = raw.trim_start_matches('\u{feff}').lines().next().unwrap_or("").trim().to_string();
        if !first.is_empty() {
            let d = PathBuf::from(first);
            if d.join("server.py").exists() {
                return Some(d);
            }
        }
    }
    let candidates = [
        home.join("Documents").join("K-Personal-MCP"),
        home.join("OneDrive").join("Documents").join("K-Personal-MCP"),
        home.join("OneDrive").join("문서").join("K-Personal-MCP"),
        home.join("K-Personal-MCP"),
    ];
    candidates.into_iter().find(|d| d.join("server.py").exists())
}

/// 번들 안의 파일 목록(상대 경로). `.git`, `__pycache__`, `data` 는 제외.
pub fn bundle_files(bundle: &Path) -> Vec<PathBuf> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name == ".git" || name == "__pycache__" || name == "data" {
                continue;
            }
            if p.is_dir() {
                walk(root, &p, out);
            } else if let Ok(rel) = p.strip_prefix(root) {
                out.push(rel.to_path_buf());
            }
        }
    }
    let mut out = Vec::new();
    walk(bundle, bundle, &mut out);
    out.sort();
    out
}

/// 번들 파일을 target 으로 복사. 덮어쓸 기존 파일은 backup 에 먼저 복사. `KPM_VERSION` 은 제외
/// (의존성 설치 성공 후 따로 쓴다). 복사한 파일 수를 돌려준다.
pub fn copy_bundle_over(bundle: &Path, target: &Path, backup: &Path) -> Result<usize, String> {
    let mut n = 0;
    for rel in bundle_files(bundle) {
        if rel.as_os_str() == "KPM_VERSION" {
            continue;
        }
        let src = bundle.join(&rel);
        let dst = target.join(&rel);
        if dst.exists() {
            let b = backup.join(&rel);
            if let Some(parent) = b.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("백업 폴더 생성 실패: {}", e))?;
            }
            std::fs::copy(&dst, &b).map_err(|e| format!("백업 실패 {}: {}", rel.display(), e))?;
        }
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(&src, &dst).map_err(|e| format!("복사 실패 {}: {}", rel.display(), e))?;
        n += 1;
    }
    Ok(n)
}

fn hidden(cmd: &mut StdCommand) -> &mut StdCommand {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

fn run(cmd: &mut StdCommand) -> (i32, String) {
    match hidden(cmd).output() {
        Ok(o) => {
            let mut s = String::from_utf8_lossy(&o.stdout).to_string();
            s.push_str(&String::from_utf8_lossy(&o.stderr));
            (o.status.code().unwrap_or(-1), s)
        }
        Err(e) => (-1, e.to_string()),
    }
}

fn tail(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

fn try_git_ff(target: &Path, commit: &str) -> Result<(), String> {
    let t = target.to_string_lossy().to_string();
    let (code, out) = run(StdCommand::new("git").args(["-C", &t, "status", "--porcelain", "--untracked-files=no"]));
    if code != 0 {
        return Err(format!("git status 실패: {}", tail(&out, 3)));
    }
    if !out.trim().is_empty() {
        return Err(format!("LOCAL_CHANGES:{}", tail(&out, 5)));
    }
    let (code, out) = run(StdCommand::new("git").args(["-C", &t, "fetch", "--quiet", "origin"]));
    if code != 0 {
        return Err(format!("git fetch 실패: {}", tail(&out, 3)));
    }
    let (code, out) = run(StdCommand::new("git").args(["-C", &t, "merge", "--ff-only", commit]));
    if code != 0 {
        return Err(format!("git fast-forward 실패: {}", tail(&out, 3)));
    }
    Ok(())
}

fn pip_install(target: &Path) -> (i32, String) {
    let req = target.join("requirements.txt");
    let req_s = req.to_string_lossy().to_string();
    for py in ["py", "python"] {
        let (code, out) = run(StdCommand::new(py).args([
            "-m", "pip", "install", "--disable-pip-version-check", "-r", &req_s,
        ]));
        if code != -1 {
            return (code, out);
        }
    }
    (-1, "python 실행 파일을 찾지 못함 (py / python)".into())
}

fn now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 업그레이드 본체. 결과 상태 JSON 을 돌려주고 파일에도 기록한다.
pub fn run_upgrade(bundle: &Path, target: &Path, home: &Path) -> serde_json::Value {
    let bundled_v = read_kpm_version(bundle);
    let before_v = read_kpm_version(target);
    let prev = read_status();
    let deps_ok_for = prev.get("depsOkVersion").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let mut status = serde_json::json!({
        "at": now_epoch(),
        "target": target.to_string_lossy(),
        "bundledVersion": bundled_v,
        "fromVersion": before_v,
        "toVersion": before_v,
        "depsOkVersion": deps_ok_for,
    });

    if before_v >= bundled_v && deps_ok_for >= before_v {
        status["state"] = "current".into();
        write_status(&status);
        return status;
    }

    let mut method = "none";
    let mut code_ready = before_v >= bundled_v;
    let mut backup_dir: Option<PathBuf> = None;
    if !code_ready {
        if target.join(".git").exists() {
            match lock_commit() {
                Some(c) => match try_git_ff(target, &c) {
                    Ok(()) => {
                        method = "git";
                        code_ready = read_kpm_version(target) >= bundled_v;
                    }
                    Err(e) if e.starts_with("LOCAL_CHANGES:") => {
                        status["state"] = "failed".into();
                        status["error"] = format!(
                            "k-personal 폴더에 커밋하지 않은 수정이 있어 자동 업데이트를 건너뜀: {}",
                            e.trim_start_matches("LOCAL_CHANGES:")
                        ).into();
                        write_status(&status);
                        return status;
                    }
                    Err(e) => {
                        status["gitError"] = e.into();
                    }
                },
                None => {
                    status["gitError"] = "kpersonal.lock.json 에 commit 없음".into();
                }
            }
        }
        if !code_ready {
            let b = home.join(".kda").join("backups").join(format!("kpersonal-{}", now_epoch()));
            match copy_bundle_over(bundle, target, &b) {
                Ok(n) => {
                    method = "copy";
                    status["copiedFiles"] = n.into();
                    status["backup"] = b.to_string_lossy().to_string().into();
                    backup_dir = Some(b);
                }
                Err(e) => {
                    status["state"] = "failed".into();
                    status["error"] = format!("번들 복사 실패: {}", e).into();
                    write_status(&status);
                    return status;
                }
            }
        }
    }
    status["method"] = method.into();

    let (pip_code, pip_out) = pip_install(target);
    status["pipExit"] = pip_code.into();
    if pip_code != 0 {
        status["state"] = "failed".into();
        status["error"] = format!("의존성 설치 실패 (exit {}): {}", pip_code, tail(&pip_out, 6)).into();
        status["toVersion"] = read_kpm_version(target).into();
        write_status(&status);
        return status;
    }
    if backup_dir.is_some() || method == "copy" {
        if let Err(e) = std::fs::copy(bundle.join("KPM_VERSION"), target.join("KPM_VERSION")) {
            status["state"] = "failed".into();
            status["error"] = format!("KPM_VERSION 기록 실패: {}", e).into();
            write_status(&status);
            return status;
        }
    }
    let after_v = read_kpm_version(target);
    status["toVersion"] = after_v.into();
    status["depsOkVersion"] = after_v.into();
    status["state"] = if after_v >= bundled_v {
        if before_v < bundled_v { "upgraded" } else { "deps_synced" }
    } else {
        "failed"
    }
    .into();
    if after_v < bundled_v {
        status["error"] = format!("업데이트 후에도 버전이 낮음 ({} < {})", after_v, bundled_v).into();
    }
    write_status(&status);
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kpm-upgrade-test-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn lock_has_commit() {
        let c = lock_commit().expect("commit");
        assert_eq!(c.len(), 40);
    }

    #[test]
    fn version_defaults_to_one() {
        let d = tmp("ver");
        assert_eq!(read_kpm_version(&d), 1);
        std::fs::write(d.join("KPM_VERSION"), "\u{feff}2\r\n").unwrap();
        assert_eq!(read_kpm_version(&d), 2);
    }

    #[test]
    fn copy_preserves_user_data_and_backs_up() {
        let root = tmp("copy");
        let bundle = root.join("bundle");
        let target = root.join("target");
        std::fs::create_dir_all(bundle.join("modules")).unwrap();
        std::fs::create_dir_all(target.join("modules")).unwrap();
        std::fs::create_dir_all(target.join("data")).unwrap();
        std::fs::write(bundle.join("server.py"), "new").unwrap();
        std::fs::write(bundle.join("modules").join("tool_errors.py"), "new").unwrap();
        std::fs::write(bundle.join("KPM_VERSION"), "2").unwrap();
        std::fs::write(target.join("server.py"), "old").unwrap();
        std::fs::write(target.join("data").join("personal.db"), "keep").unwrap();
        std::fs::write(target.join("modules").join("my_plugin.py"), "keep").unwrap();
        let backup = root.join("backup");
        let n = copy_bundle_over(&bundle, &target, &backup).unwrap();
        assert_eq!(n, 2);
        assert_eq!(std::fs::read_to_string(target.join("server.py")).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(backup.join("server.py")).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(target.join("data").join("personal.db")).unwrap(), "keep");
        assert_eq!(std::fs::read_to_string(target.join("modules").join("my_plugin.py")).unwrap(), "keep");
        // KPM_VERSION 은 의존성 설치 성공 뒤에만 쓴다
        assert_eq!(read_kpm_version(&target), 1);
    }

    #[test]
    fn resolve_prefers_cache_file() {
        let home = tmp("resolve");
        let custom = home.join("custom").join("K-Personal-MCP");
        std::fs::create_dir_all(&custom).unwrap();
        std::fs::write(custom.join("server.py"), "").unwrap();
        let docs = home.join("Documents").join("K-Personal-MCP");
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::write(docs.join("server.py"), "").unwrap();
        assert_eq!(resolve_active_dir(&home, None).unwrap(), docs);
        std::fs::create_dir_all(home.join(".kda")).unwrap();
        std::fs::write(home.join(".kda").join("kpersonal-mcp-path.txt"), custom.to_string_lossy().as_bytes()).unwrap();
        assert_eq!(resolve_active_dir(&home, None).unwrap(), custom);
    }
}

/// 수동 E2E: KPM_E2E_BUNDLE / KPM_E2E_HOME 을 지정하고
/// `cargo test --lib kpersonal_upgrade::e2e -- --ignored --nocapture` 로 실행.
/// 실제 git / pip 을 호출한다.
#[cfg(test)]
mod e2e {
    use super::*;

    #[test]
    #[ignore]
    fn e2e_upgrade_from_env() {
        let bundle = PathBuf::from(std::env::var("KPM_E2E_BUNDLE").expect("KPM_E2E_BUNDLE"));
        let home = PathBuf::from(std::env::var("KPM_E2E_HOME").expect("KPM_E2E_HOME"));
        std::env::set_var("KPM_STATUS_DIR", home.join(".kda"));
        let target = resolve_active_dir(&home, None).expect("target");
        let first = run_upgrade(&bundle, &target, &home);
        println!("FIRST {}", serde_json::to_string(&first).unwrap());
        let second = run_upgrade(&bundle, &target, &home);
        println!("SECOND {}", serde_json::to_string(&second).unwrap());
    }
}
