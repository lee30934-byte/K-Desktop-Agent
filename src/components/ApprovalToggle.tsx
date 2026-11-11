import { useApprovalMode } from '../utils/useApprovalMode';
import './ApprovalToggle.css';

export default function ApprovalToggle() {
  const { enabled, toggle, error } = useApprovalMode();
  return <span className="approval-toggle-wrap">
    <button type="button" className="approval-mode-toggle" role="switch" aria-checked={enabled}
      aria-label="확인 없이 실행" onClick={toggle}
      title="Ctrl+Alt+A · ON: Codex 명령·파일 승인과 MCP 입력 확인창을 띄우지 않고 실행. OFF: 확인창 표시. 기능별 허용 범위·도구 잠금·SafeMode 차단은 그대로 적용.">
      확인 없이 실행 {enabled ? 'ON' : 'OFF'}
    </button>
    {error && <span role="alert">{error}</span>}
  </span>;
}
