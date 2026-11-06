import { useEffect, useState } from 'react';
import { mobileControl, type MobileState } from '../mobileControl';

export default function MobileSettings() {
  const [state, setState] = useState<MobileState | null>(null);
  const [origin, setOrigin] = useState(() => localStorage.getItem('kda_mobile_origin') || '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const run = async (action: string) => {
    setBusy(true); setError('');
    try {
      const result = await mobileControl(action, action === 'enable' ? { origin, port: 17677 } : {});
      setState(result); if (action === 'enable') localStorage.setItem('kda_mobile_origin', result.origin);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  useEffect(() => { void run('status'); }, []);
  return <div className="settings-row" style={{ display: 'block', padding: '18px 0' }}>
    <div className="settings-row-title">휴대폰 아바타 · 원격 명령</div>
    <p className="settings-row-desc">휴대폰에서 음성·텍스트 명령과 결과 확인. PC가 켜져 있고 KDA가 실행 중이어야 합니다.</p>
    <p className="settings-row-desc">개인 HTTPS 연결 주소를 입력하세요. 기존 Tailscale Serve 등의 연결이 PC의 127.0.0.1:17677로 이어져야 합니다. 외부 공개·방화벽 변경은 자동으로 하지 않습니다.</p>
    <label>휴대폰 접속 주소<input type="url" aria-label="휴대폰 접속 HTTPS 주소" value={origin} disabled={!!state?.enabled || busy}
      onChange={e => setOrigin(e.target.value)} placeholder="https://내-PC.내-tailnet.ts.net" style={{ width: '100%', margin: '8px 0' }} /></label>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button type="button" disabled={busy || !origin.trim() || !!state?.enabled} onClick={() => void run('enable')}>휴대폰 연결 켜기</button>
      <button type="button" disabled={busy || !state?.enabled} onClick={() => void run('rotate')}>새 연결 코드</button>
      <button type="button" disabled={busy || !state?.enabled} onClick={() => void run('disable')}>모든 휴대폰 연결 해제</button>
      <button type="button" disabled={busy} onClick={() => void run('status')}>상태 새로고침</button>
    </div>
    <p role="status">{state?.enabled ? `연결 켜짐 · ${state.clients}대 · PC 재시작 시 꺼짐` : '연결 꺼짐'}</p>
    {state?.enabled && state.pairingCode && <div style={{ overflowWrap: 'anywhere' }}>
      <p>휴대폰에서 <strong>{state.origin}</strong>에 접속한 뒤 아래 일회용 코드를 입력하세요. 10분 안에 한 번만 사용할 수 있습니다.</p>
      <code style={{ userSelect: 'all' }}>{state.pairingCode}</code>
      <p className="settings-row-desc">코드는 PC 작업 권한을 연결합니다. 다른 사람에게 공유하지 마세요. 연결 후 8시간 또는 90초 이상 접속이 끊기면 만료됩니다.</p>
    </div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
