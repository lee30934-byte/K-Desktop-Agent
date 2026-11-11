// v0.7.86 UI 6단계 — 대화 내보내기 / 전체 백업 / 가져오기.
// 예전엔 Sidebar 안에만 있던 핸들러를 끌어올려 사이드바(두 배치 공통)와 헤더 ⋯ '이 대화 내보내기'(o2)가 같이 쓴다.
// 8단계에서 설정 › 데이터·백업으로 옮길 때도 이 함수를 그대로 쓴다.
import { save, open } from "@tauri-apps/plugin-dialog";
import {
  exportConversation,
  exportAllConversations,
  importConversation,
  importAllConversations,
  type ExportedConversation,
  type ExportedBackup,
} from "../db";

// 현재 대화 내보내기
export async function exportConversationToFile(conversationId: string | null): Promise<void> {
  if (!conversationId) {
    alert("내보낼 대화를 선택하세요.");
    return;
  }
  const data = await exportConversation(conversationId);
  if (!data) {
    alert("대화를 찾을 수 없습니다.");
    return;
  }
  const filePath = await save({
    defaultPath: `conversation_${data.conversation.title.replace(/[^a-zA-Z0-9가-힣]/g, "_")}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (filePath) {
    const fs = await import("@tauri-apps/plugin-fs");
    await fs.writeTextFile(filePath, JSON.stringify(data, null, 2));
    alert(`내보내기 완료: ${filePath}`);
  }
}

export async function exportAllConversationsToFile(): Promise<void> {
  const data = await exportAllConversations();
  const filePath = await save({
    defaultPath: `k_agent_backup_${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (filePath) {
    const fs = await import("@tauri-apps/plugin-fs");
    await fs.writeTextFile(filePath, JSON.stringify(data, null, 2));
    alert(`전체 백업 완료: ${data.conversations.length}개 대화`);
  }
}

// 가져오기 성공 시 onImported(목록 새로고침) 호출
export async function importConversationsFromFile(onImported?: () => void): Promise<void> {
  const filePath = await open({
    filters: [{ name: "JSON", extensions: ["json"] }],
    multiple: false,
  });
  if (!filePath) return;
  try {
    const fs = await import("@tauri-apps/plugin-fs");
    const content = await fs.readTextFile(filePath as string);
    const data = JSON.parse(content);
    if (data.conversations && Array.isArray(data.conversations)) {
      const backup = data as ExportedBackup;
      const imported = await importAllConversations(backup);
      alert(`${imported}개 대화 가져오기 완료!`);
    } else if (data.conversation && data.messages) {
      const conv = data as ExportedConversation;
      await importConversation(conv, true);
      alert(`"${conv.conversation.title}" 가져오기 완료!`);
    } else {
      alert("유효하지 않은 백업 파일입니다.");
      return;
    }
    onImported?.();
  } catch (e) {
    console.error("Import error:", e);
    alert("가져오기 실패: " + (e as Error).message);
  }
}
