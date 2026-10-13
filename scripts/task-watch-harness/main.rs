//! Offline test driver: same Rust delivery code, real files, no Tauri or model process.
#[path = "../../src-tauri/src/task_watch_recovery.rs"]
mod recovery;
use serde_json::{json, Value};
use std::{io::Read, path::Path};
fn main() {
    let mut input = String::new(); std::io::stdin().read_to_string(&mut input).unwrap();
    let q: Value = serde_json::from_str(&input).unwrap();
    let path = Path::new(q["path"].as_str().unwrap_or(""));
    let now = q["now"].as_i64().unwrap_or(0);
    let turn = q["turn"].as_str().unwrap_or("");
    let conv = q["conversation"].as_str().unwrap_or("chat");
    let session = q["session"].as_str().unwrap_or("app-one");
    let r: Result<Value, String> = match q["op"].as_str().unwrap() {
        "write" => recovery::write(path, &q["marker"]).map(|_| Value::Null),
        "read" => recovery::read(path),
        "view" => recovery::read(path).map(|m| recovery::view(&m, now, session)),
        "claim" => recovery::claim(path, turn, conv, now, session).map(|_| Value::Null),
        "release" => recovery::release(path, turn, q["error"].as_str().unwrap(), now),
        "result" => recovery::record_result(path, turn, q["text"].as_str().unwrap(), now).map(|_| Value::Null),
        "ack" => recovery::ack(path, turn).map(|_| Value::Null),
        "classify" => Ok(json!(recovery::classify(q["error"].as_str().unwrap()))),
        "observation" => recovery::read(path).map(|m| json!(recovery::observation_block(&m, q["timeout"].as_bool().unwrap_or(false), |_| q["alive"].as_bool().unwrap_or(false)))),
        _ => Err("unknown operation".into()),
    };
    match r { Ok(value) => println!("{}", json!({"ok":true,"value":value})), Err(error) => println!("{}", json!({"ok":false,"error":error})) }
}
