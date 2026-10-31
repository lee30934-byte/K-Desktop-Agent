import { useApprovalMode } from '../utils/useApprovalMode';
import './ApprovalToggle.css';

export default function ApprovalToggle() {
  const { enabled, toggle, error } = useApprovalMode();
  return <span className="approval-toggle-wrap">
    <button type="button" className="approval-mode-toggle" role="switch" aria-checked={enabled}
      aria-label="자동 승인" onClick={toggle}
      title="앱에서 Ctrl+Alt+A · ON: 모든 대화의 Codex·MCP 확인을 창 없이 승인. OFF: 필요한 요청 확인. 질문·인증·도구 잠금은 유지.">
      자동 승인 {enabled ? 'ON' : 'OFF'}
    </button>
    {error && <span role="alert">{error}</span>}
  </span>;
}
