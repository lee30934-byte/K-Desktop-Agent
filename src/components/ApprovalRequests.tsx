import { useEffect, useRef, useState } from 'react';
import type { ApprovalRequest, ApprovalReply } from '../approvalAutomation.mjs';
import { automaticResponse, approvalDetail } from '../approvalAutomation.mjs';
import { readAutoApproval, useApprovalMode } from '../utils/useApprovalMode';
import CodexElicitationDialog from './CodexElicitationDialog';
import ApprovalToggle from './ApprovalToggle';

export default function ApprovalRequests({ requests, activeConversationId, isLive, respond, onResolved, onAudit }: {
  requests: ApprovalRequest[];
  activeConversationId: string | null;
  isLive: (request: ApprovalRequest) => boolean;
  respond: (request: ApprovalRequest, reply: ApprovalReply) => Promise<void>;
  onResolved: (request: ApprovalRequest) => void;
  onAudit: (request: ApprovalRequest, result: 'auto' | 'manual' | 'failed') => void;
}) {
  const { enabled } = useApprovalMode();
  const sending = useRef(new Set<string>());
  const attempted = useRef(new Set<string>());
  const [failed, setFailed] = useState(new Set<string>());
  const [busy, setBusy] = useState(new Set<string>());
  const [now, setNow] = useState(Date.now());
  const latest = useRef({ requests, activeConversationId, isLive, respond, onResolved, onAudit });
  latest.current = { requests, activeConversationId, isLive, respond, onResolved, onAudit };
  // Expired or stopped requests must not linger in the UI or acquire consent.
  useEffect(() => {
    if (!requests.length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [requests.length]);
  const submit = async (request: ApprovalRequest, reply: ApprovalReply, automatic: boolean) => {
    const current = latest.current;
    if (sending.current.has(request.token) || !current.requests.some(r => r.token === request.token && r.id === request.id)) return;
    if (!current.isLive(request) || request.expiresAt <= Date.now()) { current.onResolved(request); return; }
    if (automatic && !readAutoApproval()) return;
    if (!automatic && request.conversation_id !== current.activeConversationId) return;
    sending.current.add(request.token);
    if (automatic) attempted.current.add(request.token);
    setBusy(prev => new Set(prev).add(request.token));
    try {
      await current.respond(request, reply);
      current.onResolved(request);
      current.onAudit(request, automatic ? 'auto' : 'manual');
    } catch {
      setFailed(prev => new Set(prev).add(request.token));
      current.onAudit(request, 'failed');
      if (!automatic) throw new Error('Approval response delivery failed');
    } finally {
      sending.current.delete(request.token);
      setBusy(prev => { const next = new Set(prev); next.delete(request.token); return next; });
    }
  };
  useEffect(() => {
    if (!enabled) return;
    for (const request of requests) {
      const reply = automaticResponse(request);
      if (reply && isLive(request) && !attempted.current.has(request.token)) void submit(request, reply, true);
    }
  }, [enabled, requests, isLive]);
  useEffect(() => {
    const keys = new Set(requests.map(r => r.token));
    for (const key of attempted.current) if (!keys.has(key)) attempted.current.delete(key);
  }, [requests]);
  const request = requests.find(r => r.conversation_id === activeConversationId && isLive(r) && r.expiresAt > now &&
    (failed.has(r.token) || !enabled || !automaticResponse(r, now)));
  if (!request) return null;
  if (request.type === 'codex_elicitation_request') return (
    <CodexElicitationDialog key={request.token} request={request}
      deliveryError={failed.has(request.token)}
      onResponse={(r, action, content) => submit(r, { action, content }, false)} />
  );
  return <div className="elicitation-overlay">
    <div className="elicitation-dialog elicitation-warn" role="dialog" aria-modal="true" aria-labelledby="execution-approval-title">
      <h3 id="execution-approval-title">Codex 실행 승인</h3>
      <ApprovalToggle />
      <p>이 요청 1회에만 적용됩니다.</p>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '45vh', overflow: 'auto' }}>{approvalDetail(request)}</pre>
      {failed.has(request.token) && <p role="alert">응답 전달 실패. 다시 시도하거나 거절해 주세요.</p>}
      <div className="elicitation-actions">
        <button type="button" disabled={busy.has(request.token)} onClick={() => { void submit(request, { action: 'decline', content: null }, false).catch(() => {}); }}>거절</button>
        <button type="button" disabled={busy.has(request.token) || !automaticResponse(request)}
          onClick={() => { void submit(request, { action: 'accept', content: null }, false).catch(() => {}); }}>이 요청만 승인</button>
      </div>
    </div>
  </div>;
}
