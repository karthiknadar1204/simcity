import { agentPolicy } from "@repo/contracts";
import { createThinkingQueue, createThinkingWorker } from "@repo/jobs";
import type { AgentStore } from "@repo/storage";
import type { AgentRunner } from "./runner";

export class AgentRuntime {
  private queue: ReturnType<typeof createThinkingQueue>;
  private worker?: ReturnType<typeof createThinkingWorker>;
  private timer?: ReturnType<typeof setInterval>;
  private dispatching = false;
  constructor(
    readonly agents: AgentStore,
    readonly runner: AgentRunner,
    readonly redisUrl: string,
  ) {
    this.queue = createThinkingQueue(redisUrl);
    this.queue.on("error", () =>
      console.error("Thinking producer connection error."),
    );
  }
  async start() {
    await this.queue.setGlobalConcurrency(agentPolicy.concurrency);
    this.worker = createThinkingWorker(this.redisUrl, (id) =>
      this.runner.run(id),
    );
    await this.worker.waitUntilReady();
    await this.dispatch();
    this.timer = setInterval(() => {
      void this.dispatch();
    }, 1000);
  }
  private async dispatch() {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      for (const task of await this.agents.candidates()) {
        let existing = await this.queue.getJob(task.id);
        if (existing) {
          const state = await existing.getState();
          if (state === "completed") {
            await existing.remove();
            existing = undefined;
          } else if (state === "failed") {
            await this.agents.failDelivery(task.id);
            continue;
          }
        }
        if (!existing)
          await this.queue.add(
            "agent.think",
            { taskId: task.id },
            { jobId: task.id },
          );
        await this.agents.markQueued(task.id);
      }
    } catch {
      console.error(
        "Thinking outbox reconciliation failed; durable tasks will retry.",
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
