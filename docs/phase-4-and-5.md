# Conversations, a simulated day, and recorded playback

The Phase 4 engine and Phase 5 viewer/export paths are implemented. The complete autonomous-day gate is still being validated. The checks below distinguish model behavior from controlled mechanics fixtures.

Three citizens can now have separate thinking controls and memories in one shared, capped run. Conversations have independently chosen turns, participant claims, versions, refusal, a turn limit, and a timeout. Ordinary nearby speech does not wake a sleeping citizen; an explicit nearby alert can interrupt sleep.

The memory compiler still targets 8,000 input tokens. A decision can use up to 16,000 tokens after exact tool results accumulate. The original context and each request/result remain in PostgreSQL. A database timeout after a committed tool call parks the saved decision instead of asking the model to repeat it.

Replay uses `packages/playback` to reconstruct recorded state and interpolate only movement steps that actually happened. R2 recording chunks include a checkpoint, ordered events, an ending hash, and completed actor traces. Upload and complete readback must match SHA-256 and byte length before PostgreSQL publishes the chunk manifest. Hot data remains in PostgreSQL.

Verified so far:

- Three separate private memory/thinking controls, actual invitation/refusal and sleep reload in a Neon fixture.
- A lost database acknowledgement reuses the saved response and command ID. One inference and one physical effect.
- Time-based replay matches the final checkpoint and selects a half-tile position between recorded steps.
- An actual R2 recording roundtrip verified 8,552 bytes and reproduced the checkpoint hash.
- The first two autonomous day pilots stopped early on database transport and context headroom problems. They do not count as a successful full day. A fresh capped pilot is running after those fixes.

The video worker and browser controls have passed their real service checks. The remaining acceptance check is the complete autonomous day.

## Recorded video and restart checks

The real export path passed on fixture run `e0183edb-bbcd-49b9-91c6-11386c494b6d`: 60 frames, 1280×720, 30 fps, 2.000 seconds, 26,625 MP4 bytes. The video, PNG thumbnail and JSON manifest passed R2 full readback checks. Source world hashes matched before and after export. Actor calls and memory calls were both zero. The browser loaded the private R2 video through the same-origin API proxy and reported 1280×720, two seconds, no playback error.

A separate process test killed a server process while three citizens slept, waited for its ownership lease to expire, and resumed from a new process. All three woke at 07:00 on day two. The pre-restart world hash and simulation time matched exactly. Three consolidation tasks retained their pre-sleep cutoffs. This is a controlled mechanics fixture, not evidence that a model independently chose sleep.

The installed Neon 1.2.0 driver had a reproducible queued-connection regression. A test held the only pool slot, queued a second query, terminated the held session, and released it. The queued query stayed stuck on 1.2.0. Temporarily pinning the workspace to 1.1.0 made the same test pass, but longer WebSocket runs still dropped sessions. The final runtime now uses the standard TLS connection described below. See [the upstream issue](https://github.com/neondatabase/serverless/issues/230) and [the release history](https://github.com/neondatabase/serverless/blob/main/CHANGELOG.md). No database schema or TLS settings changed for this workaround.

## Scenario calibration and remaining day check

`town-day-v1` is retained with the earlier short jobs and its failed pilot traces. It reached morning activities, independent model contexts, memory publication and revised plans. Database failures and early context limits prevented a complete day. It is not reported as a successful autonomous day.

`town-day-v2` changes declared mechanics data for a longer day: harvesting a food basket takes two hours, repairing one section takes three hours, preparing two meal portions takes 45 minutes, eating takes 20 minutes, and the square advertises a 90-minute rest capability. These affordances do not choose anyone's actions. Citizens still decide whether to use them, how many units to request, whom to talk to, and when to sleep.

The WebSocket experiment also supplied Neon's supported `ws` constructor explicitly, rather than relying on the host's global WebSocket implementation. A 160-query parallel-read/transaction check with idle periods completed with no errors. This short check does not substitute for the complete-day gate.

Video was also exported from paused autonomous run `e9ddfbc8-4a56-46c8-ac2b-a11e254a2dff`, not just a manual walk fixture. The source already contained real OpenAI actor and memory calls. Their counts stayed unchanged, the sampled world hashes matched, and the 60-frame MP4 passed ffprobe and R2 readback. No new inference occurred during replay/export.

## Decision and recovery changes from the day checks

A citizen chooses a place such as the kitchen. The navigation helper finds a reachable tile within that place's interaction distance and the engine walks there tile by tile. It does not choose what to do after arrival. Beds still require their exact tile. This avoids repeated attempts to stand on a person who is already at the selected object. Exact x/y movement still means that exact visible tile.

The initial context includes the citizen's latest rejected tool request and exact result from a completed earlier turn. This feedback is scoped to the citizen and selected event boundary. It is historical feedback, not a claim that old remote conditions still hold. Earlier feedback and all accepted outcomes remain in the full SQL trace. A fresh decision can therefore reconsider a failed route or parameter without forgetting the rejection.

Long work and waits can trigger an awake decision at a personal rhythm boundary, an accepted promise deadline or a needs threshold. The default attention thresholds are energy 100 and hunger 700, with another notification at the 0/1000 extremes. These thresholds request a decision; they do not choose a destination, cancel work or force sleep. A sleeping citizen keeps its chosen timer until completion or a real nearby alert. Periodic plan reviews apply during movement and idle time; an already chosen long activity otherwise progresses to completion or a relevant interruption.

A fault-injection test reproduced a second connection problem in the Neon Drizzle adapter: a lost `BEGIN` acknowledgement could leave a leased client unreleased. The database package now owns that lease outside the adapter's transaction and destroys a client on transaction failure. It sets the transaction's statement timeout to seven seconds and its idle-in-transaction timeout to ten seconds. The same injected fault now releases the client, and a fresh query succeeds. This is separate from the Neon 1.2.0 queue regression described above.

Recording retries keep the stable SQL interval ID and start a new BullMQ delivery generation. Old failed deliveries cannot block the explicit retry. A published manifest remains immutable, and a repeated publisher reconciles the completed task state instead of leaving a queued task behind.

The combined regression suite passed 42 tests across 23 files, including real Neon, Redis and R2 paths, with 240 assertions. A separate three-way concurrent provider fixture checks private contexts, shared budget accounting, serialized physical commits and idempotent replay of finished tasks. Scripted provider fixtures make no OpenAI requests and do not stand in for the complete autonomous-day check.

Scripted-provider worlds are excluded from ordinary automatic startup recovery, matching the cognition worker's fixture boundary. Test harnesses can opt in explicitly. OpenAI towns and user-created operator sandboxes retain normal automatic recovery.

## Current database connection

The API, workers and verification scripts now use `pg` 8.23.1 and `drizzle-orm/node-postgres` over the normal PostgreSQL TLS connection to the same Neon database. The server enforces `sslmode=verify-full`, enables channel binding and reuses a small connection pool. It does not use the Neon WebSocket driver. The existing `DATABASE_URL` works without being rewritten on disk. No tables or stored data changed for this transport switch.

This follows Neon's guidance for [long-running applications](https://neon.com/blog/using-neons-auto-suspend-with-long-running-applications) and Drizzle's [supported PostgreSQL adapters](https://orm.drizzle.team/docs/get-started-postgresql). The lost-BEGIN lease guard remains necessary because the node-postgres adapter also starts `BEGIN` before its internal cleanup block. Migration execution owns its connection lease separately as well.

Migrations passed on the TLS connection, and the mixed read/transaction soak completed 160 queries with idle periods. All 47 integration tests passed on this final connection path, with 265 assertions across 26 files, including private memory, replay, outbox, archive and concurrency checks. Type checks, lint, default tests and builds also passed. Earlier WebSocket failures remain recorded rather than being counted as a successful full day.
