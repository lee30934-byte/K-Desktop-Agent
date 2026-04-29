import { memo, useState, type ReactNode, isValidElement } from "react";
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
    </div>
  );
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
