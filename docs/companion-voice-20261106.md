# Companion voice selection

K requested selecting a voice that suits the companion. The appearance panel now loads the installed Codex engine's `thread/realtime/listVoices` v3 catalog, saves the selected voice with companion preferences, and passes it through VoiceSession, Tauri and the sidecar to `thread/realtime/start.voice`.

Existing preferences migrate to the engine default, preserving the previous voice behavior. Colors do not overwrite the chosen voice. Unavailable saved choices remain visible; the native broker rejects them before starting a realtime session. A voice change during a call applies on the next connection, without reconnecting the ongoing call.

Preview uses a receive-only WebRTC transceiver without requesting a microphone. It runs at the saved KDA output gain, has a fixed Korean sample, no dynamic tools or work dispatch, and ends after the sample or a bounded timeout. Closing the appearance panel, minimizing, changing the selected voice, or starting a call stops preview. An active call disables preview. Actual audible quality and hardware media have not been verified.

Evidence: `evidence/companion-voice-20261106/`, including the live catalog, unit tests, UI receipts and the full validation. No release, tag, install, external publication, or real microphone session is part of this change.

Sources: installed Codex 0.164.0 schema in `evidence/voice-research-20261106/codex-0.164.0-schema/v2/`; [OpenAI Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations). The installed app-server catalog is authoritative for selectable voices; a generic Realtime API voice list is not substituted.
