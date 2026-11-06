import { VoiceCommandGate, voiceFeedback, explicitVoiceControl, type VoiceHandlers } from './voiceControl';

export type VoicePhase = 'idle' | 'connecting' | 'connected' | 'error' | 'ended';
export interface VoiceView {
  phase: VoicePhase; message: string; muted: boolean; speaking: boolean;
  conversationId: string; lines: { role: string; text: string }[];
}
export interface VoiceEvent { sessionId: string; kind: 'sdp' | 'error' | 'command'; sdp?: string; message?: string; token?: string; command?: unknown; createdAt?: number }
export interface VoiceTransport {
  listen(handler: (event: VoiceEvent) => void): Promise<() => void>;
  start(sessionId: string, conversationId: string, sdp: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  reply(sessionId: string, token: string, result: unknown): Promise<void>;
  speak(sessionId: string, text: string): Promise<void>;
}
let activeVoiceId: string | null = null;
export function isVoiceCallActive() { return activeVoiceId !== null; }

export function voiceStartError(error: unknown, stage: 'microphone' | 'speaker' | 'connection', selectedDevice = false) {
  const detail = error instanceof Error ? error.message : String(error);
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  if (stage === 'connection') return detail;
  if (stage === 'speaker') {
    if (name === 'NotFoundError') return '선택한 스피커를 찾지 못했습니다. 스피커를 연결한 뒤 장치를 새로고침하고 다시 선택하세요.';
    if (name === 'NotAllowedError') return '선택한 스피커 사용이 차단됐습니다. 출력 장치 권한을 확인하거나 시스템 기본을 선택하세요.';
    return `스피커 연결 실패: ${detail}`;
  }
  if (name === 'NotFoundError') return selectedDevice
    ? '선택한 마이크를 찾지 못했습니다. 마이크를 연결한 뒤 장치를 새로고침하고 다시 선택하세요.'
    : '사용 가능한 기본 마이크를 찾지 못했습니다. Windows 설정 → 시스템 → 소리 → 입력을 확인하세요. 원격 데스크톱 사용 중이면 접속 PC의 원격 오디오 설정에서 이 컴퓨터에서 녹음을 켠 뒤 다시 접속하세요.';
  if (name === 'NotAllowedError' || name === 'SecurityError') return '마이크 사용이 차단됐습니다. Windows 설정 → 개인정보 및 보안 → 마이크에서 마이크 액세스와 데스크톱 앱 액세스를 확인하세요.';
  if (name === 'NotReadableError' || name === 'AbortError') return '마이크를 열지 못했습니다. 다른 앱의 마이크 사용과 장치 연결 상태를 확인한 뒤 다시 연결하세요.';
  if (name === 'OverconstrainedError') return '선택한 마이크 또는 오디오 조건을 사용할 수 없습니다. 장치를 새로고침하고 사용 가능한 마이크를 다시 선택하세요.';
  return `마이크 연결 실패: ${detail}`;
}

/** Media lives only between an explicit start and close; tab changes never retarget work. */
export class VoiceSession {
  readonly id = crypto.randomUUID();
  private gate: VoiceCommandGate;
  private closed = false;
  private starting = false;
  private configured = false;
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private stream?: MediaStream;
  private audio?: HTMLAudioElement;
  private unlisten?: () => void;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private poll?: ReturnType<typeof setInterval>;
  private polling = false;
  private responseActive = false;
  private userSpeaking = false;
  private suppressed = false;
  private lastStatus?: string;
  private lastAnswer?: string;
  private pendingFeedback = '';
  private completedCalls = new Set<string>();
  private audioContext?: AudioContext;
  private vad?: ReturnType<typeof setInterval>;
  private silenceUntilUser = false;
  private lastControl: ReturnType<typeof explicitVoiceControl> = null;
  private lastUserText = '';
  private localStop?: { action: 'stop' | 'stop_all'; result: Promise<unknown> };
  private finalTurns = new Set<string>();
  private state: VoiceView;
  constructor(readonly conversationId: string, private handlers: VoiceHandlers, private transport: VoiceTransport,
    private update: (view: VoiceView) => void) {
    this.gate = new VoiceCommandGate(this.id, conversationId, handlers);
    this.state = { phase: 'idle', message: '', muted: false, speaking: false, conversationId, lines: [] };
  }
  private view(patch: Partial<VoiceView>) { this.state = { ...this.state, ...patch }; this.update(this.state); }
  private line(role: string, text: string) {
    if (text.trim()) this.view({ lines: [...this.state.lines, { role, text: text.slice(0, 2000) }].slice(-12) });
  }
  async start(inputDeviceId = '', outputDeviceId = '') {
    if (this.closed || this.starting) return;
    this.starting = true;
    if (activeVoiceId && activeVoiceId !== this.id) { this.fail('이미 음성통화가 열려 있습니다. 기존 통화를 종료하세요.'); return; }
    activeVoiceId = this.id;
    this.view({ phase: 'connecting', message: '마이크 권한·Codex 구독 음성 연결 확인 중…' });
    this.timers.push(setTimeout(() => this.fail('음성 연결 시간이 초과됐습니다. 마이크 권한·로그인·네트워크를 확인하세요.'), 60_000));
    let stage: 'microphone' | 'speaker' | 'connection' = 'microphone';
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') throw Error('이 환경에서 마이크·WebRTC를 사용할 수 없습니다.');
      const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}),
      } });
      if (this.closed) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream;
      stage = 'connection';
      // Thread restrictions/dynamic tool are installed before SDP; session.started
      // and the actual media connection must both succeed before transmission.
      stream.getAudioTracks().forEach(t => { t.enabled = false; t.onended = () => this.fail('마이크 연결이 해제됐습니다.'); });
      const off = await this.transport.listen(event => {
        if (this.closed || event.sessionId !== this.id) return;
        if (event.kind === 'error') this.fail(event.message || 'Codex 음성 연결 실패');
        else if (event.kind === 'sdp' && event.sdp) void this.acceptSdp(event.sdp);
        else if (event.kind === 'command') void this.command(event);
      });
      if (this.closed) { off(); return; }
      this.unlisten = off;
      const peer = this.peer = new RTCPeerConnection();
      const audio = this.audio = new Audio(); audio.autoplay = true;
      if (outputDeviceId) {
        stage = 'speaker';
        const sink = audio as HTMLAudioElement & { setSinkId?(id: string): Promise<void> };
        if (!sink.setSinkId) throw Error('이 환경은 출력 장치 선택을 지원하지 않습니다. 기본 장치를 선택하세요.');
        await sink.setSinkId(outputDeviceId);
        stage = 'connection';
      }
      if (this.closed) return;
      peer.ontrack = event => {
        if (this.closed) return;
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio.play().catch(() => this.fail('음성 재생이 차단됐습니다. 출력 장치와 앱 재생 권한을 확인하세요.'));
      };
      peer.onconnectionstatechange = () => {
        if (this.closed) return;
        if (peer.connectionState === 'connected') this.checkConnected();
        else if (['failed', 'closed', 'disconnected'].includes(peer.connectionState)) this.fail('음성 네트워크 연결이 끊겼습니다. 자동 재접수하지 않습니다.');
      };
      for (const track of stream.getTracks()) peer.addTrack(track, stream);
      const dc = this.channel = peer.createDataChannel('oai-events');
      dc.onopen = () => this.checkConnected();
      dc.onmessage = event => {
        if (this.closed) return;
        try { this.receive(JSON.parse(String(event.data))); } catch { this.fail('음성 이벤트 처리 실패'); }
      };
      dc.onerror = () => this.fail('음성 데이터 채널 오류');
      dc.onclose = () => { if (!this.closed) this.fail('음성 데이터 채널이 종료됐습니다.'); };
      await peer.setLocalDescription(await peer.createOffer());
      await this.waitIce(peer);
      if (this.closed) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw Error('음성 연결 SDP를 만들지 못했습니다.');
      await this.transport.start(this.id, this.conversationId, sdp);
    } catch (error) { if (!this.closed) this.fail(voiceStartError(error, stage, !!inputDeviceId)); }
  }
  private async waitIce(peer: RTCPeerConnection) {
    if (peer.iceGatheringState === 'complete') return;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', check); resolve(); };
      const check = () => { if (peer.iceGatheringState === 'complete') done(); };
      const timer = setTimeout(done, 5000);
      peer.addEventListener('icegatheringstatechange', check);
    });
  }
  private async acceptSdp(sdp: string) {
    try { if (!this.closed && this.peer && !this.peer.remoteDescription) await this.peer.setRemoteDescription({ type: 'answer', sdp }); }
    catch { this.fail('Codex 음성 연결 응답을 적용하지 못했습니다.'); }
  }
  private checkConnected() {
    if (this.closed || !this.configured || this.peer?.connectionState !== 'connected' || this.channel?.readyState !== 'open' || this.state.phase === 'connected') return;
    this.timers.forEach(clearTimeout); this.timers = [];
    this.stream?.getAudioTracks().forEach(t => { t.enabled = !this.state.muted; });
    this.startVad();
    this.view({ phase: 'connected', message: '통화 중 · 대상 대화 고정 · 작업 승인은 KDA 화면에서 확인' });
    this.timers.push(setTimeout(() => this.end(), 5 * 60_000));
    void this.pollStatus();
    this.poll = setInterval(() => void this.pollStatus(), 3000);
  }
  receive(event: Record<string, any>) {
    if (this.closed) return;
    if (event.type === 'session.started') {
      this.configured = true; this.checkConnected(); return;
    }
    if (event.type === 'error') { this.fail('Codex 음성 채널 요청 실패. 계정·현재 음성 지원을 확인하세요.'); return; }
    if (!this.configured) return;
    if (event.type === 'input_transcript.added') {
      this.bargeIn();
    } else if (event.type === 'output_transcript.added') {
      this.responseActive = true;
      if (!this.userSpeaking && !this.silenceUntilUser) { this.suppressed = false; if (this.audio) this.audio.muted = false; }
      this.view({ speaking: !this.suppressed });
    } else if (event.type === 'turn.done') {
      const turn = event.turn;
      if (turn?.role === 'user') {
        this.userSpeaking = false;
        const key = typeof turn.id === 'string' ? turn.id : String(event.event_id ?? '');
        const fresh = !key || !this.finalTurns.has(key);
        if (key && this.finalTurns.size < 128) this.finalTurns.add(key);
        if (fresh) {
          this.lastUserText = String(turn.transcript ?? '');
          this.lastControl = explicitVoiceControl(this.lastUserText);
          if (this.lastControl === 'silence') this.silence();
          else if (this.lastControl === 'stop' || this.lastControl === 'stop_all') {
            const action = this.lastControl;
            this.localStop = { action, result: this.control(action, true) };
          } else this.localStop = undefined;
        }
      }
      else if (turn?.role === 'assistant') { this.responseActive = false; this.view({ speaking: false }); this.flushFeedback(); }
      if (['user', 'assistant'].includes(turn?.role)) this.line(turn.role, String(turn.transcript ?? ''));
    }
  }
  private bargeIn() {
    this.userSpeaking = true; this.suppressed = true; this.silenceUntilUser = false;
    if (this.audio) this.audio.muted = true;
    this.view({ speaking: false });
  }
  private startVad() {
    if (!this.stream) return;
    try {
      const ctx = this.audioContext = new AudioContext();
      const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
      ctx.createMediaStreamSource(this.stream).connect(analyser);
      void ctx.resume().catch(() => {});
      const buffer = new Float32Array(analyser.fftSize);
      let first = 0, last = 0;
      this.vad = setInterval(() => {
        if (this.closed || this.state.muted) return;
        analyser.getFloatTimeDomainData(buffer);
        const rms = Math.sqrt(buffer.reduce((sum, v) => sum + v * v, 0) / buffer.length);
        const now = performance.now();
        if (rms > 0.025) { if (!first) first = now; last = now; if (now - first >= 80 && !this.userSpeaking) this.bargeIn(); }
        else { first = 0; if (this.userSpeaking && now - last > 650) this.userSpeaking = false; }
      }, 30);
    } catch { /* Server speech/transcript events still provide interruption. Local latency stays unverified. */ }
  }
  private async command(event: VoiceEvent) {
    const callId = event.token;
    if (typeof callId !== 'string' || !callId || callId.length > 200) { this.fail('음성 도구 식별자 오류'); return; }
    if (this.completedCalls.has(callId)) return;
    if (this.completedCalls.size >= 128) { this.fail('음성 명령 한도입니다. 통화를 다시 연결하세요.'); return; }
    this.completedCalls.add(callId);
    let result: unknown;
    try {
      if (this.state.phase !== 'connected' || !event.createdAt || Date.now() - event.createdAt > 15_000 || event.createdAt > Date.now() + 2000) throw Error('통화 명령이 만료됐거나 연결이 종료됐습니다.');
      const action = (event.command as any)?.action;
      if (action === 'stop_all' && !/(?:전체|모든|모두|전부)/.test(this.lastUserText)) throw Error('사용자가 전체 작업 정지를 요청한 발화가 아닙니다.');
      if (this.lastControl === 'silence' && action !== 'status') throw Error('말하기만 중지한 발화입니다. 작업을 변경하지 않습니다.');
      if (this.lastControl && ['stop', 'stop_all'].includes(this.lastControl) && ['send', 'steer'].includes(action)) throw Error('작업 정지 이후의 새 지시가 없어 실행하지 않습니다.');
      const localStop = this.localStop;
      if (localStop && localStop.action === action) {
        const local = await localStop.result;
        const status = await this.handlers.status(this.conversationId) as any;
        result = !status.run && status.paused ? local : await this.gate.execute(callId, event.command);
      } else result = await this.gate.execute(callId, event.command);
      // Do not send private tool dumps or code to the voice backend.
      const s = result as any;
      if (s?.latestAssistant?.text) result = { ...s, latestAssistant: { ...s.latestAssistant, text: voiceFeedback(s.latestAssistant.text) } };
    } catch (e) { result = { state: 'error', detail: String(e) }; }
    if (this.closed) return;
    try {
      await this.transport.reply(this.id, callId, result);
    } catch (e) { this.fail(String(e)); }
  }
  setMuted(muted: boolean) {
    this.stream?.getAudioTracks().forEach(t => { t.enabled = this.configured && !muted && !this.closed; });
    this.view({ muted });
  }
  silence() {
    if (this.closed) return;
    this.suppressed = true; this.pendingFeedback = '';
    this.silenceUntilUser = true;
    if (this.audio) this.audio.muted = true;
    this.view({ speaking: false });
    // Local output is silenced immediately. Work and its approvals continue.
  }
  async control(action: 'status' | 'stop' | 'stop_all', announce = false): Promise<unknown> {
    if (this.closed || !this.configured) return;
    try {
      const result = await this.gate.execute(crypto.randomUUID(), { action, text: '' });
      if (this.closed) return result;
      const status = result as any;
      this.line('system', action === 'status'
        ? `현재 작업: ${status.run ? '진행 중' : '실행 중인 작업 없음'} · 대기 ${status.queued ?? 0}건${status.approvalPending ? ' · 사용자 승인 필요' : ''}`
        : status.state === 'stopped' ? `${action === 'stop_all' ? '전체 작업' : '현재 대화의 작업'} 정지 확인. 별도로 실행 중인 작업은 확인이 필요합니다.`
        : '정지 상태를 확인하지 못했습니다. 작업 패널을 확인하세요.');
      if (announce && (result as any)?.state === 'stopped') {
        try { await this.transport.speak(this.id,
          action === 'stop_all' ? 'KDA 확인: 전체 작업 정지를 처리했습니다. 분리 실행 중인 프로세스는 별도 확인이 필요합니다.' : 'KDA 확인: 현재 대화의 작업을 정지했습니다. 분리 실행 중인 프로세스는 별도 확인이 필요합니다.'); }
        catch { if (!this.closed) this.line('system', '작업 정지는 확인됐으나 음성 안내를 전달하지 못했습니다.'); }
      }
      return result;
    } catch (e) { this.line('system', String(e)); return { state: 'error', detail: String(e) }; }
  }
  private async pollStatus() {
    if (this.closed || this.polling || this.state.phase !== 'connected') return;
    this.polling = true;
    try {
      const s = await this.handlers.status(this.conversationId) as any;
      if (this.closed) return;
      const status = JSON.stringify({ run: s.run?.state ?? null, paused: s.paused, queued: s.queued, approvalPending: !!s.approvalPending });
      const answer = s.latestAssistant;
      if (this.lastStatus === undefined) this.lastAnswer = answer?.streaming ? '' : answer?.id ?? '';
      if (this.lastStatus !== undefined && status !== this.lastStatus) {
        this.pendingFeedback = s.approvalPending ? 'KDA 확인: 사용자 승인을 기다립니다. 해당 대화 화면에서 검토해 주세요.' : s.run ? `KDA 확인: 작업 상태 ${s.run.state}. 대기 ${s.queued ?? 0}건.` :
          s.paused ? 'KDA 확인: 작업이 보류되어 있습니다. 화면을 확인하세요.' : 'KDA 확인: 실행 중인 턴이 없습니다. 최신 결과는 화면에서 확인하세요.';
      }
      if (!s.approvalPending && this.lastAnswer !== undefined && answer?.id && !answer.streaming && answer.id !== this.lastAnswer) {
        this.pendingFeedback = `KDA의 새 답변: ${voiceFeedback(String(answer.text ?? '화면에서 확인하세요.'))}`;
      }
      this.lastStatus = status;
      // Streaming answer must not consume its final notification.
      if (!answer?.streaming) this.lastAnswer = answer?.id ?? '';
      this.flushFeedback();
    } catch { /* No synthetic success or speculative progress on failed status reads. */ }
    finally { this.polling = false; }
  }
  private flushFeedback() {
    if (!this.pendingFeedback || this.responseActive || this.userSpeaking || this.silenceUntilUser || this.closed || this.state.phase !== 'connected') return;
    const text = this.pendingFeedback; this.pendingFeedback = '';
    try {
      void this.transport.speak(this.id, text).catch(() => { if (!this.closed) this.line('system', '진행 음성 전달 실패. 실제 상태는 작업 패널에서 확인하세요.'); });
    } catch (e) { this.fail(String(e)); }
  }
  private fail(message: string) { if (!this.closed) { this.view({ phase: 'error', message, speaking: false }); this.release(); } }
  end() { if (!this.closed) { this.view({ phase: 'ended', message: '통화 종료 · 진행 중인 작업은 작업 패널에서 확인하세요.', speaking: false }); this.release(); } }
  private release() {
    this.closed = true; this.gate.close();
    if (activeVoiceId === this.id) activeVoiceId = null;
    this.timers.forEach(clearTimeout); this.timers = [];
    if (this.poll) clearInterval(this.poll);
    if (this.vad) clearInterval(this.vad);
    void this.audioContext?.close().catch(() => {});
    this.stream?.getTracks().forEach(t => { t.onended = null; t.stop(); });
    this.channel?.close(); this.peer?.close();
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; }
    this.unlisten?.(); this.unlisten = undefined;
    void this.transport.stop(this.id).catch(() => {});
  }
}
