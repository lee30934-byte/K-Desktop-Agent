import { VoiceCommandGate, type VoiceHandlers } from './voiceControl';

export interface VoiceTarget { id: string; title: string }
export interface VoiceRouting {
  conversations(): VoiceTarget[];
  selected(): string | null;
  changed?(target: VoiceTarget | null, following: boolean): void;
}

const normalize = (s: string) => s.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();

/** Resolves names locally. Neither the voice model nor its tool can supply UI IDs. */
export class VoiceRouter {
  private gates = new Map<string, VoiceCommandGate>();
  private seen = new Set<string>();
  private closed = false;
  private following = true;
  private targetId: string | null;
  private stoppedAt = 0;
  private watched = new Set<string>();
  private needsTarget = false;
  constructor(private sessionId: string, initial: string, private handlers: VoiceHandlers, private routing?: VoiceRouting) {
    this.targetId = initial;
    this.watched.add(initial);
  }
  get target() { return this.targets().find(t => t.id === this.targetId) ?? null; }
  get followsSelection() { return this.following; }
  get watchedTargets() { return this.targets().filter(t => this.watched.has(t.id)); }
  private targets(): VoiceTarget[] {
    return this.routing?.conversations() ?? [{ id: this.targetId ?? '', title: '현재 대화' }];
  }
  private labels() {
    const all = this.targets().slice().sort((a, b) => a.id.localeCompare(b.id));
    return all.map(t => {
      const same = all.filter(c => normalize(c.title) === normalize(t.title));
      return { ...t, label: same.length > 1 ? `${t.title} · ${same.findIndex(c => c.id === t.id) + 1}` : t.title };
    });
  }
  private changed() { this.routing?.changed?.(this.target, this.following); }
  /** Called once at speech onset, never when browsing changes mid-utterance. */
  beginUtterance() {
    if (this.closed || !this.following || !this.routing) return;
    this.targetId = this.routing.selected();
    this.changed();
  }
  select(id: string | null) {
    if (this.closed) throw Error('통화가 종료됐습니다.');
    if (id !== null && !this.targets().some(t => t.id === id)) throw Error('대화가 없어졌습니다. 다시 선택하세요.');
    this.following = id === null;
    this.needsTarget = false;
    this.targetId = id ?? this.routing?.selected() ?? null;
    this.changed();
    return { state: 'selected', target: this.target?.title ?? null, following: this.following };
  }
  async execute(callId: string, command: unknown): Promise<unknown> {
    if (this.closed) throw Error('통화가 종료되어 명령을 폐기했습니다.');
    if (!callId || callId.length > 200 || this.seen.has(callId)) return { state: 'unknown', detail: '이미 접수한 명령입니다. 재실행하지 마세요.' };
    if (this.seen.size >= 128) throw Error('통화 명령 한도입니다.');
    this.seen.add(callId);
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw Error('명령 형식 오류');
    const c = command as { action: string; text: string; target?: string };
    if (Object.keys(c).some(k => !['action', 'text', 'target'].includes(k)) || typeof c.text !== 'string' || c.text.length > 12000 ||
        (c.target !== undefined && (typeof c.target !== 'string' || !c.target.trim() || c.target.length > 300)) ||
        !['conversations', 'select', 'follow', 'status', 'send', 'steer', 'stop', 'stop_all'].includes(c.action)) throw Error('명령 내용 오류');
    if (c.target && ['conversations', 'select', 'follow', 'stop_all'].includes(c.action)) throw Error('이 동작에는 별도 target을 지정하지 않습니다.');
    if (c.action === 'conversations') {
      const matches = this.labels().filter(t => !c.text.trim() || normalize(t.title).includes(normalize(c.text)));
      return { state: 'choices', conversations: matches.slice(0, 8).map(t => t.label), total: matches.length,
        target: this.target?.title ?? null, following: this.following, detail: '대화 내용은 조회하지 않았습니다. 이름이 겹치면 구분 이름을 사용자에게 확인하세요.' };
    }
    if (c.action === 'follow') return this.select(null);
    let target = this.target;
    const query = c.target ?? (c.action === 'select' ? c.text : '');
    if (query) {
      const all = this.labels(), key = normalize(query);
      const exact = all.filter(t => normalize(t.label) === key || normalize(t.title) === key);
      const matches = exact.length ? exact : all.filter(t => normalize(t.title).includes(key));
      if (matches.length !== 1) { this.needsTarget = true; return { state: 'needs_target', candidates: matches.slice(0, 8).map(t => t.label),
        total: matches.length, detail: matches.length ? '대화 이름이 겹칩니다. 사용자에게 대상을 확인한 뒤 다시 요청하세요. 아직 실행하지 않았습니다.' : '일치하는 대화가 없습니다. 아직 실행하지 않았습니다.' }; }
      target = matches[0];
      this.select(target.id);
    }
    if (c.action === 'select') {
      if (!query) throw Error('전환할 대화 이름이 필요합니다.');
      return { state: 'selected', target: target?.title, following: false };
    }
    if (c.action === 'stop_all') {
      this.stoppedAt = Date.now();
      if (!this.handlers.stopAll) throw Error('전체 정지 사용 불가');
      await this.handlers.stopAll();
      return { state: 'stopped', detail: 'KDA 전체 정지 확인. 분리 실행 중인 프로세스는 별도 확인이 필요합니다.' };
    }
    if (this.needsTarget) throw Error('대상 확인이 필요합니다. 먼저 명령할 대화를 지정하세요.');
    if (!target) throw Error('명령 대상 대화를 선택하세요. 이전 대화로 대신 전달하지 않습니다.');
    if (['send', 'steer'].includes(c.action) && !c.text.trim()) throw Error('작업 지시가 비었습니다.');
    const id = target.id, title = target.title;
    let gate = this.gates.get(id);
    if (!gate) {
      gate = new VoiceCommandGate(this.sessionId, id, { ...this.handlers,
        canSend: r => this.targets().some(t => t.id === id) && r.createdAt > this.stoppedAt && this.handlers.canSend?.(r) !== false,
        status: key => { if (!this.targets().some(t => t.id === key)) throw Error('대화가 없어졌습니다.'); return this.handlers.status(key); },
        stop: key => { if (!this.targets().some(t => t.id === key)) throw Error('대화가 없어졌습니다.'); return this.handlers.stop(key); },
      });
      this.gates.set(id, gate);
    }
    this.watched.add(id);
    const result = await gate.execute(callId, { action: c.action, text: c.text });
    return { ...(result as object), target: title };
  }
  close() { this.closed = true; for (const gate of this.gates.values()) gate.close(); }
}
