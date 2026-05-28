/**
 * PromptPicker - 슬래시 명령어로 템플릿을 선택하는 팝업
 */

import { useState, useEffect, useRef, useCallback, memo } from "react";
import type { PromptTemplate } from "../types";
import { filterPrompts, groupPromptsByCategory, CATEGORY_LABELS } from "../prompts";

interface PromptPickerProps {
  isOpen: boolean;
  query: string;          // "/" 이후 입력된 검색어
  onSelect: (prompt: PromptTemplate) => void;
  onClose: () => void;
  anchorRect?: DOMRect;   // 위치 기준점 (Composer textarea 위치)
}

function PromptPicker({
  isOpen,
  query,
  onSelect,
  onClose,
  anchorRect,
}: PromptPickerProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  // 필터링된 프롬프트
  const filteredPrompts = filterPrompts(query);
  const grouped = groupPromptsByCategory(filteredPrompts);

  // 평면화된 리스트 (키보드 네비게이션용)
  const flatList = filteredPrompts;

  // 검색어 변경 시 선택 초기화
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // 선택된 항목 스크롤
  useEffect(() => {
    const selectedEl = itemRefs.current.get(selectedIndex);
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedIndex]);

  // 키보드 이벤트 (전역)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev < flatList.length - 1 ? prev + 1 : 0
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev > 0 ? prev - 1 : flatList.length - 1
          );
          break;
        case "Enter":
        case "Tab":
          e.preventDefault();
          if (flatList[selectedIndex]) {
            onSelect(flatList[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [isOpen, flatList, selectedIndex, onSelect, onClose]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // 팝업 외부 클릭 감지
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };

    // 약간의 딜레이 후 리스너 등록 (열리자마자 닫히는 것 방지)
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 100);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // 위치 계산
  const style: React.CSSProperties = anchorRect
    ? {
        position: "absolute",
        bottom: `calc(100% + 8px)`,
        left: 0,
        right: 0,
      }
    : {};

  // 평면 인덱스 계산 헬퍼
  let flatIndex = 0;

  return (
    <div className="prompt-picker" ref={containerRef} style={style}>
      <div className="prompt-picker-header">
        <span className="prompt-picker-title">/ 명령어</span>
        <span className="prompt-picker-hint">
          ↑↓ 이동 · Enter 선택 · Esc 닫기
        </span>
      </div>

      {filteredPrompts.length === 0 ? (
        <div className="prompt-picker-empty">
          "{query}"에 맞는 명령어가 없습니다
        </div>
      ) : (
        <div className="prompt-picker-list">
          {Object.entries(grouped).map(([category, prompts]) => (
            <div key={category} className="prompt-picker-category">
              <div className="prompt-picker-category-label">
                {CATEGORY_LABELS[category] || category}
              </div>
              {prompts.map((prompt) => {
                const currentIndex = flatIndex++;
                const isSelected = currentIndex === selectedIndex;

                return (
                  <button
                    key={prompt.id}
                    ref={(el) => {
                      if (el) itemRefs.current.set(currentIndex, el);
                    }}
                    className={`prompt-picker-item ${isSelected ? "selected" : ""}`}
                    onClick={() => onSelect(prompt)}
                    onMouseEnter={() => setSelectedIndex(currentIndex)}
                  >
                    <span className="prompt-picker-icon">{prompt.icon || "📌"}</span>
                    <div className="prompt-picker-content">
                      <div className="prompt-picker-name">
                        <span className="prompt-picker-command">/{prompt.command}</span>
                        <span className="prompt-picker-label">{prompt.name}</span>
                      </div>
                      <div className="prompt-picker-desc">{prompt.description}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Phase 102 (v0.6.48) — PromptPicker 도 memo. Composer 의 매 render 마다 같이 재호출되는
// 비용 차단. isOpen=false 시 self-skip 하지만 함수 자체 호출은 제거.
export default memo(PromptPicker);
