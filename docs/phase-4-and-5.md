# Conversations, a simulated day, and recorded playback

Implementation is in progress. This document will record the final checks and limits before the milestone is called complete.

Three citizens can now have separate thinking controls and memories in one shared, capped run. Conversations have independently chosen turns, participant claims, versions, refusal, a turn limit, and a timeout. Ordinary nearby speech does not wake a sleeping citizen; an explicit nearby alert can interrupt sleep.

The memory compiler still targets 8,000 input tokens. A decision can use up to 16,000 tokens after exact tool results accumulate. The original context and each request/result remain in PostgreSQL. A database timeout after a committed tool call parks the saved decision instead of asking the model to repeat it.

Replay uses `packages/playback` to reconstruct recorded state and interpolate only movement steps that actually happened. R2 recording chunks include a checkpoint, ordered events, an ending hash, and completed actor traces. Upload and complete readback must match SHA-256 and byte length before PostgreSQL publishes the chunk manifest. Hot data remains in PostgreSQL.

Verified so far:

- Three separate private memory/thinking controls, actual invitation/refusal and sleep reload in a Neon fixture.
- A lost database acknowledgement reuses the saved response and command ID. One inference and one physical effect.
- Time-based replay matches the final checkpoint and selects a half-tile position between recorded steps.
- An actual R2 recording roundtrip verified 8,552 bytes and reproduced the checkpoint hash.
- The first two autonomous day pilots stopped early on database transport and context headroom problems. They do not count as a successful full day. A fresh capped pilot is running after those fixes.

The video worker, browser controls, final day gate and final browser verification remain to be checked.
