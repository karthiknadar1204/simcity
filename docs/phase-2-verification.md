# Phase 2 verification — 1 November 2026

The one-citizen runtime, tools, durable task storage, and viewer are implemented. Offline checks and infrastructure fixtures pass. **The live autonomy gate remains pending: OpenAI inference returned HTTP 429, “You have no credits remaining.”** Authenticating and listing models succeeded, but no successful live model-generated citizen choice has been observed in this verification session.

## Completed checks

| Check                             | Result                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `bun run check-types`             | 10 workspace tasks passed.                                                                            |
| `bun run lint`                    | 10 workspace tasks passed.                                                                            |
| `bun run test`                    | 26 tests passed; five cloud integration tests intentionally skipped; no failures.                     |
| `bun run build`                   | Web, API, and worker passed. Existing Phaser chunk-size warning remains.                              |
| `bun run db:check`                | Real Neon connection verified through Drizzle.                                                        |
| Migration `0002`                  | Generated, reviewed, and applied to the configured Neon database.                                     |
| `bun run test:integration`        | Five real infrastructure tests passed, with 35 assertions.                                            |
| `bun run verify:thinking-restart` | Separate-process pending-task recovery and duplicate-consumption checks passed; zero OpenAI requests. |
| `bun run verify:restart`          | World/sleep/crash/offline-time/replay checks passed; zero OpenAI requests.                            |

Offline tests cover private versioned plans, replay preservation, meaningful thinking triggers rather than every clock/walking event, scoped context, tool actor binding, blocked-surface visibility, unseen tile rejection, strict schemas, and the Responses SDK adapter's completed/incomplete/quota handling. Provider wire responses in adapter tests are explicit mocks.

## Real database, queue, and archive fixtures

These use real infrastructure and labeled development data. Their model responses, where needed, are deliberately scripted fixtures.

| Fixture                  | Run ID                                 | Evidence                                                                                                                                                                                                                              |
| ------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable thinking         | `475b8bdf-d3c3-4e48-a709-ef414acb1df5` | Single owner, one reservation per task/round, bounded request budget, new evidence supersedes stale effects, foreign evidence unavailable, overlapping citizen turns denied, and operator sleep invalidates an awake decision.        |
| World store              | `06e2e370-f032-48c5-b1fb-4d45867e7277` | Transfer idempotency, scoped historical evidence, world ownership fencing, recovery, and manifest round trip.                                                                                                                         |
| R2 archive               | `8bc6add7-b931-4a3e-b4b7-4483dd6fd564` | Removed the fixture's own Redis delivery, republished its SQL task, uploaded a checkpoint, and verified R2 content by read-back.                                                                                                      |
| Runtime/provider fixture | `de0dfe8c-9338-4169-b01b-3f33ad21c4e8` | Real rejected tool receipt followed by a valid wait; new runner resumes a saved response without another provider request; repeated task causes no duplicate effect; known quota rejection releases reservation and pauses the world. |

The fifth integration test terminates only its own leased PostgreSQL backend session. Its current work fails, the pool accepts a fresh query, and no application data is modified. The generic disconnect diagnostic is expected in this test.

## Separate-process recovery

`verify:thinking-restart` created run `fd196ba1-f5e4-4947-8ad3-403994ea0af9` with task `346b2cfc-02ff-4868-a001-2d750f8ea93f`. It killed a separate process that had observed the pending task, verified that SQL retained the same task ID, and consumed it from a new process using one scripted provider response. A second consumer made zero provider requests and preserved the state hash. This proves pending-task delivery continuity; it does not simulate a live provider's response surviving an in-flight network crash. Saved-response recovery is checked separately by the runtime integration fixture.

Its final recorded sequence was 8, hash `e3180f90868ebc9745e3234eb820f766e381c2b648afd949e2981d1897a4646b`. Machine-readable evidence is in ignored `.local/thinking-restart-proof.json`.

`verify:restart` passed for run `c4c503c9-a39f-425b-8787-fe937c5cb75e`: final sequence 93, hash `caa87088a91a35f5de33f00562dfa335fec1b03cdf1de49c5f08b714e1fd37a0`. It checked tile steps, route interruption, transfer retry, preserved sleep, checkpoint/event recovery after SIGKILL, running-world resumption, offline-time exclusion, and replay equality. The test waits for the crashed process's lease to expire. Evidence is in ignored `.local/restart-proof.json`.

One earlier attempt of the broader restart script timed out on a database request. After adding request-path diagnostics, the rerun completed successfully without bypassing assertions. The passing rerun is evidence of recovery behavior, not proof that infrastructure cannot time out.

## Browser and actual OpenAI attempt

The React/Phaser viewer was exercised through the browser: AI-town creation, selected citizen, Play, live state, decision/error tracing, and the quota-failure path. After restarting development, the saved failed run loaded with a live connection, paused state, rejected request, retry control, and $0 estimated cost. Seeking event zero disabled world writes and hid current thinking traces; returning live restored the decision panel. The final browser error-log check returned no errors. The genuine request failed at the provider; scripted answers were not inserted into that browser run. The local browser screenshot is saved in ignored `.local/phase-2-view.jpg`.

The latest paid-gate attempt created run `c6384b2b-5af0-4172-a7e3-2277ed313703`. Its first request was recorded as a known rejection, the reservation was released, estimated inference cost remained zero, and the world paused. No plan or model-chosen movement was produced. Earlier failed development attempts predate this rejection-accounting fix and may show conservative unresolved-request estimates; those estimates are not provider billing evidence.

## Remaining acceptance work

After the OpenAI project is funded, run `bun run verify:autonomy` against the normal development API and watch the citizen in the browser. The development protocol requires a self-initiated plan, model-selected destination, real walking/result, response to a route blocker or encounter, and exact replay. Use the trace to assess whether the decisions are grounded in the citizen's legitimate evidence. Invalid-action feedback and saved-response recovery already pass the explicitly scripted runtime checks; do not describe them as live model observations.

If the live gate reveals a behavioral or integration fault, fix it and repeat the affected checks before marking Phase 2 accepted. This report contains no claim of town-wide autonomy, long-term memory quality, research-paper replication, or throughput at scale. Full memory/context compilation and sleep consolidation remain Phase 3.
