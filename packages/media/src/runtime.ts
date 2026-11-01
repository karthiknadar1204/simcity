import type { Database } from "@repo/db";
import { MediaStore, PlaybackStore, createArchiveStore } from "@repo/storage";
import { createMediaQueue, createMediaWorker } from "@repo/jobs";
import { contentHash, type MediaFile } from "@repo/contracts";
import { renderClip } from "./render";
export class ExportRunner {
  readonly ownerId = crypto.randomUUID();
  readonly store: MediaStore;
  constructor(readonly db: Database) {
    this.store = new MediaStore(db);
  }
  async run(id: string) {
    const claimed = await this.store.begin(id, this.ownerId);
    if (!claimed) return;
    const { guard, payload } = claimed,
      abort = new AbortController(),
      archive = createArchiveStore();
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.store
        .heartbeat(guard)
        .then((valid) => {
          if (!valid) abort.abort();
        })
        .catch(() => abort.abort())
        .finally(() => {
          renewing = false;
        });
    }, 10000);
    try {
      if (!archive) throw new Error("R2 is not configured");
      const bundle = await new PlaybackStore(this.db).bundle(
          payload.runId,
          payload.request.startMs,
          payload.request.endMs,
          payload.upperSequence,
        ),
        clip = await renderClip(bundle, payload.request, abort.signal);
      const files: MediaFile[] = [];
      for (const [kind, bytes, contentType, extension] of [
        ["video", clip.video, "video/mp4", "mp4"],
        ["thumbnail", clip.thumbnail, "image/png", "png"],
      ] as const) {
        const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
          result = await archive.putBytes(
            `runs/${payload.runId}/exports/${id}/${hash}.${extension}`,
            bytes,
            contentType,
          );
        files.push({ kind, contentType, ...result });
      }
      const metadata = { ...clip.metadata, files },
        body = JSON.stringify(metadata),
        result = await archive.put(
          `runs/${payload.runId}/exports/${id}/${await contentHash(metadata)}.json`,
          body,
        );
      files.push({
        kind: "manifest",
        contentType: "application/json",
        ...result,
      });
      await this.store.complete(guard, files, metadata);
    } catch (error) {
      await this.store.fail(guard);
      console.error(
        `Export ${id} failed: ${error instanceof Error ? error.name : "ExportError"}`,
      );
    } finally {
      clearInterval(timer);
      while (renewing) await Bun.sleep(10);
      archive?.close();
    }
  }
}
export class MediaRuntime {
  private readonly queue;
  private readonly worker;
  private timer?: ReturnType<typeof setInterval>;
  private dispatching = false;
  constructor(
    readonly store: MediaStore,
    runner: ExportRunner,
    redisUrl: string,
  ) {
    this.queue = createMediaQueue(redisUrl);
    this.worker = createMediaWorker(redisUrl, (id) => runner.run(id));
    this.queue.on("error", () =>
      console.error("Media queue connection failed."),
    );
  }
  async start() {
    await this.worker.waitUntilReady();
    await this.dispatch();
    this.timer = setInterval(() => {
      void this.dispatch();
    }, 2000);
  }
  private async dispatch() {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      for (const task of await this.store.candidates()) {
        let job = await this.queue.getJob(task.id);
        if (job && ["completed", "failed"].includes(await job.getState())) {
          await job.remove();
          job = undefined;
        }
        if (!job)
          await this.queue.add(
            "media.export",
            { taskId: task.id },
            { jobId: task.id, attempts: 1 },
          );
        await this.store.markQueued(task.id);
      }
    } catch {
      console.error("Media reconciliation failed; durable exports will retry.");
    } finally {
      this.dispatching = false;
    }
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    while (this.dispatching) await Bun.sleep(10);
    await this.worker.close();
    await this.queue.close();
  }
}
