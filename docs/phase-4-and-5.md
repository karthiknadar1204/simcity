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

## Recorded video and restart checks

The real export path passed on fixture run `e0183edb-bbcd-49b9-91c6-11386c494b6d`: 60 frames, 1280×720, 30 fps, 2.000 seconds, 26,625 MP4 bytes. The video, PNG thumbnail and JSON manifest passed R2 full readback checks. Source world hashes matched before and after export. Actor calls and memory calls were both zero. The browser loaded the signed-storage result through the same-origin API proxy and reported 1280×720, two seconds, no playback error.

A separate process test killed a server process while three citizens slept, waited for its ownership lease to expire, and resumed from a new process. All three woke at 07:00 on day two. The pre-restart world hash and simulation time matched exactly. Three consolidation tasks retained their pre-sleep cutoffs. This is a controlled mechanics fixture, not evidence that a model independently chose sleep.

The installed Neon 1.2.0 driver had a reproducible queued-connection regression. A test held the only pool slot, queued a second query, terminated the held session, and released it. The queued query stayed stuck on 1.2.0. Pinning the workspace to 1.1.0 made the same test pass. See [the upstream issue](https://github.com/neondatabase/serverless/issues/230) and [the release history](https://github.com/neondatabase/serverless/blob/main/CHANGELOG.md). No database schema or TLS settings changed for this workaround.
