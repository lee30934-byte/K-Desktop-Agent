# Voice playback repair after v0.7.73

K confirmed that a call was started and speech was sent, but no spoken answer was heard. The installed executable was observed as v0.7.73. Seeing the call closed after the complaint did not establish why the earlier call was silent.

## Reproduction

The frozen v0.7.73 browser fixture connected to the actual installed Codex subscription transport with synthetic Korean microphone input and fixture task handlers. It received the expected status answer and 1,083 audio packets, while every downstream gain-graph sample was zero. A second run remained at zero for 470 samples. In that same run, attaching a zero-volume source media consumer and requesting a diagnostic utterance produced 26 nonzero, unmuted playback samples. No real microphone, speaker, account secret, or real task handler was used.

This isolates the new amplification path: Chromium did not pump the received WebRTC track through the Web Audio source until the source stream also had an active media element consumer. Directly generated local MediaStreams used by the original gain probe did not reproduce the failure.

Separately, three executable regressions showed that interruption mute could stay latched when the first output transcript preceded the user's final transcript, or when local input noise ended without another output transcript. The explicit speech-stop latch must still be preserved.

## Change

`VoiceOutput` owns a zero-volume source media element. `resume()` activates it before resuming the gain graph, and `close()` pauses and detaches it without stopping the received source track. The processed destination remains the audible output and retains the chosen speaker and KDA gain. OS volume and microphone settings are untouched.

`VoiceSession` reevaluates temporary mute when user speech completes or the local 650ms quiet interval expires. It does not release explicit speech-stop or change task routing, approval, or execution gates.

The probes accept a separate output directory to preserve previous evidence. The output test now uses an actual local WebRTC pair, measures post-gain signal, verifies the silent consumer and resource cleanup, and preserves failure receipts. The subscription probe measures post-gain energy and unmuted playback; packets and text alone cannot pass.

## Evidence and scope

- `evidence/voice-silence-fix-20261106/status.json`: current repair state.
- `baseline/native-probe-120022289026.json`: connected/text/packets but zero output signal.
- `baseline/native-probe-120225545227.json`: zero output before the silent source activation; nonzero afterward.
- `fixed/audio-verification.json`: local WebRTC signal, amplification ratio, mute and cleanup.
- `fixed/native-probe-120419830844.json`: actual subscription status reply, 137 nonzero unmuted output samples.
- `regression-before.log`: original 26 pass, three new playback regressions fail.
- `regression-after.log`: all 29 voice regressions pass.
- `gate.done.json` / `release-gate.log`: full local release gate and frozen code manifest.

These are synthetic audio and browser playback checks. Actual microphone/speaker audibility, acoustic echo, installed WebView2 behavior and natural speech routing across real conversations still require installed verification. The source repair has not been published or installed. The earlier v0.7.73 release receipt remains historical evidence and is not overwritten as repaired.

Protocol background: [official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server). The decoding diagnosis and pass/fail decisions above come from the measured KDA fixtures, not a claim that the official documentation guarantees this behavior.
