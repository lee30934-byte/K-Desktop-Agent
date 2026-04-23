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
  const common: React.CSSProperties = {
    position: "absolute",
    width: size,
    height: size,
    pointerEvents: "none",
  };

  return (
    <>
      {corners.includes("tl") && (
        <span
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
