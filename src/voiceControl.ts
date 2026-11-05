import { DotDispatcher, type DotHandlers } from './dotBridge';

export { VOICE_TOOL, VOICE_INSTRUCTIONS } from '../sidecar/src/voice-contract.mjs';

export interface VoiceHandlers extends DotHandlers { stopAll?(): Promise<void> }
export interface VoiceCommand { action: string; text: string }

/** Final, explicit control utterances only; ordinary/generated text cannot start work. */
export function explicitVoiceControl(text: string): 'stop' | 'stop_all' | 'silence' | null {
  const value = text.replace(/[\s.,!?。，！？]/g, '');
  const verb = '(?:멈춰(?:줘|주세요)?|멈추어줘|중지(?:해|해줘|해주세요)?|정지(?:해|해줘|해주세요)?|중단(?:해|해줘|해주세요)?)';
  if (new RegExp(`^(?:말|말하기|음성|음성출력)(?:은|는|을|만)?(?:그만(?:해|해줘|해주세요)?|${verb})$`).test(value)) return 'silence';
  if (new RegExp(`^(?:모든|전체|전부|모두)(?:작업|실행|일)?(?:을|를|은|는)?${verb}$`).test(value)) return 'stop_all';
  if (new RegExp(`^(?:(?:이|현재)대화(?:의|에서))?(?:(?:현재|지금|진행중인|하고있는|하던|하는))?(?:작업|실행|일)(?:을|를|은|는)?${verb}$`).test(value)) return 'stop';
  return null;
}

/** One claim per provider call ID; never replay after timeout/disconnect. */
export class VoiceCommandGate {
  private seen = new Set<string>();
  private active = true;
  private dispatcher: DotDispatcher;
  private stoppedAt = 0;
  constructor(readonly sessionId: string, readonly conversationId: string, private handlers: VoiceHandlers) {
    this.dispatcher = new DotDispatcher({ ...handlers,
      canSend: r => r.createdAt > this.stoppedAt && handlers.canSend?.(r) !== false,
    }, async r => this.active && r.session === sessionId && r.conversationId === conversationId);
  }
  close() { this.active = false; }
  async execute(callId: string, command: unknown): Promise<unknown> {
    if (!this.active) throw Error('통화가 종료되어 명령을 폐기했습니다.');
    if (!callId || callId.length > 200 || this.seen.has(callId)) return { state: 'unknown', detail: '이미 접수된 명령입니다. 재실행하지 말고 status로 확인하세요.' };
    if (this.seen.size >= 128) throw Error('통화 명령 한도입니다. 통화를 다시 연결하세요.');
    this.seen.add(callId);
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw Error('명령 형식 오류');
    const c = command as VoiceCommand;
    if (!['status', 'send', 'steer', 'stop', 'stop_all'].includes(c.action) || typeof c.text !== 'string' || c.text.length > 12000 ||
        Object.keys(c).some(k => k !== 'action' && k !== 'text') || (['send', 'steer'].includes(c.action) && !c.text.trim())) throw Error('명령 내용 오류');
    if (c.action === 'stop_all') {
      this.stoppedAt = Date.now();
      if (!this.handlers.stopAll) throw Error('전체 정지를 사용할 수 없습니다.');
      await this.handlers.stopAll();
      return { state: 'stopped', detail: 'KDA 전체 정지 처리 확인. 분리 실행 중인 프로세스는 별도 확인이 필요합니다.' };
    }
    return this.dispatcher.dispatch({ id: callId, session: this.sessionId, conversationId: this.conversationId,
      createdAt: Date.now(), action: c.action === 'steer' ? 'send' : c.action as 'status' | 'send' | 'stop',
      text: c.text, mode: c.action === 'steer' ? 'steer' : 'queue' });
  }
}

export function voiceFeedback(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/https?:\/\/\S+/g, '')
    .replace(/(?:[A-Za-z]:[\\/]|\/home\/|\\\\)\S+/g, '파일')
    .replace(/\b(?:sk-|ghp_|github_pat_|Bearer\s+)\S+/gi, '[비공개]')
    .replace(/[^\n]*(?:api.?key|password|secret|token|비밀번호|인증키)[^\n]*/gi, '[비공개 항목]')
    .replace(/[*#`<>]/g, '').trim().slice(0, 140);
}
