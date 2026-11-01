# Simcity

Phases 0–2 of a persistent citizen simulation. The world can move residents tile by tile, run resource interactions, deliver local speech, sleep, record events, replay history, and resume after a server restart. Phase 2 adds one OpenAI-controlled resident with scoped context, a revisable plan, typed tools, and durable thinking tasks.

Choose an **operator sandbox** or an **AI town**. The engine contains mechanics; scenarios contain people and places. Production code contains no citizen-specific future action sequence. Full episodic/semantic memory, commitments, and sleep consolidation belong to Phase 3. See [Phase 2 behavior](./docs/phase-2.md) and [the verification status](./docs/phase-2-verification.md); funded live inference is still required to pass the autonomy gate.

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

The root `.env` holds `DATABASE_URL`, `REDIS_URL`, the four `R2_*` variables, and `OPENAI_API_KEY`, as shown in `.env.example`. The API reads Neon and hosts the cognition worker; the archive worker needs Redis and R2. The default actor is pinned to `gpt-5.4-mini-2026-03-17`. Credentials stay on the server. Never add `VITE_` to a secret variable name. Restart the root development command after replacing a key so child processes receive the new environment.

An exported shell key takes precedence over `.env`. If a replaced file key appears ignored, stop development and start it without inherited key overrides:

```sh
env -u OPENAI_API_KEY -u openai_api_key bun run dev --ui=stream
```

This removes the inherited values only for the launched process; Bun and the API then load the root `.env`. It does not change your shell configuration or print credentials.

AI runs start paused, with an estimated $1 spending cap and 80 request attempts. A known OpenAI rejection pauses the run, records the error, and releases that request's budget reservation. After resolving an account error, use **Retry thinking**, then **Play**. This application estimates model cost; the provider's billing records remain authoritative.

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

Default tests run without cloud credentials; five integration tests are explicitly skipped. `test:integration` uses real Neon, Redis, and R2 and leaves labeled fixture rows/archives for inspection. Scripted provider fixtures test runtime correctness without OpenAI requests. The archive test's Redis queue is isolated from the application queue.

To verify actual process recovery, first stop `bun run dev` and other API coordinators using this database, then run:

```sh
bun run verify:restart
bun run verify:thinking-restart
```

This builds and starts its own API on port 3107, creates a fixture, verifies movement/interruption/transfer/sleep/replay, restarts it gracefully and after SIGKILL, and checks running-world recovery. It waits for the ownership lease after the crash. Logs and a result JSON go to ignored `.local/`. The script stops only the processes it creates. Restart `bun run dev --ui=stream` afterward.

The second command kills a separate process with a pending thinking task, consumes that task from a new process with a scripted provider, and checks that repeating it changes nothing. Both restart checks make zero OpenAI requests. These are mechanics checks, not research results about autonomous agents or memory quality.

With the normal development server running and a funded key, the paid development gate is:

```sh
bun run verify:autonomy
```

It creates one capped AI run, checks a self-initiated plan and model-chosen walking, introduces a route blocker and a permitted encounter, and checks subsequent movement and replay. It pauses its own run when finished, including on failure. It never substitutes scripted answers for a failed inference. See the [acceptance protocol](./experiments/protocols/phase-2.json). This gate currently remains blocked by OpenAI's no-credits response.

## Database and builds

```sh
# After editing the Drizzle schema, generate and review SQL before migrating.
bun run db:generate
bun run db:migrate
bun run db:studio
```

Migration `0000` enables pgvector. `0001` creates world/event/observation/receipt/checkpoint/task/outbox/artifact tables. `0002` adds citizen controls, budgets, thinking turns, and model rounds. Memory embeddings and semantic extraction are Phase 3; enabling vector does not implement retrieval. Migrations never run automatically at API startup.

The database package uses Drizzle's `neon-serverless` adapter with Neon's WebSocket pool for interactive transactions. Redis is delivery infrastructure; committed PostgreSQL records remain authoritative.

Production bundles are in each app's `dist`. Backend bundles run from the installed monorepo using `bun run --cwd apps/api start` and `bun run --cwd apps/worker start`. Keep the versioned `experiments` directory and Git metadata available for scenario loading and provenance. Serve frontend assets with an `/api` reverse proxy. Vite's development proxy is not a production proxy. A Phaser bundle-size warning is currently expected; the library is split into its own chunk.

The operator API binds to loopback by default. Binding elsewhere requires `OPERATOR_TOKEN`; use a trusted authenticated reverse proxy for browser access, because the frontend does not store this token. Production user authentication is outside Phase 1.

References for the original database setup: [Drizzle with Neon](https://orm.drizzle.team/docs/tutorials/drizzle-with-neon), [Neon driver](https://neon.com/docs/serverless/serverless-driver).
