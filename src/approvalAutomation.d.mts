import type { CodexElicitationRequest, CodexApprovalRequest } from './types';
export const APPROVAL_MODE_KEY: string;
export const APPROVAL_MODE_EVENT: string;
export type ApprovalRequest = CodexElicitationRequest | CodexApprovalRequest;
export type ApprovalReply = { action: 'accept' | 'decline' | 'cancel'; content: Record<string, unknown> | null };
export function automaticConfirmation(schema: unknown): Record<string, boolean> | null;
export function automaticResponse(request: ApprovalRequest, now?: number): ApprovalReply | null;
export function approvalDetail(request: CodexApprovalRequest): string;
