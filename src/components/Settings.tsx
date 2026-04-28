import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import CornerBrackets from "./CornerBrackets";
import type { WatchedFolder } from "../types";

interface SettingsProps {
  open: boolean;
  onClose: () => void;
  mcpConnected: boolean;
}

// API 제공자 타입
interface APIProvider {
  id: string;
  name: string;
  icon: string;
  keyName: string;
  placeholder: string;
  docsUrl: string;
  supportsOAuth?: boolean;
}

const API_PROVIDERS: APIProvider[] = [
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    icon: "🤖",
    keyName: "ANTHROPIC_API_KEY",
    placeholder: "sk-ant-api...",
    docsUrl: "https://console.anthropic.com/",
    supportsOAuth: false,
  },
  {
    id: "openai",
    name: "OpenAI (GPT)",
    icon: "🧠",
    keyName: "OPENAI_API_KEY",
    placeholder: "sk-proj-...",
    docsUrl: "https://platform.openai.com/api-keys",
    supportsOAuth: false,
  },
  {
    id: "google",
    name: "Google (Gemini)",
    icon: "🔮",
    keyName: "GOOGLE_API_KEY",
    placeholder: "AIza...",
    docsUrl: "https://aistudio.google.com/apikey",
    supportsOAuth: true,
  },
];

export default function Settings({ open, onClose, mcpConnected }: SettingsProps) {
  const [autoStart, setAutoStart] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [watchedFolders, setWatchedFolders] = useState<WatchedFolder[]>([]);
  const [addingFolder, setAddingFolder] = useState(false);

  // API 키 상태
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [activeProvider, setActiveProvider] = useState<string>("anthropic");

  useEffect(() => {
    if (!open) return;
    setLoading(true);

    // 병렬로 설정 로드
    Promise.all([
      isEnabled().catch(() => false),
      invoke<WatchedFolder[]>("get_watched_folders_list").catch(() => []),
      loadAPIKeys(),
    ])
      .then(([autoStartEnabled, folders, keys]) => {
        setAutoStart(autoStartEnabled);
        setWatchedFolders(folders);
        setApiKeys(keys);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [open]);

  // API 키 로드 (localStorage에서)
  async function loadAPIKeys(): Promise<Record<string, string>> {
    try {
      const stored = localStorage.getItem("kda_api_keys");
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (e) {
      console.error("API 키 로드 실패:", e);
    }
    return {};
  }

  // API 키 저장
  async function saveAPIKey(providerId: string, key: string) {
    setSavingKey(providerId);
    try {
      const newKeys = { ...apiKeys, [providerId]: key };
      setApiKeys(newKeys);
      localStorage.setItem("kda_api_keys", JSON.stringify(newKeys));

      // 환경 변수로도 설정 (Rust 백엔드에 전달)
      const provider = API_PROVIDERS.find(p => p.id === providerId);
      if (provider) {
        await invoke("set_env_var", {
          name: provider.keyName,
          value: key
        }).catch(() => {
          // 명령이 없으면 무시 (나중에 구현)
        });
      }
    } catch (e) {
      console.error("API 키 저장 실패:", e);
    } finally {
      setSavingKey(null);
    }
  }

  // API 키 삭제
  async function removeAPIKey(providerId: string) {
    const newKeys = { ...apiKeys };
    delete newKeys[providerId];
    setApiKeys(newKeys);
    localStorage.setItem("kda_api_keys", JSON.stringify(newKeys));
  }

  async function toggleAutoStart() {
    setLoading(true);
    try {
      if (autoStart) {
        await disable();
        setAutoStart(false);
      } else {
        await enable();
        setAutoStart(true);
      }
    } catch (e) {
      console.error("autostart toggle failed:", e);
    } finally {
      setLoading(false);
    }
  }

  async function handleReload() {
    setReloading(true);
    try {
      await invoke("reload_sidecar");
      // 잠시 후 자동 해제 (sidecar ready 다시 뜨면 UI 업데이트됨)
      setTimeout(() => setReloading(false), 2000);
    } catch (e) {
      console.error("reload failed:", e);
      setReloading(false);
    }
  }

  async function handleQuit() {
    try {
      await invoke("quit_app");
    } catch {
      // ignore
    }
  }

  async function handleAddWatchFolder() {
    setAddingFolder(true);
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "감시할 폴더 선택",
      });

      if (selected && typeof selected === "string") {
        await invoke("watch_folder", { path: selected, recursive: true });
        const folders = await invoke<WatchedFolder[]>("get_watched_folders_list");
        setWatchedFolders(folders);
      }
    } catch (e) {
      console.error("폴더 추가 실패:", e);
    } finally {
      setAddingFolder(false);
    }
  }

  async function handleRemoveWatchFolder(path: string) {
    try {
      await invoke("unwatch_folder", { path });
      setWatchedFolders((prev) => prev.filter((f) => f.path !== path));
    } catch (e) {
      console.error("폴더 제거 실패:", e);
    }
  }

  if (!open) return null;

  const currentProvider = API_PROVIDERS.find(p => p.id === activeProvider);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <CornerBrackets corners={["tl", "tr", "bl", "br"]} size={12} />

        <div className="settings-header">
          <div>
            <div className="eyebrow">설정</div>
            <h2 className="display settings-title">환경설정</h2>
          </div>
          <button className="settings-close" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </div>

        <div className="settings-body">
          {/* API 키 / 인증 섹션 */}
          <section className="settings-section">
            <div className="eyebrow">AI 모델 연동</div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-info">
                <div className="settings-row-title">API 키 설정</div>
                <div className="settings-row-desc">
                  여러 AI 모델을 API 키로 연동하여 사용할 수 있습니다
                </div>
              </div>

              {/* 제공자 탭 */}
              <div className="api-provider-tabs">
                {API_PROVIDERS.map((provider) => (
                  <button
                    key={provider.id}
                    className={`api-provider-tab ${activeProvider === provider.id ? "active" : ""} ${apiKeys[provider.id] ? "has-key" : ""}`}
                    onClick={() => setActiveProvider(provider.id)}
                  >
                    <span className="api-provider-icon">{provider.icon}</span>
                    <span className="api-provider-name">{provider.name.split(" ")[0]}</span>
                    {apiKeys[provider.id] && <span className="api-key-check">✓</span>}
                  </button>
                ))}
              </div>

              {/* 선택된 제공자 설정 */}
              {currentProvider && (
                <div className="api-key-form">
                  <div className="api-key-header">
                    <span>{currentProvider.icon} {currentProvider.name}</span>
                    <a
                      href={currentProvider.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="api-key-docs"
                    >
                      API 키 발급 →
                    </a>
                  </div>

                  <div className="api-key-input-row">
                    <input
                      type={showKeys[currentProvider.id] ? "text" : "password"}
                      className="api-key-input mono"
                      placeholder={currentProvider.placeholder}
                      value={apiKeys[currentProvider.id] || ""}
                      onChange={(e) => setApiKeys({
                        ...apiKeys,
                        [currentProvider.id]: e.target.value
                      })}
                    />
                    <button
                      className="api-key-toggle"
                      onClick={() => setShowKeys({
                        ...showKeys,
                        [currentProvider.id]: !showKeys[currentProvider.id]
                      })}
                      title={showKeys[currentProvider.id] ? "숨기기" : "보기"}
                    >
                      {showKeys[currentProvider.id] ? "🙈" : "👁"}
                    </button>
                  </div>

                  <div className="api-key-actions">
                    <button
                      className="settings-btn settings-btn-primary"
                      onClick={() => saveAPIKey(currentProvider.id, apiKeys[currentProvider.id] || "")}
                      disabled={savingKey === currentProvider.id || !apiKeys[currentProvider.id]}
                    >
                      {savingKey === currentProvider.id ? "저장 중..." : "저장"}
                    </button>
                    {apiKeys[currentProvider.id] && (
                      <button
                        className="settings-btn settings-btn-danger"
                        onClick={() => removeAPIKey(currentProvider.id)}
                      >
                        삭제
                      </button>
                    )}
                  </div>

                  {currentProvider.supportsOAuth && (
                    <div className="api-oauth-section">
                      <div className="api-oauth-divider">또는</div>
                      <button className="settings-btn settings-btn-oauth">
                        🔐 {currentProvider.name.split(" ")[0]} 계정으로 로그인
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* 현재 활성 모델 표시 */}
          <section className="settings-section">
            <div className="eyebrow">활성 모델</div>
            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-title">현재 사용 중인 모델</div>
                <div className="settings-row-desc">
                  Claude Opus 4.7 (Max 구독 - 1M 컨텍스트)
                </div>
              </div>
              <div className="model-status">
                <span className="model-badge active">활성</span>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <div className="eyebrow">시작</div>
            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-title">Windows 시작 시 자동 실행</div>
                <div className="settings-row-desc">
                  부팅하면 트레이에 숨겨진 채로 자동 실행됩니다
                </div>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={autoStart}
                  onChange={toggleAutoStart}
                  disabled={loading}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>
          </section>

          <section className="settings-section">
            <div className="eyebrow">런타임</div>
            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-title">Sidecar · MCP 재기동</div>
                <div className="settings-row-desc">
                  응답이 이상하거나 MCP 꼬였을 때 Node 사이드카를 재시작합니다
                  <br />
                  상태: {mcpConnected ? (
                    <span className="status-ok">● K-PERSONAL · 연결됨</span>
                  ) : (
                    <span className="status-warn">● 연결 안됨</span>
                  )}
                </div>
              </div>
              <button
                className="settings-btn"
                onClick={handleReload}
                disabled={reloading}
              >
                {reloading ? "재시작 중..." : "재시작"}
              </button>
            </div>
          </section>

          <section className="settings-section">
            <div className="eyebrow">리소스</div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-header">
                <div className="settings-row-info">
                  <div className="settings-row-title">파일 시스템 감시</div>
                  <div className="settings-row-desc">
                    폴더 변경 사항을 실시간으로 모니터링합니다
                  </div>
                </div>
                <button
                  className="settings-btn"
                  onClick={handleAddWatchFolder}
                  disabled={addingFolder}
                >
                  {addingFolder ? "..." : "+ 폴더 추가"}
                </button>
              </div>
              {watchedFolders.length > 0 && (
                <div className="watched-folders-list">
                  {watchedFolders.map((folder) => (
                    <div key={folder.path} className="watched-folder-item">
                      <span className="watched-folder-path mono" title={folder.path}>
                        📁 {folder.path.split("\\").pop() || folder.path}
                      </span>
                      <span className="watched-folder-full-path mono">
                        {folder.path}
                      </span>
                      <button
                        className="watched-folder-remove"
                        onClick={() => handleRemoveWatchFolder(folder.path)}
                        title="감시 중단"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="settings-section">
            <div className="eyebrow">단축키</div>
            <div className="settings-row settings-row-vertical">
              <div className="settings-row-info">
                <div className="settings-row-title">전역 단축키</div>
                <div className="settings-row-desc">
                  어떤 앱에서든 사용할 수 있는 시스템 단축키
                </div>
              </div>
              <div className="shortcuts-list">
                <div className="shortcut-item">
                  <span className="shortcut-key mono">Ctrl+Shift+Space</span>
                  <span className="shortcut-desc">창 표시/숨김 토글</span>
                </div>
                <div className="shortcut-item">
                  <span className="shortcut-key mono">Ctrl+Shift+S</span>
                  <span className="shortcut-desc">스크린샷 캡처 후 분석</span>
                </div>
                <div className="shortcut-item">
                  <span className="shortcut-key mono">Ctrl+Shift+P</span>
                  <span className="shortcut-desc">빠른 명령 팔레트</span>
                </div>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <div className="eyebrow">앱</div>
            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-title">앱 종료</div>
                <div className="settings-row-desc">
                  창을 X로 닫으면 트레이로만 숨기고, 완전 종료는 여기서
                </div>
              </div>
              <button className="settings-btn settings-btn-danger" onClick={handleQuit}>
                종료
              </button>
            </div>
          </section>

          <section className="settings-section">
            <div className="eyebrow">정보</div>
            <div className="settings-meta mono">
              <div>K Desktop Agent v0.1.0</div>
              <div>Tauri + React + Node sidecar (Claude Agent SDK)</div>
              <div>현재 모델: Claude Opus 4.7 · 1M 컨텍스트 · Max 구독</div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
