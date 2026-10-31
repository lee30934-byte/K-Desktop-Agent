import { useEffect, useRef } from "react";

export default function ActionConfirmation(props: { title: string; detail: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => previous?.focus();
  }, []);
  return <div style={{ position: "fixed", inset: 0, zIndex: 10000, display: "grid", placeItems: "center", background: "#0009" }}>
    <section role="alertdialog" aria-modal="true" aria-labelledby="action-confirm-title" aria-describedby="action-confirm-detail"
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); props.onCancel(); }
        if (event.key === "Tab") { event.preventDefault(); const buttons = event.currentTarget.querySelectorAll("button");
          (document.activeElement === buttons[0] ? buttons[1] : buttons[0])?.focus(); }
      }}
      style={{ maxWidth: 440, margin: 20, padding: 24, borderRadius: 12, background: "var(--bg-2, #15202d)", color: "var(--text-primary, #e5eef6)", border: "1px solid #60758a" }}>
      <h2 id="action-confirm-title" style={{ fontSize: 18, margin: "0 0 12px" }}>{props.title}</h2>
      <p id="action-confirm-detail" style={{ lineHeight: 1.7 }}>{props.detail}</p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 20 }}>
        <button ref={cancelRef} onClick={props.onCancel}>취소</button>
        <button onClick={props.onConfirm}>{props.confirmLabel}</button>
      </div>
    </section>
  </div>;
}
