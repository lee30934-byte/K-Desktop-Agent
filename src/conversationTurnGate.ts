/**
 * Synchronous conversation-scoped single-flight gate.
 * The turn owner prevents a late done/error from unlocking a newer turn.
 */
export class ConversationTurnGate {
  private readonly owners = new Map<string, string>();

  claim(conversationId: string, turnId: string): boolean {
    if (!conversationId || !turnId || this.owners.has(conversationId)) return false;
    this.owners.set(conversationId, turnId);
    return true;
  }

  release(conversationId: string, turnId: string): boolean {
    if (this.owners.get(conversationId) !== turnId) return false;
    return this.owners.delete(conversationId);
  }

  releaseAny(conversationId: string): boolean {
    return this.owners.delete(conversationId);
  }

  isActive(conversationId: string): boolean {
    return this.owners.has(conversationId);
  }

  activeConversationIds(): Set<string> {
    return new Set(this.owners.keys());
  }

  clear(): void {
    this.owners.clear();
  }
}
