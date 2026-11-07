import http from 'node:http';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

type Emit = (event: Record<string, unknown>) => void;
type Client = { expires: number; seen: number; events: { seq: number; event: unknown }[]; seq: number;
  requests: Map<string, Promise<unknown>>; voice?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const methods = new Set(['conversations', 'status', 'send', 'stop', 'voice']);
const secret = () => randomBytes(32).toString('base64url');
const same = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Loopback transport only. Desktop retains all model, project and approval decisions. */
export class MobileHost {
  private server?: http.Server;
  private pairing = '';
  private pairingExpires = 0;
  private origin = '';
  private port = 0;
  private clients = new Map<string, Client>();
  private pending = new Map<string, { client: Client; claimed: boolean; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private sweep?: ReturnType<typeof setInterval>;
  private failedPairs = 0;
  private pairWindow = 0;
  private changing = false;
  constructor(private emit: Emit, private voice: (message: Record<string, unknown>) => void,
    private staticRoot = fileURLToPath(new URL('./mobile/', import.meta.url))) {}

  status() {
    return { enabled: !!this.server?.listening, port: this.port, origin: this.origin,
      pairingCode: this.pairingExpires > Date.now() ? this.pairing : '', pairingExpires: this.pairingExpires,
      clients: this.clients.size, loopback: '127.0.0.1' };
  }
  receive(message: any) {
    if (message?.type !== 'mobile_control') return false;
    if (message.action === 'reply') {
      const pending = this.pending.get(message.requestId);
      if (pending) {
        clearTimeout(pending.timer); this.pending.delete(message.requestId);
        if (message.error) pending.reject(Error(String(message.error).slice(0, 500)));
        else pending.resolve(message.result);
      }
      return true;
    }
    void this.control(message).then(result => this.emit({ type: 'mobile_control_result', id: message.id, result }),
      () => this.emit({ type: 'mobile_control_result', id: message.id, error: '휴대폰 연결 설정 실패. 포트와 HTTPS 주소를 확인하세요.' }));
    return true;
  }
  private async control(message: any) {
    if (message.action === 'status') return this.status();
    if (message.action === 'claim') {
      const pending = this.pending.get(message.requestId);
      const valid = !!pending && !pending.claimed;
      if (valid) pending.claimed = true;
      return { valid };
    }
    if (this.changing) throw Error('설정 처리 중');
    this.changing = true;
    try {
      if (message.action === 'disable') { await this.close(); return this.status(); }
      if (message.action === 'rotate') {
        if (!this.server?.listening) throw Error('연결 꺼짐');
        this.pairing = secret(); this.pairingExpires = Date.now() + 10 * 60_000; return this.status();
      }
      if (message.action !== 'enable') throw Error('지원하지 않는 설정');
      const port = message.port ?? 17677;
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('포트 오류');
      const url = new URL(message.origin);
      const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
      if ((!local && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('HTTPS 주소 필요');
      if (this.server) throw Error('먼저 연결 해제 필요');
      this.origin = url.origin; this.port = port;
      const server = http.createServer((req, res) => { void this.route(req, res).catch(() => this.json(res, 500, { error: '연결 처리 오류' })); });
      server.requestTimeout = 15_000; server.headersTimeout = 10_000;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      this.server = server;
      server.on('error', () => { void this.close(); });
      this.pairing = secret(); this.pairingExpires = Date.now() + 10 * 60_000;
      this.sweep = setInterval(() => {
        for (const [key, client] of this.clients) if (client.expires <= Date.now() || Date.now() - client.seen > 90_000) this.revoke(key);
      }, 10_000);
      this.sweep.unref(); return this.status();
    } finally { this.changing = false; }
  }
  private revoke(key: string) {
    const client = this.clients.get(key);
    if (client?.voice) this.voice({ type: 'voice_stop', sessionId: client.voice });
    for (const [id, entry] of this.pending) if (entry.client === client && !entry.claimed) {
      clearTimeout(entry.timer); this.pending.delete(id); entry.reject(Error('연결 해제로 미접수 명령 취소'));
    }
    this.clients.delete(key);
  }
  async close() {
    this.pairing = ''; this.pairingExpires = 0;
    clearInterval(this.sweep);
    for (const key of this.clients.keys()) this.revoke(key);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(Error('PC에서 연결 해제')); }
    this.pending.clear();
    const server = this.server; this.server = undefined;
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
  publishVoice(event: Record<string, unknown>) {
    if (event.type !== 'voice_event') return;
    for (const client of this.clients.values()) if (client.voice === event.sessionId) {
      client.events.push({ seq: ++client.seq, event });
      if (client.events.length > 128) client.events.shift();
    }
  }
  private json(res: http.ServerResponse, code: number, value: unknown) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(JSON.stringify(value));
  }
  private async body(req: http.IncomingMessage): Promise<any> {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw Error('JSON 필요');
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { size += chunk.length; if (size > 120_000) throw Error('요청 크기 초과'); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('요청 형식 오류');
    return body;
  }
  private relay(client: Client, method: string, params: any): Promise<unknown> {
    if (this.pending.size >= 32) return Promise.reject(Error('PC 요청이 밀려 있습니다. 상태를 확인하세요.'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(Error('PC 응답 시간 초과. 실행 여부는 상태에서 확인하세요. 자동 재전송하지 않습니다.')); }, 35_000);
      this.pending.set(requestId, { client, claimed: false, resolve, reject, timer });
      this.emit({ type: 'mobile_request', requestId, method, params, createdAt: Date.now() });
    });
  }
  private async route(req: http.IncomingMessage, res: http.ServerResponse) {
    const allowedHosts = new Set([new URL(this.origin).host, `localhost:${this.port}`, `127.0.0.1:${this.port}`]);
    if (!allowedHosts.has(req.headers.host ?? '')) return this.json(res, 403, { error: '허용하지 않은 호스트' });
    if (req.headers.origin && req.headers.origin !== this.origin) return this.json(res, 403, { error: '허용하지 않은 출처' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'POST' || req.headers.origin !== this.origin) return this.json(res, 403, { error: '동일 출처 POST 필요' });
      let body: any;
      try { body = await this.body(req); } catch { return this.json(res, 400, { error: '요청 형식 또는 크기 오류' }); }
      if (url.pathname === '/api/pair') {
        if (Date.now() - this.pairWindow > 60_000) { this.failedPairs = 0; this.pairWindow = Date.now(); }
        if (this.failedPairs >= 10) return this.json(res, 429, { error: '연결 시도가 많습니다. 잠시 후 다시 시도하세요.' });
        if (typeof body.code !== 'string' || !this.pairing || this.pairingExpires <= Date.now() || !same(body.code, this.pairing)) {
          this.failedPairs++; return this.json(res, 401, { error: '만료되었거나 잘못된 연결 코드' });
        }
        if (this.clients.size >= 4) return this.json(res, 429, { error: '연결 기기 한도입니다. PC에서 연결을 해제하세요.' });
        const token = secret(); this.pairing = ''; this.pairingExpires = 0;
        const expires = Date.now() + 8 * 60 * 60_000;
        this.clients.set(token, { expires, seen: Date.now(), events: [], seq: 0, requests: new Map() });
        return this.json(res, 200, { token, expires });
      }
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const client = this.clients.get(token);
      if (!client || client.expires <= Date.now() || Date.now() - client.seen > 90_000) { this.revoke(token); return this.json(res, 401, { error: '연결이 만료되었습니다. PC에서 다시 연결하세요.' }); }
      client.seen = Date.now();
      if (url.pathname === '/api/disconnect') { this.revoke(token); return this.json(res, 200, { disconnected: true }); }
      if (url.pathname === '/api/events') {
        if (!Number.isSafeInteger(body.after) || body.after < 0) return this.json(res, 400, { error: '이벤트 위치 오류' });
        if (client.events.length && body.after < client.events[0].seq - 1) return this.json(res, 409, { error: '음성 이벤트 유실. 통화를 다시 연결하세요.' });
        return this.json(res, 200, { events: client.events.filter(e => e.seq > body.after), cursor: client.seq });
      }
      if (url.pathname !== '/api/rpc' || !uuid.test(body.id) || !methods.has(body.method)) return this.json(res, 400, { error: '지원하지 않는 명령' });
      // Read polling must not consume the bounded mutation replay ledger.
      const mutation = body.method !== 'status' && body.method !== 'conversations';
      let work = mutation ? client.requests.get(body.id) : undefined;
      if (!work) {
        if (mutation && client.requests.size >= 256) return this.json(res, 429, { error: '명령 한도입니다. 다시 연결하세요.' });
        work = this.execute(client, body.method, body.params ?? {});
        if (mutation) client.requests.set(body.id, work); // Claim before awaiting; duplicate POST never starts another task.
      }
      try { return this.json(res, 200, { result: await work }); }
      catch (err) { return this.json(res, 409, { error: err instanceof Error ? err.message : '요청 실패' }); }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.json(res, 405, { error: '지원하지 않는 방식' });
    let relative: string;
    try { relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); } catch { return this.json(res, 400, { error: '경로 오류' }); }
    if (relative.includes('\\') || relative.split('/').some(v => v === '..' || v.startsWith('.'))) return this.json(res, 404, { error: '없음' });
    const file = path.resolve(this.staticRoot, '.' + relative);
    if (!file.startsWith(path.resolve(this.staticRoot) + path.sep)) return this.json(res, 404, { error: '없음' });
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mjs': 'text/javascript', '.webmanifest': 'application/manifest+json' };
    const mime = types[path.extname(file)];
    if (!mime) return this.json(res, 404, { error: '없음' });
    try {
      const bytes = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(self)',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { this.json(res, 404, { error: '휴대폰 화면 빌드가 필요합니다.' }); }
  }
  private execute(client: Client, method: string, params: any) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return Promise.reject(Error('명령 형식 오류'));
    if (method === 'voice') {
      const allowed = new Set(['start', 'stop', 'reply', 'speak', 'extend']);
      if (!allowed.has(params.action) || !uuid.test(params.sessionId)) return Promise.reject(Error('음성 요청 오류'));
      if (params.action === 'start') {
        if (client.voice && client.voice !== params.sessionId) return Promise.reject(Error('기존 통화를 종료하세요.'));
        if ([...this.clients.values()].some(other => other !== client && other.voice)) return Promise.reject(Error('다른 휴대폰에서 통화 중입니다.'));
        client.voice = params.sessionId;
      } else if (client.voice !== params.sessionId) return Promise.reject(Error('음성 연결 소유권 오류'));
    }
    const result = this.relay(client, method, params);
    if (method === 'voice' && params.action === 'stop') {
      return result.finally(() => { if (client.voice === params.sessionId) client.voice = undefined; });
    }
    if (method === 'voice' && params.action === 'start') {
      return result.catch(error => { if (client.voice === params.sessionId) client.voice = undefined; throw error; });
    }
    return result;
  }
}
