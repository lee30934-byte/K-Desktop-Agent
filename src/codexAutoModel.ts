/** Codex 자동 모델 선택. 계정 한도는 모델별 잔량이 아니므로 선택 근거로 추정하지 않는다. */
export type CodexAutoChoice = {
  model: "gpt-6-luna" | "gpt-6-sol" | "gpt-6-astra";
  reasoningEffort: "low" | "medium" | "high";
  reason: string;
};

/** 자동 모드는 매 요청에서 선택한다. 구버전 model="auto"도 유지한다. */
export function shouldAutoSelectCodexModel(
  mode: string | null,
  globalModel: string | null,
): boolean {
  return mode === "auto" || (mode === null && globalModel === "auto");
}

export function chooseCodexAutoModel(prompt: string): CodexAutoChoice {
  const text = prompt.trim();
  if (/릴리스|release|배포|deploy|보안|security|취약점|vulnerabil|데이터베이스|database|마이그레이션|migration|결제|payment|법률|legal|의료|medical|금융|financial|원인 분석|root cause|아키텍처|architecture|설계와 구현|end.to.end|전체 구현|다중 파일|multi.file/i.test(text)) {
    return { model: "gpt-6-astra", reasoningEffort: "high", reason: "정확도와 검증이 중요한 작업" };
  }

  // 긴 지침이나 파일 첨부는 짧은 요청 문장만으로 난도를 낮게 판단할 수 없다.
  if (!text || text.length > 1200 || /\[파일 첨부:|<memory_context>|<prior_conversation>/i.test(text)) {
    return { model: "gpt-6-sol", reasoningEffort: "medium", reason: "맥락이 길거나 불명확해 균형 모델 선택" };
  }

  // 좁고 명확한 요청에서만 경량 모델을 사용한다. 나머지는 Sol로 둔다.
  if (text.length <= 240 && (/^(하이|안녕|hello|hi|고마워|thanks|감사)[!?.\s]*$/i.test(text) || /^(번역|translate|요약|summari[sz]e|제목 추천|문장 교정|맞춤법|짧게 설명|한 줄로|한줄로|이름 추천|목록 정리)([:\s]|$)/i.test(text))) {
    return { model: "gpt-6-luna", reasoningEffort: "low", reason: "짧고 범위가 명확한 요청" };
  }
  return { model: "gpt-6-sol", reasoningEffort: "medium", reason: "일반 작업의 품질과 사용량 균형" };
}
