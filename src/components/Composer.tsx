import { useState, useRef, useEffect, FormEvent, KeyboardEvent, DragEvent, ChangeEvent, ClipboardEvent } from "react";
import type { FileAttachment, PromptTemplate } from "../types";
import PromptPicker from "./PromptPicker";

interface ComposerProps {
  disabled?: boolean;
  isStreaming: boolean;
  onSubmit: (text: string, files?: FileAttachment[]) => void;
  onInterrupt: () => void;
  // Phase 46 (v0.5.34) — "모두 중단" 강한 stop (현재 turn + 큐 + 자동 갱신 abort)
  onHardStop?: () => void;
  placeholder?: string;
  // Phase 34 (v0.5.22) — 큐 미리보기 + 취소
  queuedSend?: { text: string; fileCount: number; queuedAt: number } | null;
  onCancelQueuedSend?: () => void;
  // Phase 49 (v0.5.37) — 큐 즉시 전송 (작업 중단 + 새 turn)
  onFlushQueueNow?: () => void;
}

// 파일 타입별 아이콘
function getFileIcon(type: string): string {
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

// 파일 크기 포맷
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// 고유 ID 생성
function generateId(): string {
  return `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export default function Composer({
  disabled = false,
  isStreaming,
  onSubmit,
  onInterrupt,
  onHardStop,
  placeholder = "메시지를 입력하세요. Enter로 전송, Shift+Enter로 줄바꿈.",
  queuedSend,
  onCancelQueuedSend,
  onFlushQueueNow,
}: ComposerProps) {
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [showPromptPicker, setShowPromptPicker] = useState(false);
  const [promptQuery, setPromptQuery] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Phase 40 (v0.5.28): Composer 높이 조절 — 상단 grip bar drag.
  // localStorage 에 저장 (기본 4 lines = 약 100px).
  const [composerHeight, setComposerHeight] = useState<number>(() => {
    try {
      const saved = parseInt(localStorage.getItem("kda_composer_height") || "", 10);
      if (!Number.isNaN(saved) && saved >= 60 && saved <= 600) return saved;
    } catch {}
    return 100;
  });
  const heightDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const [resizingHeight, setResizingHeight] = useState(false);

  useEffect(() => {
    if (!resizingHeight) return;
    const onMove = (e: MouseEvent) => {
      if (!heightDragRef.current) return;
      const dy = heightDragRef.current.startY - e.clientY; // 위로 끌수록 +
      const next = Math.max(60, Math.min(600, heightDragRef.current.startH + dy));
      setComposerHeight(next);
    };
    const onUp = () => {
      setResizingHeight(false);
      heightDragRef.current = null;
      try {
        localStorage.setItem("kda_composer_height", String(composerHeight));
      } catch {}
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [resizingHeight, composerHeight]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 파일을 FileAttachment로 변환
  async function processFile(file: File): Promise<FileAttachment> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => {
        const base64 = reader.result as string;
        const attachment: FileAttachment = {
          id: generateId(),
          name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size,
          base64: base64.split(",")[1], // data:...;base64, 제거
        };

        // 이미지/비디오/오디오 모두 미리보기 URL 생성
        // — 비디오는 첫 프레임, 오디오는 미니 플레이어로 렌더링됨
        if (
          file.type.startsWith("image/") ||
          file.type.startsWith("video/") ||
          file.type.startsWith("audio/")
        ) {
          attachment.preview = URL.createObjectURL(file);
        }

        resolve(attachment);
      };

      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // 파일 추가
  async function addFiles(fileList: FileList | File[]) {
    const newFiles: FileAttachment[] = [];

    for (const file of Array.from(fileList)) {
      // 50MB 제한
      if (file.size > 50 * 1024 * 1024) {
        alert(`${file.name}은(는) 50MB를 초과합니다.`);
        continue;
      }

      try {
        const attachment = await processFile(file);
        newFiles.push(attachment);
      } catch (err) {
        console.error("파일 처리 실패:", file.name, err);
      }
    }

    setFiles((prev) => [...prev, ...newFiles]);
  }

  // 파일 제거
  function removeFile(id: string) {
    setFiles((prev) => {
      const file = prev.find((f) => f.id === id);
      if (file?.preview) {
        URL.revokeObjectURL(file.preview);
      }
      return prev.filter((f) => f.id !== id);
    });
  }

  // 드래그 앤 드롭 핸들러
  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }

  // 파일 선택 핸들러
  function handleFileSelect(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
      e.target.value = ""; // 같은 파일 다시 선택 가능하도록
    }
  }

  // 제출 핸들러
  // Phase 30 (v0.5.18): isStreaming 중에도 onSubmit 호출 — App 이 큐로 처리.
  // K 가 답변 받는 동안 Enter 치면 streaming 끝난 직후 자동 전송.
  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if ((!input.trim() && files.length === 0) || disabled) return;

    onSubmit(input.trim(), files.length > 0 ? files : undefined);
    setInput("");

    // 미리보기 URL 해제
    files.forEach((f) => {
      if (f.preview) URL.revokeObjectURL(f.preview);
    });
    setFiles([]);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // PromptPicker가 열려있으면 키 이벤트를 PromptPicker가 처리
    if (showPromptPicker) {
      // Enter, Tab, ArrowUp, ArrowDown, Escape는 PromptPicker에서 처리
      if (["Enter", "Tab", "ArrowUp", "ArrowDown", "Escape"].includes(e.key)) {
        return; // 기본 동작 막지 않음 - PromptPicker의 전역 리스너가 처리
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as FormEvent);
    }
  }

  // 입력 변경 시 슬래시 명령어 감지
  function handleInputChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setInput(value);

    // "/" 로 시작하고 줄바꿈이 없으면 프롬프트 피커 표시
    if (value.startsWith("/") && !value.includes("\n")) {
      const query = value.slice(1); // "/" 제거
      setPromptQuery(query);
      setShowPromptPicker(true);
    } else {
      setShowPromptPicker(false);
      setPromptQuery("");
    }
  }

  // 프롬프트 선택 핸들러
  function handlePromptSelect(prompt: PromptTemplate) {
    setInput(prompt.template);
    setShowPromptPicker(false);
    setPromptQuery("");

    // 커서를 끝으로 이동
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.selectionStart = prompt.template.length;
        textareaRef.current.selectionEnd = prompt.template.length;
      }
    }, 0);
  }

  // 프롬프트 피커 닫기
  function handlePromptPickerClose() {
    setShowPromptPicker(false);
    setPromptQuery("");
  }

  // 클립보드 붙여넣기 핸들러 (Ctrl+V로 이미지/파일 붙여넣기)
  async function handlePaste(e: ClipboardEvent) {
    const clipboardItems = e.clipboardData?.items;
    if (!clipboardItems) return;

    const filesToAdd: File[] = [];

    for (const item of Array.from(clipboardItems)) {
      // 이미지 또는 파일인 경우
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          // 스크린샷인 경우 파일명 생성
          const fileName = file.name === "image.png"
            ? `screenshot-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.png`
            : file.name;

          // 파일명 변경을 위해 새 File 객체 생성
          const renamedFile = new File([file], fileName, { type: file.type });
          filesToAdd.push(renamedFile);
        }
      }
    }

    if (filesToAdd.length > 0) {
      // 파일이 있으면 기본 붙여넣기 방지 (텍스트 붙여넣기 유지를 위해 파일만 있을 때)
      const hasOnlyFiles = Array.from(clipboardItems).every(
        (item) => item.kind === "file" || (item.kind === "string" && item.type === "text/plain")
      );

      if (hasOnlyFiles && filesToAdd.length > 0) {
        // 이미지만 있으면 텍스트 붙여넣기 방지
        const hasText = Array.from(clipboardItems).some(
          (item) => item.kind === "string" && item.type === "text/plain"
        );
        if (!hasText) {
          e.preventDefault();
        }
      }

      await addFiles(filesToAdd);
    }
  }

  return (
    <div
      className={`composer-wrapper ${isDragging ? "dragging" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 드래그 오버레이 */}
      {isDragging && (
        <div className="drag-overlay">
          <div className="drag-overlay-content">
            <span className="drag-icon">📁</span>
            <span>파일을 여기에 놓으세요</span>
          </div>
        </div>
      )}

      {/* Phase 34 (v0.5.22) — 작업 중 다음 메시지 예약 미리보기 + 취소 */}
      {isStreaming && queuedSend && (
        <div className="queue-chip" role="status" aria-live="polite">
          <span className="queue-chip-icon">📨</span>
          <div className="queue-chip-body">
            <div className="queue-chip-label mono">작업 후 자동 전송 예약</div>
            <div className="queue-chip-text">
              {queuedSend.text.slice(0, 200)}
              {queuedSend.text.length > 200 ? "…" : ""}
              {queuedSend.fileCount > 0 && (
                <span className="queue-chip-files"> · 📎 첨부 {queuedSend.fileCount}개</span>
              )}
            </div>
          </div>
          {onFlushQueueNow && (
            <button
              type="button"
              className="queue-chip-flush-now"
              onClick={onFlushQueueNow}
              title="현재 작업 중단 후 이 메시지 즉시 전송 (Claude 가 중간 질문 했을 때 답하기 적합)"
              aria-label="큐 즉시 전송"
            >
              📤 지금
            </button>
          )}
          {onCancelQueuedSend && (
            <button
              type="button"
              className="queue-chip-cancel"
              onClick={onCancelQueuedSend}
              title="예약 메시지 취소"
              aria-label="예약 메시지 취소"
            >
              ✕ 취소
            </button>
          )}
        </div>
      )}

      {/* 첨부된 파일 미리보기 */}
      {files.length > 0 && (
        <div className="file-preview-list">
          {files.map((file) => (
            <div key={file.id} className="file-preview-item">
              {file.preview && file.type.startsWith("image/") ? (
                <img src={file.preview} alt={file.name} className="file-thumbnail" />
              ) : file.preview && file.type.startsWith("video/") ? (
                <video
                  src={file.preview}
                  className="file-thumbnail file-thumbnail-video"
                  muted
                  preload="metadata"
                  controls
                  // 첫 프레임 강제로 보이게 (Chromium 은 #t=0.1 으로 metadata 시점 프레임 표시)
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    if (v.currentTime === 0) v.currentTime = 0.1;
                  }}
                />
              ) : file.preview && file.type.startsWith("audio/") ? (
                <audio
                  src={file.preview}
                  className="file-audio-preview"
                  controls
                  preload="metadata"
                />
              ) : (
                <span className="file-icon">{getFileIcon(file.type)}</span>
              )}
              <div className="file-info">
                <span className="file-name">{file.name}</span>
                <span className="file-size">{formatFileSize(file.size)}</span>
              </div>
              <button
                type="button"
                className="file-remove-btn"
                onClick={() => removeFile(file.id)}
                aria-label="파일 제거"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Phase 40 (v0.5.28): Composer 높이 조절 grip — 상단 가로 bar */}
      <div
        className={`composer-height-grip ${resizingHeight ? "dragging" : ""}`}
        onMouseDown={(e) => {
          e.preventDefault();
          heightDragRef.current = { startY: e.clientY, startH: composerHeight };
          setResizingHeight(true);
        }}
        onDoubleClick={() => setComposerHeight(100)}
        title="위아래 드래그로 입력창 높이 조절 · 더블클릭 = 기본 (100px)"
        role="separator"
        aria-label="Composer 높이 조절"
      >
        <div className="composer-height-grip-bar" />
      </div>

      <form className="composer" onSubmit={handleSubmit}>
        <div className="composer-corner composer-corner-tl" />
        <div className="composer-corner composer-corner-tr" />
        <div className="composer-corner composer-corner-bl" />
        <div className="composer-corner composer-corner-br" />

        {/* 파일 첨부 버튼 */}
        <button
          type="button"
          className="composer-attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || isStreaming}
          title="파일 첨부 (이미지, 비디오, 오디오, 문서, 압축파일 등)"
        >
          📎
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          style={{ display: "none" }}
          accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.txt,.md,.json,.xml,.csv,.zip,.rar,.7z,.tar,.gz,.js,.ts,.py,.java,.c,.cpp,.html,.css"
        />

        <div className="composer-prefix mono">{">"}</div>

        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            disabled
              ? "연결 대기 중..."
              : isStreaming
                ? "응답 생성 중... Enter 시 다음 메시지 예약 (답변 끝나면 자동 전송)"
                : placeholder
          }
          disabled={disabled}
          style={{ height: `${composerHeight}px`, resize: "none" }}
        />

        {/* 프롬프트 피커 */}
        <PromptPicker
          isOpen={showPromptPicker}
          query={promptQuery}
          onSelect={handlePromptSelect}
          onClose={handlePromptPickerClose}
        />

        {isStreaming ? (
          <div className="composer-stop-group">
            <button
              type="button"
              onClick={onInterrupt}
              className="composer-btn composer-btn-stop"
              title="현재 진행 중인 메시지만 멈춤 (예약된 메시지는 계속 전송됨)"
            >
              <span className="stop-icon">■</span>
              STOP
            </button>
            {onHardStop && (
              <button
                type="button"
                onClick={onHardStop}
                className="composer-btn composer-btn-hardstop"
                title="진행 중 + 예약 메시지 + 자동 세션 갱신까지 전부 정지"
              >
                🛑 모두
              </button>
            )}
          </div>
        ) : (
          <button
            type="submit"
            disabled={disabled || (!input.trim() && files.length === 0)}
            className="composer-btn composer-btn-send"
          >
            SEND
            <span className="send-arrow">→</span>
          </button>
        )}
      </form>
    </div>
  );
}
