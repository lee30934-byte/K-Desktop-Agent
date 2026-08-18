// Phase 145 (v0.7.22) — 폴더 지침 주입 **행위** 테스트 (정적 검사 아님).
//
// test-folder-instructions.mjs 가 `node --experimental-strip-types` 로 spawn 한다.
// (파일명이 test-*.mjs 가 아닌 이유: release-gate 의 회귀테스트 glob 이 이 파일을 플래그 없이
//  직접 실행해 TS import 에서 죽는 걸 막기 위함.)
//
// [함정 2026-08-18 / pitfall_ci_node20_type_stripping] .ts 정적 import 는 node >=22.6 에만
// 있어 CI(node 20)에서만 조용히 죽는다 → 로더를 2단계로 (스트리핑 → typescript transpile).
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __srcTs = nodePath.resolve(
  nodePath.dirname(fileURLToPath(import.meta.url)),
  "../src/folderContext.ts",
);

async function loadFolderContext() {
  try {
    return await import(pathToFileURL(__srcTs).href);
  } catch (e) {
    // 타입 스트리핑 미지원 런타임만 폴백. 그 외 에러는 감추지 않고 던진다.
    if (e?.code !== "ERR_UNKNOWN_FILE_EXTENSION") throw e;
  }
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(__srcTs, "utf-8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const tmp = nodePath.join(tmpdir(), `kda-folderContext-${process.pid}-${Date.now()}.mjs`);
  writeFileSync(tmp, js, "utf-8");
  try {
    return await import(pathToFileURL(tmp).href);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* 정리 실패는 테스트 결과에 영향 없음 */
    }
  }
}

const { resolveFolderContext, EMPTY_FOLDER_CONTEXT } = await loadFolderContext();

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}${detail ? " — " + detail : ""}`);
  }
}

// 실제 사고를 재현하는 픽스처: 폴더 지침 안에 권한 경계가 들어 있다.
const BOUNDARY = "권한 경계: git commit 금지. desktop/** 만 수정한다.";
const FOLDER = {
  systemPrompt: BOUNDARY,
  projectProfile: { name: "cae-automation", forbiddenTools: ["Bash"] },
  attachments: [{ path: "C:\\ref\\a.md" }, { path: "C:\\ref\\b.md" }],
};

console.log("Phase 145 — 폴더 지침 주입 행위 테스트\n");

// ── ① 자동 주입 turn(첨부 비허용)도 지침을 받는다 = 결함의 핵심 ───────────
{
  const r = resolveFolderContext(
    { folderId: "f1", lastAttachedFolderId: "f1" },
    FOLDER,
    { allowAttachments: false },
  );
  check("① 자동 주입 경로도 folderSystemPrompt 를 받는다", r.folderSystemPrompt === BOUNDARY, String(r.folderSystemPrompt));
  check("① 권한 경계 문구가 그대로 실린다", (r.folderSystemPrompt || "").includes("git commit 금지"));
  check("① projectProfile 도 실린다", r.projectProfile?.name === "cae-automation");
  check("① 첨부는 안 싣는다(비용/실패 회피)", r.folderAttachmentPaths === undefined);
  check("① sentinel 갱신 대상 없음", r.didAttachFolderId === null);
}

// ── ② 사람 입력 turn: 첫 send 면 첨부까지 ────────────────────────────────
{
  const r = resolveFolderContext(
    { folderId: "f1", lastAttachedFolderId: null },
    FOLDER,
    { allowAttachments: true },
  );
  check("② 첫 send 는 첨부 2개", Array.isArray(r.folderAttachmentPaths) && r.folderAttachmentPaths.length === 2);
  check("② sentinel 갱신 대상 = folderId", r.didAttachFolderId === "f1");
  check("② 지침은 당연히 함께", r.folderSystemPrompt === BOUNDARY);
}

// ── ③ 같은 폴더 재send 는 첨부 skip, 지침은 유지 ─────────────────────────
{
  const r = resolveFolderContext(
    { folderId: "f1", lastAttachedFolderId: "f1" },
    FOLDER,
    { allowAttachments: true },
  );
  check("③ 재send 첨부 skip(토큰 절약)", r.folderAttachmentPaths === undefined);
  check("③ 그래도 지침은 매 turn 실린다", r.folderSystemPrompt === BOUNDARY);
  check("③ 첨부 skip 이면 sentinel 갱신 없음", r.didAttachFolderId === null);
}

// ── ④ 폴더 이동 직후엔 새 폴더 첨부를 다시 박는다 ────────────────────────
{
  const r = resolveFolderContext(
    { folderId: "f2", lastAttachedFolderId: "f1" },
    FOLDER,
    { allowAttachments: true },
  );
  check("④ 폴더 바뀌면 첨부 재박음", r.didAttachFolderId === "f2");
}

// ── ⑤ 폴더 없음 / 지침 없음 = 기존 동작 보존 (빈 컨텍스트) ───────────────
{
  const noFolder = resolveFolderContext({ folderId: null }, FOLDER, { allowAttachments: true });
  check("⑤ 폴더 미소속이면 아무것도 안 싣는다", noFolder.folderSystemPrompt === undefined && noFolder.folderAttachmentPaths === undefined);

  const empty = resolveFolderContext({ folderId: "f1" }, { systemPrompt: "   " });
  check("⑤ 공백 지침은 미지정 취급", empty.folderSystemPrompt === undefined, String(empty.folderSystemPrompt));

  const nullFolder = resolveFolderContext({ folderId: "f1" }, null);
  check("⑤ 폴더 레코드가 null 이어도 예외 없음", nullFolder.folderSystemPrompt === undefined);
}

// ── ⑥ 어떤 파손 입력에도 turn 을 죽이지 않는다 ───────────────────────────
{
  let threw = false;
  try {
    resolveFolderContext(null, undefined);
    resolveFolderContext(undefined, { attachments: "not-an-array" });
    resolveFolderContext({ folderId: "f1" }, { attachments: [null, { path: 123 }, { path: "" }] });
  } catch {
    threw = true;
  }
  check("⑥ null/파손 입력에도 throw 없음", !threw);
  const r = resolveFolderContext({ folderId: "f1" }, { attachments: [null, { path: 123 }, { path: "C:\\ok.md" }] });
  check("⑥ 잘못된 항목은 걸러내고 유효 경로만", JSON.stringify(r.folderAttachmentPaths) === JSON.stringify(["C:\\ok.md"]));
}

// ── ⑦ 기본값은 "첨부 허용" 이지만 지침은 옵션과 무관 ─────────────────────
{
  const r = resolveFolderContext({ folderId: "f1", lastAttachedFolderId: null }, FOLDER);
  check("⑦ 옵션 생략 시 첨부 허용", r.didAttachFolderId === "f1");
  const r2 = resolveFolderContext({ folderId: "f1", lastAttachedFolderId: null }, FOLDER, {});
  check("⑦ 빈 옵션도 동일", r2.didAttachFolderId === "f1");
}

// ── ⑧ EMPTY 상수를 공유해도 호출부가 오염되지 않는다 ─────────────────────
{
  check("⑧ EMPTY 는 전부 미지정", EMPTY_FOLDER_CONTEXT.folderSystemPrompt === undefined && EMPTY_FOLDER_CONTEXT.didAttachFolderId === null);
  const a = resolveFolderContext({ folderId: null }, null);
  a.folderSystemPrompt = "오염";
  const b = resolveFolderContext({ folderId: null }, null);
  check("⑧ 반환값 변조가 다음 호출에 새지 않음", b.folderSystemPrompt === undefined, String(b.folderSystemPrompt));
}

// 주의: "결과: N/M 통과" 라는 문구를 쓰면 release-gate 가 부모 집계 대신 이 줄을 집어간다.
console.log(`\nBEHAVIOR-SUMMARY: ${pass}/${pass + fail} assertions ok`);
process.exit(fail === 0 ? 0 : 1);
