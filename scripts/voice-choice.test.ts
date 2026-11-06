import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { VoiceSession, isVoiceCallActive } from '../src/voiceSession.ts';
// @ts-ignore Runtime module.
import { VoiceHost, CodexVoiceSession, voiceCatalog, VOICE_SAMPLE } from '../sidecar/src/codex-voice.mjs';

function broker() {
  const process: any = new EventEmitter(); process.stdout = new PassThrough(); process.stderr = new PassThrough();
  process.stdin = new Writable({ write(_chunk, _encoding, cb) { cb(); } });
  const sent: any[] = [];
  const session = new CodexVoiceSession('codex', () => {}, () => process);
  session.request = async (method: string, params: any) => {
    sent.push({ method, params });
    if (method === 'thread/realtime/listVoices') return { voices: { v3: ['marin', 'cedar'] } };
    if (method === 'thread/start') return { thread: { id: 'voice' }, approvalPolicy: 'untrusted', sandbox: { type: 'readOnly' } };
    return {};
  };
  return { session, sent };
}
test('voice catalog uses only current v3 support; malformed and missing lists fail closed', () => {
  assert.deepEqual(voiceCatalog({ voices: { v3: ['marin', 'marin', 'cedar'], v2: ['unsupported'] } }), ['marin', 'cedar']);
  for (const value of [null, { voices: { v2: ['marin'] } }, { voices: { v3: [] } }, { voices: { v3: ['../../private'] } }])
    assert.throws(() => voiceCatalog(value));
});
test('catalog queries do not create a thread or realtime session', async () => {
  const { session, sent } = broker();
  try { assert.deepEqual(await session.listVoices(), ['marin', 'cedar']); assert.deepEqual(sent.map(v => v.method), ['initialize', 'thread/realtime/listVoices']); }
  finally { session.close(); }
});
test('chosen voice reaches realtime start; unsupported voice never starts a thread', async () => {
  for (const voice of ['marin', 'unavailable']) {
    const { session, sent } = broker();
    try {
      if (voice === 'unavailable') { await assert.rejects(session.start('v=0', 'id', { voice }), /목소리/); assert.equal(sent.some(v => v.method === 'thread/start'), false); }
      else { await session.start('v=0', 'id', { voice }); assert.equal(sent.find(v => v.method === 'thread/realtime/start').params.voice, voice); }
    } finally { session.close(); }
  }
});
test('preview has no dynamic work tools and rejects tool calls', async () => {
  const { session, sent } = broker();
  try {
    await session.start('v=0', 'id', { voice: 'cedar', preview: true });
    assert.deepEqual(sent.find(v => v.method === 'thread/start').params.dynamicTools, []);
    assert.ok(sent.find(v => v.method === 'thread/realtime/start').params.prompt.includes(VOICE_SAMPLE));
    session.receive({ id: 99, method: 'item/tool/call', params: { threadId: 'voice', tool: 'kda_control', turnId: 't', callId: 'c', arguments: { action: 'stop_all' } } });
    assert.equal(session.closed, true);
  } finally { session.close(); }
});
test('host catalog requests share one disposable process and preserve an active call', async () => {
  const instances: any[] = [], events: any[] = []; let resolve!: (value: string[]) => void;
  class Session {
    closed = false;
    constructor() { instances.push(this); }
    async start() {}
    listVoices() { return new Promise<string[]>(r => { resolve = r; }); }
    close() { this.closed = true; }
  }
  const host = new VoiceHost('codex', (e: any) => events.push(e), Session);
  try {
    host.receive({ type: 'voice_start', sessionId: crypto.randomUUID(), conversationId: 'target', sdp: 'v=0' });
    for (let n = 0; n < 2; n++) host.receive({ type: 'voice_list', sessionId: crypto.randomUUID() });
    await Promise.resolve(); assert.equal(instances.length, 2);
    resolve(['marin']); await new Promise(r => setTimeout(r, 5));
    assert.equal(instances[0].closed, false); assert.equal(instances[1].closed, true);
    assert.equal(events.filter(e => e.kind === 'voices').length, 2);
  } finally { host.dispose(); }
});
test('preview host forwards chosen voice and pins sample text without allowing extension', async () => {
  const seen: any[] = [], events: any[] = [];
  class Session {
    threadId = 'voice'; closed = false;
    async start(...args: any[]) { seen.push(args); }
    async request(...args: any[]) { seen.push(args); }
    close() { this.closed = true; }
  }
  const host = new VoiceHost('codex', (e: any) => events.push(e), Session), id = crypto.randomUUID();
  try {
    host.receive({ type: 'voice_start', sessionId: id, conversationId: 'target', sdp: 'v=0', voice: 'marin', preview: true });
    assert.deepEqual(seen[0][2], { voice: 'marin', preview: true });
    host.receive({ type: 'voice_speak', sessionId: id, text: 'untrusted instructions' });
    assert.equal(seen[1][1].text, VOICE_SAMPLE);
    const before = events.length;
    host.receive({ type: 'voice_extend', sessionId: id, token: crypto.randomUUID() });
    assert.equal(events.length, before);
  } finally { host.dispose(); }
});
test('receive-only preview opens no microphone, executes no work, sends the chosen voice and releases its peer', async () => {
  const descriptors = new Map(['navigator', 'RTCPeerConnection', 'Audio'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  let microphone = 0, work = 0, options: any; const spoken: any[] = [];
  class Peer {
    static instance: Peer; connectionState = 'connected'; iceGatheringState = 'complete'; remoteDescription = null;
    localDescription: any; direction = ''; channel = { readyState: 'open', close() {} };
    constructor() { Peer.instance = this; }
    addTransceiver(_kind: string, init: any) { this.direction = init.direction; }
    createDataChannel() { return this.channel; }
    async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
    async setLocalDescription(value: any) { this.localDescription = value; }
    close() { this.connectionState = 'closed'; }
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => { microphone++; throw Error('microphone opened'); } } } });
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: class { pause() {} } });
  const deny = async () => { work++; };
  const session = new VoiceSession('preview', { status: deny, send: deny, stop: deny, stopAll: deny }, {
    listen: async () => () => {}, start: async (_id, _target, _sdp, value) => { options = value; },
    stop: async () => {}, reply: deny, speak: async (_id, text) => { spoken.push(text); },
  }, () => {});
  try {
    await session.start('', '', 'cedar', true); session.receive({ type: 'session.started' });
    assert.equal(microphone, 0); assert.equal(Peer.instance.direction, 'recvonly');
    assert.deepEqual(options, { voice: 'cedar', preview: true }); assert.equal(spoken.length, 1);
    session.receive({ type: 'turn.done', turn: { role: 'user', transcript: '전체 작업 멈춰' } });
    assert.equal(work, 0); session.end(); assert.equal(isVoiceCallActive(), false); assert.equal(Peer.instance.connectionState, 'closed');
  } finally {
    session.end();
    for (const [name, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});
