use std::time::Duration;
use tokio::process::{Child, Command};

/// A successful return requires a successful tree kill and confirmed root exit.
pub async fn stop_process_tree(child: &mut Child) -> Result<(), String> {
    if let Some(pid) = child.id() {
        let mut kill = Command::new("taskkill");
        kill.args(["/F", "/T", "/PID", &pid.to_string()]);
        #[cfg(windows)]
        kill.creation_flags(0x08000000);
        kill.kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(10), kill.output()).await
            .map_err(|_| "프로세스 트리 종료 시간 초과 · 잠금 유지".to_string())?
            .map_err(|e| format!("프로세스 트리 종료 실패: {e}"))?;
        if !output.status.success() {
            return Err("프로세스 트리 종료를 확인하지 못했습니다 · 잠금 유지".into());
        }
    }
    tokio::time::timeout(Duration::from_secs(5), child.wait()).await
        .map_err(|_| "실행 엔진 종료 확인 시간 초과 · 잠금 유지".to_string())?
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, BufReader};

    #[tokio::test]
    async fn kills_isolated_unresponsive_engine_and_its_descendant() {
        // The fixture never reads stdin; recovery must work without a cooperative engine.
        let mut fixture = Command::new("node");
        fixture.args(["-e", "const {spawn}=require('node:child_process');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});console.log(p.pid);setInterval(()=>{},1000)"])
            .creation_flags(0x08000000).stdin(Stdio::piped()).stdout(Stdio::piped()).kill_on_drop(true);
        let mut child = fixture.spawn().expect("isolated engine fixture");
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let descendant: u32 = tokio::time::timeout(Duration::from_secs(10), lines.next_line()).await
            .unwrap().unwrap().unwrap().parse().unwrap();
        stop_process_tree(&mut child).await.unwrap();
        assert!(child.try_wait().unwrap().is_some());
        let output = Command::new("tasklist").args(["/FI", &format!("PID eq {descendant}"), "/FO", "CSV", "/NH"])
            .creation_flags(0x08000000).output().await.unwrap();
        assert!(!String::from_utf8_lossy(&output.stdout).contains(&format!("\"{descendant}\"")), "descendant survived recovery");
    }
}
