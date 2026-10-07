import { useEffect, useRef, useState } from 'react';
import { parseElicitationSchema, validateElicitationContent } from '../../sidecar/src/mcp-elicitation-schema.mjs';
import type { CodexElicitationRequest } from '../types';

export default function CodexElicitationDialog({ request, onResponse }: {
  request: CodexElicitationRequest;
  onResponse: (request: CodexElicitationRequest, action: 'accept' | 'decline' | 'cancel', content: Record<string, unknown> | null) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(Date.now() >= request.expiresAt);
  const panel = useRef<HTMLDivElement>(null);
  const sending = useRef(false);
  const fields = parseElicitationSchema(request.schema);
  const schemaInfo = request.schema as { title?: unknown; description?: unknown } | null;
  useEffect(() => {
    panel.current?.focus();
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, request.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [request.expiresAt]);
  const respond = async (action: 'accept' | 'decline' | 'cancel') => {
    if (sending.current || (action === 'accept' && (expired || !validateElicitationContent(request.schema, values)))) return;
    sending.current = true;
    setBusy(true);
    try { await onResponse(request, action, action === 'accept' ? values : null); }
    catch { setError('응답을 전달하지 못했습니다. 거절하거나 다시 시도해 주세요.'); sending.current = false; setBusy(false); }
  };
  const set = (name: string, value: unknown) => setValues(prev => {
    const next = { ...prev };
    if (value === undefined) delete next[name]; else next[name] = value;
    return next;
  });
  return <div className="elicitation-overlay">
    <div className="elicitation-dialog elicitation-warn codex-elicitation" role="dialog" aria-modal="true" data-request-token={request.token}
      aria-labelledby="codex-elicit-title" tabIndex={-1} ref={panel} onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); void respond('cancel'); }
        if (e.key === 'Tab') {
          const nodes = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)');
          if (!nodes?.length) { e.preventDefault(); return; }
          const first = nodes[0], last = nodes[nodes.length - 1];
          if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }}>
      <h3 id="codex-elicit-title">연결된 도구의 추가 승인</h3>
      <p>요청 서버: <strong>{request.serverName}</strong></p>
      <p className="elicitation-message">{request.message}</p>
      {typeof schemaInfo?.title === 'string' && <p>{schemaInfo.title}</p>}
      {typeof schemaInfo?.description === 'string' && <p className="elicitation-message">{schemaInfo.description}</p>}
      <p className="elicitation-hint">아래 내용은 도구 서버가 보낸 요청입니다. 승인하면 입력한 내용이 이 요청에만 전달됩니다. 비밀번호나 인증 키는 입력하지 마세요.</p>
      {fields === null && <p role="alert">지원하지 않는 입력 형식입니다. 승인할 수 없습니다.</p>}
      <div className="codex-elicit-fields">
        {fields?.map(f => <label key={f.name}>
          <span>{f.title ?? f.name}{f.required ? ' (필수)' : ' (선택)'}</span>
          {f.description && <small>{f.description}</small>}
          {f.type === 'boolean' ? <select disabled={busy || expired} value={values[f.name] === undefined ? '' : String(values[f.name])}
            onChange={e => set(f.name, e.target.value === '' ? undefined : e.target.value === 'true')}>
            <option value="">선택해 주세요</option><option value="true">예</option><option value="false">아니요</option>
          </select> : f.options ? <select disabled={busy || expired} multiple={f.type === 'array'}
            value={f.type === 'array' ? (values[f.name] as string[] ?? []) : (values[f.name] as string ?? '')}
            onChange={e => set(f.name, f.type === 'array' ? Array.from(e.target.selectedOptions, o => o.value) : e.target.value)}>
            {f.type !== 'array' && <option value="" disabled>선택해 주세요</option>}
            {f.options.map(o => <option key={o.value} value={o.value}>{o.label} ({o.value})</option>)}
          </select> : <input disabled={busy || expired} type={f.type === 'string' ? 'text' : 'number'}
            step={f.type === 'integer' ? '1' : 'any'} min={f.minimum} max={f.maximum}
            maxLength={f.maxLength ?? 12000} value={values[f.name] as string | number ?? ''}
            onChange={e => set(f.name, f.type === 'string' ? e.target.value : e.target.value === '' ? undefined : e.target.valueAsNumber)} />}
          {!f.required && <button type="button" disabled={busy || expired} onClick={() => set(f.name, undefined)}>입력 제외</button>}
        </label>)}
      </div>
      {expired && <p role="alert">요청이 만료되었습니다. 승인할 수 없습니다.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="elicitation-actions">
        <button type="button" className="elicitation-btn-cancel" disabled={busy} onClick={() => void respond('cancel')}>취소</button>
        <button type="button" className="elicitation-btn-cancel" disabled={busy} onClick={() => void respond('decline')}>거절</button>
        <button type="button" className="elicitation-btn-confirm" disabled={busy || expired || !validateElicitationContent(request.schema, values)}
          onClick={() => void respond('accept')}>이 요청만 승인</button>
      </div>
    </div>
  </div>;
}
