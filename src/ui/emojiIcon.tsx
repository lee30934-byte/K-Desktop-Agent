// dzC — 설정·명령 팔레트에 남은 이모지를 o2 에서만 같은 뜻의 라인 아이콘으로 바꾼다 (목업 v2.1: 이모지 없음).
// classic 은 글자 그대로 렌더한다 (EmojiLabel 은 children 을 손대지 않고, EmojiIcon 은 이모지를 그대로 낸다).
// 위험도 색 원(🟢🟡🟠🔴)은 아이콘 대신 작은 색 점으로.
import { Children, Fragment, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { useUiLayout } from "../utils/useUiLayout";

export const EMOJI_ICONS: Record<string, IconName> = {
  "🔄": "rotate", "↻": "rotate", "📥": "download", "📤": "upload", "💾": "save", "🗑": "trash", "🧹": "trash",
  "📖": "book", "📘": "book", "📜": "book", "📋": "copy", "✎": "pencil", "✏": "pencil", "💬": "msg", "🔑": "key",
  "🔌": "plug", "🪟": "split", "🌐": "globe", "🌍": "globe", "🔍": "search", "🛡": "shield", "🪪": "user", "👤": "user",
  "👥": "users", "🤝": "users", "🧪": "sliders", "⚖": "sliders", "📊": "sheet", "📈": "sheet", "🔒": "lock", "🔓": "lock",
  "⚡": "zap", "🚀": "zap", "✨": "zap", "🗂": "folder", "📁": "folder", "📂": "folder", "📷": "camera", "📸": "camera",
  "🖼": "image", "🤖": "bot", "💠": "bot", "🔮": "bot", "🧠": "cpu", "⚙": "settings", "🔧": "wrench", "🖱": "app",
  "💡": "info", "💻": "monitor", "🖥": "monitor", "☁": "cloud", "🔀": "split", "📌": "pin", "🎉": "check", "✅": "check",
  "📝": "note", "📄": "file", "🐙": "link", "🐘": "db", "🕒": "clock", "⏳": "clock", "🧟": "alertCircle", "📦": "layers",
  "🚫": "x", "⚠": "alert", "👁": "eye", "🙈": "eye", "⌘": "command",
};
const DOTS: Record<string, string> = { "🟢": "ok", "🟡": "mid", "🟠": "hi", "🔴": "danger" };

// 맨 앞 이모지 1개(+이음·변형 선택자)와 뒤 공백
const LEAD = /^\s*((?:\p{Extended_Pictographic}|[↻✎⌘])(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*/u;

/** 맨 앞 이모지를 떼어 낸다. 없으면 emoji=null */
export function splitLeadEmoji(text: string): { emoji: string | null; rest: string } {
  const m = text.match(LEAD);
  return m ? { emoji: m[1], rest: text.slice(m[0].length) } : { emoji: null, rest: text };
}

/** 이모지 → 라인 아이콘 이름 (변형 선택자 무시). 모르면 null */
export function emojiIconName(emoji: string): IconName | null {
  const base = emoji.replace(/\uFE0F/g, "");
  return EMOJI_ICONS[base] ?? EMOJI_ICONS[emoji] ?? null;
}

function glyph(emoji: string, size: number, noDot = false): ReactNode {
  const base = emoji.replace(/\uFE0F/g, "");
  if (DOTS[base] && !noDot) return <span className={`o2-dot o2-dot--${DOTS[base]}`} aria-hidden="true" />;
  const name = emojiIconName(emoji);
  return name ? <Icon name={name} size={size} className="o2-emo" /> : null;
}

/** 아이콘 자리 하나 (catalog 의 icon 필드 등). o2 = 라인 아이콘(모르면 fallback), classic = 이모지 그대로 */
export function EmojiIcon({ e, size = 16, fallback, noDot }: { e: string | null | undefined; size?: number; fallback?: IconName; noDot?: boolean }) {
  const { isO2 } = useUiLayout();
  if (!isO2) return <>{e}</>;
  const g = e ? glyph(e, size, noDot) : null;
  return <>{g ?? (fallback ? <Icon name={fallback} size={size} className="o2-emo" /> : e)}</>;
}

/** 글자 앞 이모지를 o2 에서만 라인 아이콘으로. children 의 첫 글자 조각만 본다 (나머지는 그대로) */
export function EmojiLabel({ children, size = 14 }: { children?: ReactNode; size?: number }) {
  const { isO2 } = useUiLayout();
  if (!isO2) return <>{children}</>;
  const parts = Children.toArray(children);
  const first = parts[0];
  if (typeof first !== "string") return <>{children}</>;
  const { emoji, rest } = splitLeadEmoji(first);
  if (!emoji) return <>{children}</>;
  return (
    <>
      {glyph(emoji, size)}
      {rest}
      {parts.slice(1).map((p, i) => <Fragment key={i}>{p}</Fragment>)}
    </>
  );
}
