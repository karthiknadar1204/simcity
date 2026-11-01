# Simcity

A persistent citizen simulation with Bun, Hono, React, Vite and Phaser. Citizens move tile by tile, observe nearby events, retrieve personal memories, revise plans, use typed tools, talk independently and sleep. PostgreSQL records actual outcomes and resumes the world from its saved state after a restart.

Phases 0–5 now have engine and viewer implementations. Phase 5's recorded playback and video gate has passed. The full autonomous three-citizen day gate for Phase 4 is still being validated; controlled conversation and sleep/restart checks have passed. These development checks are not paper-scale evaluation results.

Choose an **operator sandbox** or an **AI town**. Scenarios contain people, places, capabilities, starting resources and personal rhythm preferences. Production code contains no citizen-specific future action sequence. Read [memory and context](./docs/phase-3.md), [conversation/day verification](./docs/phase-4-and-5.md), and [playback and video export](./docs/phase-5-playback.md). Earlier verification reports remain as historical evidence, including their failed gates.

## Start

Use Bun 1.3.3 and Node 22.18+ (22.x) or Node 24.11+ for workspace tooling.

```sh
bun install
# On a new checkout only: copy .env.example to .env and fill it in.
# Keep your existing .env if it is already configured.
bun run redis:start
bun run db:migrate
bun run media:install
bun run build
bun run dev --ui=stream
```

Open [the town viewer](http://localhost:5173). For manual physics, click **Create town**, select a citizen, click a destination, then press **Play** or **Step 1s**. For independent citizens, select **A day in town (longer activities)**, leave **All three citizens** selected, click **Create AI town**, then **Play**. Each citizen chooses using its own private context and memory. A single-citizen option is also available.

Select any citizen to inspect its needs, plan, conversations, memories, sources, exact model requests and action receipts. Use the time slider to seek history, **Play replay** to watch it, and **Return live** to resume the live view. The live world keeps running while you watch history or close the viewer. The camera supports following, dragging and zooming. Open **Recordings & video export** for verified R2 intervals and short MP4 clips.

The root `.env` holds `DATABASE_URL`, `REDIS_URL`, the four `R2_*` variables, and `OPENAI_API_KEY`, as shown in `.env.example`. The API reads Neon and hosts the actor and memory workers; the background worker needs Redis and R2. Video export also needs FFmpeg, ffprobe and the pinned Playwright Chromium installation. The actor/extractor uses `gpt-5.4-mini-2026-03-17`, and embeddings use `text-embedding-3-small` at 512 dimensions. Credentials stay on the server. Never add `VITE_` to a secret variable name. Restart the root development command after replacing a key so child processes receive the new environment.

An exported shell key takes precedence over `.env`. If a replaced file key appears ignored, stop development and start it without inherited key overrides:

```sh
env -u OPENAI_API_KEY -u openai_api_key bun run dev --ui=stream
```

This removes the inherited values only for the launched process; Bun and the API then load the root `.env`. It does not change your shell configuration or print credentials.

AI runs start paused, with an estimated $1 spending cap and 2,000 request attempts shared by all citizens' actor and memory operations. Memory work may finish while the simulation clock is paused. A known actor OpenAI rejection pauses the run, records the error, and releases that request's budget reservation. After resolving an account error, use **Retry thinking**, then **Play**. Memory failures retain raw evidence and have a separate retry control. This application estimates model cost; the provider's billing records remain authoritative.

Open **Memory & context inspector** to see personal episodes, commitments, source links, index/work state and retrieval versus selected context. Its searches and replay make no model requests. Older runs retain their recorded citizen configuration and memory variant without automatic backfill. New runs use up to three independent actors and a bounded conversation protocol.

`redis:start` uses an installed `redis-server`/`redis-cli` and starts a dedicated loopback service on port 6387 by default. Its AOF data is in ignored `.local/redis`, with `appendfsync everysec` and `noeviction`. It is a local daemon, not an automatically installed boot service. Run the command again after a machine restart. A managed Redis URL can be used by the worker directly.

## Folders

| Folder                   | Responsibility                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `apps/web`               | React controls and Phaser pixel rendering; port 5173.                              |
| `apps/api`               | Hono HTTP/SSE API and fenced world coordinator; port 3001.                         |
| `apps/worker`            | Outbox reconciliation, verified recording archives and video export.               |
| `packages/contracts`     | Shared schemas, action types, canonical hashes, runtime policy.                    |
| `packages/agent-runtime` | Bounded context, OpenAI Responses adapter, tools, thinking runner.                 |
| `packages/engine`        | Pure deterministic transitions, navigation, jobs, perception, clock.               |
| `packages/memory`        | Pure evidence, grouping, temporal rules and memory diversity.                      |
| `packages/db`            | Neon pool, Drizzle tables/migrations, pgvector extension.                          |
| `packages/storage`       | Atomic recording, checkpoints, recovery, verified R2 writes.                       |
| `packages/playback`      | Recorded time lookup, authoritative scene frames and committed-step interpolation. |
| `packages/media`         | Owned Chromium capture, FFmpeg encoding, export leases and R2 publication.         |
| `packages/jobs`          | Redis/BullMQ transport and durable task delivery.                                  |
| `experiments`            | Versioned scenarios, predeclared protocol, development/held-out cases.             |
| `.agent/skills`          | Relevant engineering skills imported/adapted from Neatlogs.                        |

See [the skill inventory](./skill-centre.md), [implementation details](./docs/phase-0-1.md), and [verification evidence](./docs/phase-0-1-verification.md).

## Checks

```sh
bun run check-types
bun run lint
bun run test
bun run build
bun run db:check
bun run test:integration
```

Default tests run without cloud credentials; live integration checks are explicitly skipped. `test:integration` uses real Neon, Redis, and R2 and leaves labeled fixture rows/archives for inspection. Scripted provider fixtures test runtime correctness without OpenAI requests. Redis loss tests use isolated queues.

To verify actual process recovery, first stop `bun run dev` and other API coordinators using this database, then run:

```sh
bun run verify:restart
bun run verify:thinking-restart
bun run verify:memory-restart
bun run verify:town-restart
```

This builds and starts its own API on port 3107, creates a fixture, verifies movement/interruption/transfer/sleep/replay, restarts it gracefully and after SIGKILL, and checks running-world recovery. It waits for the ownership lease after the crash. Logs and a result JSON go to ignored `.local/`. The script stops only the processes it creates. Restart `bun run dev --ui=stream` afterward.

The second command kills a separate process with a pending thinking task, consumes that task from a new process with a scripted provider, and checks that repeating it changes nothing. The third kills a memory worker after saving its scripted response and verifies that a replacement publishes it without another request. The town restart check separately kills an owning process while three citizens sleep and verifies their next-morning wake and unchanged consolidation cutoffs. All restart checks make zero OpenAI requests. These are mechanics checks, not research results about autonomous agents or memory quality.

For the capped paid memory development probe, run `bun run verify:memory`. It uses controlled experience history with real OpenAI extraction, embeddings, a source-citing interview and sleep consolidation. It saves requests/usage in SQL and reports in ignored `.local/`. The five-question smoke test does not replace the later held-out evaluation program.

With the normal development server running and a funded key, the paid development gate is:

```sh
bun run verify:autonomy
```

It creates one capped AI run, checks a self-initiated plan and model-chosen walking, introduces a route blocker and a permitted encounter, and checks subsequent movement and replay. It pauses its own run when finished, including on failure. It never substitutes scripted answers for a failed inference. See the [acceptance protocol](./experiments/protocols/phase-2.json) and [recorded verification results](./docs/phase-2-verification.md).

## Database and builds

```sh
# After editing the Drizzle schema, generate and review SQL before migrating.
bun run db:generate
bun run db:migrate
bun run db:studio
```

Migration `0000` enables pgvector. `0001` creates world/event/observation/receipt/checkpoint/task/outbox/artifact tables. `0002` adds citizen controls, budgets, thinking turns, and model rounds. `0003` adds versioned memory, commitments, indexes, jobs, model-call accounting and context audits, with full-text and HNSW indexes. Migrations never run automatically at API startup.

The database package uses Drizzle's `neon-serverless` adapter with Neon's WebSocket pool for interactive transactions. Redis is delivery infrastructure; committed PostgreSQL records remain authoritative.

Production bundles are in each app's `dist`. Backend bundles run from the installed monorepo using `bun run --cwd apps/api start` and `bun run --cwd apps/worker start`. Keep the versioned `experiments` directory and Git metadata available for scenario loading and provenance. Serve frontend assets with an `/api` reverse proxy. Vite's development proxy is not a production proxy. A Phaser bundle-size warning is currently expected; the library is split into its own chunk.

The operator API binds to loopback by default. Binding elsewhere requires `OPERATOR_TOKEN`; use a trusted authenticated reverse proxy for browser access, because the frontend does not store this token. Production user authentication is outside Phase 1.

References for the original database setup: [Drizzle with Neon](https://orm.drizzle.team/docs/tutorials/drizzle-with-neon), [Neon driver](https://neon.com/docs/serverless/serverless-driver).

## Phase 4 and 5 checks

```sh
# No OpenAI calls: a recorded walk, real Chromium, FFmpeg and verified R2 files.
bun run verify:video

# Paid three-citizen development pilot, with a shared $1.50 cap.
env -u OPENAI_API_KEY -u openai_api_key bun run verify:town
```

The paid pilot uses the versioned `town-day-v2` scenario and advances the clock to relevant recorded deadlines and runs real, separately prompted residents. It does not write their plans or choose destinations, speech or sleep. It checks a full day, independently initiated activities, dialogue, memory use, plan revision and next-morning wake. Its report records failures as failures. An interrupted pilot can be resumed explicitly with `RESUME_RUN_ID=<id>`; the report retains prior decisions and the previous interruption. Formal evaluation and memory ablations remain later work.

Initial context compilation targets 8,000 tokens. Exact tool history can use separate headroom up to a 16,000-token complete request. Optional duplicated memories compact first; exact receipts and current commitment terms remain. Actor concurrency is two per queue, background memory concurrency is one, and media rendering concurrency is one. The spend cap is shared, not a fresh cap per citizen.

Neon is pinned to 1.1.0 through a root override because 1.2.0 fails the queued-disconnection regression test. See [the recovery evidence and upstream issue](./docs/phase-4-and-5.md). Migration `0004` adds recorded interval/video metadata and historical completion boundaries. No Neo4j is used.

The database package also owns transaction leases outside the adapter's `BEGIN`, including failure cleanup. Long work can prompt an awake citizen to reconsider at a personal rhythm boundary, critical need or accepted promise deadline. These are decision notifications, not scheduled actions. Place navigation approaches a reachable interaction tile, while the model chooses the place and subsequent action.
