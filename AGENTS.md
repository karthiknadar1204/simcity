<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": true` in the root `turbo.json` or `turbo.jsonc` to opt in; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# Simcity

Read `skill-centre.md` and apply relevant skills from `.agent/skills`. That directory is canonical. Keep the three platform aliases as links and update the inventory when skills change.

## Product boundaries

- The engine implements general mechanics. Citizen names, biographies, maps, initial knowledge, capabilities, and resource quantities belong in versioned scenario data.
- Never encode a citizen's future choices or a specific delivery story in production engine code. Deterministic command sequences belong only in clearly labeled test fixtures.
- Phase 1 is an operator-controlled physics and recording sandbox. Autonomous decisions start in Phase 2. Never present manual commands as autonomous behavior.
- Preserve private knowledge boundaries, exact action outcomes, integer simulation time, serializable random state, and restart continuity.

## Ownership and folders

- `packages/contracts`: shared schemas and wire formats.
- `packages/agent-runtime`: bounded context, OpenAI adapter, typed tools, durable thinking runner, and BullMQ cognition host.
- `packages/engine`: pure deterministic world transitions. No database, network, model, or renderer imports.
- `packages/memory`: pure evidence validation, episode grouping, temporal rules, and retrieval selection. No model or database imports.
- `packages/db`: Drizzle schemas, migrations, and database connection.
- `packages/storage`: transactional recording, recovery, and object archives.
- `packages/jobs`: Redis/BullMQ transport and outbox reconciliation.
- `apps/api`: thin Hono routes and the world coordinator.
- `apps/worker`: background delivery and archive processing.
- `apps/web`: React controls and Phaser rendering of authoritative state.
- `experiments`: versioned scenarios, protocols, and isolated fixtures. Held-out cases never enter citizen context.

Use the test-first skill for stateful behavior. Run relevant tests, type checks, lint, builds, and a real service path before reporting a milestone complete. Keep credentials, `.local`, build output, and runtime reports out of Git. This session authorizes regular commits and pushes to the existing repository.
