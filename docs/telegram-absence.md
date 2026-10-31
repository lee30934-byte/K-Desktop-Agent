# Telegram absence operation

Desktop-origin work previously had no general remote decision subscription. Follow-up delivery expired after six hours and its registry disappeared on restart. This change adds an explicit, bounded subscription for existing work and preserves pending result delivery across restart.

## Operation

- `/부재 36` subscribes the current tracked/running/queued work for 36 hours (allowed range 1–48 hours). Paused/stopping/stopped and unrelated new conversations are excluded. Default is OFF.
- `/부재 종료` disables the subscription. It does not stop work or change execution approval settings.
- `/상태` reports whole-app active/queued counts separately from Telegram-origin turns, the subscription and expiry, and unsent result count.
- `/부재검증` sends a two-minute, harmless approval-button challenge. Clicking it checks live Bot transport and callback ownership only. It executes no command, file operation or power action. It does not prove a native execution RPC or 24 hours of uptime.
- New turns for subscribed conversations receive the existing-work/recommendation instruction. Running engine prompts are not interrupted or rewritten. Existing approval exceptions remain in force.

## Request and delivery boundaries

Desktop and Telegram-origin Codex execution/MCP requests use the same dispatcher. Legacy confirmations are routed before the background-dialog guard and retain the existing 30-second timeout. Structured inputs use the native request deadline and require an explicit, schema-valid JSON reply. Model questions are forwarded with all question/option text; multiple questions never become a misleading single-number button.

Responses must match the permitted chat, original message, live conversation/turn and unexpired request. Duplicate, stopped, resolved, stale or cross-conversation responses cannot execute a new request. Turning off remote approval invalidates affirmative responses. Restart preserves notification bindings and unsent result text; pending execution approvals are deliberately invalidated and require a fresh request from the originating work.

Follow-up notification bindings last at most 48 hours and survive restart. Subscription bounds are 36 hours by default and at most 48. Result outbox entries remain until accepted by Telegram, with an in-flight guard against simultaneous initial delivery and retry. Partial chunk failures can repeat a delivered prefix on retry; Telegram sendMessage has no transaction/idempotency key. Result storage failure is reported and is not a restart guarantee.

Decision/error text bypasses quiet hours; ordinary results may be held until morning. Pending approvals without numbered options or a question mark are classified as urgent. Device/network outages and human-only visual review still require recovery or K's judgment. This is a verified configuration and simulated elapsed-time test, not a completed 24-hour soak test.

## Validation and rollout

Evidence: `C:/Users/lee30/.kda/remote/absence-readiness-20261031-v3/`.

The normal release gate includes `telegram-absence.test.ts` and `telegram-app.test.ts`. The latter executes the actual production App event handler extracted by TypeScript AST, with isolated native/Bot dependencies. The browser probe checks real localStorage, reload at 30 hours, rendered button clicks, duplicate rejection and expiry; its Bot/native transports are mocked.

The v0.7.64 installed runtime predates this feature. The v0.7.65 rollout combines this feature with the v0.7.64 fixes after K authorized proceeding with the combined release. Reconcile main and remote tags, perform the normal signed CI release and existing idle-gated updater, verify the installed version, then activate the subscription and run the phone challenge on request. Never run a second getUpdates poller or extract KDA settings through an alternate channel after a denied UI read.

OpenClaw's competing Telegram receiver was separately disabled through `channels.telegram.enabled=false`, after CLI dry-run validation. The gateway hot-reload released its polling lease. Other OpenClaw capabilities and the KDA bridge remain enabled. Re-enabling that receiver while KDA uses the same bot would recreate HTTP 409 conflicts.
