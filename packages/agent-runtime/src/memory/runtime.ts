import { memoryPolicy } from "@repo/contracts";
import { createMemoryQueue, createMemoryWorker } from "@repo/jobs";
import type { MemoryWorkStore } from "@repo/storage";
import type { MemoryRunner } from "./runner";

export class MemoryRuntime {
  private queue: ReturnType<typeof createMemoryQueue>;
  private worker?: ReturnType<typeof createMemoryWorker>;
  private timer?: ReturnType<typeof setInterval>;
  private dispatching = false;
  constructor(
    readonly work: MemoryWorkStore,
    readonly runner: MemoryRunner,
    redisUrl: string,
    readonly queueName?: string,
    readonly fixtureRunId?: string,
  ) {
    this.queue = createMemoryQueue(redisUrl, queueName);
    this.redisUrl = redisUrl;
    this.queue.on("error", () =>
      console.error("Memory producer connection error."),
    );
  }
  readonly redisUrl: string;
  async start() {
    await this.queue.setGlobalConcurrency(memoryPolicy.concurrency);
    this.worker = createMemoryWorker(
      this.redisUrl,
      (id) => this.runner.run(id),
      this.queueName,
    );
    await this.worker.waitUntilReady();
    await this.dispatch();
    this.timer = setInterval(() => void this.dispatch(), 1000);
  }
  private async dispatch() {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      for (const task of await this.work.candidates(
        Boolean(this.fixtureRunId),
        this.fixtureRunId,
      )) {
        let existing = await this.queue.getJob(task.id);
        if (existing) {
          const status = await existing.getState();
          if (status === "completed") {
            await existing.remove();
            existing = undefined;
          } else if (status === "failed") {
            await this.work.failDelivery(task.id);
            continue;
          }
        }
        if (!existing)
          await this.queue.add(
            "memory.work",
            { taskId: task.id },
            {
              jobId: task.id,
              priority:
                task.operation === "extract"
                  ? 1
                  : task.operation === "consolidate"
                    ? 10
                    : 20,
            },
          );
        await this.work.markQueued(task.id);
      }
    } catch {
      console.error(
        "Memory outbox reconciliation failed; SQL work remains durable.",
      );
    } finally {
      this.dispatching = false;
    }
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    while (this.dispatching) await Bun.sleep(10);
    await this.worker?.close();
    await this.queue.close();
  }
}
