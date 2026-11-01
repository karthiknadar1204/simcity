# Phase 3: memory and bounded context

New AI towns store personal experiences, extract evidence-backed interpretations, track accepted agreements, retrieve with PostgreSQL and pgvector, and compile a bounded context for each decision. Sleep starts simple consolidation over a fixed historical cutoff. The engine still decides whether an attempted physical action actually succeeds.

This is the first working memory baseline in the roadmap. It uses our own Bun/TypeScript modules. No Neo4j, Mem0 service or OpenViking service is required. Predictive Nemori experiments remain later work.

## A simple example

Mira says, "I will bring six food by 18:00." Iris replies, "Agreed."

1. The engine records both messages and their actual listeners immediately. Mira can read her received sources before any model finishes.
2. The messages share a bounded conversation episode. A SQL transaction also writes a background extraction task and outbox entry.
3. The memory worker asks OpenAI to identify a summary and any agreement. The model must cite exact message spans.
4. Code checks that the sources belong to Mira, precede the task's cutoff, identify the actual parties, support six food, and contain a later explicit acceptance. Code converts the quoted clock time into simulation milliseconds.
5. PostgreSQL stores an accepted commitment version. The original messages remain intact.
6. Later, Iris asks to change the deadline to 19:00. That request becomes a proposal. The accepted deadline remains 18:00.
7. Mira's later "Yes, agreed" can establish version 2 with a 19:00 deadline. A query at the earlier publication still returns 18:00.
8. At a decision, the compiler fetches the current commitment directly. It also searches relevant experiences and opens supporting evidence. Mira receives the exact terms alongside her current plan and visible surroundings.
9. An accepted engine transfer of exactly six food between the matching parties can mark the commitment fulfilled. Speech about a transfer cannot do that.

These are example experiences in tests. Production code does not prescribe Mira's promise, destination, work, dialogue or sleep time.

## Where the code lives

| Folder or file                               | Responsibility                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/memory.ts`           | Versioned policy, evidence and model-output schemas.                                                    |
| `packages/memory/src`                        | Pure grouping, quote checks, calendar/reference normalization, commitment rules and evidence diversity. |
| `packages/storage/src/memory-ingest.ts`      | Immediate raw episodes and SQL outbox writes during a world transaction.                                |
| `packages/storage/src/memory-store.ts`       | Scoped reads, original-source expansion, search, commitments and context audits.                        |
| `packages/storage/src/memory-work-store.ts`  | Leases, model reservations, saved responses, delivery status and explicit retries.                      |
| `packages/storage/src/memory-publication.ts` | Atomic publication of validated interpretations and indexes.                                            |
| `packages/storage/src/memory-commitments.ts` | Receipt-backed fulfillment and reconciliation after delayed extraction.                                 |
| `packages/agent-runtime/src/memory`          | OpenAI adapter, worker, query embeddings, context compiler and deterministic round compaction.          |
| `apps/api/src/app.ts`                        | Hosts actor and memory workers alongside the Hono API and coordinator.                                  |
| `apps/web/src/world/MemoryPanel.tsx`         | Personal memory, source, commitment, processing and retrieval inspector.                                |
| `experiments/protocols/phase-3.json`         | Development acceptance protocol.                                                                        |

The pure engine imports none of the database or model code.

## What PostgreSQL stores

Migration `0003` adds twelve tables to the existing world records. It was generated with Drizzle and applied to Neon after review.

| Table                         | What it keeps                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `sim_memories`                | Immutable episode or interpretation versions, exact source IDs, certainty, event times, source cutoff and publication sequence. |
| `sim_memory_streams`          | Ingestion and consolidation cursors per run and citizen.                                                                        |
| `sim_memory_sessions`         | Current conversation/activity grouping session.                                                                                 |
| `sim_memory_members`          | One primary raw episode for each personal source.                                                                               |
| `sim_memory_entities`         | Indexed person, object and code-assigned commitment/project keys.                                                               |
| `sim_memory_edges`            | Bounded continuation, support, summary and supersession links.                                                                  |
| `sim_memory_indexes`          | Embedding, model, dimensions, text hash, status and availability sequence.                                                      |
| `sim_commitment_versions`     | Accepted, cancelled and fulfilled agreement versions with exact parties, terms and evidence.                                    |
| `sim_memory_tasks`            | Durable extraction, embedding and consolidation work with owner/generation leases.                                              |
| `sim_memory_calls`            | Exact model requests, saved responses, usage, estimated costs and uncertain delivery.                                           |
| `sim_memory_query_embeddings` | Query embeddings cached by run, citizen, text hash, model and dimensions.                                                       |
| `sim_context_compilations`    | Retrieval candidates, selected memories/source pointers, omissions, token estimates and fallback reasons.                       |

Original observations, commands and receipts remain in their existing tables. Redis delivers work; it does not own the memories. R2 keeps the existing checkpoint archives. This phase keeps original evidence and searchable memory text in PostgreSQL. It does not move or delete original sources after summarization.

Every memory read is scoped to a run, a citizen and an event boundary. A memory has two different times: when its experience happened, and when its interpretation became available. A summary published at event 50 about event 10 cannot appear in a query at event 20.

Publication adds a recorded knowledge event under the SQL run lock. It does not advance the clock, move a citizen or alter random state. This gives new knowledge an explicit sequence and preserves exact checkpoint/event replay.

## Grouping and interpretation

Raw conversation grouping uses the actual participant set, a five-minute simulated gap, at most 24 sources and a 12,000-character window. Activity grouping uses the actual job ID. A full buffer starts a new episode with a continuation link. Movement frames stay in world recording without generating an embedding for every tile.

The model summarizes a bounded segment and can propose beliefs, relationships, reflections or routines. Each proposal needs original-source quotes. Interpretations remain qualified. Repeated summaries of one event do not count as several independent experiences during retrieval selection.

Continuing conversations include `newSourceIds` in the extraction request. The worker derives these from the last published summary's cutoff. The model sees newer messages alongside older evidence and existing agreements, so an old promise does not occupy all its attention when a new amendment arrives.

A routine needs parameter names, steps, preconditions and limitations. Code also requires evidence from at least two distinct successful personal job IDs. A routine remains a suggestion. The actor and engine must check whether its prerequisites hold now.

Grouping currently starts with these mechanical boundaries. The extractor can organize several topics in its summary and claims; a separate semantic topic-splitting model is not implemented. Relationships have qualified evidence and version history, rather than a comprehensive social ontology.

## Agreement validation

The model proposes meaning. Code checks evidence and normalizes mechanical fields.

- Quotes must exist in sources actually supplied to this extraction, within the citizen and cutoff.
- The debtor and creditor must be actual participating parties. A later acceptance must come from the other party.
- Tentative, negated, conditional and unaccepted terms cannot become accepted obligations.
- Supported quantities and resource IDs must match the evidence or inherited terms.
- A known commitment ID resolves its canonical original proposal. The model cannot select another citizen's agreement.
- An unambiguous quoted clock time supplies the deadline through code. The raw model deadline and normalized value remain auditable.
- A pending amendment does not overwrite accepted terms. An accepted amendment supersedes the previous version at publication time.
- Cancellation requires explicit cancellation evidence and acceptance. A closed commitment cannot silently reopen through an amendment.

The initial parser is conservative and English-oriented. It supports explicit clock times, a specified day or tomorrow with a supported clock, and a limited set of acceptance and uncertainty forms. Unsupported or ambiguous expressions can fail validation. Exact quotes do not constitute a universal proof that every semantic interpretation is correct; originals and rejected-candidate diagnostics remain available.

Receipt-based fulfillment matches the exact parties, resource and quantity. A transfer that could match several obligations remains unallocated. Partial deliveries and arbitrary contracts need a richer allocation model later.

## Retrieval for one decision

The compiler freezes a turn's world boundary. Recovery reconstructs that same historical state if a process resumes before the context was saved. Memory search uses that boundary. Physical observation tools can deliberately return fresh permitted state with their own sequence. An exact personal source returned by the turn's own tool result can then be reopened and cited; saved outcomes restore that permission after recovery. This does not grant access to other unseen future sources.

The compiler fetches identity, current plan, visible surroundings, compact job progress, recent action results and current obligations. Obligations use a direct SQL query, so a deadline does not have to win a similarity search.

For optional recollections it combines PostgreSQL full-text search, recent memories, pgvector cosine neighbors, indexed entity/commitment keys and a bounded link expansion. Reciprocal-rank fusion combines the ranked lists. Evidence diversity removes redundant copies before selection. Queries and source reads never inspect another citizen's private profile or future evidence.

Vectors use `text-embedding-3-small` with 512 dimensions. The index contract includes the model, dimensions and text hash. A historical query also checks when the vector became available. Only compatible rows participate. Pending indexes leave raw text searchable. The result reports text fallback when there is no usable query embedding or compatible index. It reports hybrid retrieval only when semantic rows actually participated.

Current physical state and current commitment versions take precedence over historical descriptions. For example, "I saw 20 food at dawn" remains useful history; it does not reveal how much food is currently at a distant garden.

## Context and compaction

The actor input policy is 8,000 estimated tokens including instructions and the tool catalogue. Counting uses `js-tiktoken`, plus transport headroom. Actual provider usage is recorded separately.

| Item                       | Bound or behavior                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Retrieval candidates       | At most 40.                                                                                                             |
| Selected optional memories | At most 8 and about 2,200 estimated tokens.                                                                             |
| Link/entity expansion      | At most 12 per bounded query.                                                                                           |
| Current obligations        | At most 12 pinned, with counts and pagination. More than 12 already-due obligations causes explicit essential overflow. |
| Recent action attempts     | Last 6, with exact arguments, receipt and compact job result.                                                           |
| Pending extraction         | Up to 4 episode references and 8 newest source excerpts; a limited-window flag exposes clipping.                        |
| Original evidence          | Bounded excerpts with IDs and truncation flags; `memory_read` opens permitted sources.                                  |
| Model/tool rounds          | At most 6; at most 2 explicit memory searches.                                                                          |

The initial context drops optional retrieved copies, evidence excerpts, recent recollections and seed copies as needed. Current identity/state, plan, pinned obligations, recent action failures and pending excerpts remain essential. If those essentials exceed the budget, the runtime reports a limit instead of silently losing a due obligation.

During a turn, exact function calls and tool results remain in history. Deterministic compaction removes optional copies from the initial context to make room. It does not generate a new summary of a failed transfer or erase its quantity. If essentials and exact tool history still do not fit, the decision fails explicitly and the run pauses for a narrower retry.

SQL retains the initial compilation and each exact round request. The compilation audit records all retrieval candidates separately from selected IDs, retained source pointers, omissions, token estimates and pending/fallback status. A source pointer does not mean the entire original message was sent; the compiled context records actual excerpts, and round requests show later compaction.

## Tools available to the actor

| Tool                               | Purpose                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `world_observe`                    | Fresh permitted surroundings, needs and inventory.                                  |
| `world_find_places`                | Page through places the citizen already knows; no remote stock lookup.              |
| `world_inspect`                    | Engine-validated inspection of a visible target.                                    |
| `world_capabilities`               | Nearby advertised capability IDs, occupancy and the dedicated bed/sleep affordance. |
| `world_move`                       | Start a validated walking job to a known place or locally visible tile.             |
| `world_interact`                   | Request an advertised resource/work capability.                                     |
| `inventory_transfer`               | Transfer owned resources to an adjacent recipient.                                  |
| `social_say`                       | Speak to actual nearby awake listeners.                                             |
| `time_wait`, `time_sleep`          | Start simulation-time jobs and yield.                                               |
| `actions_status`, `actions_cancel` | Inspect real activity progress or cancel it.                                        |
| `memory_search`                    | Bounded personal hybrid retrieval with explicit fallback.                           |
| `memory_read`                      | Read an accessible original source or memory/commitment version.                    |
| `commitments_list`                 | Page through current personal commitment states.                                    |
| `plans_update`                     | Save revisable intentions with accessible evidence IDs.                             |

The model chooses actions. The engine calculates routes, moves tile by tile and validates effects. Memory code cannot award resources or perform an action on the citizen's behalf.

## Sleep and recovery

A successful sleep start queues consolidation at a fixed source cutoff. The worker waits for pending extraction up to that cutoff, then processes bounded raw episode batches. It can publish qualified lessons and relationships. It cannot invent consent, create agreements, observe future events or execute dream actions. Original sources remain available. Long sleep histories continue through durable child tasks and a consolidation cursor.

This implements simple sleep consolidation. It is the baseline needed before testing predictive Nemori-style prediction, surprise and distillation. It does not claim a full reproduction of that research algorithm.

SQL task IDs, request records and responses survive Redis loss and process replacement. Leases carry an owner and generation. Publication checks them again under the run lock. The worker saves a model response before applying it; a replacement can reuse that response. An uncertain in-flight request is charged conservatively and requires an explicit new retry instead of automatic duplicate inference. Known rejections settle with zero inference cost. Delivery recovery has a bounded attempt count.

The actor queue has global concurrency 1 and the memory queue has global concurrency 1. Query embeddings run inside the actor worker, keeping the normal maximum at two concurrent model operations. Both roles share the run's request and estimated-spend limits. Background memory work may finish while the simulation clock is paused.

## Running and inspecting it

Create a new AI town after migrating through `0003`. Old runs keep their recorded `observations-only` variant. They are not silently backfilled or charged for extraction.

Use a fresh run for comparisons after a code upgrade. A run manifest records its creation configuration; continuing an old run uses the running binary for future requests. Exact saved requests document those calls, but such a continued run is not a fixed-revision experiment.

Open **Memory & context inspector** in the selected citizen panel. It shows episodes, qualifications, commitment versions, original evidence links, index state, work failures and retrieval audits. Replay requests pass an explicit event boundary and hide current job status. Inspector searches make no model requests.

Hono provides scoped memory list/search, source-read and explicit failed-job retry routes under `/api/world/runs/:id/citizens/:citizenId`. These share the existing operator authentication and origin policy.

Use `bun run verify:memory` for a capped paid OpenAI development probe and `bun run verify:memory-restart` for a zero-OpenAI process-kill fixture. See [verification evidence](./phase-3-verification.md) for what passed and the remaining behavioral limits.

API details were checked against the primary [OpenAI structured-output guide](https://developers.openai.com/api/docs/guides/structured-outputs), [embedding guide](https://developers.openai.com/api/docs/guides/embeddings), [Drizzle vector retrieval guide](https://orm.drizzle.team/docs/guides/vector-similarity-search) and [PostgreSQL full-text guide](https://orm.drizzle.team/docs/guides/postgresql-full-text-search).
