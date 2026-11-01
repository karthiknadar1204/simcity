# Phases 0 and 1

Phase 0 defines versioned scenario data and experiment contracts. Phase 1 implements general world mechanics, authoritative storage, observation boundaries, walking, and recording/recovery. Operator commands and deterministic fixtures exercise mechanics. Model decisions start in Phase 2.

## Scenario data

`experiments/scenarios/dev/town.json` contains residents, their private seed experiences, places, inventories, capabilities, terrain, two crossings, calendar, metabolism, and seed. It contains no future action list. The held-out scenario changes identifiers and seed to check that the engine does not depend on names.

Each object advertises permitted capabilities. Inputs are reserved when work starts. Completion validates capacity and location before applying outputs. Cancellation and failure refund reserved inputs. Repair, eating, and harvesting use the same capability interpreter. Movement uses terrain and current occupancy. A blocked next tile interrupts the job; a later actor can choose another route. The engine does not choose that response.

The initial world starts paused. One fenced coordinator owns a run. Simulation time freezes during server downtime. PostgreSQL commits world state, ordered events, observations, command receipts, checkpoint/task intent, and outbox records together. Redis/BullMQ delivers archive jobs; PostgreSQL remains authoritative if Redis loses a job.

## Information rules

The operator can inspect the whole town. A citizen receives its own action results, visible local events, and audible delivered speech. Walls occlude vision. Directed speech reaches only named nearby participants. Public speech reaches nearby listeners. Initial knowledge is configured independently for each citizen. Current inventory of a distant object is not granted by knowing its name.

Receipts distinguish acceptance from completion. Work, walking, waiting, and sleep run on simulation time. Redis retries and leases use wall time. Completed effects are deduplicated by run and command ID. Reusing an ID with a different command is rejected.

## Acceptance

- Scenario validation rejects invalid positions, IDs, references, capacities, and command parameters.
- Movement advances one tile at each due boundary and records direction and route progress.
- Transfers conserve resources and reject unavailable or inaccessible inventory.
- Competing work cannot reserve the same stock. Failed completion and cancellation preserve refunds.
- Speech and observations preserve recipient boundaries.
- Sleep restores energy while time advances and ends at its persisted wake time.
- Seeded regeneration continues consistently across replay and restart.
- Checkpoint plus events reconstructs the same canonical state hash.
- Duplicate command delivery, stale owners, and restart do not repeat effects or fabricate offline activity.
- A real Neon run, API restart, Redis/BullMQ delivery, and R2 checkpoint readback are verified with isolated fixture run IDs.

The implementation report will record actual checks and limits. No fixture run counts as autonomous behavior or a memory-model evaluation.
