//! v0.7.51 — 미리보기 미디어 스트리밍 프로토콜 (`kdamedia://`).
//!
//! K 보고: 미리보기에서 음악·영상이 재생되지 않고 PDF 는 오류 화면.
//! 원인 1) CSP 에 `media-src` / `frame-src` 가 없어 data: URL 이 `<video>`/`<audio>`/`<iframe>`
//!         에서 차단됨 (img 만 `img-src data:` 로 허용돼 있었음).
//! 원인 2) 파일 전체를 `Vec<u8>` → JSON 숫자 배열 → base64 로 넘겨 큰 파일이 느리고 100MB 초과는 거부.
//!
//! 근본 대책: 파일을 미리 읽지 않고, 브라우저가 Range 로 필요한 구간만 요청하게 한다.
//!
//! Tauri 기본 asset 프로토콜 대신 전용 프로토콜을 쓰는 이유 (보안):
//! - asset 프로토콜은 모든 webview(외부 사이트를 띄우는 창 포함)에 등록되고, 한 번
//!   `allow_file` 한 경로는 앱 종료까지 회수할 수 없으며 URL 에 실제 경로가 드러난다.
//! - 이 프로토콜은 **K 가 클릭해 기존 경로 신뢰 검증을 통과한 파일**에 대해서만
//!   추측 불가능한 토큰을 발급하고, **메인 창(label "main")의 요청만** 응답한다.
//!   URL 에는 토큰만 있고 경로는 없으므로 토큰 없이 임의 파일을 읽을 수 없다.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use tauri::http::{header, Request, Response, StatusCode};

pub const SCHEME: &str = "kdamedia";
/// 요청을 허용하는 webview label. 외부 사이트를 띄우는 창은 거부한다.
pub const ALLOWED_WEBVIEW: &str = "main";
/// 세션 동안 유지할 최대 토큰 수. 넘치면 가장 오래된 것부터 폐기.
const MAX_GRANTS: usize = 256;
/// 끝이 열린 Range(`bytes=N-`) 응답 한 번의 최대 크기.
const CHUNK: u64 = 4 * 1024 * 1024;
/// Range 없이 요청이 오면 통째로 응답하는 상한 (PDF 뷰어 등). 이보다 크면 416 대신 앞부분만 206.
const MAX_FULL_BODY: u64 = 64 * 1024 * 1024;

struct Grant {
    path: PathBuf,
    seq: u64,
}

#[derive(Default)]
struct Store {
    map: HashMap<String, Grant>,
    seq: u64,
}

fn store() -> &'static Mutex<Store> {
    static S: OnceLock<Mutex<Store>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Store::default()))
}

/// 신뢰 검증을 **이미 통과한** canonical 경로에 대해 토큰을 발급한다.
pub fn grant(path: PathBuf) -> String {
    let mut s = store().lock().unwrap_or_else(|e| e.into_inner());
    insert_grant(&mut s, path)
}

fn insert_grant(s: &mut Store, path: PathBuf) -> String {
    let token = uuid::Uuid::new_v4().simple().to_string();
    s.seq += 1;
    let seq = s.seq;
    s.map.insert(token.clone(), Grant { path, seq });
    while s.map.len() > MAX_GRANTS {
        let oldest = s.map.iter().min_by_key(|(_, g)| g.seq).map(|(k, _)| k.clone());
        match oldest {
            Some(k) => {
                s.map.remove(&k);
            }
            None => break,
        }
    }
    token
}

fn lookup(token: &str) -> Option<PathBuf> {
    let s = store().lock().unwrap_or_else(|e| e.into_inner());
    s.map.get(token).map(|g| g.path.clone())
}

/// 확장자 → MIME. 브라우저가 정확한 값을 받아야 재생 가능 여부를 올바로 판단한다.
/// (기존 data URL 경로는 m4a 를 `audio/m4a` 로 잘못 표기했다 — 정답은 `audio/mp4`.)
pub fn mime_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// `Range` 헤더 해석. 첫 구간만 사용 (미디어 요소는 단일 구간만 요청한다).
/// 반환: Ok(Some((start, end_inclusive))) / Ok(None)=Range 아님(무시하고 전체) / Err(())=416.
pub fn parse_range(value: &str, len: u64) -> Result<Option<(u64, u64)>, ()> {
    let v = value.trim();
    let Some(spec) = v.strip_prefix("bytes=") else {
        return Ok(None); // 알 수 없는 단위는 무시 (RFC 9110: 전체 응답 가능)
    };
    let first = spec.split(',').next().unwrap_or("").trim();
    let Some((a, b)) = first.split_once('-') else {
        return Err(());
    };
    let (a, b) = (a.trim(), b.trim());
    if len == 0 {
        return Err(());
    }
    let (start, mut end) = if a.is_empty() {
        // suffix: 마지막 n 바이트
        let n: u64 = b.parse().map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        (len.saturating_sub(n), len - 1)
    } else {
        let s: u64 = a.parse().map_err(|_| ())?;
        let e: u64 = if b.is_empty() {
            s.saturating_add(CHUNK - 1)
        } else {
            b.parse().map_err(|_| ())?
        };
        (s, e)
    };
    if start >= len || end < start {
        return Err(());
    }
    if end >= len {
        end = len - 1;
    }
    // 한 응답의 크기 상한 (메모리 보호). 미디어 요소는 이어서 다음 구간을 요청한다.
    if end - start + 1 > CHUNK {
        end = start + CHUNK - 1;
    }
    Ok(Some((start, end)))
}

fn plain(status: StatusCode, msg: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(msg.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// URL 경로 `/<token>/<표시용 파일명>` 에서 토큰만 꺼낸다. 파일명은 PDF 뷰어 제목용이며 무시.
fn token_from_path(uri_path: &str) -> Option<&str> {
    let t = uri_path.trim_start_matches('/').split('/').next()?;
    if t.len() == 32 && t.bytes().all(|c| c.is_ascii_hexdigit()) {
        Some(t)
    } else {
        None
    }
}

fn read_span(path: &Path, start: u64, len: u64) -> std::io::Result<Vec<u8>> {
    let mut f = File::open(path)?;
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity(len as usize);
    f.take(len).read_to_end(&mut buf)?;
    Ok(buf)
}

/// 프로토콜 요청 1건 처리 (블로킹 IO — 호출 측이 blocking 스레드에서 실행).
pub fn handle(webview_label: &str, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if webview_label != ALLOWED_WEBVIEW {
        return plain(StatusCode::FORBIDDEN, "kdamedia: main window only");
    }
    let method = req.method().as_str();
    if method != "GET" && method != "HEAD" {
        return plain(StatusCode::METHOD_NOT_ALLOWED, "kdamedia: GET/HEAD only");
    }
    let Some(token) = token_from_path(req.uri().path()) else {
        return plain(StatusCode::NOT_FOUND, "kdamedia: bad token");
    };
    let Some(path) = lookup(token) else {
        return plain(StatusCode::NOT_FOUND, "kdamedia: unknown or expired token");
    };
    let len = match std::fs::metadata(&path) {
        Ok(m) if m.is_file() => m.len(),
        Ok(_) => return plain(StatusCode::NOT_FOUND, "kdamedia: not a file"),
        Err(e) => return plain(StatusCode::NOT_FOUND, &format!("kdamedia: {}", e)),
    };
    let mime = mime_for(&path);
    let range = req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|v| parse_range(v, len));

    let base = |status: StatusCode| {
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CACHE_CONTROL, "no-store")
            .header("X-Content-Type-Options", "nosniff")
    };

    let (status, start, span) = match range {
        Some(Err(())) => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{}", len))
                .header(header::CACHE_CONTROL, "no-store")
                .body(Vec::new())
                .unwrap_or_else(|_| Response::new(Vec::new()));
        }
        Some(Ok(Some((s, e)))) => (StatusCode::PARTIAL_CONTENT, s, e - s + 1),
        _ if len > MAX_FULL_BODY => {
            // Range 없는 큰 요청: 메모리 보호를 위해 앞부분만 206 으로 준다.
            (StatusCode::PARTIAL_CONTENT, 0, CHUNK.min(len))
        }
        _ => (StatusCode::OK, 0, len),
    };

    let mut rb = base(status).header(header::CONTENT_LENGTH, span.to_string());
    if status == StatusCode::PARTIAL_CONTENT {
        rb = rb.header(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", start, start + span - 1, len),
        );
    }
    if method == "HEAD" || span == 0 {
        return rb.body(Vec::new()).unwrap_or_else(|_| Response::new(Vec::new()));
    }
    match read_span(&path, start, span) {
        Ok(buf) => rb.body(buf).unwrap_or_else(|_| Response::new(Vec::new())),
        Err(e) => plain(StatusCode::INTERNAL_SERVER_ERROR, &format!("kdamedia read: {}", e)),
    }
}

#[cfg(test)]
mod media_preview_tests {
    use super::*;

    fn req(path: &str, range: Option<&str>) -> Request<Vec<u8>> {
        let mut b = Request::builder().method("GET").uri(format!("http://kdamedia.localhost{}", path));
        if let Some(r) = range {
            b = b.header(header::RANGE, r);
        }
        b.body(Vec::new()).unwrap()
    }

    fn fixture(bytes: usize, ext: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kda-media-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(format!("clip.{}", ext));
        let data: Vec<u8> = (0..bytes).map(|i| (i % 251) as u8).collect();
        std::fs::write(&p, data).unwrap();
        p
    }

    #[test]
    fn mime_m4a_is_audio_mp4() {
        assert_eq!(mime_for(Path::new("a/b.M4A")), "audio/mp4");
        assert_eq!(mime_for(Path::new("x.mp3")), "audio/mpeg");
        assert_eq!(mime_for(Path::new("x.mov")), "video/quicktime");
        assert_eq!(mime_for(Path::new("x.pdf")), "application/pdf");
    }

    #[test]
    fn range_parsing() {
        assert_eq!(parse_range("bytes=0-99", 1000), Ok(Some((0, 99))));
        assert_eq!(parse_range("bytes=900-", 1000), Ok(Some((900, 999))));
        assert_eq!(parse_range("bytes=-100", 1000), Ok(Some((900, 999))));
        assert_eq!(parse_range("bytes=990-5000", 1000), Ok(Some((990, 999))));
        assert_eq!(parse_range("bytes=1000-", 1000), Err(()));
        assert_eq!(parse_range("bytes=5-2", 1000), Err(()));
        assert_eq!(parse_range("bytes=abc", 1000), Err(()));
        assert_eq!(parse_range("items=0-1", 1000), Ok(None));
        // 끝이 열린 큰 요청은 CHUNK 로 잘린다
        let big = 100 * 1024 * 1024;
        assert_eq!(parse_range("bytes=0-", big), Ok(Some((0, CHUNK - 1))));
    }

    #[test]
    fn serves_partial_content_for_granted_token() {
        let p = fixture(10_000, "mp4");
        let token = grant(p.clone());
        let r = handle("main", &req(&format!("/{}/clip.mp4", token), Some("bytes=100-199")));
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes 100-199/10000");
        assert_eq!(r.headers()[header::CONTENT_TYPE], "video/mp4");
        assert_eq!(r.body().len(), 100);
        assert_eq!(r.body()[0], (100 % 251) as u8);
        // Range 없음 → 전체 200
        let full = handle("main", &req(&format!("/{}/clip.mp4", token), None));
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(full.body().len(), 10_000);
        // 범위 밖 → 416
        let bad = handle("main", &req(&format!("/{}/clip.mp4", token), Some("bytes=20000-")));
        assert_eq!(bad.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn rejects_other_webviews_and_unknown_tokens() {
        let p = fixture(10, "mp3");
        let token = grant(p.clone());
        let ext = handle("external-1", &req(&format!("/{}/clip.mp3", token), None));
        assert_eq!(ext.status(), StatusCode::FORBIDDEN);
        let unknown = handle("main", &req("/0123456789abcdef0123456789abcdef/x.mp3", None));
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
        // 경로를 URL 에 직접 넣어도 열리지 않는다 (토큰만 인정)
        let raw = handle("main", &req("/C:/Windows/win.ini", None));
        assert_eq!(raw.status(), StatusCode::NOT_FOUND);
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn grant_store_is_bounded() {
        // 전역 store 는 다른 테스트와 병렬 공유되므로 로컬 store 로 검사한다.
        let mut local = Store::default();
        let first = insert_grant(&mut local, PathBuf::from("a.wav"));
        for _ in 0..MAX_GRANTS + 5 {
            insert_grant(&mut local, PathBuf::from("a.wav"));
        }
        assert!(!local.map.contains_key(&first), "가장 오래된 토큰은 폐기돼야 함");
        assert_eq!(local.map.len(), MAX_GRANTS);
    }
}
