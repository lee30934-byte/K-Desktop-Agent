use std::sync::{Arc, Mutex};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;
use tauri::{AppHandle, Emitter, Manager};

/// Sidecar 프로세스 상태를 앱 전역에서 공유
struct SidecarState {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    child: Arc<Mutex<Option<Child>>>,
}

impl SidecarState {
    fn new() -> Self {
        Self {
            stdin: Arc::new(Mutex::new(None)),
            child: Arc::new(Mutex::new(None)),
        }
    }
}

/// 프론트엔드가 호출하는 메시지 전송 커맨드.
/// 메시지를 JSON으로 sidecar stdin에 쓰고, sidecar가 응답을
/// stdout으로 보내면 별도 태스크가 `sidecar-event` 이벤트로 프론트에 중계.
#[tauri::command]
async fn send_message(
    message: String,
    id: String,
    state: tauri::State<'_, SidecarState>,
) -> Result<(), String> {
    let payload = serde_json::json!({
        "type": "user_message",
        "id": id,
        "content": message,
    });

    let line = format!("{}\n", payload.to_string());

    let stdin_arc = state.stdin.clone();
    let mut guard = stdin_arc.lock().map_err(|e| e.to_string())?;
    let stdin = guard.as_mut().ok_or("sidecar not ready")?;

    // AsyncWriteExt::write_all은 async지만 Mutex lock 들고 await는 불가.
    // try_write는 non-blocking이라 여기선 스레드 블로킹 write.
    use std::io::Write as _;
    // 실제로는 ChildStdin의 std 버전이 필요. 아래 spawn_sidecar에서 take_stdin()으로
    // std 버전을 따로 관리하는 방식이 더 깔끔하지만, 일단 tokio ChildStdin 사용하면서
    // blocking_write 대안 사용.
    // ⇒ 본 구현에서는 channel 기반으로 재작성함. 아래 spawn_sidecar 참고.
    // 이 함수는 채널로 보내는 방식으로 바뀔 예정.
    drop(guard);

    // 실제 구현: 채널에 넣어서 writer task가 쓰게 함
    let sender = SIDECAR_TX.get().ok_or("sidecar tx not initialized")?;
    sender.send(line).await.map_err(|e| e.to_string())?;

    Ok(())
}

/// 프론트엔드에서 현재 응답 중단 요청
#[tauri::command]
async fn interrupt(id: String) -> Result<(), String> {
    let payload = serde_json::json!({
        "type": "interrupt",
        "id": id,
    });
    let line = format!("{}\n", payload.to_string());
    let sender = SIDECAR_TX.get().ok_or("sidecar tx not initialized")?;
    sender.send(line).await.map_err(|e| e.to_string())?;
    Ok(())
}

// sidecar stdin writer task와 통신할 mpsc sender를 글로벌에 저장
// (Tauri state보다 간단한 방법 — static OnceCell)
use std::sync::OnceLock;
static SIDECAR_TX: OnceLock<mpsc::Sender<String>> = OnceLock::new();

/// Node sidecar 프로세스를 띄우고, stdout를 읽어서 이벤트로 프론트에 중계
async fn spawn_sidecar(app: AppHandle) -> Result<(), String> {
    // 개발 모드: sidecar/src/index.ts를 tsx로 실행
    // 프로덕션: 번들된 dist/index.js를 node로 실행
    //
    // 개발 편의를 위해 먼저 개발 경로 시도, 실패하면 dist.
    let sidecar_dir = std::env::current_dir()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("no parent dir")?
        .join("sidecar");

    let dev_entry = sidecar_dir.join("src").join("index.ts");
    let prod_entry = sidecar_dir.join("dist").join("index.js");

    let (cmd, args): (&str, Vec<String>) = if dev_entry.exists() {
        (
            "npx",
            vec![
                "tsx".to_string(),
                dev_entry.to_string_lossy().to_string(),
            ],
        )
    } else if prod_entry.exists() {
        ("node", vec![prod_entry.to_string_lossy().to_string()])
    } else {
        return Err(format!(
            "sidecar entry not found at {} or {}",
            dev_entry.display(),
            prod_entry.display()
        ));
    };

    let mut child = Command::new(cmd)
        .args(&args)
        .current_dir(&sidecar_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar: {}", e))?;

    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // writer task: mpsc → stdin
    let (tx, mut rx) = mpsc::channel::<String>(64);
    SIDECAR_TX
        .set(tx)
        .map_err(|_| "SIDECAR_TX already set".to_string())?;

    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if let Err(e) = stdin.write_all(line.as_bytes()).await {
                eprintln!("sidecar stdin write failed: {}", e);
                break;
            }
            if let Err(e) = stdin.flush().await {
                eprintln!("sidecar stdin flush failed: {}", e);
                break;
            }
        }
    });

    // reader task: stdout 라인 → Tauri 이벤트 "sidecar-event"
    let app_clone = app.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(v) => {
                    let _ = app_clone.emit("sidecar-event", v);
                }
                Err(e) => {
                    eprintln!("sidecar stdout parse err: {} — line: {}", e, line);
                }
            }
        }
    });

    // stderr도 읽어서 개발자 콘솔로 (문제 진단용)
    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("[sidecar stderr] {}", line);
        }
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .manage(SidecarState::new())
        .setup(|app| {
            let handle = app.handle().clone();

            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }

            // 백그라운드에서 sidecar 기동
            tauri::async_runtime::spawn(async move {
                if let Err(e) = spawn_sidecar(handle.clone()).await {
                    let _ = handle.emit(
                        "sidecar-event",
                        serde_json::json!({
                            "type": "error",
                            "message": format!("sidecar spawn failed: {}", e),
                        }),
                    );
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![send_message, interrupt])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
