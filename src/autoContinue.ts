// v0.7.57 — 자동 이어가기 (턴 끝 질문 검사기).
//
// 배경 (2026-10-29 K: "작업이 주욱 이어 진행하는 건 잘 안 되는 것 같은데"):
// v0.7.54 의 [자율 진행 원칙] 은 프롬프트 지시문일 뿐이라, 모델이 습관대로 "추천은 1+2+3,
// 번호로 골라 주세요" 로 턴을 끝내도 걸러내는 장치가 없었다. 16:00~21:20 실측 51개 답변 중
// 17개가 질문으로 끝났고, 그중 일부는 확인 사유(①~⑥)에 해당하지 않았다.
//
// 이 모듈은 턴이 끝난 뒤 마지막 답변을 검사해 세 가지로 판정한다 (순수 함수, 엔진 무관):
//   - "none":     질문으로 끝나지 않음 → 아무것도 안 함
//   - "allowed":  질문이지만 확인 사유(전원·되돌리기 어려운 작업·배포·실자금/보안·사람 눈 검증·진행 불가)
//                 단서가 있음 → 그대로 K 를 기다림
//   - "unneeded": 질문인데 확인 사유 단서가 없음 → App 이 같은 대화에 "추천안으로 이어서 진행" 턴을 주입
//
// 안전 설계: 오판 비용이 비대칭이다. 필요한 질문을 건너뛰는 쪽이 위험하므로
//   ① 확인 사유 단어는 넓게 잡고(애매하면 allowed), ② 주입 문구 자체가 "실제로 ①~⑥이면 진행하지 말고
//   사유를 밝히고 기다리라" 고 모델에게 재확인시키며, ③ 대화별 연속 주입 횟수를 제한한다.

export const AUTO_CONTINUE_MARK = "[자동 이어가기]";
/** 같은 대화에서 K 의 실제 메시지 없이 연속으로 주입할 수 있는 최대 횟수. */
export const AUTO_CONTINUE_MAX_CHAIN = 2;
/** 질문 판정에 쓰는 답변 끝부분 길이(문자). 앞쪽 본문 단어로 오판하지 않도록 짧게 본다. */
const TAIL_CHARS = 700;

export type EndingKind = "none" | "allowed" | "unneeded";
export interface EndingVerdict {
  kind: EndingKind;
  /** allowed 일 때 걸린 확인 사유 (예: "② 되돌리기 어려운 작업") */
  category?: string;
  /** 질문으로 본 근거 (매칭된 문구) */
  ask?: string;
  /** 확인 사유로 본 근거 (매칭된 문구) */
  evidence?: string;
  /** v0.7.60 — unneeded 지만 [상시 승인 규칙] 범위로 보이는 경우 그 규칙 이름 (주입 문구에 조건 재확인을 넣는다) */
  standing?: string;
}

// K 에게 결정을 넘기는 문구. "알려 주세요" 단독은 결과 보고 요청(사람 검증)과 섞여 있어 넣지 않는다.
const ASK_PATTERNS: RegExp[] = [
  /할까요\s*\??/,
  /하시겠(어요|습니까)/,
  /하실래요/,
  /(골라|정해|선택해|결정해)\s*주(세요|시면|십시오)/,
  /번호(로|를)\s*(골라|답|주|알려|선택)/,
  /어느\s*(쪽|것|안)\s*(으로|이|을|로)/,
  /원하시는\s*(쪽|것|방향|안)/,
  /진행할지/,
  /(괜찮|좋)을까요/,
  /여쭙(니다|겠습니다)/,
  /정해\s*주실\s*것/,
  /확인이\s*필요한\s*것/,
];

// 확인 사유 ①~⑥ 단서. 넓게 잡는다 (애매하면 K 를 기다리는 쪽이 안전).
const ALLOWED_CATEGORIES: Array<{ label: string; re: RegExp }> = [
  // v0.7.60: bare "power"(PowerShell 오판), 대상 없는 "종료하"("강제 종료하는 실행기" 오판) 제거 — 전원 대상 명사가 있어야 함.
  { label: "① 전원 조작", re: /전원|재부팅|재시작|shutdown|reboot|절전|깨우|\bwake\b|\bpower\s*(off|on|down)\b|(PC|컴퓨터|5080|LDW|시스템|윈도우|머신|서버)\s*\S{0,3}\s*(종료|끄|켜)/i },
  { label: "② 되돌리기 어려운 작업", re: /삭제|제거|지우|덮어쓰|덮어씌|폐기|초기화|되돌리기\s*어려|\bforce\b|--force|rm\s+-|reset\s+--hard|정리\s*승인|칸\s*정리/i },
  { label: "③ 배포·외부 공개", re: /태그|push|릴리[즈스]|배포|공개|업로드|게시|publish|release|deploy|발송|송금/i },
  { label: "④ 실자금·결제·보안·법적 위험", re: /저작권|약관|법적|불법|결제|요금|과금|크레딧|구매|실자금|주문|매수|매도|권한|로그인|토큰|비밀번호|인증|보안|api\s*키|secret/i },
  { label: "⑤ 사람 눈 검증", re: /직접\s*(보|확인|들어|눌러|써)|눈으로|보시고|보신\s*(뒤|후)|들어\s*보|청취|폰(으로|에서)|화면을\s*(보|확인)|마음에\s*드|취향|느낌|보기에/ },
  { label: "⑥ 진행 불가(모순·정보 없음)", re: /모순|정보가\s*없|알\s*수\s*없|접근할\s*수\s*없|찾을\s*수\s*없|진행할\s*수\s*없/ },
];

/** 답변 끝이 결정 요청인지, 그렇다면 확인 사유에 해당하는지 판정한다. */
export function classifyTurnEnding(text: string | undefined | null): EndingVerdict {
  const body = (text ?? "").replace(/\r\n/g, "\n").trim();
  if (!body) return { kind: "none" };
  // 자동 이어가기로 생성된 메시지를 모델이 그대로 되풀이한 경우까지 질문으로 보지 않도록 제거.
  const tail = body.slice(-TAIL_CHARS).split("\n").filter((l) => !l.includes(AUTO_CONTINUE_MARK)).join("\n");
  // v0.7.60: 인용 문구 안의 질문형("\"기록할까요?\" 라고 묻지 않습니다")은 질문이 아니다 (2026-10-30 00:03 오판).
  const askScan = stripQuoted(tail);
  let ask: string | undefined;
  for (const re of ASK_PATTERNS) {
    const m = re.exec(askScan);
    if (m) { ask = m[0]; break; }
  }
  // 끝에 번호 목록(2개 이상)이 있고 그 바로 앞에 "?" 로 끝나는 문장이 있으면 질문으로 본다.
  if (!ask) {
    const lines = tail.split("\n").map((l) => l.trim()).filter(Boolean);
    let i = lines.length - 1;
    let n = 0;
    while (i >= 0 && /^\d+[.)]\s/.test(lines[i])) { n++; i--; }
    if (n >= 2 && i >= 0 && /\?\s*$/.test(lines[i])) ask = lines[i].slice(-40);
  }
  if (!ask) return { kind: "none" };
  // 확인 사유는 "질문 문단 + 바로 앞 선택지 목록 + 그 뒤" 에서만 찾는다.
  // 앞쪽 보고 문장("업로드는 실행하지 않았습니다")이 질문과 무관하게 allowed 로 만드는 오판 방지
  // (2026-10-29 실측: "…업로드는 실행하지 않았습니다. 글꼴 대응법도 pitfall 로 기록할까요?").
  // v0.7.60: 그 영역에서도 "이미 한 일/안 한 일" 보고 문장은 뺀다
  // ("push·tag·release는 하지 않았습니다", "이미 공개 완료됐고", "00:02:03 재시작" 같은 로그 줄 — 2026-10-30 오판 5건).
  const region = stripReportSentences(questionRegion(tail, ask), ask);
  for (const c of ALLOWED_CATEGORIES) {
    const m = c.re.exec(region);
    if (!m) continue;
    // ② 단서가 [상시 승인 규칙] 1(CAE 빌드·설치 칸 순환 정리) 범위면 기다리지 않는다 — 조건 재확인은 주입 문구가 시킨다.
    if (c.label.startsWith("②") && STANDING_CAE_SLOT.test(region) && !otherCategoryHit(region, c.label)) {
      return { kind: "unneeded", ask, standing: "상시 승인 1 (CAE 빌드·설치 칸 순환 정리)", evidence: m[0] };
    }
    // "메모리 기록은 승인이 필요해 진행할 수 없습니다" 류 — 함정 기록은 묻지 않는 규칙이므로 ⑥ 이 아니다.
    if (c.label.startsWith("⑥") && MEMORY_RECORD.test(region)) {
      return { kind: "unneeded", ask, standing: "실패 자동 포착 (함정 기록은 묻지 않고 기존 파일에 append)", evidence: m[0] };
    }
    return { kind: "allowed", ask, category: c.label, evidence: m[0] };
  }
  return { kind: "unneeded", ask };
}

/** [상시 승인 규칙] 1 — "오래된 빌드/설치본 정리·삭제", "빌드 칸 정리/비우기". */
const STANDING_CAE_SLOT = /((가장\s*)?오래된|이전|예전)\s*(빌드|설치본)[^\n]{0,40}(삭제|제거|지우|정리|비우)|(빌드|설치)[·\s]*(설치\s*)?칸[^\n]{0,40}(정리|비우|삭제|제거)|(설치본|빌드)\s*a\d+\s*(을|를)?\s*(제거|삭제)/;
/** [실패 자동 포착] — 함정(pitfall) 기록은 묻지 않고 바로 append 하는 규칙. */
const MEMORY_RECORD = /(함정|pitfall|메모리)[^\n]{0,40}(기록|저장|append)/i;

function otherCategoryHit(region: string, except: string): boolean {
  return ALLOWED_CATEGORIES.some((c) => c.label !== except && c.re.test(region));
}

/** 따옴표·백틱 안의 짧은 인용을 지운다 (질문 판정 전용). */
function stripQuoted(s: string): string {
  return s
    .replace(/\\"/g, "")
    .replace(/"[^"\n]{0,120}"/g, "")
    .replace(/“[^”\n]{0,120}”/g, "")
    .replace(/`[^`\n]{0,200}`/g, "");
}

// 이미 끝났거나 하지 않은 일을 보고하는 문장 — 앞으로 할 일(질문의 대상)이 아니다.
const REPORT_SENTENCE = /(하지\s*않았|않았습니다|않았고|안\s*했습니다|손대지\s*않|건드리지\s*않|그대로\s*(입니다|이고|둡니다|두었|뒀|유지)|(상태|선택|선곡)\S{0,3}\s*유지|유지했|완료(했|됐|되었|된\s*상태)|끝났|마쳤|통과했|기록했|커밋했|반영했)/;
// "- 00:02:03 재시작" 같은 시각으로 시작하는 진행 기록 줄
const LOG_LINE = /^\s*[-*]?\s*\d{1,2}:\d{2}(:\d{2})?\b/;

function stripReportSentences(region: string, ask: string): string {
  return region
    .split("\n")
    .filter((line) => line.includes(ask) || !LOG_LINE.test(line))
    .map((line) => {
      if (line.includes(ask)) return line;
      // 문장 단위로 나눠 보고 문장만 뺀다 (목록 항목 하나에 여러 문장이 있을 수 있음)
      const parts = line.split(/(?<=[.!?。])\s+|(?<=다)\s*[,·]\s+|(?<=고)\s+(?=\S+[은는이가]\s)/);
      return parts.filter((p) => !REPORT_SENTENCE.test(p)).join(" ");
    })
    .join("\n");
}

/** 질문이 들어 있는 마지막 문단부터 끝까지 + 그 직전 문단이 번호 목록이면 그것까지. */
function questionRegion(tail: string, ask: string): string {
  const paras = tail.split(/\n\s*\n/);
  let k = -1;
  for (let i = paras.length - 1; i >= 0; i--) {
    if (paras[i].includes(ask)) { k = i; break; }
  }
  if (k < 0) return tail;
  // 같은 문단의 앞 문장은 질문의 이유인 경우가 많아 포함한다 ("결제가 필요합니다. 진행할까요?").
  const head = paras[k];
  // 선택지 목록이 질문 1~3문단 앞에 있으면("1. … 2. …" → "제 추천은 …" → "번호로 골라 주세요") 그 목록부터 포함.
  let from = k;
  for (let j = k - 1; j >= Math.max(0, k - 3); j--) {
    if (/^\s*\d+[.)]\s/m.test(paras[j])) { from = j; break; }
  }
  const prev = from < k ? paras.slice(from, k).join("\n\n") + "\n\n" : "";
  return prev + head + (k + 1 < paras.length ? "\n\n" + paras.slice(k + 1).join("\n\n") : "");
}

/** App 이 같은 대화에 주입하는 메시지. 모델이 실제 확인 사유를 놓쳤을 때 스스로 멈추도록 재확인 문구 포함. */
export function buildAutoContinuePrompt(v: EndingVerdict): string {
  return [
    `${AUTO_CONTINUE_MARK} 직전 응답이 K님께 선택을 묻고 끝났습니다${v.ask ? ` (판정 근거: "${v.ask}")` : ""}.`,
    "KDA 검사기는 이 질문이 확인이 필요한 경우(① 전원 조작 ② 삭제·덮어쓰기 등 되돌리기 어려운 작업 ③ 태그 push·배포·외부 공개 ④ 실자금·결제·보안 권한 ⑤ 사람 눈으로만 판단 가능한 검증 ⑥ 모순·정보 부족으로 진행 불가)에 해당하지 않는다고 판정했습니다.",
    ...(v.standing
      ? [`이 질문은 K님이 미리 승인한 규칙 범위로 보입니다: ${v.standing}. 시스템 지침에 적힌 그 규칙의 조건${v.standing.includes("CAE") ? "(사전 점검 dry-run exit 0, 제거 대상이 규칙과 정확히 일치, 보호 대상 제외)" : ""}을 직접 확인해 모두 맞으면 묻지 말고 진행하고, 하나라도 어긋나면 어느 조건인지 밝히고 기다리세요.`]
      : []),
    "추천안으로 정하고 이어서 끝까지 진행하세요. 보고에는 \"추천으로 정한 것(바꾸려면 말씀)\" 한 줄을 적습니다.",
    "단, 실제로 위 ①~⑥ 중 하나에 해당한다면 진행하지 말고 어느 항목인지 한 줄로 밝힌 뒤 K님을 기다리세요.",
  ].join("\n");
}

/** 대화별 연속 주입 카운터. K 의 실제 메시지가 오면 reset. */
export class AutoContinueChain {
  private counts = new Map<string, number>();
  constructor(private readonly max = AUTO_CONTINUE_MAX_CHAIN) {}
  /** 주입 가능하면 카운트를 올리고 true. 한도 도달이면 false. */
  tryTake(convId: string): boolean {
    const n = this.counts.get(convId) ?? 0;
    if (n >= this.max) return false;
    this.counts.set(convId, n + 1);
    return true;
  }
  reset(convId: string): void { this.counts.delete(convId); }
  count(convId: string): number { return this.counts.get(convId) ?? 0; }
}

/** 사용자 메시지가 자동 이어가기 주입분인지. 주입분은 카운터를 reset 하지 않는다. */
export function isAutoContinueMessage(text: string | undefined | null): boolean {
  return (text ?? "").trimStart().startsWith(AUTO_CONTINUE_MARK);
}
