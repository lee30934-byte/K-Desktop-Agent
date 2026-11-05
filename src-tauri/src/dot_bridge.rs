//! Opt-in, same-user file IPC. No TCP listener, account token or model API.
//! Each enable creates a fresh session. Claimed requests are never replayed.
use serde_json::{json, Value};
use std::{fs, io::Write, path::{Path, PathBuf}, sync::Mutex, time::{SystemTime, UNIX_EPOCH}};

static STATE: Mutex<Option<Session>> = Mutex::new(None);
struct Session { root: PathBuf, id: String, conversation: String }
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn root() -> PathBuf { super::data_root().join("dot-bridge") }
fn exclusive(path: &Path, value: &Value) -> Result<(), String> {
    let mut f = fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| e.to_string())?;
    f.write_all(value.to_string().as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())
}
fn view(s: Option<&Session>) -> Value {
    json!({"enabled":s.is_some(), "session":s.map(|x|x.id.as_str()), "conversationId":s.map(|x|x.conversation.as_str()),
        "adapterPath":s.map(|x|x.root.join(&x.id).join("adapter.mjs")), "root":root()})
}
fn descriptor(s: &Session) -> Result<(), String> {
    // Readers fail closed on a partial read. Poll retries only read operations.
    fs::write(s.root.join("connection.json"), json!({"version":1,"enabled":true,
        "session":s.id,"conversationId":s.conversation,"heartbeatMs":now()}).to_string()).map_err(|e|e.to_string())
}
#[tauri::command]
pub fn dot_bridge_info() -> Result<Value, String> {
    let state = STATE.lock().map_err(|e|e.to_string())?;
    Ok(view(state.as_ref()))
}
#[tauri::command]
pub fn dot_bridge_pair(conversation_id: Option<String>) -> Result<Value, String> {
    let mut state = STATE.lock().map_err(|e|e.to_string())?;
    if let Some(id) = conversation_id {
        uuid::Uuid::parse_str(&id).map_err(|_|"invalid conversation id")?;
        let s = Session {root:root(), id:uuid::Uuid::new_v4().to_string(), conversation:id};
        fs::create_dir_all(s.root.join(&s.id)).map_err(|e|e.to_string())?;
        // Embed the standalone adapter so installed builds do not depend on a source checkout.
        fs::write(s.root.join(&s.id).join("adapter.mjs"), include_str!("../../scripts/dot-bridge.mjs")).map_err(|e|e.to_string())?;
        descriptor(&s)?;
        *state = Some(s);
    } else {
        fs::create_dir_all(root()).map_err(|e|e.to_string())?;
        fs::write(root().join("connection.json"), json!({"enabled":false}).to_string()).map_err(|e|e.to_string())?;
        *state = None;
    }
    Ok(view(state.as_ref()))
}
fn validate(r: &Value, s: &Session, id: &str, time: u64) -> Result<(), String> {
    if r["id"].as_str()!=Some(id) || r["session"].as_str()!=Some(&s.id) ||
        r["conversationId"].as_str()!=Some(&s.conversation) { return Err("wrong session or conversation".into()); }
    let t=r["createdAt"].as_u64().ok_or("missing timestamp")?;
    if t>time+2000 || time.saturating_sub(t)>15_000 { return Err("request expired; do not auto-retry".into()); }
    match r["action"].as_str() {
        Some("status"|"stop") => {},
        Some("send") => {
            let text=r["text"].as_str().ok_or("missing text")?;
            if text.trim().is_empty() || text.len()>12_000 {return Err("invalid text length".into());}
            if !matches!(r["mode"].as_str(),Some("steer"|"queue")) {return Err("invalid mode".into());}
        },
        _=>return Err("unsupported action".into())
    }
    Ok(())
}
fn scan(s: &Session) -> Result<Vec<Value>,String> {
    let dir=s.root.join(&s.id);
    let mut pending=Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e|e.to_string())? {
        let e=entry.map_err(|e|e.to_string())?;
        let name=e.file_name().to_string_lossy().to_string();
        let Some(id)=name.strip_suffix(".request.json") else {continue};
        if uuid::Uuid::parse_str(id).is_err() || dir.join(format!("{id}.claim.json")).exists() {continue;}
        let meta=fs::symlink_metadata(e.path()).map_err(|e|e.to_string())?;
        if !meta.is_file() || meta.len()>20_000 {continue;}
        let r:Value=match fs::read(e.path()).ok().and_then(|b|serde_json::from_slice(&b).ok()) {Some(v)=>v,None=>continue};
        // The durable claim is written before exposing a mutation to the frontend.
        exclusive(&dir.join(format!("{id}.claim.json")), &json!({"at":now()}))?;
        if let Err(error)=validate(&r,s,id,now()) {
            exclusive(&dir.join(format!("{id}.response.json")), &json!({"id":id,"ok":false,"error":error}))?;
        } else {pending.push(r);}
        if pending.len()>=8 {break;}
    }
    // A stop in the same batch preempts older queued requests in the frontend.
    pending.sort_by_key(|r|(r["action"]!="stop",r["createdAt"].as_u64().unwrap_or(0)));
    Ok(pending)
}
#[tauri::command]
pub fn dot_bridge_poll() -> Result<Vec<Value>, String> {
    let state=STATE.lock().map_err(|e|e.to_string())?;
    let Some(s)=state.as_ref() else {return Ok(vec![])};
    descriptor(s)?;
    scan(s)
}
#[tauri::command]
pub fn dot_bridge_reply(session: String, id: String, result: Value) -> Result<(), String> {
    uuid::Uuid::parse_str(&id).map_err(|_|"invalid request id")?;
    let state=STATE.lock().map_err(|e|e.to_string())?;
    let s=state.as_ref().ok_or("bridge disabled")?;
    if s.id!=session {return Err("bridge session changed".into());}
    let dir=s.root.join(&s.id);
    if !dir.join(format!("{id}.claim.json")).is_file() {return Err("unclaimed request".into());}
    if result.to_string().len()>40_000 {return Err("reply too large".into());}
    exclusive(&dir.join(format!("{id}.response.json")), &response(&id,result))
}
fn response(id:&str,result:Value)->Value {
    let failed=result["state"]=="failed";
    json!({"id":id,"ok":!failed,"error":if failed {result["error"].clone()} else {Value::Null},"result":result})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture()->Session {
        let root=std::env::temp_dir().join(format!("kda-dot-test-{}",uuid::Uuid::new_v4()));
        let s=Session{root,id:uuid::Uuid::new_v4().to_string(),conversation:uuid::Uuid::new_v4().to_string()};
        fs::create_dir_all(s.root.join(&s.id)).unwrap(); s
    }
    fn request(s:&Session)->Value {json!({"id":uuid::Uuid::new_v4().to_string(),"session":s.id,"conversationId":s.conversation,"createdAt":now(),"action":"send","text":"hello","mode":"steer"})}
    #[test] fn failed_execution_is_not_a_successful_receipt() {
        let r=response("id",json!({"state":"failed","error":"stop unconfirmed"}));
        assert_eq!(r["ok"],false);assert_eq!(r["error"],"stop unconfirmed");
        assert_eq!(response("id",json!({"state":"submitted"}))["ok"],true);
    }
    #[test] fn claim_prevents_replay_after_scan() {
        let s=fixture();let r=request(&s);let id=r["id"].as_str().unwrap();
        exclusive(&s.root.join(&s.id).join(format!("{id}.request.json")),&r).unwrap();
        assert_eq!(scan(&s).unwrap().len(),1);assert!(scan(&s).unwrap().is_empty());
    }
    #[test] fn expired_and_foreign_requests_never_dispatch() {
        let s=fixture();let mut r=request(&s);r["conversationId"]=json!("other");
        assert!(validate(&r,&s,r["id"].as_str().unwrap(),now()).is_err());
        r=request(&s);r["createdAt"]=json!(1);
        assert!(validate(&r,&s,r["id"].as_str().unwrap(),now()).is_err());
    }
    #[test] fn invalid_mode_and_text_are_rejected() {
        let s=fixture();let mut r=request(&s);r["mode"]=json!("execute");
        assert!(validate(&r,&s,r["id"].as_str().unwrap(),now()).is_err());
        r["mode"]=json!("steer");r["text"]=json!(" ");
        assert!(validate(&r,&s,r["id"].as_str().unwrap(),now()).is_err());
    }
    #[test] fn node_adapter_native_spool_roundtrip_and_retry_are_at_most_once() {
        use std::process::{Command,Stdio};
        let s=fixture();descriptor(&s).unwrap();
        let adapter=s.root.join(&s.id).join("adapter.mjs");
        fs::write(&adapter,include_str!("../../scripts/dot-bridge.mjs")).unwrap();
        let js=r#"import {pathToFileURL} from 'node:url';
            const {request,connect}=await import(pathToFileURL(process.env.DOT_TEST_ADAPTER));
            const root=process.env.DOT_TEST_ROOT,c=await connect(root);
            const input={action:'send',session:c.session,conversationId:c.conversationId,id:process.env.DOT_TEST_ID,text:'native roundtrip',mode:'steer'};
            const a=await request(root,input),b=await request(root,input);
            if(!a.ok || a.result.state!=='submitted' || JSON.stringify(a)!==JSON.stringify(b)) process.exitCode=2;
            console.log(JSON.stringify(a));"#;
        let mut child=Command::new("node").args(["--input-type=module","-e",js])
            .env("DOT_TEST_ADAPTER",adapter).env("DOT_TEST_ROOT",&s.root)
            .env("DOT_TEST_ID",uuid::Uuid::new_v4().to_string())
            .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let start=now();let mut dispatched=0;
        loop {
            descriptor(&s).unwrap();
            for r in scan(&s).unwrap() {
                dispatched+=1;let id=r["id"].as_str().unwrap();
                exclusive(&s.root.join(&s.id).join(format!("{id}.response.json")),&json!({"id":id,"ok":true,"result":{"state":"submitted"}})).unwrap();
            }
            if child.try_wait().unwrap().is_some() {break;}
            if now()-start>10_000 {child.kill().unwrap();panic!("Node/native roundtrip timed out");}
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        let output=child.wait_with_output().unwrap();
        assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
        assert_eq!(dispatched,1);
    }
}
