import { useCallback, useEffect, useState } from 'react';
import { APPROVAL_MODE_KEY, APPROVAL_MODE_EVENT } from '../approvalAutomation.mjs';

export function readAutoApproval(): boolean {
  try { return localStorage.getItem(APPROVAL_MODE_KEY) === '1'; }
  catch { return false; }
}

export function useApprovalMode() {
  const [enabled, setEnabled] = useState(readAutoApproval);
  const [error, setError] = useState('');
  useEffect(() => {
    const sync = () => setEnabled(readAutoApproval());
    window.addEventListener(APPROVAL_MODE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(APPROVAL_MODE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  const toggle = useCallback(() => {
    try {
      localStorage.setItem(APPROVAL_MODE_KEY, readAutoApproval() ? '0' : '1');
      setError('');
      window.dispatchEvent(new Event(APPROVAL_MODE_EVENT));
    } catch { setError('승인 설정을 저장하지 못했습니다.'); }
  }, []);
  return { enabled, toggle, error };
}

export function useApprovalShortcut() {
  const { toggle } = useApprovalMode();
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && !e.shiftKey && e.code === 'KeyA' && !e.repeat && !e.getModifierState('AltGraph')) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [toggle]);
}
