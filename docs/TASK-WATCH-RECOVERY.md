# Task-watch failure recovery

The installed 0.7.44 frontend recorded watch errors for retry, then called `ConversationControl.finish(..., "failed")`, which persisted a pause. The next tick logged `conversation-busy` forever. These frontend sources were unchanged in the 0.7.45 source baseline (`2033546cf4141b00d050577f1a96796abc46e784`).

The new delivery decision is written before the conversation owner is released. Capacity and explicit transient transport errors receive up to five total attempts, with 30/60/120/240-second waits. Other errors, approval denials, authentication/usage failures and user stops require review. A retry never clears a conversation or global stop. Existing pauses without provenance remain paused; the app cannot safely infer whether they were user stops.

The scan and claim paths recheck the completion file/PID and any recorded producer PID. A ready scan is not authority to use a now-missing completion. A still-running producer holds delivery. An initial timeout can report missing completion, but a later retry needs fresh completion evidence. Notification retries skip `run` launch processing and include instructions to inspect durable outputs/processes before any further work.

The app records a final response in the marker before writing it to the conversation database and ACKing it. A restart or DB/ACK failure replays these local writes under the same message ID, without a new model call. A claimed turn interrupted before a final result or classified terminal error is ambiguous and requires review. New claims reject a current owner, backoff, exhausted budget and mismatched conversation. These guarantees do not make arbitrary external tool side effects exactly-once.

The waiting banner distinguishes running, stopping, user/global/legacy pause, retry backoff, exhausted budget, missing completion and live producer. Old unknown pauses and interrupted claims require user review rather than silently running again. Task-watch does not supply approvals or change model selection.

Validation:

- `node sidecar/test-task-watch-recovery.mjs`: frontend control/recovery with the production Rust delivery module, real temporary marker files, no model or desktop action.
- `node sidecar/test-conversation-control.mjs` and `node sidecar/test-task-watch.mjs`: existing control and wiring regressions.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib task_watch`: production command helpers, completion disappearance and a real live process guard.
- `npm run release:gate`: full source/build gate. This is a check, not a release.

Implementation evidence and runner receipts are in `evidence/taskwatch-capacity-20261013/`. Installed GUI verification remains separate and requires an approved update. This change does not clear live pauses or modify production marker/DB contents.
