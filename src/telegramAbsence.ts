/** Explicit, bounded notification subscription. Does not grant execution permissions. */
export interface AbsenceTarget { convId: string; label: string }
export interface AbsenceSession {
  chatId: string;
  startedAt: number;
  until: number;
  targets: AbsenceTarget[];
}
export const ABSENCE_MAX_HOURS = 48;
export const ABSENCE_DEFAULT_HOURS = 36;

/** Preserve all questions as text; a single numeric callback cannot identify multiple answers. */
export function formatRemoteQuestions(value: unknown): string | null {
  if (!Array.isArray(value) || !value.length) return null;
  const questions = value.filter(q => q && typeof q.question === 'string');
  if (!questions.length) return null;
  return '❓ 작업에서 답변을 요청했습니다.\n\n' + questions.map((q, i) => {
    const options = Array.isArray(q.options) ? q.options.filter((o: any) => o && typeof o.label === 'string') : [];
    return `[질문 ${i + 1}] ${q.question}\n` + options.map((o: any, n: number) =>
      `${n + 1}. ${o.label}${typeof o.description === 'string' ? ` — ${o.description}` : ''}`).join('\n');
  }).join('\n\n') + '\n\n이 메시지에 답장해 주세요. 여러 질문이면 질문별 답을 함께 적어 주세요. 응답 없이 기본값을 선택하지 않습니다.';
}

export function restoreAbsence(value: unknown, now: number): AbsenceSession | null {
  if (!value || typeof value !== 'object') return null;
  const x = value as AbsenceSession;
  if (typeof x.chatId !== 'string' || !/^-?\d+$/.test(x.chatId) ||
      !Number.isFinite(x.startedAt) || !Number.isFinite(x.until) ||
      x.startedAt > now || x.until <= now || x.until <= x.startedAt ||
      x.until - x.startedAt > ABSENCE_MAX_HOURS * 3600000 || !Array.isArray(x.targets)) return null;
  const seen = new Set<string>();
  const targets = x.targets.filter(t => {
    if (!t || typeof t.convId !== 'string' || !t.convId ||
        typeof t.label !== 'string' || seen.has(t.convId)) return false;
    seen.add(t.convId); return true;
  }).slice(0, 200).map(t => ({ convId: t.convId, label: t.label.slice(0, 100) }));
  return { chatId: x.chatId, startedAt: x.startedAt, until: x.until, targets };
}

export function absenceChat(session: AbsenceSession | null, convId: string | undefined, now: number): string | undefined {
  return session && convId && now >= session.startedAt && now < session.until &&
    session.targets.some(t => t.convId === convId) ? session.chatId : undefined;
}

export function absenceInstruction(session: AbsenceSession | null, convId: string | undefined, now: number): string {
  if (!absenceChat(session, convId, now)) return '';
  return '[부재 운영 지시]\nK가 이미 승인한 이 대화의 작업만 끝까지 이어서 진행한다. 추천안이 분명한 기본값·세부 설계·순서는 스스로 정한다. '
    + '이미 승인된 정확한 대상·행동은 다시 묻지 않는다. 새로운 삭제·덮어쓰기 등 파괴 작업, 외부 공개·태그 push·배포, 결제·권한 확대, 사람 눈 검증, 실제 모순·필수정보 부족은 자동 승인하지 않는다. '
    + 'K의 결정이 필요하면 이 대화의 최종 답변에 정확한 대상·행동·이유와 번호 선택지를 적어 텔레그램 전달을 기다린다. 미응답은 승인으로 해석하지 않는다. '
    + '기존 프로젝트의 승인·품질·보존 규칙과 보류 상태를 유지한다. 관련 없는 새 작업을 시작하지 않는다.';
}
