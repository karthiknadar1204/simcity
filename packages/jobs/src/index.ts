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
import { createArchiveStore, RecordingStore } from "@repo/storage";
import {
  contentHash,
  runtimePolicy,
  agentPolicy,
  memoryPolicy,
} from "@repo/contracts";

export const queueNames = {
  archive: runtimePolicy.archiveQueue,
  cognition: "simcity-cognition",
  memory: "simcity-memory",
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
      attempts: runtimePolicy.archiveAttempts,
      backoff: { type: "exponential", delay: runtimePolicy.archiveBackoffMs },
      removeOnComplete: { age: 86400, count: 1000 },
      removeOnFail: false,
    },
  });
}

export function createThinkingQueue(redisUrl: string) {
  return createArchiveQueue(redisUrl, queueNames.cognition);
}
export function createThinkingWorker(
  redisUrl: string,
  processTask: (taskId: string) => Promise<void>,
) {
  return createTaskWorker(
    redisUrl,
    queueNames.cognition,
    processTask,
    agentPolicy.concurrency,
    agentPolicy.leaseMs,
  );
}
function createTaskWorker(
  redisUrl: string,
  queueName: string,
  processTask: (taskId: string) => Promise<void>,
  concurrency: number,
  leaseMs: number,
) {
  const worker = new Worker<{ taskId: string }>(
    queueName,
    (job) => processTask(job.data.taskId),
    {
      connection: { ...connection(redisUrl), maxRetriesPerRequest: null },
      concurrency,
      lockDuration: leaseMs,
      stalledInterval: 5000,
      maxStalledCount: 2,
    },
  );
  worker.on("error", () => console.error("Thinking queue connection error."));
  worker.on("failed", (job) =>
    console.error(`Thinking delivery ${job?.id ?? "unknown"} failed.`),
  );
  return worker;
}
export function createMemoryQueue(
  redisUrl: string,
  name: string = queueNames.memory,
) {
  return createArchiveQueue(redisUrl, name);
}
export function createMemoryWorker(
  redisUrl: string,
  processTask: (taskId: string) => Promise<void>,
  name: string = queueNames.memory,
) {
  return createTaskWorker(
    redisUrl,
    name,
    processTask,
    memoryPolicy.concurrency,
    memoryPolicy.leaseMs,
  );
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
        inArray(backgroundTasks.kind, [
          "archive.checkpoint",
          "archive.interval",
        ]),
        inArray(backgroundTasks.status, ["pending", "queued"]),
        taskIds ? inArray(backgroundTasks.id, taskIds) : undefined,
      ),
    )
    .orderBy(asc(backgroundTasks.createdAt))
    .limit(100);
  for (const task of tasks) {
    const generation =
      "retryGeneration" in task.payload
        ? task.payload.retryGeneration
        : undefined;
    const deliveryId = generation ? `${task.id}-retry-${generation}` : task.id;
    const existing = await queue.getJob(deliveryId);
    if (!existing)
      await queue.add(task.kind, { taskId: task.id }, { jobId: deliveryId });
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
      if (task.kind === "archive.interval" && "fromSequence" in task.payload) {
        if (task.attempts >= runtimePolicy.archiveAttempts)
          throw new Error("Recording retry budget exhausted.");
        await db
          .update(backgroundTasks)
          .set({ attempts: sql`${backgroundTasks.attempts}+1` })
          .where(eq(backgroundTasks.id, task.id));
        try {
          await new RecordingStore(db).publish(task.id, task.payload, archive);
        } catch {
          await db
            .update(backgroundTasks)
            .set({
              status:
                task.attempts + 1 >= runtimePolicy.archiveAttempts
                  ? "failed"
                  : "queued",
              error: "Recording archive failed; hot data retained.",
            })
            .where(eq(backgroundTasks.id, task.id));
          throw new Error("Recording archive failed.");
        }
        return;
      }
      if (task.kind !== "archive.checkpoint" || !("sequence" in task.payload))
        throw new Error("Wrong task routed to archive queue.");
      const payload = task.payload;
      if (
        task.attempts >= runtimePolicy.archiveAttempts ||
        task.status === "failed"
      )
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
              eq(checkpoints.runId, payload.runId),
              eq(checkpoints.sequence, payload.sequence),
            ),
          )
          .limit(1);
        if (!source) throw new Error("Checkpoint source missing.");
        if ((await contentHash(source.state)) !== source.stateHash)
          throw new Error("Checkpoint source hash mismatch.");
        const key = `runs/${task.runId}/checkpoints/${payload.sequence}-${source.stateHash}.json`;
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
              sequence: payload.sequence,
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
            status:
              task.attempts + 1 >= runtimePolicy.archiveAttempts
                ? "failed"
                : "queued",
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
      concurrency: runtimePolicy.archiveConcurrency,
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

export function createMediaQueue(redisUrl: string) {
  return createArchiveQueue(redisUrl, queueNames.media);
}
export function createMediaWorker(
  redisUrl: string,
  processTask: (id: string) => Promise<void>,
) {
  return createTaskWorker(redisUrl, queueNames.media, processTask, 1, 60000);
}
