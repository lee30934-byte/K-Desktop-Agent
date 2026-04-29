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

#[tauri::command]
fn quit_app(app: AppHandle) {
    log_lifecycle("shutdown.log", "quit_app invoked (frontend)");
    INTENTIONAL_SHUTDOWN.store(true, Ordering::SeqCst);
    app.exit(0);
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

    let mut command = Command::new(&cmd_name);
    command
        .args(&args)
        .current_dir(&sidecar_dir)
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

    Ok(())
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
