//! Owned WebView2 transport. Remote pages never receive native command permissions.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::Mutex;

const ADAPTER: &str = include_str!("browser_host_adapter.js");
const MAX_TABS: usize = 5;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub request_id: String,
    pub owner: String,
    pub action: String,
    pub prompt: Option<String>,
}
struct Lease { label: String, sent: bool, status: Value, trace: Trace }
#[derive(Clone, Default)]
struct Trace(Arc<std::sync::Mutex<std::collections::VecDeque<Value>>>);
impl Trace {
    fn record(&self, label: &str, event: &str, url: Option<&url::Url>) {
        if let Ok(mut events) = self.0.lock() {
            if events.len() == 256 { events.pop_front(); }
            events.push_back(json!({"atMs":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
                "window":label,"event":event,"site":url.map(site),
                "destination":url.map(destination_diagnostic)}));
        }
    }
    fn snapshot(&self) -> Value {
        match self.0.lock() { Ok(events) => json!(*events), Err(_) => json!({"error":"trace-unavailable"}) }
    }
    fn watch_window(&self, window: &WebviewWindow) {
        let trace = self.clone();
        let label = window.label().to_owned();
        window.on_window_event(move |event| match event {
            tauri::WindowEvent::CloseRequested { .. } => trace.record(&label, "close-requested", None),
            tauri::WindowEvent::Destroyed => trace.record(&label, "destroyed", None),
            _ => {}
        });
    }
}
// Fixed categories only: never retain paths, queries, fragments, titles or arbitrary hosts.
fn site(url: &url::Url) -> &'static str {
    if url.as_str() == "about:blank" { return "blank"; }
    if !allowed(url) { return "other"; }
    match url.host_str() {
        Some("chatgpt.com") => "chatgpt",
        Some("accounts.google.com") => "google-auth",
        Some("login.microsoftonline.com") => "microsoft-auth",
        Some("appleid.apple.com" | "idmsa.apple.com") => "apple-auth",
        _ => "openai-auth"
    }
}
fn unverified_auth(url: &url::Url) -> Value {
    json!({"phase":"login-required", "authenticated":null,"authState":"unverified","site":site(url)})
}
// Only fixed public destinations and fixed reason codes may leave the native host.
// Never export arbitrary subdomains, credentials, paths, queries or fragments.
fn destination_diagnostic(url: &url::Url) -> Value {
    let scheme = match url.scheme() {
        "https" => "https", "http" => "http", "about" => "about",
        "data" => "data", "blob" => "blob", "javascript" => "javascript",
        "file" => "file", _ => "other",
    };
    let host = match url.host_str() {
        Some(h @ ("chatgpt.com" | "auth.openai.com" | "auth0.openai.com" |
            "login.openai.com" | "accounts.openai.com" | "accounts.google.com" |
            "google.com" | "www.google.com" | "accounts.google.co.kr" |
            "google.co.kr" | "www.google.co.kr" | "accounts.youtube.com" |
            "youtube.com" | "www.youtube.com" | "myaccount.google.com" |
            "oauth.googleusercontent.com" | "consent.google.com" |
            "login.microsoftonline.com" | "appleid.apple.com" | "idmsa.apple.com")) => h,
        None => "none", _ => "redacted",
    };
    let reason = if url.as_str() == "about:blank" { "blank-document" }
        else if url.scheme() != "https" { "scheme-not-https" }
        else if url.port_or_known_default() != Some(443) { "port-not-443" }
        else if !url.username().is_empty() || url.password().is_some() { "url-credentials" }
        else if !allowed(url) { "host-not-allowed" }
        else { "allowed" };
    json!({"scheme":scheme,"knownHost":host,"policyReason":reason})
}
#[derive(Clone, Default)]
pub struct BrowserHost { leases: Arc<Mutex<HashMap<String, Lease>>>, closed: Arc<AtomicBool> }

fn allowed(url: &url::Url) -> bool {
    url.scheme() == "https" && url.port_or_known_default() == Some(443)
        && url.username().is_empty() && url.password().is_none()
        && matches!(url.host_str(), Some("chatgpt.com" | "auth.openai.com" |
            "auth0.openai.com" | "login.openai.com" | "accounts.openai.com" |
            "accounts.google.com" | "login.microsoftonline.com" |
            "appleid.apple.com" | "idmsa.apple.com"))
}
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b))
}
fn profile(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // Explicit override is only for the isolated native test runner; never import cookies.
    if let Some(path) = std::env::var_os("KDA_WEBVIEW2_PROFILE") {
        let path = PathBuf::from(path);
        if !path.is_absolute() { return Err("profile-must-be-absolute".into()); }
        return Ok(path);
    }
    app.path().app_local_data_dir().map(|p| p.join("chatgpt-webview2")).map_err(|e| e.to_string())
}
async fn evaluate(w: &WebviewWindow, method: &str, prompt: Option<&str>) -> Result<Value, String> {
    let url = w.url().map_err(|e| e.to_string())?;
    if !allowed(&url) || url.host_str() != Some("chatgpt.com") {
        return Ok(unverified_auth(&url));
    }
    let arg = serde_json::to_string(&prompt).map_err(|e| e.to_string())?;
    let script = format!("(() => {{ if (!window.__kdaPort) {{ {ADAPTER} }} return window.__kdaPort.{method}({arg}); }})()");
    let (tx, rx) = tokio::sync::oneshot::channel();
    let sender = std::sync::Mutex::new(Some(tx));
    w.eval_with_callback(script, move |raw| {
        if let Ok(mut sender) = sender.lock() { if let Some(tx) = sender.take() { let _ = tx.send(raw); } }
    }).map_err(|e| e.to_string())?;
    let raw = tokio::time::timeout(Duration::from_secs(8), rx).await
        .map_err(|_| "browser-evaluation-timeout")?.map_err(|_| "browser-evaluation-closed")?;
    if raw.len() > 2_000_000 { return Err("browser-result-too-large".into()); }
    serde_json::from_str(&raw).map_err(|_| "invalid-browser-result".into())
}

impl BrowserHost {
    async fn close_label(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
        for (name, w) in app.webview_windows() {
            if name == label || name.starts_with(&format!("{label}-auth-")) {
                w.destroy().map_err(|e| e.to_string())?;
            }
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            if !app.webview_windows().keys().any(|name| name == label || name.starts_with(&format!("{label}-auth-"))) { return Ok(()); }
            if tokio::time::Instant::now() >= deadline { return Err("browser-destruction-unconfirmed".into()); }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    pub async fn shutdown(&self, app: &tauri::AppHandle) {
        self.closed.store(true, Ordering::SeqCst);
        let mut leases = self.leases.lock().await;
        for lease in leases.values_mut() {
            let result = Self::close_label(app, &lease.label).await;
            lease.status = json!({"phase":"cancelled", "cleanupConfirmed":result.is_ok()});
        }
        leases.clear();
    }

    pub async fn dispatch(&self, app: tauri::AppHandle, r: Request) -> Result<Value, String> {
        if !valid_id(&r.owner) || !valid_id(&r.request_id) { return Err("invalid-browser-request-identity".into()); }
        let mut leases = self.leases.lock().await;
        if self.closed.load(Ordering::SeqCst) { return Err("browser-host-closed".into()); }
        if r.action == "open" {
            if let Some(lease) = leases.get(&r.owner) { return Ok(lease.status.clone()); }
            if leases.len() >= MAX_TABS { return Err("browser-capacity-reached".into()); }
            let label = format!("kda-web-{}", uuid::Uuid::new_v4());
            let popup_label = label.clone();
            let popup_app = app.clone();
            let trace = Trace::default();
            let nav_trace = trace.clone(); let nav_label = label.clone();
            let load_trace = trace.clone();
            let popup_trace = trace.clone();
            let data_dir = profile(&app)?;
            std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
            let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External("https://chatgpt.com/?temporary-chat=true".parse().unwrap()))
                .title("KDA ChatGPT WebView2").inner_size(1050., 780.)
                .data_directory(data_dir).initialization_script(ADAPTER)
                .on_navigation(move |url| { let ok = allowed(url); nav_trace.record(&nav_label, if ok { "navigation-allowed" } else { "navigation-denied" }, Some(url)); ok })
                .on_page_load(move |w, payload| { load_trace.record(w.label(), match payload.event() { tauri::webview::PageLoadEvent::Started => "load-started", tauri::webview::PageLoadEvent::Finished => "load-finished" }, Some(payload.url())); })
                .on_new_window(move |url, features| {
                    popup_trace.record(&popup_label, "popup-requested", Some(&url));
                    if !allowed(&url) { popup_trace.record(&popup_label, "popup-denied", Some(&url)); return tauri::webview::NewWindowResponse::Deny; }
                    // This callback must return the created WebView2 synchronously per Tauri's API.
                    // Native OAuth popup execution is an explicit remaining validation gate.
                    let label = format!("{popup_label}-auth-{}", uuid::Uuid::new_v4());
                    let nav_trace = popup_trace.clone(); let nav_label = label.clone();
                    let load_trace = popup_trace.clone();
                    let data_dir = match profile(&popup_app) { Ok(p) => p, Err(_) => return tauri::webview::NewWindowResponse::Deny };
                    match WebviewWindowBuilder::new(&popup_app, &label, WebviewUrl::External("about:blank".parse().unwrap()))
                        .window_features(features).data_directory(data_dir).title("KDA ChatGPT 인증")
                        .on_navigation(move |url| { let ok = url.as_str() == "about:blank" || allowed(url); nav_trace.record(&nav_label, if ok { "navigation-allowed" } else { "navigation-denied" }, Some(url)); ok })
                        .on_page_load(move |w, payload| { load_trace.record(w.label(), match payload.event() { tauri::webview::PageLoadEvent::Started => "load-started", tauri::webview::PageLoadEvent::Finished => "load-finished" }, Some(payload.url())); }).build() {
                        Ok(window) => { popup_trace.record(&label, "popup-created", None); popup_trace.watch_window(&window); tauri::webview::NewWindowResponse::Create { window } },
                        Err(_) => { popup_trace.record(&label, "popup-build-failed", None); tauri::webview::NewWindowResponse::Deny },
                    }
                }).build().map_err(|e| e.to_string())?;
            trace.record(&label, "window-created", None);
            trace.watch_window(&window);
            let status = json!({"phase":"login-required"});
            leases.insert(r.owner, Lease { label, sent: false, status: status.clone(), trace });
            return Ok(status);
        }
        let lease = leases.get_mut(&r.owner).ok_or("browser-owner-not-found")?;
        if r.action == "diagnostics" {
            let windows: Vec<_> = app.webview_windows().into_iter().filter(|(name, _)| name == &lease.label || name.starts_with(&format!("{}-auth-", lease.label)))
                .map(|(name, w)| json!({"window":name,"site":w.url().ok().as_ref().map(site),"visible":w.is_visible().ok()})).collect();
            return Ok(json!({"events":lease.trace.snapshot(),"windows":windows}));
        }
        if r.action == "close" {
            Self::close_label(&app, &lease.label).await?;
            leases.remove(&r.owner);
            return Ok(json!({"phase":"closed", "cleanupConfirmed":true}));
        }
        if r.action == "status" && matches!(lease.status["phase"].as_str(), Some("completed" | "cancelled" | "failed")) {
            return Ok(lease.status.clone());
        }
        let w = app.get_webview_window(&lease.label).ok_or("browser-window-closed")?;
        match r.action.as_str() {
            "show" => { w.show().map_err(|e| e.to_string())?; return Ok(json!({"visible":true})); }
            "hide" => { w.hide().map_err(|e| e.to_string())?; return Ok(json!({"visible":false})); }
            "status" => {
                let status = evaluate(&w, "snapshot", None).await?;
                lease.status = status.clone();
                return Ok(status);
            }
            "stop" => {
                // Destruction is authoritative cancellation even when the site's Stop UI is absent.
                let _ = evaluate(&w, "stop", None).await;
                Self::close_label(&app, &lease.label).await?;
                lease.status = json!({"phase":"cancelled", "cleanupConfirmed":true});
                return Ok(lease.status.clone());
            }
            "send" => {
                if lease.sent { return Err("browser-resubmission-blocked".into()); }
                let prompt = r.prompt.as_deref().ok_or("missing-browser-prompt")?;
                if prompt.trim().is_empty() || prompt.len() > 120_000 { return Err("invalid-browser-prompt-size".into()); }
                let status = evaluate(&w, "snapshot", None).await?;
                if status["phase"] != "ready" { return Err("browser-not-ready".into()); }
                lease.sent = true; // Irreversible submission fence precedes IPC; errors cannot permit resend.
                let owner = r.owner.clone();
                let owned_label = lease.label.clone();
                let host = self.clone();
                let watchdog_app = app.clone();
                // Backend-owned deadline and cleanup, independent of frontend/sidecar polling.
                tauri::async_runtime::spawn(async move {
                    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
                    loop {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        let mut leases = host.leases.lock().await;
                        let Some(lease) = leases.get_mut(&owner) else { break };
                        if lease.label != owned_label { break; } // Old watchdog cannot touch a new owner lease.
                        if lease.status["phase"] == "cancelled" { break; }
                        let status = if tokio::time::Instant::now() >= deadline {
                            json!({"phase":"failed", "error":"browser-turn-timeout"})
                        } else if let Some(w) = watchdog_app.get_webview_window(&lease.label) {
                            evaluate(&w, "snapshot", None).await.unwrap_or_else(|_| json!({"phase":"failed","error":"browser-probe-failed"}))
                        } else { json!({"phase":"failed","error":"browser-window-closed"}) };
                        let terminal = matches!(status["phase"].as_str(), Some("completed" | "cancelled" | "failed"));
                        lease.status = status;
                        if terminal {
                            let cleanup = Self::close_label(&watchdog_app, &lease.label).await;
                            lease.status["cleanupConfirmed"] = json!(cleanup.is_ok());
                            if cleanup.is_err() { lease.status["phase"] = json!("failed"); lease.status["error"] = json!("browser-cleanup-failed"); }
                            break;
                        }
                    }
                });
                let value = evaluate(&w, "send", Some(prompt)).await?;
                lease.status = value.clone();
                Ok(value)
            }
            _ => Err("unsupported-browser-action".into()),
        }
    }
}

#[tauri::command]
pub async fn browser_host_request(app: tauri::AppHandle, window: WebviewWindow, request: Request) -> Result<Value, String> {
    let url = window.url().map_err(|e| e.to_string())?;
    let local = window.label() == "main" && (url.as_str().starts_with("tauri://localhost/")
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost") && url.port().is_none()));
    if !local { return Err("browser-control-origin-denied".into()); }
    app.state::<BrowserHost>().inner().clone().dispatch(app.clone(), request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn denied_navigation_diagnostics_identify_fixed_destinations_only() {
        for (raw, host, reason) in [
            ("https://accounts.youtube.com/secret?code=secret#secret", "accounts.youtube.com", "host-not-allowed"),
            ("https://accounts.google.co.kr/secret", "accounts.google.co.kr", "host-not-allowed"),
            ("https://secret.accounts.google.com/secret", "redacted", "host-not-allowed"),
            ("https://accounts.google.com.evil.test/secret", "redacted", "host-not-allowed"),
            ("https://secret:secret@accounts.google.com/secret", "accounts.google.com", "url-credentials"),
            ("https://accounts.google.com:444/secret", "accounts.google.com", "port-not-443"),
            ("secret-scheme:secret", "none", "scheme-not-https"),
            ("about:blank", "none", "blank-document"),
        ] {
            let url = url::Url::parse(raw).unwrap();
            let trace = Trace::default();
            trace.record("test-window", "navigation-denied", Some(&url));
            let snapshot = trace.snapshot();
            assert_eq!(snapshot[0]["destination"]["knownHost"], host);
            assert_eq!(snapshot[0]["destination"]["policyReason"], reason);
            assert!(!snapshot.to_string().contains("secret"));
            assert!(!allowed(&url));
        }
    }
    #[test] fn auth_trace_drops_url_secrets_and_bounds_retention() {
        let trace = Trace::default();
        let url = url::Url::parse("https://accounts.google.com/secret-path?code=secret-code#secret-fragment").unwrap();
        for _ in 0..300 { trace.record("test-window", "navigation-allowed", Some(&url)); }
        let data = trace.snapshot();
        assert_eq!(data.as_array().unwrap().len(), 256);
        assert_eq!(data[0]["site"], "google-auth");
        assert!(!data.to_string().contains("secret"));
        let spoof = url::Url::parse("https://secret-host.example/secret-path").unwrap();
        assert_eq!(site(&spoof), "other");
    }
    #[test] fn authentication_navigation_is_not_logout_evidence() {
        let url = url::Url::parse("https://accounts.google.com/login").unwrap();
        let status = unverified_auth(&url);
        assert!(status["authenticated"].is_null());
        assert_eq!(status["authState"], "unverified");
        assert_ne!(status["phase"], "ready");
    }
    #[test] fn navigation_rejects_local_and_spoofed_origins() {
        for raw in ["http://chatgpt.com", "https://chatgpt.com:444", "https://chatgpt.com.evil.test", "https://user@chatgpt.com", "https://127.0.0.1", "file:///C:/test"] {
            assert!(!allowed(&url::Url::parse(raw).unwrap()));
        }
        assert!(allowed(&url::Url::parse("https://accounts.google.com/login").unwrap()));
    }
    #[test] fn owner_identifiers_cannot_be_paths() {
        for id in ["", "../a", "a/b", "a b"] { assert!(!valid_id(id)); }
        assert!(valid_id("conversation:123_turn-456"));
    }
}
