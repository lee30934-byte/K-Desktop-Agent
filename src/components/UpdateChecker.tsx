import { useState, useEffect } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

interface UpdateInfo {
  version: string;
  body?: string;
  date?: string;
}

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
        setUpdateAvailable(true);
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

  if (!updateAvailable || dismissed) return null;

  return (
    <div className="update-banner">
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
          <button className="update-btn secondary" onClick={() => setDismissed(true)}>
            나중에
          </button>
        </div>
      )}

      {error && <div className="update-error">{error}</div>}
    </div>
  );
}
