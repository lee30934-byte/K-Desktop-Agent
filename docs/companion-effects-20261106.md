# Companion voice effects and v0.7.76

The ceramic companion has nine state/reaction poses, mint/pearl/rose finishes, torso-centered controls, scoped slate/mint settings and engine voice selection. The appearance panel saves a local effect preset and strength. Natural is the default. Warm, bright, small robot, deep and radio apply streaming pitch shift, EQ, ring modulation or saturation in the shared output graph. Changes update preview and active calls without reconnecting. Worklet or graph failures restore original audio. The existing remote-track decoding consumer, gain, limiter and cleanup remain required.

Evidence: `evidence/voice-effects-20261106/status.json` and `evidence/release-v0776-20261106/`. Candidate QA passed 21 UI checks, 39 voice-session tests, 6 DSP tests and the full gate. Hardware audio, naturalness and measured end-to-end latency remain unverified. This is not neural voice conversion or independent formant preservation. Phone access and other character designs are not implemented here.

K authorized the GitHub release. Preserve the prior explicit manual-install preference: no automatic install request or app restart.
