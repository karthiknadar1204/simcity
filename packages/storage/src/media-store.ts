import type { Database } from "@repo/db";
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { backgroundTasks, outbox, videoExports } from "@repo/db/tables";
import {
  contentHash,
  exportRequestSchema,
  type VideoRequest,
  type MediaFile,
  type VideoPayload,
} from "@repo/contracts";
import { WorldStore, StoreError } from "./world-store";
export type MediaGuard = { id: string; ownerId: string; generation: number };
export class MediaStore {
  constructor(readonly db: Database) {}
  async create(runId: string, input: VideoRequest) {
    const request = exportRequestSchema.parse(input),
      worlds = new WorldStore(this.db),
      current = await worlds.current(runId),
      initial = await worlds.atSequence(runId, 0);
    if (
      request.startMs < initial.simTimeMs ||
      request.endMs > current.state.simTimeMs
    )
      throw new StoreError("Choose a recorded time interval.", 400);
    const payload: VideoPayload = {
        runId,
        upperSequence: current.state.sequence,
        request,
      },
      id = `video-${await contentHash(payload)}`;
    await this.db.transaction(async (tx) => {
      await tx
        .insert(backgroundTasks)
        .values({ id, runId, kind: "media.export", payload, status: "pending" })
        .onConflictDoNothing();
      await tx
        .insert(videoExports)
        .values({ id, runId, payload })
        .onConflictDoNothing();
      await tx.insert(outbox).values({ taskId: id }).onConflictDoNothing();
    });
    return id;
  }
  async list(runId: string) {
    return this.db
      .select({
        export: videoExports,
        status: backgroundTasks.status,
        error: backgroundTasks.error,
        attempts: backgroundTasks.attempts,
      })
      .from(videoExports)
      .innerJoin(backgroundTasks, eq(backgroundTasks.id, videoExports.id))
      .where(eq(videoExports.runId, runId))
      .orderBy(desc(backgroundTasks.createdAt))
      .limit(20);
  }
  async candidates() {
    return this.db
      .select({ id: videoExports.id })
      .from(videoExports)
      .innerJoin(backgroundTasks, eq(backgroundTasks.id, videoExports.id))
      .where(
        and(
          inArray(backgroundTasks.status, ["pending", "queued", "running"]),
          or(
            isNull(videoExports.leaseUntil),
            lte(videoExports.leaseUntil, sql`clock_timestamp()`),
          ),
        ),
      )
      .limit(20);
  }
  async begin(id: string, ownerId: string) {
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(backgroundTasks)
        .where(eq(backgroundTasks.id, id))
        .for("update");
      if (
        !job ||
        job.kind !== "media.export" ||
        job.status === "completed" ||
        job.status === "failed"
      )
        return null;
      if (job.attempts >= 3) {
        await tx
          .update(backgroundTasks)
          .set({ status: "failed", error: "Export retry budget exhausted." })
          .where(eq(backgroundTasks.id, id));
        return null;
      }
      const [row] = await tx
        .update(videoExports)
        .set({
          ownerId,
          generation: sql`${videoExports.generation}+1`,
          leaseUntil: sql`clock_timestamp()+interval '60 seconds'`,
        })
        .where(
          and(
            eq(videoExports.id, id),
            or(
              isNull(videoExports.leaseUntil),
              lte(videoExports.leaseUntil, sql`clock_timestamp()`),
            ),
          ),
        )
        .returning();
      if (!row) return null;
      await tx
        .update(backgroundTasks)
        .set({ status: "running", attempts: job.attempts + 1, error: null })
        .where(eq(backgroundTasks.id, id));
      return {
        payload: row.payload,
        guard: { id, ownerId, generation: row.generation },
      };
    });
  }
  private fence(g: MediaGuard) {
    return and(
      eq(videoExports.id, g.id),
      eq(videoExports.ownerId, g.ownerId),
      eq(videoExports.generation, g.generation),
      sql`${videoExports.leaseUntil}>clock_timestamp()`,
    );
  }
  async heartbeat(g: MediaGuard) {
    const rows = await this.db
      .update(videoExports)
      .set({ leaseUntil: sql`clock_timestamp()+interval '60 seconds'` })
      .where(this.fence(g))
      .returning({ id: videoExports.id });
    return rows.length === 1;
  }
  async complete(
    g: MediaGuard,
    files: MediaFile[],
    metadata: Record<string, unknown>,
  ) {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(videoExports)
        .set({ files, metadata, leaseUntil: null, ownerId: null })
        .where(this.fence(g))
        .returning({ id: videoExports.id });
      if (!rows.length)
        throw new Error("Export lease expired; publication rejected.");
      await tx
        .update(backgroundTasks)
        .set({ status: "completed", error: null })
        .where(eq(backgroundTasks.id, g.id));
    });
  }
  async fail(g: MediaGuard) {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(videoExports)
        .set({ leaseUntil: null, ownerId: null })
        .where(this.fence(g))
        .returning({ id: videoExports.id });
      if (rows.length)
        await tx
          .update(backgroundTasks)
          .set({
            status: "failed",
            error:
              "Video export failed. Check renderer build, Chromium, FFmpeg and R2; world data is retained.",
          })
          .where(eq(backgroundTasks.id, g.id));
    });
  }
  async retry(runId: string, id: string) {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(videoExports)
        .where(and(eq(videoExports.runId, runId), eq(videoExports.id, id)))
        .for("update");
      if (!row) throw new StoreError("Export not found.", 404);
      const updated = await tx
        .update(backgroundTasks)
        .set({ status: "pending", attempts: 0, error: null })
        .where(
          and(eq(backgroundTasks.id, id), eq(backgroundTasks.status, "failed")),
        )
        .returning();
      if (!updated.length)
        throw new StoreError("Only a failed export can be retried.");
      await tx
        .update(outbox)
        .set({ publishedAt: null })
        .where(eq(outbox.taskId, id));
    });
  }
  async file(runId: string, id: string, kind: string) {
    const [row] = await this.db
      .select()
      .from(videoExports)
      .where(and(eq(videoExports.runId, runId), eq(videoExports.id, id)))
      .limit(1);
    const file = row?.files?.find((file) => file.kind === kind);
    if (!file) throw new StoreError("Published export file not found.", 404);
    return file;
  }
}
