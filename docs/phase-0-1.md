# Phases 0 and 1

The first two phases build a reproducible world and its recorder. They do not choose a citizen's intentions. The operator and isolated physics fixtures issue commands; OpenAI decision making starts in Phase 2.

## Phase 0: the contract

`experiments/scenarios/dev/town.json` defines three residents, biographies, motivations, private initial experiences, known entities, homes, a garden, storehouse, meeting area, repair target, wall crossings, inventories, capacities, perception radii, calendar, and random seed. The initial world is paused at 07:00. There is no future action list.

The engine loads arbitrary validated scenario data. The held-out scenario uses different identifiers and seed. Names and IDs are absent from production action logic. The literal action kinds and physics rules are intentional mechanics: every agent needs a way to request movement, and the world must define what movement means.

`experiments/protocols/baseline.json` predeclares memory comparisons, primary metrics, useful-effect thresholds, zero-tolerance correctness gates, and spending controls. `experiments/cases/{dev,held-out}/memory.json` includes accepted promises, tentative offers, amendments, cancellations, stale stock, unavailable evidence, and private information. These cases are prepared for later memory evaluation; no memory model has been evaluated yet. They are small initial acceptance packs, not a finished research benchmark.

The API catalog reads only `experiments/scenarios/dev/*.json`. It never loads evaluation questions/answers or held-out cases into a citizen's world/context. Future evaluation ingestion must take only evidence permitted to the named recipient and keep probes/expected answers separate.

Each new run stores its immutable scenario and a manifest: run/parent ID, seed, scenario/profile/map hashes, engine commit, dirty-source flag, dependency lock SHA-256, protocol hash/version, schema/runtime/tool versions, clock policy, queue/retry/ownership settings, model roles, memory variant, context and spending limits. Phase 1 records zero model concurrency/calls, no prompt, and `operator-fixture` actor mode. Direct storage test fixtures can have null Git/protocol provenance; HTTP-created runs record it. Older development manifests remain readable with their original fields.

`packages/contracts/src/runtime.ts` is the shared infrastructure policy: 500 ms clock scheduling, 15-second ownership leases, five-second recovery discovery, two-second outbox reconciliation, and five archive attempts with exponential backoff. Physics and simulated durations live in each scenario instead.

## A command from click to durable action

1. React sends a typed command with a fresh ID to Hono. The browser never changes world state itself.
2. The coordinator serializes commands for that run and acquires/renews a fenced ownership generation using PostgreSQL's clock.
3. Storage locks the run row. It checks ownership, prior command receipts, and the current state hash.
4. The pure engine validates the request and computes the next state, ordered events, personal observations, and an accepted/rejected receipt.
5. One PostgreSQL transaction writes the resulting state, events, observations, receipt, and any checkpoint/archive-task/outbox intent. A rollback reports no successful effect.
6. The API replies after commit. SSE sends committed snapshots to the viewer. It sends heartbeat events while the world is unchanged; reconnect starts with a full current snapshot.
7. Expensive archive delivery happens afterward. No network/model request runs inside a world transaction.

For example, a walk request is accepted and gets a persisted route. Later clock advances commit each due tile step, direction, and route cursor. Observers receive the steps they can perceive. A newly occupied/blocked next tile interrupts the job. The engine reports that result; it does not script a replacement destination. A later operator or, in Phase 2, the citizen can ask for another route.

The receipt's `accepted` status means the request started successfully. The job can later complete, fail, or be interrupted. Retrying the same run/command ID returns the original receipt without repeating an effect. Reusing that ID with different parameters returns a conflict. The permanent receipt ledger is in PostgreSQL rather than every world snapshot.

## Mechanics

| Citizen action | Real effect / constraint                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| `move`         | Four-direction deterministic pathfinding; timed tile steps; occupancy and terrain rechecked at each step. |
| `inspect`      | Adjacent permitted entity details become a private observation; no distant/private stock disclosure.      |
| `interact`     | Executes an advertised object capability using its duration, inputs, outputs, needs deltas, and progress. |
| `transfer`     | Moves owned stock to an adjacent citizen, subject to quantity and receiving capacity.                     |
| `say`          | Delivers text publicly in hearing range, or privately to explicitly named nearby awake listeners.         |
| `wait`         | Persists a bounded timed wait.                                                                            |
| `sleep`        | Uses an accessible bed at its tile; persists wake time and restores energy on simulated metabolism ticks. |
| `cancel`       | Interrupts the current activity and refunds reserved work inputs.                                         |

Capabilities are scenario data. Harvesting, eating, depositing/withdrawing stock, and repair use one interpreter rather than separate citizen stories. Work reserves finite actor/object inputs at acceptance. It checks location/access/capacity again at completion. Cancellation and failed completion refund inputs; competing requests cannot reserve the same stock. The receiving inventory check includes reserved capacity.

Sleep recovery and hunger/energy progression use integer simulation time. No dreaming, model distillation, or memory consolidation runs yet. Those are later memory/conversation phases. Seeded regeneration uses serialized PRNG state, so replay and restart do not roll new outcomes.

Operator commands are `advance`, `set-status`, `set-speed`, and `set-blocked`. They are not citizen tools. Pause stops automatic ticks; manual Step still advances time. Speed is 0.25–16×, with a 500 ms scheduling interval. Under slow database I/O, simulation time can advance slower than nominal speed; the coordinator does not invent missed wall-time ticks.

## Information boundaries

Global events contain authoritative state patches and are for the recorder/operator. Personal observations contain only delivered evidence: citizen ID, source event sequence, simulated time, kind, content, and referenced entities. They are stored separately.

A citizen receives its own action results, visible local events, and audible speech. Walls occlude sight. Ordinary public events do not become a sleeping person's observations. Directed speech validates distance/listeners and reaches only named participants. Initial private biography/experiences are not exposed to other citizens. Knowing a place exists does not grant its live inventory.

The personal view exposes self state, visible peers' public location/facing, and visible objects. Detailed stock/capabilities require permitted nearby access. Future actor context must use this scoped view and delivered evidence, never the operator's full snapshot. Observations can be read with an `as of` event boundary; replay never substitutes later observations for earlier knowledge.

## Storage and recovery

| PostgreSQL table                      | What it preserves                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `sim_runs`                            | Scenario, manifest, current authoritative state/hash, time/sequence/status, ownership lease/generation. |
| `sim_events`                          | Ordered state transition patches and their causes.                                                      |
| `sim_observations`                    | Recipient-specific delivered evidence indexed by run/citizen/event.                                     |
| `sim_commands`                        | Requests and permanent idempotent receipts.                                                             |
| `sim_checkpoints`                     | State at a sequence/time with a canonical SHA-256 hash.                                                 |
| `sim_background_tasks` / `sim_outbox` | Durable archive intent, attempts/status, and delivery marker.                                           |
| `sim_artifacts`                       | Verified R2 object reference, sequence, byte size, and checksum.                                        |

World snapshots include active jobs, routes/cursors, resource reservations, needs, simulation time, and PRNG state. Starting checkpoints, periodic checkpoints (five simulated minutes or 1,000 events in the development scenario), explicit pause, and clean stop boundaries are recorded. Historical event patches reconstruct intermediate boundaries.

Clean shutdown waits for in-flight commands/ticks, saves a checkpoint, and releases ownership. Run status is preserved. A replacement process discovers eligible running worlds and verifies checkpoint-plus-events reconstruction against the stored current-state hash before resuming. Paused runs remain paused and can be opened/controlled again.

After SIGKILL there may be no final checkpoint, but the last committed PostgreSQL snapshot and event interval survive. The replacement cannot write until the old 15-second lease expires. Recovery discovery runs every five seconds and batches eligible worlds; it does not depend on the viewer's 100-item recent-run list. Stale generations cannot commit. Uncommitted work is rolled back. Offline elapsed wall time is never added to the simulation clock.

Redis uses AOF/noeviction locally. PostgreSQL is the recovery source if Redis loses a delivery. The dispatcher reconciles durable pending/queued tasks, recreates missing Redis jobs with stable IDs, and tracks exhausted retries. Only the archive consumer is implemented; cognition/extraction/embedding/consolidation/media/evaluation queue names reserve later responsibilities.

The archive worker reads a checkpoint, validates its state hash, writes an immutable run/sequence/hash R2 object, reads it back, and checks its SHA-256 before publishing the artifact record. Retries use the same key/task ID. PostgreSQL checkpoints/events are retained. Current replay reads PostgreSQL; automatic reconstruction from R2 alone and event-chunk offloading are later work.

## Viewer and HTTP surface

The minimal pixel viewer supports citizen selection, click-to-walk, directional stride animation, pause/play/speed/manual steps, tile blocking, capability/speech/operator requests, personal observations, and read-only event-boundary history. Live movement interpolates already committed route steps. It never advances physics or predicts uncommitted actions. Replay snaps to the selected authoritative boundary; continuous arbitrary-time playback and video export belong to Phase 5.

| Endpoint under `/api/world`                                          | Purpose                                                          |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `GET /scenarios`                                                     | Development catalog, without private profiles or held-out cases. |
| `GET /runs`, `POST /runs`                                            | List recent runs / create from a catalog scenario ID.            |
| `GET /runs/:id`                                                      | Operator snapshot, hash, and manifest.                           |
| `POST /runs/:id/commands`                                            | Submit a validated command.                                      |
| `GET /runs/:id/stream`                                               | Reconnecting SSE snapshots and heartbeats.                       |
| `GET /runs/:id/events?after=0&limit=100`                             | Bounded ordered event page.                                      |
| `GET /runs/:id/replay?sequence=0`                                    | Checkpoint/event reconstruction with a hash; read only.          |
| `GET /runs/:id/citizens/:citizenId/view`                             | Current scoped citizen view.                                     |
| `GET /runs/:id/citizens/:citizenId/observations?before=100&limit=50` | Scoped evidence up to the specified event.                       |

The API is an operator API, not a public multi-user service. Loopback is the default; non-loopback binding requires an operator bearer token. Write requests validate browser origins and request sizes. Cross-origin browser deployments need the configured reverse proxy/authentication path.

## What is deliberately later

Phase 2 adds autonomous intentions, plans, dynamic reactions, and OpenAI tool calls against this engine. Phase 3 adds episodes, extraction, commitments, pgvector retrieval, source links, and bounded context. Phase 4 adds independent conversations and sleep consolidation. Phase 5 adds the full inspector, continuous playback, recording artifacts, and video export. Subsequent phases add research evals and scale work.

Phase 1 does not establish many-world throughput. State/job history and event queries need the later retention/partition/index tuning before long large-population experiments. Its acceptance evidence concerns this small deterministic world and actual service recovery.
