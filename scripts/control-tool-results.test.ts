import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { codexToolResult } from "../sidecar/src/codexToolResult.ts";
import { toolResultOutcome } from "../src/toolResultOutcome.ts";

const textResult = (text: string) => JSON.stringify({ content: [{ type: "text", text }] });

test("MCP transport errors and isError cannot become successful empty cards", () => {
  const rpc = codexToolResult({ type: "mcp_tool_call", result: null, error: { message: "tool disconnected" } });
  assert.equal(rpc.status, "error"); assert.match(rpc.output, /disconnected/);
  assert.equal(codexToolResult({ type: "mcp_tool_call", result: { isError: true, content: [{ type: "text", text: "declined" }] } }).status, "error");
  assert.equal(codexToolResult({ type: "mcp_tool_call", status: "failed" }).status, "error");
});

test("nonzero and cancelled commands are errors; clean empty output is completed", () => {
  assert.equal(codexToolResult({ type: "command_exec", output: "", exitCode: 7 }).status, "error");
  assert.equal(codexToolResult({ type: "command_exec", exit_code: 1 }).status, "error");
  assert.equal(codexToolResult({ type: "command_exec", status: "cancelled" }).status, "error");
  assert.deepEqual(codexToolResult({ type: "command_exec", output: "", exitCode: 0 }), { output: "", status: "success" });
});

test("native MCP screenshots become thumbnail data, not base64 text history", () => {
  const data = "AAABBBCCCDDDEEEFFF000111222333444555";
  const result = codexToolResult({ type: "mcp_tool_call", result: { content: [
    { type: "text", text: "스크린샷 캡처 완료" }, { type: "image", mimeType: "image/png", data }], structuredContent: { width: 300 } } });
  assert.deepEqual(result.images, ["data:image/png;base64," + data]);
  assert.ok(!result.output.includes(data)); assert.match(result.output, /300/); assert.equal(result.status, "success");
  assert.ok(!codexToolResult({ type: "mcp_tool_call", result: { content: [{ type: "image", mimeType: "text/html", data }] } }).output.includes(data));
});

test("legacy control diagnostics report error even when the server omitted isError", () => {
  for (const [name, text] of [["web_open", "web 자동화 오류: ERR_HTTP2_PROTOCOL_ERROR"],
    ["web_snapshot", "(snapshot 실패: 'Page' object has no attribute 'accessibility')"],
    ["web_evaluate", "evaluate 실패: Execution context was destroyed"],
    ["ui_click_by_name", '컨트롤은 찾았지만 클릭 가능한 패턴이 없습니다: Button "fixture"'],
    ["ui_find", "창을 찾을 수 없습니다: 'fixture'"], ["mcp__k-personal__ui_invoke", "Invoke 실패: not supported"],
    ["ui_set_text", "ValuePattern 미지원/읽기전용 컨트롤입니다: Edit fixture"],
    ["cc_focus_window", "'fixture'을(를) 포함한 창을 찾을 수 없습니다."]]) {
    assert.equal(toolResultOutcome(name, textResult(text)).status, "error", name);
  }
});

test("completed actions with failed observations are warnings, never invitations to repeat the action", () => {
  const result = toolResultOutcome("web_click", "✓ click 성공\n\n(snapshot 실패: missing API)");
  assert.equal(result.status, "success"); assert.equal(result.observationWarning, true);
  assert.equal(toolResultOutcome("web_snapshot", "(snapshot 실패: missing API)").status, "error");
});

test("page text and ordinary zero-match searches cannot masquerade as tool failures", () => {
  for (const [name, text] of [["web_get_text", "오류: a heading on the requested page"],
    ["ui_find", "매칭 없음."], ["web_open", "✓ open\nTitle: 오류: fixture"],
    ["Bash", "evaluate 실패: quoted log"], ["file_read", "오류: content from a file"]]) {
    assert.equal(toolResultOutcome(name, text).status, "success", name);
  }
  assert.equal(toolResultOutcome("", JSON.stringify({ isError: true, content: [] })).status, "error");
  assert.equal(toolResultOutcome("", "", "error").status, "error");
});

const source = ts.createSourceFile("App.tsx", readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler = "";
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleSidecarEvent" && node.initializer) handler = node.initializer.getText(source);
  ts.forEachChild(node, visit);
}
visit(source); assert.ok(handler);
const compiled = ts.transpileModule(`return (${handler});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test("actual App handler persists failed tool results in the originating background conversation", () => {
  const saved: any[] = [], previous = { role: "tool", toolName: "ui_click_by_name", toolId: "call", status: "pending" };
  const deps = { taskWatchTurnsRef: { current: new Map() }, telegramTurnsRef: { current: { touch() {} } },
    turnToConvMap: { current: new Map([["turn", "conv"]]) }, conversationTurnGateRef: { current: { accepts: () => true } },
    logger: { warn: () => assert.fail() }, resolveEventConv: () => "conv", warnUnroutable: () => assert.fail(),
    activeConversationIdRef: { current: "different-visible-conversation" },
    messageCacheRef: { current: new Map([["conv", new Map([["turn-tool-call", previous]])]]) },
    queueMessageSave: (message: any, convId: string) => saved.push({ message, convId }),
    setMessages: () => assert.fail("Background results must not change the visible conversation"), toolResultOutcome };
  const handle = new Function(...Object.keys(deps), compiled)(...Object.values(deps));
  handle({ type: "tool_result", id: "turn", tool_id: "call", conversation_id: "conv", output: "컨트롤은 찾았지만 클릭 가능한 패턴이 없습니다: fixture" });
  assert.equal(saved.length, 1); assert.equal(saved[0].message.status, "error"); assert.equal(saved[0].convId, "conv");
  handle({ type: "tool_result", id: "turn", tool_id: "call", conversation_id: "conv", output: "", status: "error" });
  assert.equal(saved.at(-1).message.status, "error");
});

test("actual Codex event adapter emits an error even when a completed MCP call has no result", () => {
  const sidecar = ts.createSourceFile("index.ts", readFileSync(new URL("../sidecar/src/index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let clause = "";
  function find(node: ts.Node): void {
    if (ts.isCaseClause(node) && node.expression.getText(sidecar) === '"item.completed"' && node.getText(sidecar).includes("mcp_tool_call")) clause = node.getText(sidecar);
    ts.forEachChild(node, find);
  }
  find(sidecar); assert.ok(clause);
  const code = ts.transpileModule(`return function(event) { switch(event.type) { ${clause} } };`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const emitted: any[] = [];
  const fn = new Function("emit", "msg", "codexToolResult", "buildRiskMeta", "markActiveToolDone", code)(
    (v: any) => emitted.push(v), { id: "turn" }, codexToolResult, () => ({}), () => {});
  fn({ type: "item.completed", item: { type: "mcp_tool_call", id: "call", tool: "web_snapshot", error: { message: "failed" } } });
  assert.equal(emitted.at(-1).type, "tool_result"); assert.equal(emitted.at(-1).status, "error");
  assert.equal(emitted.at(-1).tool_id, "call");
});
