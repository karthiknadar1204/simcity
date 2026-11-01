# Phase 2 — One citizen connected to OpenAI

Phase 2 connects one resident per run to a model. The resident can form and revise intentions, inspect permitted surroundings, retrieve personal evidence, and request real actions. The model does not directly move a sprite, update an inventory, or advance the clock. Those effects come from the existing deterministic engine.

The intended product is an autonomous town in the spirit of [Generative Agents](https://arxiv.org/abs/2304.03442): residents independently observe, remember, plan, act, meet, talk, and influence later behavior. Phase 2's single resident is the first development gate toward that town. General world rules and a finite set of executable mechanics are necessary; specific residents' future choices and social outcomes must not be scripted.

The implementation is present and live OpenAI inference has been verified with the configured file key. The [verification report](./phase-2-verification.md) distinguishes passing mechanics tests from actual live autonomy evidence. Nothing in a scripted provider fixture counts as autonomous behavior.

## 1. Where the pieces live

| Component                   | Job                                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| React + Phaser (`apps/web`) | Draw authoritative state, select runs, show plans/context/tool receipts, and replay historical event boundaries.                   |
| Bun + Hono (`apps/api`)     | Serve HTTP/SSE, own world clocks, validate operator access, and host cognition.                                                    |
| `packages/engine`           | Pure rules: perception, pathfinding, tile steps, inventory, interactions, sleep, events, and replay.                               |
| `packages/agent-runtime`    | Build bounded context, call OpenAI, validate tools, and resume durable thinking turns.                                             |
| Drizzle + Neon PostgreSQL   | Store authoritative world state, exact events, personal observations, plans, pending tasks, model requests/responses, and budgets. |
| Redis + BullMQ              | Deliver thinking and archive work. Missing deliveries can be rebuilt from SQL.                                                     |
| `apps/worker` + R2          | Archive checkpoints and verify uploaded bytes by reading them back.                                                                |

The cognition consumer currently lives inside the API process so actions use that process's world coordinator. The separate worker handles archives. SQL ownership and generation checks protect writes if processes restart or compete. BullMQ has a global thinking concurrency of two on the shared queue; SQL also permits only one live thinking lease per citizen.

## 2. The citizen's complete loop

1. **Create:** the API loads versioned scenario data and creates a paused world. The chosen citizen gets an active controller, a budget, and a durable `self-initiated` task. No human goal or action list is added.
2. **Play:** integer simulation time advances. After the one-second simulated debounce, the durable task becomes eligible for BullMQ delivery.
3. **Claim:** the runner checks the task, controller version, running world, and ownership lease. It fixes an event boundary and records the frozen context. The same citizen cannot begin a second turn while the first lease remains live.
4. **Observe/retrieve:** context includes that citizen's identity, motivations, needs, inventory, current job, plan, initial memories, and recent delivered evidence. Known places provide legitimate navigation targets. Detailed stock and capabilities require nearby permitted access.
5. **Ask OpenAI:** the runner reserves budget and saves the exact request before calling the Responses API. No database transaction remains open while the model is working.
6. **Save the answer:** output, tool-call identity, usage, and estimated cost are persisted before any requested world action executes.
7. **Validate and execute:** the broker validates strict tool arguments, binds the acting citizen itself, and submits a command through the world coordinator. SQL checks the thinking version again immediately before a side effect.
8. **Read the real result:** the model receives a receipt such as accepted, rejected, or unavailable. A rejected request can be corrected in the next bounded tool round. A written intention never proves an action happened.
9. **Yield during activity:** an accepted walk, interaction, wait, or sleep yields to the engine. The engine advances real tile steps and work on simulation time. There is no model call on every frame.
10. **Think again:** completion, interruption, a permitted message, an encounter, a meaningful observed change, waking, or a scheduled review can enqueue another turn. The current plan and received outcomes carry forward.

During travel, the model may inspect progress, continue its goal, revise its plan, or cancel before replacing a physical activity. The engine continues the walk unless it is cancelled, blocked, or completed. A resident encountering another person does not automatically abandon its goal.

For an idle resident, Responses uses `tool_choice=required`: writing “I will go” cannot end the round in place of requesting a tool. The model remains free to choose reads, planning, movement, work, speech, sleep, or a bounded wait. The six-round limit still applies. A resident with a running job can finish with a continuation decision; cancelling that job switches subsequent rounds back to requiring a tool. The exact choice mode is saved with the model request.

## 3. A simple example — illustrative, not a recorded model result

Suppose Mira knows a café and wants food. These are scenario facts and motives; they do not prescribe her future choices.

Her first context might contain hunger, food in her inventory, the café's known location, and a personal memory that she likes meeting neighbors. The model could call `plans_update` with a tentative breakfast goal, then `world_move` with the café's ID. The engine computes a route and emits each tile step. The renderer follows those recorded positions.

If an operator blocks the next route tile, the engine interrupts the job and writes the actual outcome. Because Mira receives that evidence, a new thinking task can retrieve it and reconsider. She might choose another route, another destination, or wait. Production code does not choose between those options for her.

If Mira requests a capability that does not exist, she gets a rejected receipt. Her food does not increase. A later valid interaction only changes inventory when the engine's requirements and completion rules pass.

If a nearby resident speaks, only eligible listeners receive the message. Mira can respond through `social_say`. The model cannot invent the other resident's agreement or reply. Only one resident is model-controlled in Phase 2; operators supply other residents' actions when testing encounters.

## 4. Memory and context in this phase

Phase 2 deliberately uses the first small slice of the planned memory architecture:

| Stored item                                         | Location and retrieval                                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity, motives, initial memories, known entities | Versioned scenario and current citizen JSON in `sim_runs`. Only the selected citizen's private fields enter its context.                             |
| Personal observations                               | `sim_observations`, keyed by run, citizen, and event sequence. Original engine-delivered content remains available.                                  |
| Current plan                                        | Versioned citizen state; private `plan.updated` events also preserve historical versions for replay.                                                 |
| Exact thinking context                              | `sim_thinking_turns.context`, together with boundary, reasons, ownership, and outcome.                                                               |
| Model request, answer, usage, tool result           | `sim_model_rounds`, keyed by task and round. SQL stores the full request; the browser's recent-turn endpoint omits duplicate full request histories. |

The initial context includes at most 20 recent personal observations. Routine `command.accepted` and `plan.updated` entries are excluded from this recent-evidence query to reduce noise. The compiler estimates tokens for instructions, context, history, and tools. It removes optional older observations, then excess seed memories, until the initial request fits. It does not silently discard the active goal or essential state; if essential context cannot fit, the turn records a limit instead of making an oversized request.

`memory_search` currently performs bounded keyword matching against the citizen's initial memories and personal observations, returning at most eight sources. At most two searches are allowed in one turn. `memory_read` opens an exact permitted source. Both restrict historical evidence to the turn's event boundary. Another citizen's evidence and future evidence are unavailable. Fresh world-read tools return a separately labeled current sequence and still respect perception; world mutations recheck the current task version.

The visible-world view omits other biographies, private plans, distant stock, and object details behind walls. Local coordinate destinations must be visible; known place IDs can remain valid navigation goals at a distance. The engine's navigator uses map mechanics to find routes; that does not grant the model an omniscient map dump.

**Not implemented in Phase 2:** episode extraction, commitment extraction, belief/relationship consolidation, embeddings and pgvector ranking, learned routines, predictive Nemori distillation, and sleep consolidation. The pgvector extension already exists, but Phase 2 does not call this simple keyword retrieval a full semantic memory system. Those remain Phase 3 work from the roadmap.

## 5. The model's tool catalogue

Tool names use underscores in the OpenAI function schema. The actor ID is bound by the server, not chosen by the model.

| Tool                 | What it can do                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `world_observe`      | Read permitted current surroundings plus own position, needs, inventory, and activity.                                    |
| `world_inspect`      | Request inspection of a visible target; engine access rules determine the result.                                         |
| `world_capabilities` | Read advertised interactions on a nearby accessible object.                                                               |
| `world_move`         | Request walking to a known/visible place ID or a visible local tile. The engine calculates and performs the route.        |
| `world_interact`     | Request one object capability with a unit count. Engine validates proximity, access, stock, capacity, and activity state. |
| `inventory_transfer` | Transfer a positive owned quantity to an adjacent resident.                                                               |
| `social_say`         | Speak locally, with optional eligible directed listeners.                                                                 |
| `time_wait`          | Begin an explicit simulated wait.                                                                                         |
| `time_sleep`         | Sleep at an accessible bed on the current tile for a selected simulated duration.                                         |
| `actions_status`     | Read the citizen's own current job and progress.                                                                          |
| `actions_cancel`     | Cancel the current activity; engine reservation/refund rules apply.                                                       |
| `memory_search`      | Search personal seeds and delivered observations at the fixed evidence boundary.                                          |
| `memory_read`        | Open one exact personal source ID.                                                                                        |
| `plans_update`       | Save a tentative day outline, goal, constraints, steps, cursor, blocker, evidence IDs, brief reason, and review interval. |

Plans use optimistic version checks and validate cited source access. A brief reason is a short decision explanation; it is not hidden model chain of thought. The model does not receive tools for changing world status, advancing time, blocking tiles, altering budgets, selecting another actor, issuing arbitrary SQL, or writing arbitrary code.

## 6. Timing, sleep, and reactions

Model calls use wall-clock timeouts. Actions, sleep durations, debounce, and review deadlines use simulation time. Redis delayed jobs are not the authority for in-world deadlines. World time freezes during server downtime and while paused.

An automatic tick rechecks the latest running status after earlier commands finish. A tick queued behind Pause cannot advance the newly paused world. Idle residents receive another review within 30 simulated seconds even when a long-term plan requests a later review; a valid earlier review can run sooner. Active jobs retain their plan deadline, and their real results can trigger cognition immediately. An expired plan deadline falls back to the normal review interval instead of spinning.

Meaningful triggers coalesce before a task fixes its information boundary. New relevant evidence after that boundary supersedes the old task with a new version. A late answer can still be saved for usage/accounting, but its old guard cannot apply a world effect. The replacement waits until the previous live lease is released or expires.

A sleeping resident does not receive ordinary surroundings or scheduled awake reviews. Operator sleep also invalidates an already pending awake decision. Waking produces an action outcome that can resume cognition. This phase preserves and completes sleeping jobs across restart; it does not yet run a dream/consolidation model job.

## 7. Persistence and failure behavior

SQL commits world changes, observations, receipts, and resulting thinking tasks together. Redis delivers work by stable task ID. Reconciliation republishes missing deliveries. The production dispatcher selects only `provider=openai`; fixture providers must be invoked explicitly by test harnesses.

The runner keeps the same task/round identity on retries. A stable command ID derived from task and round makes repeating a recorded tool action return its existing receipt instead of applying another effect. A persisted response can resume without another model call.

There is no claim of exactly-once external inference. A crash after sending a request but before saving its response can leave delivery uncertain. The runtime records that uncertainty, conservatively consumes the reserved estimate, and requires an explicit retry rather than silently generating a second answer. A known provider rejection releases its reservation and records zero estimated inference cost. An incomplete response records reported usage and applies no partial action.

Leased database session errors and query/statement timeouts fail affected work instead of leaving an unhandled client error or indefinite wait. Existing durable state is used for recovery. This is bounded failure handling, not proof against every infrastructure outage.

## 8. Current limits and cost accounting

| Limit                                               | Default                                               |
| --------------------------------------------------- | ----------------------------------------------------- |
| AI residents per run                                | 1                                                     |
| Concurrent thinking jobs on the shared BullMQ queue | 2                                                     |
| Live thinking leases per citizen                    | 1                                                     |
| Model/tool rounds per turn                          | 6                                                     |
| Memory searches per turn                            | 2                                                     |
| Estimated input context budget                      | 8,000 tokens, including tools and accumulated history |
| Output limit                                        | 1,400 tokens                                          |
| Model timeout                                       | 20 seconds; automatic SDK retries disabled            |
| Thinking lease / renewal                            | 30 seconds / every 5 seconds                          |
| Run spending estimate cap                           | $1                                                    |
| Run request-attempt cap                             | 80                                                    |

The tokenizer is an estimate, not the provider's exact token counter. Reservation includes a small input margin and maximum output; reported usage settles the local estimate after a response. Pricing for the supported pinned model is $0.75 per million input tokens, $0.075 cached input, and $4.50 output. Unknown model pricing is rejected when creating a run. Provider billing is authoritative. A budget or context limit produces an explicit state/error, never a fabricated successful action.

## 9. Viewer, recording, and provenance

The panel shows the latest plan, short explanation, thinking outcomes, tool arguments/results, token counts, estimated budget use, and the latest frozen context. Recent tracing is bounded to three turns. Historical replay hides current live thinking and uses the plan stored at the selected event boundary.

Replay uses recorded engine events without asking a model to regenerate choices. Existing checkpoint-to-R2 archival remains active. This phase does not add MP4/video export, polished sprite assets, continuous arbitrary-time playback, or archival of all source chunks; those remain later roadmap work.

New AI runs record model, prompt/tool/runtime versions, scenario hash, source/protocol hashes, seed, context limits, and spending cap in their manifest. The Phase 2 development protocol is separate from the original baseline protocol. Fixture runs are visibly labeled as scripted fixtures in the UI.

## 10. Read the implementation

- `packages/agent-runtime/src/{context,prompt,tools,broker,openai,runner,runtime}.ts`
- `packages/storage/src/{agent-store,thinking-policy,thinking-records,world-store}.ts`
- `packages/db/src/schema.ts` and `packages/db/drizzle/0002_abnormal_turbo.sql`
- `apps/api/src/{app,routes/worlds,world/coordinator}.ts`
- `apps/web/src/world/{CitizenPanel,ThinkingPanel}.tsx` and `apps/web/src/world/useWorld.ts`
- `experiments/protocols/phase-2.json`

Official API references used: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [Neon driver](https://neon.com/docs/serverless/serverless-driver), [node-postgres client options](https://node-postgres.com/apis/client), and [pool error handling](https://node-postgres.com/apis/pool).
