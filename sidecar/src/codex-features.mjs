// v0.7.86 — KDA 가 띄우는 Codex app-server 에서 끄는 Codex 내장 기능 목록 (단일 출처).
//
// 배경 (2026-11-11 K 확정: "codex 기능을 안쓰는게 나을거 같은데 기본적으로 kda 에 도구들 다 있자나"):
// - Codex 의 computer_use / browser_use 는 Codex 데스크톱 앱의 네이티브 헬퍼·내장 브라우저가 있어야
//   실제로 동작한다. KDA 가 쓰는 npm CLI(app-server) 에는 그 실행기가 없어서, 모델이 도구를 골라도
//   마우스·브라우저가 움직이지 않고 턴만 헛돈다 (다른 PC v0.7.83 실사용 증상).
// - 같은 일은 KDA 의 k-personal 도구(web_* / ui_* / cc_*)가 실제로 하고, 입력 잠금·창 확인·실패 신호·
//   멈춤 감시도 그쪽에만 있다. 도구 목록에 겹치는 내장 도구가 있으면 모델은 내장 쪽을 먼저 고른다.
// - 그래서 겹치는 기능은 도구 목록에서 아예 빼서 모델이 고를 수 없게 한다 (대화로 "쓰지 마" 는 효과 없음).
//
// 끄지 않는 것: shell/파일 편집(엔진 본체), image_generation·plugins/apps(KDA 대체 도구 없음),
// in_app_voice(KDA 음성 세션이 사용), skills.
//
// 형식: `-c features.<name>=false`. 아는 버전에선 끄고, 모르는 버전에선 무시된다.
// `--disable <name>` 은 모르는 버전에서 "Unknown feature flag" 로 시작 자체가 실패하므로 금지 (2026-11-11 실측).
export const CODEX_DISABLED_FEATURES = Object.freeze([
  "computer_use",
  "browser_use",
  "browser_use_external",
  "in_app_browser",
]);

export function codexAppServerArgs() {
  const args = ["app-server", "--stdio"];
  for (const name of CODEX_DISABLED_FEATURES) args.push("-c", `features.${name}=false`);
  return args;
}
