# Codex MCP additional consent

KDA displays a schema-aware form for `mcpServer/elicitation/request`. The user explicitly chooses Accept, Decline, or Cancel; accepting returns the entered content for that one RPC request. Permission settings, model mode, old command approvals, and schema defaults never grant consent.

Supported: flat object forms (`form`, and the same supported subset if an `openai/form` or legacy `openaiForm` request arrives), strings, booleans, bounded numbers/integers, string enums, titled enums, multi-select enums, and the standard email/URI/date/date-time formats. Empty object forms still require an explicit approval click. Unsupported constraints, nested forms, URL flows, missing/mismatched context, and excessive payloads are declined without aborting the turn. Extended-form capability is not advertised because arbitrary extended schemas are not supported.

The bridge validates content again before sending it. A random single-use token binds the response to the RPC request, thread, optional Codex turn ID, and its owning KDA process. No response is accepted after the 120-second deadline, server resolution, or turn termination. Background requests remain in their own conversation; a click can approve only the active running conversation. Raw form values are not written to diagnostics.

Protocol reference: https://learn.chatgpt.com/docs/app-server#MCP-server-elicitation-requests . The implementation also uses the schema generated from the installed Codex CLI 0.158.0 (the request `turnId` is nullable).

Verification commands:

- `node sidecar/test-mcp-elicitation-schema.mjs`
- `node sidecar/test-codex-elicitation-ui-protocol.mjs`
- `node sidecar/test-codex-elicitation-bridge.mjs`
- `npm run sidecar:build` and `node sidecar/probe-codex-elicitation-turn.mjs` (offline built-sidecar continuation)
- `KDA_PROBE_ELICITATION_ACTION=accept` also exercises explicit accepted content through the offline sidecar.
- `py -3 scripts/probe-codex-elicitation-ui.py` (local Playwright + headless Edge; rendered React form, not the installed app)
- `npm run release:gate` and `scripts/check.ps1`

Installed validation must separately record the installed executable version, actual request delivery, visible form, the user's response, MCP result, and normal turn completion. Offline fixtures cannot establish actual installed consent or a successful k-personal call.

The 2026-10-07 earlier diagnosis that all ui_list_windows rejections happened before the KDA bridge was not justified. Installed logs contain the v0.7.43 unsupported-elicitation notice, including epoch 1791028555 and multiple later occurrences. Individual calls still require correlation; generic `user rejected MCP tool call` alone does not identify which layer declined.
