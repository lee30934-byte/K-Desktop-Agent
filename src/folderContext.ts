// Phase 145 (v0.7.22) — 폴더 프로젝트 지침 주입 해석 (순수 함수).
//
// 왜 별도 모듈인가:
//   폴더 지침(folderSystemPrompt) / 프로젝트 프로필 / 폴더 첨부 결정 로직이 App.tsx 의
//   handleSendMessage 안에만 인라인으로 있었다. 그래서 **사람이 직접 입력한 turn 만**
//   프로젝트 지침을 받았고, 자동 주입 경로(task-watch / 텔레그램 / 예약 / resume)는
//   지침 없이 실행됐다 — 에러도 경고도 없이 조용히.
//
//   실제 피해(2026-08-18, cae-automation): task-watch 로 주입한 실행자 turn 이 폴더의
//   권한 경계(수정 금지 경로, git 금지 목록, 판정 권한 없음)를 통째로 못 받아, 그 turn 은
//   무권한 상태로 굴러갔다. 회피책은 "프롬프트에 경계를 손으로 매번 동봉" 이었고,
//   한 번만 빠뜨려도 재발하는 구조였다.
//
//   결정 로직을 부작용 없는 함수 하나로 모아서 (a) 경로별 배선 누락을 없애고
//   (b) 실제로 각 경로가 지침을 싣는지 테스트한다.
//
// 이 모듈은 React / Tauri / DOM / DB 에 의존하지 않는다 (레코드를 주입받는다).
// 테스트: sidecar/test-folder-instructions.mjs (+ 행위: sidecar/folderContextBehavior.mjs)

import type { ProjectProfile } from "./db";

/** conversations 테이블에서 필요한 최소 필드. */
export interface ConversationFolderState {
  folderId?: string | null;
  /** 마지막으로 폴더 첨부를 박은 폴더 id. 현재 folderId 와 다르면 다시 박는다. */
  lastAttachedFolderId?: string | null;
}

/** folders 테이블에서 필요한 최소 필드. */
export interface FolderInstructionSource {
  systemPrompt?: string | null;
  projectProfile?: ProjectProfile | null;
  attachments?: Array<{ path?: string | null }> | null;
}

export interface ResolvedFolderContext {
  /** 매 turn 실린다 (사람 입력이든 자동 주입이든 동일). */
  folderSystemPrompt: string | undefined;
  /** 매 turn 실린다. sidecar 는 projectMode ON 일 때만 enforce. */
  projectProfile: ProjectProfile | undefined;
  /** 이번 turn 에 박을 폴더 첨부 경로. 이미 박은 폴더면 undefined (토큰 절약). */
  folderAttachmentPaths: string[] | undefined;
  /** 첨부를 박았을 때만 폴더 id. 호출부가 send 성공 후 DB sentinel 을 갱신한다. */
  didAttachFolderId: string | null;
}

export const EMPTY_FOLDER_CONTEXT: ResolvedFolderContext = {
  folderSystemPrompt: undefined,
  projectProfile: undefined,
  folderAttachmentPaths: undefined,
  didAttachFolderId: null,
};

function cleanText(v: string | null | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  return v.trim().length > 0 ? v : undefined;
}

/**
 * 대화 + 폴더 레코드로 이번 turn 에 실을 폴더 컨텍스트를 정한다.
 *
 * 규칙:
 *  1. systemPrompt 는 **경로를 가리지 않고 매 turn** 싣는다. 자동 주입 turn 이라고
 *     지침을 빼면 그 turn 만 무권한이 된다 — 이게 이 모듈이 생긴 이유다.
 *  2. projectProfile 도 매 turn 싣는다 (sidecar 가 OFF 면 무시하므로 안전).
 *  3. attachments 는 lastAttachedFolderId !== folderId 일 때만 싣는다 (중복 토큰 방지).
 *     - allowAttachments=false 면 아예 싣지 않는다. 첨부는 파일 읽기라 비용/실패 위험이
 *       있어, sentinel 을 갱신하지 못하는 호출부는 이 옵션을 끈다.
 *  4. 어떤 입력이 null/undefined/파손이어도 예외를 던지지 않는다. 지침 주입 실패로
 *     turn 자체가 죽으면 안 된다 (pitfall_js_arg_type_silent_throw).
 */
export function resolveFolderContext(
  conv: ConversationFolderState | null | undefined,
  folder: FolderInstructionSource | null | undefined,
  options?: { allowAttachments?: boolean },
): ResolvedFolderContext {
  const folderId = cleanText(conv?.folderId) ? String(conv?.folderId) : null;
  if (!folderId || !folder) return { ...EMPTY_FOLDER_CONTEXT };

  const folderSystemPrompt = cleanText(folder.systemPrompt);
  const projectProfile = folder.projectProfile ?? undefined;

  let folderAttachmentPaths: string[] | undefined;
  let didAttachFolderId: string | null = null;
  const allowAttachments = options?.allowAttachments !== false;
  if (allowAttachments && (conv?.lastAttachedFolderId ?? null) !== folderId) {
    const list = Array.isArray(folder.attachments) ? folder.attachments : [];
    const paths = list
      .map((a) => (a && typeof a.path === "string" ? a.path : ""))
      .filter((p) => p.length > 0);
    if (paths.length > 0) {
      folderAttachmentPaths = paths;
      didAttachFolderId = folderId;
    }
  }

  return { folderSystemPrompt, projectProfile, folderAttachmentPaths, didAttachFolderId };
}
