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
  if (["txt", "md", "json", "csv", "xml", "yaml", "yml", "log", "ini", "conf", "ts", "tsx", "js", "jsx", "py", "rs", "java", "c", "cpp", "h", "go", "rb", "sh", "ps1", "html", "htm", "css", "scss", "toml", "bat", "cmd", "sql", "env"].includes(ext)) return "text";
  if (ext === "pdf") return "pdf";
  return "other";
}

/**
 * Phase 78 (v0.6.21) — react-markdown 이 href 를 URL spec 에 따라 normalize 하면서
 * Windows path 의 `\` 와 한글을 percent-encode 함:
 *   C:\Users\user\Pictures\캡처.PNG
 *   → C:%5CUsers%5Cuser%5CPictures%5C%EC%BA%A1%EC%B2%98.PNG
 * Rust 의 read_preview_file canonicalize 가 이 percent-encoded path 를 못 풀어
 * "forbidden path" 로 거부. frontend 에서 invoke 전에 raw path 로 복원 필요.
 *
 * 또 K 가 file:// URL 로 줄 수도 있어 prefix 도 제거.
 */
export function normalizeLocalPath(input: string): string {
  let p = input;
  // file:// 또는 file:/// prefix 제거 (Windows path 는 file:///C:/...)
  if (p.startsWith("file:///")) p = p.slice(8);
  else if (p.startsWith("file://")) p = p.slice(7);
  // URL-encoded 문자 (%XX) 복원. invalid escape 면 원본 유지 (defensive).
  try {
    p = decodeURIComponent(p);
  } catch {
    // 사용자가 잘못된 % 문자열 박은 경우 — 원본 그대로 두고 Rust 가 거부하도록
  }
  return p;
}

/**
 * Phase 80 (v0.6.24) — Final-Review Gate: 미리보기 표시 전 같은 폴더의 qa-report.json 검사.
 * SIGILFALL 같은 대량 생성의 raw 컷이 사용자에게 노출 안 되도록 차단.
 *
 * qa-report.json (v1):
 *   { "version": 1, "files": { "<filename>": { "status": "FINAL_CANDIDATE"|"HOLD"|"FAIL", "reason"?, "qa_at"? } } }
 *
 * 반환:
 * - { blocked: false } — qa-report 없거나 FINAL_CANDIDATE
 * - { blocked: true, status, reason, qaExists } — HOLD/FAIL 또는 누락
 * - { blocked: false, gateDisabled: true } — Settings 에서 토글 OFF
 */
export interface GateResult {
  blocked: boolean;
  status?: string;
  reason?: string;
  qaExists?: boolean;
  gateDisabled?: boolean;
}

export async function checkFinalReviewGate(localPath: string): Promise<GateResult> {
  // Settings 의 토글 검사. 실패하면 (config 없음 등) default ON 으로 진행 — 안전 우선.
  try {
    const cfg = await invoke<Record<string, any>>("get_sidecar_config");
    if (cfg && cfg.finalReviewGateEnabled === false) {
      return { blocked: false, gateDisabled: true };
    }
  } catch {
    // config 못 읽으면 default ON (블록 가능) — fall through.
  }

  // localPath 의 부모 폴더 + filename 분리. Windows separator + POSIX 둘 다 처리.
  const normalized = normalizeLocalPath(localPath);
  const sepIdx = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  if (sepIdx < 0) return { blocked: false }; // 절대경로 아님 — gate 적용 불가
  const folder = normalized.slice(0, sepIdx);
  const filename = normalized.slice(sepIdx + 1);

  let qaResult: any;
  try {
    qaResult = await invoke<any>("read_qa_report", { folderPath: folder });
  } catch (e) {
    // 신뢰 prefix fail 등 — Gate 자체가 안 도는 폴더. 통과 (legacy / scope 밖).
    logger.warn(`[Gate] read_qa_report 호출 실패 (gate skip): ${e}`);
    return { blocked: false, qaExists: false };
  }

  if (!qaResult?.exists) {
    // qa-report.json 없음 — legacy 폴더로 간주, 통과.
    return { blocked: false, qaExists: false };
  }

  if (qaResult.error) {
    // qa-report.json 있는데 parse 실패 — 안전 우선으로 차단.
    return {
      blocked: true,
      status: "PARSE_ERROR",
      reason: qaResult.error,
      qaExists: true,
    };
  }

  const fileEntry = qaResult.content?.files?.[filename];
  if (!fileEntry) {
    return {
      blocked: true,
      status: "NOT_LISTED",
      reason: "qa-report.json 에 이 파일 항목 없음",
      qaExists: true,
    };
  }
  const status = String(fileEntry.status ?? "").toUpperCase();
  if (status === "FINAL_CANDIDATE") {
    return { blocked: false, status, qaExists: true };
  }
  return {
    blocked: true,
    status,
    reason: fileEntry.reason ? String(fileEntry.reason) : undefined,
    qaExists: true,
  };
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

  // Phase 78 (v0.6.21): URL-encoded local path 복원. 호출자가 이미 normalize 된 path 를
  // 줘도 idempotent (raw path 에는 % 가 거의 없어 decode 가 no-op).
  const normalizedPath = normalizeLocalPath(pathOrUrl);
  if (normalizedPath !== pathOrUrl) {
    logger.log(`[SidePanel] path normalize: "${pathOrUrl}" → "${normalizedPath}"`);
  }

  // Phase 74 — Rust 측 read_preview_file 우선 시도 (capabilities scope 우회).
  // 옛 binary (~v0.6.16) 면 invoke 자체가 throw → plugin-fs 폴백.
  const tryRustRead = async (asText: boolean): Promise<{ text?: string; bytes?: Uint8Array } | null> => {
    try {
      const result = await invoke<{ text?: string; bytes?: number[] }>("read_preview_file", {
        path: normalizedPath,
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
      const content = await readTextFile(normalizedPath);
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
        bytes = await readFile(normalizedPath);
      }
      // bytes (Uint8Array) → base64
      let bin = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      const b64 = btoa(bin);
      const mimeMap: Record<string, string> = {
        image: getExt(normalizedPath) === "svg" ? "image/svg+xml" : `image/${getExt(normalizedPath)}`,
        video: `video/${getExt(normalizedPath) === "mov" ? "quicktime" : getExt(normalizedPath)}`,
        audio: `audio/${getExt(normalizedPath) === "mp3" ? "mpeg" : getExt(normalizedPath)}`,
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
  // Phase 80 (v0.6.24): preview state 에 gate 차단 분기 추가
  const [preview, setPreview] = useState<{
    dataUrl?: string;
    text?: string;
    error?: string;
    blockedByGate?: GateResult;
  }>({});
  // K 가 차단된 항목에 "강제 열기" 누른 케이스 추적 — 같은 item 에 대해 그 후로는 gate skip
  const [gateOverrides, setGateOverrides] = useState<Set<string>>(new Set());
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
    (async () => {
      // Phase 80 (v0.6.24): Final-Review Gate — image/video/audio/pdf 만 검사 (text 는 그대로 통과)
      const gatedCategory = category === "image" || category === "video" || category === "audio" || category === "pdf";
      if (gatedCategory && !gateOverrides.has(item.pathOrUrl)) {
        const gate = await checkFinalReviewGate(item.pathOrUrl);
        if (gate.blocked) {
          logger.warn(`[Gate] BLOCKED: ${item.pathOrUrl} status=${gate.status} reason=${gate.reason ?? "(없음)"}`);
          setPreview({ blockedByGate: gate });
          setLoading(false);
          return;
        }
        if (gate.qaExists) {
          logger.log(`[Gate] PASS: ${item.pathOrUrl} status=${gate.status ?? "FINAL_CANDIDATE"}`);
        }
      }
      const result = await loadPreview(item.pathOrUrl, category);
      setPreview(result);
      setLoading(false);
      if (result.error) {
        logger.warn(`[SidePanel] preview 로드 실패: ${item.pathOrUrl} → ${result.error}`);
      } else {
        logger.log(`[SidePanel] preview 로드 성공 — hasDataUrl=${!!result.dataUrl} hasText=${!!result.text}`);
      }
    })();
  }, [item, open, gateOverrides]);

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
        // 로컬 파일은 file:// prefix 추가가 안전.
        // Phase 78 (v0.6.21): react-markdown URL-encoded path 도 복원해서 OS 가 받음.
        const normalizedPath = normalizeLocalPath(item.pathOrUrl);
        // Phase 114 (v0.6.69) — open_path 가 로컬 drive-letter 경로 전체를 신뢰하므로
        // 거의 항상 성공. 옛 폴백이던 plugin-shell.open(normalizedPath) 은 로컬 path 에서
        // 항상 scope regex 에 막혀 "Unexpected command argument ... but found .txt" cryptic
        // 에러를 노출했음 (K 보고 원인) → 제거. open_path 가 없는 옛 binary 일 때만 폴백.
        try {
          await invoke("open_path", { path: normalizedPath });
        } catch (rustErr) {
          const msg = String(rustErr);
          // 옛 binary (command 자체가 미등록) — "not found" / "not allowed" 류면 폴백 시도.
          const isMissingCommand =
            /not found|unknown command|not allowed|command .* not/i.test(msg);
          if (isMissingCommand) {
            await openShell(normalizedPath);
          } else {
            // Rust 가 명시적으로 거부 (네트워크 경로 등) — 그 사유를 그대로 전달.
            throw new Error(msg);
          }
        }
      }
    } catch (e) {
      logger.warn(`[SidePanel] 외부 열기 실패: ${e}`);
      alert(
        `이 파일을 OS 기본 앱으로 열 수 없습니다.\n\n경로: ${item.pathOrUrl}\n사유: ${e}`,
      );
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
              {/* Phase 80 (v0.6.24): Final-Review Gate 차단 카드 */}
              {!loading && preview.blockedByGate && (
                <div
                  style={{
                    padding: "12px 14px",
                    background: "rgba(255, 170, 0, 0.12)",
                    border: "1px solid rgba(255, 170, 0, 0.45)",
                    borderRadius: 6,
                    margin: 8,
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: "1em", marginBottom: 6 }}>
                    ⚠ Final-Review Gate
                  </div>
                  <div style={{ fontSize: "0.85em", marginBottom: 4 }}>
                    이 파일은 <strong>최종 후보 (FINAL_CANDIDATE)</strong> 가 아니어서 차단됐습니다.
                  </div>
                  <div className="mono" style={{ fontSize: "0.8em", opacity: 0.85, marginTop: 8 }}>
                    상태:{" "}
                    <span
                      style={{
                        padding: "1px 6px",
                        borderRadius: 3,
                        background: preview.blockedByGate.status === "FAIL" ? "rgba(255,80,80,0.2)" : "rgba(255,170,0,0.2)",
                        color: preview.blockedByGate.status === "FAIL" ? "#f88" : "#fa0",
                      }}
                    >
                      {preview.blockedByGate.status ?? "(unknown)"}
                    </span>
                  </div>
                  {preview.blockedByGate.reason && (
                    <div style={{ fontSize: "0.8em", opacity: 0.85, marginTop: 4 }}>
                      사유: {preview.blockedByGate.reason}
                    </div>
                  )}
                  <div style={{ fontSize: "0.75em", opacity: 0.6, marginTop: 8 }}>
                    qa-report.json {preview.blockedByGate.qaExists ? "발견됨" : "없음"}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <button
                      className="settings-btn"
                      style={{ fontSize: "0.8em", padding: "3px 10px" }}
                      onClick={() => {
                        if (!item) return;
                        if (!confirm(`⚠ 이 파일은 FINAL_CANDIDATE 가 아닙니다.\n그래도 강제로 미리보기를 표시할까요?\n\n파일: ${item.pathOrUrl}\n상태: ${preview.blockedByGate?.status}\n사유: ${preview.blockedByGate?.reason ?? "(없음)"}`)) return;
                        // 같은 path 는 그 후로 gate 검사 skip
                        setGateOverrides((prev) => {
                          const next = new Set(prev);
                          next.add(item.pathOrUrl);
                          return next;
                        });
                      }}
                    >
                      ⚠ 강제 열기 (이 세션 한정)
                    </button>
                    <button
                      className="settings-btn"
                      style={{ fontSize: "0.8em", padding: "3px 10px" }}
                      onClick={() => onClose?.()}
                    >
                      닫기
                    </button>
                  </div>
                </div>
              )}
              {preview.error && !preview.blockedByGate && (
                <div className="side-panel-error">
                  <strong>미리보기 실패</strong>
                  <div className="mono">{preview.error}</div>
                  <p style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                    "외부 열기" 버튼으로 시도해보세요.
                  </p>
                </div>
              )}
              {!loading && !preview.error && !preview.blockedByGate && (
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
