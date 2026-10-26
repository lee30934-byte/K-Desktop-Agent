import { invoke, convertFileSrc } from "@tauri-apps/api/core";

/**
 * v0.7.51 — 미리보기 미디어 스트리밍 (`kdamedia://`, src-tauri/src/media_preview.rs).
 *
 * 기존: 파일 전체를 Rust 에서 읽어 JSON 숫자 배열 → base64 data URL 로 변환.
 *   - 큰 영상은 메모리를 많이 쓰고 열리기까지 오래 걸리며, 100MB 초과는 아예 거부.
 * 변경: 클릭한 파일에 대해 Rust 가 (기존 경로 신뢰 검증 통과 시) 임의 토큰을 발급하고,
 *   웹뷰가 `http://kdamedia.localhost/<token>/<파일명>` 을 Range 요청으로 필요한 만큼만 읽는다.
 *   URL 에는 실제 경로가 없고, 토큰은 메인 창에서만 유효하다.
 */

export const MEDIA_SCHEME = "kdamedia";

export interface MediaGrant {
  url: string;
  size: number;
  mime: string;
}

/** 경로의 마지막 구성요소 (표시/PDF 제목용). 토큰 판정에는 쓰이지 않는다. */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || "file";
}

/** `http://kdamedia.localhost/` (Windows) 형태의 base 에 토큰/파일명을 붙인다. */
export function buildMediaUrl(base: string, token: string, fileName: string): string {
  const b = base.endsWith("/") ? base : base + "/";
  return `${b}${token}/${encodeURIComponent(fileName)}`;
}

export async function grantMediaUrl(hostPath: string): Promise<MediaGrant> {
  const r = await invoke<{ token: string; scheme?: string; size: number; mime: string }>(
    "grant_media_preview",
    { path: hostPath },
  );
  if (!r || typeof r.token !== "string" || !/^[0-9a-f]{32}$/.test(r.token)) {
    throw new Error("grant_media_preview 응답에 토큰이 없습니다");
  }
  const base = convertFileSrc("", r.scheme || MEDIA_SCHEME);
  return { url: buildMediaUrl(base, r.token, baseName(hostPath)), size: r.size, mime: r.mime };
}

/** 스트리밍 URL 인지 (오류 시 기존 data URL 방식으로 되돌릴지 판단용). */
export function isMediaStreamUrl(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith(`http://${MEDIA_SCHEME}.localhost/`) ||
    url.startsWith(`https://${MEDIA_SCHEME}.localhost/`) ||
    url.startsWith(`${MEDIA_SCHEME}://`);
}

/**
 * 기존 data URL 경로용 MIME. (종전엔 `audio/${ext}` 로 만들어 m4a 가 `audio/m4a` 가 됐다 —
 * 정확한 값은 `audio/mp4`. Rust media_preview::mime_for 와 같은 표를 유지한다.)
 */
export function mimeForExt(ext: string, category: "image" | "video" | "audio" | "pdf"): string {
  const e = ext.toLowerCase();
  const map: Record<string, string> = {
    mp4: "video/mp4",
    m4v: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    aac: "audio/mp4",
    wav: "audio/wav",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    opus: "audio/ogg",
    flac: "audio/flac",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    ico: "image/x-icon",
    svg: "image/svg+xml",
    pdf: "application/pdf",
  };
  if (map[e]) return map[e];
  if (category === "pdf") return "application/pdf";
  // webm 오디오 등 표에 없는 확장자는 webm 계열로 두지 않고 generic 으로.
  return "application/octet-stream";
}
