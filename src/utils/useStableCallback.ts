import { useCallback, useRef } from "react";

/**
 * 매 렌더 새로 생성되는 함수를 "안정된 ref" 로 감싼다.
 * 결과 콜백은 빈 deps 의 useCallback 이므로 reference 가 평생 동일.
 * 내부에서 호출 시점에 ref 의 최신 함수를 invoke 하므로 stale closure 도 없음.
 *
 * 용도: 자식 컴포넌트(memo)에 핸들러를 prop 으로 내릴 때, App 의 state 변경
 * 마다 핸들러 ref 가 바뀌어 자식 memo 가 무효화되는 문제를 막는다.
 *
 * 주의: 콜백 자체는 안정이지만 호출 시 ref 가 최신값을 읽으므로,
 * 자식이 "deps 로 받아 effect 트리거" 하는 패턴엔 부적합 (effect 가 안 다시 뜸).
 * 일반적인 onClick / onChange 핸들러용.
 */
export function useStableCallback<T extends (...args: any[]) => any>(fn: T): T {
  const ref = useRef(fn);
  ref.current = fn;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback(((...args: any[]) => ref.current(...args)) as T, []);
}
