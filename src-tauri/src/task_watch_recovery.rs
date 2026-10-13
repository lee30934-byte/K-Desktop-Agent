//! Durable delivery state. Retrying a notification never launches its producer again.
use serde_json::{json, Value};
use std::path::Path;
pub const MAX_ATTEMPTS: u64 = 5;

/// Fresh, local evidence is checked again at claim time, after frontend awaits.
pub fn observation_block(marker: &Value, timeout: bool, alive: impl Fn(u32) -> bool) -> Option<&'static str> {
    if marker["run"]["pid"].as_u64().is_some_and(|pid| pid > 0 && alive(pid as u32)) { return Some("producer-still-running"); }
    let complete = match marker["watch"]["type"].as_str() {
        Some("file") => marker["watch"]["path"].as_str().is_some_and(|p| Path::new(p).is_file()),
        Some("pid") => marker["watch"]["pid"].as_u64().is_some_and(|pid| pid > 0 && pid <= u32::MAX as u64 && !alive(pid as u32)),
        _ => false,
    };
    if complete || (timeout && marker.get("_delivery").is_none()) { None } else { Some("watch-condition-missing") }
}

pub fn classify(error: &str) -> &'static str {
    let e = error.to_lowercase();
    // Denials/stops/authentication win even if a transport word is also present.
    if ["사용자가 정지", "user stop", "cancelled", "canceled", "rejected", "denied", "approval", "승인", "unauthorized", "forbidden", "authentication", "quota", "usage limit", "billing"].iter().any(|s| e.contains(s)) { return "requires-user"; }
    if ["selected model is at capacity", "model is at capacity", "server overloaded", "service unavailable", "http 503", "status 503"].iter().any(|s| e.contains(s)) { return "capacity"; }
    if ["econnreset", "econnrefused", "etimedout", "connection reset", "connection closed", "websocket disconnected", "stream disconnected before completion", "transport error", "network error"].iter().any(|s| e.contains(s)) { return "transport"; }
    "requires-user"
}

pub fn read(path: &Path) -> Result<Value, String> {
    let s = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(s.trim_start_matches('\u{feff}')).map_err(|e| e.to_string())
}
pub fn write(path: &Path, marker: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(marker).map_err(|e| e.to_string())?;
    // Keep the old file until the replacement has reached disk (rename replaces atomically).
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let temp = path.with_extension(format!("pending-{}-{}", std::process::id(), nonce));
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e| e.to_string())?;
    use std::io::Write;
    f.write_all(&bytes).and_then(|_| f.sync_all()).map_err(|e| e.to_string())?;
    drop(f);
    std::fs::rename(&temp, path).map_err(|e| e.to_string())
}

pub fn view(marker: &Value, now: i64, session: &str) -> Value {
    let mut d = marker.get("_delivery").cloned().unwrap_or(json!({"state":"ready","attempts":0}));
    if d["result"].is_object() { d["state"] = json!("result_ready"); return d; }
    match d["state"].as_str().unwrap_or("ready") {
        "claimed" => {
            if d["session"].as_str() != Some(session) {
                // A crash might have happened after a tool write. No blind replay of ambiguous work.
                d["state"] = json!("blocked"); d["reason"] = json!("interrupted-delivery-review");
            }
        }
        "retry_wait" => {
            let kind = classify(d["lastError"].as_str().unwrap_or(""));
            if kind == "requires-user" { d["state"] = json!("blocked"); d["reason"] = json!(kind); }
            else if d["attempts"].as_u64().unwrap_or(0) >= MAX_ATTEMPTS { d["state"] = json!("exhausted"); d["reason"] = json!("retry-exhausted"); }
            else if now >= d["nextAttemptAt"].as_i64().unwrap_or(0) { d["state"] = json!("ready"); }
        }
        _ => {}
    }
    d
}

pub fn claim(path: &Path, turn: &str, conversation: &str, now: i64, session: &str) -> Result<(), String> {
    let mut m = read(path)?;
    let d = view(&m, now, session);
    if d["state"] != "ready" { return Err(format!("delivery not ready: {}", d["state"])); }
    if let Some(expected) = m["conversationId"].as_str().or(m["_delivery"]["conversationId"].as_str()) {
        if expected != conversation { return Err("delivery conversation mismatch".into()); }
    }
    let attempts = d["attempts"].as_u64().unwrap_or(0);
    if attempts >= MAX_ATTEMPTS { return Err("retry budget exhausted".into()); }
    m["_delivery"] = json!({"state":"claimed","turnId":turn,"conversationId":conversation,"claimedAt":now,"attempts":attempts+1,"session":session});
    write(path, &m)
}

pub fn release(path: &Path, turn: &str, error: &str, now: i64) -> Result<Value, String> {
    let mut m = read(path)?;
    let mut d = m["_delivery"].clone();
    if d["turnId"].as_str() != Some(turn) { return Err("task-watch release owner mismatch".into()); }
    // Repeated terminal events must not postpone the backoff or consume attempts.
    if d["state"] != "claimed" && !d["result"].is_object() { return Ok(d); }
    if d["result"].is_object() { d["state"] = json!("result_ready"); }
    else {
        let attempts = d["attempts"].as_u64().unwrap_or(1);
        let kind = classify(error);
        d["state"] = json!(if kind == "requires-user" {"blocked"} else if attempts >= MAX_ATTEMPTS {"exhausted"} else {"retry_wait"});
        d["reason"] = json!(if attempts >= MAX_ATTEMPTS && kind != "requires-user" {"retry-exhausted"} else {kind});
        d["lastError"] = json!(error.chars().take(1000).collect::<String>());
        d["nextAttemptAt"] = if d["state"] == "retry_wait" { json!(now + 30_000 * (1_i64 << attempts.saturating_sub(1).min(4))) } else { Value::Null };
    }
    m["_delivery"] = d.clone(); write(path, &m)?; Ok(d)
}

pub fn record_result(path: &Path, turn: &str, text: &str, now: i64) -> Result<(), String> {
    if text.trim().is_empty() { return Err("empty task-watch result".into()); }
    let mut m = read(path)?;
    if m["_delivery"]["turnId"].as_str() != Some(turn) { return Err("result owner mismatch".into()); }
    if m["_delivery"]["state"] != "claimed" && m["_delivery"]["state"] != "result_ready" { return Err("result after terminal failure".into()); }
    m["_delivery"]["result"] = json!({"text":text,"savedAt":now});
    m["_delivery"]["state"] = json!("result_ready");
    write(path, &m)
}

pub fn ack(path: &Path, turn: &str) -> Result<(), String> {
    if !path.exists() { return Ok(()); }
    let m = read(path)?;
    if m["_delivery"]["turnId"].as_str() != Some(turn) { return Err("task-watch ack owner mismatch".into()); }
    if m["_delivery"]["state"] != "result_ready" { return Err("task-watch ack requires saved result".into()); }
    std::fs::remove_file(path).map_err(|e| e.to_string())
}
