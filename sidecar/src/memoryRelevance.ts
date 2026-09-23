/**
 * Phase 149 (v0.7.37) — 메모리 관련도 스코어링 모듈.
 *
 * ## 왜 분리했나
 * 기존 pitfall trigger 스코어링은 `index.ts` 안의 비공개 함수여서 테스트가 접근할 수 없었다.
 * 그래서 `test-context-meter.mjs` 가 그랬듯 **테스트가 로직을 재구현(mirror)** 하게 되고,
 * 앱만 고치고 미러를 방치하면 테스트가 앱과 다른 걸 재는 드리프트가 생긴다
 * (v0.7.20 → v0.7.36 에서 실제로 발생, 분모 미러가 200K 를 돌려주고 있었다).
 *
 * → 관련도 계산은 **여기 한 곳에만** 둔다. index.ts 도 테스트도 이 모듈을 import 한다.
 *   재구현 금지. 이 파일을 고치면 앱과 테스트가 동시에 움직인다.
 *
 * ## 이 단계(Step A)의 범위
 * **동작 무변경 추출만 한다.** 개선(IDF/토큰경계/도구호출 쿼리)은 baseline 을 측정한 뒤
 * Step C 에서 별도로 들어간다. 측정 없이 알고리즘을 바꾸면 개선을 증명할 수 없다.
 */

// ── 기존 index.ts 상수 (값 그대로 이동) ────────────────────────────────
export const MAX_TRIGGERED_PITFALLS = 8;
export const PITFALL_TRIGGER_MIN_TOKEN_LEN = 4;
/**
 * Phase 147 (v0.7.25) — triggered 본문 길이 상한.
 * 통합 MASTER 파일이 43KB 까지 자라면 cap 을 단독 초과해 "매치됐는데도 통째 drop" 된다.
 * 잘라서라도 주입하는 편이 0 보다 낫다.
 */
export const TRIGGERED_BODY_MAX_CHARS = 6000;

// slug/tags 에서 흔히 나오는 과도하게 일반적인 토큰 → 오매치 방지 (explicit triggers 는 면제).
// windows/powershell 은 의도적으로 제외(=매칭 허용): K 가 그 단어를 쓰면 해당 도메인 함정이 정확히 필요.
export const PITFALL_TRIGGER_STOPWORDS = new Set<string>([
  "memory", "file", "files", "path", "paths", "data", "code", "tool", "tools",
  "user", "json", "node", "test", "tests", "name", "list", "mode", "time",
  "work", "true", "false", "with", "from", "this", "that", "when", "then",
  "pitfall", "kda",
]);

// description/triggers 에서 뽑은 한글 토큰 중 변별력 없는 조사·일반어 → 제외.
// (K 는 한국어로 명령하는데 slug 는 영문이라, 한글 토큰 매칭이 회상의 핵심 경로다.)
export const PITFALL_TRIGGER_KSTOP = new Set<string>([
  "없이", "하는", "해서", "에서", "으로", "그리고", "또는", "같은", "경우", "때문",
  "대신", "직접", "다시", "매번", "항상", "절대", "반복", "사용", "호출", "실행",
  "파일", "작업", "메모리", "내용", "자세한", "참조", "문제", "발생", "우회", "회피",
  "확인", "처리", "결과", "상태", "설정", "변경", "추가", "제거", "생성", "적용",
  "필요", "가능", "시도", "해야", "된다", "안됨", "해도", "하면", "이나", "에는",
  "에도", "까지", "부터", "보다", "마다", "위해", "통해", "관련", "경로", "스크립트",
  "명령", "호스트", "사용자", "요청", "동작", "구조", "기존",
]);

// ── frontmatter 파서 (index.ts 에서 이동, 로직 동일) ───────────────────

/** frontmatter block (--- 사이) 만 추출. 없으면 null. */
export function extractFrontmatterBlock(body: string): string | null {
  const fm = body.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  return fm ? fm[1] : null;
}

/**
 * YAML frontmatter 의 list/scalar 필드를 string[] 로 파싱.
 * 지원 형태: `key: [a, b]`, `key: a, b`, 여러 줄 `key:\n  - a\n  - b`.
 */
export function extractYamlList(block: string, key: string): string[] {
  const splitCsv = (v: string): string[] =>
    v
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  const inline = block.match(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, "m"));
  if (inline) {
    const v = inline[1].trim();
    return v.startsWith("[") ? splitCsv(v.replace(/^\[|\]$/g, "")) : splitCsv(v);
  }
  const listM = block.match(
    new RegExp(`^${key}:[ \\t]*\\r?\\n((?:[ \\t]*-[ \\t]*.+\\r?\\n?)+)`, "m"),
  );
  if (listM) {
    return listM[1]
      .split(/\r?\n/)
      .map((l) => l.replace(/^[ \t]*-[ \t]*/, "").trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return [];
}

/** frontmatter scalar 한 줄 추출 (없으면 null). */
export function extractYamlScalar(block: string, key: string): string | null {
  const m = block.match(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

/** 한글 2자+ 토큰만 추출(조사 섞여도 substring 매칭되도록), KSTOP 제외. */
export function extractHangulTokens(text: string | null): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(/[가-힣]{2,}/g)) {
    if (!PITFALL_TRIGGER_KSTOP.has(m[0])) out.add(m[0]);
  }
  return [...out];
}

export interface PitfallTriggers {
  explicit: string[];
  derived: string[];
  korean: string[];
}

/**
 * 키워드 = explicit `triggers:`(있으면) + `tags:` + slug 토큰(_/- 분리, 길이>=4).
 * frontmatter 수정 없이도 기존 pitfall 이 slug/tags 로 자동 파생된다.
 */
export function derivePitfallTriggers(slug: string, block: string | null): PitfallTriggers {
  const explicit = new Set<string>();
  const derived = new Set<string>();
  const korean = new Set<string>();
  if (block) {
    for (const t of extractYamlList(block, "triggers")) {
      if (t) explicit.add(t.toLowerCase());
      for (const w of extractHangulTokens(t)) korean.add(w);
    }
    for (const t of extractYamlList(block, "tags")) {
      const lt = t.toLowerCase();
      if (lt.length >= PITFALL_TRIGGER_MIN_TOKEN_LEN && !PITFALL_TRIGGER_STOPWORDS.has(lt)) {
        derived.add(lt);
      }
    }
    // K 는 한국어로 쓰므로 description 의 한글 명사 토큰을 매칭 키로 사용 (slug 는 영문).
    for (const w of extractHangulTokens(extractYamlScalar(block, "description"))) korean.add(w);
  }
  for (const tok of slug.split(/[_\-]/)) {
    const lt = tok.toLowerCase();
    if (lt.length >= PITFALL_TRIGGER_MIN_TOKEN_LEN && !PITFALL_TRIGGER_STOPWORDS.has(lt)) {
      derived.add(lt);
    }
  }
  return { explicit: [...explicit], derived: [...derived], korean: [...korean] };
}

// ── 스코어러 (신규 — 기존 인라인 로직을 순수 함수로 노출) ───────────────

export interface PitfallCandidate {
  /** 파일명 (pitfall_*.md) */
  file: string;
  /** 파일 전체 본문 (frontmatter 포함) */
  body: string;
}

export interface PitfallScore {
  file: string;
  score: number;
  /** 어떤 키워드가 왜 맞았는지 — 진단/테스트용. 스코어에는 영향 없음. */
  hits: { explicit: string[]; derived: string[]; korean: string[] };
}

/**
 * 현재 메시지에 대한 pitfall 관련도 점수.
 * 점수 = explicit trigger(가중 2) + derived 영문토큰(1) + 한글토큰(1).
 *
 * ⚠ 이 함수는 **기존 index.ts 인라인 로직과 동작이 동일**해야 한다 (Step A: 무변경 추출).
 *   정렬 tie-break 까지 동일: score desc → file asc.
 */
export function scorePitfalls(
  candidates: PitfallCandidate[],
  currentMsg: string,
): PitfallScore[] {
  if (!currentMsg) return [];
  const lc = currentMsg.toLowerCase();
  const scored: PitfallScore[] = [];
  for (const c of candidates) {
    const block = extractFrontmatterBlock(c.body);
    const slug = c.file.replace(/^pitfall_/, "").replace(/\.md$/, "");
    const { explicit, derived, korean } = derivePitfallTriggers(slug, block);
    let score = 0;
    const hits: PitfallScore["hits"] = { explicit: [], derived: [], korean: [] };
    for (const t of explicit) {
      if (t && lc.includes(t)) {
        score += 2;
        hits.explicit.push(t);
      }
    }
    for (const t of derived) {
      if (t && lc.includes(t)) {
        score += 1;
        hits.derived.push(t);
      }
    }
    for (const t of korean) {
      if (currentMsg.includes(t)) {
        score += 1;
        hits.korean.push(t);
      }
    }
    if (score > 0) scored.push({ file: c.file, score, hits });
  }
  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return scored;
}

// ══════════════════════════════════════════════════════════════════════
// Phase 149 Step C — 개선 스코어러 (v2)
// ══════════════════════════════════════════════════════════════════════
//
// ## v1 이 왜 0% 였나 (2026-09-23 실측, 골든셋 13개 기대항목 중 0개 적중)
//   - pitfall 538개 중 frontmatter 보유 216개(40.1%), explicit `triggers:` 는 **8개(1.5%)**.
//   - 나머지 322개(59.9%)의 매칭 키는 **영문 slug 토큰뿐**이다.
//   - 그런데 K 는 한국어로 명령한다 ("5080 꺼줘", "릴리즈 진행하자").
//     → `lc.includes(영문토큰)` 은 순한글 메시지에 **영원히 매치되지 않는다.**
//   - 한글 매칭 경로는 frontmatter `description:` 한 줄(203개)에서 뽑은 토큰이 전부였다.
//   즉 회상 실패는 튜닝 문제가 아니라 **인덱싱 대상이 틀린** 구조적 결함이었다.
//
// ## v2 의 해법
//   1. **본문 전체를 인덱싱한다.** 모든 pitfall 은 증상/회피책이 한국어로 적혀 있다.
//      frontmatter 마이그레이션(538개 수작업) 없이 전 파일에 한글 매칭 경로가 생긴다.
//   2. **한글은 문자 n-gram(2,3)** 으로 자른다. 형태소 분석기 없이 조사 변형을 흡수한다
//      ("커밋해줘" / "커밋을" / "커밋" 이 모두 "커밋" 바이그램을 공유).
//   3. **IDF 가중.** 538개 중 300개에 나오는 토큰과 2개에만 나오는 토큰을 같게 세면
//      일반어가 순위를 지배한다. v1 이 그랬다.
//   4. **영문은 토큰 경계 매칭.** `includes` 는 "rg" 가 "large" 에 걸리는 부분문자열 오매치
//      (`v135c_css_class_selector_is_subset_match` 계열)를 만든다.
//   5. explicit trigger / slug 정확매칭은 **가산점으로 유지** (정밀도 높은 신호라 버릴 이유 없음).

/** 본문 인덱싱 상한 — 파일당 이 길이까지만 토큰화 (MASTER 파일 43KB 대비 비용 방어). */
export const V2_BODY_INDEX_MAX_CHARS = 8000;
/** 한글 n-gram 길이. 2 는 재현율, 3 은 정밀도. */
const V2_HANGUL_NGRAMS = [2, 3];
/** 영문 토큰 최소 길이 (v1 과 동일 기준). */
const V2_EN_MIN_LEN = 4;
/** IDF 상한 — 희귀 토큰 하나가 순위를 독점하지 않도록 클램프. */
const V2_IDF_CAP = 6;

/**
 * IDF 하한 — 이 값 미만의 매치는 **증거로 세지 않는다.**
 * "확인/작업/대로/해줘" 같은 일반어는 거의 모든 문서에 있어 IDF 가 0.2~0.5 수준인데,
 * 질의 어절 3~4개가 전부 그런 말이면 합산 0.9 가 되어 정답의 희귀토큰 1개를 눌러버린다
 * (2026-09-23 케이스1 실측: 정답이 'ripgrep' 을 갖고도 47위).
 * KSTOP 은 frontmatter 경로에만 적용돼 n-gram 에는 안 먹으므로 IDF 하한으로 막는다.
 */
const V2_IDF_FLOOR = Number(process.env.KDA_MEM_IDF_FLOOR ?? 1.2);

/**
 * 문서 길이 보정 방식.
 * ⚠ sqrt 는 **짧은 파일을 과도하게 띄운다** — 실측에서 62토큰짜리 단편이 'ripgrep' 1개만
 *   맞고 1위, 같은 단어를 가진 6.9KB 정본이 47위였다. 정보량이 많은 정본이 벌을 받는 셈.
 * 기본값은 실측으로 고른다 (knob 로 스윕 후 고정).
 */
const V2_LEN_NORM = (process.env.KDA_MEM_LEN_NORM ?? "log") as "none" | "log" | "sqrt";

function lengthNorm(size: number): number {
  if (V2_LEN_NORM === "none") return 1;
  if (V2_LEN_NORM === "sqrt") return Math.sqrt(size);
  return Math.log(size + Math.E); // log: 완만한 보정 (기본)
}

/** 텍스트 → 토큰 집합 (한글 n-gram + 영문 단어). 인덱스/쿼리 양쪽에 같은 함수를 쓴다. */
export function tokenizeForIndex(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const src = text.slice(0, V2_BODY_INDEX_MAX_CHARS);

  // 한글: 연속 한글 구간마다 문자 n-gram
  for (const run of src.match(/[가-힣]+/g) ?? []) {
    for (const n of V2_HANGUL_NGRAMS) {
      for (let i = 0; i + n <= run.length; i++) out.add("k:" + run.slice(i, i + n));
    }
  }
  // 영문/숫자: 단어 단위 (경계 매칭 — 부분문자열 오매치 차단)
  for (const w of src.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (w.length >= V2_EN_MIN_LEN && !PITFALL_TRIGGER_STOPWORDS.has(w)) out.add("e:" + w);
  }
  return out;
}

export interface V2Index {
  /** file → 토큰 집합 */
  docs: Map<string, Set<string>>;
  /** 토큰 → 그 토큰을 가진 문서 수 */
  df: Map<string, number>;
  /** 문서 총수 */
  n: number;
}

/** 후보 전체를 1회 토큰화해 역문서빈도(IDF) 계산까지 끝낸 인덱스를 만든다. */
export function buildV2Index(candidates: PitfallCandidate[]): V2Index {
  const docs = new Map<string, Set<string>>();
  const df = new Map<string, number>();
  for (const c of candidates) {
    // slug 도 본문과 함께 넣는다 (영문 키워드로 물어볼 때의 경로 유지)
    const slug = c.file.replace(/^pitfall_/, "").replace(/\.md$/, "").replace(/[_\-]/g, " ");
    const toks = tokenizeForIndex(slug + "\n" + c.body);
    docs.set(c.file, toks);
    for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { docs, df, n: candidates.length };
}

function idf(index: V2Index, token: string): number {
  const d = index.df.get(token) ?? 0;
  if (d <= 0) return 0;
  // 표준 IDF, 상한 클램프
  return Math.min(V2_IDF_CAP, Math.log((index.n + 1) / (d + 0.5)));
}

/**
 * 질의를 **증거 그룹**으로 쪼갠다.
 *
 * ⚠ 이게 v2 의 핵심 교정이다. 단순히 n-gram 집합으로 다루면 같은 어절에서 나온
 *   겹치는 n-gram 이 **독립 증거로 중복 가산**된다:
 *     "설치본" → 설치, 치본, 본에, 설치본, 치본에  (5배 가산)
 *   그 결과 "설치" 한 단어만 걸쳐도 무관한 함정이 상위를 점유한다
 *   (2026-09-23 실측: 케이스 7 정답이 46위로 밀림).
 *
 * → 한글은 **어절(연속 한글 구간) 하나당 증거 1개**만 인정한다.
 *   그룹 안에서는 가장 정보량이 큰(IDF 최대) 매치 하나만 점수로 친다.
 *   영문 단어는 서로 독립이므로 각각이 자기 그룹이다.
 */
export function buildQueryGroups(query: string): { kind: "k" | "e"; toks: string[] }[] {
  const groups: { kind: "k" | "e"; toks: string[] }[] = [];
  if (!query) return groups;
  const src = query.slice(0, V2_BODY_INDEX_MAX_CHARS);

  for (const run of src.match(/[가-힣]+/g) ?? []) {
    const toks: string[] = [];
    for (const n of V2_HANGUL_NGRAMS) {
      for (let i = 0; i + n <= run.length; i++) toks.push("k:" + run.slice(i, i + n));
    }
    if (toks.length) groups.push({ kind: "k", toks });
  }
  const seenEn = new Set<string>();
  for (const w of src.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (w.length < V2_EN_MIN_LEN || PITFALL_TRIGGER_STOPWORDS.has(w)) continue;
    if (seenEn.has(w)) continue;
    seenEn.add(w);
    groups.push({ kind: "e", toks: ["e:" + w] });
  }
  return groups;
}

/**
 * v2 스코어. query 는 사용자 메시지 + (선택) 도구/경로 등 문맥 신호를 합친 문자열.
 *
 * score = Σ_{그룹 g} max_{t ∈ g∩doc} idf(t)  / sqrt(|doc|)   ← 어절당 증거 1개 + 길이 보정
 *       + explicit trigger 정확매칭 가산
 */
export function scorePitfallsV2(
  candidates: PitfallCandidate[],
  query: string,
  index?: V2Index,
): PitfallScore[] {
  if (!query) return [];
  const idx = index ?? buildV2Index(candidates);
  const groups = buildQueryGroups(query);
  const lcQuery = query.toLowerCase();

  const scored: PitfallScore[] = [];
  for (const c of candidates) {
    const doc = idx.docs.get(c.file);
    if (!doc || doc.size === 0) continue;
    let sum = 0;
    const korean: string[] = [];
    const derived: string[] = [];
    for (const g of groups) {
      // 그룹 내 최대 IDF 매치 1개만 채택 (중복 가산 차단)
      let best = 0;
      let bestTok = "";
      for (const t of g.toks) {
        if (!doc.has(t)) continue;
        const w = idf(idx, t);
        if (w > best) {
          best = w;
          bestTok = t;
        }
      }
      if (best < V2_IDF_FLOOR) continue; // 변별력 없는 일반어(확인/작업/대로…) 차단
      sum += best;
      if (bestTok.startsWith("k:")) korean.push(bestTok.slice(2));
      else derived.push(bestTok.slice(2));
    }
    let score = sum / lengthNorm(doc.size);

    // 정밀도 높은 신호는 가산으로 유지 (v1 계승)
    const block = extractFrontmatterBlock(c.body);
    const slug = c.file.replace(/^pitfall_/, "").replace(/\.md$/, "");
    const { explicit } = derivePitfallTriggers(slug, block);
    const explicitHits: string[] = [];
    for (const t of explicit) {
      if (t && lcQuery.includes(t)) {
        score += 0.5;
        explicitHits.push(t);
      }
    }
    if (score > 0) {
      scored.push({
        file: c.file,
        score,
        hits: {
          explicit: explicitHits,
          // 진단 출력이 폭발하지 않게 상위 몇 개만 남긴다 (점수에는 영향 없음)
          derived: derived.slice(0, 8),
          korean: korean.slice(0, 8),
        },
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return scored;
}

// ══════════════════════════════════════════════════════════════════════
// Phase 149 Step D — 2단 주입 (full body / 관련 인덱스)
// ══════════════════════════════════════════════════════════════════════
//
// ## 왜 top-8 을 더 짜내지 않는가 (2026-09-23 실측)
//   길이보정 3종 × IDF하한 4종 = 12조합 스윕 결과 recall@8 이 **38.5% 에서 포화**했다.
//   튜닝이 병목이 아니다. K 곡선을 보면 답이 나온다:
//
//     K=  8 → 30.8%      K= 25 → 61.5%      K= 40 → 84.6%
//     K= 60 → 92.3%      K=100 → 100%       (v1 은 K=100 에서도 0.0%)
//
//   신호는 분명히 있고 40위권 안에 들어온다. 문제는 **본문 8개만 넣는 구조**였다.
//
// ## 그래서 2단으로 나눈다
//   Tier A (full body, ~6KB×N) : 상위 FULL_K 개 — 지금 당장 읽어야 할 회피책
//   Tier B (한 줄 인덱스, ~120B×N): 상위 INDEX_K 개 — "관련 있을 수 있음" 신호.
//                                   에이전트가 이름을 보고 필요하면 직접 read 한다.
//   Tier B 40개 ≈ 5KB 로 recall 30.8% → 84.6%. 예산 대비 효율이 본문보다 훨씬 높다.
//
// ⚠ Tier B 는 "읽었다"가 아니라 "있다"를 알리는 것이다. 회피책을 봤다고 착각하면 안 된다.

/** Tier A — 본문 전체를 주입할 개수. */
// 값은 실측으로 골랐다 (2026-09-23, 골든셋 8케이스/13항목, FULL_K×INDEX_K 12조합 스윕):
//   3×45 → 92.3% / 17.8KB     4×45 → 92.3% / 21.5KB     4×60 → 100% / 23.5KB
//   6×30 → 76.9% / 24.7KB     (30 이하는 전부 61~77% 로 급락)
// 4×45 채택: 실행 가능한 본문 4개 + 이름 45개, 40KB cap 중 21.5KB.
// ⚠ 골든셋 n=13 이라 92.3% 와 100% 의 차이는 **단 1건**이다. 이 소수점에 과적합하지 말 것.
export const INJECT_FULL_K = Number(process.env.KDA_MEM_FULL_K ?? 4);
/** Tier B — 한 줄 인덱스로 알릴 개수 (Tier A 제외하고 이만큼 더). */
export const INJECT_INDEX_K = Number(process.env.KDA_MEM_INDEX_K ?? 45);

/** pitfall 파일에서 한 줄 요약을 뽑는다. frontmatter description → 첫 서술 줄 순. */
export function pitfallOneLiner(body: string, maxLen = 110): string {
  const block = extractFrontmatterBlock(body);
  const desc = block ? extractYamlScalar(block, "description") : null;
  let line: string | null = desc;
  if (!line) {
    const stripped = body.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
    for (const raw of stripped.split(/\r?\n/)) {
      const t = raw.trim();
      // 제목(#)·구분선·빈줄·코드펜스는 건너뛰고 첫 서술 문장을 쓴다
      if (!t || t.startsWith("#") || t.startsWith("---") || t.startsWith("```")) continue;
      line = t.replace(/^[*\-+]\s*/, "").replace(/\*\*/g, "");
      break;
    }
  }
  if (!line) return "";
  return line.length > maxLen ? line.slice(0, maxLen) + "…" : line;
}

export interface PitfallInjection {
  /** 본문을 넣을 파일들 (점수 내림차순) */
  full: PitfallScore[];
  /** 한 줄로만 알릴 파일들 (full 제외, 점수 내림차순) */
  index: PitfallScore[];
}

/**
 * 관련도 순위를 2단으로 나눠 반환.
 * 호출측은 full 에는 본문을, index 에는 `slug — 한 줄` 만 넣는다.
 */
export function selectPitfallInjection(
  candidates: PitfallCandidate[],
  query: string,
  index?: V2Index,
  fullK: number = INJECT_FULL_K,
  indexK: number = INJECT_INDEX_K,
): PitfallInjection {
  const scored = scorePitfallsV2(candidates, query, index);
  return {
    full: scored.slice(0, fullK),
    index: scored.slice(fullK, fullK + indexK),
  };
}
