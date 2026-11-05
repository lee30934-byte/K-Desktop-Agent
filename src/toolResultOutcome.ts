export interface ToolResultOutcome { status: "success" | "error"; observationWarning: boolean }

/** Legacy K-Personal tools return some failures as text without MCP isError.
 * Inspect only their diagnostic first line, never arbitrary page text or quoted logs.
 * A completed click followed by a snapshot failure must not encourage a repeated action.
 */
export function toolResultOutcome(name: string, output: string, explicitStatus?: string): ToolResultOutcome {
  let text = output;
  let isError = explicitStatus === "error";
  if (output.length <= 262144 && output.trimStart().startsWith("{")) {
    try {
      const result = JSON.parse(output);
      isError ||= result?.isError === true;
      if (Array.isArray(result?.content)) text = result.content
        .filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text).join("\n");
    } catch { /* Unstructured tool text is valid output. */ }
  }
  const tool = name.split("__").pop() ?? name;
  const first = text.trimStart().split(/\r?\n/, 1)[0];
  const wrapped = /^(web_(open|snapshot|click|fill|evaluate|screenshot)|ui_(dump_tree|find|click_by_name|click_by_id|set_text|focus_control|invoke|list_windows)|cc_(focus_window|mouse_click|keyboard_type|keyboard_hotkey))$/.test(tool);
  const diagnostic = /^(web 자동화 오류:|evaluate 실패:|fill 실패:|screenshot 실패:|클릭 실패:|UIA 오류:|창 열거 실패:|Invoke 실패:|포커스 실패:|창 활성화 중 오류:|오류:|\(snapshot 실패:|창을 찾을 수 없습니다:|컨트롤을 찾을 수 없습니다\.|컨트롤은 찾았지만 클릭 가능한 패턴이 없습니다:|ValuePattern 미지원\/읽기전용 컨트롤입니다:|'[^'\n]{1,500}'을\(를\) 포함한 창을 찾을 수 없습니다\.)/.test(first);
  const observationWarning = /^web_(open|click|fill)$/.test(tool) && /^✓/.test(first) && /\(snapshot 실패:/.test(text);
  return { status: isError || (wrapped && diagnostic) ? "error" : "success", observationWarning };
}
