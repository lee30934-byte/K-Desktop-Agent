import { parseElicitationSchema, validateElicitationContent } from '../sidecar/src/mcp-elicitation-schema.mjs';

export const APPROVAL_MODE_KEY = 'kda_auto_approve';
export const APPROVAL_MODE_EVENT = 'kda-approval-mode-changed';

// Only a confirmation can be answered without user input. Never infer a
// preference, credential, text answer or consent from a schema default.
export function automaticConfirmation(schema) {
  const fields = parseElicitationSchema(schema);
  // A valid empty form asks for accept/decline only. MCP tool-use consent
  // often has no boolean input; accepting it supplies an empty object.
  if (fields?.length === 0) return validateElicitationContent(schema, {}) ? {} : null;
  if (fields?.length !== 1) return null;
  const field = fields[0];
  if (field.type !== 'boolean' || !field.required ||
      !['approve', 'approved', 'confirm', 'confirm_read', 'confirm_action'].includes(field.name)) return null;
  const content = { [field.name]: true };
  return validateElicitationContent(schema, content) ? content : null;
}

export function approvalDetail(request) {
  if (request.networkApprovalContext) {
    const n = request.networkApprovalContext;
    return `네트워크: ${n.protocol ?? '?'}://${n.host ?? '?'}:${n.port ?? '?'}`;
  }
  return request.kind === 'command'
    ? `명령: ${Array.isArray(request.command) ? request.command.join(' ') : request.command ?? '(없음)'}\n작업 폴더: ${request.cwd ?? '(없음)'}`
    : `파일 변경:\n${(request.changes ?? []).map(c => `${c.kind}: ${c.path}\n${c.diff ?? ''}`).join('\n')}`;
}

export function automaticResponse(request, now = Date.now()) {
  if (!request.id || !request.token || !request.threadId || !request.conversation_id ||
      !Number.isFinite(request.expiresAt) || request.expiresAt <= now) return null;
  if (request.type === 'codex_elicitation_request') {
    const content = automaticConfirmation(request.schema);
    return content ? { action: 'accept', content } : null;
  }
  if (request.type !== 'codex_approval_request' || !request.turnId || !request.itemId ||
      !['command', 'file'].includes(request.kind) || approvalDetail(request).length > 12000) return null;
  const reviewable = request.kind === 'command'
    ? (typeof request.command === 'string' && request.command.trim().length > 0) ||
      (Array.isArray(request.command) && request.command.length > 0 && request.command.every(c => typeof c === 'string')) ||
      !!request.networkApprovalContext
    : Array.isArray(request.changes) && request.changes.length > 0;
  return reviewable ? { action: 'accept', content: null } : null;
}
