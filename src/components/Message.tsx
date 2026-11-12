import { memo, useState, useEffect, type ReactNode, isValidElement } from "react";
import ReactMarkdown from "react-markdown";
import { toolResultOutcome } from "../toolResultOutcome";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { open } from "@tauri-apps/plugin-shell";
import type { ChatMessage } from "../types";
import { loadPreview, getCategory, isUrl } from "./SidePanel";
// v0.7.51 — 채팅 본문의 영상/음악 링크를 바로 재생하는 작은 플레이어.
import InlineMediaPlayer from "./InlineMediaPlayer";
import { isMediaStreamUrl } from "../utils/mediaStream";
import logger from "../utils/logger";
import { useUiLayout } from "../utils/useUiLayout";
import { Icon, type IconName } from "../ui/icons";
// Phase 85 (v0.6.28) — Tool Safety Layer 후속. tool_use 카드 risk 배지.
import { RISK_BADGES } from "../utils/toolSafety";
// v0.7.50 — 화면용 로딩에서 잘린 도구 원문을 필요할 때만 DB 에서 읽는다.
import { getToolMessagePayload } from "../db";

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
  // v0.7.51 — 스트리밍 URL 로 표시 실패 시 한 번만 data URL 로 폴백.
  const [legacyTried, setLegacyTried] = useState(false);
  const { isO2 } = useUiLayout();

  useEffect(() => {
    let cancelled = false;
    setLegacyTried(false);
    // http(s)/data URL 은 그대로 src 사용 — 별도 로드 불필요.
    // (file:// 은 웹뷰가 차단하므로 로컬 경로로 정규화해 아래 로드 경로를 탄다.)
    if ((isUrl(src) && !/^file:/i.test(src)) || src.startsWith("data:")) {
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
        {isO2 ? <Icon name="image" size={14} /> : "🖼️"} {alt || src} <small style={{ opacity: 0.6 }}>({error})</small>
      </span>
    );
  }

  if (!dataUrl) {
    return <span className="md-inline-image-loading">{isO2 ? <Icon name="image" size={14} /> : "🖼️"} {alt || "이미지 로딩 중…"}</span>;
  }

  const handleImgError = () => {
    if (!legacyTried && isMediaStreamUrl(dataUrl ?? undefined)) {
      setLegacyTried(true);
      logger.warn(`[InlineImage] 스트리밍 표시 실패 → data URL 폴백: ${src}`);
      loadPreview(src, "image", { legacy: true }).then((r) => {
        if (r.dataUrl && !r.error) setDataUrl(r.dataUrl);
        else setError(r.error ?? "이미지를 표시하지 못했습니다");
      });
      return;
    }
    setError("이미지를 표시하지 못했습니다");
  };

  return (
    <img
      src={dataUrl}
      alt={alt || ""}
      className="md-inline-thumbnail"
      onClick={handleClick}
      onError={handleImgError}
      title="클릭 = 원본 미리보기"
    />
  );
}

// dzB — 코드 블록 언어 이름 (```powershell → <code class="hljs language-powershell">). 없으면 null.
function codeLanguage(children: ReactNode): string | null {
  const first = Array.isArray(children) ? children[0] : children;
  if (!isValidElement(first)) return null;
  const cls = (first.props as { className?: string }).className ?? "";
  const m = cls.match(/(?:^|\s)language-([\w#+.-]+)/);
  return m ? m[1] : null;
}

// dzB — 파일 칩 둘째 줄의 종류 이름 (확장자 기준, 모르면 대문자 확장자)
const FILE_KINDS: Record<string, string> = {
  ps1: "PowerShell", md: "마크다운", txt: "텍스트", pdf: "PDF", json: "JSON", csv: "CSV", xlsx: "엑셀", xls: "엑셀",
  docx: "워드", doc: "워드", hwp: "한글", pptx: "파워포인트", py: "Python", ts: "TypeScript", tsx: "TypeScript",
  js: "JavaScript", html: "HTML", css: "CSS", png: "이미지", jpg: "이미지", jpeg: "이미지", gif: "이미지", webp: "이미지",
  zip: "압축 파일", log: "로그",
};
function fileKindLabel(href: string): string {
  const name = href.split(/[\\/]/).pop() ?? href;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return FILE_KINDS[ext] ?? (ext ? ext.toUpperCase() : "파일");
}

// 코드 블록 wrapper — 우상단 복사 버튼.
function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const { isO2 } = useUiLayout();

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

  // dzB (o2) — 목업 .code: 머리 줄(언어 · 복사) + 줄 번호 + 같은 mono. classic 은 아래 예전 모양 그대로.
  if (isO2) {
    const text = extractText(children).replace(/\n$/, "");
    const lineCount = Math.max(1, text.split("\n").length);
    return (
      <div className="md-code-block-wrapper md-code-block-wrapper--o2">
        <div className="md-code-head">
          <span className="md-code-lang">{codeLanguage(children) ?? "코드"}</span>
          <span className="md-code-head__grow" />
          <button
            type="button"
            className={`md-code-copy-btn ${copied ? "copied" : ""}`}
            onClick={handleCopy}
            title="코드 복사"
            aria-label="코드 복사"
          >
            <Icon name={copied ? "check" : "copy"} size={14} />
            {copied ? "복사됨" : "복사"}
          </button>
        </div>
        <div className="md-code-body">
          <span className="md-code-lines" aria-hidden="true">
            {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
          </span>
          <pre className="md-code-block">{children}</pre>
        </div>
      </div>
    );
  }

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
  // v0.7.86 fidA (o2) — 파일 링크는 파일 칩 카드, 답변 아래 작은 동작 줄(복사). classic 은 예전 그대로.
  const { isO2 } = useUiLayout();

  if (message.role === "tool") {
    return <ToolMessageView message={message} onFilterToggle={onToolFilterToggle} />;
  }

  // dzB (o2) — 시스템 알림은 카드: 오류 = 빨강 아이콘 + 옅은 판(목업 .card.err), 주의 = 주황 아이콘, 안내 = 무채색.
  // 앞의 기호(⚠️ · Error:)는 아이콘이 대신하므로 떼고 보여 준다. classic 은 아래 예전 한 줄 그대로.
  if (isO2 && message.role === "system") {
    const level = message.level ?? "info";
    const text = message.content.replace(/^(?:[⚠❌✅ℹ🤝🤖️️]+\s*|Error:\s*)/u, "");
    return (
      <div className={`msg msg-system msg-system--${level}`} role={level === "error" ? "alert" : "status"}>
        <Icon name={level === "error" ? "alert" : level === "warn" ? "alertCircle" : "info"} size={level === "error" ? 20 : 16} className="msg-system__icon" />
        <div className="msg-system__text">
          {level === "error" && <div className="msg-system__title">문제가 생겼어요</div>}
          <div className="msg-system__body">{text}</div>
        </div>
      </div>
    );
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
                  // v0.7.51 — 영상/음악 링크면 링크 옆에 "▶ 재생" 인라인 플레이어를 붙인다.
                  const mediaKind = href ? getCategory(href) : null;
                  const anchor = (
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
                  // fidA (o2) — 로컬 파일 링크는 목업의 파일 칩 ('design-spec.md · 클릭하면 미리보기'). 동작은 같은 미리보기.
                  if (isO2 && href && !isUrl(href) && mediaKind !== "video" && mediaKind !== "audio" && !/^(mailto:|#)/i.test(href)) {
                    return (
                      <a href={href} className="md-link md-file-chip" title="클릭 = 미리보기"
                        onClick={(e) => {
                          e.preventDefault();
                          if (onPreviewRequest) onPreviewRequest(href, label);
                          else open(href).catch((err) => logger.error("[Message file chip] open 실패:", err));
                        }}>
                        <span className="md-file-chip__tile" aria-hidden="true"><Icon name="file" size={18} /></span>
                        <span className="md-file-chip__text">
                          <span className="md-file-chip__name">{children}</span>
                          <span className="md-file-chip__hint">{fileKindLabel(href)} · 클릭하면 미리보기</span>
                        </span>
                        <Icon name="eye" className="md-file-chip__go" />
                      </a>
                    );
                  }
                  if (href && (mediaKind === "video" || mediaKind === "audio")) {
                    return (
                      <>
                        {anchor}
                        <InlineMediaPlayer
                          src={href}
                          label={label ?? (extractText(children) || undefined)}
                          kind={mediaKind}
                          onPreviewRequest={onPreviewRequest}
                        />
                      </>
                    );
                  }
                  return anchor;
                },
                // Phase 65 (v0.5.53 후보): markdown 이미지 `![alt](path)` → 인라인 썸네일.
                // 로컬 파일 path 면 Tauri fs.readFile 로 base64 data URL 로드 (CSP 안전).
                // 클릭 시 SidePanel 에 원본 표시.
                // v0.7.51 — `![제목](영상.mp4)` 처럼 미디어를 이미지 문법으로 넣어도 인라인 플레이어로.
                img: ({ src, alt }) => {
                  if (!src || typeof src !== "string") return null;
                  const kind = getCategory(src);
                  if (kind === "video" || kind === "audio") {
                    const label = typeof alt === "string" && alt ? alt : undefined;
                    return (
                      <>
                        <span className="md-inline-media-label">{isO2 ? <Icon name={kind === "video" ? "film" : "music"} size={14} /> : kind === "video" ? "🎬" : "🎵"} {label ?? src}</span>
                        <InlineMediaPlayer src={src} label={label} kind={kind} onPreviewRequest={onPreviewRequest} />
                      </>
                    );
                  }
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
                // dzB (o2) — 표는 둥근 테두리 틀(가로 스크롤) 안에, 숫자 칸은 고정폭 숫자. classic 은 기본 table/td 그대로.
                table: ({ children }) =>
                  isO2 ? <div className="md-table-wrap"><table>{children}</table></div> : <table>{children}</table>,
                td: ({ children, style }) =>
                  isO2 && /^[\s\d.,%+\-−:/~()]+$/.test(extractText(children)) && /\d/.test(extractText(children))
                    ? <td style={style} className="is-num">{children}</td>
                    : <td style={style}>{children}</td>,
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
      {isO2 && isAssistant && !isStreaming && (
        <div className="msg-actbar" role="group" aria-label="답변 동작">
          <button type="button" className="msg-act" onClick={handleCopy} aria-label="답변 복사" title={copied ? "복사됨" : "복사"}>
            <Icon name={copied ? "check" : "copy"} size={14} />
          </button>
        </div>
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
  const { isO2 } = useUiLayout();
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
              <span className="msg-attachment-icon">{isO2 ? <Icon name={o2AttachmentIcon(att.type)} size={18} /> : getAttachmentIcon(att.type)}</span>
            )}
            <div className="msg-attachment-info mono">
              <span className="msg-attachment-name">{att.name}</span>
              <span className="msg-attachment-size">{formatBytes(att.size)}</span>
              {isPreviewable && (
                <span className="msg-attachment-hint">{isO2 ? "클릭하면 원본" : "🔍 클릭 = 원본"}</span>
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

// dzB (o2) — 첨부 아이콘도 라인 아이콘 (classic 은 아래 이모지 그대로)
function o2AttachmentIcon(type: string): IconName {
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "film";
  if (type.startsWith("audio/")) return "music";
  if (type.includes("sheet") || type.includes("excel") || type.includes("csv")) return "sheet";
  if (type.includes("text") || type.includes("json") || type.includes("javascript") || type.includes("typescript")) return "note";
  return "file";
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

// Phase 98.5 (v0.6.44) — 이미지 lightbox modal. 본문 썸네일 클릭 시 원본 크기로 띄움.
// Phase 99 (v0.6.45) — ←/→ navigation + counter + download + clipboard.
// chat 메신저 (카톡/Slack/Discord) 의 표준 UX. ESC / ✕ / 빈 공간 클릭으로 닫힘.
function ImageLightbox({
  images,
  index,
  onClose,
  onIndexChange,
}: {
  images: string[];
  index: number;
  onClose: () => void;
  onIndexChange: (i: number) => void;
}) {
  const src = images[index];
  const hasNav = images.length > 1;
  const goPrev = () => onIndexChange((index - 1 + images.length) % images.length);
  const goNext = () => onIndexChange((index + 1) % images.length);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (hasNav && e.key === "ArrowLeft") goPrev();
      else if (hasNav && e.key === "ArrowRight") goNext();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, images.length]);

  const onDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `kda-image-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[ImageLightbox] download failed:", err);
    }
  };

  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      // ClipboardItem 으로 이미지 type 보존. webview2 (Chromium) 지원.
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob }),
      ]);
    } catch (err) {
      console.error("[ImageLightbox] clipboard write failed:", err);
    }
  };

  const btnStyle: React.CSSProperties = {
    background: "rgba(255,255,255,0.12)",
    border: "1px solid rgba(255,255,255,0.2)",
    color: "white",
    fontSize: 18,
    padding: "6px 12px",
    cursor: "pointer",
    borderRadius: 6,
    lineHeight: 1,
  };

  const navBtnStyle: React.CSSProperties = {
    ...btnStyle,
    position: "absolute",
    top: "50%",
    transform: "translateY(-50%)",
    fontSize: 28,
    padding: "12px 16px",
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.88)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "zoom-out",
      }}
    >
      {/* counter — 좌상단, 다중 이미지일 때만 */}
      {hasNav && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: 16,
            left: 16,
            background: "rgba(0,0,0,0.5)",
            border: "1px solid rgba(255,255,255,0.2)",
            color: "white",
            fontSize: 14,
            padding: "6px 12px",
            borderRadius: 6,
            fontFamily: "var(--font-mono, monospace)",
          }}
        >
          {index + 1} / {images.length}
        </div>
      )}

      {/* button cluster — 우상단 */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          display: "flex",
          gap: 8,
        }}
      >
        <button onClick={onCopy} style={btnStyle} title="클립보드에 복사">
          📋
        </button>
        <button onClick={onDownload} style={btnStyle} title="다운로드">
          ⬇
        </button>
        <button onClick={onClose} style={btnStyle} title="닫기 (ESC)" aria-label="닫기">
          ✕
        </button>
      </div>

      {/* prev/next — 좌우 가운데, 다중 이미지일 때만 */}
      {hasNav && (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation();
              goPrev();
            }}
            style={{ ...navBtnStyle, left: 16 }}
            title="이전 (←)"
            aria-label="이전 이미지"
          >
            ◀
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              goNext();
            }}
            style={{ ...navBtnStyle, right: 16 }}
            title="다음 (→)"
            aria-label="다음 이미지"
          >
            ▶
          </button>
        </>
      )}

      <img
        src={src}
        alt={`이미지 ${index + 1} / ${images.length}`}
        style={{
          maxWidth: "95vw",
          maxHeight: "95vh",
          objectFit: "contain",
          cursor: "default",
          boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
        }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

// Phase 99 — 썸네일 hover 시 살짝 enlarge (chat 메신저 느낌).
function ImageThumbnail({
  src,
  index,
  total,
  onClick,
}: {
  src: string;
  index: number;
  total: number;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      title={`이미지 ${index + 1}${total > 1 ? ` / ${total}` : ""} — 클릭하면 원본 크기로`}
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "block",
        border: "1px solid var(--border-subtle)",
        borderRadius: 8,
        overflow: "hidden",
        background: "rgba(255,255,255,0.02)",
        lineHeight: 0,
        cursor: "zoom-in",
        transform: hover ? "scale(1.03)" : "scale(1)",
        transition: "transform 0.15s ease-out, box-shadow 0.15s ease-out",
        boxShadow: hover ? "0 4px 16px rgba(0,0,0,0.3)" : "none",
      }}
    >
      <img
        src={src}
        alt={`screenshot ${index + 1}`}
        style={{
          display: "block",
          width: "100%",
          height: "auto",
          maxHeight: 180,
          objectFit: "cover",
        }}
        loading="lazy"
      />
    </a>
  );
}

// Phase 115 (v0.6.70) — 채팅창 도구 이미지 표시 모드.
// 종전엔 도구 결과에 이미지가 있으면 무조건 큰 썸네일로 inline 표시 → 모델이 작업 중
// 자동으로 찍는 스크린샷까지 전부 떠서 K 가 "아무거나 사진 다 뜬다" 호소.
// localStorage kda_tool_image_mode 로 제어:
//   "collapsed"(기본)   — 모든 도구 이미지는 작은 footnote 로 접고, 클릭 시 펼침
//   "screenshot_only"   — cc_screenshot / web_screenshot 류만 inline, 나머지는 접음
//   "all"               — 종전 동작 (전부 inline)
// Settings 의 ToolImageModeToggle 가 변경 + kda-tool-image-mode-changed 이벤트 dispatch.
export type ToolImageMode = "collapsed" | "screenshot_only" | "all";
function readToolImageMode(): ToolImageMode {
  try {
    const v = localStorage.getItem("kda_tool_image_mode");
    if (v === "all" || v === "screenshot_only" || v === "collapsed") return v;
  } catch {
    /* localStorage 접근 불가 — 기본값 */
  }
  return "collapsed";
}
function useToolImageMode(): ToolImageMode {
  const [mode, setMode] = useState<ToolImageMode>(readToolImageMode);
  useEffect(() => {
    const refresh = () => setMode(readToolImageMode());
    window.addEventListener("kda-tool-image-mode-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("kda-tool-image-mode-changed", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return mode;
}
// 명시적 화면/웹 캡처 도구만 inline 후보 (screenshot_only 모드).
function isScreenshotTool(toolName: string | undefined): boolean {
  return !!toolName && /screenshot/i.test(toolName);
}

function ToolMessageView({
  message,
  onFilterToggle,
}: {
  message: Extract<ChatMessage, { role: "tool" }>;
  onFilterToggle?: (kind: "risk" | "category", value: string) => void;
}) {
  const outcome = toolResultOutcome(message.toolName, message.toolOutput ?? "", message.status);
  const displayStatus = message.status === "pending" ? "pending" : outcome.status;
  // Phase 85 (v0.6.28) — risk 배지. sidecar 가 분류 못 한 도구는 risk=undefined → 배지 숨김.
  const riskBadge = message.risk ? RISK_BADGES[message.risk.level] : null;
  const isHighRisk = message.risk?.level === "high" || message.risk?.level === "critical";
  // Phase 98.2 — 이미지가 있는 도구 호출은 chat-like 한 본문 형태로 표시.
  // Phase 98.5 — 본문은 작은 썸네일, 클릭 시 in-app lightbox 로 원본 크기.
  // Phase 99 — lightbox ←/→ navigation + counter + download + clipboard, 썸네일 hover scale.
  const hasImages = Array.isArray(message.images) && message.images.length > 0;
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // v0.7.50 — 잘린 도구 원문(앞부분만 표시) → "전체 불러오기" 로 DB 원문을 카드 안에서만 표시.
  // 메시지 객체는 바꾸지 않는다(저장 보호 판정과 프롬프트 이력이 미리보기 기준으로 일관되게).
  const isTruncated = typeof message.inputPreview === "string" || typeof message.outputPreview === "string";
  const [fullPayload, setFullPayload] = useState<{ toolInput: unknown; toolOutput: string | undefined } | null>(null);
  const [payloadState, setPayloadState] = useState<"idle" | "loading" | "error">("idle");
  const loadFullPayload = async () => {
    setPayloadState("loading");
    try {
      const payload = await getToolMessagePayload(message.id);
      if (!payload) throw new Error("메시지를 DB 에서 찾지 못했습니다");
      setFullPayload(payload);
      setPayloadState("idle");
    } catch (err) {
      logger.warn(`[ToolMessageView] 원문 불러오기 실패 id=${message.id}: ${err instanceof Error ? err.message : String(err)}`);
      setPayloadState("error");
    }
  };
  const shownInput = fullPayload ? fullPayload.toolInput : message.toolInput;
  const shownOutput = fullPayload ? fullPayload.toolOutput : message.toolOutput;
  const inputText =
    !fullPayload && typeof message.inputPreview === "string"
      ? `${message.inputPreview}…`
      : JSON.stringify(shownInput, null, 2);
  const outputText =
    !fullPayload && typeof message.outputPreview === "string" ? `${shownOutput ?? ""}…` : shownOutput;
  // Phase 115 (v0.6.70) — 표시 모드. inline 으로 크게 띄울지, footnote 로 접을지 결정.
  const imageMode = useToolImageMode();
  const { isO2 } = useUiLayout();
  const showInline =
    hasImages &&
    (imageMode === "all" ||
      (imageMode === "screenshot_only" && isScreenshotTool(message.toolName)));
  // 접힌 케이스: 이미지를 footnote(details) 안으로 넣어 기본 숨김 → 클릭 시 펼침.
  // 모델이 작업 중 자동으로 찍는 스크린샷이 채팅을 도배하는 걸 막음.
  if (hasImages && !showInline) {
    return (
      <div className="msg-tool-image-mode msg-tool-image-collapsed">
        {lightboxIndex !== null && (
          <ImageLightbox
            images={message.images!}
            index={lightboxIndex}
            onClose={() => setLightboxIndex(null)}
            onIndexChange={setLightboxIndex}
          />
        )}
        <details
          className={`msg-tool-image-footnote msg-tool-${message.status}`}
          data-risk={message.risk?.level ?? "unknown"}
          style={{ fontSize: "0.74em", opacity: 0.6, marginTop: 2 }}
        >
          <summary style={{ cursor: "pointer", listStyle: "none", userSelect: "none" }}>
            <span style={{ fontFamily: "var(--font-mono, monospace)" }}>
              {isO2 ? <Icon name="image" size={13} /> : "🖼️"} {message.toolName}
            </span>
            <span style={{ marginLeft: 6 }}>
              ·{" "}
              {new Date(message.timestamp).toLocaleTimeString("ko-KR", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })}
            </span>
            <span style={{ marginLeft: 6 }}>· 이미지 {message.images!.length}장</span>
            <span style={{ marginLeft: 6, opacity: 0.7 }}>· 클릭해서 보기</span>
          </summary>
          <div
            className="msg-tool-images-inline"
            style={{
              display: "grid",
              gridTemplateColumns:
                message.images!.length === 1
                  ? "minmax(0, 280px)"
                  : "repeat(auto-fill, minmax(180px, 220px))",
              gap: 8,
              marginTop: 8,
              marginBottom: 4,
            }}
          >
            {message.images!.map((src, i) => (
              <ImageThumbnail
                key={i}
                src={src}
                index={i}
                total={message.images!.length}
                onClick={() => setLightboxIndex(i)}
              />
            ))}
          </div>
          {message.toolInput != null && (
            <pre
              className="mono msg-tool-json"
              style={{ fontSize: "0.95em", padding: "4px 8px" }}
            >
              {JSON.stringify(message.toolInput, null, 2)}
            </pre>
          )}
        </details>
      </div>
    );
  }
  // 이미지 있는 케이스 (inline 표시): 본문 썸네일 + 클릭 시 lightbox + 그 아래 한 줄 footnote
  if (hasImages) {
    return (
      <div className="msg-tool-image-mode">
        {lightboxIndex !== null && (
          <ImageLightbox
            images={message.images!}
            index={lightboxIndex}
            onClose={() => setLightboxIndex(null)}
            onIndexChange={setLightboxIndex}
          />
        )}
        <div
          className="msg-tool-images-inline"
          style={{
            display: "grid",
            gridTemplateColumns:
              message.images!.length === 1
                ? "minmax(0, 280px)"
                : "repeat(auto-fill, minmax(180px, 220px))",
            gap: 8,
            marginBottom: 8,
          }}
        >
          {message.images!.map((src, i) => (
            <ImageThumbnail
              key={i}
              src={src}
              index={i}
              total={message.images!.length}
              onClick={() => setLightboxIndex(i)}
            />
          ))}
        </div>
        {/* 도구 호출이었다는 한 줄 footnote — 작은 회색 글씨, 클릭 시 details 펼침 */}
        <details
          className={`msg-tool-image-footnote msg-tool-${message.status}`}
          data-risk={message.risk?.level ?? "unknown"}
          style={{
            fontSize: "0.72em",
            opacity: 0.55,
            marginTop: 2,
          }}
        >
          <summary
            style={{
              cursor: "pointer",
              listStyle: "none",
              userSelect: "none",
            }}
          >
            <span style={{ fontFamily: "var(--font-mono, monospace)" }}>
              {isO2 ? <Icon name="camera" size={13} /> : "📷"} {message.toolName}
            </span>
            <span style={{ marginLeft: 6 }}>
              ·{" "}
              {new Date(message.timestamp).toLocaleTimeString("ko-KR", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })}
            </span>
            {message.images!.length > 1 && (
              <span style={{ marginLeft: 6 }}>· {message.images!.length}장</span>
            )}
            <span style={{ marginLeft: 6, opacity: 0.7 }}>· 상세 펼치기</span>
          </summary>
          <div style={{ marginTop: 6, opacity: 0.85 }}>
            {message.toolInput != null && (
              <pre
                className="mono msg-tool-json"
                style={{ fontSize: "0.95em", padding: "4px 8px" }}
              >
                {JSON.stringify(message.toolInput, null, 2)}
              </pre>
            )}
            {message.toolOutput && (
              <pre
                className="mono msg-tool-json"
                style={{ fontSize: "0.95em", padding: "4px 8px", marginTop: 4 }}
              >
                {message.toolOutput}
              </pre>
            )}
          </div>
        </details>
      </div>
    );
  }
  // dzB (o2) — 목업 .tc: 상태 원(완료 ✓ · 실패 ✕ · 실행 중 회전) + 도구 이름 + 인자(mono) + 시각 + 펼침 화살표.
  // 펼치면 입력/결과 2단 표, 실패면 접힌 상태에서도 이유 한 줄, 실행 중이면 아래 얇은 진행 선. 위험도·분류 배지 클릭 필터는 그대로.
  if (isO2) {
    const args = toolArgsPreview(shownInput);
    const why = displayStatus === "error" ? firstMeaningfulLine(shownOutput) : null;
    const time = new Date(message.timestamp).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
    return (
      <div className={`msg-tool-o2 msg-tool-o2--${displayStatus}`} data-risk={message.risk?.level ?? "unknown"}>
        <details className={`msg-tool-compact msg-tool-${message.status}`} data-risk={message.risk?.level ?? "unknown"}>
          <summary className="msg-tool-summary">
            <span className={`msg-tool-st msg-tool-st--${displayStatus}`} role="img" aria-label={statusLabelKo(displayStatus)}
              title={outcome.observationWarning ? "동작은 완료됐으나 화면 읽기에 실패했습니다. 같은 동작을 반복하지 말고 화면 조회만 다시 확인하세요." : statusLabelKo(displayStatus)}>
              <Icon name={displayStatus === "pending" ? "loader" : displayStatus === "error" ? "x" : "check"} size={displayStatus === "pending" ? 16 : 13} strokeWidth={displayStatus === "pending" ? 2 : 2.2} />
            </span>
            <span className="msg-tool-name">{shortToolName(message.toolName)}</span>
            <span className="mono msg-tool-arg" title={args || undefined}>{args}</span>
            {outcome.observationWarning && <span className="msg-tool-flag">화면 읽기 실패</span>}
            {riskBadge && message.risk && (
              <span className={`msg-tool-risk msg-tool-risk--${message.risk.level}`}
                title={onFilterToggle ? `클릭하면 위험도 "${riskBadge.label}" 만 보기 — ${message.risk.summary}` : message.risk.summary}
                onClick={(e) => {
                  if (!onFilterToggle || !message.risk) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onFilterToggle("risk", message.risk.level);
                }}>
                위험도 {riskBadge.label}
              </span>
            )}
            {message.risk?.categoryId && (
              <span className="msg-tool-cat" title={onFilterToggle ? `클릭하면 분류 "${message.risk.categoryId}" 만 보기` : `분류: ${message.risk.categoryId}`}
                onClick={(e) => {
                  if (!onFilterToggle || !message.risk?.categoryId) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onFilterToggle("category", message.risk.categoryId);
                }}>
                {message.risk.categoryId}
              </span>
            )}
            <span className="mono msg-time">{time}</span>
            <Icon name="chevronRight" size={14} className="msg-tool-chev" />
          </summary>
          <div className="msg-tool-expanded">
            {message.risk && (
              <div className="msg-tool-section">
                <span className="msg-tool-label">위험도</span>
                <div className="msg-tool-risknote">{riskBadge?.label} · {message.risk.summary}</div>
              </div>
            )}
            {shownInput != null && (
              <div className="msg-tool-section">
                <span className="msg-tool-label">입력</span>
                <pre className="mono msg-tool-json">{inputText}</pre>
              </div>
            )}
            {shownOutput && (
              <div className="msg-tool-section">
                <span className="msg-tool-label">결과</span>
                <pre className="mono msg-tool-json">{outputText}</pre>
              </div>
            )}
            {isTruncated && !fullPayload && (
              <div className="msg-tool-section msg-tool-truncated">
                <span className="msg-tool-label" />
                <div>
                  앞부분만 표시 중{" "}
                  <button type="button" className="msg-tool-load-full" onClick={() => void loadFullPayload()} disabled={payloadState === "loading"}>
                    {payloadState === "loading" ? "불러오는 중…" : payloadState === "error" ? "다시 시도" : "전체 불러오기"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </details>
        {why && <div className="msg-tool-why"><Icon name="alertCircle" size={14} />{why}</div>}
        {displayStatus === "pending" && <div className="msg-tool-runbar" aria-hidden="true" />}
      </div>
    );
  }
  // 이미지 없는 일반 케이스: 기존 도구 카드 (기존 동작 유지)
  return (
    <>
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
        <span className={`tool-pill tool-pill-${displayStatus}`} title={outcome.observationWarning ? "동작은 완료됐으나 화면 읽기에 실패했습니다. 같은 동작을 반복하지 말고 화면 조회만 다시 확인하세요." : undefined}>
          {outcome.observationWarning ? "완료 · 화면 읽기 실패" : statusLabel(displayStatus)}
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
        {shownInput != null && (
          <div className="msg-tool-section">
            <span className="eyebrow">Arguments</span>
            <pre className="mono msg-tool-json">{inputText}</pre>
          </div>
        )}
        {shownOutput && (
          <div className="msg-tool-section">
            <span className="eyebrow">Output</span>
            <pre className="mono msg-tool-json">{outputText}</pre>
          </div>
        )}
        {isTruncated && !fullPayload && (
          <div className="msg-tool-section msg-tool-truncated">
            <span style={{ opacity: 0.7 }}>앞부분만 표시 중</span>{" "}
            <button
              type="button"
              className="msg-tool-load-full"
              onClick={() => void loadFullPayload()}
              disabled={payloadState === "loading"}
            >
              {payloadState === "loading" ? "불러오는 중…" : payloadState === "error" ? "다시 시도" : "전체 불러오기"}
            </button>
          </div>
        )}
        {/* Phase 98.1 — 이미지 영역은 도구 카드 위쪽 inline 으로 분리됨 (위 fragment 참조).
           카드 펼침 안 해도 K 가 바로 채팅 본문에서 볼 수 있도록 함. */}
      </div>
    </details>
    </>
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

// dzB (o2) — 도구 카드 보조 함수
function statusLabelKo(status: string): string {
  return status === "pending" ? "실행 중" : status === "error" ? "실패" : "완료";
}
/** mcp__k-personal__fm_list_directory → fm_list_directory */
function shortToolName(name: string): string {
  return name.startsWith("mcp__") ? name.split("__").pop() || name : name;
}
/** 입력 인자 한 줄 요약: 앞쪽 글자·숫자 값 두 개까지 (긴 값은 자름). */
function toolArgsPreview(input: unknown): string {
  if (input == null) return "";
  if (typeof input !== "object") return String(input).slice(0, 140);
  const vals = Object.values(input as Record<string, unknown>)
    .filter((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .slice(0, 2)
    .map((v) => String(v).replace(/\s+/g, " "));
  const out = vals.join("  ");
  return out.length > 140 ? `${out.slice(0, 139)}…` : out;
}
/** 실패 이유 한 줄: 결과의 첫 의미 있는 줄 ('Error:' 머리는 뗌). */
function firstMeaningfulLine(output: string | undefined): string | null {
  if (!output) return null;
  const line = output.split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  const t = line.replace(/^(?:Error|오류)\s*:\s*/i, "");
  return t.length > 160 ? `${t.slice(0, 159)}…` : t;
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
