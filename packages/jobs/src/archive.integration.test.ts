import { expect, test } from "bun:test";
import "@repo/db/env";
import { createDatabase } from "@repo/db";
import { artifacts, backgroundTasks } from "@repo/db/tables";
import { eq } from "drizzle-orm";
import { WorldStore } from "@repo/storage";
import { parseScenario } from "@repo/contracts";
import {
  createArchiveQueue,
  createArchiveWorker,
  dispatchOutbox,
} from "./index";
import scenario from "../../../experiments/scenarios/dev/town.json";

const live = process.env.RUN_INTEGRATION === "1" ? test : test.skip;
live(
  "a missing Redis delivery is republished from PostgreSQL and archived with R2 readback",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const redisUrl = process.env.REDIS_URL!;
    const queueName = `archive-proof-${crypto.randomUUID()}`;
    const queue = createArchiveQueue(redisUrl, queueName);
    let consumer: ReturnType<typeof createArchiveWorker> | undefined;
    try {
      const created = await new WorldStore(db).create(
        parseScenario(scenario),
        "archive-integration-fixture",
      );
      const taskId = `${created.state.runId}-checkpoint-0`;
      await dispatchOutbox(db, queue, [taskId]);
      const lost = await queue.getJob(taskId);
      expect(lost).toBeDefined();
      await lost!.remove();
      await dispatchOutbox(db, queue, [taskId]);
      expect(await queue.getJob(taskId)).toBeDefined();
      consumer = createArchiveWorker(db, redisUrl, queueName);
      await consumer.worker.waitUntilReady();
      const deadline = Date.now() + 20000;
      let status = "";
      while (Date.now() < deadline) {
        const [task] = await db
          .select({ status: backgroundTasks.status })
          .from(backgroundTasks)
          .where(eq(backgroundTasks.id, taskId));
        status = task?.status ?? "missing";
        if (status === "completed" || status === "failed") break;
        await Bun.sleep(250);
      }
      expect(status).toBe("completed");
      const [artifact] = await db
        .select()
        .from(artifacts)
        .where(eq(artifacts.id, taskId));
      expect(artifact?.bytes).toBeGreaterThan(0);
      expect(artifact?.checksum).toHaveLength(64);
      console.log(
        `R2 checkpoint readback verified for fixture run ${created.state.runId}`,
      );
    } finally {
      await consumer?.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await pool.end();
    }
  },
  30000,
);
