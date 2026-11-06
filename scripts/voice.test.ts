import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { VoiceCommandGate, voiceFeedback, explicitVoiceControl } from '../src/voiceControl.ts';
import { VoiceRouter } from '../src/voiceRouting.ts';
import { VoiceSession, isVoiceCallActive, voiceStartError, type VoiceEvent, type VoiceTransport } from '../src/voiceSession.ts';
// @ts-ignore Runtime module is deliberately dependency-light.
import { VoiceHost, CodexVoiceSession, voiceError } from '../sidecar/src/codex-voice.mjs';

const tick = () => new Promise(r => setTimeout(r, 10));
const handlers = (calls: any[] = []) => ({
  status: async (id: string) => { calls.push(['status', id]); return { run: { state: 'running' } }; },
  send: async (id: string, text: string, mode: string) => { calls.push(['send', id, text, mode]); },
  stop: async (id: string) => { calls.push(['stop', id]); },
  stopAll: async () => { calls.push(['stop_all']); },
});
test('explicit final controls distinguish stopping work, all work, and speech without guessing other utterances', () => {
  assert.equal(explicitVoiceControl('이 대화의 현재 작업을 멈춰 줘.'), 'stop');
  assert.equal(explicitVoiceControl('전체 작업 멈춰'), 'stop_all');
  assert.equal(explicitVoiceControl('말 그만해'), 'silence');
  for (const text of ['현재 작업 어디까지 됐어?', '멈추지 말고 계속해', '코드를 수정해줘', '작업 멈추는 방법 알려줘']) assert.equal(explicitVoiceControl(text), null);
});
test('status does not steer work; sends queue by default, explicit steer uses the existing path', async () => {
  const calls: any[] = [], gate = new VoiceCommandGate('session', 'locked-conversation', handlers(calls));
  await gate.execute('status', { action: 'status', text: '' });
  await gate.execute('send', { action: 'send', text: 'open editor' });
  await gate.execute('steer', { action: 'steer', text: 'change direction' });
  assert.deepEqual(calls, [['status', 'locked-conversation'], ['send', 'locked-conversation', 'open editor', 'queue'], ['send', 'locked-conversation', 'change direction', 'steer']]);
});
test('duplicate/invalid/cross-target/closed commands cannot execute or approve anything', async () => {
  const calls: any[] = [], gate = new VoiceCommandGate('session', 'locked', handlers(calls));
  const c = { action: 'send', text: 'once' };
  await gate.execute('1', c); await gate.execute('1', c);
  for (const value of [{ action: 'approve', text: '' }, { action: 'send', text: '' }, { ...c, conversationId: 'other' }, []])
    await assert.rejects(gate.execute(crypto.randomUUID(), value));
  gate.close(); await assert.rejects(gate.execute('late', c));
  assert.deepEqual(calls, [['send', 'locked', 'once', 'queue']]);
});
test('stop preempts a pending send and cancels older queued instructions; status remains responsive', async () => {
  const calls: any[] = []; let finish!: () => void;
  const pending = new Promise<void>(r => { finish = r; });
  const gate = new VoiceCommandGate('session', 'locked', { ...handlers(calls), send: async (_id, text) => { calls.push(text); if (text === 'first') await pending; } });
  const first = gate.execute('first', { action: 'send', text: 'first' }); await tick();
  const old = gate.execute('old', { action: 'send', text: 'old' });
  await tick();
  await gate.execute('stop', { action: 'stop', text: '' });
  await gate.execute('status', { action: 'status', text: '' });
  finish(); await first;
  assert.equal((await old as any).state, 'cancelled');
  assert.deepEqual(calls, ['first', ['stop', 'locked'], ['status', 'locked']]);
});
test('manual stop barrier is retained and failed stop is never reported as confirmed', async () => {
  const gate = new VoiceCommandGate('session', 'locked', { ...handlers(), canSend: () => false, stop: async () => { throw Error('not stopped'); } });
  assert.equal((await gate.execute('send', { action: 'send', text: 'blocked' }) as any).state, 'cancelled');
  await assert.rejects(gate.execute('stop', { action: 'stop', text: '' }), /not stopped/);
});
test('global stop uses the existing global handler and blocks pending older commands', async () => {
  const calls: any[] = [], gate = new VoiceCommandGate('session', 'locked', handlers(calls));
  assert.equal((await gate.execute('stop-all', { action: 'stop_all', text: '' }) as any).state, 'stopped');
  assert.deepEqual(calls, [['stop_all']]);
});
test('feedback strips code, URLs, keys, sensitive lines and bounds speech', () => {
  const value = voiceFeedback('결과 완료\n```sh\nsecret\n```\nhttps://example.test/path\nAPI_KEY=sk-secret\nC:/private/file.txt\n'+ '가'.repeat(900));
  assert.ok(!/secret|https:|private|```/.test(value)); assert.ok(value.length <= 400);
  assert.ok(!voiceError('Bearer abcdefghijklmnopqrstuvwxyz0123456789').includes('abcdefghijklmnopqrstuvwxyz'));
});

function fakeServer() {
  const server: any = new EventEmitter(); server.stdout = new PassThrough(); server.stderr = new PassThrough();
  const sent: any[] = [];
  server.stdin = new Writable({ write(chunk, _encoding, cb) { sent.push(JSON.parse(chunk.toString())); cb(); } });
  return { server, sent };
}
test('native broker binds dynamic replies and never approves unknown execution', async () => {
  const { server, sent } = fakeServer(), events: any[] = [];
  const session = new CodexVoiceSession('codex', (e: any) => events.push(e), () => server);
  session.threadId = 'voice-thread';
  const rpc = { id: 1, method: 'item/tool/call', params: { threadId: 'voice-thread', turnId: 'turn', callId: 'call', tool: 'kda_control', arguments: { action: 'status', text: '' } } };
  session.receive(rpc); session.receive(rpc);
  assert.equal(events.length, 1); assert.equal(events[0].kind, 'command');
  session.reply('wrong-token', { state: 'submitted' }); assert.equal(sent.length, 0);
  session.reply(events[0].token, { state: 'submitted' }); session.reply(events[0].token, { state: 'submitted' });
  assert.equal(sent.length, 1); assert.equal(sent[0].id, 1); assert.equal(sent[0].result.success, true);
  session.receive({ id: 2, method: 'item/commandExecution/requestApproval', params: { threadId: 'voice-thread' } });
  assert.equal(session.closed, true); assert.equal(sent.length, 1); assert.equal(events[1].kind, 'error');
});
test('native broker rejects wrong thread/tool and closes before forwarding native work', () => {
  for (const msg of [
    { id: 1, method: 'item/tool/call', params: { threadId: 'other', tool: 'kda_control' } },
    { id: 2, method: 'item/tool/call', params: { threadId: 'voice-thread', tool: 'shell' } },
    { method: 'item/started', params: { threadId: 'voice-thread', item: { type: 'commandExecution' } } },
  ]) {
    const { server, sent } = fakeServer(), events: any[] = [];
    const session = new CodexVoiceSession('codex', (e: any) => events.push(e), () => server); session.threadId = 'voice-thread';
    session.receive(msg); assert.equal(session.closed, true); assert.equal(sent.length, 0); assert.equal(events[0].kind, 'error');
  }
});

test('native start disables inherited MCP, installs only the KDA dynamic tool and rejects an escalated sandbox', async () => {
  for (const policy of ['readOnly', 'dangerFullAccess']) {
    const { server, sent } = fakeServer();
    const session = new CodexVoiceSession('codex', () => {}, () => server);
    session.request = async (method: string, params: any) => {
      sent.push({ method, params });
      if (method === 'config/read') return { config: { mcp_servers: { private: { enabled: true } } } };
      if (method === 'thread/start') return { thread: { id: 'voice-thread' }, approvalPolicy: 'untrusted', sandbox: { type: policy } };
      return {};
    };
    if (policy === 'readOnly') await session.start('v=0', 'voice-id');
    else await assert.rejects(session.start('v=0', 'voice-id'), /정책/);
    const config = sent.find(v => v.method === 'thread/start').params;
    assert.equal(config.config['mcp_servers.private.enabled'], false);
    assert.equal(config.config['features.shell_tool'], false);
    assert.equal(config.config['features.multi_agent'], false);
    assert.deepEqual(config.dynamicTools.map((t: any) => t.name), ['kda_control']);
    assert.equal(sent.some(v => v.method === 'thread/realtime/start'), policy === 'readOnly');
    if (policy === 'readOnly') assert.equal(sent.find(v => v.method === 'thread/realtime/start').params.version, 'v3');
    session.close();
  }
});
test('host allows one call, rejects cross-session replies/stops, and discards replies after teardown', async () => {
  const instances: any[] = [], events: any[] = [];
  class Session {
    closed = false; replies: any[] = [];
    constructor() { instances.push(this); }
    async start() {}
    close() { this.closed = true; }
    reply(...v: any[]) { this.replies.push(v); }
  }
  const host = new VoiceHost('codex', (e: any) => events.push(e), Session);
  const start = { type: 'voice_start', sessionId: crypto.randomUUID(), conversationId: 'conversation', sdp: 'v=0\r\n' };
  host.receive(start); host.receive(start); assert.equal(instances.length, 1); assert.equal(events[0].kind, 'error');
  host.receive({ type: 'voice_stop', sessionId: crypto.randomUUID() }); assert.equal(instances[0].closed, false);
  host.receive({ type: 'voice_reply', sessionId: crypto.randomUUID(), token: 'unknown', result: {} }); assert.equal(instances[0].replies.length, 0);
  host.dispose(); assert.equal(instances[0].closed, true);
  host.receive({ type: 'voice_reply', sessionId: start.sessionId, token: 'late', result: {} }); assert.equal(instances[0].replies.length, 0);
});

function fakeMedia() {
  const track: any = { enabled: true, readyState: 'live', onended: null, stop() { this.readyState = 'ended'; } };
  const stream: any = { getTracks: () => [track], getAudioTracks: () => [track] };
  const peers: any[] = [], audios: any[] = [];
  class Peer {
    connectionState = 'new'; iceGatheringState = 'complete'; remoteDescription: any = null; localDescription: any = null;
    channel: any = { readyState: 'open', close() {} };
    constructor() { peers.push(this); }
    addTrack() {} createDataChannel() { return this.channel; }
    async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
    async setLocalDescription(d: any) { this.localDescription = d; }
    async setRemoteDescription(d: any) { this.remoteDescription = d; }
    close() { this.connectionState = 'closed'; }
  }
  class Audio {
    muted = false; srcObject: any = null; paused = false;
    constructor() { audios.push(this); } async play() {} pause() { this.paused = true; }
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: Audio });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => stream } } });
  return { track, stream, peers, audios };
}

test('device failures distinguish missing default, selected device, permission and busy input', () => {
  const error = (name: string) => Object.assign(new Error('Requested device not found'), { name });
  assert.match(voiceStartError(error('NotFoundError'), 'microphone'), /기본 마이크.*원격 데스크톱/s);
  assert.match(voiceStartError(error('NotFoundError'), 'microphone', true), /선택한 마이크/);
  assert.match(voiceStartError(error('NotAllowedError'), 'microphone'), /마이크 사용이 차단/);
  assert.match(voiceStartError(error('NotReadableError'), 'microphone'), /다른 앱/);
  assert.match(voiceStartError(error('OverconstrainedError'), 'microphone'), /오디오 조건/);
  assert.match(voiceStartError(error('NotFoundError'), 'speaker'), /선택한 스피커/);
  assert.equal(voiceStartError(error('NotFoundError'), 'connection'), 'Requested device not found');
});

test('missing or denied microphone never starts backend, retries or silently switches the selected input', async () => {
  for (const name of ['NotFoundError', 'NotAllowedError', 'OverconstrainedError', 'NotReadableError']) {
    const media = fakeMedia(), views: any[] = [], calls: any[] = [];
    navigator.mediaDevices.getUserMedia = async constraints => {
      calls.push(constraints);
      throw Object.assign(new Error('Requested device not found'), { name });
    };
    const transport: VoiceTransport = { listen: async () => { throw Error('must not listen'); }, start: async () => { throw Error('must not start'); }, stop: async () => {}, reply: async () => {}, speak: async () => {} };
    const session = new VoiceSession('locked', handlers(), transport, view => views.push(view));
    await session.start('chosen-microphone');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].audio.deviceId, { exact: 'chosen-microphone' });
    assert.equal(media.peers.length, 0);
    assert.equal(views[views.length - 1].phase, 'error');
    assert.equal(isVoiceCallActive(), false);
  }
});

test('missing speaker reports output failure and releases acquired input without starting backend', async () => {
  const media = fakeMedia(), views: any[] = []; let starts = 0;
  (globalThis.Audio.prototype as any).setSinkId = async () => { throw Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' }); };
  const transport: VoiceTransport = { listen: async () => () => {}, start: async () => { starts++; }, stop: async () => {}, reply: async () => {}, speak: async () => {} };
  const session = new VoiceSession('locked', handlers(), transport, view => views.push(view));
  await session.start('', 'missing-output');
  assert.match(views[views.length - 1].message, /선택한 스피커/);
  assert.equal(media.track.readyState, 'ended');
  assert.equal(starts, 0);
  assert.equal(isVoiceCallActive(), false);
});
test('browser never transmits before actual media+session handshake, binds target, and releases all media on close', async () => {
  const media = fakeMedia(), calls: any[] = [], views: any[] = [], messages: any[] = [];
  let receive!: (e: VoiceEvent) => void; let unlistened = false;
  const transport: VoiceTransport = { listen: async fn => { receive = fn; return () => { unlistened = true; }; },
    start: async (...v) => { messages.push(['start', ...v]); }, stop: async id => { messages.push(['stop', id]); },
    reply: async (...v) => { messages.push(['reply', ...v]); }, speak: async () => {} };
  const session = new VoiceSession('locked', handlers(calls), transport, v => views.push(v));
  await session.start(); assert.equal(media.track.enabled, false); assert.equal(isVoiceCallActive(), true);
  await session.start(); assert.equal(media.peers.length, 1);
  media.peers[0].connectionState = 'connected'; media.peers[0].onconnectionstatechange();
  assert.equal(media.track.enabled, false); assert.ok(!views.some(v => v.phase === 'connected'));
  session.receive({ type: 'session.started' }); assert.equal(media.track.enabled, true); assert.equal(views.at(-1).phase, 'connected');
  receive({ sessionId: 'wrong', kind: 'command', token: 'x', command: { action: 'send', text: 'bad' }, createdAt: Date.now() });
  const event: VoiceEvent = { sessionId: session.id, kind: 'command', token: crypto.randomUUID(), command: { action: 'send', text: 'once' }, createdAt: Date.now() };
  receive(event); receive(event); await tick();
  assert.equal(calls.filter(v => v[0] === 'send').length, 1); assert.equal(messages.filter(v => v[0] === 'reply').length, 1);
  session.setMuted(true); assert.equal(media.track.enabled, false); session.setMuted(false); assert.equal(media.track.enabled, true);
  session.silence(); assert.equal(media.audios[0].muted, true); assert.equal(calls.filter(v => v[0] === 'stop').length, 0);
  session.end(); assert.equal(media.track.readyState, 'ended'); assert.equal(media.audios[0].srcObject, null); assert.equal(unlistened, true); assert.equal(isVoiceCallActive(), false);
  receive({ ...event, token: 'late' }); await tick(); assert.equal(calls.filter(v => v[0] === 'send').length, 1);
});
test('closing while permission is pending stops a late microphone stream and never starts a backend', async () => {
  const media = fakeMedia(), events: any[] = []; let resolve!: (value: unknown) => void;
  navigator.mediaDevices.getUserMedia = () => new Promise(r => { resolve = r; }) as any;
  const transport: VoiceTransport = { listen: async () => () => {}, start: async () => { events.push('start'); }, stop: async () => {}, reply: async () => {}, speak: async () => {} };
  const s = new VoiceSession('locked', handlers(), transport, () => {});
  const pending = s.start(); s.end(); resolve(media.stream); await pending;
  assert.equal(media.track.readyState, 'ended'); assert.deepEqual(events, []); assert.equal(isVoiceCallActive(), false);
});
test('microphone denial is visible and clears the active-call/update lock', async () => {
  fakeMedia(); navigator.mediaDevices.getUserMedia = async () => { throw Error('permission denied'); };
  const views: any[] = [];
  const transport: VoiceTransport = { listen: async () => () => {}, start: async () => { throw Error('must not start'); }, stop: async () => {}, reply: async () => {}, speak: async () => {} };
  await new VoiceSession('locked', handlers(), transport, v => views.push(v)).start();
  assert.equal(views.at(-1).phase, 'error'); assert.match(views.at(-1).message, /permission denied/); assert.equal(isVoiceCallActive(), false);
});

test('explicit final stop reaches KDA without a model delegation, coalesces its later delegation and never treats silence as task stop', async () => {
  const media = fakeMedia(), calls: any[] = [], spoken: string[] = [], replies: any[] = [];
  let receive!: (event: VoiceEvent) => void, running = true;
  const transport: VoiceTransport = { listen: async fn => { receive = fn; return () => {}; }, start: async () => {}, stop: async () => {},
    reply: async (_id, _token, result) => { replies.push(result); }, speak: async (_id, text) => { spoken.push(text); } };
  const session = new VoiceSession('locked', { ...handlers(calls), status: async () => ({ run: running ? { state: 'running' } : null, paused: !running }),
    stop: async () => { calls.push('stop'); running = false; } }, transport, () => {});
  await session.start(); media.peers[0].connectionState = 'connected'; session.receive({ type: 'session.started' });
  session.receive({ type: 'input_transcript.added', item: { text: '작업 멈춰' } }); await tick(); assert.equal(calls.length, 0);
  const event = { type: 'turn.done', turn: { id: 'utterance-1', role: 'user', transcript: '이 대화의 현재 작업을 멈춰 줘.' } };
  session.receive(event); session.receive(event); await tick(); assert.deepEqual(calls, ['stop']); assert.match(spoken[0], /정지했습니다/);
  receive({ sessionId: session.id, kind: 'command', token: crypto.randomUUID(), createdAt: Date.now(), command: { action: 'stop', text: '' } });
  await tick(); assert.deepEqual(calls, ['stop']); assert.equal(replies[0].state, 'stopped');
  receive({ sessionId: session.id, kind: 'command', token: crypto.randomUUID(), createdAt: Date.now(), command: { action: 'stop_all', text: '' } });
  await tick(); assert.equal(replies[1].state, 'error');
  session.receive({ type: 'turn.done', turn: { id: 'utterance-2', role: 'user', transcript: '말 그만해' } });
  receive({ sessionId: session.id, kind: 'command', token: crypto.randomUUID(), createdAt: Date.now(), command: { action: 'stop', text: '' } });
  await tick(); assert.equal(replies[2].state, 'error'); assert.deepEqual(calls, ['stop']); session.end();
});

test('a streaming answer present at call start still produces its final feedback, and approvals are announced', async () => {
  const media = fakeMedia(), spoken: string[] = [];
  let answer: any = { id: 'a', streaming: true, text: 'partial' }, approvalPending = false;
  const transport: VoiceTransport = { listen: async () => () => {}, start: async () => {}, stop: async () => {}, reply: async () => {}, speak: async (_id, text) => { spoken.push(text); } };
  const session: any = new VoiceSession('locked', { ...handlers(), status: async () => ({ run: { state: 'running' }, approvalPending, latestAssistant: answer }) }, transport, () => {});
  await session.start(); media.peers[0].connectionState = 'connected'; session.receive({ type: 'session.started' }); await tick();
  assert.deepEqual(spoken, []);
  answer = { ...answer, streaming: false, text: '검증 결과 실패. 화면을 확인하세요.' };
  await session.pollStatus(); assert.match(spoken[0], /실패/);
  approvalPending = true; await session.pollStatus(); assert.match(spoken[1], /승인/);
  session.silence(); answer = { id: 'b', streaming: false, text: 'new answer' }; await session.pollStatus();
  assert.equal(spoken.length, 2); session.end();
});

function routingFixture() {
  let selected: string | null = 'a';
  const calls: any[] = [], changed: any[] = [];
  const conversations = [{ id: 'a', title: 'KDA 개발' }, { id: 'b', title: '릴리스 점검' },
    { id: 'c', title: '중복 이름' }, { id: 'd', title: '중복 이름' }];
  const routing = { conversations: () => conversations, selected: () => selected,
    changed: (target: any, following: boolean) => changed.push({ target, following }) };
  const router = new VoiceRouter('routing-session', 'a', handlers(calls), routing);
  return { router, calls, changed, conversations, routing, select: (id: string | null) => { selected = id; } };
}

test('voice routing samples selection once per utterance; queued work keeps its original conversation', async () => {
  const f = routingFixture(); f.router.beginUtterance(); f.select('b');
  await f.router.execute('a', { action: 'send', text: '기존 맥락으로 수정' });
  f.router.beginUtterance(); await f.router.execute('b', { action: 'send', text: '점검' });
  assert.deepEqual(f.calls, [['send', 'a', '기존 맥락으로 수정', 'queue'], ['send', 'b', '점검', 'queue']]);
  assert.deepEqual(f.router.watchedTargets.map(t => t.id), ['a', 'b']);
});

test('named routing pins future commands; follow resumes selection without stopping old work', async () => {
  const f = routingFixture();
  const result: any = await f.router.execute('named', { action: 'send', target: '릴리스', text: '테스트 실행' });
  assert.equal(result.target, '릴리스 점검'); assert.equal(f.router.followsSelection, false);
  f.select('a'); f.router.beginUtterance(); await f.router.execute('status', { action: 'status', text: '' });
  assert.deepEqual(f.calls[1], ['status', 'b']);
  await f.router.execute('follow', { action: 'follow', text: '' });
  await f.router.execute('back', { action: 'send', text: '이어 진행' });
  assert.deepEqual(f.calls[2], ['send', 'a', '이어 진행', 'queue']);
  assert.equal(f.calls.filter(c => c[0] === 'stop').length, 0);
});

test('ambiguous or missing names never dispatch; clarification must resolve before a default send', async () => {
  const f = routingFixture();
  const r: any = await f.router.execute('ambiguous', { action: 'send', target: '중복 이름', text: '수정' });
  assert.equal(r.state, 'needs_target'); assert.deepEqual(r.candidates, ['중복 이름 · 1', '중복 이름 · 2']);
  await assert.rejects(f.router.execute('fallback', { action: 'send', text: '수정' }), /대상 확인/);
  assert.deepEqual(f.calls, []);
  await f.router.execute('choice', { action: 'send', target: '중복 이름 · 2', text: '선택한 작업' });
  assert.deepEqual(f.calls, [['send', 'd', '선택한 작업', 'queue']]);
  assert.equal((await f.router.execute('missing', { action: 'stop', target: '존재하지 않음', text: '' }) as any).state, 'needs_target');
  assert.equal(f.calls.length, 1);
});

test('routing accepts local names only, bounds discovery, and rejects replay across target changes', async () => {
  const f = routingFixture();
  const choices: any = await f.router.execute('list', { action: 'conversations', text: '릴리스' });
  assert.deepEqual(choices.conversations, ['릴리스 점검']); assert.ok(!JSON.stringify(choices).includes('"id"'));
  assert.equal(f.calls.length, 0);
  await f.router.execute('once', { action: 'send', text: '1회' });
  await f.router.execute('select', { action: 'select', text: '릴리스 점검' });
  assert.equal((await f.router.execute('once', { action: 'send', text: '재전송' }) as any).state, 'unknown');
  for (const command of [{ action: 'send', text: 'x', conversationId: 'b' }, { action: 'approve', text: '' },
    { action: 'send', text: 'x', target: {} }, { action: 'send', text: '' }]) {
    await assert.rejects(f.router.execute(crypto.randomUUID(), command));
  }
  f.router.close(); await assert.rejects(f.router.execute('late', { action: 'send', text: 'late' }));
  assert.equal(f.calls.length, 1);
});

test('selection loss or deletion cannot fall back to another conversation; queued sends revalidate membership', async () => {
  const f = routingFixture(); f.select(null); f.router.beginUtterance();
  await assert.rejects(f.router.execute('none', { action: 'send', text: '실행' }), /대상 대화/);
  f.select('b'); f.router.beginUtterance(); f.conversations.splice(1, 1);
  await assert.rejects(f.router.execute('deleted', { action: 'stop', text: '' }), /대상 대화/);
  assert.deepEqual(f.calls, []);
  const calls: string[] = []; let release!: () => void;
  const pending = new Promise<void>(r => { release = r; });
  const g = routingFixture();
  const router = new VoiceRouter('pending', 'a', { ...handlers(), send: async (_id, text) => { calls.push(text); await pending; } }, g.routing);
  const first = router.execute('first', { action: 'send', text: 'first' }); await tick();
  const queued = router.execute('queued', { action: 'send', text: 'queued' });
  g.conversations.splice(0, 1); release(); await first;
  assert.equal((await queued as any).state, 'cancelled'); assert.deepEqual(calls, ['first']); router.close();
});

test('a global stop cancels older queued sends in every routed conversation', async () => {
  const f = routingFixture(), calls: any[] = []; let release!: () => void;
  const wait = new Promise<void>(r => { release = r; });
  const router = new VoiceRouter('all-stop', 'a', { ...handlers(calls), send: async (id, text) => { calls.push([id, text]); if (text === 'first') await wait; } }, f.routing);
  const first = router.execute('first', { action: 'send', text: 'first' }); await tick();
  const queued = router.execute('queued', { action: 'send', text: 'queued' }); await tick();
  await router.execute('switch', { action: 'select', text: '릴리스 점검' });
  await router.execute('stop-all', { action: 'stop_all', text: '' }); release(); await first;
  assert.equal((await queued as any).state, 'cancelled'); assert.deepEqual(calls, [['a', 'first'], ['stop_all']]); router.close();
});

test('live session keeps speech-onset target across tab changes and reports results from previous conversations', async () => {
  const media = fakeMedia(), f = routingFixture(), spoken: string[] = [], replies: any[] = [];
  const states: Record<string, any> = { a: { run: { state: 'running' } }, b: { run: null } };
  let receive!: (e: VoiceEvent) => void;
  const transport: VoiceTransport = { listen: async fn => { receive = fn; return () => {}; }, start: async () => {}, stop: async () => {},
    reply: async (_id, _token, result) => { replies.push(result); }, speak: async (_id, text) => { spoken.push(text); } };
  const session: any = new VoiceSession('a', { ...handlers(f.calls), status: async id => states[id] }, transport, () => {}, f.routing);
  await session.start(); media.peers[0].connectionState = 'connected'; session.receive({ type: 'session.started' }); await tick();
  session.receive({ type: 'input_transcript.added' }); f.select('b');
  session.receive({ type: 'turn.done', turn: { id: 'first-user', role: 'user', transcript: '이거 수정해줘' } });
  receive({ sessionId: session.id, kind: 'command', token: 'one', createdAt: Date.now(), command: { action: 'send', text: '이거 수정해줘' } });
  await tick(); assert.deepEqual(f.calls[0], ['send', 'a', '이거 수정해줘', 'queue']);
  session.receive({ type: 'turn.done', turn: { role: 'assistant', transcript: '접수했습니다' } });
  session.receive({ type: 'input_transcript.added' });
  session.receive({ type: 'turn.done', turn: { id: 'second-user', role: 'user', transcript: '여기도 점검' } });
  receive({ sessionId: session.id, kind: 'command', token: 'two', createdAt: Date.now(), command: { action: 'send', text: '여기도 점검' } });
  await tick(); assert.deepEqual(f.calls[1], ['send', 'b', '여기도 점검', 'queue']);
  session.receive({ type: 'turn.done', turn: { role: 'assistant', transcript: '접수했습니다' } }); await session.pollStatus();
  states.a = { run: null, latestAssistant: { id: 'finished-a', text: '수정 완료', streaming: false } };
  await session.pollStatus(); assert.ok(spoken.some(s => s.includes('KDA 개발') && s.includes('수정 완료')));
  assert.deepEqual(replies.map(r => r.target), ['KDA 개발', '릴리스 점검']); session.end();
});
