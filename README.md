# Simcity

Bun + Turborepo workspace with a React/Vite/Phaser frontend, a Bun/Hono API, and a server-only Neon PostgreSQL/Drizzle package. This is the initial application setup; the simulation engine and agent behavior are not implemented yet.

## Workspace

| Path                         | Purpose                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| `apps/web`                   | React + Vite + Phaser, on port 5173.                                    |
| `apps/api`                   | Bun + Hono, on port 3001.                                               |
| `packages/db`                | Neon connection pool, Drizzle schema, migrations, and connection check. |
| `packages/ui`                | Shared React components.                                                |
| `packages/eslint-config`     | Shared JavaScript/TypeScript lint configuration.                        |
| `packages/typescript-config` | Shared browser, React, and Bun compiler settings.                       |

## Start locally

Use Bun 1.3.3 or newer. CLI tools require Node 22.18+ (22.x) or Node 24.11+.

```sh
bun install
cp .env.example .env
bun run dev
```

If `.env` already exists, keep it and add the variables from `.env.example` instead of replacing it.

Open <http://localhost:5173>. The starter shows a Phaser canvas and checks the API through Vite's `/api` development proxy. The API can start without a database connection; database health reports `unconfigured` until a connection string is supplied.

## Neon PostgreSQL + Drizzle

Create or select a project in the [Neon console](https://console.neon.tech). Copy its PostgreSQL connection string into **the root `.env`**:

```dotenv
DATABASE_URL=postgresql://USER:PASSWORD@YOUR-NEON-HOST/neondb?sslmode=require
```

Only the backend and database tooling read `DATABASE_URL`. Never prefix it with `VITE_`: those variables are exposed to the browser. Local environment files are ignored by Git.

Restart `bun run dev` after changing `.env` so both apps pick up the new settings.

```sh
# Verify a real connection without changing application data.
bun run db:check

# Review packages/db/drizzle/*.sql, then apply migrations.
bun run db:migrate

# After adding application tables to packages/db/src/schema.ts:
bun run db:generate

# Optional database browser.
bun run db:studio
```

The initial migration enables `vector` for the planned pgvector memory store. There are no application tables yet. Migrations are explicit commands and never run automatically at API startup.

The shared package uses the Neon `Pool` and Drizzle's `neon-serverless` adapter. This supports interactive transactions needed by the future engine. Bun supplies the native WebSocket implementation. SQL/schema tooling uses pinned stable Drizzle releases.

References: [Drizzle's Neon tutorial](https://orm.drizzle.team/docs/tutorials/drizzle-with-neon), [Drizzle connection methods](https://orm.drizzle.team/docs/connect-neon), [Neon driver](https://neon.com/docs/serverless/serverless-driver).

## Checks and build

```sh
bun run check-types
bun run lint
bun run build
```

Frontend output is in `apps/web/dist`. API output is in `apps/api/dist` and runs with `bun run --cwd apps/api start` from the installed monorepo. Serve frontend assets with an `/api` reverse proxy, or set the public `VITE_API_URL` before building and configure the API's `WEB_ORIGIN`. Vite's development proxy is not a production proxy.

## Health endpoints

- `GET /api/health`: API liveness and whether a database URL is configured; it does not query the database.
- `GET /api/health/db`: runs `SELECT 1` through Drizzle; returns 503 when unconfigured or unavailable.

`PORT`, `HOST`, `WEB_ORIGIN`, and `API_PROXY_TARGET` can be adjusted in the root `.env`. If changing the API port, update `API_PROXY_TARGET` too.
