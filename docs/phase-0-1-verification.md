# Phases 0 and 1: verification

Verified locally on 2026-11-01 with Bun 1.3.3, real Neon PostgreSQL, local Redis 8.6.0, and the configured Cloudflare R2 bucket. These are operator/physics fixtures. They contain no autonomous citizen behavior or paid inference.

## Results

| Check                      | Observed result                                                                                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run check-types`      | All nine applicable workspace checks passed.                                                                                                                                                         |
| `bun run lint`             | All nine applicable workspace checks passed, with zero warnings.                                                                                                                                     |
| `bun run test`             | 17 tests passed; two cloud integration tests explicitly skipped in this offline command.                                                                                                             |
| `bun run build`            | API, worker, and web bundles built. Phaser's separate bundle produces a size warning.                                                                                                                |
| `bun run db:check`         | Real Neon `SELECT 1` through Drizzle succeeded.                                                                                                                                                      |
| `bun run test:integration` | Both live tests passed: atomic/deduplicated storage and verified archive delivery.                                                                                                                   |
| `bun run verify:restart`   | The real API subprocess fixture passed all eight recovery/mechanics checks below.                                                                                                                    |
| Browser verification       | Created a town, selected citizens without world mutations, clicked a destination, stepped time, observed intermediate tile movement, reloaded the saved world, sought event zero, and returned live. |
| SSE transport              | A paused run delivered an initial world snapshot and a heartbeat without closing the stream.                                                                                                         |
| Source scan                | Production engine/runtime/storage code contains no Mira/Iris/Klaus/garden/storehouse-specific decision branch. Scenario names and action scripts remain data/tests.                                  |

The contract tests include two small evaluation-pack provenance checks. They establish valid recipients, query cutoffs, and permitted source references; they do not measure memory extraction or retrieval quality.

## Actual restart fixture

The final full subprocess run used engine commit `ede7e8ec7c5b3baf684bdcc932b250d37d26ceab` with `sourceDirty: false`, protocol `town-memory-baseline-v1`, and recorded runtime policy `phase1-runtime-v1`.

- Run: `f9b735d6-8585-4ff6-8494-a3cd2d4306ae`.
- Completed: `2026-11-01T08:22:24.902Z`.
- Final event sequence: `93`.
- Final authoritative state/replay SHA-256: `b34b504d1c98ff65ac7ba4fa44c0669628e4d1acdeebda81744912609dfde104`.
- Model calls: `0`.

The script checked committed tile steps; interruption after blocking the next route tile; a food transfer retried under the same ID; an in-progress sleep preserved across graceful restart; wake completion; checkpoint-plus-events recovery after SIGKILL; automatic ticking when a running world resumes; exclusion of offline elapsed wall time; and equality between current state and its recorded replay hash. The script groups sleep/replay checks into its eight reported categories.

After the crash, writes wait for the previous ownership lease to expire. The fixture explicitly waits for that boundary rather than bypassing fencing. Its process logs and machine-readable result are in ignored `.local/restart-*`. Run IDs differ between executions, so compare each run to its own replay rather than comparing independent runs' full hashes.

A subsequent route-level fix preserves Hono's authentication challenge. Its regression check passed: missing bearer token returns 401 with `WWW-Authenticate`, the configured token permits access, and a foreign browser origin cannot write. That response-handling change does not alter world transitions.

## Real storage and archive fixtures

The latest isolated Neon storage run was `ac243fb6-b6d2-44a6-b813-d7fb3f1c567a`. It checked one transfer effect despite retry, an earlier observation cutoff returning no future evidence, rejection of a stale ownership generation, exact state recovery, and manifest round-trip preservation.

The latest isolated archive run was `5905437e-08e6-4c80-871b-99d932e48525`. The test deliberately removed its own Redis delivery, republished the durable PostgreSQL task, consumed it, uploaded its checkpoint to R2, and verified the read-back content/checksum before marking it completed. The test used an isolated queue and cleaned up only that queue; database rows and archive evidence remain inspectable.

The normal worker was also started with the full development stack and processed the application's checkpoint queue. No credential values or signed object URLs are included in this report.

## Limits of this evidence

This passes the Phase 1 mechanics/recovery gate for the small world. It is not a claim about many-world throughput, model autonomy, social believability, memory quality, or research effect sizes.

The viewer currently has a simple procedural pixel map and directional walking, plus event-boundary history. Continuous arbitrary-time playback, polished assets, video export, source-chunk archival, and R2-only recovery are later work. PostgreSQL remains the hot authoritative recorder. Semantic memory, commitments, pgvector indexes, and sleep consolidation have not been implemented in these phases.
