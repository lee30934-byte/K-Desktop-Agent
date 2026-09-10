import { ConversationTurnGate } from "./conversationTurnGate.ts";

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected=${String(expected)} actual=${String(actual)}`);
}

export function runConversationTurnGateChecks(): void {
  const gate = new ConversationTurnGate();
  assertEqual(gate.claim("conv-a", "turn-1"), true, "첫 turn claim");
  assertEqual(gate.claim("conv-a", "turn-2"), false, "같은 대화 중복 차단");
  assertEqual(gate.claim("conv-b", "turn-3"), true, "다른 대화 병렬 허용");
  assertEqual(gate.release("conv-a", "wrong-turn"), false, "잘못된 owner 해제 차단");
  assertEqual(gate.release("conv-a", "turn-1"), true, "정확한 owner 해제");
  assertEqual(gate.claim("conv-a", "turn-4"), true, "완료 뒤 다음 turn 허용");
  gate.clear();
  assertEqual(gate.isActive("conv-a"), false, "clear conv-a");
  assertEqual(gate.isActive("conv-b"), false, "clear conv-b");
}
