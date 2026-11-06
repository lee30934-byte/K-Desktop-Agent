import type { VoiceEvent, VoiceTransport } from '../voiceSession';

export class MobileApi {
  private token = sessionStorage.getItem('kda_mobile_session') ?? '';
  private handlers = new Set<(event: VoiceEvent) => void>();
  private cursor = 0;
  private polling?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private stopped = false;
  onExpired: () => void = () => {};
  get paired() { return !!this.token; }
  private async post(path: string, body: unknown) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 40_000);
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) }, body: JSON.stringify(body), signal: controller.signal,
        cache: 'no-store', credentials: 'omit', redirect: 'error' });
      if (!response.headers.get('content-type')?.includes('application/json')) throw Error('PC 연결 상태를 확인하지 못했습니다. PC의 KDA와 개인 HTTPS 연결을 확인하세요.');
      const value = await response.json();
      if (!response.ok) {
        if (response.status === 401 && path !== '/api/pair') { this.clear(); this.onExpired(); }
        throw Error(value.error || 'PC 연결 실패');
      }
      return value;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw Error('PC 응답 시간 초과. 실행 여부를 상태에서 확인하세요. 자동 재전송하지 않습니다.');
      if (error instanceof TypeError) throw Error('PC에 연결할 수 없습니다. PC의 KDA와 개인 HTTPS 연결을 확인하세요.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  async pair(code: string) {
    const { token } = await this.post('/api/pair', { code });
    this.token = token; this.stopped = false; this.cursor = 0; sessionStorage.setItem('kda_mobile_session', token);
  }
  rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return this.post('/api/rpc', { id: crypto.randomUUID(), method, params }).then(v => v.result);
  }
  private clear() {
    this.token = ''; this.stopped = true; this.generation++; clearTimeout(this.polling); sessionStorage.removeItem('kda_mobile_session');
  }
  async disconnect() { try { await this.post('/api/disconnect', {}); } finally { this.clear(); } }
  private async poll(generation: number) {
    if (this.stopped || !this.token || !this.handlers.size || generation !== this.generation) return;
    try {
      const value = await this.post('/api/events', { after: this.cursor });
      if (this.stopped || generation !== this.generation) return;
      this.cursor = value.cursor;
      for (const entry of value.events) for (const handler of this.handlers) handler(entry.event);
    } catch (error) {
      if (generation === this.generation) for (const handler of this.handlers) handler({ sessionId: this.sessionId, kind: 'error', message: String(error) });
      return; // Never resume a failed voice stream automatically.
    }
    this.polling = setTimeout(() => void this.poll(generation), 450);
  }
  private sessionId = '';
  readonly transport: VoiceTransport = {
    listen: async handler => {
      const first = !this.handlers.size; this.handlers.add(handler);
      if (first) { this.stopped = false; void this.poll(++this.generation); }
      return () => { this.handlers.delete(handler); if (!this.handlers.size) { this.generation++; clearTimeout(this.polling); } };
    },
    start: async (sessionId, conversationId, sdp, options) => {
      this.sessionId = sessionId;
      await this.rpc('voice', { action: 'start', sessionId, conversationId, sdp, ...options });
    },
    stop: async sessionId => { await this.rpc('voice', { action: 'stop', sessionId }); },
    reply: async (sessionId, token, result) => { await this.rpc('voice', { action: 'reply', sessionId, token, result }); },
    speak: async (sessionId, text) => { await this.rpc('voice', { action: 'speak', sessionId, text }); },
    extend: async (sessionId, token) => { await this.rpc('voice', { action: 'extend', sessionId, token }); },
  };
}
