# Phase 2 verification — 1 November 2026

The one-citizen runtime, tools, durable task storage, and viewer are implemented. Offline checks and infrastructure fixtures pass. **The replacement file key works with paid inference. Real model-generated plans, walking requests, and local speech have been observed.** The original bounded live-pilot script has not yet passed end to end; the latest attempt timed out before a post-blocker walk completed. See the live evidence and limits below.

## Completed checks

| Check                             | Result                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `bun run check-types`             | 10 workspace tasks passed.                                                                            |
| `bun run lint`                    | 10 workspace tasks passed.                                                                            |
| `bun run test`                    | 30 tests passed; five cloud integration tests intentionally skipped; no failures.                     |
| `bun run build`                   | Web, API, and worker passed. Existing Phaser chunk-size warning remains.                              |
| `bun run db:check`                | Real Neon connection verified through Drizzle.                                                        |
| Migration `0002`                  | Generated, reviewed, and applied to the configured Neon database.                                     |
| `bun run test:integration`        | Five real infrastructure tests passed, with 39 assertions.                                            |
| `bun run verify:thinking-restart` | Separate-process pending-task recovery and duplicate-consumption checks passed; zero OpenAI requests. |
| `bun run verify:restart`          | World/sleep/crash/offline-time/replay checks passed; zero OpenAI requests.                            |

Offline tests cover private versioned plans, replay preservation, meaningful thinking triggers rather than every clock/walking event, scoped context, tool actor binding, blocked-surface visibility, unseen tile rejection, strict schemas, and the Responses SDK adapter's completed/incomplete/quota handling. New regressions prove that a queued clock tick cannot advance after Pause, idle reviews cannot be deferred by a much later project review, and idle SDK requests require tools while active jobs permit continuation. Provider wire responses in adapter tests are explicit mocks.

## Real database, queue, and archive fixtures

These use real infrastructure and labeled development data. Their model responses, where needed, are deliberately scripted fixtures.

| Fixture                  | Run ID                                 | Evidence                                                                                                                                                                                                                                                                   |
| ------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable thinking         | `b11e7d4f-30a2-435b-a7cb-84664dc68d2e` | Single owner, one reservation per task/round, bounded request budget, new evidence supersedes stale effects, foreign evidence unavailable, overlapping citizen turns denied, and operator sleep invalidates an awake decision.                                             |
| World store              | `26d26852-f04d-44d6-8b16-ec0a709e91a4` | Transfer idempotency, scoped historical evidence, world ownership fencing, recovery, and manifest round trip.                                                                                                                                                              |
| R2 archive               | `a0fbf254-e37d-41aa-bbb3-49531b0e737d` | Removed the fixture's own Redis delivery, republished its SQL task, uploaded a checkpoint, and verified R2 content by read-back.                                                                                                                                           |
| Runtime/provider fixture | `27138215-bacf-4ee8-99c4-a88d84863e24` | Real rejected receipt followed by a valid wait; saved response resumes without another request; repeated task has no duplicate effect; idle turns request tools; a busy resident can continue its existing job; quota rejection releases reservation and pauses the world. |

The fifth integration test terminates only its own leased PostgreSQL backend session. Its current work fails, the pool accepts a fresh query, and no application data is modified. The generic disconnect diagnostic is expected in this test.

## Separate-process recovery

`verify:thinking-restart` created run `fd196ba1-f5e4-4947-8ad3-403994ea0af9` with task `346b2cfc-02ff-4868-a001-2d750f8ea93f`. It killed a separate process that had observed the pending task, verified that SQL retained the same task ID, and consumed it from a new process using one scripted provider response. A second consumer made zero provider requests and preserved the state hash. This proves pending-task delivery continuity; it does not simulate a live provider's response surviving an in-flight network crash. Saved-response recovery is checked separately by the runtime integration fixture.

Its final recorded sequence was 8, hash `e3180f90868ebc9745e3234eb820f766e381c2b648afd949e2981d1897a4646b`. Machine-readable evidence is in ignored `.local/thinking-restart-proof.json`.

`verify:restart` passed after the Pause fix for run `ef07219f-3b02-4cda-97cd-e47ebc812fd6`: final sequence 93, hash `3d14d91d49013a4da8d5df6ea9a8c08714e0b92f92552f998742c3d8757ba086`. It checked tile steps, route interruption, transfer retry, preserved sleep, checkpoint/event recovery after SIGKILL, running-world resumption, offline-time exclusion, and replay equality. The test waits for the crashed process's lease to expire. Evidence is in ignored `.local/restart-proof.json`.

Earlier restart attempts exposed a database request timeout and an overly short fixed one-second progress observation. The script now bounds its wait on actual time progression to ten seconds, and compares offline freeze against measured online startup time. It preserves the same recovery assertions and pauses its own fixture during cleanup. The passing rerun is evidence of recovery behavior, not proof that infrastructure cannot time out.

## Browser and actual OpenAI attempts

The earlier React/Phaser browser pass exercised AI-town creation, selected citizen, Play, live state, decision/error tracing, and the quota-failure path. The saved failed run loaded with a live connection, paused state, rejected request, retry control, and $0 estimated cost. Seeking event zero disabled world writes and hid current thinking traces; returning live restored the decision panel. That pass's final browser error-log check returned no errors. Its genuine request failed at the provider; scripted answers were not inserted. The historical screenshot is in ignored `.local/phase-2-view.jpg`. The subsequent funded browser pass showed real plans, position changes, and decision traces; its screenshot is `.local/phase-2-funded-view.jpg`.

The earlier credit-error run `c6384b2b-5af0-4172-a7e3-2277ed313703` recorded a known rejection, released its reservation, and paused with zero estimated inference cost. Later diagnosis found that an older inherited shell key took precedence over the replacement in `.env`. Direct inference using the file key returned HTTP 200, and restarting development with inherited key overrides removed enabled real citizen calls. The error did not establish the replacement account's balance. Earlier attempts that predate rejection accounting may show conservative unresolved-request estimates; those are not billing evidence.

The first funded run `da8d47c7-9c6f-4dc5-82f7-7cb6fbc7bc42` produced Mira's own plan and a garden-directed walk. Its blocker test exposed a queued tick executing after Pause; a failing regression reproduced the extra 500 simulated milliseconds before the coordinator fix. Run `2cb3cd08-18f2-4951-abf5-5fec9db24e99` exposed an idle turn waiting for its five-minute plan review. A failing deadline test led to the bounded idle-review fix.

Run `5b091f43-3585-49dc-8583-9bebecd59f5c` planned, chose the garden, received a route interruption and a nearby message, and revised its plan. A text-only ending delayed further physical action. The runtime now requires tool selection while idle, with an explicit exception for continuing an active job.

The latest original bounded pilot, `0cf2885a-0f44-4027-adfb-f30907afb984`, used that tool-selection policy. Mira chose the garden, started walking, received a real blocked-route interruption, and spoke to nearby Iris. She also made an invalid capability request and later requested movement that the engine rejected. The post-blocker walk did not complete within the script's two-minute window. The script exited with failure and paused the run; no successful original-pilot result JSON was emitted. Model outputs were not replaced or given a forced destination to obtain a pass.

A separate bounded continuation resumed that same paused run and saved task with `bun run scripts/verify-autonomy-continuation.ts RUN_ID`. It also timed out before another completed walk. The citizen continued making real model/tool calls, including redundant reads and rejected attempts; that is not a passing action-completion result. Across the original attempt and continuation, this run recorded 23 model requests and $0.038668 estimated inference cost, with zero outstanding reservation. It ended paused at event 559, hash `9c13f0d596e8d656aacd9f3c1f984e685233188be410bb99aaa3667b52c49e32`. A failure summary is in ignored `.local/phase-2-live-failure.json`; full contexts, responses, receipts, and events remain in PostgreSQL. These costs describe this one run, not the entire account or all development attempts.

## Remaining acceptance work

The original bounded live gate remains open. Continue testing `bun run verify:autonomy` against the normal development API and inspect why the model spends rounds on redundant reads or invalid capabilities. Preserve freedom to choose actions; do not insert a successful action list to satisfy the gate. The protocol requires a self-initiated plan, model-selected destination, real walking/result, response to a route blocker or encounter, and exact replay. Use the trace to assess whether choices are grounded in legitimate evidence. Saved-response recovery passes its explicitly scripted runtime check and must retain that label.

If the live gate reveals a behavioral or integration fault, fix it and repeat the affected checks before marking Phase 2 accepted. This report contains no claim of town-wide autonomy, long-term memory quality, research-paper replication, or throughput at scale. Full memory/context compilation and sleep consolidation remain Phase 3.
