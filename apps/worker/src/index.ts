import { ExportRunner, MediaRuntime } from "@repo/media";
import { MediaStore } from "@repo/storage";
import { requireDatabaseUrl } from "@repo/db/env";
import { createDatabase } from "@repo/db";
import { runtimePolicy } from "@repo/contracts";
import {
  createArchiveQueue,
  createArchiveWorker,
  dispatchOutbox,
} from "@repo/jobs";

if (!process.env.REDIS_URL)
  throw new Error("Set REDIS_URL before starting background workers.");
const { db, pool } = createDatabase(requireDatabaseUrl());
const queue = createArchiveQueue(process.env.REDIS_URL);
queue.on("error", () => console.error("Archive queue connection error."));
const consumer = createArchiveWorker(db, process.env.REDIS_URL);
await consumer.worker.waitUntilReady();
const media = new MediaRuntime(new MediaStore(db),new ExportRunner(db),process.env.REDIS_URL);
await media.start();
let dispatching = false;
async function dispatch() {
  if (dispatching) return;
  dispatching = true;
  try {
    await dispatchOutbox(db, queue);
  } catch {
    console.error(
      "Outbox delivery failed; durable tasks remain available for retry.",
    );
  } finally {
    dispatching = false;
  }
}
await dispatch();
const timer = setInterval(() => {
  void dispatch();
}, runtimePolicy.outboxIntervalMs);
console.log("Checkpoint archive worker and outbox reconciliation are running.");

async function shutdown() {
  clearInterval(timer);
  while (dispatching) await Bun.sleep(10);
  await media.close();
  await consumer.close();
  await queue.close();
  await pool.end();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
