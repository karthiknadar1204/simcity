import { Queue, Worker } from "bullmq";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@repo/db";
import {
  artifacts,
  backgroundTasks,
  checkpoints,
  outbox,
  runs,
} from "@repo/db/tables";
import { createArchiveStore } from "@repo/storage";
import { contentHash } from "@repo/contracts";

export const queueNames = {
  archive: "simcity-archive",
  cognition: "simcity-cognition",
  extraction: "simcity-extraction",
  embeddings: "simcity-embeddings",
  consolidation: "simcity-consolidation",
  media: "simcity-media",
  evaluation: "simcity-evaluation",
} as const;

function connection(url: string) {
  const parsed = new URL(url);
  if (!["redis:", "rediss:"].includes(parsed.protocol))
    throw new Error("REDIS_URL must use redis or rediss.");
  const db = Number(parsed.pathname.slice(1) || 0);
  if (!Number.isSafeInteger(db) || db < 0)
    throw new Error("Invalid Redis database number.");
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    db,
    ...(parsed.username
      ? { username: decodeURIComponent(parsed.username) }
      : {}),
    ...(parsed.password
      ? { password: decodeURIComponent(parsed.password) }
      : {}),
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
  };
}

export function createArchiveQueue(
  redisUrl: string,
  name: string = queueNames.archive,
) {
  return new Queue(name, {
    connection: { ...connection(redisUrl), maxRetriesPerRequest: 1 },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: { age: 86400, count: 1000 },
      removeOnFail: false,
    },
  });
}

export async function dispatchOutbox(
  db: Database,
  queue: ReturnType<typeof createArchiveQueue>,
  taskIds?: string[],
) {
  const tasks = await db
    .select()
    .from(backgroundTasks)
    .where(
      and(
        inArray(backgroundTasks.status, ["pending", "queued"]),
        taskIds ? inArray(backgroundTasks.id, taskIds) : undefined,
      ),
    )
    .orderBy(asc(backgroundTasks.createdAt))
    .limit(100);
  for (const task of tasks) {
    const existing = await queue.getJob(task.id);
    if (!existing)
      await queue.add(task.kind, { taskId: task.id }, { jobId: task.id });
    else if ((await existing.getState()) === "failed") {
      await db
        .update(backgroundTasks)
        .set({ status: "failed", error: "Queue retry budget exhausted." })
        .where(
          and(
            eq(backgroundTasks.id, task.id),
            inArray(backgroundTasks.status, ["pending", "queued"]),
          ),
        );
      continue;
    }
    await db.transaction(async (tx) => {
      await tx
        .update(backgroundTasks)
        .set({ status: "queued" })
        .where(
          and(
            eq(backgroundTasks.id, task.id),
            eq(backgroundTasks.status, "pending"),
          ),
        );
      await tx
        .update(outbox)
        .set({ publishedAt: new Date() })
        .where(eq(outbox.taskId, task.id));
    });
  }
}

export function createArchiveWorker(
  db: Database,
  redisUrl: string,
  name: string = queueNames.archive,
) {
  const archive = createArchiveStore();
  if (!archive)
    throw new Error(
      "Configure the four R2 environment variables before starting the archive worker.",
    );
  const worker = new Worker<{ taskId: string }>(
    name,
    async (job) => {
      const [task] = await db
        .select()
        .from(backgroundTasks)
        .where(eq(backgroundTasks.id, job.data.taskId))
        .limit(1);
      if (!task || task.status === "completed") return;
      if (task.attempts >= 5 || task.status === "failed")
        throw new Error("Durable retry budget exhausted.");
      await db
        .update(backgroundTasks)
        .set({ attempts: sql`${backgroundTasks.attempts} + 1` })
        .where(eq(backgroundTasks.id, task.id));
      try {
        const [source] = await db
          .select({
            state: checkpoints.state,
            stateHash: checkpoints.stateHash,
            manifest: runs.manifest,
          })
          .from(checkpoints)
          .innerJoin(runs, eq(runs.id, checkpoints.runId))
          .where(
            and(
              eq(checkpoints.runId, task.payload.runId),
              eq(checkpoints.sequence, task.payload.sequence),
            ),
          )
          .limit(1);
        if (!source) throw new Error("Checkpoint source missing.");
        if (await contentHash(source.state) !== source.stateHash)
          throw new Error("Checkpoint source hash mismatch.");
        const key = `runs/${task.runId}/checkpoints/${task.payload.sequence}-${source.stateHash}.json`;
        const result = await archive.put(
          key,
          JSON.stringify({ version: 1, ...source }),
        );
        await db.transaction(async (tx) => {
          await tx
            .insert(artifacts)
            .values({
              id: task.id,
              runId: task.runId,
              sequence: task.payload.sequence,
              ...result,
            })
            .onConflictDoNothing();
          await tx
            .update(backgroundTasks)
            .set({ status: "completed", error: null })
            .where(eq(backgroundTasks.id, task.id));
        });
      } catch (error) {
        await db
          .update(backgroundTasks)
          .set({
            status: task.attempts + 1 >= 5 ? "failed" : "queued",
            error: error instanceof Error ? error.name : "ArchiveError",
          })
          .where(
            and(
              eq(backgroundTasks.id, task.id),
              inArray(backgroundTasks.status, ["pending", "queued"]),
            ),
          );
        // SDK causes can contain signed URLs; persist only the error class above.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(
          "Checkpoint archive failed; inspect task status and R2 configuration.",
        );
      }
    },
    {
      connection: { ...connection(redisUrl), maxRetriesPerRequest: null },
      concurrency: 2,
    },
  );
  worker.on("error", () => console.error("Archive worker connection error."));
  worker.on("failed", (job) =>
    console.error(`Archive task ${job?.id ?? "unknown"} failed.`),
  );
  return {
    worker,
    close: async () => {
      await worker.close();
      archive.close();
    },
  };
}
