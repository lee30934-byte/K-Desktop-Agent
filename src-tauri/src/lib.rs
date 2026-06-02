use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
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
/// sidecar heartbeat/stdout event watchdog. Sidecar emits heartbeat events even when idle.
static LAST_SIDECAR_EVENT_SECS: AtomicU64 = AtomicU64::new(0);
static LAST_SIDECAR_SPAWN_SECS: AtomicU64 = AtomicU64::new(0);
const SIDECAR_WATCHDOG_INTERVAL_SECS: u64 = 30;
const SIDECAR_STARTUP_GRACE_SECS: u64 = 60;
const SIDECAR_HEARTBEAT_TIMEOUT_SECS: u64 = 120;

fn epoch_secs() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
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

// ────────── Phase 25 (v0.5.11): portable data root ──────────
//
// K 의 요구: "설치 경로 + DB 도 같은 드라이브" — 진짜 portable.
//
// 설계:
//   - `<install_dir>\data-pointer.txt` 에 데이터 폴더의 절대 경로 한 줄 박음 (UTF-8, no BOM).
//   - 인스톨러가 default 로 `<install_dir>\..\data` 박지만 K 가 Settings 에서 변경 가능.
//   - pointer 파일이 없거나 깨졌으면 `~/.kda` 폴백 (이전 v0.5.10 동작 유지 — 회귀 안전).
//
// 이 helper 가 모든 path 의 single source of truth:
//   data_root()/cwd                       → sidecar cwd (Claude session sharding 안정용)
//   data_root()/.backups                  → 백업
//   data_root()/logs                      → 런타임 로그
//   data_root()/conversations.db          → SQLite DB
//   data_root()/first-run-completed.flag  → 첫 실행 sentinel

/// install 디렉토리 (current_exe 부모). dev 환경에선 target/debug 같은 곳.
fn install_dir() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf()))
}

/// install 폴더 옆의 data-pointer.txt 경로. 인스톨러도 같은 위치를 알아야 한다.
fn data_pointer_path() -> Option<PathBuf> {
    install_dir().map(|d| d.join("data-pointer.txt"))
}

/// 데이터 폴더 (포인터 → 폴백). pure function — side effect 없음.
/// 후속 호출자가 create_dir_all 직접 함.
fn data_root() -> PathBuf {
    // 1순위: data-pointer.txt
    if let Some(pointer) = data_pointer_path() {
        if let Ok(raw) = std::fs::read_to_string(&pointer) {
            // BOM strip + trim — `pitfall_powershell_secret_bom` 함정 방어
            let trimmed = strip_bom(&raw).trim().to_string();
            if !trimmed.is_empty() {
                let p = PathBuf::from(&trimmed);
                // 절대 경로만 인정 (상대 경로는 cwd 가 다르면 깨짐)
                if p.is_absolute() {
                    return p;
                }
            }
        }
    }
    // 2순위: ~/.kda (옛 default — 회귀 안전망)
    if let Ok(home) = std::env::var("USERPROFILE") {
        return PathBuf::from(home).join(".kda");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".kda");
    }
    // 3순위: cwd 의 .kda (마지막 fallback)
    PathBuf::from(".kda")
}

/// 데이터 폴더가 존재하지 않으면 생성. 초기 부트 + 마이그레이션 후 호출.
fn ensure_data_root() -> Result<PathBuf, String> {
    let root = data_root();
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("data root 생성 실패 ({}): {}", root.display(), e))?;
    Ok(root)
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
    // Phase 84 (v0.6.27) — Connector/Tool Safety Layer (Lee #6).
    // "off" | "balanced" | "strict". sidecar 가 위험도 high+ 카테고리를 자동 강등.
    // None / 미지정 → sidecar 가 "off" 로 가정 (백 호환).
    safe_mode: Option<String>,
    // 첨부 파일: [{name, type, size, base64}]
    // sidecar 가 임시 폴더에 디코드해 파일로 저장 후 Claude CLI 에 path 로 안내.
    // Claude CLI 의 Read 도구가 path 를 받아 이미지면 vision, 텍스트면 그대로 처리.
    // None / 빈 배열 → 첨부 없음.
    attachments: Option<serde_json::Value>,
    // Phase 107 (v0.6.56) — 폴더 프로젝트 지침 (활성 conv 의 folder.system_prompt).
    // App.tsx 가 매 turn 보내고 sidecar 가 시스템 프롬프트에 prepend.
    folder_system_prompt: Option<String>,
    // Phase 107 — 폴더 첨부 reference (절대 경로). 새 대화 첫 message 일 때만 박힘.
    // sidecar 는 path 를 prompt 의 "참고 파일" 블록에 안내. Claude CLI 가 Read 로 읽음.
    folder_attachment_paths: Option<Vec<String>>,
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
    // Phase 84 — SafeMode (sidecar 는 safeMode 키로 읽음)
    if let Some(sm) = safe_mode {
        let s = sm.trim();
        if s == "off" || s == "balanced" || s == "strict" {
            payload["safeMode"] = serde_json::Value::String(s.to_string());
        }
    }
    // 첨부 파일 (sidecar 가 임시 파일로 저장 후 prompt 에 path 안내 추가)
    if let Some(att) = attachments {
        payload["attachments"] = att;
    }
    // Phase 107 (v0.6.56) — 폴더 프로젝트 지침 + 첨부 reference 전달.
    if let Some(prompt) = folder_system_prompt {
        let trimmed = prompt.trim();
        if !trimmed.is_empty() {
            payload["folderSystemPrompt"] = serde_json::Value::String(trimmed.to_string());
        }
    }
    if let Some(paths) = folder_attachment_paths {
        if !paths.is_empty() {
            payload["folderAttachmentPaths"] = serde_json::json!(paths);
        }
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

// Phase 69 (v0.6.13) — frontend 가 sidecar.log 에 진단 메시지를 박을 path.
//
// Settings.tsx 의 mcp_tools listener / 다른 React component 가 invoke("frontend_log", { message })
// 호출 → 이 command 가 그대로 sidecar.log 에 `[frontend] ...` 라인 박음. K 가 "frontend 가 진짜
// listener 등록했나? 진짜 event 받았나?" 같은 질문을 sidecar.log grep 한 번으로 확정.
//
// 옛 frontend 가 이 command 호출 시도해도 unknown command 로 fail — 호출자가 .catch(() => {}) 로
// silently swallow. backward compat 보장.
#[tauri::command]
fn frontend_log(message: String) -> Result<(), String> {
    log_lifecycle("sidecar.log", &format!("[frontend] {}", message));
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

// ─── Phase 87 (v0.6.30) — Git Memory Sync Tauri commands ──────────────
//
// 모두 sidecar stdin 으로 JSON 라인 흘리는 thin wrapper.
// PAT 는 git_sync_store_credential 의 인자로만 sidecar 에 전달 — Rust 측에도 저장 X.
// sidecar 가 git credential helper (Windows Credential Manager) 에 박은 뒤
// 그 다음 호출부터는 git 이 알아서 사용.

async fn send_to_sidecar(payload: serde_json::Value) -> Result<(), String> {
    let line = format!("{}\n", payload);
    let tx_holder = get_tx_holder().clone();
    let guard = tx_holder.lock().await;
    let tx = guard.as_ref().ok_or("sidecar not initialized")?;
    tx.send(line).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn git_sync_store_credential(
    repo_url: String,
    pat: String,
    username: Option<String>,
) -> Result<(), String> {
    send_to_sidecar(serde_json::json!({
        "type": "git_sync_store_credential",
        "repoUrl": repo_url,
        "pat": pat,
        "username": username.unwrap_or_else(|| "x-access-token".to_string()),
    }))
    .await
}

#[tauri::command]
async fn git_sync_config_update(
    enabled: Option<bool>,
    repo_url: Option<String>,
    team_repo_url: Option<String>,
    interval_ms: Option<u64>,
) -> Result<(), String> {
    let mut payload = serde_json::json!({ "type": "git_sync_config_update" });
    if let Some(e) = enabled {
        payload["enabled"] = serde_json::Value::Bool(e);
    }
    if let Some(u) = repo_url {
        payload["repoUrl"] = serde_json::Value::String(u);
    }
    if let Some(u) = team_repo_url {
        payload["teamRepoUrl"] = serde_json::Value::String(u);
    }
    if let Some(ms) = interval_ms {
        payload["intervalMs"] = serde_json::Value::Number(ms.into());
    }
    send_to_sidecar(payload).await
}

#[tauri::command]
async fn git_sync_now() -> Result<(), String> {
    send_to_sidecar(serde_json::json!({ "type": "git_sync_now" })).await
}

#[tauri::command]
async fn git_sync_resolve_conflict(keep: String, target: Option<String>) -> Result<(), String> {
    if keep != "local" && keep != "remote" {
        return Err(format!("invalid keep side: {}", keep));
    }
    // Phase 89 — target: "personal" | "team". 미지정 시 "personal" (백 호환).
    let t = target.unwrap_or_else(|| "personal".to_string());
    if t != "personal" && t != "team" {
        return Err(format!("invalid target kind: {} (personal/team 만 허용)", t));
    }
    send_to_sidecar(serde_json::json!({
        "type": "git_sync_resolve_conflict",
        "keep": keep,
        "target": t,
    }))
    .await
}

#[tauri::command]
async fn git_sync_status_request() -> Result<(), String> {
    send_to_sidecar(serde_json::json!({ "type": "git_sync_status_request" })).await
}

#[tauri::command]
async fn git_sync_log_request(target: String, limit: Option<u32>) -> Result<(), String> {
    if target != "personal" && target != "team" {
        return Err(format!("invalid target kind: {}", target));
    }
    let mut payload = serde_json::json!({
        "type": "git_sync_log_request",
        "target": target,
    });
    if let Some(n) = limit {
        payload["limit"] = serde_json::Value::Number(n.into());
    }
    send_to_sidecar(payload).await
}

// ─── Phase 90 (v0.6.32) — SafeMode 주간 통계 ──────────────

#[tauri::command]
async fn safety_stats_request() -> Result<(), String> {
    send_to_sidecar(serde_json::json!({ "type": "safety_stats_request" })).await
}

#[tauri::command]
async fn safety_stats_reset() -> Result<(), String> {
    send_to_sidecar(serde_json::json!({ "type": "safety_stats_reset" })).await
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
///   2. `~/Documents/K-Personal-MCP/server.py` (K 의 평소 위치 — 실제 personal.db 가 사는 곳)
///   3. `~/K-Personal-MCP/server.py`
///   4. Phase 26 (v0.5.13): `<install_dir>/bundled-mcp/server.py` (KDA 가 setup.exe 에 번들로 박은 fallback)
///   5. project_root().parent()/K-Personal-MCP/server.py (dev 환경의 sibling 폴더)
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
    // Phase 26: install_dir 의 bundled-mcp 도 후보 (Tauri resource_dir 다중 layout 시도)
    if let Some(install) = install_dir() {
        let candidates = [
            install.join("bundled-mcp").join("server.py"),
            install.join("resources").join("bundled-mcp").join("server.py"),
            install.join("resources").join("_up_").join("bundled-mcp").join("server.py"),
            install.join("_up_").join("bundled-mcp").join("server.py"),
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
    Err("K-Personal MCP server.py 못 찾음 (USERPROFILE/Documents · ~ · install_dir/bundled-mcp · dev sibling 모두 없음)".into())
}

/// Phase 26 (v0.5.13): 새 PC 의 K 가 setup.exe 깐 직후 ~/Documents/K-Personal-MCP/ 가 없으면
/// install_dir 의 bundled-mcp 를 자동 복사해 K 가 [K-Personal MCP 등록] 클릭 한 번으로
/// 모든 도구 작동하게 해준다. K 의 본 PC 에선 이미 폴더 있어 skip.
///
/// data/personal.db 는 새로 빈 SQLite 가 생기는 게 정상 — K-Personal-MCP 의 personal_db.py
/// 가 첫 호출 시 자동 schema 생성. K 의 옛 데이터가 있으면 ~/Documents/K-Personal-MCP/ 가
/// 이미 있어 이 함수는 skip 됨 (조건 검사 첫 줄).
fn deploy_bundled_mcp_if_needed() {
    // 옛 폴더 이미 있으면 보존 — K 의 todos/notes/habits 그대로
    let target_root = match std::env::var("USERPROFILE").ok() {
        Some(h) => PathBuf::from(&h).join("Documents").join("K-Personal-MCP"),
        None => return,
    };
    if target_root.exists() {
        return;
    }
    // install_dir 의 bundled-mcp 후보 다중 시도
    let install = match install_dir() {
        Some(p) => p,
        None => return,
    };
    let bundled_candidates = [
        install.join("bundled-mcp"),
        install.join("resources").join("bundled-mcp"),
        install.join("resources").join("_up_").join("bundled-mcp"),
        install.join("_up_").join("bundled-mcp"),
    ];
    let bundled = match bundled_candidates.iter().find(|p| p.join("server.py").exists()) {
        Some(p) => p.clone(),
        None => {
            log_lifecycle(
                "runtime.log",
                "deploy_bundled_mcp_if_needed: bundled-mcp 못 찾음 — skip (dev/legacy 빌드)",
            );
            return;
        }
    };
    log_lifecycle(
        "runtime.log",
        &format!(
            "deploy_bundled_mcp_if_needed: copying {} → {}",
            bundled.display(),
            target_root.display()
        ),
    );
    if let Err(e) = copy_dir_recursive(&bundled, &target_root) {
        log_lifecycle(
            "runtime.log",
            &format!("warn: bundled-mcp 복사 실패: {}", e),
        );
        return;
    }
    // data/ 빈 폴더 생성 (personal.db 는 첫 호출 시 K-Personal-MCP 가 자동 생성)
    let _ = std::fs::create_dir_all(target_root.join("data"));
    log_lifecycle(
        "runtime.log",
        &format!("bundled-mcp deployed to {}", target_root.display()),
    );
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
    // Phase 25 (v0.5.11): 백업은 데이터에 속함 → data_root().
    let root = data_root();
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
    let root = data_root();
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
    let data_root_str = ensure_data_root().unwrap_or_else(|_| data_root()).display().to_string();
    // Phase 23: Windows 콘솔 창 깜빡임 hide.
    // Phase 25 (v0.5.11): -DataRoot 인자 추가 — backup.ps1 가 portable data root 안에서 백업/DB 찾음.
    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script.to_str().unwrap(),
        "-Label",
        &label_arg,
        "-DataRoot",
        &data_root_str,
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
    // Phase 25 (v0.5.11): data_root() 로 일원화 — 옛 ~/.kda 경로도 data_root() 기본 fallback 이라 회귀 안전.
    Ok(data_root().join("first-run-completed.flag"))
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
            .map_err(|e| format!("data root 폴더 생성 실패: {}", e))?;
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

// ────────── Phase 25 (v0.5.11) — Portable data dir ──────────
//
// data-pointer.txt 를 통해 K 가 데이터 폴더를 자유롭게 선택하게 한다.
// 마이그레이션은 모든 데이터 (DB / .backups / cwd / logs / sentinel) 를 통째로 이동.

#[derive(serde::Serialize)]
struct DataDirInfo {
    /// 현재 데이터 폴더 절대 경로
    data_root: String,
    /// install_dir/data-pointer.txt 절대 경로 (없을 수 있음)
    pointer_path: Option<String>,
    /// pointer 파일 존재 여부 (없으면 fallback 동작 중)
    pointer_exists: bool,
    /// install 디렉토리 절대 경로
    install_dir: Option<String>,
    /// 추천 default 데이터 폴더 (install_dir/../data) — UI 가 [기본값으로] 버튼에 사용
    default_data_dir: Option<String>,
    /// 데이터 폴더 자체가 실제 존재하는지
    data_root_exists: bool,
    /// SQLite DB 경로 (data_root/conversations.db)
    db_path: String,
    /// DB 파일 존재 여부
    db_exists: bool,
}

fn default_data_dir_for(install: &PathBuf) -> PathBuf {
    install.parent().map(|p| p.join("data")).unwrap_or_else(|| install.join("data"))
}

#[tauri::command]
fn get_data_dir_info() -> Result<DataDirInfo, String> {
    let install = install_dir();
    let pointer = data_pointer_path();
    let root = data_root();
    let db = root.join("conversations.db");
    Ok(DataDirInfo {
        data_root: root.display().to_string(),
        pointer_path: pointer.as_ref().map(|p| p.display().to_string()),
        pointer_exists: pointer.as_ref().map(|p| p.exists()).unwrap_or(false),
        install_dir: install.as_ref().map(|p| p.display().to_string()),
        default_data_dir: install.as_ref().map(|p| default_data_dir_for(p).display().to_string()),
        data_root_exists: root.exists(),
        db_path: db.display().to_string(),
        db_exists: db.exists(),
    })
}

/// 데이터 폴더 변경. 옵션으로 기존 데이터 마이그레이션.
///
/// 흐름:
///   1. new_path 검증 (절대 경로, 존재 가능, write 가능)
///   2. migrate=true 면 옛 data_root() 의 모든 항목을 new_path 로 복사
///      (DB 는 SQLite WAL 때문에 K 가 KDA 재시작해야 lock 해제됨 → 옛 DB 삭제는 안 함)
///   3. data-pointer.txt 갱신 (UTF-8 no BOM)
///   4. K 가 KDA 재시작 시 new_path 가 data_root() 가 됨
///
/// 안전장치:
///   - new_path 가 install_dir 자체이면 거부 (인앱 updater 가 install_dir 정리 시 데이터 삭제 위험)
///   - new_path 부모가 read-only (Program Files 등) 면 경고만 띄우고 K 가 결정
///   - 마이그레이션 도중 에러 — 옛 데이터는 그대로 두고 pointer 갱신 안 함 (회귀 안전)
#[tauri::command]
fn change_data_dir(new_path: String, migrate: bool) -> Result<DataDirInfo, String> {
    let new_root = PathBuf::from(&new_path);
    if !new_root.is_absolute() {
        return Err(format!("절대 경로만 허용 (받은 값: {})", new_path));
    }
    // install_dir 안에 직접 박는 건 위험 (updater 가 _up_/ 정리 중에 실수로 청소될 수 있음)
    if let Some(install) = install_dir() {
        if new_root == install {
            return Err("install 폴더 자체는 데이터 폴더로 사용 불가 (인앱 update 시 손실 위험)".to_string());
        }
    }
    let pointer = data_pointer_path()
        .ok_or_else(|| "install_dir 못 찾음 — data-pointer.txt 위치 결정 불가".to_string())?;

    // 1. 새 폴더 생성
    std::fs::create_dir_all(&new_root)
        .map_err(|e| format!("새 데이터 폴더 생성 실패 ({}): {}", new_root.display(), e))?;

    // 2. 마이그레이션 (옛 → 새)
    let old_root = data_root();
    if migrate && old_root != new_root && old_root.exists() {
        log_lifecycle(
            "runtime.log",
            &format!("data dir migration: {} → {}", old_root.display(), new_root.display()),
        );
        copy_dir_recursive(&old_root, &new_root)
            .map_err(|e| format!("마이그레이션 실패 ({}): {} — pointer 갱신 안 함", e, old_root.display()))?;
    }

    // 3. pointer 파일 갱신 (UTF-8 no BOM)
    let pointer_content = new_root.display().to_string();
    if let Some(parent) = pointer.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("pointer 폴더 생성 실패: {}", e))?;
    }
    std::fs::write(&pointer, pointer_content.as_bytes())
        .map_err(|e| format!("data-pointer.txt 작성 실패 ({}): {}", pointer.display(), e))?;
    log_lifecycle(
        "runtime.log",
        &format!("data-pointer.txt updated → {}", new_root.display()),
    );

    // 4. 새 정보 반환 (UI 가 즉시 갱신)
    get_data_dir_info()
}

/// 옛 K 의 SQLite DB (%APPDATA%\com.k.desktop-agent\conversations.db*) 가 새 data_root()
/// 에 없으면 자동 복사. v0.5.10 → v0.5.11 update 시 K 의 대화 보존.
/// 이미 새 위치에 있으면 skip (idempotent).
fn migrate_legacy_db_if_needed() {
    let new_root = data_root();
    let new_db = new_root.join("conversations.db");
    if new_db.exists() {
        return; // 이미 마이그레이션됨
    }
    let appdata = match std::env::var("APPDATA") {
        Ok(v) => v,
        Err(_) => return,
    };
    let legacy_dir = PathBuf::from(appdata).join("com.k.desktop-agent");
    let legacy_db = legacy_dir.join("conversations.db");
    if !legacy_db.exists() {
        return; // 옛 DB 도 없음 — fresh install
    }
    if let Err(e) = std::fs::create_dir_all(&new_root) {
        log_lifecycle("runtime.log", &format!("warn: data_root 생성 실패 (legacy migration): {}", e));
        return;
    }
    let mut moved = 0u32;
    for name in &["conversations.db", "conversations.db-shm", "conversations.db-wal"] {
        let src = legacy_dir.join(name);
        let dst = new_root.join(name);
        if src.exists() && !dst.exists() {
            match std::fs::copy(&src, &dst) {
                Ok(_) => { moved += 1; }
                Err(e) => log_lifecycle(
                    "runtime.log",
                    &format!("warn: legacy db copy 실패 {} → {}: {}", src.display(), dst.display(), e),
                ),
            }
        }
    }
    log_lifecycle(
        "runtime.log",
        &format!("legacy db migration: {} files copied to {}", moved, new_root.display()),
    );
}

/// 옛 데이터 폴더 → 새 데이터 폴더 재귀 복사. 같은 파일 있으면 skip (idempotent).
/// SQLite WAL/SHM 같은 lock 잡힌 파일은 fail 시 skip 하고 진행 (K 가 재시작 후 자연스럽게 처리).
fn copy_dir_recursive(src: &PathBuf, dst: &PathBuf) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let s = entry.path();
        let d = dst.join(entry.file_name());
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_dir() {
            copy_dir_recursive(&s, &d)?;
        } else if ft.is_file() {
            // 이미 있으면 skip (재실행 안전)
            if d.exists() {
                continue;
            }
            // SQLite WAL/SHM lock 가능 — fail 해도 다음 파일로 진행
            if let Err(e) = std::fs::copy(&s, &d) {
                log_lifecycle(
                    "runtime.log",
                    &format!("warn: copy skip {} ({})", s.display(), e),
                );
            }
        }
    }
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
    let code = output.status.code().unwrap_or(-1);
    // Phase 24 (v0.5.10): stdout 에 valid JSON 이 있으면 exit code 무관하게 그대로 반환.
    // PS 스크립트는 fatal 시에도 (winget 없음 등) JSON 결과를 stdout 에 박으므로 UI 가
    // missing[] / fatal 필드 보고 의미있는 메시지를 렌더할 수 있음.
    // exit=2 만 stderr 만 보고 fatal 처리하던 옛 로직은 stdout 이 풍부할 때 손실 큼.
    if !stdout_trimmed.is_empty() && stdout_trimmed.starts_with('{') {
        log_lifecycle(
            "runtime.log",
            &format!(
                "install-deps.ps1 done exit={} stdout_len={} stderr_len={}",
                code,
                stdout_trimmed.len(),
                stderr.len()
            ),
        );
        return Ok(stdout_trimmed.to_string());
    }
    // stdout 비어있거나 JSON 아님 → 진짜 fatal. stderr 가 깨졌어도 일단 그대로 보고.
    Err(format!(
        "install-deps.ps1 실행 실패 (exit={}, stdout 비어있음) — stderr: {}",
        code,
        stderr.trim()
    ))
}

#[tauri::command]
async fn check_dependencies() -> Result<String, String> {
    run_install_deps_internal(true).await
}

#[tauri::command]
async fn run_install_deps() -> Result<String, String> {
    run_install_deps_internal(false).await
}

// ────────── Phase 66 (v0.6.1) — K-Personal MCP 자동 설치 ──────────
//
// K 가 다른 PC 에서도 KDA + MCP 도구 (ui_*, web_*, fm_*, app_*, clip_*, db_*, cc_*) 를
// 한 클릭으로 셋업. Settings UI 의 "MCP 도구 자동 설치" 버튼이 이 command 호출.
//
// 패턴은 run_install_deps_internal 과 동일 — scripts/install-kpersonal-mcp.ps1 을
// powershell.exe -AsJson 으로 실행 + CREATE_NO_WINDOW 로 콘솔 깜빡임 방지.

async fn install_kpersonal_mcp_internal(dry_run: bool) -> Result<String, String> {
    log_lifecycle(
        "runtime.log",
        &format!("install_kpersonal_mcp invoked dry_run={}", dry_run),
    );
    let script = resolve_script_path("install-kpersonal-mcp.ps1")
        .map_err(|e| format!("install-kpersonal-mcp script 없음: {}", e))?;
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
        .map_err(|e| format!("install-kpersonal-mcp.ps1 실행 실패: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stdout_trimmed = stdout.trim();
    let stderr = String::from_utf8_lossy(&output.stderr);
    let code = output.status.code().unwrap_or(-1);
    if !stdout_trimmed.is_empty() && stdout_trimmed.starts_with('{') {
        log_lifecycle(
            "runtime.log",
            &format!(
                "install-kpersonal-mcp.ps1 done exit={} stdout_len={} stderr_len={}",
                code,
                stdout_trimmed.len(),
                stderr.len()
            ),
        );
        return Ok(stdout_trimmed.to_string());
    }
    Err(format!(
        "install-kpersonal-mcp.ps1 실행 실패 (exit={}, stdout 비어있음) — stderr: {}",
        code,
        stderr.trim()
    ))
}

#[tauri::command]
async fn check_kpersonal_mcp() -> Result<String, String> {
    install_kpersonal_mcp_internal(true).await
}

#[tauri::command]
async fn install_kpersonal_mcp() -> Result<String, String> {
    install_kpersonal_mcp_internal(false).await
}

// ────────── Phase 67a (v0.6.2) — MCP 도구 인스펙터 ──────────
//
// Settings 의 "MCP 도구" 탭이 이 command 호출 → sidecar stdin 에 list_mcp_tools 메시지 흘림.
// sidecar 가 mcp_tools event 로 응답 (frontend 가 listen 으로 받음). ping_sidecar 와 동일 패턴.

#[tauri::command]
async fn list_mcp_tools(refresh: Option<bool>) -> Result<(), String> {
    let payload = serde_json::json!({
        "type": "list_mcp_tools",
        "refresh": refresh.unwrap_or(false),
    });
    let line = format!("{}\n", payload);
    let tx_holder = get_tx_holder().clone();
    let guard = tx_holder.lock().await;
    let tx = guard.as_ref().ok_or("sidecar not initialized")?;
    tx.send(line).await.map_err(|e| e.to_string())?;
    Ok(())
}

// ────────── Phase 67c (v0.6.2) — KDA 커스텀 도구 plugin 관리 ──────────
//
// K 가 Settings 의 "새 도구 만들기" 로 박는 커스텀 도구는 K-Personal-MCP/modules/kda_plugins/
// 디렉토리에 *.py 로 저장. server.py 의 plugin loader (별도 K-Personal-MCP PR) 가 자동 import +
// get_tools() / handle_tool(name, args) prefix 라우팅.
//
// 모든 커스텀 도구는 "kda_" prefix 강제 — 표준 도구 (cc_/fm_/db_/...) 와 namespace 충돌 방지.
// 또한 K-Personal-MCP repo 의 git tracked 파일을 KDA 가 직접 박지 않게 함 (modules/kda_plugins/
// 디렉토리는 .gitignore 또는 untracked — K-Personal-MCP push 측에서 보장).

fn resolve_kpersonal_plugins_dir() -> Result<std::path::PathBuf, String> {
    // sidecar 의 resolveKPersonalPath 와 같은 우선순위.
    // Phase 66.7 (v0.6.8): OneDrive redirect 함정 + cache 파일 우선 fix.
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "USERPROFILE/HOME 없음".to_string())?;
    let home_pb = std::path::PathBuf::from(&home);

    // 1. install-kpersonal-mcp.ps1 가 박은 cache 파일 우선 (KnownFolder API 정공법 결과)
    let cache_path = home_pb.join(".kda").join("kpersonal-mcp-path.txt");
    if cache_path.exists() {
        if let Ok(raw) = std::fs::read_to_string(&cache_path) {
            // BOM strip
            let stripped: &str = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
            let first_line = stripped.lines().next().unwrap_or("").trim();
            if !first_line.is_empty() {
                let target = std::path::PathBuf::from(first_line);
                if target.join("server.py").exists() {
                    return Ok(target.join("modules").join("kda_plugins"));
                }
            }
        }
    }

    // 2. candidates (OneDrive redirect 변형 포함)
    let candidates = [
        home_pb.join("Documents").join("K-Personal-MCP"),
        home_pb.join("OneDrive").join("Documents").join("K-Personal-MCP"),
        home_pb.join("OneDrive").join("문서").join("K-Personal-MCP"),
        home_pb.join("K-Personal-MCP"),
    ];
    for base in &candidates {
        if base.join("server.py").exists() {
            return Ok(base.join("modules").join("kda_plugins"));
        }
    }
    Err("K-Personal-MCP 가 설치되지 않았습니다. Settings → 'MCP 도구 자동 설치' 먼저.".into())
}

fn validate_kda_plugin_name(name: &str) -> Result<(), String> {
    if !name.starts_with("kda_") {
        return Err("plugin 이름은 'kda_' 로 시작해야 합니다 (namespace 충돌 회피)".into());
    }
    if name.len() < 5 || name.len() > 64 {
        return Err("plugin 이름은 5~64자".into());
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("plugin 이름은 ASCII 영문/숫자/언더스코어만".into());
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct KdaPluginInfo {
    file: String,
    size: u64,
    modified_ms: u128,
}

#[tauri::command]
async fn list_kda_plugins() -> Result<Vec<KdaPluginInfo>, String> {
    let dir = match resolve_kpersonal_plugins_dir() {
        Ok(d) => d,
        // 디렉토리가 없는 상태 = plugin 0 개 — 정상 케이스 (K-Personal-MCP 미설치 포함). 빈 list 반환.
        Err(_) => return Ok(vec![]),
    };
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("plugins dir 읽기 실패: {}", e))?;
    for ent in entries.flatten() {
        let p = ent.path();
        if p.extension().and_then(|s| s.to_str()) != Some("py") {
            continue;
        }
        let fname = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        if fname.starts_with("__") {
            // __init__.py / __pycache__ skip
            continue;
        }
        let meta = match ent.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        out.push(KdaPluginInfo {
            file: fname,
            size: meta.len(),
            modified_ms,
        });
    }
    out.sort_by(|a, b| a.file.cmp(&b.file));
    Ok(out)
}

#[tauri::command]
async fn read_kda_plugin(file: String) -> Result<String, String> {
    // file 은 단순 basename (예: "kda_my_tool.py") — directory traversal 차단
    if file.contains('/') || file.contains('\\') || file.contains("..") {
        return Err("file 은 단순 파일명만 허용".into());
    }
    if !file.ends_with(".py") {
        return Err("file 은 .py 확장자만".into());
    }
    let dir = resolve_kpersonal_plugins_dir()?;
    let path = dir.join(&file);
    if !path.exists() {
        return Err(format!("plugin 없음: {}", file));
    }
    std::fs::read_to_string(&path).map_err(|e| format!("read 실패: {}", e))
}

#[tauri::command]
async fn save_kda_plugin(
    app: AppHandle,
    name: String,
    code: String,
) -> Result<String, String> {
    // name 은 plugin 식별자 (예: "kda_my_tool" — 확장자 제외). 파일명은 자동으로 .py 추가.
    validate_kda_plugin_name(&name)?;
    if code.is_empty() || code.len() > 200_000 {
        return Err("code 가 비어있거나 너무 큽니다 (200KB 제한)".into());
    }
    let dir = resolve_kpersonal_plugins_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("plugins dir 생성 실패: {}", e))?;
    // 디렉토리에 __init__.py 가 없으면 같이 박음 (Python package 인식)
    let init_path = dir.join("__init__.py");
    if !init_path.exists() {
        let _ = std::fs::write(
            &init_path,
            "# KDA custom plugins — generated by K-Desktop-Agent Settings UI\n",
        );
    }
    let path = dir.join(format!("{}.py", name));
    // 이전 plugin 이 있으면 .bak 으로 보존 (롤백 용)
    if path.exists() {
        let bak = dir.join(format!("{}.py.bak", name));
        let _ = std::fs::copy(&path, &bak);
    }
    std::fs::write(&path, code).map_err(|e| format!("plugin 저장 실패: {}", e))?;
    log_lifecycle(
        "runtime.log",
        &format!("save_kda_plugin {} ({} bytes)", name, path.metadata().map(|m| m.len()).unwrap_or(0)),
    );
    // sidecar 재기동 → MCP server 재 spawn → 새 도구가 list_tools 에 노출
    reload_sidecar(app).await?;
    Ok(format!("저장 완료: {} (sidecar 재기동 중)", path.display()))
}

#[tauri::command]
async fn delete_kda_plugin(app: AppHandle, file: String) -> Result<String, String> {
    if file.contains('/') || file.contains('\\') || file.contains("..") {
        return Err("file 은 단순 파일명만 허용".into());
    }
    if !file.ends_with(".py") {
        return Err("file 은 .py 확장자만".into());
    }
    let basename = file.trim_end_matches(".py");
    validate_kda_plugin_name(basename)?;
    let dir = resolve_kpersonal_plugins_dir()?;
    let path = dir.join(&file);
    if !path.exists() {
        return Err(format!("plugin 없음: {}", file));
    }
    // .bak 백업 — 실수로 지웠을 때 K-Personal-MCP/modules/kda_plugins/ 에서 직접 복구 가능
    let bak = dir.join(format!("{}.deleted.bak", file));
    let _ = std::fs::copy(&path, &bak);
    std::fs::remove_file(&path).map_err(|e| format!("plugin 삭제 실패: {}", e))?;
    log_lifecycle("runtime.log", &format!("delete_kda_plugin {}", file));
    reload_sidecar(app).await?;
    Ok(format!("삭제 완료 (.deleted.bak 보존)"))
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
/// Phase 74 (v0.6.17) — 로컬 파일을 OS 기본 앱으로 열기.
///
/// SidePanel 의 "외부 열기" 버튼이 호출. 기존 SidePanel.tsx 는 `invoke("open_path")`
/// 시도 후 실패하면 `plugin-shell.open` 폴백이었는데, plugin-shell 의 default scope 는
/// `^((mailto:\w+)|(tel:\w+)|(https?://\w+)).+` 만 허용 — 로컬 파일 path 는 regex
/// validation 에서 거부 ("Scoped command argument at position 0 was found, but failed
/// regex validation"). 그래서 K 보고: "외부 앱에서 열기 실패" 메시지.
///
/// fix: Rust 측 명시적 command 로 path 직접 열기. capabilities scope 우회.
/// Windows 의 `cmd /c start "" "<path>"` 가 path 의 첫 인자를 window title 로 잡는
/// 함정 회피 위해 빈 title 명시.
///
/// Phase 78 (v0.6.21) — input path normalize 헬퍼.
///
/// react-markdown 이 채팅 마크다운 link href 를 URL spec 에 따라 normalize 하면서 Windows
/// path 의 `\` 와 한글을 percent-encode 함:
///   C:\Users\user\Pictures\캡처.PNG
///   → C:%5CUsers%5Cuser%5CPictures%5C%EC%BA%A1%EC%B2%98.PNG
/// canonicalize 가 이 percent-encoded path 못 풀어서 "path canonicalize 실패" 거부.
/// frontend (SidePanel.normalizeLocalPath) 가 이미 처리하지만 옛 binary 호환 / 다른 호출자
/// (CLI, 외부 trigger) 안전망으로 양방향 방어. % 가 없으면 raw return — no-op.
/// Phase 78.1 (v0.6.23) — Windows 의 Path::canonicalize 가 반환하는 UNC long path prefix
/// (`\\?\C:\...`) 제거. canonical_str.starts_with("c:\\users\\...") 매칭이 깨지는 함정.
///
/// Windows API 의 GetFinalPathNameByHandle (canonicalize 가 내부 호출) 은 32K path 지원 위해
/// `\\?\` prefix 를 자동 추가하는데, K 의 trusted_prefixes 는 USERPROFILE/APPDATA 등 env var
/// 기반 raw path 라 prefix 안 붙음 → starts_with 항상 false → "신뢰하지 않는 경로" 거부.
///
/// 회피: canonical_str 의 `\\?\` prefix 만 strip 후 비교. Drive letter (`C:`) 로 시작하는
/// 단순 케이스만 처리 (`\\?\UNC\server\...` 같은 UNC server share 는 strip 안 함 — KDA scope 밖).
fn strip_unc_prefix(s: &str) -> &str {
    // `\\?\C:\...` 또는 `\\?\D:\...` 등 drive letter 형식만. UNC server share 는 보존.
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        // rest 가 `UNC\...` 면 원본 유지 (server share — 별도 케이스)
        if rest.to_lowercase().starts_with("unc\\") {
            return s;
        }
        return rest;
    }
    s
}

/// Phase 114 (v0.6.69) — 로컬 drive-letter 경로 판별 (`c:\...`, `d:/...`).
///
/// K 보고: 작업 파일이 USERPROFILE/APPDATA 밖 (다른 드라이브, 다른 폴더) 에 있으면
/// 프리뷰/외부열기가 "신뢰하지 않는 경로" 로 거부되고, 폴백 plugin-shell.open 이
/// scope regex 에 막혀 cryptic 한 "Unexpected command argument ... but found .txt" 에러가
/// K 에게 그대로 노출됐다.
///
/// 근본 원인: trusted_prefixes 가 USERPROFILE/APPDATA/LOCALAPPDATA/exe폴더 4개로만 제한.
///
/// 근본 대책: open_path / read_preview_file / read_qa_report 는 **K 가 KDA UI 에서 직접
/// 클릭한 파일에만** 호출된다 (AI 모델이 임의로 부르는 command 가 아님 — frontend invoke).
/// 따라서 로컬 drive-letter 경로 전체를 신뢰해도 "모델 경유 임의 파일 읽기" 위험이 없다.
/// 모델의 파일 접근은 별도 레이어 (MCP 권한 토글) 에서 통제된다.
///
/// 네트워크 UNC 경로 (`\\server\share`) 는 drive letter 가 없어 false → 여전히 거부.
/// (canonical_str 은 호출 측에서 lowercase + strip_unc_prefix 적용 후 전달)
fn is_local_drive_path(canonical_str: &str) -> bool {
    let b = canonical_str.as_bytes();
    b.len() >= 3
        && b[0].is_ascii_lowercase()
        && b[1] == b':'
        && (b[2] == b'\\' || b[2] == b'/')
}

fn percent_decode_local_path(input: &str) -> String {
    // file:// prefix 제거 (Windows path 는 file:///C:/...)
    let stripped = input
        .strip_prefix("file:///")
        .or_else(|| input.strip_prefix("file://"))
        .unwrap_or(input);
    // 빠른 path: % 가 없으면 raw return (성능 + idempotent)
    if !stripped.contains('%') {
        return stripped.to_string();
    }
    // manual percent-decode (UTF-8 aware). decode 후 invalid UTF-8 면 원본 유지.
    let bytes = stripped.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| stripped.to_string())
}

/// 안전성: path 가 K 의 신뢰 영역 ($HOME, $HOME/.kda, $HOME/Documents, Desktop, AppData,
/// Tauri resource dir) 안인지만 검증. 더 strict 한 path traversal 검증은 PathBuf 의
/// canonicalize 가 ".." 풀어서 absolute path 만들면 자연 차단.
///
/// Phase 78 (v0.6.21) — percent_decode_local_path 로 URL-encoded path 양방향 방어.
/// Phase 78.1 (v0.6.23) — Windows canonicalize 의 `\\?\` UNC long path prefix strip.
///   canonicalize 결과: `\\?\C:\Users\user\Pictures\캡처.PNG`
///   trusted_prefixes: `c:\users\user`
///   strip_unc_prefix 없으면 starts_with 영구 false → forbidden.
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    use std::path::Path;
    let normalized = percent_decode_local_path(&path);
    let p = Path::new(&normalized);
    let canonical = match p.canonicalize() {
        Ok(c) => c,
        Err(e) => return Err(format!("path canonicalize 실패: {} (입력: {} / 정규화: {})", e, path, normalized)),
    };
    let canonical_full = canonical.to_string_lossy().to_string();
    // Phase 78.1 (v0.6.23): UNC prefix strip 후 비교
    let canonical_str = strip_unc_prefix(&canonical_full).to_lowercase();

    // K 가 신뢰하는 영역만 허용. PC 마다 user 이름 다르므로 ($HOME) 기준.
    let home = std::env::var("USERPROFILE").unwrap_or_default().to_lowercase();
    let resource_dir = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_string_lossy().to_lowercase()));
    let appdata = std::env::var("APPDATA").unwrap_or_default().to_lowercase();
    let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_default().to_lowercase();

    let trusted_prefixes: Vec<String> = vec![
        Some(home.clone()),
        resource_dir,
        Some(appdata.clone()),
        Some(localappdata.clone()),
    ]
    .into_iter()
    .flatten()
    .filter(|s| !s.is_empty())
    .collect();

    // Phase 114 (v0.6.69) — 로컬 drive-letter 경로 전체 신뢰 (K 가 직접 클릭한 파일).
    // 기존 trusted_prefixes 는 OR 안전망으로 보존. UNC 네트워크 경로만 거부됨.
    let trusted = is_local_drive_path(&canonical_str)
        || trusted_prefixes
            .iter()
            .any(|prefix| canonical_str.starts_with(prefix));
    if !trusted {
        return Err(format!(
            "신뢰하지 않는 경로 (외부 열기 거부): {}\n네트워크/UNC 경로는 보안상 지원하지 않습니다.",
            canonical.display(),
        ));
    }

    // Windows 에선 `cmd /c start "" "<path>"` 가 가장 안전. 첫 빈 quote = window title 자리.
    // Phase 78.1 (v0.6.23): cmd start 도 UNC prefix 가 있으면 동작 불안정 — strip 된 raw path 전달.
    #[cfg(target_os = "windows")]
    {
        use std::process::Command as StdCommand;
        let safe_path = strip_unc_prefix(&canonical_full);
        let mut cmd = StdCommand::new("cmd");
        cmd.args(["/c", "start", "", safe_path]);
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| format!("cmd start spawn 실패: {}", e))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        return Err("open_path 는 Windows 전용".to_string());
    }
    Ok(())
}

/// Phase 75 (v0.6.18) — Codex 좀비 process detect.
///
/// K 보고 (다른 PC): KDA 가 "Reconnecting... 2/5 (timeout waiting for child process to exit)" 로
/// 막히는데, 원인은 **이전 세션의 codex.exe / node.exe / powershell 가 K 의 user 권한으로
/// 살아있어서** KDA 의 reconnect 시 child 정리 timeout. 2026-05-22 부터 11일째 떠있는
/// process 까지 확인됨 (`codex exec resume 019e4d8e...`).
///
/// 회피 — Phase 75 의 default OFF + visible UI:
/// 1. Settings 시스템 탭의 "🧟 좀비 codex 프로세스" 섹션이 이 command 로 stale 후보 목록 표시.
/// 2. K 가 직접 "정리하기" 누르면 kill_process_tree 가 taskkill /F /T 호출.
/// 3. 자동 kill 은 default OFF — K 의 다른 PC 의 codex 작업을 죽일 위험 회피.
///
/// "stale" 의 정의 (3가지 동시 만족):
/// (a) 이름이 codex.exe / node.exe / powershell.exe / pwsh.exe 중 하나
/// (b) CommandLine 에 "codex" 포함 (false positive 회피) — 또는 Phase 76 의 "suspected" 분기
/// (c) StartTime 이 1시간 이전 (현재 KDA 의 codex subprocess 는 아닌 게 확실)
/// (d) ParentProcessId 가 현재 KDA process tree 안이 아님 — 다른 KDA 인스턴스 의 child 거나 orphan
///
/// (d) 검증은 비용이 커서 (모든 process 의 parent 추적) v1 에선 (a)+(b)+(c) 만 + KDA 의 PID 자체는 제외.
/// false positive 한 두 개 있어도 K 가 UI 에서 확인하고 직접 kill 하므로 안전.
///
/// Phase 76 (v0.6.19) — 좀비 검출 강화:
/// K 의 다른 PC 진단 결과 7.5시간 떠있는 node.exe 7개가 cmdline=null (권한 부족 / elevated 등)
/// 이라 (b) 조건 못 통과 → UI 가 "좀비 0개" 거짓 표시.
/// 강화: cmdline 빈 node.exe / codex.exe 도 suspected 후보로 포함 (1시간+ AND KDA 자기 PID 아닌 경우).
/// UI 가 suspected 라벨로 구분 표시 + K 가 직접 판단해서 kill 결정.
/// false positive 위험 ↑ (다른 IDE/도구의 node 가 잡힐 수 있음) — UI 에 명시 라벨 + cmdline 빈 경우
/// "권한 부족으로 명령줄 못 가져옴" 안내. 자동 kill 은 여전히 OFF (Phase 75 정책 유지).
#[derive(serde::Serialize)]
struct StaleProcess {
    pid: u32,
    name: String,
    start_time: String,
    age_hours: f64,
    command_line: String,
    /// Phase 76 (v0.6.19): true 면 cmdline 못 읽어서 "codex 일 가능성만 있음" 으로 잡힌 후보.
    /// false 면 cmdline 에 "codex" 가 명시적으로 들어간 확정 후보.
    suspected: bool,
}

#[tauri::command]
fn list_stale_codex_processes() -> Result<Vec<StaleProcess>, String> {
    use std::process::Command as StdCommand;
    // PowerShell Get-CimInstance Win32_Process — StartTime, ParentProcessId, CommandLine 다 한 번에.
    // Format: pipe-delimited. Json 도 가능하지만 datetime 직렬화 까다로움.
    //
    // Phase 76 (v0.6.19): 검출 조건을 두 분기로 확장.
    //   분기 A (확정 후보, suspected=false): cmdline 에 "codex" 포함 (Phase 75 와 동일)
    //   분기 B (의심 후보, suspected=true):  cmdline 이 null/empty 인 node.exe 또는 codex.exe
    //                                        (powershell 은 워낙 많아서 분기 B 제외 — false positive 폭증 방지)
    // 두 분기 OR + 1시간+ AND KDA 자기 PID 아닌 경우. 7번째 컬럼에 suspected 플래그 박음.
    let script = r#"
$now = Get-Date
Get-CimInstance Win32_Process |
  Where-Object {
    ($_.Name -in @('codex.exe','node.exe','powershell.exe','pwsh.exe')) -and
    ($_.CreationDate -lt $now.AddHours(-1)) -and
    (
      ($_.CommandLine -like '*codex*') -or
      (($_.Name -in @('node.exe','codex.exe')) -and [string]::IsNullOrEmpty($_.CommandLine))
    )
  } |
  ForEach-Object {
    $age = [math]::Round(($now - $_.CreationDate).TotalHours, 2)
    $hasCodex = ($_.CommandLine -like '*codex*')
    $suspected = if ($hasCodex) { '0' } else { '1' }
    $cmd = if ($_.CommandLine) { $_.CommandLine.Substring(0, [Math]::Min(300, $_.CommandLine.Length)) } else { '<권한 부족으로 명령줄 못 가져옴>' }
    "$($_.ProcessId)|$($_.Name)|$($_.CreationDate.ToString('yyyy-MM-dd HH:mm:ss'))|$age|$suspected|$cmd"
  }
"#;
    let output = StdCommand::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|e| format!("powershell spawn 실패: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "powershell exit {}: {}",
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let kda_pid = std::process::id();
    let mut results = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Phase 76: 6개 필드 (pid|name|start|age|suspected|cmd)
        let parts: Vec<&str> = line.splitn(6, '|').collect();
        if parts.len() < 6 {
            continue;
        }
        let pid: u32 = match parts[0].parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        // 자기 자신 (KDA) 제외
        if pid == kda_pid {
            continue;
        }
        let age_hours: f64 = parts[3].parse().unwrap_or(0.0);
        let suspected = parts[4] == "1";
        results.push(StaleProcess {
            pid,
            name: parts[1].to_string(),
            start_time: parts[2].to_string(),
            age_hours,
            command_line: parts[5].to_string(),
            suspected,
        });
    }
    Ok(results)
}

/// Phase 75 (v0.6.18) — process tree kill.
///
/// taskkill /F /T /PID <pid> — child 까지 강제 종료. K 가 UI 의 "정리하기" 누를 때 호출.
///
/// Phase 76 (v0.6.19) — stdout/stderr 캡처는 유지하되 (에러 메시지 추출 위해),
/// 부모 prosess (Tauri main) 의 stdout/stderr 로 새지 않음. `.output()` 은 inherit 안 함 — OK.
/// 별도 fix 는 sidecar 측에서 Codex 의 stdout 라인 중 "SUCCESS:" / "성공:" prefix skip (Fix #2-B).
#[tauri::command]
fn kill_process_tree(pid: u32) -> Result<(), String> {
    use std::process::Command as StdCommand;
    let kda_pid = std::process::id();
    if pid == kda_pid {
        return Err(format!("KDA 자기 자신 (PID {}) 은 kill 거부", pid));
    }
    let output = StdCommand::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .output()
        .map_err(|e| format!("taskkill spawn 실패: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "taskkill PID {} 실패 (exit {}): {}",
            pid,
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Phase 74 (v0.6.17) — 미리보기 파일을 binary 또는 텍스트로 읽기.
///
/// SidePanel.tsx 의 `loadPreview` 가 기존엔 `@tauri-apps/plugin-fs` 의 readFile/readTextFile
/// 사용 → capabilities 의 `fs:scope` 가 default 라 `~/.kda/cwd/runtime/previews/...` 같은
/// K 워크스페이스 path 를 거부 ("forbidden path: runtime/previews/..."). 결과: 모든 이미지/
/// PDF/비디오/오디오 미리보기 fail.
///
/// fix: Rust 측 명시적 command — plugin-fs scope 우회. 안전 검증은 open_path 와 동일하게
/// 신뢰 prefix (USERPROFILE/APPDATA/LOCALAPPDATA/install dir) 안만 허용.
///
/// 반환: as_text=true 면 UTF-8 텍스트, 아니면 raw bytes (Vec<u8>) — frontend 가 base64 변환.
#[tauri::command]
fn read_preview_file(path: String, as_text: bool) -> Result<serde_json::Value, String> {
    use std::path::Path;
    // Phase 78 (v0.6.21) — react-markdown URL-encoded path 양방향 방어. open_path 와 동일 로직.
    let normalized = percent_decode_local_path(&path);
    let p = Path::new(&normalized);
    let canonical = match p.canonicalize() {
        Ok(c) => c,
        Err(e) => return Err(format!("path canonicalize 실패: {} (입력: {} / 정규화: {})", e, path, normalized)),
    };
    // Phase 78.1 (v0.6.23): UNC `\\?\` prefix strip 후 비교. Windows canonicalize 가
    // long path 위해 자동 추가 → trusted_prefixes 매칭 영구 fail. K 의 다른 PC 진단 4중 함정 #4.
    let canonical_full = canonical.to_string_lossy().to_string();
    let canonical_str = strip_unc_prefix(&canonical_full).to_lowercase();

    let home = std::env::var("USERPROFILE").unwrap_or_default().to_lowercase();
    let resource_dir = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_string_lossy().to_lowercase()));
    let appdata = std::env::var("APPDATA").unwrap_or_default().to_lowercase();
    let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_default().to_lowercase();
    let trusted_prefixes: Vec<String> = vec![
        Some(home),
        resource_dir,
        Some(appdata),
        Some(localappdata),
    ]
    .into_iter()
    .flatten()
    .filter(|s| !s.is_empty())
    .collect();

    // Phase 114 (v0.6.69) — 로컬 drive-letter 경로 전체 신뢰 (K 가 직접 클릭한 파일).
    let trusted = is_local_drive_path(&canonical_str)
        || trusted_prefixes
            .iter()
            .any(|prefix| canonical_str.starts_with(prefix));
    if !trusted {
        return Err(format!(
            "신뢰하지 않는 경로 (미리보기 거부): {}\n네트워크/UNC 경로는 보안상 지원하지 않습니다.",
            canonical.display(),
        ));
    }

    // 파일 크기 cap — 100MB 이상은 거부 (메모리 폭주 회피).
    let metadata = std::fs::metadata(&canonical).map_err(|e| format!("metadata 실패: {}", e))?;
    const MAX_SIZE: u64 = 100 * 1024 * 1024;
    if metadata.len() > MAX_SIZE {
        return Err(format!(
            "파일 크기 100MB 초과 ({}MB) — 미리보기 거부",
            metadata.len() / (1024 * 1024)
        ));
    }

    if as_text {
        let s = std::fs::read_to_string(&canonical).map_err(|e| format!("text read 실패: {}", e))?;
        // 텍스트도 100KB 까지만 (frontend 의 truncate 와 일관성).
        // Phase 116 (v0.6.71) — `&s[..100_000]` 는 byte 슬라이스라 100_000 번째 byte 가
        // 한글 등 멀티바이트 char 중간이면 panic ("not a char boundary"). UTF-8 안전 경계로
        // 내려서 자른다 (한글 3byte/자 → 약 2/3 확률로 panic 하던 latent crash).
        let truncated = if s.len() > 100_000 {
            let mut end = 100_000;
            while end > 0 && !s.is_char_boundary(end) {
                end -= 1;
            }
            format!("{}\n\n... [잘림: 100KB 까지만]", &s[..end])
        } else {
            s
        };
        Ok(serde_json::json!({ "text": truncated }))
    } else {
        let bytes = std::fs::read(&canonical).map_err(|e| format!("binary read 실패: {}", e))?;
        Ok(serde_json::json!({ "bytes": bytes }))
    }
}

/// Phase 80 (v0.6.24) — Final-Review Gate.
///
/// folder_path 의 같은 폴더에서 `qa-report.json` 을 찾아 parse 후 반환. SidePanel 의
/// loadPreview 직전에 호출 — FINAL_CANDIDATE 외 status 면 차단.
///
/// 안전성: read_preview_file 과 동일한 신뢰 prefix + UNC strip 검증.
/// qa-report.json 형식 (v1):
///   {
///     "version": 1,
///     "files": {
///       "<filename>": { "status": "FINAL_CANDIDATE" | "HOLD" | "FAIL", "reason"?: "...", "qa_at"?: "..." }
///     }
///   }
///
/// 반환:
/// - { "exists": false }                          - qa-report.json 없음 (legacy 폴더 = 통과)
/// - { "exists": true, "content": <json>, "raw": "<text>" } - 정상 parse
/// - { "exists": true, "error": "..." }           - 파일은 있는데 parse 실패
#[tauri::command]
fn read_qa_report(folder_path: String) -> Result<serde_json::Value, String> {
    use std::path::Path;
    let normalized = percent_decode_local_path(&folder_path);
    let folder = Path::new(&normalized);
    let canonical = match folder.canonicalize() {
        Ok(c) => c,
        Err(e) => return Err(format!("folder canonicalize 실패: {} (입력: {} / 정규화: {})", e, folder_path, normalized)),
    };
    let canonical_full = canonical.to_string_lossy().to_string();
    let canonical_str = strip_unc_prefix(&canonical_full).to_lowercase();

    let home = std::env::var("USERPROFILE").unwrap_or_default().to_lowercase();
    let appdata = std::env::var("APPDATA").unwrap_or_default().to_lowercase();
    let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_default().to_lowercase();
    let trusted_prefixes: Vec<String> = vec![home, appdata, localappdata]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    // Phase 114 (v0.6.69) — read_preview_file 과 동일 정책 (로컬 drive-letter 전체 신뢰).
    // 프리뷰가 열리는 폴더의 qa-report 검사도 같이 통과해야 gate 일관성 유지.
    let trusted = is_local_drive_path(&canonical_str)
        || trusted_prefixes.iter().any(|p| canonical_str.starts_with(p));
    if !trusted {
        return Err(format!(
            "신뢰하지 않는 경로 (qa-report 거부): {}\n네트워크/UNC 경로는 보안상 지원하지 않습니다.",
            canonical.display(),
        ));
    }

    let qa_path = canonical.join("qa-report.json");
    if !qa_path.exists() {
        return Ok(serde_json::json!({ "exists": false }));
    }
    let raw = match std::fs::read_to_string(&qa_path) {
        Ok(s) => s,
        Err(e) => {
            return Ok(serde_json::json!({
                "exists": true,
                "error": format!("read 실패: {}", e),
            }));
        }
    };
    // UTF-8 BOM strip (Windows tooling 이 자주 생성)
    let cleaned = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
    match serde_json::from_str::<serde_json::Value>(cleaned) {
        Ok(parsed) => Ok(serde_json::json!({
            "exists": true,
            "content": parsed,
            "raw": cleaned,
        })),
        Err(e) => Ok(serde_json::json!({
            "exists": true,
            "error": format!("JSON parse 실패: {}", e),
            "raw": cleaned,
        })),
    }
}

/// Phase 81 (v0.6.25) — Lee Profile read + 첫 진입 시 example template 자동 생성.
///
/// `~/.kda/lee-profile.md` 파일 read. 없으면 example template 박아 K 가 즉시 편집 가능하게 함.
/// sidecar 의 loadMemoryContext 가 매 turn 시작 시 이 파일 내용을 system prompt 첫머리에 prepend.
///
/// 반환: { path: "...", exists: bool, content: "<markdown>", bytes: N, justCreated: bool }
#[tauri::command]
fn read_lee_profile() -> Result<serde_json::Value, String> {
    let home = std::env::var("USERPROFILE").map_err(|e| format!("USERPROFILE 못 읽음: {}", e))?;
    let kda_dir = std::path::PathBuf::from(&home).join(".kda");
    let profile_path = kda_dir.join("lee-profile.md");

    if profile_path.exists() {
        let raw = std::fs::read_to_string(&profile_path)
            .map_err(|e| format!("lee-profile.md read 실패: {}", e))?;
        let cleaned = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw).to_string();
        let bytes = cleaned.len();
        return Ok(serde_json::json!({
            "path": profile_path.to_string_lossy(),
            "exists": true,
            "content": cleaned,
            "bytes": bytes,
            "justCreated": false,
        }));
    }

    // 첫 진입 — 부모 폴더 보장 + example template 생성. K 가 편집해서 자기 규칙 채울 수 있게.
    if let Err(e) = std::fs::create_dir_all(&kda_dir) {
        return Err(format!("~/.kda 폴더 생성 실패 ({}): {}", kda_dir.display(), e));
    }

    let template = "# K(Lee) 의 개인 응답 규칙\n\
\n\
> 이 파일에 K 본인이 직접 정의한 응답 스타일/규칙을 채우세요.\n\
> 매 turn 시작 시 sidecar 가 system prompt 첫머리에 자동 prepend 합니다.\n\
> Settings → 안전 탭 → \"🪪 Lee Profile\" 섹션에서 토글 OFF 하면 prepend 안 됩니다.\n\
\n\
## 응답 스타일\n\
\n\
- 한국어 우선 (코드/명령어 제외)\n\
- 증거 없는 완료 보고 금지 — 항상 검증 가능한 출력으로 마무리\n\
- 긴 작업은 5분 단위 evidence update 또는 진행 상황 보고\n\
\n\
## 자주 하는 작업의 규칙\n\
\n\
- SIGILFALL: 의도 → 룰 → 콘티 → QA 순서 먼저, 그 다음 생성\n\
- 링크는 K 가 KDA 안에서 미리보기 가능한 로컬 경로 우선 (http URL 보다)\n\
- raw 생성컷은 final-review 통과한 것만 K 에게 노출 (qa-report.json + Phase 80 Gate 활용)\n\
\n\
## 금지 사항\n\
\n\
- 파괴적 작업 (force push / 대량 삭제 / 자동시작 등록 등) 은 사전 명시 승인 없이 실행 금지\n\
- (필요한 항목 추가)\n";

    if let Err(e) = std::fs::write(&profile_path, template.as_bytes()) {
        return Err(format!("lee-profile.md template 쓰기 실패: {}", e));
    }
    Ok(serde_json::json!({
        "path": profile_path.to_string_lossy(),
        "exists": true,
        "content": template,
        "bytes": template.len(),
        "justCreated": true,
    }))
}

/// Phase 81 (v0.6.25) — lee-profile.md 를 OS 기본 텍스트 에디터로 open.
///
/// open_path 와 같은 cmd start 사용 — Windows 의 .md 기본 연결 앱 (메모장 / VS Code 등) 호출.
/// 신뢰 prefix 검증 생략 (~/.kda 안 고정 path 라 안전).
#[tauri::command]
fn open_lee_profile_in_editor() -> Result<(), String> {
    let home = std::env::var("USERPROFILE").map_err(|e| format!("USERPROFILE 못 읽음: {}", e))?;
    let profile_path = std::path::PathBuf::from(home).join(".kda").join("lee-profile.md");
    if !profile_path.exists() {
        // read_lee_profile 가 먼저 호출되어야 — template 생성 path. 안전망으로 빈 파일 박음.
        if let Some(parent) = profile_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&profile_path, "# K(Lee) 의 개인 응답 규칙\n").ok();
    }
    #[cfg(target_os = "windows")]
    {
        use std::process::Command as StdCommand;
        let path_str = profile_path.to_string_lossy().to_string();
        let mut cmd = StdCommand::new("cmd");
        cmd.args(["/c", "start", "", &path_str]);
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| format!("cmd start spawn 실패: {}", e))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        return Err("open_lee_profile_in_editor 는 Windows 전용".to_string());
    }
    Ok(())
}

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
    // Phase 31 (v0.5.19): top-level keys + 첫 500자 디버그 로깅 — schema 변경 진단용.
    // K 가 sidecar.log 한 줄 보내주면 normalizeRateLimit 의 schema 정확히 패치 가능.
    let top_keys: Vec<String> = json
        .as_object()
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_else(|| vec!["(not-an-object)".to_string()]);
    let snippet: String = body.chars().take(500).collect();
    log_lifecycle(
        "runtime.log",
        &format!(
            "codex_fetch_usage OK status={} bodyLen={} topKeys=[{}] snippet={}",
            status.as_u16(),
            body.len(),
            top_keys.join(","),
            snippet
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

// ────────── Sidecar config (Phase 59 — Anthropic rate polling toggle) ──────────
//
// sidecar 가 시작 시 읽는 ~/.kda/sidecar-config.json 의 한 키만 partial-update.
// 기존 키는 보존 (merge). sidecar 는 시작 시에만 읽으므로 변경 후 즉시 효과 보려면 reload_sidecar.
// 동기: K 의 V3 (안랩) 백신이 ccusage native binary (bun standalone .exe) 의 실행을 차단해
// 매 5분마다 알림 팝업이 뜨는 경우, polling 자체를 끌 수 있어야 함. 끈 상태에서도 KDA 본체
// 동작은 무관 — Anthropic 사용량 표시의 정확한 source 만 비활성화.

fn sidecar_config_path() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "HOME/USERPROFILE 환경변수 없음".to_string())?;
    Ok(PathBuf::from(home).join(".kda").join("sidecar-config.json"))
}

#[tauri::command]
async fn get_sidecar_config() -> Result<serde_json::Value, String> {
    let path = sidecar_config_path()?;
    if !path.exists() {
        // 기본값 — sidecar 의 readSidecarConfig() 와 동기화 유지 필요.
        // Phase 80 (v0.6.24): finalReviewGateEnabled 신규 — default true (안전 우선).
        return Ok(serde_json::json!({
            "anthropicRatePollingEnabled": true,
            "finalReviewGateEnabled": true,
        }));
    }
    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("config 읽기 실패: {}", e))?;
    let stripped = strip_bom(&raw);
    let v: serde_json::Value = serde_json::from_str(stripped)
        .map_err(|e| format!("config 파싱 실패: {}", e))?;
    Ok(v)
}

#[tauri::command]
async fn set_sidecar_config_flag(
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let path = sidecar_config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("config 부모 폴더 생성 실패 ({}): {}", parent.display(), e))?;
    }

    // 기존 파일 로드 (없거나 깨진 경우 빈 객체로 시작 — merge 가 의미 있음)
    let mut obj: serde_json::Map<String, serde_json::Value> = if path.exists() {
        match std::fs::read_to_string(&path) {
            Ok(raw) => {
                let stripped = strip_bom(&raw);
                match serde_json::from_str::<serde_json::Value>(stripped) {
                    Ok(serde_json::Value::Object(m)) => m,
                    _ => serde_json::Map::new(),
                }
            }
            Err(_) => serde_json::Map::new(),
        }
    } else {
        serde_json::Map::new()
    };
    obj.insert(key, value);

    // BOM 없는 UTF-8 으로 write (pitfall_powershell_secret_bom 함정 회피).
    // Rust 의 std::fs::write 는 raw bytes 라 BOM 자동 주입 없음 — 그대로 안전.
    let json = serde_json::to_string_pretty(&serde_json::Value::Object(obj))
        .map_err(|e| format!("config 직렬화 실패: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("config 쓰기 실패: {}", e))?;
    log_lifecycle(
        "runtime.log",
        &format!("[config] sidecar-config.json updated: {}", path.display()),
    );
    Ok(())
}

// ────────── Sidecar spawning ──────────

async fn spawn_sidecar(app: AppHandle) -> Result<(), String> {
    // 새 spawn 이 시작되었다는 건 이전의 의도적 종료가 완료되었다는 뜻.
    INTENTIONAL_SHUTDOWN.store(false, Ordering::SeqCst);
    let spawn_started_at = epoch_secs();
    LAST_SIDECAR_SPAWN_SECS.store(spawn_started_at, Ordering::SeqCst);
    LAST_SIDECAR_EVENT_SECS.store(0, Ordering::SeqCst);

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
    // Phase 25 (v0.5.11): data_root() 로 일원화. 옛 fallback 도 ~/.kda 라 기존 K 의 session 그대로 회복.
    let claude_cwd: Option<PathBuf> = Some(data_root().join("cwd"));
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
                        LAST_SIDECAR_EVENT_SECS.store(epoch_secs(), Ordering::SeqCst);
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

            // Phase 25 (v0.5.11): 옛 K 의 데이터 (%APPDATA%\com.k.desktop-agent\conversations.db)
            // 가 새 data_root() 에 없으면 자동 한 번 복사 — v0.5.10→v0.5.11 update 시 K 의
            // 대화 손실 방지. idempotent — 이미 새 위치에 있으면 skip.
            migrate_legacy_db_if_needed();

            // Phase 26 (v0.5.13): 새 PC 에 setup.exe 깐 직후 K-Personal-MCP 가 없으면
            // install_dir 의 bundled-mcp 를 ~/Documents/K-Personal-MCP/ 로 자동 복사.
            // K 의 본 PC 에선 폴더 이미 있어 skip — 옛 todos/notes/habits 보존.
            deploy_bundled_mcp_if_needed();

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

            // Phase 70 — prod build 에서도 KDA_OPEN_DEVTOOLS=1 환경변수 있으면 DevTools 자동 오픈.
            // tauri.conf.json 의 "devtools": true 와 짝 — 진단 가능성을 영구히 열어둠.
            // 우클릭→검사 / Ctrl+Shift+I 도 prod 에서 작동 (devtools: true 덕분).
            if std::env::var("KDA_OPEN_DEVTOOLS").is_ok() {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
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

            // Heartbeat watchdog: if the Node sidecar stops emitting stdout events
            // while the app still expects it to be alive, kill it and let the
            // existing stdout-EOF respawn path recover. This catches hangs where
            // the process has not exited but the LLM/sidecar stream is wedged.
            let watchdog_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(SIDECAR_WATCHDOG_INTERVAL_SECS)).await;
                    if INTENTIONAL_SHUTDOWN.load(Ordering::SeqCst) {
                        continue;
                    }

                    let now = epoch_secs();
                    let last = LAST_SIDECAR_EVENT_SECS.load(Ordering::SeqCst);
                    if last == 0 {
                        let spawn_started_at = LAST_SIDECAR_SPAWN_SECS.load(Ordering::SeqCst);
                        if spawn_started_at == 0 {
                            continue;
                        }

                        let startup_age = now.saturating_sub(spawn_started_at);
                        if startup_age <= SIDECAR_STARTUP_GRACE_SECS {
                            continue;
                        }

                        log_lifecycle(
                            "sidecar.log",
                            &format!(
                                "sidecar startup timeout: no first stdout event for {}s threshold={}s - killing child for respawn",
                                startup_age, SIDECAR_STARTUP_GRACE_SECS
                            ),
                        );
                        let _ = watchdog_handle.emit(
                            "sidecar-event",
                            serde_json::json!({
                                "type": "sidecar_startup_timeout",
                                "startup_age_secs": startup_age,
                                "threshold_secs": SIDECAR_STARTUP_GRACE_SECS,
                            }),
                        );
                        LAST_SIDECAR_SPAWN_SECS.store(now, Ordering::SeqCst);

                        let child_holder = get_child_holder().clone();
                        let mut guard = child_holder.lock().await;
                        if let Some(child) = guard.as_mut() {
                            let _ = child.start_kill();
                        } else if let Some(tx) = RESPAWN_TX.get() {
                            let attempt = RESTART_ATTEMPTS.fetch_add(1, Ordering::SeqCst) + 1;
                            let _ = tx.send(RespawnRequest { delay_secs: 1, attempt });
                        }
                        continue;
                    }

                    let age = now.saturating_sub(last);
                    if age <= SIDECAR_HEARTBEAT_TIMEOUT_SECS {
                        continue;
                    }

                    log_lifecycle(
                        "sidecar.log",
                        &format!(
                            "sidecar heartbeat timeout: last_event_age={}s threshold={}s - killing child for respawn",
                            age, SIDECAR_HEARTBEAT_TIMEOUT_SECS
                        ),
                    );
                    let _ = watchdog_handle.emit(
                        "sidecar-event",
                        serde_json::json!({
                            "type": "sidecar_watchdog_timeout",
                            "last_event_age_secs": age,
                            "threshold_secs": SIDECAR_HEARTBEAT_TIMEOUT_SECS,
                        }),
                    );
                    LAST_SIDECAR_EVENT_SECS.store(now, Ordering::SeqCst);

                    let child_holder = get_child_holder().clone();
                    let mut guard = child_holder.lock().await;
                    if let Some(child) = guard.as_mut() {
                        let _ = child.start_kill();
                    } else if let Some(tx) = RESPAWN_TX.get() {
                        let attempt = RESTART_ATTEMPTS.fetch_add(1, Ordering::SeqCst) + 1;
                        let _ = tx.send(RespawnRequest { delay_secs: 1, attempt });
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
            // Phase 69 (v0.6.13) — frontend → sidecar.log echo bridge
            frontend_log,
            elicitation_response,
            // Phase 87 (v0.6.30) — Git Memory Sync commands
            git_sync_store_credential,
            git_sync_config_update,
            git_sync_now,
            git_sync_resolve_conflict,
            git_sync_status_request,
            // Phase 91 — Memory Sync history viewer
            git_sync_log_request,
            // Phase 90 — SafeMode 주간 통계
            safety_stats_request,
            safety_stats_reset,
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
            // Phase 74 (v0.6.17) — SidePanel 미리보기/외부 열기 — capabilities scope 우회
            open_path,
            read_preview_file,
            codex_login,
            codex_login_status,
            codex_register_mcp,
            codex_fetch_usage,
            // Phase 18 — 의존성 자동 셋업 + First-run 마법사
            is_first_run,
            mark_first_run_complete,
            check_dependencies,
            run_install_deps,
            // Phase 66 (v0.6.1) — K-Personal MCP 자동 설치
            check_kpersonal_mcp,
            install_kpersonal_mcp,
            // Phase 67 (v0.6.2) — MCP 도구 인스펙터 + 카탈로그 + 커스텀 도구 plugin 빌더
            list_mcp_tools,
            list_kda_plugins,
            read_kda_plugin,
            save_kda_plugin,
            delete_kda_plugin,
            // Phase 25 — Portable data dir
            get_data_dir_info,
            change_data_dir,
            // Resources (파일 감시)
            watch_folder,
            get_watched_folders_list,
            unwatch_folder,
            // Phase 59 — Sidecar config (Anthropic rate polling toggle)
            get_sidecar_config,
            set_sidecar_config_flag,
            // Phase 75 (v0.6.18) — Codex 좀비 process detect + 안전 정리
            list_stale_codex_processes,
            kill_process_tree,
            // Phase 80 (v0.6.24) — Final-Review Gate
            read_qa_report,
            // Phase 81 (v0.6.25) — Lee Profile + Memory Auto-Loader
            read_lee_profile,
            open_lee_profile_in_editor
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
