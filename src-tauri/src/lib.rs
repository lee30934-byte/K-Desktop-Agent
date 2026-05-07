use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebouncedEventKind};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex, RwLock};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent,
};

/// Node sidecar stdin writer 채널. 싱글톤.
static SIDECAR_TX: OnceLock<Arc<Mutex<Option<mpsc::Sender<String>>>>> = OnceLock::new();
/// Sidecar 자식 프로세스 핸들. 리로드 시 kill 하기 위해 보관.
static SIDECAR_CHILD: OnceLock<Arc<Mutex<Option<Child>>>> = OnceLock::new();
/// 파일 감시 대상 폴더들과 watcher 핸들
static WATCHED_FOLDERS: OnceLock<Arc<RwLock<HashMap<String, WatchedFolder>>>> = OnceLock::new();

/// sidecar 를 의도적으로 종료시키는 중(reload/quit)인지 여부. true 면 stdout EOF 에서 재시작하지 않음.
static INTENTIONAL_SHUTDOWN: AtomicBool = AtomicBool::new(false);
/// 연속 재시작 시도 횟수. 성공 신호(stdout 첫 메시지) 수신 시 0 으로 리셋.
static RESTART_ATTEMPTS: AtomicU32 = AtomicU32::new(0);
/// 재시작 최대 횟수. 초과 시 영구 실패로 UI 알림.
const MAX_RESTART_ATTEMPTS: u32 = 3;
/// Supervisor 채널 — stdout 루프에서 "재시작 해 줘" 요청을 넣는다. 재귀 호출 회피용.
static RESPAWN_TX: OnceLock<mpsc::UnboundedSender<RespawnRequest>> = OnceLock::new();

#[derive(Clone)]
struct RespawnRequest {
    delay_secs: u64,
    attempt: u32,
}

#[derive(Clone, serde::Serialize)]
struct WatchedFolder {
    path: String,
    label: String,
    created_count: u32,
    modified_count: u32,
    deleted_count: u32,
    last_event: Option<u64>, // timestamp
}

#[derive(Clone, serde::Serialize)]
struct FileChangeEvent {
    folder_id: String,
    path: String,
    kind: String, // "created", "modified", "deleted"
    timestamp: u64,
}

fn get_watched_folders() -> &'static Arc<RwLock<HashMap<String, WatchedFolder>>> {
    WATCHED_FOLDERS.get_or_init(|| Arc::new(RwLock::new(HashMap::new())))
}

fn get_tx_holder() -> &'static Arc<Mutex<Option<mpsc::Sender<String>>>> {
    SIDECAR_TX.get_or_init(|| Arc::new(Mutex::new(None)))
}

fn get_child_holder() -> &'static Arc<Mutex<Option<Child>>> {
    SIDECAR_CHILD.get_or_init(|| Arc::new(Mutex::new(None)))
}

// ────────── Lifecycle logging ──────────

/// `<project_root>/logs/<file>` 에 한 줄 append. 실패 시 조용히 무시 (로깅이 앱을 죽이면 안 됨).
/// file 예시: "crash.log", "shutdown.log", "sidecar.log"
fn log_lifecycle(file: &str, line: &str) {
    let timestamp = chrono_lite_now();
    let log_dir = find_logs_dir();
    let _ = std::fs::create_dir_all(&log_dir);
    let path = log_dir.join(file);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "[{}] {}", timestamp, line);
    }
}

/// 로그 디렉토리 위치 탐지. dev 모드(cwd = src-tauri)와 prod(current_exe 옆) 모두 커버.
/// 프로젝트 루트 기준으로 일관된 `logs/` 경로 반환.
fn find_logs_dir() -> PathBuf {
    // 1. current_exe 에서 부모로 올라가며 프로젝트 루트 표식(package.json 또는 src-tauri 폴더) 탐색
    if let Ok(exe) = std::env::current_exe() {
        let mut current = exe.parent();
        while let Some(p) = current {
            if p.join("package.json").exists() || p.join("src-tauri").exists() {
                return p.join("logs");
            }
            current = p.parent();
        }
    }
    // 2. cwd 가 src-tauri 면 부모의 logs, 아니면 cwd/logs
    if let Ok(cwd) = std::env::current_dir() {
        if cwd.file_name().map(|n| n == "src-tauri").unwrap_or(false) {
            if let Some(parent) = cwd.parent() {
                return parent.join("logs");
            }
        }
        return cwd.join("logs");
    }
    // 3. 최후 fallback
    PathBuf::from("logs")
}

/// chrono 의존성 없이 ISO-8601 비슷한 로컬 타임스탬프. SystemTime 기반.
fn chrono_lite_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 초 단위 epoch 만 기록. 가독성 낮지만 chrono 추가 없이 안전.
    format!("epoch={}", secs)
}

// ────────── Commands ──────────

#[tauri::command]
async fn send_message(
    message: String,
    id: String,
    agent_id: Option<String>,
    history: Option<serde_json::Value>,
    api_key: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    // 권한 정책: { permission_id: "auto" | "ask" | "manual", ... }
    // claude provider 의 sidecar CLI 호출 시 --disallowed-tools 와 시스템 프롬프트 안내 생성.
    // None 이면 sidecar 의 DEFAULT_PERMISSIONS 가 적용.
    permissions: Option<serde_json::Value>,
    // 개별 잠금된 도구 풀네임 목록 (Settings UI "정밀 잠금" 섹션).
    // 카테고리 토글과 독립적으로 --disallowed-tools 에 그대로 추가됨.
    // None / 빈 배열 → 개별 잠금 없음.
    // (JS 호출 측은 Tauri 의 자동 케이스 변환에 따라 `lockedTools` 키로 전달)
    locked_tools: Option<serde_json::Value>,
    // 첨부 파일: [{name, type, size, base64}]
    // sidecar 가 임시 폴더에 디코드해 파일로 저장 후 Claude CLI 에 path 로 안내.
    // Claude CLI 의 Read 도구가 path 를 받아 이미지면 vision, 텍스트면 그대로 처리.
    // None / 빈 배열 → 첨부 없음.
    attachments: Option<serde_json::Value>,
) -> Result<(), String> {
    let mut payload = serde_json::json!({
        "type": "user_message",
        "id": id,
        "content": message,
    });
    // agent_id가 있으면 resume 지원을 위해 추가
    if let Some(aid) = agent_id {
        payload["agent_id"] = serde_json::Value::String(aid);
    }
    // history 가 있으면 sidecar 에 그대로 전달 (이전 턴 컨텍스트용)
    if let Some(h) = history {
        payload["history"] = h;
    }
    // API 키와 프로바이더/모델 정보 추가
    if let Some(key) = api_key {
        payload["api_key"] = serde_json::Value::String(key);
    }
    if let Some(prov) = provider {
        payload["provider"] = serde_json::Value::String(prov);
    }
    if let Some(m) = model {
        payload["model"] = serde_json::Value::String(m);
    }
    // 권한 정책 (있으면 그대로 전달; 없으면 sidecar 가 기본값 사용)
    if let Some(p) = permissions {
        payload["permissions"] = p;
    }
    // 개별 잠금 도구 (sidecar 는 lockedTools 키로 읽음 — JSON 키 이름 유지)
    if let Some(lt) = locked_tools {
        payload["lockedTools"] = lt;
    }
    // 첨부 파일 (sidecar 가 임시 파일로 저장 후 prompt 에 path 안내 추가)
    if let Some(att) = attachments {
        payload["attachments"] = att;
    }
    let line = format!("{}\n", payload);
    let tx_holder = get_tx_holder().clone();
    let guard = tx_holder.lock().await;
    let tx = guard.as_ref().ok_or("sidecar not initialized")?;
    tx.send(line).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn interrupt(id: String) -> Result<(), String> {
    let payload = serde_json::json!({ "type": "interrupt", "id": id });
    let line = format!("{}\n", payload);
    let tx_holder = get_tx_holder().clone();
    let guard = tx_holder.lock().await;
    let tx = guard.as_ref().ok_or("sidecar not initialized")?;
    tx.send(line).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn ping_sidecar() -> Result<(), String> {
    let payload = serde_json::json!({ "type": "ping" });
    let line = format!("{}\n", payload);
    let tx_holder = get_tx_holder().clone();
    let guard = tx_holder.lock().await;
    let tx = guard.as_ref().ok_or("sidecar not initialized")?;
    tx.send(line).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn elicitation_response(id: String, confirmed: bool) -> Result<(), String> {
    let payload = serde_json::json!({
        "type": "elicitation_response",
        "id": id,
        "confirmed": confirmed,
    });
    let line = format!("{}\n", payload);
    let tx_holder = get_tx_holder().clone();
    let guard = tx_holder.lock().await;
    let tx = guard.as_ref().ok_or("sidecar not initialized")?;
    tx.send(line).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn reload_sidecar(app: AppHandle) -> Result<(), String> {
    log_lifecycle("sidecar.log", "reload_sidecar requested");
    // 의도적 종료: stdout EOF 에서 자동 재시작 금지. spawn_sidecar 진입 시 다시 false 로.
    INTENTIONAL_SHUTDOWN.store(true, Ordering::SeqCst);
    // 재시작 카운터도 리셋 — 사용자 의지의 재시작이므로 직전 실패 기록은 잊는다.
    RESTART_ATTEMPTS.store(0, Ordering::SeqCst);

    // 1. 기존 프로세스 kill
    let child_holder = get_child_holder().clone();
    {
        let mut guard = child_holder.lock().await;
        if let Some(mut child) = guard.take() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }
    // 2. 기존 채널 제거
    {
        let tx_holder = get_tx_holder().clone();
        let mut tx_guard = tx_holder.lock().await;
        *tx_guard = None;
    }
    // 3. 프론트에 알림
    let _ = app.emit(
        "sidecar-event",
        serde_json::json!({ "type": "reloading", "message": "Sidecar 재기동 중..." }),
    );
    // 4. 재기동
    spawn_sidecar(app).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    Ok(())
}

#[tauri::command]
fn hide_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    Ok(())
}

/// Claude Code CLI 의 OAuth 로그인 흐름을 별도 콘솔 창에서 실행한다.
/// `cmd /k claude login` 을 새 콘솔 창에 붙여 띄워서, K 가 브라우저 OAuth 를 끝낸 뒤
/// 결과 메시지를 직접 확인하고 닫을 수 있도록 한다.
/// Windows 한정 — 다른 OS 에서는 단순 에러 반환.
#[tauri::command]
fn run_claude_login() -> Result<(), String> {
    log_lifecycle("runtime.log", "run_claude_login invoked");
    if cfg!(target_os = "windows") {
        // `cmd /c start "Claude Login" cmd /k claude login`
        // - `start "..."` 는 새 콘솔 창을 띄우고, 첫 인자를 창 제목으로 소비함
        // - `cmd /k` 는 명령 실행 후 창을 유지 (K 가 결과 보고 직접 닫음)
        // claude.cmd 가 PATH 에 있다고 가정 (있어야 sidecar 도 동작 중일 것).
        std::process::Command::new("cmd")
            .args(["/c", "start", "Claude Login", "cmd", "/k", "claude", "login"])
            .spawn()
            .map_err(|e| format!("claude login 콘솔 기동 실패: {}", e))?;
        Ok(())
    } else {
        Err("Windows 전용 기능입니다".to_string())
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    log_lifecycle("shutdown.log", "quit_app invoked (frontend)");
    INTENTIONAL_SHUTDOWN.store(true, Ordering::SeqCst);
    app.exit(0);
}

// ────────── Safety net (백업/복구) ──────────
//
// "LLM 통신 불능 시에도 K 가 단독 복구 가능" 보장을 위한 이중 방벽.
//   진입점 1: Settings UI 의 "안전장치" 섹션 → 이 모듈의 Tauri command 호출
//   진입점 2: 바탕화면 "K-Desktop-Agent 비상복구.lnk" → scripts/rollback.ps1 직접 실행
// 두 경로 모두 결국 같은 PowerShell 스크립트 (backup.ps1 / rollback.ps1) 를 호출 →
// 로직 한 곳에 모이고 진입점만 다중화.

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct BackupFile {
    name: String,
    size: u64,
    sha256: Option<String>,
    src: String,
    #[serde(default)]
    missing: bool,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct BackupInfo {
    timestamp: String,
    label: String,
    #[serde(rename = "createdBy")]
    created_by: String,
    files: Vec<BackupFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    total_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dir_path: Option<String>,
}

/// 프로젝트 루트 (logs/ 와 같은 로직 재사용).
fn project_root() -> Result<PathBuf, String> {
    if let Ok(exe) = std::env::current_exe() {
        let mut current = exe.parent();
        while let Some(p) = current {
            if p.join("package.json").exists() || p.join("src-tauri").exists() {
                return Ok(p.to_path_buf());
            }
            current = p.parent();
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if cwd.file_name().map(|n| n == "src-tauri").unwrap_or(false) {
            if let Some(parent) = cwd.parent() {
                return Ok(parent.to_path_buf());
            }
        }
        return Ok(cwd);
    }
    Err("can't locate project root".into())
}

/// Phase 19 (release path resolution): scripts/<name> 의 절대 경로를 release/dev 자동 분기로 해석.
///
/// 함정 (v0.5.4): `project_root()` 가 release 환경에서 fail 하면 cwd (= K 가 KDA 자동시작/트레이로
/// 띄울 때의 `C:\WINDOWS\system32`) 를 root 로 박아 `C:\WINDOWS\system32\scripts\install-deps.ps1`
/// 같은 잘못된 경로 만들어냄. Tauri release 에선 install dir 의 `scripts/` 가 정답
/// (bundle.resources 에 의해 install dir 에 자동 복사). dev 에선 project root 의 scripts/.
///
/// 우선순위:
///   1. `current_exe().parent()` 의 scripts 폴더 (release path)
///   2. dev project root 폴백 (일부 portable 빌드 포함)
fn resolve_script_path(name: &str) -> Result<PathBuf, String> {
    let mut tried: Vec<PathBuf> = Vec::new();
    fn try_path(p: PathBuf, tried: &mut Vec<PathBuf>) -> Option<PathBuf> {
        if p.exists() {
            return Some(p);
        }
        tried.push(p);
        None
    }
    // Phase 20 (v0.5.6) / Phase 21 (v0.5.7): Tauri v2 의 bundle.resources (array 형식)
    // 가 install dir 어디에 정확히 두는지 NSIS/MSI 빌드별로 다름. 다중 후보 시도.
    //
    // 가능한 위치 (관찰됨):
    //   1. <install>/scripts/<name>                              — bundle 이 source 디렉토리 구조 보존
    //   2. <install>/<name>                                       — bundle 이 source 의 leaf 파일만 복사
    //   3. <install>/resources/scripts/<name>                     — Tauri 의 resource_dir 내부
    //   4. <install>/resources/_up_/scripts/<name>                — updater 가 _up_ sub-dir 사용
    //   5. <install>/_up_/scripts/<name>                          — updater 의 또 다른 layout
    //   6. <install>/resources/<full-prefix>/scripts/<name>       — source 경로 prefix 보존
    if let Ok(exe) = std::env::current_exe() {
        if let Some(install_dir) = exe.parent() {
            let candidates = vec![
                install_dir.join("scripts").join(name),
                install_dir.join(name),
                install_dir.join("resources").join("scripts").join(name),
                install_dir.join("resources").join(name),
                install_dir.join("resources").join("_up_").join("scripts").join(name),
                install_dir.join("_up_").join("scripts").join(name),
                install_dir.join("_up_").join("resources").join("scripts").join(name),
            ];
            for c in candidates {
                if let Some(found) = try_path(c, &mut tried) {
                    return Ok(found);
                }
            }
        }
    }
    if let Ok(root) = project_root() {
        let p = root.join("scripts").join(name);
        if let Some(found) = try_path(p, &mut tried) {
            return Ok(found);
        }
    }
    Err(format!(
        "script '{}' 못 찾음. 시도한 경로 ({}): [{}]",
        name,
        tried.len(),
        tried
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

/// K-Personal MCP server.py 절대 경로 해석. sidecar 의 K_PERSONAL_PATH 와 동일한 우선순위
/// 패턴 — release 환경에서도 일관되게 동작하도록.
///
/// 우선순위:
///   1. 환경변수 `K_PERSONAL_MCP_PATH` 명시 지정
///   2. `~/Documents/K-Personal-MCP/server.py` (K 의 평소 위치)
///   3. `~/K-Personal-MCP/server.py`
///   4. project_root().parent()/K-Personal-MCP/server.py (dev 환경의 sibling 폴더)
fn resolve_kpersonal_mcp_server() -> Result<PathBuf, String> {
    if let Ok(env_path) = std::env::var("K_PERSONAL_MCP_PATH") {
        let p = PathBuf::from(&env_path);
        if p.exists() {
            return Ok(p);
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        let candidates = [
            PathBuf::from(&home)
                .join("Documents")
                .join("K-Personal-MCP")
                .join("server.py"),
            PathBuf::from(&home)
                .join("K-Personal-MCP")
                .join("server.py"),
        ];
        for c in &candidates {
            if c.exists() {
                return Ok(c.clone());
            }
        }
    }
    if let Ok(root) = project_root() {
        if let Some(parent) = root.parent() {
            let p = parent.join("K-Personal-MCP").join("server.py");
            if p.exists() {
                return Ok(p);
            }
        }
    }
    Err("K-Personal MCP server.py 못 찾음 (USERPROFILE/Documents 또는 ~ 또는 dev sibling 모두 없음)".into())
}

/// UTF-8 BOM (`\u{FEFF}`) 이 있으면 떼어낸 슬라이스 반환.
/// 도입 배경 (2026-05-06): scripts/backup.ps1 의 PowerShell 5.1 `Set-Content -Encoding UTF8`
/// 가 latest.txt + manifest.json 첫 3바이트에 BOM (EF BB BF) 을 자동 주입 → `.trim()` 은 BOM 을
/// 공백으로 안 보고 그대로 둠 → label 이 "\u{FEFF}20260506-..." 가 되어 폴더 못 찾는 회귀 발생.
/// backup.ps1 은 UTF8NoBom 으로 패치됐지만, 외부 도구가 BOM 박힌 파일을 만들 가능성에 대한 안전망.
fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{FEFF}').unwrap_or(s)
}

/// 백업 폴더의 manifest.json 파싱 + 편의 필드 보강.
fn read_manifest(backup_dir: &std::path::Path) -> Result<BackupInfo, String> {
    let manifest_path = backup_dir.join("manifest.json");
    let raw = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("manifest.json 읽기 실패 ({:?}): {}", manifest_path, e))?;
    let raw_no_bom = strip_bom(&raw);
    let mut info: BackupInfo = serde_json::from_str(raw_no_bom)
        .map_err(|e| format!("manifest.json 파싱 실패: {}", e))?;
    info.dir_path = Some(backup_dir.to_string_lossy().to_string());
    info.total_size = Some(info.files.iter().filter(|f| !f.missing).map(|f| f.size).sum());
    Ok(info)
}

/// 마지막(latest) 백업 정보. 없으면 None.
#[tauri::command]
async fn get_latest_backup() -> Result<Option<BackupInfo>, String> {
    let root = project_root()?;
    let latest_file = root.join(".backups").join("latest.txt");
    if !latest_file.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&latest_file).map_err(|e| e.to_string())?;
    // BOM strip → trim — 순서 중요. trim 만으론 BOM 안 떨어짐.
    let label = strip_bom(&raw).trim().to_string();
    if label.is_empty() {
        return Ok(None);
    }
    let backup_dir = root.join(".backups").join(&label);
    if !backup_dir.exists() {
        return Ok(None);
    }
    Ok(Some(read_manifest(&backup_dir)?))
}

/// 모든 백업 스냅샷 목록 (최신순).
#[tauri::command]
async fn list_backups() -> Result<Vec<BackupInfo>, String> {
    let root = project_root()?;
    let backups_root = root.join(".backups");
    if !backups_root.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&backups_root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir = entry.path();
        if dir.join("manifest.json").exists() {
            if let Ok(info) = read_manifest(&dir) {
                out.push(info);
            }
        }
    }
    // 최신 timestamp 가 위로
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(out)
}

/// 새 백업 생성. scripts/backup.ps1 -AsJson 호출 → 결과 JSON 그대로 BackupInfo 로.
#[tauri::command]
async fn backup_now(label: Option<String>) -> Result<BackupInfo, String> {
    log_lifecycle("runtime.log", "backup_now invoked");
    let script = resolve_script_path("backup.ps1")
        .map_err(|e| format!("backup script 없음: {}", e))?;
    let label_arg = label.unwrap_or_else(|| "settings-ui".to_string());
    // Phase 23: Windows 콘솔 창 깜빡임 hide.
    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script.to_str().unwrap(),
        "-Label",
        &label_arg,
        "-AsJson",
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("backup.ps1 실행 실패: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("backup.ps1 종료 코드 {} — stderr: {}", output.status, stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stdout_trimmed = stdout.trim();
    if stdout_trimmed.is_empty() {
        return Err("backup.ps1 빈 응답".to_string());
    }
    let info: BackupInfo = serde_json::from_str(stdout_trimmed)
        .map_err(|e| format!("backup.ps1 응답 JSON 파싱 실패: {} (응답: {})", e, stdout_trimmed))?;
    log_lifecycle(
        "runtime.log",
        &format!("backup_now ok: label={} size={}", info.label, info.total_size.unwrap_or(0)),
    );
    Ok(info)
}

/// 마지막 백업 시점으로 복원.
/// rollback.ps1 -Yes 를 detached 로 spawn 하고 자기 자신은 종료.
/// (release 바이너리 자체 swap 이 필요해서 외부 프로세스가 처리해야 함)
#[tauri::command]
async fn rollback_now(app: AppHandle) -> Result<(), String> {
    log_lifecycle("shutdown.log", "rollback_now invoked — spawning rollback.ps1 then exiting self");
    let script = resolve_script_path("rollback.ps1")
        .map_err(|e| format!("rollback script 없음: {}", e))?;
    // detached spawn — 자기 자신이 죽어도 PowerShell 프로세스는 살아남아야 함.
    // Windows 에선 CREATE_NEW_PROCESS_GROUP + CREATE_BREAKAWAY_FROM_JOB 필요할 수 있으나
    // start /B 로 우회.
    std::process::Command::new("cmd")
        .args([
            "/c",
            "start",
            "",
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script.to_str().unwrap(),
            "-Yes",
        ])
        .spawn()
        .map_err(|e| format!("rollback.ps1 spawn 실패: {}", e))?;

    // 사용자에게 "복원 시작됨" 알림 후 자기 자신 종료.
    let _ = app.emit(
        "sidecar-event",
        serde_json::json!({
            "type": "rolling-back",
            "message": "복원 진행 중 — 잠시 후 옛 버전으로 자동 재기동됩니다."
        }),
    );
    // 0.5초 정도 frontend 알림 시간 확보 후 exit
    tokio::time::sleep(Duration::from_millis(500)).await;
    INTENTIONAL_SHUTDOWN.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

// ────────── Phase 18 — 의존성 자동 셋업 + First-run 마법사 ──────────
//
// 다른 PC 에서 setup.exe 만 깔고도 K-Desktop-Agent 가 곧장 동작 가능하도록
// install-deps.ps1 을 호출해 Node/Git/Python/Claude/Codex CLI 등을 자동 설치.
// OAuth 로그인은 K 가 직접 1회 — 보안상 자동화 불가.
//
// First-run sentinel = `~/.kda/first-run-completed.flag`
//   - 없으면: KDA 첫 실행으로 간주 → Settings 의 first-run 마법사 표시
//   - 있으면: 이미 셋업 완료 → 마법사 안 뜸 (Settings 에서 수동 트리거 가능)
// NSIS 가 sentinel 안 박음 — 신규 설치든 업데이트든 K 의 home 에 sentinel 없으면
// 마법사가 자연스럽게 표시. 업데이트 후엔 이미 sentinel 있어서 안 뜸.

fn first_run_sentinel_path() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .map_err(|e| format!("USERPROFILE 환경변수 없음: {}", e))?;
    Ok(PathBuf::from(home).join(".kda").join("first-run-completed.flag"))
}

#[tauri::command]
fn is_first_run() -> Result<bool, String> {
    let sentinel = first_run_sentinel_path()?;
    Ok(!sentinel.exists())
}

#[tauri::command]
fn mark_first_run_complete() -> Result<(), String> {
    let sentinel = first_run_sentinel_path()?;
    if let Some(parent) = sentinel.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("~/.kda 폴더 생성 실패: {}", e))?;
    }
    let now = chrono_lite_now();
    std::fs::write(&sentinel, format!("first-run completed at {}\n", now))
        .map_err(|e| format!("sentinel 파일 작성 실패: {}", e))?;
    log_lifecycle(
        "runtime.log",
        &format!("first-run sentinel created at {}", sentinel.display()),
    );
    Ok(())
}

/// install-deps.ps1 실행 (DryRun=true 면 detect 만, false 면 실제 설치).
///
/// JSON 결과는 PS 스크립트가 stdout 에 박은 그대로 frontend 에 전달 — Settings UI 가
/// 파싱해서 단계별 status / next steps 를 렌더. Rust 쪽에선 schema 까지 신경 안 씀.
async fn run_install_deps_internal(dry_run: bool) -> Result<String, String> {
    log_lifecycle(
        "runtime.log",
        &format!("run_install_deps invoked dry_run={}", dry_run),
    );
    let script = resolve_script_path("install-deps.ps1")
        .map_err(|e| format!("install-deps script 없음: {}", e))?;
    let mut args = vec![
        "-NoProfile".to_string(),
        "-ExecutionPolicy".to_string(),
        "Bypass".to_string(),
        "-File".to_string(),
        script.to_str().unwrap().to_string(),
        "-AsJson".to_string(),
    ];
    if dry_run {
        args.push("-DryRun".to_string());
    }
    // Phase 23 (v0.5.9): Windows 콘솔 창 숨김 — Settings 가 열릴 때마다 (DryRun)
    // PowerShell 깜빡임 UX 함정 해결. CREATE_NO_WINDOW = 0x08000000.
    let mut cmd = Command::new("powershell.exe");
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("install-deps.ps1 실행 실패: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stdout_trimmed = stdout.trim();
    let stderr = String::from_utf8_lossy(&output.stderr);
    // exit code 0/1 모두 valid result (1=partial). 2=fatal (winget 없음).
    let code = output.status.code().unwrap_or(-1);
    if code == 2 || stdout_trimmed.is_empty() {
        return Err(format!(
            "install-deps.ps1 fatal (exit={}) — stderr: {}",
            code,
            stderr.trim()
        ));
    }
    log_lifecycle(
        "runtime.log",
        &format!(
            "install-deps.ps1 done exit={} stdout_len={} stderr_len={}",
            code,
            stdout_trimmed.len(),
            stderr.len()
        ),
    );
    Ok(stdout_trimmed.to_string())
}

#[tauri::command]
async fn check_dependencies() -> Result<String, String> {
    run_install_deps_internal(true).await
}

#[tauri::command]
async fn run_install_deps() -> Result<String, String> {
    run_install_deps_internal(false).await
}

// ────────── Phase 15 — 외부 webview 창 + Codex 통합 ──────────
//
// K 의 의도: K-Desktop-Agent 안에서 모든 게 완결.
//   - 사용량 페이지: console.anthropic.com / chatgpt.com 등을 새 webview 창으로 열어서 그대로 보기
//   - Codex 로그인: 백그라운드로 codex login spawn (시스템 브라우저 자동 열림) — 외부 PowerShell 안 거침
//   - K-Personal MCP 등록: codex mcp add 한 번 실행해서 codex 도 같은 도구 쓰게
//
// 새 webview 창은 main 과 별개 cookie storage 를 갖고, K가 한 번 로그인하면 영속.

/// 외부 URL 을 K 의 시스템 기본 브라우저로 엶 (사용량 페이지, OAuth 페이지 등).
///
/// 원래 Phase 15 초기 설계는 새 webview 창으로 띄우는 거였으나 — Google OAuth 가
/// embedded webview (Tauri/Electron) 에서의 로그인을 보안 정책으로 차단함 (2021~).
/// "로그인 중 오류가 발생했습니다" 페이지가 떠서 K 가 anthropic / chatgpt 로그인 못함.
///
/// 회피책: 시스템 기본 브라우저 (Edge/Chrome/Firefox) 로 열기 — Google OAuth 제약 없음 +
/// K 평소 브라우저의 cookie 영속 → 다음에 그 브라우저에서 anthropic 들어갈 때도 자동 로그인.
///
/// frontend 호출 시그니처는 backward compat 위해 유지 (label, title 은 무시).
/// 함수명도 그대로 — frontend invoke 부분 변경 안 해도 됨.
#[tauri::command]
async fn open_external_webview(
    app: AppHandle,
    url: String,
    label: String,
    title: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    // URL validate — 비정상 URL 로 OS 핸들러에 흘리는 거 방지
    let _ = url::Url::parse(&url).map_err(|e| format!("invalid URL: {}", e))?;
    log_lifecycle(
        "runtime.log",
        &format!(
            "open_external_webview → system browser url={} label={} title={:?}",
            url, label, title
        ),
    );
    // 두 번째 인자 None = OS 기본 핸들러 (Edge/Chrome/Firefox 중 K 의 default).
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| format!("system browser open 실패: {}", e))?;
    Ok(())
}

/// Codex CLI 가 PATH 에 있는지.
fn codex_cli_path() -> Option<String> {
    // Windows: codex.cmd, codex.ps1, codex.exe 순으로 시도.
    // npm 글로벌 install 위치는 보통 %APPDATA%/npm 안에 codex.cmd 가 있음.
    let appdata = std::env::var("APPDATA").ok()?;
    let candidates = [
        format!("{}/npm/codex.cmd", appdata),
        format!("{}/npm/codex.ps1", appdata),
        "codex.cmd".to_string(),
        "codex".to_string(),
    ];
    candidates.into_iter().find(|p| std::path::Path::new(p).exists() || p == "codex.cmd" || p == "codex")
}

/// `codex login` 을 background spawn — 시스템 브라우저가 자동으로 OAuth 페이지 열림.
/// 실행 직후 즉시 반환. 진행 상황은 codex_login_status 로 poll.
#[tauri::command]
async fn codex_login() -> Result<(), String> {
    log_lifecycle("runtime.log", "codex_login spawning");
    // Windows: cmd /c codex.cmd login (npm 글로벌 install 위치).
    // 콘솔 창은 안 보이게 — CREATE_NO_WINDOW (0x08000000) flag.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/c", "codex.cmd", "login"])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("codex login spawn 실패: {}", e))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("codex")
            .arg("login")
            .spawn()
            .map_err(|e| format!("codex login spawn 실패: {}", e))?;
    }
    Ok(())
}

#[derive(Clone, serde::Serialize)]
struct CodexLoginStatus {
    authenticated: bool,
    cli_available: bool,
    auth_path: String,
}

/// Codex 인증 상태 — Settings UI 가 poll 해서 표시.
///
/// Phase 20 (v0.5.6) 강화:
/// 옛 동작은 `auth.exists()` 만 체크 → false positive (예: OneDrive 로 다른 PC 의 auth.json
/// 동기화됐거나, codex CLI 깔지 않았는데도 옛 잔존 파일 있는 경우 "✓ 로그인됨" 표시되어
/// K 가 실제 채팅 보내면 fail).
///
/// 새 동작:
///   1. cli_available = codex_cli_path().is_some() (CLI 자체 없으면 무조건 not authenticated)
///   2. authenticated = cli_available && auth.exists() && (auth.json 안 access_token 추출 가능)
///   3. 둘 중 하나 fail 이어도 false 반환 — UI 가 정확한 상태 표시
#[tauri::command]
async fn codex_login_status() -> Result<CodexLoginStatus, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    let auth = std::path::Path::new(&home).join(".codex").join("auth.json");
    let cli_available = codex_cli_path().is_some();
    // Valid 검증: 파일 있고 + JSON 파싱되고 + access_token 필드 추출 가능해야 진짜 인증됨
    let authenticated = cli_available && auth.exists() && read_codex_access_token().is_ok();
    Ok(CodexLoginStatus {
        authenticated,
        cli_available,
        auth_path: auth.to_string_lossy().to_string(),
    })
}

// ────────── Phase 15.5 — Codex Usage API ──────────
//
// `https://chatgpt.com/backend-api/codex/usage` 는 ChatGPT 백엔드의 비공식 endpoint.
// `~/.codex/auth.json` 의 OAuth access_token 을 Bearer 로 보내면 5h primary + 7d secondary
// rate limit 을 JSON 으로 받음. Anthropic 의 rate_limit_event 와 동등한 데이터.
//
// 비공식이라 깨질 위험 있음 → 호출 실패는 silently 처리 (UI 가 stale 표시).
// 토큰은 hourly expire — refresh 는 codex CLI 가 별도로 처리하므로 우리는 현재 access_token
// 만 읽어 사용. 401 받으면 K 가 codex login 다시 해야 한다는 신호.

#[derive(serde::Deserialize)]
struct CodexAuthFile {
    tokens: Option<CodexAuthTokens>,
    #[serde(rename = "access_token")]
    access_token_top: Option<String>,
}

#[derive(serde::Deserialize)]
struct CodexAuthTokens {
    access_token: Option<String>,
}

fn read_codex_access_token() -> Result<String, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "HOME/USERPROFILE 환경변수 없음".to_string())?;
    let path = std::path::Path::new(&home).join(".codex").join("auth.json");
    if !path.exists() {
        return Err(format!("auth.json 없음 ({}). codex login 먼저 필요.", path.display()));
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("auth.json 읽기 실패: {}", e))?;
    let parsed: CodexAuthFile = serde_json::from_str(&raw)
        .map_err(|e| format!("auth.json JSON 파싱 실패: {}", e))?;
    // 형식 변동성: 최상위 access_token 또는 tokens.access_token 둘 다 시도.
    parsed
        .tokens
        .and_then(|t| t.access_token)
        .or(parsed.access_token_top)
        .ok_or_else(|| "auth.json 안 access_token 없음".to_string())
}

/// Codex 의 5h+주간 한도 정보 가져오기.
/// 응답 raw JSON 그대로 반환 — frontend 가 normalize.
/// 실패 (네트워크, 401, parsing) 는 Err 로 — frontend 는 silently swallow.
#[tauri::command]
async fn codex_fetch_usage() -> Result<serde_json::Value, String> {
    let token = read_codex_access_token()?;
    let resp = reqwest::Client::new()
        .get("https://chatgpt.com/backend-api/codex/usage")
        .bearer_auth(&token)
        .header("User-Agent", "K-Desktop-Agent/0.4.6 (codex-usage-poll)")
        .send()
        .await
        .map_err(|e| format!("HTTP 요청 실패: {}", e))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("응답 읽기 실패: {}", e))?;
    if !status.is_success() {
        let snippet: String = body.chars().take(200).collect();
        return Err(format!(
            "HTTP {} — {} (codex login 만료됐을 수 있음)",
            status.as_u16(),
            snippet
        ));
    }
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("응답 JSON 파싱 실패: {}", e))?;
    log_lifecycle(
        "runtime.log",
        &format!(
            "codex_fetch_usage OK status={} bodyLen={}",
            status.as_u16(),
            body.len()
        ),
    );
    Ok(json)
}

/// `codex mcp add k-personal -- python <K-Personal-MCP/server.py>` 한 번 실행.
/// 이미 등록돼있으면 에러 — 그래도 무시 (idempotent).
#[tauri::command]
async fn codex_register_mcp(name: Option<String>) -> Result<String, String> {
    let mcp_name = name.unwrap_or_else(|| "k-personal".to_string());
    // K-Personal MCP server.py — release/dev 자동 분기 (Phase 19).
    // 옛 패턴: `project_root().parent()/K-Personal-MCP/server.py` 는 release 환경에서
    // project_root() 가 cwd (= C:\WINDOWS\system32) 로 fallback 시 잘못된 경로 만들어냄.
    let mcp_server = resolve_kpersonal_mcp_server()
        .map_err(|e| format!("K-Personal MCP server.py 없음: {}", e))?;
    let mcp_server_str = mcp_server.to_string_lossy().to_string();
    // Phase 23: Windows 콘솔 창 hide.
    let mut cmd = Command::new("cmd");
    cmd.args([
        "/c",
        "codex.cmd",
        "mcp",
        "add",
        &mcp_name,
        "--",
        "python",
        &mcp_server_str,
    ]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("codex mcp add spawn 실패: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() {
        Ok(format!("등록 성공: {} → {}", mcp_name, mcp_server_str))
    } else {
        // 이미 등록된 경우도 여기로 옴. stderr 메시지 그대로 반환 (UI 가 표시).
        Err(format!("codex mcp add 실패 (이미 등록됐을 수 있음): {} {}", stdout.trim(), stderr.trim()))
    }
}

// ────────── Resources (파일 감시) ──────────

/// 폴더 감시 시작
#[tauri::command]
async fn watch_folder(app: AppHandle, path: String, label: String) -> Result<String, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let folder_id = format!("folder_{}", uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("unknown"));
    let path_clone = path.clone();

    // 경로 유효성 검사
    let folder_path = PathBuf::from(&path);
    if !folder_path.exists() || !folder_path.is_dir() {
        return Err(format!("폴더가 존재하지 않습니다: {}", path));
    }

    // WatchedFolder 등록
    {
        let folders = get_watched_folders();
        let mut folders_guard = folders.write().await;
        folders_guard.insert(folder_id.clone(), WatchedFolder {
            path: path.clone(),
            label: label.clone(),
            created_count: 0,
            modified_count: 0,
            deleted_count: 0,
            last_event: None,
        });
    }

    // 파일 감시 시작 (별도 스레드)
    let app_handle = app.clone();
    let folder_id_clone = folder_id.clone();

    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();

        let mut debouncer = match new_debouncer(Duration::from_millis(500), tx) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[Resources] debouncer 생성 실패: {}", e);
                return;
            }
        };

        if let Err(e) = debouncer.watcher().watch(&folder_path, RecursiveMode::NonRecursive) {
            eprintln!("[Resources] 감시 시작 실패: {}", e);
            return;
        }

        println!("[Resources] 폴더 감시 시작: {}", path_clone);

        // 이벤트 처리 루프
        loop {
            match rx.recv() {
                Ok(Ok(events)) => {
                    for event in events {
                        let kind = match event.kind {
                            DebouncedEventKind::Any => "modified",
                            DebouncedEventKind::AnyContinuous => continue, // 연속 이벤트는 스킵
                            _ => continue, // non_exhaustive 대응: 알 수 없는 종류는 스킵
                        };

                        let timestamp = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0);

                        let file_event = FileChangeEvent {
                            folder_id: folder_id_clone.clone(),
                            path: event.path.to_string_lossy().to_string(),
                            kind: kind.to_string(),
                            timestamp,
                        };

                        // Frontend에 이벤트 전송
                        let _ = app_handle.emit("resource-change", &file_event);
                    }
                }
                Ok(Err(e)) => {
                    eprintln!("[Resources] 감시 에러: {:?}", e);
                }
                Err(_) => {
                    // 채널 닫힘 - 감시 종료
                    break;
                }
            }
        }
    });

    Ok(folder_id)
}

/// 감시 중인 폴더 목록 조회
#[tauri::command]
async fn get_watched_folders_list() -> Result<Vec<WatchedFolder>, String> {
    let folders = get_watched_folders();
    let folders_guard = folders.read().await;
    Ok(folders_guard.values().cloned().collect())
}

/// 폴더 감시 중지
#[tauri::command]
async fn unwatch_folder(folder_id: String) -> Result<(), String> {
    let folders = get_watched_folders();
    let mut folders_guard = folders.write().await;
    folders_guard.remove(&folder_id);
    Ok(())
}

// ────────── Sidecar spawning ──────────

async fn spawn_sidecar(app: AppHandle) -> Result<(), String> {
    // 새 spawn 이 시작되었다는 건 이전의 의도적 종료가 완료되었다는 뜻.
    INTENTIONAL_SHUTDOWN.store(false, Ordering::SeqCst);

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));

    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;

    let sidecar_dir = find_sidecar_dir(&cwd, exe_dir.as_deref())
        .ok_or("sidecar 디렉터리를 찾을 수 없습니다")?;

    let dev_entry = sidecar_dir.join("src").join("index.ts");
    let prod_entry = sidecar_dir.join("dist").join("index.js");

    // 빌드 모드에 따라 우선순위 반대로.
    // - debug 빌드(dev): dev_entry 우선 (tsx 로 소스 바로 실행 → 재시작 없이 수정 반영)
    // - release 빌드:    prod_entry 우선 (node 로 dist/index.js 직접 실행 → 빠르고 cmd 창 안 뜸)
    let prefer_prod = !cfg!(debug_assertions);
    let chosen = if prefer_prod {
        if prod_entry.exists() {
            Some((true, prod_entry.clone()))
        } else if dev_entry.exists() {
            Some((false, dev_entry.clone()))
        } else {
            None
        }
    } else {
        if dev_entry.exists() {
            Some((false, dev_entry.clone()))
        } else if prod_entry.exists() {
            Some((true, prod_entry.clone()))
        } else {
            None
        }
    };

    // 번들된 Node.js 경로 찾기 (release 모드에서 사용)
    let bundled_node = exe_dir.as_ref().and_then(|exe| {
        // 1) exe 옆에 node-bundle/node.exe
        let node1 = exe.join("node-bundle").join("node.exe");
        if node1.exists() {
            return Some(node1);
        }
        // 2) _up_/node-bundle/node.exe (Tauri 리소스 배치)
        let node2 = exe.join("_up_").join("node-bundle").join("node.exe");
        if node2.exists() {
            return Some(node2);
        }
        // 3) 부모 폴더에서 찾기
        if let Some(parent) = exe.parent() {
            let node3 = parent.join("node-bundle").join("node.exe");
            if node3.exists() {
                return Some(node3);
            }
        }
        None
    });

    let (cmd_name, args): (String, Vec<String>) = match chosen {
        Some((true, path)) => {
            // release 모드: 번들된 Node.js 우선 사용
            let node_cmd = if cfg!(windows) {
                bundled_node
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| "node.exe".to_string())
            } else {
                "node".to_string()
            };
            (node_cmd, vec![path.to_string_lossy().to_string()])
        },
        Some((false, path)) => (
            if cfg!(windows) { "npx.cmd".to_string() } else { "npx".to_string() },
            vec![
                "--yes".to_string(),
                "tsx".to_string(),
                path.to_string_lossy().to_string(),
            ],
        ),
        None => {
            return Err(format!(
                "sidecar 엔트리 없음: {} 또는 {}",
                dev_entry.display(),
                prod_entry.display()
            ));
        }
    };

    let spawn_msg = format!(
        "[sidecar] spawn cmd={} args={:?} cwd={}",
        cmd_name,
        args,
        sidecar_dir.display()
    );
    eprintln!("{}", spawn_msg);
    log_lifecycle("runtime.log", &spawn_msg);

    // Claude CLI 의 transcript 저장소는 cwd 기반으로 ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
    // 처럼 sharded 된다. 인앱 업데이트가 sidecar 의 설치 경로를 _up_/sidecar 로 옮기면 sharded
    // 폴더가 바뀌어 옛 session ID 의 --resume 이 "No conversation found" 로 즉사하는 사고가
    // v0.5.0→0.5.1 사이클에 발생 (pitfall_claude_cli_session_sharding.md). 사용자 홈 안에
    // 안정된 cwd 를 박아 어떤 버전이든 같은 sharded 폴더로 모이게 한다.
    let claude_cwd = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
        .map(|h| std::path::PathBuf::from(h).join(".kda").join("cwd"));
    let final_cwd: PathBuf = if let Some(p) = claude_cwd.as_ref() {
        match std::fs::create_dir_all(p) {
            Ok(_) => p.clone(),
            Err(e) => {
                log_lifecycle(
                    "runtime.log",
                    &format!("warn: claude_cwd 생성 실패 ({}) — sidecar_dir 폴백", e),
                );
                sidecar_dir.clone()
            }
        }
    } else {
        sidecar_dir.clone()
    };
    log_lifecycle(
        "runtime.log",
        &format!("[sidecar] claude_cwd (transcript shard) = {}", final_cwd.display()),
    );

    let mut command = Command::new(&cmd_name);
    command
        .args(&args)
        .current_dir(&final_cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Windows: 콘솔 창 숨기기 (CREATE_NO_WINDOW = 0x08000000).
    // 기본 spawn 은 npx.cmd/node.exe 실행 시 cmd 창이 깜빡이거나 남는다.
    #[cfg(target_os = "windows")]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("사이드카 기동 실패: {}", e))?;

    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let (tx, mut rx) = mpsc::channel::<String>(64);

    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if let Err(e) = stdin.write_all(line.as_bytes()).await {
                let m = format!("[sidecar] stdin write 실패: {}", e);
                eprintln!("{}", m);
                log_lifecycle("runtime.log", &m);
                break;
            }
            if let Err(e) = stdin.flush().await {
                let m = format!("[sidecar] stdin flush 실패: {}", e);
                eprintln!("{}", m);
                log_lifecycle("runtime.log", &m);
                break;
            }
        }
    });

    // stdout → Tauri 이벤트. 루프 종료 시 의도적 종료가 아니면 자동 재시작 시도.
    let app_for_stdout = app.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        let mut received_any = false;
        let exit_reason: String;
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => match serde_json::from_str::<serde_json::Value>(&line) {
                    Ok(v) => {
                        if !received_any {
                            // 첫 메시지 수신 = sidecar 정상 기동 신호. 재시작 카운터 리셋.
                            received_any = true;
                            RESTART_ATTEMPTS.store(0, Ordering::SeqCst);
                            log_lifecycle("sidecar.log", "sidecar first message received (healthy)");
                        }
                        let _ = app_for_stdout.emit("sidecar-event", v);
                    }
                    Err(e) => {
                        let m = format!("[sidecar] stdout JSON parse 실패: {} line={}", e, line);
                        eprintln!("{}", m);
                        log_lifecycle("runtime.log", &m);
                    }
                },
                Ok(None) => {
                    eprintln!("[sidecar] stdout EOF");
                    exit_reason = "stdout EOF".to_string();
                    break;
                }
                Err(e) => {
                    eprintln!("[sidecar] stdout read 실패: {}", e);
                    exit_reason = format!("stdout read error: {}", e);
                    break;
                }
            }
        }

        // 여기까지 왔다 = sidecar 프로세스 종료. 의도적 종료면 아무것도 안 함.
        if INTENTIONAL_SHUTDOWN.load(Ordering::SeqCst) {
            log_lifecycle("sidecar.log", &format!("sidecar stopped intentionally ({})", exit_reason));
            return;
        }

        // 비정상 종료 → 프론트에 알림 + 재시작 시도
        let attempt = RESTART_ATTEMPTS.fetch_add(1, Ordering::SeqCst) + 1;
        log_lifecycle(
            "sidecar.log",
            &format!("sidecar died ({}) — attempt #{}/{}", exit_reason, attempt, MAX_RESTART_ATTEMPTS),
        );
        let _ = app_for_stdout.emit(
            "sidecar-event",
            serde_json::json!({
                "type": "sidecar_died",
                "reason": exit_reason,
                "attempt": attempt,
                "max_attempts": MAX_RESTART_ATTEMPTS,
            }),
        );

        if attempt > MAX_RESTART_ATTEMPTS {
            log_lifecycle("sidecar.log", "max restart attempts exceeded — giving up");
            let _ = app_for_stdout.emit(
                "sidecar-event",
                serde_json::json!({
                    "type": "sidecar_permanent_failure",
                    "reason": "max restart attempts exceeded",
                    "attempts": attempt - 1,
                }),
            );
            return;
        }

        // Exponential backoff: 1s, 2s, 4s
        let delay_secs = 1u64 << (attempt - 1).min(5);
        log_lifecycle(
            "sidecar.log",
            &format!("requesting respawn in {}s (attempt #{})", delay_secs, attempt),
        );

        // supervisor 태스크에 요청만 전송 (재귀 회피 — spawn_sidecar 를 직접 await 하지 않음).
        if let Some(tx) = RESPAWN_TX.get() {
            let _ = tx.send(RespawnRequest { delay_secs, attempt });
        } else {
            log_lifecycle("sidecar.log", "respawn supervisor not initialized — cannot recover");
        }
    });

    // stderr → 콘솔 + logs/runtime.log (release 모드는 콘솔이 없어서 파일이 유일한 단서)
    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("[sidecar:stderr] {}", line);
            log_lifecycle("runtime.log", &format!("[sidecar:stderr] {}", line));
        }
    });

    // 저장
    {
        let child_holder = get_child_holder().clone();
        let mut guard = child_holder.lock().await;
        *guard = Some(child);
    }
    {
        let tx_holder = get_tx_holder().clone();
        let mut guard = tx_holder.lock().await;
        *guard = Some(tx);
    }

    // 1회성 자동 마이그레이션: 옛 sharded 폴더 (이전 버전의 sidecar cwd 들) 에 박힌 transcript
    // 들을 새 cwd 의 sharded 폴더로 머지. v0.5.1→0.5.2 사이클의 K 케이스 + 향후 어느 버전에서
    // 들어와도 한 번만 이주하면 끝나도록 sentinel 파일로 idempotent. background task — 첫 query
    // 가 sharded 폴더를 만들 시간을 주고 1.5초 후 실행.
    let migration_cwd = final_cwd.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        match migrate_legacy_claude_sessions(&migration_cwd).await {
            Ok(0) => {
                // nothing to do (이미 이주 완료 또는 옛 폴더 없음)
            }
            Ok(n) => {
                log_lifecycle(
                    "runtime.log",
                    &format!("[migration] claude session 이주 완료: {} files merged", n),
                );
            }
            Err(e) => {
                log_lifecycle(
                    "runtime.log",
                    &format!("[migration] claude session 이주 실패 (무시 가능): {}", e),
                );
            }
        }
    });

    Ok(())
}

/// 옛 ~/.claude/projects/<old-shard>/ 의 *.jsonl 들을 새 <new-shard>/ 로 1회성 머지.
///
/// `new_cwd` 는 sidecar 의 새 cwd (예: `~/.kda/cwd`). Claude CLI 가 한번 spawn 되면
/// `~/.claude/projects/<encoded-new-cwd>/` 폴더를 자동 생성한다. mtime 가장 최근 폴더를
/// 새 sharded 라고 추정하고, 같은 부모 디렉터리 안의 다른 `*K-Desktop-Agent*sidecar*` 패턴
/// 폴더들에서 jsonl 만 머지 (덮어쓰기 X — 같은 session ID 면 skip).
///
/// idempotent: 새 폴더에 `.kda-migrated` sentinel 박아 두 번 안 돈다.
async fn migrate_legacy_claude_sessions(new_cwd: &std::path::Path) -> Result<usize, String> {
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
        .ok_or("HOME/USERPROFILE 환경변수 없음")?;
    let projects_dir = std::path::PathBuf::from(home).join(".claude").join("projects");
    if !projects_dir.exists() {
        return Ok(0); // claude CLI 미사용 환경 — 이주할 것 없음
    }

    // new_cwd 의 expected sharded 폴더명 추측. Claude CLI 의 인코딩 룰을 정확히 모르므로
    // mtime 가장 최근 + new_cwd path 의 일부 토큰 포함 폴더로 fuzzy 매칭.
    let new_cwd_str = new_cwd.to_string_lossy().to_lowercase();
    let new_cwd_tokens: Vec<String> = new_cwd_str
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty() && s.len() >= 3)
        .map(|s| s.to_string())
        .collect();

    let mut entries: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
    for entry in std::fs::read_dir(&projects_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.path().is_dir() {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        entries.push((entry.path(), mtime));
    }
    entries.sort_by(|a, b| b.1.cmp(&a.1)); // 최신 순

    // 새 sharded 폴더 후보: new_cwd_tokens 중 ".kda" 또는 "cwd" 같은 토큰 모두 포함하면서
    // 가장 최근에 수정된 폴더. fallback: 그냥 가장 최근 폴더.
    let new_shard = entries.iter().find(|(p, _)| {
        let name = p.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
        new_cwd_tokens.iter().all(|tok| name.contains(tok))
    });
    let new_shard = match new_shard {
        Some((p, _)) => p.clone(),
        None => {
            // 새 폴더 아직 안 만들어짐 — 다음 spawn 까지 대기 (이번 round 는 skip)
            return Ok(0);
        }
    };

    let sentinel = new_shard.join(".kda-migrated");
    if sentinel.exists() {
        return Ok(0); // 이미 이주 완료
    }

    // 옛 sharded 폴더 후보: K-Desktop-Agent + sidecar 토큰 포함하는 다른 폴더들.
    let mut migrated = 0usize;
    for (old_path, _) in &entries {
        if *old_path == new_shard {
            continue;
        }
        let name = old_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        if !name.contains("k-desktop-agent") || !name.contains("sidecar") {
            continue;
        }
        // *.jsonl 머지 — 같은 파일명 있으면 skip (같은 session ID 라 의미적으로 동일)
        let read_iter = match std::fs::read_dir(old_path) {
            Ok(it) => it,
            Err(_) => continue,
        };
        for f in read_iter.flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let dst = new_shard.join(p.file_name().unwrap_or_default());
            if dst.exists() {
                continue;
            }
            if std::fs::copy(&p, &dst).is_ok() {
                migrated += 1;
            }
        }
    }

    // sentinel
    let _ = std::fs::write(&sentinel, b"migrated\n");
    Ok(migrated)
}

fn find_sidecar_dir(
    cwd: &std::path::Path,
    exe_dir: Option<&std::path::Path>,
) -> Option<std::path::PathBuf> {
    let mut current = Some(cwd);
    while let Some(p) = current {
        let candidate = p.join("sidecar");
        if candidate.join("src").join("index.ts").exists()
            || candidate.join("dist").join("index.js").exists()
        {
            return Some(candidate);
        }
        current = p.parent();
    }

    if let Some(exe) = exe_dir {
        // 1) exe 옆에 sidecar 폴더 (새 빌드)
        let candidate = exe.join("sidecar");
        if candidate.join("dist").join("index.js").exists()
            || candidate.join("src").join("index.ts").exists()
        {
            return Some(candidate);
        }
        // 2) exe 부모 폴더에 sidecar (이전 방식)
        if let Some(parent) = exe.parent() {
            let candidate2 = parent.join("sidecar");
            if candidate2.join("dist").join("index.js").exists()
                || candidate2.join("src").join("index.ts").exists()
            {
                return Some(candidate2);
            }
        }
        // 3) _up_/sidecar (Tauri 리소스 기본 배치)
        let candidate3 = exe.join("_up_").join("sidecar");
        if candidate3.join("dist").join("index.js").exists() {
            return Some(candidate3);
        }
    }

    None
}

// ────────── Tray setup ──────────

fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let reload_i = MenuItem::with_id(app, "reload", "Reload Sidecar", true, None::<&str>)?;
    let settings_i = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show_i, &reload_i, &settings_i, &sep, &quit_i])?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .tooltip("K Desktop Agent")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            "reload" => {
                let app_handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = reload_sidecar(app_handle.clone()).await {
                        eprintln!("reload failed: {}", e);
                    }
                });
            }
            "settings" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                    let _ = w.emit("open-settings", ());
                }
            }
            "quit" => {
                log_lifecycle("shutdown.log", "tray Quit menu clicked");
                INTENTIONAL_SHUTDOWN.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button,
                button_state,
                ..
            } = event
            {
                if button == MouseButton::Left && button_state == MouseButtonState::Up {
                    let app = tray.app_handle();
                    if let Some(w) = app.get_webview_window("main") {
                        if w.is_visible().unwrap_or(false) {
                            let _ = w.hide();
                        } else {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}

// ────────── Run ──────────

pub fn run() {
    run_with_options(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run_with_options(start_minimized: bool) {
    // 패닉 → logs/crash.log 에 기록. 기존 hook 도 유지해서 stderr 로도 계속 출력되게.
    let prev_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            format!("{:?}", info.payload())
        };
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".to_string());
        let backtrace = std::backtrace::Backtrace::force_capture();
        log_lifecycle(
            "crash.log",
            &format!("PANIC at {}\n  payload: {}\n  backtrace:\n{}", loc, payload, backtrace),
        );
        prev_hook(info);
    }));

    log_lifecycle("shutdown.log", "app starting");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 이미 실행 중일 때 다시 실행되면 기존 창을 포커스
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .setup(move |app| {
            let handle = app.handle().clone();

            // Tray
            if let Err(e) = setup_tray(&handle) {
                eprintln!("tray setup failed: {}", e);
            }

            // 창 X 버튼 → 숨김으로 변경
            if let Some(main_window) = app.get_webview_window("main") {
                let win_handle = main_window.clone();
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        log_lifecycle("shutdown.log", "window X clicked — hiding to tray (not exiting)");
                        api.prevent_close();
                        let _ = win_handle.hide();
                    }
                });

                // --minimized 플래그 시 시작부터 숨김
                if start_minimized {
                    let _ = main_window.hide();
                }
            }

            #[cfg(debug_assertions)]
            {
                // 개발 중에만, 그리고 명시적으로 원할 때만 DevTools 자동 오픈
                if std::env::var("KDA_OPEN_DEVTOOLS").is_ok() {
                    if let Some(window) = app.get_webview_window("main") {
                        window.open_devtools();
                    }
                }
            }

            // Supervisor 태스크: 재시작 요청을 받아 spawn_sidecar 를 호출.
            // 이 태스크가 중앙화된 재시작 경로라서 spawn_sidecar 내부가 자기 자신을 재귀 호출하지 않아도 됨.
            let (respawn_tx, mut respawn_rx) = mpsc::unbounded_channel::<RespawnRequest>();
            if RESPAWN_TX.set(respawn_tx).is_err() {
                eprintln!("RESPAWN_TX 이미 설정됨 (중복 초기화?)");
            }
            let sup_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(req) = respawn_rx.recv().await {
                    if INTENTIONAL_SHUTDOWN.load(Ordering::SeqCst) {
                        log_lifecycle("sidecar.log", "supervisor: intentional shutdown — skip respawn");
                        continue;
                    }
                    tokio::time::sleep(Duration::from_secs(req.delay_secs)).await;
                    log_lifecycle(
                        "sidecar.log",
                        &format!("supervisor respawning (attempt #{})", req.attempt),
                    );
                    if let Err(e) = spawn_sidecar(sup_handle.clone()).await {
                        log_lifecycle("sidecar.log", &format!("supervisor respawn failed: {}", e));
                        let _ = sup_handle.emit(
                            "sidecar-event",
                            serde_json::json!({
                                "type": "sidecar_died",
                                "reason": format!("respawn failed: {}", e),
                                "attempt": req.attempt,
                                "max_attempts": MAX_RESTART_ATTEMPTS,
                            }),
                        );
                    }
                }
            });

            // 초기 sidecar 기동
            tauri::async_runtime::spawn(async move {
                if let Err(e) = spawn_sidecar(handle.clone()).await {
                    let _ = handle.emit(
                        "sidecar-event",
                        serde_json::json!({
                            "type": "error",
                            "message": format!("sidecar 기동 실패: {}", e),
                        }),
                    );
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            send_message,
            interrupt,
            reload_sidecar,
            ping_sidecar,
            elicitation_response,
            show_main_window,
            hide_main_window,
            quit_app,
            run_claude_login,
            // Safety net (백업/복구) — Settings UI 의 안전장치 섹션이 사용
            get_latest_backup,
            list_backups,
            backup_now,
            rollback_now,
            // Phase 15 — 외부 webview 창 + Codex 통합
            open_external_webview,
            codex_login,
            codex_login_status,
            codex_register_mcp,
            codex_fetch_usage,
            // Phase 18 — 의존성 자동 셋업 + First-run 마법사
            is_first_run,
            mark_first_run_complete,
            check_dependencies,
            run_install_deps,
            // Resources (파일 감시)
            watch_folder,
            get_watched_folders_list,
            unwatch_folder
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| match event {
            RunEvent::ExitRequested { .. } => {
                log_lifecycle("shutdown.log", "RunEvent::ExitRequested");
            }
            RunEvent::Exit => {
                log_lifecycle("shutdown.log", "RunEvent::Exit (process terminating)");
            }
            _ => {}
        });
}
