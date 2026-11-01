import { chromium } from "playwright";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { workspaceRoot } from "@repo/db/env";
import {
  contentHash,
  rendererVersion,
  type PlaybackBundle,
  type VideoRequest,
} from "@repo/contracts";
import { Playback } from "@repo/playback";
export function frameTimes(request: VideoRequest) {
  const count = Math.ceil(
    ((request.endMs - request.startMs) / request.speed / 1000) * request.fps,
  );
  return Array.from({ length: count }, (_, index) =>
    Math.min(
      request.endMs - 1,
      request.startMs + (index * 1000 * request.speed) / request.fps,
    ),
  );
}
export async function renderClip(
  bundle: PlaybackBundle,
  request: VideoRequest,
  signal?: AbortSignal,
) {
  const assets = new Map<string, Uint8Array>(),
    dist = join(workspaceRoot, "apps/web/dist");
  for await (const path of new Bun.Glob("**/*").scan({
    cwd: dist,
    onlyFiles: true,
  }))
    assets.set("/" + path, new Uint8Array(await readFile(join(dist, path))));
  if (!assets.has("/index.html"))
    throw new Error("Build the web renderer before exporting video.");
  const assetHashes = await Promise.all(
    [...assets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(async ([path, bytes]) => ({
        path,
        hash: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      })),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path =
          new URL(req.url).pathname === "/"
            ? "/index.html"
            : new URL(req.url).pathname,
        body = assets.get(path);
      const mime: Record<string, string> = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".png": "image/png",
        ".svg": "image/svg+xml",
      };
      return body
        ? new Response(new Uint8Array(body).buffer, {
            headers: {
              "Content-Type": mime[extname(path)] ?? "application/octet-stream",
              "Cache-Control": "no-store",
            },
          })
        : new Response("Not found", { status: 404 });
    },
  });
  const directory = await mkdtemp(join(tmpdir(), "simcity-video-"));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const timeout = setTimeout(() => {
    void browser?.close();
  }, 600000);
  const aborted = () => {
    void browser?.close();
  };
  signal?.addEventListener("abort", aborted, { once: true });
  try {
    if (signal?.aborted) throw new Error("Export cancelled");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    const origin = `http://127.0.0.1:${server.port}`;
    await page.route("**/*", (route) =>
      route
        .request()
        .url()
        .startsWith(origin + "/")
        ? route.continue()
        : route.abort(),
    );
    await page.goto(origin + "/?capture=1");
    await page.waitForFunction(() =>
      Boolean(
        (globalThis as unknown as { __SIMCITY_CAPTURE__: unknown })
          .__SIMCITY_CAPTURE__,
      ),
    );
    const version = await page.evaluate(
      () =>
        (globalThis as unknown as { __SIMCITY_CAPTURE__: { version: string } })
          .__SIMCITY_CAPTURE__.version,
    );
    if (version !== rendererVersion)
      throw new Error("Renderer build is stale. Build web before exporting.");
    await page.evaluate(
      async ({ bundle, camera }) => {
        await (
          globalThis as unknown as {
            __SIMCITY_CAPTURE__: {
              load: (b: unknown, c: unknown) => Promise<void>;
            };
          }
        ).__SIMCITY_CAPTURE__.load(bundle, camera);
      },
      { bundle, camera: request.camera },
    );
    const times = frameTimes(request),
      playback = new Playback(bundle),
      samples: unknown[] = [];
    for (let i = 0; i < times.length; i++) {
      if (signal?.aborted) throw new Error("Export cancelled");
      const time = times[i]!;
      const result = await page.evaluate(
        async (time) =>
          (
            globalThis as unknown as {
              __SIMCITY_CAPTURE__: {
                seek: (
                  t: number,
                ) => Promise<{ sequence: number; timeMs: number }>;
              };
            }
          ).__SIMCITY_CAPTURE__.seek(time),
        time,
      );
      if (result.sequence !== playback.stateAt(time).sequence)
        throw new Error("Renderer selected a different recorded boundary.");
      await page.screenshot({
        path: join(directory, `frame-${String(i).padStart(6, "0")}.png`),
        type: "png",
        animations: "disabled",
      });
      if (
        i === 0 ||
        i === Math.floor(times.length / 2) ||
        i === times.length - 1
      )
        samples.push({
          index: i,
          timeMs: time,
          sequence: result.sequence,
          stateHash: await contentHash(playback.stateAt(time)),
        });
    }
    const child = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-framerate",
        String(request.fps),
        "-i",
        join(directory, "frame-%06d.png"),
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        join(directory, "clip.mp4"),
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const kill = () => child.kill();
    signal?.addEventListener("abort", kill, { once: true });
    const error = await new Response(child.stderr).text(),
      code = await child.exited;
    signal?.removeEventListener("abort", kill);
    if (code !== 0) throw new Error(`FFmpeg failed: ${error.slice(0, 200)}`);
    const ffmpeg = Bun.spawn(["ffmpeg", "-version"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const ffmpegVersion = (await new Response(ffmpeg.stdout).text()).split(
      "\n",
    )[0];
    await ffmpeg.exited;
    const metadata = {
      version: 1,
      rendererVersion,
      browser: browser.version(),
      captureLibrary: "playwright-1.58.2",
      assetsHash: await contentHash(assetHashes),
      assets: assetHashes,
      sourceHash: await contentHash(bundle),
      runId: bundle.runId,
      upperSequence: bundle.upperSequence,
      ...request,
      frameCount: times.length,
      framePolicy:
        "start-inclusive/end-exclusive; exact simulation timestamps; no new inference",
      ffmpegVersion,
      samples,
    };
    return {
      video: new Uint8Array(await readFile(join(directory, "clip.mp4"))),
      thumbnail: new Uint8Array(
        await readFile(join(directory, "frame-000000.png")),
      ),
      metadata,
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", aborted);
    await browser?.close();
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}
