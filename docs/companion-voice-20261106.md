# Companion voice selection

K requested selecting a voice that suits the companion. The appearance panel now loads the installed Codex engine's `thread/realtime/listVoices` v3 catalog, saves the selected voice with companion preferences, and passes it through VoiceSession, Tauri and the sidecar to `thread/realtime/start.voice`.

Existing preferences migrate to the engine default, preserving the previous voice behavior. Colors do not overwrite the chosen voice. Unavailable saved choices remain visible; the native broker rejects them before starting a realtime session. A voice change during a call applies on the next connection, without reconnecting the ongoing call.

Preview generates an exact-zero audio input track without requesting a microphone or routing that source to speakers. The v3 preview request uses a fixed, trusted developer text instruction; regular call feedback keeps its existing speech-append path. The preview runs at the saved KDA output gain, has no dynamic tools or work dispatch, and ends after the sample or a bounded timeout. A timeout without generated speech displays an error. Closing the appearance panel, minimizing, changing the selected voice, or starting a call stops preview and releases its source, tracks, context and peer. An active call disables preview. Actual audible quality and hardware media have not been verified.

Evidence: `evidence/companion-voice-20261106/`, including the live catalog, unit tests, UI receipts and the full validation. No release, tag, install, external publication, or real microphone session is part of this change.

Preview silence regression: `evidence/voice-preview-fix-20261106/`. Original receive-only and speech-append combinations could connect without producing audio. The combined correction passed real subscription previews with Juniper and Haetsal, measured after the gain graph, with zero microphone requests and zero work dispatch. The live engine catalog remains authoritative; names in mocked unit fixtures are not evidence that those voices are available. Hardware listening and speech naturalness remain unverified.

Sources: installed Codex 0.164.0 schema in `evidence/voice-research-20261106/codex-0.164.0-schema/v2/`; [OpenAI Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations). The installed app-server catalog is authoritative for selectable voices; a generic Realtime API voice list is not substituted.
