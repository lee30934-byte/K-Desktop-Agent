// v0.7.86 UI 3b단계 — 화면 배치 전환 (2026-11-11 K: 옛 배치도 계속 쓸 수 있게).
// "o2" = 새 배치(신규 설치 기본값), "classic" = 이전 배치. localStorage 에 저장하고
// window 이벤트로 모든 컴포넌트를 동기화한다 (useApprovalMode 와 같은 방식).
// document.documentElement.dataset.layout 도 같이 맞춰 CSS 를 :root[data-layout="o2"] 로 한정한다.
import { useCallback, useEffect, useState } from 'react';
import { devLayoutOverride } from '../dev/mockupFixture';

export type UiLayout = 'o2' | 'classic';
export const UI_LAYOUT_KEY = 'kda_ui_layout';
export const UI_LAYOUT_EVENT = 'kda-ui-layout-changed';
export const DEFAULT_UI_LAYOUT: UiLayout = 'o2';

export function readUiLayout(): UiLayout {
  // 개발 빌드 캡처용 ?layout= (저장하지 않음, 배포 빌드에서는 항상 null)
  const dev = devLayoutOverride();
  if (dev) return dev;
  try { return localStorage.getItem(UI_LAYOUT_KEY) === 'classic' ? 'classic' : DEFAULT_UI_LAYOUT; }
  catch { return DEFAULT_UI_LAYOUT; }
}

export function applyUiLayout(layout: UiLayout = readUiLayout()) {
  try { document.documentElement.dataset.layout = layout; } catch { /* ignore */ }
}

export function useUiLayout() {
  const [layout, setLayoutState] = useState<UiLayout>(readUiLayout);
  useEffect(() => {
    const sync = () => setLayoutState(readUiLayout());
    window.addEventListener(UI_LAYOUT_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(UI_LAYOUT_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  useEffect(() => { applyUiLayout(layout); }, [layout]);
  const setLayout = useCallback((next: UiLayout) => {
    try { localStorage.setItem(UI_LAYOUT_KEY, next); } catch { /* 저장 실패해도 이번 실행엔 반영 */ }
    applyUiLayout(next);
    setLayoutState(next);
    window.dispatchEvent(new Event(UI_LAYOUT_EVENT));
  }, []);
  return { layout, setLayout, isO2: layout === 'o2' };
}
