export const VIEW_PAGE_ROWS: number;
export const TOOL_INPUT_PREVIEW_CHARS: number;
export const TOOL_OUTPUT_PREVIEW_CHARS: number;
export const VIEW_SELECT_COLUMNS: string;

export interface ViewCursor {
  timestamp: number;
  id: string;
}

export function buildViewPageQuery(before?: ViewCursor | null): { sql: string; cursorParams: (string | number)[] };
export function decodeToolInputPreview(raw: string | null | undefined): { toolInput: unknown; inputPreview?: string };
export function decodeToolOutputPreview(raw: string | null | undefined): { toolOutput: string | undefined; outputPreview?: string };
export function toolPayloadPreservation(message: unknown): { keepInput: boolean; keepOutput: boolean };
export function buildPreservingUpdateSql(keep: { keepInput: boolean; keepOutput: boolean }): string;
export function preservingUpdateParams(
  upsertParams: (string | number | null)[],
  keep: { keepInput: boolean; keepOutput: boolean },
): (string | number | null)[];
export function prependOlder<T extends { id: string }>(current: T[], older: T[]): T[];
export function pageCursor(rows: { id: string; timestamp: number }[], limit: number): { hasOlder: boolean; before: ViewCursor | null };
export function prependedCount(prevFirstId: string | null | undefined, nextIds: string[]): number | null;
export const HISTORY_MIN_TEXT_MESSAGES: number;
export function countTextMessages(messages: { role: string }[]): number;
export function loadedMessagesSufficeForHistory(messages: { role: string }[], hasOlder: boolean, minText?: number): boolean;
