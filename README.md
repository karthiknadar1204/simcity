# Simcity

Phases 0 and 1 of a persistent citizen simulation. The world can move residents tile by tile, run resource interactions, deliver local speech, sleep, record events, replay history, and resume after a server restart.

This is an **operator sandbox**. Citizen decisions, model tools, retrieval, commitments, and sleep consolidation arrive in later phases. The engine contains mechanics; scenarios contain people and places. Production code contains no citizen-specific future action sequence.

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

Open [the town viewer](http://localhost:5173). Select a scenario and click **Create town**. Select a citizen, click a destination, then press **Play** or **Step 1s**. Shift + click a tile to block/open it. Activities and capabilities are available in the citizen panel. Saved runs are listed in the top selector.

The root `.env` holds `DATABASE_URL`, `REDIS_URL`, and the four `R2_*` variables shown in `.env.example`. The API reads Neon; the worker needs Redis and R2. Credentials stay on the server. Never add `VITE_` to a secret variable name.

`redis:start` uses an installed `redis-server`/`redis-cli` and starts a dedicated loopback service on port 6387 by default. Its AOF data is in ignored `.local/redis`, with `appendfsync everysec` and `noeviction`. It is a local daemon, not an automatically installed boot service. Run the command again after a machine restart. A managed Redis URL can be used by the worker directly.

## Folders

| Folder               | Responsibility                                                         |
| -------------------- | ---------------------------------------------------------------------- |
| `apps/web`           | React controls and Phaser pixel rendering; port 5173.                  |
| `apps/api`           | Hono HTTP/SSE API and fenced world coordinator; port 3001.             |
| `apps/worker`        | Outbox reconciliation and BullMQ checkpoint archives.                  |
| `packages/contracts` | Shared schemas, action types, canonical hashes, runtime policy.        |
| `packages/engine`    | Pure deterministic transitions, navigation, jobs, perception, clock.   |
| `packages/db`        | Neon pool, Drizzle tables/migrations, pgvector extension.              |
| `packages/storage`   | Atomic recording, checkpoints, recovery, verified R2 writes.           |
| `packages/jobs`      | Redis/BullMQ transport and durable task delivery.                      |
| `experiments`        | Versioned scenarios, predeclared protocol, development/held-out cases. |
| `.agent/skills`      | Relevant engineering skills imported/adapted from Neatlogs.            |

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

Default tests run without cloud credentials; the two live integration tests are explicitly skipped. `test:integration` uses real Neon, Redis, and R2 and leaves labeled fixture rows/archives for inspection. Its Redis queue is isolated from the application queue.

To verify actual process recovery, first stop `bun run dev` and other API coordinators using this database, then run:

```sh
bun run verify:restart
```

This builds and starts its own API on port 3107, creates a fixture, verifies movement/interruption/transfer/sleep/replay, restarts it gracefully and after SIGKILL, and checks running-world recovery. It waits for the ownership lease after the crash. Logs and a result JSON go to ignored `.local/`. The script stops only the processes it creates. Restart `bun run dev --ui=stream` afterward.

These are mechanics checks, not research results about autonomous agents or memory quality. No model API is called in these phases.

## Database and builds

```sh
# After editing the Drizzle schema, generate and review SQL before migrating.
bun run db:generate
bun run db:migrate
bun run db:studio
```

Migration `0000` enables pgvector. `0001` creates world/event/observation/receipt/checkpoint/task/outbox/artifact tables. Memory embeddings and semantic extraction are Phase 3; enabling vector does not implement retrieval. Migrations never run automatically at API startup.

The database package uses Drizzle's `neon-serverless` adapter with Neon's WebSocket pool for interactive transactions. Redis is delivery infrastructure; committed PostgreSQL records remain authoritative.

Production bundles are in each app's `dist`. Backend bundles run from the installed monorepo using `bun run --cwd apps/api start` and `bun run --cwd apps/worker start`. Keep the versioned `experiments` directory and Git metadata available for scenario loading and provenance. Serve frontend assets with an `/api` reverse proxy. Vite's development proxy is not a production proxy. A Phaser bundle-size warning is currently expected; the library is split into its own chunk.

The operator API binds to loopback by default. Binding elsewhere requires `OPERATOR_TOKEN`; use a trusted authenticated reverse proxy for browser access, because the frontend does not store this token. Production user authentication is outside Phase 1.

References for the original database setup: [Drizzle with Neon](https://orm.drizzle.team/docs/tutorials/drizzle-with-neon), [Neon driver](https://neon.com/docs/serverless/serverless-driver).
