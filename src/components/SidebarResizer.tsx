import { useEffect, useRef, useState } from "react";

interface Props {
  width: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
}

/**
 * Phase 38 (v0.5.26) — 사이드바 폭 조절 handle.
 * 사이드바 우측 가장자리에 absolute fixed positioned. K 가 mouse drag 로 200~600px 사이 조절.
 * 폭은 App.tsx 의 useEffect 가 CSS variable `--sidebar-width` 에 박고 localStorage 에 저장.
 */
export default function SidebarResizer({
  width,
  onChange,
  min = 200,
  max = 600,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => {
    if (!dragging) return;

    const handleMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const dx = e.clientX - dragStartRef.current.x;
      const next = Math.max(min, Math.min(max, dragStartRef.current.w + dx));
      onChange(next);
    };
    const handleUp = () => {
      setDragging(false);
      dragStartRef.current = null;
    };

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging, min, max, onChange]);

  const handleDoubleClick = () => {
    // 더블클릭 시 기본 폭 (260) 으로 복원
    onChange(260);
  };

  return (
    <div
      className={`sidebar-resizer ${dragging ? "dragging" : ""}`}
      style={{ left: `calc(var(--space-md, 12px) + var(--sidebar-width, 260px))` }}
      onMouseDown={(e) => {
        e.preventDefault();
        dragStartRef.current = { x: e.clientX, w: width };
        setDragging(true);
      }}
      onDoubleClick={handleDoubleClick}
      title="좌우 드래그로 사이드바 폭 조절 · 더블클릭 = 기본값 (260px)"
      aria-label="사이드바 폭 조절"
      role="separator"
    >
      <div className="sidebar-resizer-grip" />
    </div>
  );
}
