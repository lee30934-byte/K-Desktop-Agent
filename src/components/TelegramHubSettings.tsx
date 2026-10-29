/**
 * v0.7.54 — 텔레그램 허브 설정 + 상태 카드 (명령 실행창 없이 앱 안에서 감시).
 * 값은 localStorage 에 즉시 저장되고, App 의 허브가 매 처리 때 다시 읽으므로 재시작 없이 반영된다.
 */
import { useEffect, useState } from "react";
import { getActiveTelegramHub } from "../telegramHub";

const FEATURES: Array<{ key: string; title: string; desc: string }> = [
  { key: "routing", title: "주제별 자동 분배", desc: "답장 → @별칭 → 짧은 답 → Luna 분류 순. 끄면 📱 텔레그램 대화에서만 처리." },
  { key: "digest", title: "필요한 것만 요약 회신", desc: "결정 필요·오류는 즉시, 결과는 3~5줄 요약, 진행 중 보고는 생략. '자세히' 답장으로 원문." },
  { key: "buttons", title: "선택지 버튼", desc: "번호 선택지를 버튼으로. 누르면 그 대화로 번호 전달." },
  { key: "progress", title: "진행 메시지 1개 갱신", desc: "5분 넘는 작업은 '⏳ 진행 중 N분' 메시지 하나를 계속 고칩니다." },
  { key: "inbox", title: "폰 사진·파일 받기", desc: "보낸 사진·파일을 ~/.kda/inbox/날짜/ 에 저장하고 경로를 함께 전달." },
  { key: "quiet", title: "조용한 시간 + 아침 요약", desc: "조용한 시간엔 결정 필요·오류만 보내고, 결과는 끝나는 시각에 한 번에." },
  { key: "approvals", title: "원격 승인 버튼", desc: "텔레그램에서 시킨 Codex 작업의 실행 승인을 버튼으로(1회용, 5분 무응답=거절)." },
];

const on = (k: string) => localStorage.getItem(`kda_tg_feat_${k}`) !== "false";

export default function TelegramHubSettings() {
  const [flags, setFlags] = useState<Record<string, boolean>>(() => Object.fromEntries(FEATURES.map((f) => [f.key, on(f.key)])));
  const [qs, setQs] = useState(() => localStorage.getItem("kda_tg_quiet_start") || "23");
  const [qe, setQe] = useState(() => localStorage.getItem("kda_tg_quiet_end") || "7");
  const [targetsJson, setTargetsJson] = useState(() => localStorage.getItem("kda_tg_route_targets") || "");
  const [targetsMsg, setTargetsMsg] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const t = window.setInterval(() => setTick((v) => v + 1), 5000);
    return () => window.clearInterval(t);
  }, []);

  const toggle = (k: string) => {
    const next = !flags[k];
    localStorage.setItem(`kda_tg_feat_${k}`, next ? "true" : "false");
    setFlags((f) => ({ ...f, [k]: next }));
  };
  const saveHour = (key: string, v: string, set: (s: string) => void) => {
    set(v);
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 23) localStorage.setItem(key, String(n));
  };
  const saveTargets = () => {
    const t = targetsJson.trim();
    if (!t) {
      localStorage.removeItem("kda_tg_route_targets");
      setTargetsMsg("기본값(CAE GUI·CAE Solver·KDA 개발·쇼츠·SIGILFALL, 폴더 최신 대화 자동 연결) 사용");
      return;
    }
    try {
      const arr = JSON.parse(t);
      if (!Array.isArray(arr)) throw new Error("배열이 아님");
      localStorage.setItem("kda_tg_route_targets", JSON.stringify(arr));
      setTargetsMsg(`저장됨 (${arr.length}개). 없는 대화는 자동으로 빠집니다.`);
    } catch (e) {
      setTargetsMsg(`JSON 오류: ${String(e)}`);
    }
  };

  const hub = getActiveTelegramHub();
  void tick;
  const recent = hub ? hub.recent.slice(-12).reverse() : [];

  return (
    <div style={{ marginTop: 8 }}>
      <div className="settings-row-title" style={{ marginBottom: 6 }}>자동 분배 · 요약 회신 (v0.7.54)</div>
      {FEATURES.map((f) => (
        <div className="settings-row" key={f.key}>
          <div className="settings-row-info">
            <div className="settings-row-title">{f.title}</div>
            <div className="settings-row-desc">{f.desc}</div>
          </div>
          <button type="button" className={`settings-btn ${flags[f.key] ? "settings-btn-primary" : ""}`} onClick={() => toggle(f.key)}>
            {flags[f.key] ? "켜짐" : "꺼짐"}
          </button>
        </div>
      ))}
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-title">조용한 시간</div>
          <div className="settings-row-desc">시작~끝 시각(0~23). 자정을 넘겨도 됩니다(예: 23~7).</div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input className="api-key-input mono" style={{ width: 56 }} value={qs} onChange={(e) => saveHour("kda_tg_quiet_start", e.target.value, setQs)} />
          <span>~</span>
          <input className="api-key-input mono" style={{ width: 56 }} value={qe} onChange={(e) => saveHour("kda_tg_quiet_end", e.target.value, setQe)} />
        </div>
      </div>
      <div className="settings-row" style={{ alignItems: "flex-start" }}>
        <div className="settings-row-info" style={{ flex: 1 }}>
          <div className="settings-row-title">분배 대상 (비우면 기본값)</div>
          <div className="settings-row-desc">
            JSON 배열: {`[{"convId":"…","label":"CAE GUI","aliases":["cae"],"description":"…"}]`}. 트레이딩 봇은 기본값에서 제외돼 있습니다.
          </div>
          <textarea
            className="api-key-input mono"
            style={{ width: "100%", minHeight: 70, marginTop: 6 }}
            value={targetsJson}
            onChange={(e) => setTargetsJson(e.target.value)}
            spellCheck={false}
          />
          {targetsMsg && <div className="settings-row-desc">{targetsMsg}</div>}
        </div>
        <button type="button" className="settings-btn" onClick={saveTargets}>저장</button>
      </div>
      <div className="settings-row" style={{ alignItems: "flex-start" }}>
        <div className="settings-row-info" style={{ flex: 1 }}>
          <div className="settings-row-title">상태 (5초마다 갱신)</div>
          <div className="settings-row-desc">
            {hub
              ? `허브 동작 중 · 보류 결과 ${hub.heldCount}건 · 학습한 분배 교정 ${hub.examplesCount}건`
              : "허브 미동작 — 텔레그램 브리지가 꺼져 있거나 앱 시작 중"}
          </div>
          <div className="mono" style={{ fontSize: 12, marginTop: 6, whiteSpace: "pre-wrap" }}>
            {recent.length === 0
              ? "최근 기록 없음"
              : recent.map((r) => `${new Date(r.at).toLocaleTimeString("ko-KR", { hour12: false })} ${r.kind} ${r.detail}`).join("\n")}
          </div>
          <div className="settings-row-desc" style={{ marginTop: 4 }}>전체 기록: ~/.kda/telegram-bridge.log · 텔레그램에서 /상태</div>
        </div>
      </div>
    </div>
  );
}
