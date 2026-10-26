// v0.7.51 — 미리보기 미디어(영상/음악/PDF/이미지) 스트리밍 + 채팅 인라인 플레이어 회귀 테스트.
//
// K 보고: 미리보기에서 음악·영상이 재생되지 않고 PDF 는 오류 화면.
//   원인 1) CSP 에 media-src / frame-src 가 없어 data: URL 이 <video>/<audio>/<iframe> 에서 차단.
//   원인 2) 파일 전체를 JSON 숫자 배열 → base64 로 넘겨 큰 파일이 느리고 100MB 초과는 거부.
//   원인 3) m4a 를 audio/m4a 로 표기 (정답 audio/mp4).
// 불변식
//   1. CSP 가 미디어/프레임/이미지에 kdamedia 와 data: 를 허용한다 (회귀 시 재생 불가가 재발).
//   2. kdamedia 프로토콜은 메인 창 전용 + 토큰 기반이며, 토큰 발급은 기존 경로 신뢰 검증을 거친다.
//   3. 미리보기는 스트리밍 우선, 실패 시 data URL 폴백, 둘 다 실패하면 보이는 오류.
//   4. 인라인 플레이어는 클릭 전에는 파일을 열지 않고, Final-Review Gate 를 먼저 검사한다.
//   5. 스킴 이름이 Rust / TS / CSP 에서 일치한다.
// Range/토큰/라벨 거부의 실제 동작은 cargo test media_preview_tests 가 검증한다.
// 실행: node test-media-preview-stream.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf-8").replace(/\r\n/g, "\n");

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const csp = conf?.app?.security?.csp ?? "";
const directive = (name) => {
  const m = new RegExp(`(?:^|;)\\s*${name}\\s+([^;]*)`).exec(csp);
  return m ? m[1].trim().split(/\s+/) : null;
};
const lib = read("src-tauri/src/lib.rs");
const media = read("src-tauri/src/media_preview.rs");
const streamTs = read("src/utils/mediaStream.ts");
const side = read("src/components/SidePanel.tsx");
const msg = read("src/components/Message.tsx");
const player = read("src/components/InlineMediaPlayer.tsx");
const css = read("src/App.css");

// ── 1. CSP ────────────────────────────────────────────────────────────────
console.log("\n[1] CSP — 미디어/프레임/이미지 허용");
const mediaSrc = directive("media-src");
const frameSrc = directive("frame-src");
const imgSrc = directive("img-src");
check("media-src 존재", !!mediaSrc, csp);
check("media-src: kdamedia (windows http + 기타 플랫폼 scheme)", !!mediaSrc && mediaSrc.includes("http://kdamedia.localhost") && mediaSrc.includes("kdamedia:"));
check("media-src: data: (폴백 경로)", !!mediaSrc && mediaSrc.includes("data:"));
check("frame-src 존재 + kdamedia + data: (PDF)", !!frameSrc && frameSrc.includes("http://kdamedia.localhost") && frameSrc.includes("data:"));
check("img-src: kdamedia + data: 유지", !!imgSrc && imgSrc.includes("http://kdamedia.localhost") && imgSrc.includes("data:"));
check("script-src 는 넓히지 않음", (directive("script-src") ?? []).join(" ") === "'self' 'unsafe-inline'");
check("media/frame 에 와일드카드(*) 금지", !(mediaSrc ?? []).includes("*") && !(frameSrc ?? []).includes("*"));

// ── 2. Rust 프로토콜/명령 ─────────────────────────────────────────────────
console.log("\n[2] Rust — kdamedia 프로토콜 + 토큰 발급");
check("mod media_preview 선언", /^mod media_preview;/m.test(lib));
check("SCHEME = \"kdamedia\"", /pub const SCHEME: &str = "kdamedia";/.test(media));
check("메인 창 전용 (ALLOWED_WEBVIEW = \"main\" + label 비교)", /ALLOWED_WEBVIEW: &str = "main"/.test(media) && /webview_label != ALLOWED_WEBVIEW/.test(media));
check("토큰 형식 검증 (32 hex)", /t\.len\(\) == 32 && t\.bytes\(\)\.all\(\|c\| c\.is_ascii_hexdigit\(\)\)/.test(media));
check("Range 지원 (206 + Content-Range)", /PARTIAL_CONTENT/.test(media) && /CONTENT_RANGE/.test(media));
check("m4a → audio/mp4", /"m4a" \| "aac" => "audio\/mp4"/.test(media));
check("프로토콜 등록 (asynchronous + spawn_blocking)", /register_asynchronous_uri_scheme_protocol\(media_preview::SCHEME/.test(lib) && /spawn_blocking\(move \|\| \{\s*responder\.respond\(media_preview::handle\(&label, &request\)\)/.test(lib));
const grantFn = /fn grant_media_preview\(path: String\)[\s\S]*?\n\}/.exec(lib)?.[0] ?? "";
check("grant_media_preview 정의", grantFn.length > 0);
check("grant 는 신뢰 검증 공용 함수를 먼저 통과", /resolve_trusted_preview_path\(&path, "미디어 미리보기"\)\?/.test(grantFn) && grantFn.indexOf("resolve_trusted_preview_path") < grantFn.indexOf("media_preview::grant"));
check("grant 는 파일만 허용", /is_file\(\)/.test(grantFn));
check("read_preview_file 도 같은 검증 함수 사용", /fn read_preview_file[\s\S]{0,200}resolve_trusted_preview_path\(&path, "미리보기"\)\?/.test(lib));
const resolveFn = /fn resolve_trusted_preview_path[\s\S]*?\n\}/.exec(lib)?.[0] ?? "";
check("신뢰 검증 규칙 유지 (drive / WSL UNC / prefix, 일반 UNC 거부)", /is_local_drive_path\(&canonical_str\)/.test(resolveFn) && /is_wsl_unc_path\(&canonical_str\)/.test(resolveFn) && /canonicalize\(\)/.test(resolveFn));
check("invoke_handler 에 grant_media_preview 등록", /read_preview_file,\s*grant_media_preview,/.test(lib));
check("Tauri asset 프로토콜은 켜지 않음 (전체 webview 노출 회피)", !/"assetProtocol"/.test(read("src-tauri/tauri.conf.json")) && !/protocol-asset/.test(read("src-tauri/Cargo.toml")));

// ── 3. 프론트 스트리밍/폴백 ───────────────────────────────────────────────
console.log("\n[3] 프론트 — 스트리밍 우선, data URL 폴백, 보이는 오류");
check("mediaStream: 스킴 상수 kdamedia", /export const MEDIA_SCHEME = "kdamedia";/.test(streamTs));
check("mediaStream: grant_media_preview invoke + convertFileSrc", /invoke<[\s\S]*?>\(\s*"grant_media_preview"/.test(streamTs) && /convertFileSrc\(""/.test(streamTs));
const mediaBranch = /if \(category === "image" \|\| category === "video" \|\| category === "audio" \|\| category === "pdf"\) \{[\s\S]*?\n    \}\n/.exec(side)?.[0] ?? "";
check("loadPreview 미디어 분기 탐지", mediaBranch.length > 0);
check("스트리밍(grantMediaUrl)이 read_preview_file 보다 먼저", mediaBranch.indexOf("grantMediaUrl") > 0 && mediaBranch.indexOf("grantMediaUrl") < mediaBranch.indexOf("tryRustRead"));
check("legacy 옵션이면 스트리밍 건너뜀", /if \(!opts\.legacy\) \{/.test(mediaBranch));
check("옛 MIME 조립(`audio/${ext}`) 제거", !/`audio\/\$\{/.test(side) && !/`video\/\$\{/.test(side) && /mimeForExt\(getExt\(hostPath\), category\)/.test(side));
check("file:// 은 그대로 src 로 넘기지 않음", /isUrl\(pathOrUrl\) && !\/\^file:\/i\.test\(pathOrUrl\)/.test(side));
for (const tag of ["video", "audio"]) {
  const el = new RegExp(`<${tag}\\s[\\s\\S]*?className="side-panel-${tag}"[\\s\\S]*?/>`).exec(side)?.[0] ?? "";
  check(`SidePanel <${tag}> onError → handleMediaError`, new RegExp(`onError=\\{\\(\\) => handleMediaError\\("${tag}"\\)\\}`).test(el));
}
check("SidePanel <img> onError → handleMediaError", /className="side-panel-image"\s*onError=\{\(\) => handleMediaError\("image"\)\}/.test(side));
check("폴백은 스트리밍 URL 일 때 1회만 (legacy:true)", /preview\.streamed && isMediaStreamUrl\(failedUrl\)/.test(side) && /loadPreview\(item\.pathOrUrl, kind, \{ legacy: true \}\)/.test(side));
check("늦게 온 로드 결과가 다른 항목을 덮지 않음 (loadSeqRef)", (side.match(/seq !== loadSeqRef\.current/g) ?? []).length >= 3);
check("Final-Review Gate 유지 (미디어 4종)", /const gatedCategory = category === "image" \|\| category === "video" \|\| category === "audio" \|\| category === "pdf";/.test(side));

// ── 4. 채팅 인라인 플레이어 ──────────────────────────────────────────────
console.log("\n[4] 채팅 인라인 플레이어");
check("Message: 링크(a) 렌더러가 video/audio 면 InlineMediaPlayer 추가", /mediaKind === "video" \|\| mediaKind === "audio"[\s\S]{0,200}<InlineMediaPlayer/.test(msg));
check("Message: 이미지 문법의 미디어도 플레이어", /const kind = getCategory\(src\);\s*if \(kind === "video" \|\| kind === "audio"\)[\s\S]{0,400}<InlineMediaPlayer/.test(msg));
check("Message: 인라인 이미지 스트리밍 실패 시 data URL 폴백", /onError=\{handleImgError\}/.test(msg) && /loadPreview\(src, "image", \{ legacy: true \}\)/.test(msg));
const startFn = /const start = async[\s\S]*?\n  \};/.exec(player)?.[0] ?? "";
check("플레이어: 파일 로드는 start(클릭) 안에서만", (player.match(/loadPreview\(/g) ?? []).length === 2 && startFn.includes("loadPreview(src, kind)"));
check("플레이어: Gate 검사가 로드보다 먼저", startFn.indexOf("checkFinalReviewGate") > 0 && startFn.indexOf("checkFinalReviewGate") < startFn.indexOf("loadPreview"));
check("플레이어: 차단 시 재생하지 않고 패널로 안내", /if \(gate\.blocked\) \{[\s\S]{0,200}setState\("blocked"\);\s*return;/.test(startFn));
check("플레이어: 처음 상태는 idle (▶ 재생 버튼)", /useState<"idle" \| "loading" \| "ready" \| "blocked" \| "error">\("idle"\)/.test(player) && /▶ 재생/.test(player));
check("플레이어: 미디어 오류 처리 (onError)", (player.match(/onError=\{onMediaError\}/g) ?? []).length === 2);
check("플레이어 CSS 존재", /\.md-inline-media-btn/.test(css) && /\.md-inline-video \{/.test(css) && /\.md-inline-media-close \{/.test(css));

// ── 5. mediaStream 함수 동작 ─────────────────────────────────────────────
console.log("\n[5] mediaStream 함수 동작");
const stripped = streamTs.replace(/^import .*$/m, "const invoke = async () => { throw new Error('no tauri'); }; const convertFileSrc = (p, proto) => `http://${proto}.localhost/${encodeURIComponent(p)}`;");
const js = ts.transpileModule(stripped, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const ms = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
check("mimeForExt m4a → audio/mp4", ms.mimeForExt("M4A", "audio") === "audio/mp4");
check("mimeForExt mp3/mov/svg/pdf", ms.mimeForExt("mp3", "audio") === "audio/mpeg" && ms.mimeForExt("mov", "video") === "video/quicktime" && ms.mimeForExt("svg", "image") === "image/svg+xml" && ms.mimeForExt("x", "pdf") === "application/pdf");
const url = ms.buildMediaUrl("http://kdamedia.localhost/", "0123456789abcdef0123456789abcdef", "01 내 노래#1.mp3");
check("buildMediaUrl: 토큰 + 인코딩된 파일명", url === "http://kdamedia.localhost/0123456789abcdef0123456789abcdef/01%20%EB%82%B4%20%EB%85%B8%EB%9E%98%231.mp3", url);
check("buildMediaUrl: 경로 구분자가 URL 에 새지 않음", !ms.buildMediaUrl("http://kdamedia.localhost/", "a".repeat(32), ms.baseName("C:\\Users\\lee30\\Music\\a.mp3")).includes("Users"));
check("isMediaStreamUrl", ms.isMediaStreamUrl(url) && !ms.isMediaStreamUrl("data:audio/mp4;base64,AA") && !ms.isMediaStreamUrl(undefined));

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
