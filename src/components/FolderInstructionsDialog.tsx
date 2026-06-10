// ─────────────────────────────────────────────────────────────────
// Phase 107 (v0.6.56) — 폴더 프로젝트 지침 + 첨부파일 편집 다이얼로그
// ─────────────────────────────────────────────────────────────────
// K 가 폴더 우클릭 → "📜 프로젝트 지침…" 선택 시 열림.
// - 시스템 프롬프트 textarea (지침)
// - 첨부파일 list + [+ 파일 추가] (tauri-plugin-dialog 의 open) + ✕ remove
// 저장 시 db.ts 의 updateFolderInstructions 호출.
// 새 대화가 이 폴더에 속한 채 첫 message 송신될 때 sidecar 가 자동 inject.

import { useEffect, useState, useCallback, memo } from "react";
import type { CSSProperties } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { FolderRecord, FolderAttachment, ProjectProfile } from "../db";

interface Props {
  folder: FolderRecord;
  onClose: () => void;
  onSave: (
    systemPrompt: string | null,
    attachments: FolderAttachment[],
    // Phase 138 (v0.7.10) — #3 프로젝트 모드 프로필 (null 이면 미설정)
    projectProfile: ProjectProfile | null,
  ) => Promise<void> | void;
}

// Phase 138 — 줄/콤마 구분 문자열 → 정규화된 배열.
function splitLines(s: string): string[] {
  return s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

// Phase 138 — 프로젝트 프로필 입력 공통 스타일.
const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontFamily: "inherit",
  fontSize: 12,
  lineHeight: 1.5,
  background: "var(--bg-1, #0a0e18)",
  border: "1px solid var(--border-dim, #1d2540)",
  borderRadius: 6,
  color: "var(--text, #e8eaff)",
  boxSizing: "border-box",
};

function basenameOf(p: string): string {
  // Windows 경로 둘 다 처리
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function formatSize(bytes?: number): string {
  if (typeof bytes !== "number" || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function FolderInstructionsDialog({ folder, onClose, onSave }: Props) {
  const [prompt, setPrompt] = useState<string>(folder.systemPrompt ?? "");
  const [attachments, setAttachments] = useState<FolderAttachment[]>(
    Array.isArray(folder.attachments) ? folder.attachments : [],
  );
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Phase 138 (v0.7.10) — #3 프로젝트 모드 프로필 필드.
  const pp = folder.projectProfile;
  const [projName, setProjName] = useState<string>(pp?.name ?? "");
  const [projDefaultPath, setProjDefaultPath] = useState<string>(pp?.defaultPath ?? "");
  const [projForbidden, setProjForbidden] = useState<string>(
    Array.isArray(pp?.forbiddenTools) ? pp!.forbiddenTools!.join("\n") : "",
  );
  const [projMemoryTags, setProjMemoryTags] = useState<string>(
    Array.isArray(pp?.memoryTags) ? pp!.memoryTags!.join(", ") : "",
  );

  // ESC 로 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const handleAddFile = useCallback(async () => {
    try {
      // tauri-plugin-dialog 의 open dialog (시스템 파일 선택)
      const result = await openDialog({
        multiple: true,
        directory: false,
        title: "프로젝트 첨부파일 선택",
      });
      if (!result) return;
      const paths = Array.isArray(result) ? result : [result];
      const now = Date.now();
      const newAttachments: FolderAttachment[] = paths.map((p) => ({
        name: basenameOf(String(p)),
        path: String(p),
        addedAt: now,
      }));
      // 중복 path skip
      setAttachments((prev) => {
        const existingPaths = new Set(prev.map((a) => a.path));
        const fresh = newAttachments.filter((a) => !existingPaths.has(a.path));
        return [...prev, ...fresh];
      });
    } catch (err) {
      // pitfall_js_arg_type_silent_throw 회피 — 에러 가시화
      console.error("[FolderInstructionsDialog] 파일 선택 실패:", err);
      setErrorMsg(`파일 선택 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const handleRemoveAttachment = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setErrorMsg(null);
    try {
      // Phase 138 — 채워진 필드만 모아 ProjectProfile 구성 (전부 비면 null).
      const profile: ProjectProfile = {};
      if (projName.trim()) profile.name = projName.trim();
      if (projDefaultPath.trim()) profile.defaultPath = projDefaultPath.trim();
      const ft = splitLines(projForbidden);
      if (ft.length > 0) profile.forbiddenTools = ft;
      const mt = splitLines(projMemoryTags);
      if (mt.length > 0) profile.memoryTags = mt;
      const profileOrNull = Object.keys(profile).length > 0 ? profile : null;
      await onSave(prompt.trim() ? prompt : null, attachments, profileOrNull);
      onClose();
    } catch (err) {
      console.error("[FolderInstructionsDialog] 저장 실패:", err);
      setErrorMsg(`저장 실패: ${err instanceof Error ? err.message : String(err)}`);
      setSaving(false);
    }
  }, [prompt, attachments, projName, projDefaultPath, projForbidden, projMemoryTags, onSave, onClose]);

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      style={{
        // Phase 107 (v0.6.56) 잔재 fix — .modal-overlay CSS 가 KDA 어디에도 정의되어
        // 있지 않아서 wrapper 가 static div 로 렌더되어 다이얼로그 안 보이는 사고.
        // inline style 로 강제 박음 — z-index 매우 높게 (다른 modal/sidepanel 위).
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
    >
      <div
        className="folder-instructions-dialog"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          background: "var(--bg-2, #0f1420)",
          border: "1px solid var(--border-accent, #2a3550)",
          borderRadius: 8,
          width: "min(720px, 92vw)",
          maxHeight: "86vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--border-dim, #1d2540)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>
              📜 프로젝트 지침 — {folder.name}
            </div>
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>
              이 폴더에 속한 새 대화의 첫 메시지에 자동으로 박힙니다.
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-dim, #8e9ab5)",
              fontSize: 18,
              cursor: saving ? "default" : "pointer",
              padding: "4px 8px",
            }}
            title="닫기 (Esc)"
          >
            ✕
          </button>
        </div>

        {/* Body — scrollable */}
        <div style={{ padding: "16px 18px", overflowY: "auto", flex: 1 }}>
          {/* 시스템 프롬프트 */}
          <div style={{ marginBottom: 18 }}>
            <label
              style={{
                display: "block",
                fontSize: 12,
                fontWeight: 600,
                marginBottom: 6,
                color: "var(--accent, #66ccff)",
              }}
            >
              지침 (System Prompt)
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={saving}
              placeholder={`예) 공문 작성 폴더의 지침:\n- 모든 공문은 두괄식으로 작성\n- 결재선 라인 박을 것\n- 첨부된 양식 파일 (별첨 1) 형식 그대로 따를 것`}
              spellCheck={false}
              style={{
                width: "100%",
                minHeight: 180,
                maxHeight: 360,
                padding: "10px 12px",
                fontFamily: "inherit",
                fontSize: 13,
                lineHeight: 1.5,
                background: "var(--bg-1, #0a0e18)",
                border: "1px solid var(--border-dim, #1d2540)",
                borderRadius: 6,
                color: "var(--text, #e8eaff)",
                resize: "vertical",
                boxSizing: "border-box",
              }}
            />
            <div style={{ fontSize: 10, opacity: 0.5, marginTop: 4 }}>
              {prompt.length.toLocaleString()} 자
            </div>
          </div>

          {/* 첨부파일 */}
          <div>
            <label
              style={{
                display: "block",
                fontSize: 12,
                fontWeight: 600,
                marginBottom: 6,
                color: "var(--accent, #66ccff)",
              }}
            >
              첨부 파일 ({attachments.length})
            </label>
            {attachments.length === 0 ? (
              <div
                style={{
                  fontSize: 12,
                  opacity: 0.5,
                  padding: "10px 12px",
                  border: "1px dashed var(--border-dim, #1d2540)",
                  borderRadius: 6,
                  textAlign: "center",
                }}
              >
                첨부된 파일 없음
              </div>
            ) : (
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                {attachments.map((a) => (
                  <li
                    key={a.path}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 10px",
                      background: "var(--bg-1, #0a0e18)",
                      border: "1px solid var(--border-dim, #1d2540)",
                      borderRadius: 4,
                    }}
                  >
                    <span style={{ fontSize: 13 }}>📄</span>
                    <div style={{ flex: 1, overflow: "hidden" }}>
                      <div style={{ fontSize: 12, fontWeight: 500 }}>{a.name}</div>
                      <div
                        style={{
                          fontSize: 10,
                          opacity: 0.5,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                        title={a.path}
                      >
                        {a.path}
                        {a.size ? ` · ${formatSize(a.size)}` : ""}
                      </div>
                    </div>
                    <button
                      onClick={() => handleRemoveAttachment(a.path)}
                      disabled={saving}
                      title="첨부 제거"
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "var(--text-dim, #8e9ab5)",
                        cursor: saving ? "default" : "pointer",
                        padding: "2px 6px",
                        fontSize: 14,
                      }}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              onClick={handleAddFile}
              disabled={saving}
              style={{
                marginTop: 8,
                padding: "6px 12px",
                background: "var(--bg-1, #0a0e18)",
                border: "1px dashed var(--accent-dim, #335c80)",
                borderRadius: 4,
                color: "var(--accent, #66ccff)",
                fontSize: 12,
                cursor: saving ? "default" : "pointer",
              }}
            >
              + 파일 추가…
            </button>
          </div>

          {/* Phase 138 (v0.7.10) — #3 프로젝트 모드 프로필 */}
          <div style={{ marginTop: 22, paddingTop: 16, borderTop: "1px solid var(--border-dim, #1d2540)" }}>
            <label
              style={{
                display: "block",
                fontSize: 12,
                fontWeight: 600,
                marginBottom: 4,
                color: "var(--accent, #66ccff)",
              }}
            >
              프로젝트 모드 프로필 (#3)
            </label>
            <div style={{ fontSize: 10, opacity: 0.55, marginBottom: 10, lineHeight: 1.5 }}>
              설정 → 실험 기능에서 <b>프로젝트 모드</b>가 ON 일 때만 적용됩니다 (OFF 면 무시).
              이 프로젝트의 대화에 스코프 격리(금지 도구·메모리 범위·기본 경로)를 강제합니다.
            </div>

            {/* 프로젝트 이름 */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, opacity: 0.8, marginBottom: 4 }}>프로젝트 이름</div>
              <input
                type="text"
                value={projName}
                onChange={(e) => setProjName(e.target.value)}
                disabled={saving}
                placeholder={folder.name}
                spellCheck={false}
                style={inputStyle}
              />
            </div>

            {/* 기본 작업 경로 */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, opacity: 0.8, marginBottom: 4 }}>기본 작업 경로</div>
              <input
                type="text"
                value={projDefaultPath}
                onChange={(e) => setProjDefaultPath(e.target.value)}
                disabled={saving}
                placeholder="예) C:/Users/user/Documents/트레이딩봇"
                spellCheck={false}
                style={inputStyle}
              />
            </div>

            {/* 금지 도구 */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, opacity: 0.8, marginBottom: 4 }}>
                금지 도구 (한 줄에 하나 — 도구 풀네임)
              </div>
              <textarea
                value={projForbidden}
                onChange={(e) => setProjForbidden(e.target.value)}
                disabled={saving}
                placeholder={"예)\nmcp__k-personal__fm_move_file\nmcp__k-personal__app_kill\nBash"}
                spellCheck={false}
                style={{ ...inputStyle, minHeight: 70, resize: "vertical", fontFamily: "monospace" }}
              />
            </div>

            {/* 메모리 태그 */}
            <div>
              <div style={{ fontSize: 11, opacity: 0.8, marginBottom: 4 }}>
                메모리 범위 태그 (콤마 구분 — memory/*.md 의 projects: 와 매칭)
              </div>
              <input
                type="text"
                value={projMemoryTags}
                onChange={(e) => setProjMemoryTags(e.target.value)}
                disabled={saving}
                placeholder="예) trading, 5080"
                spellCheck={false}
                style={inputStyle}
              />
            </div>
          </div>

          {errorMsg && (
            <div
              style={{
                marginTop: 14,
                padding: "8px 12px",
                background: "rgba(255, 80, 80, 0.1)",
                border: "1px solid rgba(255, 80, 80, 0.3)",
                borderRadius: 4,
                color: "#ff8080",
                fontSize: 12,
              }}
            >
              {errorMsg}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 18px",
            borderTop: "1px solid var(--border-dim, #1d2540)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              padding: "6px 16px",
              background: "transparent",
              border: "1px solid var(--border-dim, #1d2540)",
              borderRadius: 4,
              color: "var(--text-dim, #8e9ab5)",
              cursor: saving ? "default" : "pointer",
              fontSize: 12,
            }}
          >
            취소
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: "6px 16px",
              background: "var(--accent, #66ccff)",
              border: "1px solid var(--accent, #66ccff)",
              borderRadius: 4,
              color: "var(--bg-1, #0a0e18)",
              cursor: saving ? "default" : "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {saving ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default memo(FolderInstructionsDialog);
