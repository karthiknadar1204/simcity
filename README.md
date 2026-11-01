# Simcity

Phases 0–3 of a persistent citizen simulation. The world moves residents tile by tile, runs resource interactions, delivers local speech, sleeps, records events, replays history, and resumes after a server restart. One OpenAI-controlled resident uses a revisable plan, typed tools, personal episodes, accepted commitments and bounded memory context.

Choose an **operator sandbox** or an **AI town**. The engine contains mechanics; scenarios contain people and places. Production code contains no citizen-specific future action sequence. Phase 3 adds PostgreSQL/pgvector retrieval, async extraction and simple sleep consolidation. Read [how memory works](./docs/phase-3.md) and [the actual verification results](./docs/phase-3-verification.md). Focused live memory checks pass; the earlier blocked-route autonomy gate still needs work.

## Start

Use Bun 1.3.3 and Node 22.18+ (22.x) or Node 24.11+ for workspace tooling.

```sh
bun install
# On a new checkout only: copy .env.example to .env and fill it in.
# Keep your existing .env if it is already configured.
bun run redis:start
bun run db:migrate
bun run dev --ui=stream
```

Open [the town viewer](http://localhost:5173). For manual physics, click **Create town**, select a citizen, click a destination, then press **Play** or **Step 1s**. For the model loop, select an AI citizen, click **Create AI town**, then **Play**. The selected AI citizen chooses its own activities; other residents remain operator-controlled in this phase. Its panel shows plans, permitted context, tool calls, receipts, and estimated budget use. Shift + click a tile to block/open it. Saved runs are listed in the top selector.

The root `.env` holds `DATABASE_URL`, `REDIS_URL`, the four `R2_*` variables, and `OPENAI_API_KEY`, as shown in `.env.example`. The API reads Neon and hosts the actor and memory workers; the archive worker needs Redis and R2. The actor/extractor uses `gpt-5.4-mini-2026-03-17`, and embeddings use `text-embedding-3-small` at 512 dimensions. Credentials stay on the server. Never add `VITE_` to a secret variable name. Restart the root development command after replacing a key so child processes receive the new environment.

An exported shell key takes precedence over `.env`. If a replaced file key appears ignored, stop development and start it without inherited key overrides:

```sh
env -u OPENAI_API_KEY -u openai_api_key bun run dev --ui=stream
```

This removes the inherited values only for the launched process; Bun and the API then load the root `.env`. It does not change your shell configuration or print credentials.

AI runs start paused, with an estimated $1 spending cap and 80 request attempts shared by actor and memory operations. Memory work may finish while the simulation clock is paused. A known actor OpenAI rejection pauses the run, records the error, and releases that request's budget reservation. After resolving an account error, use **Retry thinking**, then **Play**. Memory failures retain raw evidence and have a separate retry control. This application estimates model cost; the provider's billing records remain authoritative.

Open **Memory & context inspector** to see personal episodes, commitments, source links, index/work state and retrieval versus selected context. Its searches and replay make no model requests. Create a new AI town for Phase 3; older runs retain their recorded memory variant without automatic backfill.

`redis:start` uses an installed `redis-server`/`redis-cli` and starts a dedicated loopback service on port 6387 by default. Its AOF data is in ignored `.local/redis`, with `appendfsync everysec` and `noeviction`. It is a local daemon, not an automatically installed boot service. Run the command again after a machine restart. A managed Redis URL can be used by the worker directly.

## Folders

| Folder                   | Responsibility                                                         |
| ------------------------ | ---------------------------------------------------------------------- |
| `apps/web`               | React controls and Phaser pixel rendering; port 5173.                  |
| `apps/api`               | Hono HTTP/SSE API and fenced world coordinator; port 3001.             |
| `apps/worker`            | Outbox reconciliation and BullMQ checkpoint archives.                  |
| `packages/contracts`     | Shared schemas, action types, canonical hashes, runtime policy.        |
| `packages/agent-runtime` | Bounded context, OpenAI Responses adapter, tools, thinking runner.     |
| `packages/engine`        | Pure deterministic transitions, navigation, jobs, perception, clock.   |
| `packages/memory`        | Pure evidence, grouping, temporal rules and memory diversity.          |
| `packages/db`            | Neon pool, Drizzle tables/migrations, pgvector extension.              |
| `packages/storage`       | Atomic recording, checkpoints, recovery, verified R2 writes.           |
| `packages/jobs`          | Redis/BullMQ transport and durable task delivery.                      |
| `experiments`            | Versioned scenarios, predeclared protocol, development/held-out cases. |
| `.agent/skills`          | Relevant engineering skills imported/adapted from Neatlogs.            |

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

Default tests run without cloud credentials; nine integration tests are explicitly skipped. `test:integration` uses real Neon, Redis, and R2 and leaves labeled fixture rows/archives for inspection. Scripted provider fixtures test runtime correctness without OpenAI requests. Redis loss tests use isolated queues.

To verify actual process recovery, first stop `bun run dev` and other API coordinators using this database, then run:

```sh
bun run verify:restart
bun run verify:thinking-restart
bun run verify:memory-restart
```

This builds and starts its own API on port 3107, creates a fixture, verifies movement/interruption/transfer/sleep/replay, restarts it gracefully and after SIGKILL, and checks running-world recovery. It waits for the ownership lease after the crash. Logs and a result JSON go to ignored `.local/`. The script stops only the processes it creates. Restart `bun run dev --ui=stream` afterward.

The second command kills a separate process with a pending thinking task, consumes that task from a new process with a scripted provider, and checks that repeating it changes nothing. The third kills a memory worker after saving its scripted response and verifies that a replacement publishes it without another request. All restart checks make zero OpenAI requests. These are mechanics checks, not research results about autonomous agents or memory quality.

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
