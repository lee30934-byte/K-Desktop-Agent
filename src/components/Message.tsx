import { memo, useState, useEffect, type ReactNode, isValidElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { open } from "@tauri-apps/plugin-shell";
import type { ChatMessage } from "../types";
import { loadPreview, getCategory, isUrl } from "./SidePanel";
import logger from "../utils/logger";
// Phase 85 (v0.6.28) — Tool Safety Layer 후속. tool_use 카드 risk 배지.
import { RISK_BADGES } from "../utils/toolSafety";

interface MessageProps {
  message: ChatMessage;
  // Phase 44 (v0.5.32): markdown link / file 클릭 → SidePanel 트리거
  onPreviewRequest?: (pathOrUrl: string, label?: string) => void;
  // Phase 90 (v0.6.32): tool_use 카드의 risk/category 배지 클릭 → MainChat filter toggle
  // kind="risk" 면 value=low|medium|high|critical, kind="category" 면 value=string (categoryId)
  onToolFilterToggle?: (kind: "risk" | "category", value: string) => void;
}

// React children 트리에서 평문 텍스트 추출 — 코드 블록 복사용.
// rehype-highlight 가 토큰별 <span> 으로 감싸기 때문에 단순 문자열이 아님.
function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return extractText(props.children);
  }
  return "";
}

// Phase 65 (v0.5.53 후보): markdown 의 ![alt](path) 를 인라인 썸네일로 표시.
// 로컬 파일 path 면 SidePanel 의 loadPreview 로 base64 data URL 로드.
// 클릭 시 onPreviewRequest 로 SidePanel 에 원본 표시.
function InlineImagePreview({
  src,
  alt,
  onPreviewRequest,
}: {
  src: string;
  alt?: string;
  onPreviewRequest?: (pathOrUrl: string, label?: string) => void;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // http(s)/file/data URL 은 그대로 src 사용 — 별도 로드 불필요
    if (isUrl(src) || src.startsWith("data:")) {
      setDataUrl(src);
      setError(null);
      return;
    }
    // 로컬 path — SidePanel 과 동일한 비동기 로드 (Tauri fs.readFile → base64)
    const category = getCategory(src);
    if (category !== "image") {
      setError("이미지 형식 아님");
      return;
    }
    setDataUrl(null);
    setError(null);
    loadPreview(src, "image").then((result) => {
      if (cancelled) return;
      if (result.error) {
        logger.warn(`[InlineImage] 로드 실패: ${src} → ${result.error}`);
        setError(result.error);
      } else if (result.dataUrl) {
        setDataUrl(result.dataUrl);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [src]);

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (onPreviewRequest) {
      onPreviewRequest(src, alt);
    } else {
      open(src).catch(console.error);
    }
  };

  if (error) {
    return (
      <span
        className="md-inline-image-error"
        onClick={handleClick}
        title={`이미지 로드 실패 — 클릭 = 원본 열기: ${error}`}
      >
        🖼️ {alt || src} <small style={{ opacity: 0.6 }}>({error})</small>
      </span>
    );
  }

  if (!dataUrl) {
    return <span className="md-inline-image-loading">🖼️ {alt || "이미지 로딩 중…"}</span>;
  }

  return (
    <img
      src={dataUrl}
      alt={alt || ""}
      className="md-inline-thumbnail"
      onClick={handleClick}
      title="클릭 = 원본 미리보기"
    />
  );
}

// 코드 블록 wrapper — 우상단 복사 버튼.
function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      const text = extractText(children).replace(/\n$/, "");
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("[CodeBlock] copy failed:", err);
    }
  };

  return (
    <div className="md-code-block-wrapper">
      <button
        className={`md-code-copy-btn ${copied ? "copied" : ""}`}
        onClick={handleCopy}
        title="코드 복사"
        aria-label="코드 복사"
      >
        {copied ? "✓ 복사됨" : "📋 복사"}
      </button>
      <pre className="md-code-block">{children}</pre>
    </div>
  );
}

function Message({ message, onPreviewRequest, onToolFilterToggle }: MessageProps) {
  const [copied, setCopied] = useState(false);

  if (message.role === "tool") {
    return <ToolMessageView message={message} onFilterToggle={onToolFilterToggle} />;
  }

  const isAssistant = message.role === "assistant";
  const isStreaming = isAssistant && (message as any).streaming;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <div className={`msg msg-${message.role}`}>
      <div className="msg-head">
        <span className="eyebrow msg-role">{roleLabel(message.role)}</span>
        <span className="mono msg-time">
          {new Date(message.timestamp).toLocaleTimeString("ko-KR", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}
        </span>
        <button
          className={`msg-copy-btn ${copied ? "copied" : ""}`}
          onClick={handleCopy}
          title="메시지 복사"
        >
          {copied ? "✓" : "📋"}
        </button>
      </div>
      <div className="msg-body markdown-content">
        {isAssistant ? (
          <>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              // Phase 77 (v0.6.20): react-markdown v10 의 default urlTransform 은 보안 화이트리스트
              // (http/https/mailto/tel + 상대경로) 외 URL — Windows path (C:\Users\...), file://,
              // 등 — 을 빈 값으로 sanitize 한다. KDA 의 채팅 마크다운 링크는 K 의 로컬 파일을
              // 가리키는 경우가 많아 default 가 그걸 모두 drop → onClick 의 `if (!href) return;`
              // 에서 일찍 빠지고 SidePanel 호출 0. K 가 "사이드 패널 안 열린다" 로 인식.
              // 회피: identity transform — KDA 는 onClick 에서 preventDefault + 명시적 처리하므로
              // unsafe URL (javascript: 등) 도 native href click 으로 dispatch 안 됨. 안전.
              urlTransform={(url) => url}
              components={{
                // Phase 44 (v0.5.32): 링크 클릭 → SidePanel 미리보기 (있으면). 없으면 외부 열기.
                // Phase 77 (v0.6.20): onClick path 진단 로그 추가 — 다음번 빈 화면 보고 시
                // sidecar.log 에서 [Message a onClick] 라인 보고 어느 단계 실패인지 즉시 파악.
                a: ({ href, children }) => {
                  const label = typeof children === "string" ? children : undefined;
                  return (
                    <a
                      href={href}
                      onClick={(e) => {
                        e.preventDefault();
                        logger.log("[Message a onClick]", {
                          hasHref: !!href,
                          hrefPrefix: href ? href.slice(0, 60) : null,
                          hasOnPreviewRequest: !!onPreviewRequest,
                          label,
                        });
                        if (!href) {
                          logger.warn("[Message a onClick] href 없음 — 무시");
                          return;
                        }
                        if (onPreviewRequest) {
                          // SidePanel 우선 — 사용자가 거기서 "외부 열기" 버튼으로 dispatch 가능
                          onPreviewRequest(href, label);
                        } else {
                          // 폴백: Tauri 의 system shell 로 외부 열기
                          logger.warn("[Message a onClick] onPreviewRequest 없음 — open(href) 폴백");
                          open(href).catch((err) =>
                            logger.error("[Message a onClick] open(href) 실패:", err)
                          );
                        }
                      }}
                      className="md-link"
                      title="클릭 = 사이드 패널에서 미리보기"
                    >
                      {children}
                    </a>
                  );
                },
                // Phase 65 (v0.5.53 후보): markdown 이미지 `![alt](path)` → 인라인 썸네일.
                // 로컬 파일 path 면 Tauri fs.readFile 로 base64 data URL 로드 (CSP 안전).
                // 클릭 시 SidePanel 에 원본 표시.
                img: ({ src, alt }) => {
                  if (!src || typeof src !== "string") return null;
                  return (
                    <InlineImagePreview
                      src={src}
                      alt={typeof alt === "string" ? alt : undefined}
                      onPreviewRequest={onPreviewRequest}
                    />
                  );
                },
                // 코드 블록 스타일링
                code: ({ className, children, ...props }) => {
                  const isInline = !className;
                  return isInline ? (
                    <code className="md-inline-code" {...props}>
                      {children}
                    </code>
                  ) : (
                    <code className={className} {...props}>
                      {children}
                    </code>
                  );
                },
                // pre 태그 — 복사 버튼이 달린 wrapper 로 교체
                pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
              }}
            >
              {message.content}
            </ReactMarkdown>
            {isStreaming && <span className="msg-cursor">▊</span>}
          </>
        ) : (
          // user/system 메시지는 plain text
          message.content
        )}
      </div>
      {message.role === "user" && (message as any).attachments?.length > 0 && (
        <AttachmentPreviewList attachments={(message as any).attachments} />
      )}
    </div>
  );
}

// ─── 사용자 메시지의 첨부 파일 미리보기 ────────────────────────
// 이미지: 썸네일 (data:base64 또는 preview URL)
// 비디오/오디오: <video>/<audio> controls 박스
// 그 외: 파일 아이콘 + 이름 + 크기
// Phase 42 (v0.5.30): 첨부 lightbox modal — 클릭 시 원본 크기로 열림
function AttachmentLightbox({
  attachment,
  onClose,
}: {
  attachment: { name: string; type: string; size: number; base64?: string; preview?: string };
  onClose: () => void;
}) {
  const dataUrl =
    attachment.preview ||
    (attachment.base64 ? `data:${attachment.type};base64,${attachment.base64}` : null);
  const isImage = attachment.type.startsWith("image/");
  const isVideo = attachment.type.startsWith("video/");
  const isAudio = attachment.type.startsWith("audio/");

  // ESC 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!dataUrl) return null;

  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <button
        type="button"
        className="lightbox-close"
        onClick={onClose}
        title="닫기 (ESC)"
        aria-label="첨부 보기 닫기"
      >
        ✕
      </button>
      <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
        {isImage && (
          <img src={dataUrl} alt={attachment.name} className="lightbox-image" />
        )}
        {isVideo && (
          <video src={dataUrl} className="lightbox-video" controls autoPlay preload="metadata" />
        )}
        {isAudio && (
          <audio src={dataUrl} className="lightbox-audio" controls autoPlay preload="metadata" />
        )}
        <div className="lightbox-caption mono">
          <span>{attachment.name}</span>
          <span style={{ opacity: 0.6 }}>· {formatBytes(attachment.size)}</span>
        </div>
      </div>
    </div>
  );
}

function AttachmentPreviewList({
  attachments,
}: {
  attachments: Array<{ name: string; type: string; size: number; base64?: string; preview?: string }>;
}) {
  // Phase 42: 클릭 시 lightbox 로 원본 표시
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  return (
    <div className="msg-attachments">
      {attachments.map((att, idx) => {
        // 우선 preview (URL.createObjectURL) 사용, 없거나 revoke 됐으면 base64 data URL fallback.
        const dataUrl = att.preview || (att.base64 ? `data:${att.type};base64,${att.base64}` : null);
        const isImage = att.type.startsWith("image/");
        const isVideo = att.type.startsWith("video/");
        const isAudio = att.type.startsWith("audio/");
        const isPreviewable = (isImage || isVideo || isAudio) && Boolean(dataUrl);
        return (
          <div
            key={idx}
            className={`msg-attachment-item ${isPreviewable ? "clickable" : ""}`}
            onClick={() => {
              if (isPreviewable) setLightboxIdx(idx);
            }}
            title={isPreviewable ? "클릭 = 원본 크기 보기" : undefined}
          >
            {dataUrl && isImage ? (
              <img
                src={dataUrl}
                alt={att.name}
                className="msg-attachment-image"
                onError={(e) => {
                  // preview 가 revoke 된 경우 base64 fallback
                  if (att.base64 && !e.currentTarget.dataset.fallback) {
                    e.currentTarget.dataset.fallback = "1";
                    e.currentTarget.src = `data:${att.type};base64,${att.base64}`;
                  }
                }}
              />
            ) : dataUrl && isVideo ? (
              <video
                src={dataUrl}
                className="msg-attachment-video"
                controls
                preload="metadata"
                onClick={(e) => e.stopPropagation()}
              />
            ) : dataUrl && isAudio ? (
              <audio
                src={dataUrl}
                className="msg-attachment-audio"
                controls
                preload="metadata"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="msg-attachment-icon">{getAttachmentIcon(att.type)}</span>
            )}
            <div className="msg-attachment-info mono">
              <span className="msg-attachment-name">{att.name}</span>
              <span className="msg-attachment-size">{formatBytes(att.size)}</span>
              {isPreviewable && (
                <span className="msg-attachment-hint">🔍 클릭 = 원본</span>
              )}
            </div>
          </div>
        );
      })}
      {lightboxIdx !== null && attachments[lightboxIdx] && (
        <AttachmentLightbox
          attachment={attachments[lightboxIdx]}
          onClose={() => setLightboxIdx(null)}
        />
      )}
    </div>
  );
}

function getAttachmentIcon(type: string): string {
  if (type.startsWith("image/")) return "🖼️";
  if (type.startsWith("video/")) return "🎬";
  if (type.startsWith("audio/")) return "🎵";
  if (type.includes("pdf")) return "📕";
  if (type.includes("zip") || type.includes("rar") || type.includes("7z") || type.includes("tar")) return "📦";
  if (type.includes("word") || type.includes("document")) return "📄";
  if (type.includes("sheet") || type.includes("excel") || type.includes("csv")) return "📊";
  if (type.includes("json") || type.includes("xml") || type.includes("yaml")) return "📋";
  if (type.includes("text") || type.includes("javascript") || type.includes("typescript")) return "📝";
  return "📎";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ToolMessageView({
  message,
  onFilterToggle,
}: {
  message: Extract<ChatMessage, { role: "tool" }>;
  onFilterToggle?: (kind: "risk" | "category", value: string) => void;
}) {
  // Phase 85 (v0.6.28) — risk 배지. sidecar 가 분류 못 한 도구는 risk=undefined → 배지 숨김.
  const riskBadge = message.risk ? RISK_BADGES[message.risk.level] : null;
  const isHighRisk = message.risk?.level === "high" || message.risk?.level === "critical";
  // 컴팩트 모드: 한 줄로 표시, 클릭 시 펼침
  return (
    <details
      className={`msg-tool-compact msg-tool-${message.status}`}
      data-risk={message.risk?.level ?? "unknown"}
      style={
        isHighRisk && riskBadge
          ? { borderLeft: `3px solid ${riskBadge.color}`, paddingLeft: "0.4rem" }
          : undefined
      }
    >
      <summary className="msg-tool-summary">
        <span className={`tool-pill tool-pill-${message.status}`}>
          {statusLabel(message.status)}
        </span>
        <span className="mono msg-tool-name">{message.toolName}</span>
        {riskBadge && message.risk && (
          <span
            title={
              onFilterToggle
                ? `클릭하면 위험도 "${message.risk.level}" 만 보기 — ${message.risk.summary}`
                : (message.risk?.summary ?? "")
            }
            onClick={(e) => {
              if (!onFilterToggle || !message.risk) return;
              e.preventDefault();
              e.stopPropagation();
              onFilterToggle("risk", message.risk.level);
            }}
            style={{
              marginLeft: "0.4rem",
              fontSize: "0.7em",
              padding: "0.1em 0.45em",
              borderRadius: 4,
              background: `${riskBadge.color}22`,
              border: `1px solid ${riskBadge.color}66`,
              color: riskBadge.color,
              fontWeight: 600,
              whiteSpace: "nowrap",
              cursor: onFilterToggle ? "pointer" : "default",
            }}
          >
            {riskBadge.icon} {riskBadge.label}
          </span>
        )}
        {message.risk?.categoryId && (
          <span
            title={
              onFilterToggle
                ? `클릭하면 카테고리 "${message.risk.categoryId}" 만 보기`
                : `category: ${message.risk.categoryId}`
            }
            onClick={(e) => {
              if (!onFilterToggle || !message.risk?.categoryId) return;
              e.preventDefault();
              e.stopPropagation();
              onFilterToggle("category", message.risk.categoryId);
            }}
            style={{
              marginLeft: "0.3rem",
              fontSize: "0.7em",
              padding: "0.1em 0.45em",
              borderRadius: 4,
              background: "rgba(255,255,255,0.04)",
              border: "1px solid var(--border-subtle)",
              opacity: 0.85,
              whiteSpace: "nowrap",
              cursor: onFilterToggle ? "pointer" : "default",
            }}
          >
            📁 {message.risk.categoryId}
          </span>
        )}
        <span className="mono msg-time">
          {new Date(message.timestamp).toLocaleTimeString("ko-KR", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}
        </span>
      </summary>
      <div className="msg-tool-expanded">
        {message.risk && (
          <div className="msg-tool-section" style={{ fontSize: "0.85em", opacity: 0.85 }}>
            <span className="eyebrow">Risk</span>
            <div style={{ marginTop: 4 }}>
              <strong style={{ color: riskBadge?.color }}>
                {riskBadge?.icon} {riskBadge?.label}
              </strong>
              {message.risk.categoryId && (
                <span style={{ marginLeft: 6, opacity: 0.7 }}>
                  · category={message.risk.categoryId}
                </span>
              )}
              <div style={{ marginTop: 2, opacity: 0.85 }}>{message.risk.summary}</div>
            </div>
          </div>
        )}
        {message.toolInput != null && (
          <div className="msg-tool-section">
            <span className="eyebrow">Arguments</span>
            <pre className="mono msg-tool-json">
              {JSON.stringify(message.toolInput, null, 2)}
            </pre>
          </div>
        )}
        {message.toolOutput && (
          <div className="msg-tool-section">
            <span className="eyebrow">Output</span>
            <pre className="mono msg-tool-json">{message.toolOutput}</pre>
          </div>
        )}
      </div>
    </details>
  );
}

// React.memo — message 객체 참조가 바뀌지 않으면 리렌더 스킵.
// App.tsx 의 매초 setTick 등으로 인한 부모 리렌더 시 ReactMarkdown 재파싱 폭탄을 방지.
// 스트리밍 중인 메시지는 객체 참조가 매 청크마다 새로 만들어지므로 정상적으로 갱신됨.
export default memo(Message, (prev, next) => prev.message === next.message);

function roleLabel(role: string): string {
  switch (role) {
    case "user":
      return "You";
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    default:
      return role;
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "RUNNING";
    case "success":
      return "DONE";
    case "error":
      return "FAILED";
    default:
      return status.toUpperCase();
  }
}
