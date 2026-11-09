//! v0.7.84 — 설치 완료 검사와 재설치(복구).
//!
//! 배경 (2026-11-09): v0.7.83 설치를 K 가 중간에 취소했더니 실행 파일만 새 버전이고
//! `sidecar/hooks` 등은 옛 파일로 남았다. 앱은 실행 파일 버전만 보고 "설치 완료" 로 기록했다.
//!
//! 구조:
//!   1. NSIS 설치기(installer-hooks.nsh)가 시작할 때 `install-complete.txt` 를 지우고,
//!      모든 파일·레지스트리·바로가기 작업이 끝난 마지막 단계에서 버전을 적어 다시 만든다.
//!   2. 앱은 시작할 때 이 표시를 읽어 `complete` / `incomplete` / `dev` 를 판정하고
//!      `<data_root>/install-integrity.json` 에 기록한다 (`evaluate` 는 순수 함수).
//!   3. 불완전하면 화면에 알리고, [다시 설치] 또는 자동 설치 흐름에서 `repair` 를 부른다.
//!      repair 는 GitHub 릴리즈에서 설치 파일과 `.sig` 를 받아(직접 주소 → 실패 시 API 경로)
//!      **업데이터와 같은 공개키로 서명을 검증한 뒤에만** 실행한다. 검증 실패면 실행하지 않는다.
//!   4. 자동 재시도는 버전마다 최대 `MAX_AUTO_ATTEMPTS` 회 (`install-repair.json`). 무한 반복 금지.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const MARKER_FILE: &str = "install-complete.txt";
pub const STATUS_FILE: &str = "install-integrity.json";
pub const REPAIR_FILE: &str = "install-repair.json";
pub const MAX_AUTO_ATTEMPTS: u64 = 2;
pub const REPO: &str = "lee30934-byte/K-Desktop-Agent";

/// 설치 폴더가 NSIS 로 설치된 것인지 (dev 빌드 구분). 제거 프로그램이 있으면 설치본.
pub fn is_packaged(install_dir: &Path) -> bool {
    install_dir.join("uninstall.exe").exists()
}

/// 순수 판정. marker = 설치 완료 표시 파일 내용 (없으면 None).
pub fn evaluate(app_version: &str, marker: Option<&str>, packaged: bool) -> Value {
    if !packaged {
        return json!({ "state": "dev", "appVersion": app_version });
    }
    let marker_version = marker.map(|m| m.trim_start_matches('\u{feff}').trim().to_string());
    let (state, reason) = match marker_version.as_deref() {
        None => ("incomplete", "설치 완료 표시가 없습니다 (설치가 중간에 취소됐거나 실패)"),
        Some(v) if v == app_version => ("complete", ""),
        Some(_) => ("incomplete", "설치 완료 표시의 버전이 실행 파일 버전과 다릅니다"),
    };
    let mut out = json!({
        "state": state,
        "appVersion": app_version,
        "markerVersion": marker_version,
    });
    if !reason.is_empty() {
        out["reason"] = json!(reason);
    }
    out
}

pub fn check(app_version: &str, install_dir: &Path) -> Value {
    let marker = std::fs::read_to_string(install_dir.join(MARKER_FILE)).ok();
    evaluate(app_version, marker.as_deref(), is_packaged(install_dir))
}

pub fn read_json(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok())
        .unwrap_or(Value::Null)
}

pub fn write_json(path: &Path, v: &Value) -> Result<(), String> {
    if let Some(p) = path.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(v).unwrap_or_default())
        .map_err(|e| format!("{} 쓰기 실패: {}", tmp.display(), e))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{} 교체 실패: {}", path.display(), e))
}

/// 이 버전의 자동 복구 시도 횟수 (다른 버전 기록은 0 으로 본다).
pub fn auto_attempts(repair: &Value, version: &str) -> u64 {
    if repair.get("version").and_then(|v| v.as_str()) == Some(version) {
        repair.get("autoAttempts").and_then(|v| v.as_u64()).unwrap_or(0)
    } else {
        0
    }
}

pub fn installer_name(version: &str) -> String {
    format!("K.Desktop.Agent_{}_x64-setup.exe", version)
}

pub fn valid_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// Tauri 업데이터와 같은 방식으로 서명 검증. pubkey/sig 는 둘 다 base64 로 감싼 minisign 텍스트.
pub fn verify_signature(data: &[u8], sig_b64: &str, pubkey_b64: &str) -> Result<(), String> {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    let pk_text = String::from_utf8(b64.decode(pubkey_b64.trim()).map_err(|e| format!("공개키 base64 오류: {}", e))?)
        .map_err(|e| format!("공개키 UTF-8 오류: {}", e))?;
    let sig_text = String::from_utf8(b64.decode(sig_b64.trim()).map_err(|e| format!("서명 base64 오류: {}", e))?)
        .map_err(|e| format!("서명 UTF-8 오류: {}", e))?;
    let pk = minisign_verify::PublicKey::decode(&pk_text).map_err(|e| format!("공개키 해석 실패: {}", e))?;
    let sig = minisign_verify::Signature::decode(&sig_text).map_err(|e| format!("서명 해석 실패: {}", e))?;
    pk.verify(data, &sig, true).map_err(|e| format!("서명 검증 실패: {}", e))
}

async fn get_bytes(client: &reqwest::Client, url: &str, accept: Option<&str>) -> Result<Vec<u8>, String> {
    let mut req = client.get(url).header("User-Agent", "K-Desktop-Agent-repair");
    if let Some(a) = accept {
        req = req.header("Accept", a);
    }
    let resp = req.send().await.map_err(|e| format!("{} 요청 실패: {}", url, e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("{} → HTTP {}", url, status.as_u16()));
    }
    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| format!("{} 본문 수신 실패: {}", url, e))
}

/// 설치 파일과 서명을 받는다. 1순위 releases/download 직접 주소, 실패하면 GitHub API 자산 경로.
/// (2026-11-09: 다운로드 서버만 504 이고 API 는 정상이었던 장애 대비)
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("HTTP 클라이언트 생성 실패: {}", e))
}

pub async fn download_installer(version: &str) -> Result<(Vec<u8>, String, &'static str), String> {
    let client = http_client()?;
    match download_direct(&client, version).await {
        Ok((exe, sig)) => Ok((exe, sig, "direct")),
        Err(direct_err) => download_via_api(&client, version)
            .await
            .map(|(exe, sig)| (exe, sig, "api"))
            .map_err(|e| format!("직접 주소 실패({}) / API 경로 실패({})", direct_err, e)),
    }
}

async fn download_direct(client: &reqwest::Client, version: &str) -> Result<(Vec<u8>, String), String> {
    let name = installer_name(version);
    let base = format!("https://github.com/{}/releases/download/v{}/", REPO, version);
    let exe = get_bytes(client, &format!("{}{}", base, name), None).await?;
    let sig = get_bytes(client, &format!("{}{}.sig", base, name), None).await?;
    Ok((exe, String::from_utf8_lossy(&sig).to_string()))
}

async fn download_via_api(client: &reqwest::Client, version: &str) -> Result<(Vec<u8>, String), String> {
    let name = installer_name(version);
    let api = format!("https://api.github.com/repos/{}/releases/tags/v{}", REPO, version);
    let meta = get_bytes(client, &api, Some("application/vnd.github+json")).await?;
    let meta: Value = serde_json::from_slice(&meta).map_err(|e| format!("릴리즈 정보 해석 실패: {}", e))?;
    let asset_url = |n: &str| -> Option<String> {
        meta.get("assets")?.as_array()?.iter().find(|a| a.get("name").and_then(|x| x.as_str()) == Some(n))?
            .get("url")?.as_str().map(|s| s.to_string())
    };
    let exe_url = asset_url(&name).ok_or_else(|| format!("릴리즈 v{} 에 {} 없음", version, name))?;
    let sig_url = asset_url(&format!("{}.sig", name)).ok_or_else(|| format!("릴리즈 v{} 에 서명 없음", version))?;
    let exe = get_bytes(client, &exe_url, Some("application/octet-stream")).await?;
    let sig = get_bytes(client, &sig_url, Some("application/octet-stream")).await?;
    Ok((exe, String::from_utf8_lossy(&sig).to_string()))
}

pub fn installer_cache_path(data_root: &Path, version: &str) -> PathBuf {
    data_root.join("installers").join(installer_name(version))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_build_is_not_flagged() {
        assert_eq!(evaluate("0.7.84", None, false)["state"], "dev");
    }

    #[test]
    fn missing_marker_is_incomplete() {
        let v = evaluate("0.7.84", None, true);
        assert_eq!(v["state"], "incomplete");
        assert!(v["reason"].as_str().unwrap().contains("취소"));
    }

    #[test]
    fn matching_marker_is_complete_even_with_bom_and_newline() {
        assert_eq!(evaluate("0.7.84", Some("\u{feff}0.7.84\r\n"), true)["state"], "complete");
    }

    #[test]
    fn stale_marker_from_older_install_is_incomplete() {
        let v = evaluate("0.7.84", Some("0.7.83"), true);
        assert_eq!(v["state"], "incomplete");
        assert_eq!(v["markerVersion"], "0.7.83");
    }

    #[test]
    fn attempts_are_per_version() {
        let r = json!({"version": "0.7.84", "autoAttempts": 2});
        assert_eq!(auto_attempts(&r, "0.7.84"), 2);
        assert_eq!(auto_attempts(&r, "0.7.85"), 0);
        assert_eq!(auto_attempts(&Value::Null, "0.7.84"), 0);
    }

    #[test]
    fn version_validation_blocks_path_tricks() {
        assert!(valid_version("0.7.84"));
        assert!(!valid_version("0.7"));
        assert!(!valid_version("../0.7.84"));
        assert!(!valid_version("0.7.84 /S"));
    }

    #[test]
    fn bad_signature_is_rejected() {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD;
        let pk = b64.encode("untrusted comment: minisign public key: 92302FAFC85D7085\nRWSFcF3Iry8wkm9P0kM7STy4fQElo2UbQKc86oZlr//ghwaLtv5/F+8S\n");
        assert!(verify_signature(b"data", "not-base64!!", &pk).is_err());
        assert!(verify_signature(b"data", &b64.encode("garbage"), &pk).is_err());
    }

    /// 실제 GitHub 에서 두 경로로 받아 서명 검증 (수동 실행, 네트워크·약 100MB): KDA_VERIFY_PUBKEY, KDA_VERIFY_VERSION
    #[test]
    #[ignore]
    fn live_download_both_routes_verify() {
        let pk = std::env::var("KDA_VERIFY_PUBKEY").unwrap();
        let ver = std::env::var("KDA_VERIFY_VERSION").unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let c = http_client().unwrap();
            let (exe, sig) = download_via_api(&c, &ver).await.expect("api route");
            verify_signature(&exe, &sig, &pk).expect("api route signature");
            match download_direct(&c, &ver).await {
                Ok((exe2, sig2)) => {
                    verify_signature(&exe2, &sig2, &pk).expect("direct route signature");
                    assert_eq!(exe.len(), exe2.len());
                }
                Err(e) => eprintln!("direct route unavailable now (fallback covers it): {}", e),
            }
        });
    }

    /// 실제 릴리즈 파일로 검증 (수동 실행): KDA_VERIFY_EXE, KDA_VERIFY_SIG, KDA_VERIFY_PUBKEY
    #[test]
    #[ignore]
    fn real_release_signature_verifies_and_tamper_fails() {
        let exe = std::fs::read(std::env::var("KDA_VERIFY_EXE").unwrap()).unwrap();
        let sig = std::fs::read_to_string(std::env::var("KDA_VERIFY_SIG").unwrap()).unwrap();
        let pk = std::env::var("KDA_VERIFY_PUBKEY").unwrap();
        verify_signature(&exe, &sig, &pk).expect("real signature must verify");
        let mut bad = exe.clone();
        bad[1000] ^= 0xff;
        assert!(verify_signature(&bad, &sig, &pk).is_err(), "tampered installer must fail");
    }
}
