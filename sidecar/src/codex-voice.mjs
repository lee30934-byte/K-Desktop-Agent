import { codexAppServerArgs } from './codex-features.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import treeKill from 'tree-kill';
import { randomUUID } from 'node:crypto';
import { VOICE_TOOL, VOICE_INSTRUCTIONS } from './voice-contract.mjs';

export const VOICE_SAMPLE = '안녕하세요, K님. 저는 곁에서 함께하는 K 비서예요. 이 목소리로 이야기할게요.';
export function voiceCatalog(result) {
  const voices = result?.voices?.v3;
  if (!Array.isArray(voices) || !voices.length || voices.some(v => typeof v !== 'string' || !/^[a-z]{2,24}$/.test(v)))
    throw Error('현재 엔진의 음성 목록을 확인하지 못했습니다. 목록을 새로고침하세요.');
  return [...new Set(voices)];
}

export function voiceError(value) {
  return String(value ?? 'unknown').replace(/https?:\/\/\S+/g, '[endpoint]')
    .replace(/(?:Bearer\s+|sk-|ghp_|github_pat_)[\w.\/-]+/gi, '[redacted]')
    .replace(/[\w-]{32,}/g, '[id]').replace(/[\r\n]+/g, ' ').slice(0, 500);
}

// Separate process/thread lifetime from work turns. No credentials leave Codex.
export class CodexVoiceSession {
  calls = new Map(); pending = new Map(); claimed = new Set(); nextId = 1; closed = false; threadId = null;
  constructor(codex, emit, spawnProcess = spawn) {
    this.emit = emit;
    this.cwd = mkdtempSync(join(tmpdir(), 'kda-voice-'));
    // v0.7.86 — 음성 세션도 KDA 도구와 겹치는 Codex 내장 기능을 끄고 시작 (codex-features.mjs).
    this.process = spawnProcess(codex, codexAppServerArgs(), {
      cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32', windowsHide: true,
    });
    this.process.on('error', () => this.fail('Codex 음성 프로세스를 시작하지 못했습니다. CLI 설치·로그인을 확인하세요.'));
    this.process.on('close', () => { if (!this.closed) this.fail('Codex 음성 연결이 종료됐습니다. 명령을 자동 재전송하지 않습니다.'); });
    // Provider stderr may contain credentials/SDP. Never relay or persist it.
    this.process.stderr.on('data', () => {});
    this.reader = readline.createInterface({ input: this.process.stdout, crlfDelay: Infinity });
    this.reader.on('line', line => {
      try { this.receive(JSON.parse(line)); } catch { this.fail('Codex 음성 프로토콜을 처리하지 못했습니다.'); }
    });
  }
  send(value) {
    if (this.closed || !this.process.stdin.writable) throw Error('음성 세션이 종료됐습니다.');
    this.process.stdin.write(JSON.stringify(value) + '\n');
  }
  request(method, params, timeout = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(id); reject(Error(`${method} 응답 시간 초과`)); }, timeout);
      this.calls.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (e) { clearTimeout(timer); this.calls.delete(id); reject(e); }
    });
  }
  receive(message) {
    if (this.closed) return;
    if ('id' in message && !message.method) {
      const call = this.calls.get(message.id);
      if (!call) return;
      clearTimeout(call.timer); this.calls.delete(message.id);
      // Only error code is exported; raw provider error can contain request data.
      if (message.error) call.reject(Error(`Codex 음성 요청 실패 (${message.error.code ?? 'provider'}): ${voiceError(message.error.message)}`));
      else call.resolve(message.result);
      return;
    }
    if ('id' in message) {
      const p = message.params ?? {};
      if (!this.preview && message.method === 'item/tool/call' && p.threadId === this.threadId && p.tool === VOICE_TOOL.name &&
          !p.namespace && typeof p.callId === 'string' && typeof p.turnId === 'string' && p.arguments && typeof p.arguments === 'object') {
        if (JSON.stringify(p.arguments).length > 14000) { this.fail('음성 명령 크기 한도를 초과했습니다.'); return; }
        if (this.claimed.has(p.callId)) return;
        if (this.claimed.size >= 128 || this.pending.size >= 8) { this.fail('음성 명령 한도를 초과했습니다.'); return; }
        this.claimed.add(p.callId);
        const token = randomUUID(), createdAt = Date.now();
        const timer = setTimeout(() => this.reply(token, { state: 'unknown', detail: '명령 전달 응답 시간 초과. 재실행하지 말고 작업 상태를 조회하세요.' }), 15_000);
        this.pending.set(token, { rpcId: message.id, timer });
        this.emit({ kind: 'command', token, command: p.arguments, createdAt });
        return;
      }
      // No approvals or execution belong to this transport process.
      this.fail('음성 연결에서 직접 도구 실행을 요청해 연결을 중단했습니다. 작업은 KDA에서만 실행됩니다.');
      return;
    }
    const p = message.params ?? {};
    if (this.threadId && p.threadId !== this.threadId) return;
    if (message.method === 'item/started' && !['userMessage', 'reasoning', 'agentMessage', 'dynamicToolCall', 'contextCompaction', 'plan'].includes(p.item?.type)) {
      this.fail('음성 중계기가 직접 작업을 시도해 차단했습니다. KDA 작업 패널을 확인하세요.');
    } else if (message.method === 'thread/realtime/sdp' && typeof p.sdp === 'string') {
      this.emit({ kind: 'sdp', sdp: p.sdp });
    } else if (message.method === 'thread/realtime/error') {
      this.fail(`Codex 구독 음성 연결 실패: ${voiceError(p.message)}`);
    } else if (message.method === 'thread/realtime/closed') {
      this.fail('음성 연결이 종료됐습니다. 진행 중인 KDA 작업은 작업 패널에서 확인하세요.');
    }
  }
  reply(token, result) {
    const p = this.pending.get(token);
    if (!p || this.closed) return;
    this.pending.delete(token); clearTimeout(p.timer);
    const text = JSON.stringify(result);
    this.send({ id: p.rpcId, result: { success: result?.state !== 'error', contentItems: [{ type: 'inputText', text: text.slice(0, 16000) }] } });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'kda_voice', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
  }
  async listVoices() {
    await this.initialize();
    return voiceCatalog(await this.request('thread/realtime/listVoices', {}));
  }
  async start(sdp, voiceSessionId, options = {}) {
    this.preview = options.preview === true;
    await this.initialize();
    if (options.voice) {
      const available = voiceCatalog(await this.request('thread/realtime/listVoices', {}));
      if (!available.includes(options.voice)) throw Error('선택한 목소리를 현재 엔진에서 사용할 수 없습니다. 다른 목소리를 선택하세요.');
    }
    // Disable inherited MCP servers for this isolated transport thread only.
    const config = await this.request('config/read', { includeLayers: false });
    const overrides = {};
    for (const name of Object.keys(config?.config?.mcp_servers ?? {})) overrides[`mcp_servers.${name}.enabled`] = false;
    overrides['features.shell_tool'] = false;
    overrides['features.apply_patch_freeform'] = false;
    overrides['features.multi_agent'] = false;
    overrides['features.js_repl'] = false;
    overrides['features.code_mode'] = false;
    overrides['features.apps'] = false;
    overrides['features.plugins'] = false;
    overrides['features.image_generation'] = false;
    overrides['web_search'] = 'disabled';
    const thread = await this.request('thread/start', { cwd: this.cwd, ephemeral: true,
      approvalPolicy: 'untrusted', sandbox: 'read-only', baseInstructions: '',
      developerInstructions: VOICE_INSTRUCTIONS + '\nYou are a restricted KDA voice dispatcher. The ONLY tool you may call is kda_control. Never read files, execute shell, edit, browse, delegate, or call any other tool. Use status for task questions; do not steer existing work for ordinary questions. Give short grounded Korean replies.',
      dynamicTools: this.preview ? [] : [{ type: 'function', name: VOICE_TOOL.name, description: VOICE_TOOL.description, inputSchema: VOICE_TOOL.parameters }],
      config: overrides });
    this.threadId = thread?.thread?.id;
    if (!this.threadId) throw Error('Codex가 음성 스레드를 반환하지 않았습니다.');
    if (thread.approvalPolicy !== 'untrusted' || thread.sandbox?.type !== 'readOnly')
      throw Error('음성 중계기의 읽기 전용·승인 정책을 확인하지 못했습니다.');
    await this.request('thread/realtime/start', { threadId: this.threadId, outputModality: 'audio',
      version: 'v3', transport: { type: 'webrtc', sdp }, voiceSessionId,
      ...(options.voice ? { voice: options.voice } : {}),
      includeStartupContext: false, clientManagedHandoffs: false, flushTranscriptTailOnSessionEnd: false,
      prompt: this.preview ? `목소리 미리듣기 전용이다. 도구나 작업 실행 없이 다음 문장만 한국어로 한 번 읽는다: ${VOICE_SAMPLE}` : '당신은 K님의 KDA 음성비서다. 한국어로 짧게 대화한다. 컴퓨터 작업·현재 작업의 상태 조회·정지는 반드시 기존 백엔드에 위임한다. 백엔드는 KDA 전용 제어만 사용한다. 단순 대화는 직접 답한다. 접수와 실제 완료를 구별하고 결과를 받기 전 실행·완료했다고 말하지 않는다. 사용자 발화 중에는 말을 멈춘다. 코드·비밀값을 읽지 않는다.' }, 45_000);
  }
  fail(message) {
    if (this.closed) return;
    this.emit({ kind: 'error', message });
    this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.calls.values()) { clearTimeout(c.timer); c.reject(Error('음성 세션 종료')); }
    this.calls.clear(); this.reader?.close(); this.process.stdin.destroy();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    if (this.process.pid) treeKill(this.process.pid, 'SIGKILL', () => {});
  }
}

export class VoiceHost {
  current = null;
  catalog = null;
  constructor(codex, emit, Session = CodexVoiceSession) { this.codex = codex; this.emit = emit; this.Session = Session; }
  receive(msg) {
    if (!['voice_list', 'voice_start', 'voice_stop', 'voice_reply', 'voice_speak', 'voice_extend'].includes(msg.type)) return false;
    const valid = typeof msg.sessionId === 'string' && /^[\w-]{20,80}$/.test(msg.sessionId);
    if (!valid) return true;
    if (msg.type === 'voice_list') {
      // Share one read-only process across simultaneous callers; no realtime call starts.
      if (!this.catalog) {
        this.catalog = Promise.resolve().then(async () => {
          const session = new this.Session(this.codex, () => {});
          try { return await session.listVoices(); } finally { session.close(); }
        }).finally(() => { this.catalog = null; });
      }
      void this.catalog.then(voices => this.emit({ type: 'voice_event', sessionId: msg.sessionId, kind: 'voices', voices }),
        error => this.emit({ type: 'voice_event', sessionId: msg.sessionId, kind: 'voices', message: voiceError(error.message) }));
      return true;
    }
    if (msg.type === 'voice_extend') {
      const entry = this.current;
      if (!entry || entry.preview || entry.id !== msg.sessionId || entry.session?.closed || Date.now() >= entry.expiresAt ||
          typeof msg.token !== 'string' || !/^[\w-]{20,80}$/.test(msg.token)) return true;
      const previous = entry.extensions.get(msg.token);
      if (previous) {
        this.emit({ type: 'voice_event', sessionId: entry.id, kind: 'lease', token: msg.token, expiresAt: previous });
        return true;
      }
      if (entry.extensions.size >= 128) return true;
      entry.expiresAt = Math.min(Date.now() + 10 * 60_000, entry.expiresAt + 5 * 60_000);
      entry.extensions.set(msg.token, entry.expiresAt);
      this.armExpiry(entry);
      this.emit({ type: 'voice_event', sessionId: entry.id, kind: 'lease', token: msg.token, expiresAt: entry.expiresAt });
      return true;
    }
    if (msg.type === 'voice_speak') {
      const s = this.current?.id === msg.sessionId && this.current.session;
      if (s?.threadId && typeof msg.text === 'string' && msg.text.trim() && msg.text.length <= 1200)
        void s.request(this.current.preview ? 'thread/realtime/appendText' : 'thread/realtime/appendSpeech', {
          threadId: s.threadId,
          ...(this.current.preview ? { role: 'developer' } : {}),
          text: this.current.preview ? `지금 목소리 미리듣기를 시작한다. 도구나 작업 실행 없이 다음 문장만 한국어로 한 번 소리 내어 읽어라: ${VOICE_SAMPLE}` : msg.text,
        }).catch(() => s.fail('음성 샘플 또는 안내를 전달하지 못했습니다.'));
      return true;
    }
    if (msg.type === 'voice_reply') {
      if (!this.current?.preview && this.current?.id === msg.sessionId && typeof msg.token === 'string' && msg.result &&
          typeof msg.result === 'object' && JSON.stringify(msg.result).length <= 16000) {
        try { this.current.session?.reply(msg.token, msg.result); }
        catch { this.current?.session?.fail('음성 명령 응답을 전달하지 못했습니다. 작업 상태를 확인하세요.'); }
      }
      return true;
    }
    if (msg.type === 'voice_stop') {
      if (this.current?.id === msg.sessionId) this.dispose();
      return true;
    }
    if (this.current || typeof msg.sdp !== 'string' || msg.sdp.length > 100_000 || !msg.sdp.startsWith('v=0') ||
        (msg.voice != null && (typeof msg.voice !== 'string' || (msg.voice !== '' && !/^[a-z]{2,24}$/.test(msg.voice)))) ||
        (msg.preview != null && typeof msg.preview !== 'boolean') ||
        typeof msg.conversationId !== 'string' || !msg.conversationId) {
      this.emit({ type: 'voice_event', sessionId: msg.sessionId, kind: 'error', message: '다른 통화가 있거나 음성 시작 요청이 유효하지 않습니다.' });
      return true;
    }
    const entry = { id: msg.sessionId, preview: msg.preview === true, session: null, timer: null, expiresAt: Date.now() + (msg.preview === true ? 60_000 : 5 * 60_000), extensions: new Map() };
    this.current = entry;
    const publish = event => {
      if (this.current !== entry) return;
      if (entry.preview && event.kind === 'command') { publish({ kind: 'error', message: '미리듣기에서는 작업을 실행할 수 없습니다.' }); return; }
      this.emit({ type: 'voice_event', sessionId: entry.id, ...event });
      if (event.kind === 'error') this.dispose();
    };
    try {
      entry.session = new this.Session(this.codex, publish);
      // Also limits a disconnected frontend that cannot send stop.
      this.armExpiry(entry);
      publish({ kind: 'lease', expiresAt: entry.expiresAt });
      void entry.session.start(msg.sdp, entry.id, { voice: msg.voice || '', preview: entry.preview }).catch(error => publish({ kind: 'error', message: String(error.message) }));
    } catch { publish({ kind: 'error', message: 'Codex 음성 연결을 시작하지 못했습니다.' }); }
    return true;
  }
  armExpiry(entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (this.current !== entry) return;
      this.emit({ type: 'voice_event', sessionId: entry.id, kind: 'error', message: '통화 시간이 만료됐습니다. 필요하면 다시 연결하세요.' });
      this.dispose();
    }, Math.max(0, entry.expiresAt - Date.now()));
  }
  dispose() {
    const entry = this.current; this.current = null;
    if (entry) { clearTimeout(entry.timer); entry.session?.close(); }
  }
}
