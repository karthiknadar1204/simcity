import type { Database } from "@repo/db";
import { and, asc, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import {
  checkpoints,
  commands,
  events,
  observations,
  runs,
} from "@repo/db/tables";
import {
  contentHash,
  parseCommand,
  parseScenario,
  stableStringify,
  type Command,
  type Scenario,
  type WorldState,
  type RunManifest,
} from "@repo/contracts";
import { applyCommand, createWorld, replay } from "@repo/engine";
import { saveCheckpoint } from "./checkpoints";

export class StoreError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
export type StoredWorld = {
  state: WorldState;
  stateHash: string;
  manifest: RunManifest;
};

export class WorldStore {
  constructor(readonly db: Database) {}

  async create(input: Scenario, commit = "unknown"): Promise<StoredWorld> {
    const scenario = parseScenario(input);
    const state = createWorld(scenario, crypto.randomUUID());
    const stateHash = await contentHash(state);
    const manifest: RunManifest = {
      version: 1,
      runId: state.runId,
      parentRunId: null,
      engineVersion: "phase1-v1",
      schemaVersion: "phase1-v1",
      scenarioId: scenario.id,
      scenarioHash: await contentHash(scenario),
      engineCommit: commit,
      seed: scenario.seed,
      clockPolicy: "freeze-during-downtime",
      actorMode: "operator-fixture",
      modelRoles: {},
      promptVersion: null,
      toolVersion: "commands-v1",
      memoryVariant: "observations-only",
      contextTokenLimit: 0,
      spendingLimitUsd: 0,
      createdAt: new Date().toISOString(),
    };
    await this.db.transaction(async (tx) => {
      await tx.insert(runs).values({
        id: state.runId,
        scenario,
        manifest,
        state,
        stateHash,
        sequence: 0,
        simTimeMs: state.simTimeMs,
        status: state.status,
      });
      await saveCheckpoint(tx, state, stateHash);
    });
    return { state, stateHash, manifest };
  }

  async claim(runId: string, ownerId: string): Promise<number> {
    const [row] = await this.db
      .update(runs)
      .set({
        ownerId,
        ownerGeneration: sql`${runs.ownerGeneration} + 1`,
        leaseUntil: sql`clock_timestamp() + interval '15 seconds'`,
      })
      .where(
        and(
          eq(runs.id, runId),
          or(
            isNull(runs.leaseUntil),
            lte(runs.leaseUntil, sql`clock_timestamp()`),
            eq(runs.ownerId, ownerId),
          ),
        ),
      )
      .returning({ generation: runs.ownerGeneration });
    if (!row) throw new StoreError("World ownership is unavailable.");
    return row.generation;
  }

  async execute(
    runId: string,
    ownerId: string,
    generation: number,
    input: Command,
  ) {
    const command = parseCommand(input);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          state: runs.state,
          stateHash: runs.stateHash,
          valid: sql<boolean>`${runs.ownerId} = ${ownerId} and ${runs.ownerGeneration} = ${generation} and ${runs.leaseUntil} > clock_timestamp()`,
        })
        .from(runs)
        .where(eq(runs.id, runId))
        .for("update");
      if (!row) throw new StoreError("World not found.", 404);
      if (!row.valid)
        throw new StoreError("World ownership changed or expired.");
      const [previous] = await tx
        .select()
        .from(commands)
        .where(and(eq(commands.runId, runId), eq(commands.id, command.id)))
        .limit(1);
      if (previous) {
        if (stableStringify(previous.request) !== stableStringify(command))
          throw new StoreError(
            "Command ID already used with different parameters.",
          );
        return { state: row.state, receipt: previous.receipt };
      }
      if ((await contentHash(row.state)) !== row.stateHash)
        throw new StoreError("Stored world hash mismatch.", 500);
      const result = applyCommand(row.state, command);
      const stateHash = await contentHash(result.state);
      if (result.events.length)
        await tx.insert(events).values(
          result.events.map((payload) => ({
            runId,
            sequence: payload.sequence,
            simTimeMs: payload.simTimeMs,
            payload,
          })),
        );
      if (result.observations.length)
        await tx.insert(observations).values(
          result.observations.map((payload) => ({
            runId,
            citizenId: payload.citizenId,
            eventSequence: payload.eventSequence,
            payload,
          })),
        );
      await tx.insert(commands).values({
        runId,
        id: command.id,
        request: command,
        receipt: result.receipt,
      });
      await tx
        .update(runs)
        .set({
          state: result.state,
          stateHash,
          sequence: result.state.sequence,
          simTimeMs: result.state.simTimeMs,
          status: result.state.status,
          leaseUntil: sql`clock_timestamp() + interval '15 seconds'`,
        })
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.ownerGeneration, generation),
            eq(runs.ownerId, ownerId),
          ),
        );
      const [last] = await tx
        .select({
          sequence: checkpoints.sequence,
          simTimeMs: checkpoints.simTimeMs,
        })
        .from(checkpoints)
        .where(eq(checkpoints.runId, runId))
        .orderBy(desc(checkpoints.sequence))
        .limit(1);
      if (
        !last ||
        result.state.sequence - last.sequence >=
          result.state.rules.checkpointEventInterval ||
        result.state.simTimeMs - last.simTimeMs >=
          result.state.rules.checkpointIntervalMs ||
        (command.action.kind === "set-status" &&
          command.action.status === "paused")
      )
        await saveCheckpoint(tx, result.state, stateHash);
      return { state: result.state, receipt: result.receipt };
    });
  }

  async current(runId: string): Promise<StoredWorld> {
    const [row] = await this.db
      .select({
        state: runs.state,
        stateHash: runs.stateHash,
        manifest: runs.manifest,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    if (!row) throw new StoreError("World not found.", 404);
    return row;
  }

  async load(runId: string): Promise<StoredWorld> {
    const current = await this.current(runId);
    const restored = await this.atSequence(runId, current.state.sequence);
    if (
      (await contentHash(restored)) !== current.stateHash ||
      (await contentHash(current.state)) !== current.stateHash
    )
      throw new StoreError("World recovery hash mismatch.", 500);
    return { ...current, state: restored };
  }

  async atSequence(runId: string, sequence: number): Promise<WorldState> {
    const [checkpoint] = await this.db
      .select()
      .from(checkpoints)
      .where(
        and(eq(checkpoints.runId, runId), lte(checkpoints.sequence, sequence)),
      )
      .orderBy(desc(checkpoints.sequence))
      .limit(1);
    if (!checkpoint) throw new StoreError("Recorded boundary not found.", 404);
    if ((await contentHash(checkpoint.state)) !== checkpoint.stateHash)
      throw new StoreError("Checkpoint hash mismatch.", 500);
    const rows = await this.db
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.runId, runId),
          gt(events.sequence, checkpoint.sequence),
          lte(events.sequence, sequence),
        ),
      )
      .orderBy(asc(events.sequence));
    const state = replay(
      checkpoint.state,
      rows.map((row) => row.payload),
    );
    if (state.sequence !== sequence)
      throw new StoreError("Incomplete recorded interval.", 404);
    return state;
  }

  async list() {
    return this.db
      .select({
        id: runs.id,
        scenarioId: sql<string>`${runs.manifest}->>'scenarioId'`,
        status: runs.status,
        simTimeMs: runs.simTimeMs,
        sequence: runs.sequence,
        createdAt: runs.createdAt,
      })
      .from(runs)
      .orderBy(desc(runs.createdAt))
      .limit(100);
  }

  async history(runId: string, after: number, limit = 100) {
    return (
      await this.db
        .select({ payload: events.payload })
        .from(events)
        .where(and(eq(events.runId, runId), gt(events.sequence, after)))
        .orderBy(asc(events.sequence))
        .limit(limit)
    ).map((row) => row.payload);
  }

  async personalObservations(
    runId: string,
    citizenId: string,
    limit = 50,
    before = Number.MAX_SAFE_INTEGER,
  ) {
    const { state } = await this.current(runId);
    if (!Object.hasOwn(state.citizens, citizenId))
      throw new StoreError("Citizen not found.", 404);
    return (
      await this.db
        .select({ payload: observations.payload })
        .from(observations)
        .where(
          and(
            eq(observations.runId, runId),
            eq(observations.citizenId, citizenId),
            lte(observations.eventSequence, before),
          ),
        )
        .orderBy(desc(observations.eventSequence))
        .limit(limit)
    ).map((row) => row.payload);
  }

  async release(runId: string, ownerId: string, generation: number) {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ state: runs.state, stateHash: runs.stateHash })
        .from(runs)
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.ownerId, ownerId),
            eq(runs.ownerGeneration, generation),
          ),
        )
        .for("update");
      if (!row) return;
      await saveCheckpoint(tx, row.state, row.stateHash);
      await tx
        .update(runs)
        .set({ ownerId: null, leaseUntil: null })
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.ownerGeneration, generation),
            eq(runs.ownerId, ownerId),
          ),
        );
    });
  }
}
