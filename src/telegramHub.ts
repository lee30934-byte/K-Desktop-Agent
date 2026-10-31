/**
 * v0.7.54 — 텔레그램 허브: 업데이트 처리 · 분배 · 요약 회신 · 버튼 · 진행 메시지 · 원격 승인 · 받은 파일함 · 아침 요약.
 *
 * React/Tauri 무의존 — 모든 외부 동작은 HubDeps 로 주입한다(scripts/telegram-hub.test.ts 가 가짜 API 로 검증).
 * 원칙:
 *  - 어떤 실패(AI·요약·이미지·버튼)도 텍스트 회신을 막지 않는다. 최후 수단은 원문 일부.
 *  - 결정 필요·오류는 조용한 시간에도 즉시 보낸다(규칙 판정, telegramDigest).
 *  - 기능별 설정이 꺼져 있으면 v0.7.53 과 같은 동작(원문 회신, 📱 텔레그램 대화 고정).
 */
import { parseElicitationSchema, validateElicitationContent } from "../sidecar/src/mcp-elicitation-schema.mjs";
import { absenceChat, absenceInstruction, restoreAbsence, ABSENCE_DEFAULT_HOURS, ABSENCE_MAX_HOURS,
  type AbsenceSession, type AbsenceTarget } from "./telegramAbsence";
import {
  decideRoutes,
  findTargetByAlias,
  labelReply,
  ReplyMap,
  FollowUpRegistry,
  type RouteTarget,
  type RouteDecision,
  type RouteExample,
} from "./telegramRouter";
import {
  classifyTier,
  deliveryPlan,
  extractChoices,
  extractImagePaths,
  unreachableImageRefs,
  inQuietHours,
  buildSummaryPrompt,
  fallbackSummary,
  encodeChoiceCallback,
  decodeChoiceCallback,
  encodeApprovalCallback,
  decodeApprovalCallback,
  type QuietHours,
  type DigestTier,
} from "./telegramDigest";

/** v0.7.68 — /방 으로 고른 방이 유지되는 시간. */
export const ROOM_PIN_MS = 10 * 60 * 1000;

export interface HubApi {
  /** Bot API 호출 (Rust telegram_call). 결과 JSON. */
  call(method: string, payload: Record<string, unknown>): Promise<any>;
  /** 로컬 파일 전송 (Rust telegram_send_file). */
  sendFile(chatId: string, path: string, caption: string): Promise<any>;
  /** 받은 파일 저장 (Rust telegram_download_file) → 저장 경로. */
  download(fileId: string, fileName: string | undefined, day: string): Promise<string>;
  /** 도구 없는 Luna 1회 호출 (Rust codex_oneshot). */
  oneshot(prompt: string): Promise<string>;
}

export interface HubSettings {
  routing: boolean;
  digest: boolean;
  buttons: boolean;
  progress: boolean;
  inbox: boolean;
  approvals: boolean;
  quiet: QuietHours;
  pcName: string;
}

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface HubDeps {
  api: HubApi;
  /** 지정 대화로 텔레그램 턴 시작 (App 의 sendTelegramTurn). */
  startTurn(convId: string, text: string, chatId: string): Promise<void>;
  targets(): RouteTarget[];
  defaultTarget(): { convId: string; label: string };
  settings(): HubSettings;
  now(): number;
  log(line: string): void;
  store: KeyValueStore;
  /** /상태 에 붙일 앱 상태 줄 (폴링·대기열 등). */
  statusLines?(): string[];
  activeConversations?(): AbsenceTarget[];
  allowedChat?(chatId: string): boolean;
  setTimeout?(fn: () => void, ms: number): unknown;
}

export const PROGRESS_FIRST_MS = 5 * 60 * 1000;
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
export const ABSENCE_DIGEST_WINDOW_MS = 10 * 60 * 1000;
export const MAX_IMAGES_PER_REPLY = 5;
const SUMMARY_MIN_CHARS = 600; // 이보다 짧으면 요약하지 않고 원문
const CHUNK = 4000;
const FULLTEXT_MAX = 100;

const K_REPLYMAP = "kda_tg_hub_replymap";
const K_EXAMPLES = "kda_tg_hub_examples";
const K_HELD = "kda_tg_hub_held";
const K_FOLLOWUPS = "kda_tg_hub_followups";
const K_ABSENCE = "kda_tg_hub_absence";
const K_OUTBOX = "kda_tg_hub_outbox";
const K_ABSENCE_DIGEST = "kda_tg_hub_absence_digest";
interface ResultDelivery { convId: string; chatId: string; text: string; turnId?: string; forceSend?: boolean; noChoices?: boolean; decisionRequired?: boolean }
interface AbsenceDigest { chatId: string; entries: Array<{ label: string; text: string; at: number }> }

interface HeldResult {
  label: string;
  summary: string;
  at: number;
}

interface PendingApproval {
  chatId: string;
  messageId?: number;
  resolve: (ok: boolean) => void;
  done: boolean;
  expiresAt: number;
}

function chunks(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK) out.push(text.slice(i, i + CHUNK));
  return out.length > 0 ? out : ["(빈 응답)"];
}

function localDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function shortToken(): string {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 12; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

export class TelegramHub {
  readonly replyMap: ReplyMap;
  readonly followUps: FollowUpRegistry;
  private absence: AbsenceSession | null;
  private absenceSaveFailed = false;
  private absenceDigest: AbsenceDigest | null;
  private absenceDigestTimer: unknown;
  private outbox: ResultDelivery[] = [];
  private flushingOutbox = false;
  private delivering = new Set<ResultDelivery>();
  private examples: RouteExample[];
  private held: HeldResult[];
  private fullText = new Map<number, string>();
  private lastReply: { convId: string; at: number } | undefined;
  private lastInbound: { text: string; chatId: string; convId: string } | undefined;
  /** v0.7.68 — /방 으로 고른 방. 다음 메시지 1건만 그 방으로 (10분 안). */
  private pinned: { convId: string; label: string; chatId: string; until: number } | undefined;
  private progressMsgs = new Map<string, { chatId: string; messageId: number; convId: string }>();
  private approvals = new Map<string, PendingApproval>();
  private inputs = new Map<string, { chatId: string; messageId?: number; schema: unknown; expiresAt: number;
    resolve: (value: Record<string, unknown> | null) => void }>();
  /** 최근 분배·오류 기록 (상태 카드/ /분배 용). */
  readonly recent: Array<{ at: number; kind: string; detail: string }> = [];

  constructor(private readonly d: HubDeps) {
    this.replyMap = ReplyMap.fromJSON(this.readJson(K_REPLYMAP));
    this.followUps = FollowUpRegistry.fromJSON(this.readJson(K_FOLLOWUPS), d.now());
    this.absence = restoreAbsence(this.readJson(K_ABSENCE), d.now());
    const digest = this.readJson(K_ABSENCE_DIGEST);
    this.absenceDigest = digest && typeof digest.chatId === "string" && Array.isArray(digest.entries)
      ? { chatId: digest.chatId, entries: digest.entries.filter((x: any) => x && typeof x.label === "string" && typeof x.text === "string" && Number.isFinite(x.at)).slice(-100) }
      : null;
    const outbox = this.readJson(K_OUTBOX);
    this.outbox = Array.isArray(outbox) ? outbox.filter(r => r && typeof r.convId === "string" &&
      typeof r.chatId === "string" && typeof r.text === "string") : [];
    const ex = this.readJson(K_EXAMPLES);
    this.examples = Array.isArray(ex) ? ex.filter((e) => e && typeof e.text === "string" && typeof e.convId === "string") : [];
    const h = this.readJson(K_HELD);
    this.held = Array.isArray(h) ? h.filter((x) => x && typeof x.summary === "string") : [];
  }

  // ── 저장 ────────────────────────────────────────────────
  private readJson(key: string): any {
    try {
      const v = this.d.store.get(key);
      return v ? JSON.parse(v) : null;
    } catch {
      return null; // 깨진 저장값은 빈 상태로 시작 (유지보수: 자가 복구)
    }
  }
  private persist(): void {
    try {
      this.d.store.set(K_REPLYMAP, JSON.stringify(this.replyMap.toJSON()));
      this.d.store.set(K_EXAMPLES, JSON.stringify(this.examples.slice(-50)));
      this.d.store.set(K_HELD, JSON.stringify(this.held.slice(-50)));
      this.d.store.set(K_FOLLOWUPS, JSON.stringify(this.followUps.toJSON()));
      this.d.store.set(K_ABSENCE, JSON.stringify(this.absence));
      this.d.store.set(K_OUTBOX, JSON.stringify(this.outbox));
      this.d.store.set(K_ABSENCE_DIGEST, JSON.stringify(this.absenceDigest));
      this.absenceSaveFailed = false;
    } catch (e) {
      this.absenceSaveFailed = true;
      this.d.log(`HUB persist-failed ${String(e).slice(0, 120)}`);
    }
  }
  private note(kind: string, detail: string): void {
    this.recent.push({ at: this.d.now(), kind, detail });
    if (this.recent.length > 30) this.recent.shift();
    this.d.log(`HUB ${kind} ${detail}`);
  }

  /** Uses the frozen desktop subscription before the normal follow-up binding. */
  chatFor(convId: string | undefined, now: number): string | undefined {
    const chat = absenceChat(this.absence, convId, now) ?? this.followUps.chatFor(convId, now);
    return chat && (!this.d.allowedChat || this.d.allowedChat(chat)) ? chat : undefined;
  }

  /** An active, explicit subscription; ordinary follow-up bindings do not enable autonomy. */
  activeAbsenceChatFor(convId: string | undefined, now: number): string | undefined {
    const chat = absenceChat(this.absence, convId, now);
    return chat && (!this.d.allowedChat || this.d.allowedChat(chat)) ? chat : undefined;
  }

  instructionFor(convId: string | undefined, now: number): string {
    const chat = absenceChat(this.absence, convId, now);
    return chat && (!this.d.allowedChat || this.d.allowedChat(chat)) ? absenceInstruction(this.absence, convId, now) : '';
  }

  private routingTargets(): RouteTarget[] {
    // v0.7.68 — /분배 목록 순서대로 번호 별칭(@1, @2 …)을 자동으로 붙인다. 설정의 별칭은 그대로 유지.
    const targets = this.d.targets().map((t, i) => (t.aliases.includes(String(i + 1)) ? t : { ...t, aliases: [...t.aliases, String(i + 1)] }));
    if (this.absence && this.d.now() < this.absence.until) for (const t of this.absence.targets) {
      if (!targets.some(x => x.convId === t.convId)) targets.push({ ...t, aliases: [], description: t.label });
    }
    return targets;
  }

  private async cmdAbsence(chatId: string, argument: string): Promise<void> {
    if (/^(off|종료|끄기)$/i.test(argument)) {
      if (this.absence && this.absence.chatId !== chatId) {
        await this.sendText(chatId, "다른 채팅의 부재 연결은 변경할 수 없습니다.", undefined); return;
      }
      this.absence = null; this.persist();
      await this.sendText(chatId, this.absenceSaveFailed ? "⚠ 종료 저장 실패 — 재시작 후 상태 재확인 필요" : "부재 알림 연결을 종료했습니다. 작업 정지·승인 설정은 유지됩니다.", undefined);
      return;
    }
    const hours = argument ? Number(argument) : ABSENCE_DEFAULT_HOURS;
    if (!Number.isFinite(hours) || hours < 1 || hours > ABSENCE_MAX_HOURS) {
      await this.sendText(chatId, "사용법: /부재 36 (1~48시간) 또는 /부재 종료", undefined); return;
    }
    if (this.absence && this.d.now() < this.absence.until && this.absence.chatId !== chatId) {
      await this.sendText(chatId, "다른 채팅의 부재 연결이 유지 중입니다.", undefined); return;
    }
    const now = this.d.now();
    const activeTargets = this.d.activeConversations?.() ?? [];
    if (!activeTargets.length) {
      const existing = this.absence && now < this.absence.until && this.absence.chatId === chatId;
      await this.sendText(chatId, existing
        ? `새 연결 대상은 0건입니다. 기존 부재 연결 ${this.absence!.targets.length}건은 만료 시각까지 유지됩니다.`
        : "부재 모드를 켜지 않았습니다. 연결 가능한 진행·복구 대기 작업이 0건입니다.", undefined);
      return;
    }
    this.absence = restoreAbsence({ chatId, startedAt: now, until: now + hours * 3600000,
      targets: activeTargets }, now);
    this.persist();
    const targets = this.absence?.targets ?? [];
    await this.sendText(chatId, this.absenceSaveFailed ? "⚠ 부재 연결 저장 실패 — 재시작 복원을 보장할 수 없습니다." :
      `부재 알림 ${hours}시간 · 현재 작업 ${targets.length}개 연결\n${targets.map(t => `- ${t.label}`).join("\n")}\n기존 작업의 결과·결정 요청을 전달합니다. 새 작업 시작이나 별도 승인은 포함하지 않습니다.`, undefined);
  }

  private labelOf(convId: string): { label: string; isDefault: boolean } {
    const def = this.d.defaultTarget();
    if (convId === def.convId) return { label: def.label, isDefault: true };
    const t = this.routingTargets().find((x) => x.convId === convId);
    return { label: t ? t.label : convId.slice(0, 8), isDefault: false };
  }

  // ── 송신 ────────────────────────────────────────────────
  /** 텍스트 전송. 마지막 조각에 버튼. 보낸 message_id 들을 대화에 연결. 실패해도 throw 하지 않고 false. */
  async sendText(chatId: string, text: string, convId: string | undefined, replyMarkup?: unknown, full?: string): Promise<number | undefined> {
    if (this.d.allowedChat && !this.d.allowedChat(chatId)) return undefined;
    const parts = chunks(text);
    let lastId: number | undefined;
    for (let i = 0; i < parts.length; i++) {
      const payload: Record<string, unknown> = { chat_id: chatId, text: parts[i], disable_web_page_preview: true };
      if (replyMarkup && i === parts.length - 1) payload.reply_markup = replyMarkup;
      let res: any;
      try {
        res = await this.d.api.call("sendMessage", payload);
      } catch (e) {
        // 버튼 때문에 실패했을 수 있으니 버튼 없이 1회 재시도
        if (payload.reply_markup) {
          delete payload.reply_markup;
          try {
            res = await this.d.api.call("sendMessage", payload);
          } catch (e2) {
            this.note("SEND-FAILED", String(e2).slice(0, 160));
            return undefined;
          }
        } else {
          this.note("SEND-FAILED", String(e).slice(0, 160));
          return undefined;
        }
      }
      const mid = res?.result?.message_id;
      if (typeof mid === "number") {
        lastId = mid;
        // v0.7.56 — 성공 전송도 기록 (0.7.54 실사용 점검에서 '보냈다' 증거가 로그에 없었다)
        this.d.log(`HUB SENT conv=${convId ? convId.slice(0, 8) : "-"} mid=${mid} part=${i + 1}/${parts.length} len=${parts[i].length}${payload.reply_markup ? " buttons" : ""}`);
        if (convId) this.replyMap.remember(mid, convId);
        if (full) {
          this.fullText.set(mid, full);
          while (this.fullText.size > FULLTEXT_MAX) this.fullText.delete(this.fullText.keys().next().value as number);
        }
      }
    }
    if (convId) this.persist();
    return lastId;
  }

  // ── 수신 ────────────────────────────────────────────────
  /** 허용 chat 검증은 호출부(App)가 이미 했다고 가정. */
  async handleUpdate(u: any): Promise<void> {
    if (u?.callback_query) {
      const chat = String(u.callback_query?.message?.chat?.id ?? "");
      if (this.d.allowedChat && !this.d.allowedChat(chat)) return;
      return this.handleCallback(u.callback_query);
    }
    const msg = u?.message;
    if (!msg) return;
    const chatId = msg.chat?.id != null ? String(msg.chat.id) : "";
    if (!chatId || (this.d.allowedChat && !this.d.allowedChat(chatId))) return;
    const s = this.d.settings();

    // 첨부 (④)
    let text: string = typeof msg.text === "string" ? msg.text : typeof msg.caption === "string" ? msg.caption : "";
    const photo = Array.isArray(msg.photo) && msg.photo.length > 0 ? msg.photo[msg.photo.length - 1] : undefined;
    const doc = msg.document;
    if (photo || doc) {
      if (!s.inbox) {
        await this.sendText(chatId, "📎 파일 받기가 꺼져 있어요. KDA 설정 → 텔레그램에서 켤 수 있습니다.", undefined);
        if (!text) return;
      } else {
        try {
          const fileId = photo ? photo.file_id : doc.file_id;
          const name = doc?.file_name ?? (photo ? `photo_${msg.message_id ?? "x"}.jpg` : undefined);
          const saved = await this.d.api.download(String(fileId), name, localDay(this.d.now()));
          this.note("INBOX", saved);
          text = `${text ? text + "\n\n" : ""}[텔레그램 첨부 파일] ${saved}`;
        } catch (e) {
          this.note("INBOX-FAILED", String(e).slice(0, 160));
          await this.sendText(chatId, `📎 파일 저장 실패: ${String(e).slice(0, 200)}`, undefined);
          if (!text) return;
        }
      }
    }
    if (!text.trim()) return;

    // 명령
    const trimmed = text.trim();
    const absenceCommand = /^\/(부재|absence)(?:@\S+)?(?:\s+(.*))?$/i.exec(trimmed);
    if (absenceCommand) return this.cmdAbsence(chatId, (absenceCommand[2] ?? "").trim());
    if (/^\/(상태|status)(?:@\S+)?(?:\s|$)/i.test(trimmed)) return this.cmdStatus(chatId);
    if (/^\/(부재검증|absence_test)(?:@\S+)?\s*$/i.test(trimmed)) {
      const convId = this.d.defaultTarget().convId;
      const probe = this.requestApproval({ convId, chatId, timeoutMs: 120000,
        detail: "부재 운영 송수신 검증입니다. 승인 버튼은 이 검증에만 응답하며 명령·파일·전원 작업을 실행하지 않습니다." });
      void probe.result.then(ok => {
        this.note("ABSENCE-PROBE", ok ? "PASS phone-callback" : "HOLD declined-or-expired");
        return this.deliverResult({ convId, chatId, forceSend: true,
          text: ok ? "✅ 휴대폰 승인 버튼 왕복 PASS. 명령 실행은 하지 않았습니다. 설치 버전·부재 연결은 /상태로 확인하세요."
            : "⚠ 휴대폰 승인 버튼 왕복 HOLD — 거절·만료·전송 실패. 실제 명령은 실행하지 않았습니다." });
      });
      return;
    }
    if (/^\/(도움|help|start)(?:@\S+)?(?:\s|$)/i.test(trimmed)) return this.cmdHelp(chatId);
    if (/^\/(분배|route)(?:@\S+)?(?:\s|$)/i.test(trimmed)) return this.cmdRoutes(chatId);
    const room = /^\/(방|room)(?:@\S+)?(?:\s+(\S+))?\s*$/i.exec(trimmed);
    if (room) return this.cmdRoom(chatId, room[2]);
    const mv = /^\/(이동|move)\s+@?(\S+)\s*$/i.exec(trimmed);
    if (mv) return this.cmdMove(chatId, mv[2]);

    // "자세히" 답장 → 원문
    const replyToId: number | undefined = msg.reply_to_message?.message_id;
    if (replyToId !== undefined) {
      const input = [...this.inputs.entries()].find(([, p]) => p.chatId === chatId && p.messageId === replyToId);
      if (input) {
        const [token, p] = input;
        if (this.d.now() >= p.expiresAt || !this.d.settings().approvals) {
          this.inputs.delete(token); p.resolve(null);
          await this.sendText(chatId, "입력 요청이 만료됐거나 원격승인이 꺼졌습니다. 실행하지 않고 보류합니다.", undefined); return;
        }
        if (/^(취소|거절|cancel)$/i.test(trimmed)) { this.inputs.delete(token); p.resolve(null); return; }
        let value: unknown;
        try { value = JSON.parse(trimmed); } catch { value = null; }
        if (!validateElicitationContent(p.schema, value)) {
          await this.sendText(chatId, "입력 형식이 맞지 않습니다. 원래 입력 요청에 JSON으로 답장하거나 '취소'로 답장해 주세요.", undefined); return;
        }
        this.inputs.delete(token); p.resolve(value as Record<string, unknown>);
        await this.sendText(chatId, "입력 응답을 전달했습니다 (해당 요청 1회만).", undefined); return;
      }
    }
    if (replyToId !== undefined && /^(자세히|전문|원문|full)$/i.test(trimmed)) {
      const full = this.fullText.get(replyToId);
      await this.sendText(chatId, full ?? "원문을 찾지 못했어요 (오래됐거나 KDA 재시작 후).", this.replyMap.lookup(replyToId));
      return;
    }

    await this.route(text, chatId, replyToId);
  }

  private async route(text: string, chatId: string, replyToId?: number): Promise<void> {
    const s = this.d.settings();
    const def = this.d.defaultTarget();
    let decisions: RouteDecision[];
    const pin = this.pinned && this.pinned.chatId === chatId && this.d.now() < this.pinned.until && replyToId === undefined ? this.pinned : undefined;
    this.pinned = undefined;
    if (pin) {
      decisions = [{ convId: pin.convId, label: pin.label, source: "pinned", text }];
    } else if (!s.routing) {
      decisions = [{ convId: def.convId, label: def.label, source: "default", text }];
    } else {
      decisions = await decideRoutes({
        text,
        replyToConvId: this.replyMap.lookup(replyToId),
        lastReply: this.lastReply,
        now: this.d.now(),
        targets: this.routingTargets(),
        defaultTarget: def,
        classify: (p) => this.d.api.oneshot(p),
        examples: this.examples,
      });
    }
    if (decisions.length > 1) {
      await this.routeSplit(decisions, text, chatId, def);
      return;
    }
    const decision = decisions[0];
    this.note("ROUTE", `conv=${decision.convId.slice(0, 8)} by=${decision.source}${decision.confidence != null ? ` conf=${decision.confidence}` : ""}${decision.note ? ` note=${decision.note}` : ""}`);
    this.lastInbound = { text: decision.text, chatId, convId: decision.convId };
    if (decision.convId !== def.convId) {
      this.followUps.mark(decision.convId, chatId, this.d.now());
      this.persist();
      await this.sendText(chatId, `→ [${decision.label}]로 전달${decision.source === "ai" ? " (자동 분류)" : ""}. 잘못됐으면 /이동 별칭`, decision.convId);
    } else if (decision.note && decision.note.startsWith("classify-failed")) {
      await this.sendText(chatId, "ℹ 자동 분류 실패 — 📱 텔레그램 대화에서 처리합니다.", def.convId);
    }
    try {
      await this.d.startTurn(decision.convId, decision.text, chatId);
    } catch (e) {
      this.note("START-FAILED", String(e).slice(0, 160));
      await this.sendText(chatId, `⚠ 처리 시작 실패: ${String(e).slice(0, 200)}`, undefined);
    }
  }

  /** v0.7.68 — 복합 명령: 대상별로 나눠 각각 턴 시작, 접수 확인은 1건. 한 대상 실패가 나머지를 막지 않는다. */
  private async routeSplit(decisions: RouteDecision[], text: string, chatId: string, def: { convId: string; label: string }): Promise<void> {
    for (const d of decisions) {
      this.note("ROUTE", `conv=${d.convId.slice(0, 8)} by=${d.source}${d.confidence != null ? ` conf=${d.confidence}` : ""}${d.note ? ` note=${d.note}` : ""}`);
      if (d.convId !== def.convId) this.followUps.mark(d.convId, chatId, this.d.now());
    }
    this.persist();
    // /이동 은 원문 전체를 한 대화로 다시 보내는 용도로 남긴다.
    this.lastInbound = { text, chatId, convId: decisions[0].convId };
    const preview = (d: RouteDecision) => d.text.split("\n\n[텔레그램 복합 명령")[0].replace(/\s+/g, " ").slice(0, 60);
    await this.sendText(
      chatId,
      ["→ 나눠서 전달 (자동 분류):", ...decisions.map((d) => `- [${d.label}] ${preview(d)}`), "잘못됐으면 /이동 별칭 (원문 전체를 그 대화로)"].join("\n"),
      undefined,
    );
    for (const d of decisions) {
      try {
        await this.d.startTurn(d.convId, d.text, chatId);
      } catch (e) {
        this.note("START-FAILED", `${d.convId.slice(0, 8)} ${String(e).slice(0, 140)}`);
        await this.sendText(chatId, `⚠ [${d.label}] 처리 시작 실패: ${String(e).slice(0, 200)}`, undefined);
      }
    }
  }

  private async handleCallback(cq: any): Promise<void> {
    const data: string = typeof cq?.data === "string" ? cq.data : "";
    const chatId = cq?.message?.chat?.id != null ? String(cq.message.chat.id) : "";
    const answer = (text: string) =>
      this.d.api.call("answerCallbackQuery", { callback_query_id: cq.id, text }).catch(() => {});

    const ap = decodeApprovalCallback(data);
    if (ap) {
      const p = this.approvals.get(ap.token);
      if (!p || p.done || this.d.now() >= p.expiresAt || p.chatId !== chatId || p.messageId !== cq?.message?.message_id) {
        await answer("이미 처리됐거나 만료된 요청입니다.");
        return;
      }
      p.done = true;
      this.approvals.delete(ap.token);
      const accepted = ap.approve && this.d.settings().approvals;
      p.resolve(accepted);
      this.note("APPROVAL", `${accepted ? "accept" : "decline"} token=${ap.token}`);
      await answer(accepted ? "승인했습니다 (이 요청 1회만)" : "거절했습니다 (원격승인 꺼짐 포함)");
      if (p.messageId !== undefined) {
        void this.d.api
          .call("editMessageReplyMarkup", { chat_id: p.chatId, message_id: p.messageId, reply_markup: { inline_keyboard: [] } })
          .catch(() => {});
      }
      return;
    }

    const rm = /^room:(\d+):([0-9a-zA-Z-]{1,8})$/.exec(data);
    if (rm && chatId) {
      const t = this.roomList()[Number(rm[1])];
      if (!t || t.convId.slice(0, 8) !== rm[2]) {
        await answer("방 목록이 바뀌었어요. /방 으로 다시 열어 주세요.");
        return;
      }
      await answer(`${t.label} 선택`);
      if (typeof cq?.message?.message_id === "number") {
        void this.d.api
          .call("editMessageReplyMarkup", { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } })
          .catch(() => {});
      }
      return this.pinRoom(chatId, t);
    }

    const ch = decodeChoiceCallback(data);
    if (ch && chatId) {
      const all = [...this.routingTargets(), { ...this.d.defaultTarget(), aliases: [], description: "" }];
      const matching = all.filter((x) => x.convId.slice(0, 8) === ch.convPrefix);
      const t = matching.length === 1 && this.replyMap.lookup(cq?.message?.message_id) === matching[0].convId ? matching[0] : undefined;
      if (!t) {
        await answer("대상 대화를 찾지 못했어요.");
        return;
      }
      await answer(`${ch.key}번 전달`);
      this.note("CHOICE", `conv=${t.convId.slice(0, 8)} key=${ch.key}`);
      this.followUps.mark(t.convId, chatId, this.d.now());
      this.persist();
      // 버튼 제거(중복 클릭 방지)
      if (typeof cq?.message?.message_id === "number") {
        void this.d.api
          .call("editMessageReplyMarkup", { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } })
          .catch(() => {});
      }
      try {
        await this.d.startTurn(t.convId, ch.key, chatId);
      } catch (e) {
        await this.sendText(chatId, `⚠ 처리 시작 실패: ${String(e).slice(0, 200)}`, undefined);
      }
      return;
    }
    await answer("알 수 없는 버튼");
  }

  // ── 명령 ────────────────────────────────────────────────
  private async cmdStatus(chatId: string): Promise<void> {
    const s = this.d.settings();
    const onoff = (b: boolean) => (b ? "켜짐" : "꺼짐");
    const lines = [
      "📊 KDA 텔레그램 상태",
      this.absence && this.d.now() < this.absence.until
        ? `부재 연결 ${this.absence.targets.length}개 · 만료 ${new Date(this.absence.until).toLocaleString("ko-KR")} · 저장 ${this.absenceSaveFailed ? "실패" : "정상"}`
        : "부재 연결 꺼짐",
      ...(this.d.statusLines?.() ?? []),
      `분배 ${onoff(s.routing)} · 요약 ${onoff(s.digest)} · 버튼 ${onoff(s.buttons)} · 진행알림 ${onoff(s.progress)} · 파일받기 ${onoff(s.inbox)} · 원격승인 ${onoff(s.approvals)}`,
      `조용한 시간 ${s.quiet.enabled ? `${s.quiet.startHour}시~${s.quiet.endHour}시` : "꺼짐"} · 보류된 결과 ${this.held.length}건`,
      `진행 중 알림 ${this.progressMsgs.size}건 · 승인 대기 ${this.approvals.size + this.inputs.size}건 · 재전송 대기 ${this.outbox.length}건`,
    ];
    const rec = this.recent.slice(-5).map((r) => `- ${new Date(r.at).toLocaleTimeString("ko-KR", { hour12: false })} ${r.kind} ${r.detail}`);
    if (rec.length) lines.push("최근 기록:", ...rec);
    await this.sendText(chatId, lines.join("\n"), undefined);
  }

  private async cmdHelp(chatId: string): Promise<void> {
    await this.sendText(
      chatId,
      [
        "🤖 사용법",
        "- 그냥 보내면 주제에 맞는 대화로 자동 분배됩니다.",
        "- 여러 작업을 한 메시지로 보내면 대화별로 나눠 각각 전달합니다 (예: CAE는 … 음악공유방은 …).",
        "- @별칭 내용 → 그 대화로 바로 (/분배 로 별칭 확인). @1, @2 처럼 번호도 됩니다.",
        "- /방 → 방 버튼 목록, 누르면 다음 메시지 1건이 그 방으로 (/방 2 처럼 번호로도)",
        "- 봇 메시지에 답장 → 그 메시지를 보낸 대화로",
        "- 요약 메시지에 '자세히' 답장 → 원문",
        "- /이동 별칭 → 직전 메시지를 다른 대화로 다시 보내고 분류기에 학습",
        "- /상태 → 브리지 상태와 최근 기록",
        "- /부재 36 → 현재 작업만 36시간 알림 연결 (재시작 복원), /부재 종료",
        "- /부재검증 → 명령 실행 없는 휴대폰 승인 버튼 왕복 시험",
        "- 사진·파일을 보내면 미니PC inbox 에 저장 후 경로를 함께 전달",
      ].join("\n"),
      undefined,
    );
  }

  private async cmdRoutes(chatId: string): Promise<void> {
    const ts = this.d.targets();
    const lines = ["🧭 분배 대상", `- (기본) ${this.d.defaultTarget().label}`];
    ts.forEach((t, i) => lines.push(`- ${i + 1}. ${t.label} — @${i + 1}${t.aliases.filter((a) => a !== String(i + 1)).map((a) => ` @${a}`).join("")}`));
    if (ts.length > 0) lines.push("방 이름 대신 @번호 를 앞에 붙이거나, /방 으로 버튼을 눌러 고를 수 있어요.");
    if (ts.length === 0) lines.push("(분배 허용 대화 없음 — KDA 설정에서 추가)");
    await this.sendText(chatId, lines.join("\n"), undefined);
  }

  /** v0.7.68 — /방 : 방 버튼 목록. /방 2 : 2번 방을 바로 고름. 고른 방으로 다음 메시지 1건이 갑니다. */
  private async cmdRoom(chatId: string, arg?: string): Promise<void> {
    const list = this.roomList();
    if (arg !== undefined) {
      const n = Number(arg.replace(/^@/, ""));
      const t = Number.isInteger(n) ? list[n] : undefined;
      if (!t) {
        await this.sendText(chatId, `'${arg}' 번 방이 없어요. /방 으로 목록을 보세요.`, undefined);
        return;
      }
      return this.pinRoom(chatId, t);
    }
    const rows = list.map((t, i) => [{ text: `${i}. ${t.label}`.slice(0, 40), callback_data: `room:${i}:${t.convId.slice(0, 8)}` }]);
    await this.sendText(chatId, "📌 보낼 방을 고르세요. 다음 메시지 1건이 그 방으로 갑니다 (10분 안).", undefined, { inline_keyboard: rows });
  }

  /** 0 = 기본 대화, 1.. = /분배 순서. */
  private roomList(): Array<{ convId: string; label: string }> {
    const def = this.d.defaultTarget();
    return [{ convId: def.convId, label: def.label }, ...this.routingTargets().map((t) => ({ convId: t.convId, label: t.label }))];
  }

  private async pinRoom(chatId: string, t: { convId: string; label: string }): Promise<void> {
    this.pinned = { convId: t.convId, label: t.label, chatId, until: this.d.now() + ROOM_PIN_MS };
    this.note("PIN", `conv=${t.convId.slice(0, 8)}`);
    await this.sendText(chatId, `📌 다음 메시지는 [${t.label}]로 보냅니다 (10분 안).`, undefined);
  }

  private async cmdMove(chatId: string, alias: string): Promise<void> {
    const t = findTargetByAlias(alias, this.d.targets()) ??
      this.d.targets().find((x) => x.label.replace(/\s+/g, "").toLowerCase() === alias.toLowerCase());
    if (!t) {
      await this.sendText(chatId, `'${alias}' 별칭을 찾지 못했어요. /분배 로 목록 확인.`, undefined);
      return;
    }
    const last = this.lastInbound;
    if (!last) {
      await this.sendText(chatId, "옮길 직전 메시지가 없어요.", undefined);
      return;
    }
    this.examples.push({ text: last.text, convId: t.convId });
    this.persist();
    this.note("MOVE", `to=${t.convId.slice(0, 8)} learned=${this.examples.length}`);
    this.followUps.mark(t.convId, chatId, this.d.now());
    this.persist();
    this.lastInbound = { ...last, convId: t.convId };
    await this.sendText(chatId, `↪ [${t.label}]로 다시 보냅니다. 다음부터 비슷한 메시지는 이쪽으로 분류합니다.`, t.convId);
    try {
      await this.d.startTurn(t.convId, last.text, chatId);
    } catch (e) {
      await this.sendText(chatId, `⚠ 처리 시작 실패: ${String(e).slice(0, 200)}`, undefined);
    }
  }

  /** Ambiguous updates are reported without executing or rerouting them. */
  async notifyUncertainUpdate(chatId: string, updateId: number): Promise<boolean> {
    return await this.sendText(chatId,
      `⚠ 텔레그램 요청 #${updateId}의 실행 여부를 확정할 수 없습니다. 중복 실행을 막기 위해 보류했습니다. 대상 대화의 작업 상태를 확인한 뒤 필요하면 명령을 다시 보내 주세요.`, undefined) !== undefined;
  }

  // ── 결과 회신 ───────────────────────────────────────────
  /**
   * 턴 결과 회신. App 의 done/error/stale 경로가 모두 이 함수를 부른다.
   * forceSend: 오류·중지 안내처럼 등급과 무관하게 즉시 보내야 하는 경우.
   */
  async deliverResult(r: ResultDelivery): Promise<void> {
    if (!r.forceSend && !r.decisionRequired && this.absenceChatFor(r.convId, r.chatId)) {
      if (r.turnId) await this.finishProgress(r.turnId, true);
      const tier = classifyTier(r.text);
      if (tier === "result" || tier === "progress") {
        this.queueAbsenceDigest(r);
        return;
      }
      await this.flushAbsenceDigest("긴급 알림 전에 요약을 전송했습니다.");
    }
    const pending = { ...r };
    this.outbox.push(pending); this.persist();
    await this.deliverPending(pending);
  }

  private absenceChatFor(convId: string, chatId: string): boolean {
    return this.absence?.chatId === chatId && !!absenceChat(this.absence, convId, this.d.now()) &&
      (!this.d.allowedChat || this.d.allowedChat(chatId));
  }

  private queueAbsenceDigest(r: ResultDelivery): void {
    if (!this.absenceDigest || this.absenceDigest.chatId !== r.chatId) this.absenceDigest = { chatId: r.chatId, entries: [] };
    const { label } = this.labelOf(r.convId);
    this.absenceDigest.entries.push({ label, text: r.text.trim() || "(빈 응답)", at: this.d.now() });
    this.absenceDigest.entries = this.absenceDigest.entries.slice(-100);
    this.persist();
    if (this.absenceDigestTimer !== undefined) return;
    const set = this.d.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.absenceDigestTimer = set(() => {
      this.absenceDigestTimer = undefined;
      void this.flushAbsenceDigest();
    }, ABSENCE_DIGEST_WINDOW_MS);
    this.note("ABSENCE-DIGEST-QUEUED", `count=${this.absenceDigest.entries.length}`);
  }

  private async flushAbsenceDigest(reason?: string): Promise<void> {
    const digest = this.absenceDigest;
    if (!digest?.entries.length) return;
    this.absenceDigest = null;
    this.absenceDigestTimer = undefined;
    this.persist();
    const body = digest.entries.map((e, i) => `${i + 1}. [${e.label}]\n${fallbackSummary(e.text, 500)}`).join("\n\n");
    const text = `📋 부재중 작업 요약 · ${digest.entries.length}건${reason ? `\n${reason}` : ""}\n\n${body}`;
    const mid = await this.sendText(digest.chatId, text, undefined);
    if (mid === undefined) {
      this.absenceDigest = digest;
      this.persist();
      this.note("ABSENCE-DIGEST-FAILED", `count=${digest.entries.length}`);
    } else this.note("ABSENCE-DIGEST-SENT", `count=${digest.entries.length}`);
  }

  private async deliverPending(r: ResultDelivery): Promise<boolean> {
    if (this.delivering.has(r)) return false;
    if (this.d.allowedChat && !this.d.allowedChat(r.chatId)) return false;
    this.delivering.add(r);
    try {
      if (!await this.deliverResultNow(r)) return false;
      this.outbox = this.outbox.filter(x => x !== r); this.persist();
      return true;
    } finally { this.delivering.delete(r); }
  }

  private async flushOutbox(): Promise<void> {
    if (this.flushingOutbox) return;
    this.flushingOutbox = true;
    try {
      for (const r of [...this.outbox]) {
        if (this.d.allowedChat && !this.d.allowedChat(r.chatId)) continue;
        if (this.delivering.has(r)) continue;
        if (!await this.deliverPending(r)) break;
      }
    } finally { this.flushingOutbox = false; }
  }

  private async deliverResultNow(r: ResultDelivery): Promise<boolean> {
    const s = this.d.settings();
    const { label, isDefault } = this.labelOf(r.convId);
    if (r.turnId) await this.finishProgress(r.turnId, true);
    const pc = s.pcName.trim() ? `[${s.pcName.trim()}] ` : "";
    const raw = r.text && r.text.trim() ? r.text : "(빈 응답)";

    if (!s.digest) {
      const mid = await this.sendText(r.chatId, pc + labelReply(raw, label, isDefault), r.convId, r.noChoices ? undefined : this.choiceMarkup(r.convId, raw), raw);
      if (mid !== undefined) this.lastReply = { convId: r.convId, at: this.d.now() };
      if (mid !== undefined) await this.sendImages(r.chatId, r.convId, label, raw);
      return mid !== undefined;
    }

    const tier: DigestTier = r.decisionRequired ? "decision" : r.forceSend ? "error" : classifyTier(raw);
    const plan = r.forceSend ? "send" : deliveryPlan(tier, inQuietHours(s.quiet, new Date(this.d.now())));
    if (plan === "skip") {
      this.note("SKIP-PROGRESS", `conv=${r.convId.slice(0, 8)} len=${raw.length}`);
      return true;
    }
    const body = await this.summarize(label, tier, raw);
    if (plan === "hold") {
      this.held.push({ label, summary: body, at: this.d.now() });
      this.persist();
      this.note("HOLD", `conv=${r.convId.slice(0, 8)} quiet`);
      return true;
    }
    const icon = tier === "error" ? "❌ " : tier === "decision" ? "❓ " : "✅ ";
    const markup = tier === "decision" && !r.noChoices ? this.choiceMarkup(r.convId, raw) : undefined;
    const mid = await this.sendText(r.chatId, pc + icon + labelReply(body, label, isDefault), r.convId, markup, raw);
    if (mid !== undefined) this.lastReply = { convId: r.convId, at: this.d.now() };
    if (mid !== undefined) await this.sendImages(r.chatId, r.convId, label, raw);
    return mid !== undefined;
  }

  private choiceMarkup(convId: string, text: string): unknown | undefined {
    if (!this.d.settings().buttons) return undefined;
    const choices = extractChoices(text.slice(-1500));
    if (choices.length < 2) return undefined;
    return {
      inline_keyboard: choices.map((c) => [{ text: `${c.key}. ${c.label}`, callback_data: encodeChoiceCallback(convId, c.key) }]),
    };
  }

  private async summarize(label: string, tier: DigestTier, raw: string): Promise<string> {
    if (raw.length < SUMMARY_MIN_CHARS) return raw;
    let summary: string;
    try {
      summary = (await this.d.api.oneshot(buildSummaryPrompt(label, tier, raw))).trim();
      if (!summary) throw new Error("empty");
      this.d.log(`HUB SUMMARY ok tier=${tier} in=${raw.length} out=${summary.length}`);
    } catch (e) {
      this.note("SUMMARY-FAILED", String(e).slice(0, 120));
      summary = fallbackSummary(raw);
    }
    if (tier === "decision") {
      // 선택지는 원문 그대로 붙인다 (요약이 선택지를 바꾸지 못하게)
      const choices = extractChoices(raw.slice(-1500));
      if (choices.length >= 2) summary += "\n\n" + choices.map((c) => `${c.key}. ${c.label}`).join("\n");
    }
    return summary + "\n(전문: 이 메시지에 '자세히' 답장)";
  }

  private async sendImages(chatId: string, convId: string, label: string, raw: string): Promise<void> {
    const paths = extractImagePaths(raw);
    const failed: string[] = [];
    for (const p of paths.slice(0, MAX_IMAGES_PER_REPLY)) {
      const name = p.split("/").pop() ?? p;
      try {
        const res = await this.d.api.sendFile(chatId, p, `[${label}] ${name}`);
        const mid = res?.result?.message_id;
        if (typeof mid === "number") this.replyMap.remember(mid, convId);
        this.d.log(`HUB PHOTO ok conv=${convId.slice(0, 8)} file=${name} mid=${mid ?? "-"}`);
      } catch (e) {
        this.d.log(`HUB PHOTO failed conv=${convId.slice(0, 8)} file=${name} err=${String(e).slice(0, 120)}`);
        const code = String(e).split(":")[0].replace(/^Error\s*/, "");
        failed.push(`${name}(${code === "not_found" ? "파일 없음" : code === "too_large" ? "용량 초과" : "전송 오류"})`);
      }
    }
    const extra = paths.length - MAX_IMAGES_PER_REPLY;
    const remote = unreachableImageRefs(raw);
    const notes: string[] = [];
    if (failed.length) notes.push(`🖼 이미지 ${failed.length}장 전송 실패: ${failed.join(", ")}`);
    if (extra > 0) notes.push(`🖼 이미지 ${extra}장 더 있음 (최대 ${MAX_IMAGES_PER_REPLY}장 전송)`);
    if (remote.length) notes.push(`🖼 미니PC에서 읽을 수 없는 경로 ${remote.length}개 (VM/WSL): ${remote.slice(0, 3).join(", ")}`);
    if (notes.length) await this.sendText(chatId, notes.join("\n"), convId);
    if (paths.length) this.persist();
  }

  // ── 진행 메시지 (②) ─────────────────────────────────────
  /** App 이 진행 중인 텔레그램발 턴마다 1분 주기로 호출. */
  async tickProgress(turnId: string, convId: string, chatId: string, startedAt: number): Promise<void> {
    if (!this.d.settings().progress) return;
    const elapsed = this.d.now() - startedAt;
    if (elapsed < PROGRESS_FIRST_MS) return;
    const { label } = this.labelOf(convId);
    const text = `⏳ [${label}] 진행 중 ${Math.floor(elapsed / 60000)}분`;
    const cur = this.progressMsgs.get(turnId);
    if (!cur) {
      try {
        const res = await this.d.api.call("sendMessage", { chat_id: chatId, text, disable_notification: true });
        const mid = res?.result?.message_id;
        if (typeof mid === "number") {
          this.progressMsgs.set(turnId, { chatId, messageId: mid, convId });
          this.replyMap.remember(mid, convId);
        }
      } catch (e) {
        this.note("PROGRESS-FAILED", String(e).slice(0, 120));
      }
      return;
    }
    await this.d.api.call("editMessageText", { chat_id: cur.chatId, message_id: cur.messageId, text }).catch(() => {});
  }

  async finishProgress(turnId: string, ok: boolean): Promise<void> {
    const cur = this.progressMsgs.get(turnId);
    if (!cur) return;
    this.progressMsgs.delete(turnId);
    const { label } = this.labelOf(cur.convId);
    await this.d.api
      .call("editMessageText", { chat_id: cur.chatId, message_id: cur.messageId, text: `${ok ? "✔" : "✖"} [${label}] 진행 종료` })
      .catch(() => {});
  }

  /** Reply-to plus exact chat binding; defaults are never filled in for the user. */
  requestInput(req: { convId: string; chatId: string; detail: string; schema: unknown; timeoutMs?: number }):
      { token: string; result: Promise<Record<string, unknown> | null> } | null {
    const fields = parseElicitationSchema(req.schema);
    if (!this.d.settings().approvals || !fields) return null;
    const token = shortToken();
    const timeoutMs = Math.max(1, Math.min(req.timeoutMs ?? APPROVAL_TIMEOUT_MS, APPROVAL_TIMEOUT_MS));
    const result = new Promise<Record<string, unknown> | null>(resolve => {
      const p = { chatId: req.chatId, schema: req.schema, resolve, expiresAt: this.d.now() + timeoutMs,
        messageId: undefined as number | undefined };
      this.inputs.set(token, p);
      const details = fields.map(f => `${f.name}: ${f.type}${f.required ? " (필수)" : ""}${f.options ? ` [${f.options.map(o => o.value).join(", ")}]` : ""}`).join("\n");
      void this.sendText(req.chatId, `❓ [${this.labelOf(req.convId).label}] 입력 요청 (${Math.ceil(timeoutMs / 1000)}초 후 만료)\n${req.detail}\n${details}\n이 메시지에 JSON 객체로 답장해 주세요. 거절은 '취소'.`, req.convId).then(mid => {
        p.messageId = mid;
        if (mid === undefined && this.inputs.delete(token)) resolve(null);
      });
      const st = this.d.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
      st(() => { if (this.inputs.delete(token)) { resolve(null);
        void this.sendText(req.chatId, "⌛ 입력 요청 만료 — 자동 승인하지 않고 보류했습니다.", undefined); } }, timeoutMs);
    });
    return { token, result };
  }

  // ── 원격 승인 (⑥) ──────────────────────────────────────
  /** 텔레그램 승인 요청. 버튼 응답 또는 5분 무응답(거절)으로 끝난다. 설정이 꺼져 있으면 즉시 false. */
  requestApproval(req: { convId: string; chatId: string; detail: string; timeoutMs?: number }): { token: string; result: Promise<boolean> } {
    const token = shortToken();
    if (!this.d.settings().approvals) return { token, result: Promise.resolve(false) };
    const { label } = this.labelOf(req.convId);
    const timeoutMs = Math.max(1, Math.min(req.timeoutMs ?? APPROVAL_TIMEOUT_MS, APPROVAL_TIMEOUT_MS));
    const result = new Promise<boolean>((resolve) => {
      const p: PendingApproval = { chatId: req.chatId, resolve, done: false, expiresAt: this.d.now() + timeoutMs };
      this.approvals.set(token, p);
      const text = `🔐 [${label}] 실행 승인 요청 (이 요청 1회만, ${Math.ceil(timeoutMs / 1000)}초 후 자동 거절)\n\n${req.detail.slice(0, 3500)}`;
      const markup = {
        inline_keyboard: [[
          { text: "✅ 승인", callback_data: encodeApprovalCallback(token, true) },
          { text: "⛔ 거절", callback_data: encodeApprovalCallback(token, false) },
        ]],
      };
      void this.sendText(req.chatId, text, req.convId, markup).then((mid) => {
        p.messageId = mid;
        if (mid === undefined && !p.done) {
          p.done = true;
          this.approvals.delete(token);
          resolve(false); // 보내지도 못했으면 거절
        }
      });
      const st = this.d.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
      st(() => {
        if (p.done) return;
        p.done = true;
        this.approvals.delete(token);
        this.note("APPROVAL", `timeout token=${token}`);
        resolve(false);
        if (p.messageId !== undefined) {
          void this.d.api.call("editMessageText", { chat_id: p.chatId, message_id: p.messageId, text: `⌛ [${label}] 승인 요청 시간 초과 — 거절됨` }).catch(() => {});
        }
      }, timeoutMs);
    });
    this.note("APPROVAL", `request token=${token} conv=${req.convId.slice(0, 8)}`);
    return { token, result };
  }

  /** 데스크톱에서 먼저 답했을 때 텔레그램 버튼 무효화. */
  cancelApproval(token: string, decidedOnDesktop: boolean): void {
    const input = this.inputs.get(token);
    if (input) { this.inputs.delete(token); input.resolve(null); return; }
    const p = this.approvals.get(token);
    if (!p || p.done) return;
    p.done = true;
    this.approvals.delete(token);
    p.resolve(decidedOnDesktop);
    if (p.messageId !== undefined) {
      void this.d.api.call("editMessageText", { chat_id: p.chatId, message_id: p.messageId, text: "🖥 데스크톱에서 처리됨" }).catch(() => {});
    }
  }

  // ── 아침 요약 (⑤) ──────────────────────────────────────
  /** 1분 주기 호출. 조용한 시간이 끝났고 보류분이 있으면 한 번에 보낸다. */
  async tickDigest(chatId: string): Promise<void> {
    await this.flushOutbox();
    if (this.absenceDigest?.chatId === chatId && this.absenceDigest.entries.length) await this.flushAbsenceDigest();
    if (this.held.length === 0) return;
    if (inQuietHours(this.d.settings().quiet, new Date(this.d.now()))) return;
    const items = this.held.splice(0, this.held.length);
    const lines = [`🌅 밤사이 결과 ${items.length}건`];
    for (const it of items) lines.push("", `[${it.label}] ${it.summary}`);
    const mid = await this.sendText(chatId, lines.join("\n"), undefined);
    if (mid === undefined) {
      this.held.unshift(...items); // 전송 실패 → 다음 틱에 재시도 (유실 금지)
    }
    this.persist();
  }

  get heldCount(): number {
    return this.held.length;
  }
  get examplesCount(): number {
    return this.examples.length;
  }
}

/** 설정 화면 상태 카드가 읽는 현재 허브 (App 이 생성 시 등록). */
let activeHub: TelegramHub | null = null;
export function setActiveTelegramHub(h: TelegramHub | null): void {
  activeHub = h;
}
export function getActiveTelegramHub(): TelegramHub | null {
  return activeHub;
}
