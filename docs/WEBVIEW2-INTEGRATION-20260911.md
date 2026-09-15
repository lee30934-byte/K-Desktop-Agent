# WebView2 native integration candidate

Base: exact clean commit `3bac792c4021c2aeadfbcd752875f28d9b0a75cf`, package version **0.7.34**. The older evidence folder name `release-0.7.33` is not a version authority. Studio/Office working changes were not copied.

## Implemented candidate

- Rust BrowserHost owns separate UUID-labelled browser leases, one owner per turn and at most five retained leases. Callers must close terminal leases to release capacity.
- WebView2 evaluates the adapter using Tauri 2.11.5 callbacks. This candidate pins that version; dependency regression validation is required before release.
- BrowserHost is registered as a native module and local-main-window command. Remote pages have no native command authority.
- Sidecar stdout requests are consumed by the native host, not sent to React. Replies return on the originating sidecar's own stdin channel. The Node client binds both request ID and owner and never retries sends.
- Every sidecar generation has its own BrowserHost; EOF closes its host and rejects late requests. An old watchdog compares the exact window label before touching a replacement lease.
- Backend polling owns the 180-second turn deadline and physical window destruction check, even when React polling stops. Cleanup has a 15-second confirmation limit.
- Browser-only adapter supports bounded arbitrary text, preserves nonempty drafts, and collects only newly bound assistant turns. Prompt contents are serialized as JSON, never interpolated as executable JavaScript.
- New client transport tests cover crossed owners, out-of-order replies, timeout without retransmission, late replies, disconnection, and malformed replies.

## Validation boundary and next work

The previous isolated executable proved login, restart persistence, exact reply, cancellation, and hidden-window completion. Those observations do **not** prove this newly integrated module works. Read `evidence/browser-host-integration/build-v1/result.json` and logs before interpreting the done marker.

The sidecar client is connected to stdin reception but not yet selected by a user-facing provider or Responses server. Do not call this a complete engine. Remaining: native module runtime probe, OAuth popup-specific execution, Responses routing, existing permission-gated Full Tunnel/MCP capability execution, model/effort selection, attachment acceptance, queueing, compaction/resume and concurrent-turn scenarios. Full-mode capability must never dispatch tools directly around KDA permissions.

Do not launch the normal candidate KDA executable for verification: its existing startup routines can touch installed user data. Use a separate test application identity/profile and import the actual candidate BrowserHost module. Never open the old harness and new host on the same WebView2 profile concurrently. No Codex settings changes, updater/signing/registry/autostart operations, release or install are authorized by this candidate build.
