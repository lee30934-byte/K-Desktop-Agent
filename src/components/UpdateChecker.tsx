import { useState, useEffect } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

interface UpdateInfo {
  version: string;
  body?: string;
  date?: string;
}

// Phase 37 (v0.5.25): 같은 버전을 한 번 dismiss 하면 다음 버전 출시 전까지 안 뜨게.
// 종전: dismissed 가 component-local state — 30분 polling 마다 또는 KDA 재시작 시 즉시 다시 뜸.
// K 의 빌드 cycle 이 분 단위라 알림이 사이드바 K.AGENT 로고를 영구히 가림.
const DISMISSED_VERSION_KEY = 'kda_update_dismissed_version';

export function UpdateChecker() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    checkForUpdate();
    // 30분마다 업데이트 체크
    const interval = setInterval(checkForUpdate, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  async function checkForUpdate() {
    try {
      const update = await check();
      if (update) {
        // Phase 37: 같은 버전을 이미 dismiss 했으면 알림 띄우지 않음
        const dismissedVersion = localStorage.getItem(DISMISSED_VERSION_KEY);
        if (dismissedVersion === update.version) {
          // 이미 K 가 "나중에" 또는 ✕ 한 버전 → 다음 버전 출시 전까지 silent
          return;
        }
        setUpdateAvailable(true);
        setDismissed(false);
        setUpdateInfo({
          version: update.version,
          body: update.body,
          date: update.date,
        });
      }
    } catch (e) {
      console.log('업데이트 체크 실패 (정상 - 오프라인 또는 설정 미완료):', e);
    }
  }

  async function downloadAndInstall() {
    setDownloading(true);
    setError(null);
    let totalSize = 0;
    let downloaded = 0;

    try {
      const update = await check();
      if (!update) return;

      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          const data = event.data as { contentLength?: number };
          totalSize = data.contentLength || 0;
          setProgress(0);
        } else if (event.event === 'Progress') {
          const data = event.data as { chunkLength: number };
          downloaded += data.chunkLength;
          if (totalSize > 0) {
            setProgress(Math.round((downloaded / totalSize) * 100));
          }
        } else if (event.event === 'Finished') {
          setProgress(100);
        }
      });

      // 설치 완료 후 재시작
      await relaunch();
    } catch (e) {
      setError(e instanceof Error ? e.message : '업데이트 실패');
      setDownloading(false);
    }
  }

  function dismissUpdate() {
    // Phase 37: localStorage 에 영구 저장 — 같은 버전은 다시 알림 안 뜸
    if (updateInfo?.version) {
      try {
        localStorage.setItem(DISMISSED_VERSION_KEY, updateInfo.version);
      } catch {}
    }
    setDismissed(true);
  }

  if (!updateAvailable || dismissed) return null;

  return (
    <div className="update-banner">
      {/* Phase 37: 우측 상단 명확한 ✕ 닫기 버튼 — 같은 버전은 다음에 안 뜸 */}
      <button
        type="button"
        className="update-close-btn"
        onClick={dismissUpdate}
        title="이 버전 알림 닫기 (다음 버전 출시까지 다시 안 뜸)"
        aria-label="업데이트 알림 닫기"
      >
        ✕
      </button>

      <div className="update-content">
        <div className="update-icon">🎉</div>
        <div className="update-text">
          <strong>새 버전 {updateInfo?.version} 출시!</strong>
          {updateInfo?.body && (
            <p className="update-notes">{updateInfo.body.slice(0, 100)}...</p>
          )}
        </div>
      </div>

      {downloading ? (
        <div className="update-progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <span>{progress}%</span>
        </div>
      ) : (
        <div className="update-actions">
          <button className="update-btn primary" onClick={downloadAndInstall}>
            지금 업데이트
          </button>
          <button className="update-btn secondary" onClick={dismissUpdate}>
            나중에
          </button>
        </div>
      )}

      {error && <div className="update-error">{error}</div>}
    </div>
  );
}
