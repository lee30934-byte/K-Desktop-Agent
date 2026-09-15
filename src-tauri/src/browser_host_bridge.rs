//! Shared by the production sidecar stdout loop and the isolated IPC harness.
use crate::browser_host::{BrowserHost, Request};
use serde_json::{json, Value};
use tokio::sync::mpsc;

pub fn route(host: &BrowserHost, app: &tauri::AppHandle, replies: &mpsc::Sender<String>, value: &Value) -> bool {
    if value["type"] != "browser_host_request" { return false; }
    if let Ok(request) = serde_json::from_value::<Request>(value["request"].clone()) {
        let host = host.clone();
        let app = app.clone();
        let replies = replies.clone();
        tokio::spawn(async move {
            let request_id = request.request_id.clone();
            let owner = request.owner.clone();
            let reply = match host.dispatch(app, request).await {
                Ok(status) => json!({"type":"browser_host_reply", "requestId":request_id, "owner":owner, "status":status}),
                Err(error) => json!({"type":"browser_host_reply", "requestId":request_id, "owner":owner, "error":error}),
            };
            let _ = replies.send(format!("{}\n", reply)).await;
        });
    }
    true
}
