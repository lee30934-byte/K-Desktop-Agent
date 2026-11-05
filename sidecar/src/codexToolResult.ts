/** Convert completed Codex items without losing failures or dumping image bytes into chat history. */
export function codexToolResult(item: Record<string, any>): {
  output: string; status: "success" | "error"; images?: string[];
} {
  const result = item.result;
  const failed = item.error != null || result?.isError === true ||
    ["failed", "error", "declined", "cancelled", "canceled"].includes(item.status) ||
    (typeof item.exitCode === "number" && item.exitCode !== 0) ||
    (typeof item.exit_code === "number" && item.exit_code !== 0);
  if (item.error != null) return {
    output: typeof item.error === "string" ? item.error : item.error.message ?? JSON.stringify(item.error), status: "error",
  };
  const value = item.type === "mcp_tool_call" ? result : item.output;
  if (Array.isArray(value?.content)) {
    const images: string[] = [];
    const text = value.content.map((part: any) => {
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      if (part?.type === "image" && typeof part.data === "string" &&
          /^image\/(png|jpeg|webp|gif)$/.test(part.mimeType) && part.data.length > 16) {
        images.push(`data:${part.mimeType};base64,${part.data}`); return "";
      }
      // Unknown image formats stay out of the text context, including malformed base64.
      if (part?.type === "image") return "[도구 이미지 형식을 지원하지 않습니다.]";
      return part == null ? "" : JSON.stringify(part);
    }).filter(Boolean);
    if (value.structuredContent != null) text.push(JSON.stringify(value.structuredContent));
    return { output: text.join("\n"), status: failed ? "error" : "success", ...(images.length ? { images } : {}) };
  }
  return { output: value == null ? "" : typeof value === "string" ? value : JSON.stringify(value), status: failed ? "error" : "success" };
}
