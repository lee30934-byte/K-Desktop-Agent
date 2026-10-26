import { useRef, useState } from "react";
import { loadPreview, checkFinalReviewGate, isUrl } from "./SidePanel";
import { isMediaStreamUrl } from "../utils/mediaStream";
import logger from "../utils/logger";

/**
 * v0.7.51 — 채팅 본문의 영상/음악 링크를 미리보기 패널 없이 바로 재생하는 작은 플레이어.
 *
 * - 처음엔 "▶ 재생" 버튼만 보인다. 파일 접근(토큰 발급)은 **K 가 누른 뒤에만** 일어난다
 *   (메시지가 렌더된다고 파일을 열지 않음 — 긴 대화에서 수십 개 플레이어가 동시에 로드되는 것도 방지).
 * - SidePanel 과 같은 Final-Review Gate 를 적용한다. 검수 미통과 파일은 재생하지 않고
 *   패널로 안내한다 (패널에서 기존 "강제 열기" 절차를 그대로 사용).
 * - 스트리밍(kdamedia://) 오류 시 data URL 방식으로 한 번 폴백, 그래도 실패하면 오류 표시.
 */
export default function InlineMediaPlayer({
  src,
  label,
  kind,
  onPreviewRequest,
}: {
  src: string;
  label?: string;
  kind: "video" | "audio";
  onPreviewRequest?: (pathOrUrl: string, label?: string) => void;
}) {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "blocked" | "error">("idle");
  const [url, setUrl] = useState<string | undefined>();
  const [streamed, setStreamed] = useState(false);
  const [message, setMessage] = useState<string>("");
  const seqRef = useRef(0);

  const openPanel = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    onPreviewRequest?.(src, label);
  };

  const start = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const seq = ++seqRef.current;
    setState("loading");
    setMessage("");
    if (!isUrl(src) || /^file:/i.test(src)) {
      const gate = await checkFinalReviewGate(src);
      if (seq !== seqRef.current) return;
      if (gate.blocked) {
        logger.warn(`[InlineMedia] Gate BLOCKED: ${src} status=${gate.status}`);
        setMessage(gate.status ?? "검수 미통과");
        setState("blocked");
        return;
      }
    }
    const r = await loadPreview(src, kind);
    if (seq !== seqRef.current) return;
    if (r.error || !r.dataUrl) {
      setMessage(r.error ?? "파일을 불러오지 못했습니다");
      setState("error");
      return;
    }
    setUrl(r.dataUrl);
    setStreamed(!!r.streamed);
    setState("ready");
  };

  const onMediaError = async () => {
    const seq = seqRef.current;
    if (streamed && isMediaStreamUrl(url)) {
      logger.warn(`[InlineMedia] 스트리밍 오류 → data URL 폴백: ${src}`);
      setState("loading");
      const r = await loadPreview(src, kind, { legacy: true });
      if (seq !== seqRef.current) return;
      if (r.dataUrl && !r.error) {
        setUrl(r.dataUrl);
        setStreamed(false);
        setState("ready");
        return;
      }
      setMessage(r.error ?? "재생하지 못했습니다");
    } else {
      setMessage("내장 플레이어가 이 형식/코덱을 재생하지 못합니다");
    }
    setState("error");
  };

  const stop = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    seqRef.current++;
    setUrl(undefined);
    setState("idle");
  };

  if (state === "idle") {
    return (
      <button
        type="button"
        className="md-inline-media-btn"
        onClick={start}
        title={`채팅 안에서 바로 ${kind === "video" ? "영상" : "음악"} 재생`}
        aria-label={`${label || "미디어"} 바로 재생`}
      >
        ▶ 재생
      </button>
    );
  }
  if (state === "loading") {
    return <span className="md-inline-media-status">⏳ 불러오는 중…</span>;
  }
  if (state === "blocked") {
    return (
      <button
        type="button"
        className="md-inline-media-status warn"
        onClick={openPanel}
        title="Final-Review Gate: 최종 후보(FINAL_CANDIDATE)가 아니라 바로 재생하지 않았습니다. 클릭 = 미리보기 패널에서 확인"
      >
        ⚠ 검수 미통과 ({message}) · 패널에서 확인
      </button>
    );
  }
  if (state === "error") {
    return (
      <span className="md-inline-media-status error" title={message}>
        ⚠ 재생 실패: {message}{" "}
        <button type="button" className="md-inline-media-link" onClick={openPanel}>
          패널에서 열기
        </button>
      </span>
    );
  }
  return (
    <span className={`md-inline-media-wrap ${kind}`}>
      {kind === "video" ? (
        <video
          key={url}
          src={url}
          controls
          autoPlay
          preload="metadata"
          className="md-inline-video"
          onError={onMediaError}
        />
      ) : (
        <audio
          key={url}
          src={url}
          controls
          autoPlay
          preload="metadata"
          className="md-inline-audio"
          onError={onMediaError}
        />
      )}
      <button type="button" className="md-inline-media-close" onClick={stop} title="플레이어 닫기" aria-label="플레이어 닫기">
        ✕
      </button>
    </span>
  );
}
