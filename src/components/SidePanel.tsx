import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
// Phase 74 (v0.6.17): plugin-fs/plugin-shell 의 default scope 가 너무 strict 해서
// ~/.kda/cwd/runtime/previews/... 같은 K 워크스페이스 path 를 거부 ("forbidden path",
// "Scoped command argument ... regex validation"). Rust 측 명시적 command (read_preview_file
// / open_path) 로 갈아탐 — capabilities scope 우회 + 신뢰 prefix 검증.
import { readTextFile, readFile } from "@tauri-apps/plugin-fs";
import { open as openShell } from "@tauri-apps/plugin-shell";
import logger from "../utils/logger";

/**
 * Phase 44 (v0.5.32) — SidePanel: 대화 안 링크/파일 클릭 → 우측 패널에서 미리보기.
 *
 * 동작:
 * - 닫혀있으면 우측에 작은 ⟨ 토글 버튼만 표시 (절약된 폭)
 * - 열려있으면 ~320px 패널 — 파일명 + 미리보기 + 외부 열기 버튼 + ✕ 닫기
 * - 미리보기: 이미지/비디오/오디오/텍스트/PDF inline, 나머지는 외부 열기 버튼만
 */

export interface SidePanelItem {
  // file path (절대 또는 상대) 또는 URL
  pathOrUrl: string;
  // 표시 이름 — 보통 link 의 text
  label?: string;
}

interface SidePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: SidePanelItem | null;
  onClose: () => void;
}

// Phase 65 (v0.5.53 후보): Message.tsx 의 inline 이미지 미리보기에서 재사용.
export function getExt(pathOrUrl: string): string {
  const m = /\.([a-zA-Z0-9]+)(?:$|\?)/.exec(pathOrUrl);
  return (m?.[1] ?? "").toLowerCase();
}

export function isUrl(pathOrUrl: string): boolean {
  return /^(https?|file):\/\//i.test(pathOrUrl);
}

export function getCategory(pathOrUrl: string): "image" | "video" | "audio" | "text" | "pdf" | "url" | "other" {
  if (isUrl(pathOrUrl) && !/\.(png|jpg|jpeg|gif|webp|svg|mp4|webm|mp3|wav|ogg|pdf|txt|md|json|csv|xml|yaml|yml|log)$/i.test(pathOrUrl)) {
    return "url";
  }
  const ext = getExt(pathOrUrl);
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) return "image";
  if (["mp4", "webm", "mov", "mkv"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "m4a", "flac"].includes(ext)) return "audio";
  if (["txt", "md", "json", "csv", "xml", "yaml", "yml", "log", "ini", "conf", "ts", "tsx", "js", "jsx", "py", "rs", "java", "c", "cpp", "h", "go", "rb", "sh", "ps1"].includes(ext)) return "text";
  if (ext === "pdf") return "pdf";
  return "other";
}

/**
 * Tauri 의 fs read 로 파일을 base64 data URL 또는 텍스트로 로드.
 * - image/video/audio/pdf: bytes → base64 → data URL
 * - text: UTF-8 text 그대로
 */
export async function loadPreview(
  pathOrUrl: string,
  category: ReturnType<typeof getCategory>,
): Promise<{ dataUrl?: string; text?: string; error?: string }> {
  if (isUrl(pathOrUrl)) {
    return { dataUrl: pathOrUrl };
  }

  // Phase 74 — Rust 측 read_preview_file 우선 시도 (capabilities scope 우회).
  // 옛 binary (~v0.6.16) 면 invoke 자체가 throw → plugin-fs 폴백.
  const tryRustRead = async (asText: boolean): Promise<{ text?: string; bytes?: Uint8Array } | null> => {
    try {
      const result = await invoke<{ text?: string; bytes?: number[] }>("read_preview_file", {
        path: pathOrUrl,
        asText,
      });
      if (asText) return { text: result.text };
      if (result.bytes) return { bytes: new Uint8Array(result.bytes) };
      return null;
    } catch (e) {
      logger.warn(`[SidePanel] read_preview_file invoke 실패 (옛 binary 가능): ${e}`);
      return null;
    }
  };

  try {
    if (category === "text") {
      const rust = await tryRustRead(true);
      if (rust?.text !== undefined) {
        return { text: rust.text };
      }
      // 폴백 — 옛 binary 에서만. v0.6.16 이하면 capabilities scope 거부 가능성 큼.
      const content = await readTextFile(pathOrUrl);
      const truncated = content.length > 100_000 ? content.slice(0, 100_000) + "\n\n... [잘림: 100KB 까지만]" : content;
      return { text: truncated };
    }
    if (category === "image" || category === "video" || category === "audio" || category === "pdf") {
      let bytes: Uint8Array | null = null;
      const rust = await tryRustRead(false);
      if (rust?.bytes) {
        bytes = rust.bytes;
      } else {
        // 폴백
        bytes = await readFile(pathOrUrl);
      }
      // bytes (Uint8Array) → base64
      let bin = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      const b64 = btoa(bin);
      const mimeMap: Record<string, string> = {
        image: getExt(pathOrUrl) === "svg" ? "image/svg+xml" : `image/${getExt(pathOrUrl)}`,
        video: `video/${getExt(pathOrUrl) === "mov" ? "quicktime" : getExt(pathOrUrl)}`,
        audio: `audio/${getExt(pathOrUrl) === "mp3" ? "mpeg" : getExt(pathOrUrl)}`,
        pdf: "application/pdf",
      };
      return { dataUrl: `data:${mimeMap[category] || "application/octet-stream"};base64,${b64}` };
    }
    return {};
  } catch (e) {
    return { error: String(e) };
  }
}

export default function SidePanel({ open, onOpenChange, item, onClose }: SidePanelProps) {
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<{ dataUrl?: string; text?: string; error?: string }>({});
  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = parseInt(localStorage.getItem("kda_side_panel_width") || "", 10);
      if (!Number.isNaN(saved) && saved >= 240 && saved <= 800) return saved;
    } catch {}
    return 360;
  });
  const [resizing, setResizing] = useState(false);

  // 폭 영구 저장 + CSS variable 갱신
  useEffect(() => {
    document.documentElement.style.setProperty("--side-panel-width", open ? `${width}px` : "0px");
    try {
      localStorage.setItem("kda_side_panel_width", String(width));
    } catch {}
  }, [width, open]);

  // 새 item 로드
  useEffect(() => {
    // Phase 61 (v0.5.49): 진단 로그 — K 다른 PC 에서 "프리뷰 안 됨" 보고. item / open / category
    // 가 어디서 끊기는지 추적. DevTools console 에서 [SidePanel] grep.
    logger.log(`[SidePanel] effect — open=${open} item=${item ? item.pathOrUrl : "null"}`);
    if (!item || !open) {
      setPreview({});
      return;
    }
    const category = getCategory(item.pathOrUrl);
    logger.log(`[SidePanel] category=${category} for ${item.pathOrUrl}`);
    if (category === "url" || category === "other") {
      // url/other 도 preview 안 박지만 render 측에서 "외부 열기" 카드 표시. 빈 preview 가 정상.
      setPreview({});
      return;
    }
    setLoading(true);
    loadPreview(item.pathOrUrl, category).then((result) => {
      setPreview(result);
      setLoading(false);
      if (result.error) {
        logger.warn(`[SidePanel] preview 로드 실패: ${item.pathOrUrl} → ${result.error}`);
      } else {
        logger.log(`[SidePanel] preview 로드 성공 — hasDataUrl=${!!result.dataUrl} hasText=${!!result.text}`);
      }
    });
  }, [item, open]);

  // 폭 drag
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      // 우측 패널 → drag 우→좌 가 폭 증가
      const next = Math.max(240, Math.min(800, window.innerWidth - e.clientX));
      setWidth(next);
    };
    const onUp = () => setResizing(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [resizing]);

  const handleOpenExternal = async () => {
    if (!item) return;
    try {
      if (isUrl(item.pathOrUrl)) {
        await openShell(item.pathOrUrl);
      } else {
        // Tauri 의 shell.open 이 절대 경로면 OS 기본 앱으로 엶
        // 로컬 파일은 file:// prefix 추가가 안전
        await invoke("open_path", { path: item.pathOrUrl }).catch(async () => {
          // open_path command 가 없으면 plugin-shell 시도
          await openShell(item.pathOrUrl);
        });
      }
    } catch (e) {
      logger.warn(`[SidePanel] 외부 열기 실패: ${e}`);
      alert(`외부 앱에서 열기 실패: ${e}`);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        className="side-panel-toggle-closed"
        onClick={() => onOpenChange(true)}
        title="사이드 패널 열기"
        aria-label="사이드 패널 열기"
      >
        ⟨
      </button>
    );
  }

  const category = item ? getCategory(item.pathOrUrl) : null;

  return (
    <aside className="side-panel" style={{ width }}>
      {/* 폭 조절 grip (좌측 가장자리) */}
      <div
        className={`side-panel-resizer ${resizing ? "dragging" : ""}`}
        onMouseDown={(e) => {
          e.preventDefault();
          setResizing(true);
        }}
        onDoubleClick={() => setWidth(360)}
        title="좌우 드래그로 패널 폭 조절 · 더블클릭 = 기본 (360px)"
      />

      <div className="side-panel-header">
        <span className="eyebrow">PREVIEW</span>
        <div className="side-panel-header-actions">
          <button
            type="button"
            className="side-panel-btn"
            onClick={() => onOpenChange(false)}
            title="숨기기"
            aria-label="사이드 패널 숨기기"
          >
            ⟩
          </button>
        </div>
      </div>

      <div className="side-panel-content">
        {!item ? (
          <div className="side-panel-empty">
            <span className="empty-icon">📄</span>
            <div className="empty-text">
              <p>대화 안에서 파일 / 링크를 클릭하면<br />여기에 미리보기가 표시됩니다.</p>
            </div>
          </div>
        ) : (
          <>
            <div className="side-panel-item-header">
              <div className="side-panel-filename" title={item.pathOrUrl}>
                {item.label || item.pathOrUrl}
              </div>
              <div className="side-panel-actions">
                <button
                  type="button"
                  className="side-panel-action-btn"
                  onClick={handleOpenExternal}
                  title="기본 앱에서 열기"
                >
                  🔗 외부 열기
                </button>
                <button
                  type="button"
                  className="side-panel-action-btn close"
                  onClick={onClose}
                  title="미리보기 닫기"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="side-panel-preview">
              {loading && <div className="side-panel-loading">로딩 중...</div>}
              {preview.error && (
                <div className="side-panel-error">
                  <strong>미리보기 실패</strong>
                  <div className="mono">{preview.error}</div>
                  <p style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                    "외부 열기" 버튼으로 시도해보세요.
                  </p>
                </div>
              )}
              {!loading && !preview.error && (
                <>
                  {category === "image" && preview.dataUrl && (
                    <img src={preview.dataUrl} alt={item.label || item.pathOrUrl} className="side-panel-image" />
                  )}
                  {category === "video" && preview.dataUrl && (
                    <video src={preview.dataUrl} controls className="side-panel-video" />
                  )}
                  {category === "audio" && preview.dataUrl && (
                    <audio src={preview.dataUrl} controls className="side-panel-audio" />
                  )}
                  {category === "pdf" && preview.dataUrl && (
                    <iframe src={preview.dataUrl} className="side-panel-pdf" title={item.label || "PDF"} />
                  )}
                  {category === "text" && preview.text !== undefined && (
                    <pre className="side-panel-text mono">{preview.text}</pre>
                  )}
                  {category === "url" && (
                    <div className="side-panel-url-card">
                      <p>웹 링크는 외부 브라우저에서 열립니다.</p>
                      <button
                        type="button"
                        className="side-panel-action-btn primary"
                        onClick={handleOpenExternal}
                      >
                        🔗 열기: {item.pathOrUrl.slice(0, 60)}
                        {item.pathOrUrl.length > 60 ? "..." : ""}
                      </button>
                    </div>
                  )}
                  {category === "other" && (
                    <div className="side-panel-url-card">
                      <p>
                        이 파일 형식은 미리보기가 지원되지 않습니다.
                        <br />
                        기본 앱에서 열어주세요.
                      </p>
                      <button
                        type="button"
                        className="side-panel-action-btn primary"
                        onClick={handleOpenExternal}
                      >
                        🔗 기본 앱에서 열기
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
