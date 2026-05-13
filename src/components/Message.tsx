import { memo, useState, useEffect, type ReactNode, isValidElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { open } from "@tauri-apps/plugin-shell";
import type { ChatMessage } from "../types";

interface MessageProps {
  message: ChatMessage;
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

function Message({ message }: MessageProps) {
  const [copied, setCopied] = useState(false);

  if (message.role === "tool") {
    return <ToolMessageView message={message} />;
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
              components={{
                // 링크 클릭 시 기본 브라우저에서 열기
                a: ({ href, children }) => (
                  <a
                    href={href}
                    onClick={(e) => {
                      e.preventDefault();
                      if (href) {
                        open(href).catch(console.error);
                      }
                    }}
                    className="md-link"
                  >
                    {children}
                  </a>
                ),
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

function ToolMessageView({ message }: { message: Extract<ChatMessage, { role: "tool" }> }) {
  // 컴팩트 모드: 한 줄로 표시, 클릭 시 펼침
  return (
    <details className={`msg-tool-compact msg-tool-${message.status}`}>
      <summary className="msg-tool-summary">
        <span className={`tool-pill tool-pill-${message.status}`}>
          {statusLabel(message.status)}
        </span>
        <span className="mono msg-tool-name">{message.toolName}</span>
        <span className="mono msg-time">
          {new Date(message.timestamp).toLocaleTimeString("ko-KR", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}
        </span>
      </summary>
      <div className="msg-tool-expanded">
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
