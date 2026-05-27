/**
 * P3Torrent 스타일의 네 모서리 L자 브래킷 장식.
 * 부모가 position: relative 여야 함.
 */
interface CornerBracketsProps {
  color?: string;
  size?: number;
  thickness?: number;
  inset?: number;
  corners?: Array<"tl" | "tr" | "bl" | "br">;
}

export default function CornerBrackets({
  color = "var(--accent)",
  size = 14,
  thickness = 2,
  inset = -1,
  corners = ["tl", "tr", "bl", "br"],
}: CornerBracketsProps) {
  // Phase 96 (v0.6.38) — 테마가 --show-corner-brackets: 0 면 데코 숨김.
  // data-corner-bracket 속성으로 App.css 에서 룰 한 번에 제어 가능.
  const common: React.CSSProperties = {
    position: "absolute",
    width: size,
    height: size,
    pointerEvents: "none",
    // CSS opacity 로 토글 — display 안 건드려야 transform/layout 안 흔들림
    opacity: "var(--show-corner-brackets, 1)",
  };

  return (
    <>
      {corners.includes("tl") && (
        <span
          data-corner-bracket="tl"
          style={{
            ...common,
            top: inset,
            left: inset,
            borderTop: `${thickness}px solid ${color}`,
            borderLeft: `${thickness}px solid ${color}`,
          }}
        />
      )}
      {corners.includes("tr") && (
        <span
          data-corner-bracket="tr"
          style={{
            ...common,
            top: inset,
            right: inset,
            borderTop: `${thickness}px solid ${color}`,
            borderRight: `${thickness}px solid ${color}`,
          }}
        />
      )}
      {corners.includes("bl") && (
        <span
          data-corner-bracket="bl"
          style={{
            ...common,
            bottom: inset,
            left: inset,
            borderBottom: `${thickness}px solid ${color}`,
            borderLeft: `${thickness}px solid ${color}`,
          }}
        />
      )}
      {corners.includes("br") && (
        <span
          data-corner-bracket="br"
          style={{
            ...common,
            bottom: inset,
            right: inset,
            borderBottom: `${thickness}px solid ${color}`,
            borderRight: `${thickness}px solid ${color}`,
          }}
        />
      )}
    </>
  );
}
