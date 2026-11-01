import { Hono } from "hono";
import type { Database } from "@repo/db";
import {
  MediaStore,
  PlaybackStore,
  RecordingStore,
  WorldStore,
  StoreError,
  createArchiveStore,
} from "@repo/storage";
import { exportRequestSchema } from "@repo/contracts";
export function recordingRoutes(db: Database) {
  const app = new Hono(),
    worlds = new WorldStore(db),
    playback = new PlaybackStore(db),
    recordings = new RecordingStore(db),
    media = new MediaStore(db);
  const archive = () => {
    const store = createArchiveStore();
    if (!store) throw new StoreError("R2 is not configured.", 503);
    return store;
  };
  app.get("/runs/:id/playback", async (c) => {
    const { state } = await worlds.current(c.req.param("id"));
    const from = Number(c.req.query("fromMs")),
      to = Number(c.req.query("toMs")),
      upper = c.req.query("upperSequence");
    return c.json(
      await playback.bundle(
        state.runId,
        from,
        to,
        upper === undefined ? undefined : Number(upper),
      ),
    );
  });
  app.get("/runs/:id/recordings", async (c) => {
    await worlds.current(c.req.param("id"));
    return c.json({ recordings: await recordings.list(c.req.param("id")) });
  });
  app.post("/runs/:id/recordings", async (c) => {
    const { state } = await worlds.current(c.req.param("id"));
    return c.json(
      { id: await recordings.queueExisting(state.runId, state.sequence) },
      202,
    );
  });
  app.get("/runs/:id/recordings/:chunkId", async (c) => {
    const r2 = archive();
    try {
      return c.json(
        await recordings.read(c.req.param("id"), c.req.param("chunkId"), r2),
      );
    } finally {
      r2.close();
    }
  });
  app.get("/runs/:id/exports", async (c) => {
    await worlds.current(c.req.param("id"));
    return c.json({ exports: await media.list(c.req.param("id")) });
  });
  app.post("/runs/:id/exports", async (c) =>
    c.json(
      {
        id: await media.create(
          c.req.param("id"),
          exportRequestSchema.parse(await c.req.json()),
        ),
      },
      202,
    ),
  );
  app.post("/runs/:id/exports/:exportId/retry", async (c) => {
    await media.retry(c.req.param("id"), c.req.param("exportId"));
    return c.json({ status: "scheduled" }, 202);
  });
  app.get("/runs/:id/exports/:exportId/files/:kind", async (c) => {
    const file = await media.file(
        c.req.param("id"),
        c.req.param("exportId"),
        c.req.param("kind"),
      ),
      r2 = archive();
    try {
      const bytes = await r2.read(file.key, file.checksum, file.bytes);
      return c.body(new Uint8Array(bytes).buffer, 200, {
        "Content-Type": file.contentType,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, max-age=300",
      });
    } finally {
      r2.close();
    }
  });
  app.get("/runs/:id/exports/:exportId/signed/:kind", async (c) => {
    const file = await media.file(
        c.req.param("id"),
        c.req.param("exportId"),
        c.req.param("kind"),
      ),
      r2 = archive();
    try {
      return c.json({ url: await r2.signGet(file.key), expiresInSeconds: 300 });
    } finally {
      r2.close();
    }
  });
  return app;
}
