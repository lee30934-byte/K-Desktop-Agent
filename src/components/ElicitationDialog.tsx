/**
 * ElicitationDialog - 사용자 확인/선택을 받는 다이얼로그
 */

import { useState, useEffect, useRef } from "react";
import type { ElicitationRequest, ElicitationResponse } from "../types";

interface ElicitationDialogProps {
  request: ElicitationRequest | null;
  onResponse: (response: ElicitationResponse) => void;
}

export default function ElicitationDialog({
  request,
  onResponse,
}: ElicitationDialogProps) {
  const [inputValue, setInputValue] = useState("");
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // 요청이 바뀌면 상태 초기화
  useEffect(() => {
    if (request) {
      setInputValue(request.inputDefault || "");
      setSelectedOption(request.options?.[0]?.id || null);

      // input 타입이면 포커스
      if (request.type === "input") {
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    }
  }, [request]);

  // 키보드 이벤트 — Phase 50: choice 타입에서 ↑↓ 방향키 + 1~9 숫자 단축키 추가.
  // 단순 confirm/preview 는 종전 그대로 Enter/ESC 만.
  useEffect(() => {
    if (!request) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleCancel();
        return;
      }

      if (request.type === "choice" && request.options && request.options.length > 0) {
        const options = request.options;

        // ↑↓ 방향키 — 라디오 선택 이동 (wrap-around)
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const currentIdx = options.findIndex((o) => o.id === selectedOption);
          let nextIdx: number;
          if (e.key === "ArrowDown") {
            nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % options.length;
          } else {
            nextIdx = currentIdx <= 0 ? options.length - 1 : currentIdx - 1;
          }
          setSelectedOption(options[nextIdx].id);
          return;
        }

        // 1~9 숫자 단축키 — 해당 옵션 즉시 선택 + confirm
        if (/^[1-9]$/.test(e.key)) {
          const idx = parseInt(e.key, 10) - 1;
          if (idx < options.length) {
            e.preventDefault();
            const targetId = options[idx].id;
            setSelectedOption(targetId);
            // 즉시 confirm — K 가 빠르게 답 가능. handleConfirm 은 selectedOption state 의
            // 다음 cycle 을 봐야 해서 targetId 를 직접 박은 임시 객체로 호출.
            onResponse({
              id: request.id,
              confirmed: true,
              selectedOption: targetId,
            });
            return;
          }
        }
      }

      if (e.key === "Enter" && request.type !== "input") {
        handleConfirm();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [request, selectedOption, inputValue]);

  if (!request) return null;

  function handleConfirm() {
    onResponse({
      id: request!.id,
      confirmed: true,
      selectedOption: selectedOption || undefined,
      inputValue: request!.type === "input" ? inputValue : undefined,
    });
  }

  function handleCancel() {
    onResponse({
      id: request!.id,
      confirmed: false,
    });
  }

  function handleOptionSelect(optionId: string) {
    setSelectedOption(optionId);
  }

  // severity에 따른 클래스
  const severityClass = request.severity || "info";

  // 아이콘 결정
  const icon =
    request.icon ||
    (request.severity === "danger"
      ? "⚠️"
      : request.severity === "warn"
        ? "⚡"
        : "ℹ️");

  return (
    <div className="elicitation-overlay" onClick={handleCancel}>
      <div
        className={`elicitation-dialog elicitation-${severityClass}`}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="elicitation-header">
          <span className="elicitation-icon">{icon}</span>
          <h3 className="elicitation-title">{request.title}</h3>
        </div>

        {/* 메시지 */}
        <p className="elicitation-message">{request.message}</p>

        {/* Preview 타입: 파일/변경 목록 */}
        {request.type === "preview" && request.previewItems && (
          <div className="elicitation-preview">
            <div className="elicitation-preview-header">
              {request.previewType === "files" && "📁 대상 파일"}
              {request.previewType === "changes" && "📝 변경 사항"}
              {request.previewType === "list" && "📋 항목 목록"}
              {!request.previewType && "📋 미리보기"}
              <span className="elicitation-preview-count">
                ({request.previewItems.length}개)
              </span>
            </div>
            <ul className="elicitation-preview-list">
              {request.previewItems.slice(0, 10).map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
              {request.previewItems.length > 10 && (
                <li className="elicitation-preview-more">
                  ... 외 {request.previewItems.length - 10}개
                </li>
              )}
            </ul>
          </div>
        )}

        {/* Choice 타입: 옵션 선택 */}
        {request.type === "choice" && request.options && (
          <div className="elicitation-options">
            {request.options.map((option) => (
              <button
                key={option.id}
                className={`elicitation-option ${
                  selectedOption === option.id ? "selected" : ""
                } ${option.danger ? "danger" : ""}`}
                onClick={() => handleOptionSelect(option.id)}
              >
                {option.icon && (
                  <span className="elicitation-option-icon">{option.icon}</span>
                )}
                <div className="elicitation-option-content">
                  <span className="elicitation-option-label">{option.label}</span>
                  {option.description && (
                    <span className="elicitation-option-desc">
                      {option.description}
                    </span>
                  )}
                </div>
                {selectedOption === option.id && (
                  <span className="elicitation-option-check">✓</span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Input 타입: 텍스트 입력 */}
        {request.type === "input" && (
          <div className="elicitation-input-wrapper">
            <input
              ref={inputRef}
              type="text"
              className="elicitation-input"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={request.inputPlaceholder || "입력하세요..."}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleConfirm();
                }
              }}
            />
          </div>
        )}

        {/* 액션 버튼 */}
        <div className="elicitation-actions">
          <button className="elicitation-btn-cancel" onClick={handleCancel}>
            {request.cancelLabel || "취소"}
          </button>
          <button
            className={`elicitation-btn-confirm ${
              request.severity === "danger" ? "danger" : ""
            }`}
            onClick={handleConfirm}
          >
            {request.confirmLabel || "확인"}
          </button>
        </div>

        {/* 키보드 힌트 */}
        <div className="elicitation-hint">
          {request.type === "choice"
            ? "↑↓ 이동 · 1~9 즉시 선택 · Enter 확인 · Esc 취소"
            : "Enter 확인 · Esc 취소"}
        </div>
      </div>
    </div>
  );
}
