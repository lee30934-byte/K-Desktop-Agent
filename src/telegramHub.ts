/**
 * v0.7.54 — 텔레그램 허브: 업데이트 처리 · 분배 · 요약 회신 · 버튼 · 진행 메시지 · 원격 승인 · 받은 파일함 · 아침 요약.
 *
 * React/Tauri 무의존 — 모든 외부 동작은 HubDeps 로 주입한다(scripts/telegram-hub.test.ts 가 가짜 API 로 검증).
 * 원칙:
 *  - 어떤 실패(AI·요약·이미지·버튼)도 텍스트 회신을 막지 않는다. 최후 수단은 원문 일부.
 *  - 결정 필요·오류는 조용한 시간에도 즉시 보낸다(규칙 판정, telegramDigest).
 *  - 기능별 설정이 꺼져 있으면 v0.7.53 과 같은 동작(원문 회신, 📱 텔레그램 대화 고정).
 */
import {
  decideRoute,
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
  setTimeout?(fn: () => void, ms: number): unknown;
}

export const PROGRESS_FIRST_MS = 5 * 60 * 1000;
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_IMAGES_PER_REPLY = 5;
const SUMMARY_MIN_CHARS = 600; // 이보다 짧으면 요약하지 않고 원문
const CHUNK = 4000;
const FULLTEXT_MAX = 100;

const K_REPLYMAP = "kda_tg_hub_replymap";
const K_EXAMPLES = "kda_tg_hub_examples";
const K_HELD = "kda_tg_hub_held";

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
  readonly followUps = new FollowUpRegistry();
  private examples: RouteExample[];
  private held: HeldResult[];
  private fullText = new Map<number, string>();
  private lastReply: { convId: string; at: number } | undefined;
  private lastInbound: { text: string; chatId: string; convId: string } | undefined;
  private progressMsgs = new Map<string, { chatId: string; messageId: number; convId: string }>();
  private approvals = new Map<string, PendingApproval>();
  /** 최근 분배·오류 기록 (상태 카드/ /분배 용). */
  readonly recent: Array<{ at: number; kind: string; detail: string }> = [];

  constructor(private readonly d: HubDeps) {
    this.replyMap = ReplyMap.fromJSON(this.readJson(K_REPLYMAP));
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
    } catch (e) {
      this.d.log(`HUB persist-failed ${String(e).slice(0, 120)}`);
    }
  }
  private note(kind: string, detail: string): void {
    this.recent.push({ at: this.d.now(), kind, detail });
    if (this.recent.length > 30) this.recent.shift();
    this.d.log(`HUB ${kind} ${detail}`);
  }

  private labelOf(convId: string): { label: string; isDefault: boolean } {
    const def = this.d.defaultTarget();
    if (convId === def.convId) return { label: def.label, isDefault: true };
    const t = this.d.targets().find((x) => x.convId === convId);
    return { label: t ? t.label : convId.slice(0, 8), isDefault: false };
  }

  // ── 송신 ────────────────────────────────────────────────
  /** 텍스트 전송. 마지막 조각에 버튼. 보낸 message_id 들을 대화에 연결. 실패해도 throw 하지 않고 false. */
  async sendText(chatId: string, text: string, convId: string | undefined, replyMarkup?: unknown, full?: string): Promise<number | undefined> {
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
            return lastId;
          }
        } else {
          this.note("SEND-FAILED", String(e).slice(0, 160));
          return lastId;
        }
      }
      const mid = res?.result?.message_id;
      if (typeof mid === "number") {
        lastId = mid;
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
    if (u?.callback_query) return this.handleCallback(u.callback_query);
    const msg = u?.message;
    if (!msg) return;
    const chatId = msg.chat?.id != null ? String(msg.chat.id) : "";
    if (!chatId) return;
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
    if (/^\/(상태|status)(?:@\S+)?(?:\s|$)/i.test(trimmed)) return this.cmdStatus(chatId);
    if (/^\/(도움|help|start)(?:@\S+)?(?:\s|$)/i.test(trimmed)) return this.cmdHelp(chatId);
    if (/^\/(분배|route)(?:@\S+)?(?:\s|$)/i.test(trimmed)) return this.cmdRoutes(chatId);
    const mv = /^\/(이동|move)\s+@?(\S+)\s*$/i.exec(trimmed);
    if (mv) return this.cmdMove(chatId, mv[2]);

    // "자세히" 답장 → 원문
    const replyToId: number | undefined = msg.reply_to_message?.message_id;
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
    let decision: RouteDecision;
    if (!s.routing) {
      decision = { convId: def.convId, label: def.label, source: "default", text };
    } else {
      decision = await decideRoute({
        text,
        replyToConvId: this.replyMap.lookup(replyToId),
        lastReply: this.lastReply,
        now: this.d.now(),
        targets: this.d.targets(),
        defaultTarget: def,
        classify: (p) => this.d.api.oneshot(p),
        examples: this.examples,
      });
    }
    this.note("ROUTE", `conv=${decision.convId.slice(0, 8)} by=${decision.source}${decision.confidence != null ? ` conf=${decision.confidence}` : ""}${decision.note ? ` note=${decision.note}` : ""}`);
    this.lastInbound = { text: decision.text, chatId, convId: decision.convId };
    if (decision.convId !== def.convId) {
      this.followUps.mark(decision.convId, chatId, this.d.now());
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

  private async handleCallback(cq: any): Promise<void> {
    const data: string = typeof cq?.data === "string" ? cq.data : "";
    const chatId = cq?.message?.chat?.id != null ? String(cq.message.chat.id) : "";
    const answer = (text: string) =>
      this.d.api.call("answerCallbackQuery", { callback_query_id: cq.id, text }).catch(() => {});

    const ap = decodeApprovalCallback(data);
    if (ap) {
      const p = this.approvals.get(ap.token);
      if (!p || p.done) {
        await answer("이미 처리됐거나 만료된 요청입니다.");
        return;
      }
      p.done = true;
      this.approvals.delete(ap.token);
      p.resolve(ap.approve);
      this.note("APPROVAL", `${ap.approve ? "accept" : "decline"} token=${ap.token}`);
      await answer(ap.approve ? "승인했습니다 (이 요청 1회만)" : "거절했습니다");
      if (p.messageId !== undefined) {
        void this.d.api
          .call("editMessageReplyMarkup", { chat_id: p.chatId, message_id: p.messageId, reply_markup: { inline_keyboard: [] } })
          .catch(() => {});
      }
      return;
    }

    const ch = decodeChoiceCallback(data);
    if (ch && chatId) {
      const all = [...this.d.targets(), { ...this.d.defaultTarget(), aliases: [], description: "" }];
      const t = all.find((x) => x.convId.slice(0, 8) === ch.convPrefix);
      if (!t) {
        await answer("대상 대화를 찾지 못했어요.");
        return;
      }
      await answer(`${ch.key}번 전달`);
      this.note("CHOICE", `conv=${t.convId.slice(0, 8)} key=${ch.key}`);
      this.followUps.mark(t.convId, chatId, this.d.now());
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
      ...(this.d.statusLines?.() ?? []),
      `분배 ${onoff(s.routing)} · 요약 ${onoff(s.digest)} · 버튼 ${onoff(s.buttons)} · 진행알림 ${onoff(s.progress)} · 파일받기 ${onoff(s.inbox)} · 원격승인 ${onoff(s.approvals)}`,
      `조용한 시간 ${s.quiet.enabled ? `${s.quiet.startHour}시~${s.quiet.endHour}시` : "꺼짐"} · 보류된 결과 ${this.held.length}건`,
      `진행 중 알림 ${this.progressMsgs.size}건 · 승인 대기 ${this.approvals.size}건`,
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
        "- @별칭 내용 → 그 대화로 바로 (/분배 로 별칭 확인)",
        "- 봇 메시지에 답장 → 그 메시지를 보낸 대화로",
        "- 요약 메시지에 '자세히' 답장 → 원문",
        "- /이동 별칭 → 직전 메시지를 다른 대화로 다시 보내고 분류기에 학습",
        "- /상태 → 브리지 상태와 최근 기록",
        "- 사진·파일을 보내면 미니PC inbox 에 저장 후 경로를 함께 전달",
      ].join("\n"),
      undefined,
    );
  }

  private async cmdRoutes(chatId: string): Promise<void> {
    const ts = this.d.targets();
    const lines = ["🧭 분배 대상", `- (기본) ${this.d.defaultTarget().label}`];
    for (const t of ts) lines.push(`- ${t.label}${t.aliases.length ? ` — @${t.aliases.join(" @")}` : ""}`);
    if (ts.length === 0) lines.push("(분배 허용 대화 없음 — KDA 설정에서 추가)");
    await this.sendText(chatId, lines.join("\n"), undefined);
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
    this.lastInbound = { ...last, convId: t.convId };
    await this.sendText(chatId, `↪ [${t.label}]로 다시 보냅니다. 다음부터 비슷한 메시지는 이쪽으로 분류합니다.`, t.convId);
    try {
      await this.d.startTurn(t.convId, last.text, chatId);
    } catch (e) {
      await this.sendText(chatId, `⚠ 처리 시작 실패: ${String(e).slice(0, 200)}`, undefined);
    }
  }

  // ── 결과 회신 ───────────────────────────────────────────
  /**
   * 턴 결과 회신. App 의 done/error/stale 경로가 모두 이 함수를 부른다.
   * forceSend: 오류·중지 안내처럼 등급과 무관하게 즉시 보내야 하는 경우.
   */
  async deliverResult(r: { convId: string; chatId: string; text: string; turnId?: string; forceSend?: boolean }): Promise<void> {
    const s = this.d.settings();
    const { label, isDefault } = this.labelOf(r.convId);
    if (r.turnId) await this.finishProgress(r.turnId, true);
    const pc = s.pcName.trim() ? `[${s.pcName.trim()}] ` : "";
    const raw = r.text && r.text.trim() ? r.text : "(빈 응답)";

    if (!s.digest) {
      const mid = await this.sendText(r.chatId, pc + labelReply(raw, label, isDefault), r.convId, this.choiceMarkup(r.convId, raw), raw);
      if (mid !== undefined) this.lastReply = { convId: r.convId, at: this.d.now() };
      await this.sendImages(r.chatId, r.convId, label, raw);
      return;
    }

    const tier: DigestTier = r.forceSend ? "error" : classifyTier(raw);
    const plan = deliveryPlan(tier, inQuietHours(s.quiet, new Date(this.d.now())));
    if (plan === "skip") {
      this.note("SKIP-PROGRESS", `conv=${r.convId.slice(0, 8)} len=${raw.length}`);
      return;
    }
    const body = await this.summarize(label, tier, raw);
    if (plan === "hold") {
      this.held.push({ label, summary: body, at: this.d.now() });
      this.persist();
      this.note("HOLD", `conv=${r.convId.slice(0, 8)} quiet`);
      return;
    }
    const icon = tier === "error" ? "❌ " : tier === "decision" ? "❓ " : "✅ ";
    const markup = tier === "decision" ? this.choiceMarkup(r.convId, raw) : undefined;
    const mid = await this.sendText(r.chatId, pc + icon + labelReply(body, label, isDefault), r.convId, markup, raw);
    if (mid !== undefined) this.lastReply = { convId: r.convId, at: this.d.now() };
    await this.sendImages(r.chatId, r.convId, label, raw);
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
      } catch (e) {
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

  // ── 원격 승인 (⑥) ──────────────────────────────────────
  /** 텔레그램 승인 요청. 버튼 응답 또는 5분 무응답(거절)으로 끝난다. 설정이 꺼져 있으면 즉시 false. */
  requestApproval(req: { convId: string; chatId: string; detail: string }): { token: string; result: Promise<boolean> } {
    const token = shortToken();
    if (!this.d.settings().approvals) return { token, result: Promise.resolve(false) };
    const { label } = this.labelOf(req.convId);
    const result = new Promise<boolean>((resolve) => {
      const p: PendingApproval = { chatId: req.chatId, resolve, done: false };
      this.approvals.set(token, p);
      const text = `🔐 [${label}] 실행 승인 요청 (이 요청 1회만, ${APPROVAL_TIMEOUT_MS / 60000}분 후 자동 거절)\n\n${req.detail.slice(0, 3500)}`;
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
      }, APPROVAL_TIMEOUT_MS);
    });
    this.note("APPROVAL", `request token=${token} conv=${req.convId.slice(0, 8)}`);
    return { token, result };
  }

  /** 데스크톱에서 먼저 답했을 때 텔레그램 버튼 무효화. */
  cancelApproval(token: string, decidedOnDesktop: boolean): void {
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
