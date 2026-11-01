# Phase 3 verification, 1 November 2026

The memory write/read path, async processing, hybrid retrieval, bounded context and simple sleep consolidation are implemented. Real OpenAI development probes passed the focused memory gate. These results do not establish full-day autonomous behavior or paper-scale memory accuracy.

## Automated checks

| Check                             | Result                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace type checks             | Passed.                                                                                                                              |
| Workspace lint with zero warnings | Passed.                                                                                                                              |
| Default Bun suite                 | 50 passed, 9 credential-dependent integration checks skipped.                                                                        |
| Production build                  | Passed. The existing Phaser chunk-size advisory remains.                                                                             |
| Drizzle database check            | Real Neon connection passed. Migration `0003` was applied.                                                                           |
| Full integration suite            | 9 passed, 0 failed, 90 assertions, about 117 seconds. Real Neon, Redis and R2; scripted provider fixtures make zero OpenAI requests. |

The tests cover exact quote access, actual agreement parties, uncertainty/negation, supported amounts/dates, accepted amendments, receipt fulfillment, historical boundaries, evidence diversity, routines requiring distinct completed jobs, token overflow, optional round compaction, final source coverage and SDK failure/usage handling.

After the full integration run, a final regression checked fulfillment when the AI citizen receives a delivery. That exposed a missing recipient receipt in immediate ingestion. The fix passed the focused publication and actor recovery suites again, 2/2 with 40 assertions. Publication fixture `3416caa4-2ac7-4e53-a249-f37556cd740a` now checks both sender and recipient fulfillment. The regular suite also checks that a fresh personal source returned by a tool can be reopened after restoring saved outcomes, without granting access to unseen future sources.

## Real service fixtures

| Fixture run                            | What it proved                                                                                                                                                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `9ed43b15-0ff6-4ea5-af71-1ee4e0564753` | Raw episodes are immediately searchable before indexing; grouping, versions, source scope, command idempotency and replay stay correct.                                                                                                |
| `00b6cab5-aad5-4ca5-aec0-5ca5d33e12a1` | Owner/generation leases and model reservations survive replacement without duplicate reservation.                                                                                                                                      |
| `006bc9c8-d6e0-4c64-bdaf-63bc6265e011` | Accepted promise, pending amendment, later accepted amendment, canonical origin resolution, historical deadline, real transfer fulfillment, text fallback and actual pgvector retrieval. Scripted vectors are explicitly fixture data. |
| `e42a4ba0-ef65-4832-98a5-e2ae625dc7d3` | Lost isolated Redis delivery is rebuilt from SQL; five scripted model responses finish; consolidation uses cutoff 4; the citizen stays asleep with unchanged clock; a replacement worker makes no duplicate request.                   |
| `4c63e3ed-fdd8-4a35-8c49-8fcc6ac440ae` | Actor response persistence and real rejected/accepted action receipts continue to work after memory integration.                                                                                                                       |
| `e3145b4d-702f-437e-869a-d6eaa8c3da65` | Existing checkpoint delivery recovers from missing Redis work and verifies R2 content by read-back.                                                                                                                                    |

The suite also checks world ownership and an intentionally disconnected leased PostgreSQL session. The disconnect diagnostic is expected. All fixtures use separate run IDs, and Redis loss tests affect their own named queues.

## Paid OpenAI memory probe

Run `ef4f1c49-6e89-4102-9e79-84e150daeaa1` used real `gpt-5.4-mini-2026-03-17` structured extraction/interview/consolidation and real `text-embedding-3-small` 512-dimensional embeddings.

Its history was deliberately controlled by the test script. This isolates memory behavior from action selection. The run uses the fixture provider label so the ordinary autonomous dispatcher will not consume it. Its memory model calls were real OpenAI calls. No expected answers entered model input.

| Development check                                         | Result                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Initial six-food promise and actual acceptance            | Accepted commitment published at event 5, deadline 64,800,000 simulated milliseconds.                   |
| Five distracting messages and a requested deadline change | Pending amendment at event 18; accepted deadline stays unchanged.                                       |
| Actual other-party acceptance of the change               | Version 2 published at event 21, deadline 68,400,000. Earlier event 5 still returns the original terms. |
| Current deadline interview                                | Correct, with accessible original source IDs.                                                           |
| Original deadline interview                               | Correct, citing the original offer.                                                                     |
| Quantity interview                                        | Correct, six.                                                                                           |
| Current distant garden stock                              | Unknown; the dawn observation was not treated as current stock.                                         |
| Another citizen's private colour preference               | Unknown; private seed content was absent from the compiled context.                                     |
| Sleep consolidation                                       | Fixed cutoff 32; reflection published at 33; no clock advancement or wake/action effect.                |
| Exact replay                                              | Passed. Final paused sequence 35, hash below.                                                           |

The five interview questions passed 5/5 in this single development history. This is a smoke test, not a measured general accuracy rate or held-out result. The history and prompts were used during development.

The compiler retrieved seven candidates and selected three diverse memories. The saved actor-format input estimate was 5,125 tokens including its instructions and tools. Three pending indexes remained visible; compatible indexed rows participated, so the audit correctly reported hybrid retrieval. The final source coverage records pointers separately from the actual context excerpts.

The run made nine paid model operations: three extractions, three memory embeddings, one query embedding, one interview and one consolidation. Estimated cost was **$0.017138**, with zero outstanding reservation. The shared run cap was $0.20 and 40 attempts. These are application estimates for this run, not account-wide billing records. The configured text and embedding price profiles match the primary [GPT-5.4 mini model page](https://developers.openai.com/api/docs/models/gpt-5.4-mini) and [embedding model page](https://developers.openai.com/api/docs/models/text-embedding-3-small).

Final state hash:

```text
71a6999bc6ae73f062585314d1134e234fc21ebb51bffff8db192313bd61c247
```

The report is in ignored `.local/phase-3-live-memory-proof.json` and a run-specific JSON. Exact requests, responses, usage, candidates and interpretations remain in PostgreSQL. Follow-up HTTP checks verified a real pending amendment at event 18, the original deadline at event 5, and HTTP 404 for a future original source requested at event 5.

## Failures that changed the implementation

Four earlier paid development histories failed their acceptance checks. They remain inspectable in PostgreSQL.

| Run                                    | Failure and resulting change                                                                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `c56da2fa-3aa8-4650-aba1-636373d596fd` | The model summarized an accepted offer but returned a proposal, omitted the clock deadline and used a command ID as the agreement ID. Instructions/schema descriptions now distinguish first agreements and canonical IDs. |
| `1c8f07d8-5c55-4d5b-ae63-4565f8fa22a1` | The model chose the accepted operation but calculated the clock incorrectly. Validation rejected it. Code now normalizes unambiguous quoted clock times.                                                                   |
| `4c32fd29-6263-442a-abc2-7290f289fe09` | The model repeated the old agreement and missed the newer amendment. Extraction now identifies newly uninterpreted source IDs and limits repeated casual claims.                                                           |
| `ec319baf-7da1-4e76-83d2-efe00c614776` | The model supplied the correct stored commitment ID but pointed its origin at the amendment message. Code now resolves the canonical origin through that scoped stored ID.                                                 |

These four runs used an estimated $0.023230 in total. Their outputs were not changed into successful responses. The original terms stayed protected when a proposed amendment failed validation.

An early Redis fixture assertion also confused "nothing available to claim" with "all jobs complete" while a lease was active. The test now waits on the SQL terminal statuses. A prior individual publication run encountered a database timeout; later focused runs and the full suite passed. This does not imply cloud connections cannot time out.

## Separate-process memory recovery

`bun run verify:memory-restart` created fixture run `216d5a9c-3606-4f47-b8aa-380ab7b73575`. A separate process claimed extraction work, saved a scripted response and was killed with SIGKILL before publication. The check waited for its real 30-second lease to expire.

A new process published from the saved response with zero provider calls. A repeated consumer also made zero calls and preserved the hash. Original sources and the derived memory remained available, and world replay matched. This proves saved-response recovery across an OS process kill. It does not establish what happened inside an unknown live provider request during a network crash; those requests remain conservatively accounted and require explicit retry.

Final sequence 3, state hash:

```text
6901380aef380eb83de9577ac01922b7af9d8542c7826bf391c68935aa6b7192
```

Evidence is in ignored `.local/memory-restart-proof.json`. This check makes zero OpenAI requests.

## Browser check and behavior limit

The browser created live OpenAI run `bc5c5c88-6ef9-47e1-b497-3b539baf3ec4`, started it and inspected its actual decision trace. The compiler used hybrid memory. Background work produced raw episodes, qualified sleep reflections and ready indexes. Source expansion displayed the exact personal sleep command and receipt. The inspector exposed retrieval candidates versus selected memories and token estimates.

Seeking event zero disabled writes, hid live thinking and removed future memories/audits from the historical view. Returning live restored the current inspector and its live status message. The run was paused at event 241 after the check; its estimated model use was $0.008321 over 11 operations, with no outstanding reservation. Read-back verified replay hash equality and no additional model requests from inspector searches. Evidence is in ignored `.local/phase-3-browser-proof.json` and `.local/phase-3-memory-view.png`.

This live actor made a plan, tried an unsupported capability and then chose a valid 30-minute sleep despite high morning energy. The engine rejected the unsupported request and recorded the actual sleep. This proves the memory-enabled decision path and mechanics, while showing poor activity selection. It does not close the earlier Phase 2 blocked-route autonomy gate or prove a believable full day. See [Phase 2's remaining acceptance work](./phase-2-verification.md).

## Remaining research and scale work

Phase 4 adds independently thinking citizens and bounded conversations. Predictive Nemori distillation, learned routine quality, semantic topic segmentation, richer contradiction handling, partial delivery allocation, long-run retention and large-world load measurements need further work. The formal multi-seed, held-out evaluation runner and ablations remain later roadmap phases. Nothing in this verification claims those experiments have already run.

Run the checks again with:

```sh
bun run check-types
bun run lint
bun test packages apps
bun run build
bun run db:check
bun run test:integration
bun run verify:memory-restart
# Paid, capped development probe. Remove inherited key overrides if necessary.
env -u OPENAI_API_KEY -u openai_api_key bun run verify:memory
```
