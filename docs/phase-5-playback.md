# Playback and video export

## What the viewer does

The live map, historical viewer and video capture use the same `Playback` scene frames and Phaser renderer. A frame contains the authoritative state at a selected time, cosmetic positions between recorded walking steps, each citizen's visible activity, recent speech and the day/night shade.

The renderer does not move citizens in the engine. If a recorded walk stops because a route was interrupted, playback stops at that interruption. It never draws the rest of a planned route as if it happened. Walking, work, eating and sleep animation phases come from simulation time, so pausing or seeking does not depend on the browser's wall clock.

The live SSE feed includes ordered committed events between snapshots. The viewer uses those events for a short interpolation delay. Missing or oversized segments snap to the authoritative snapshot. Replay loads a checkpoint and the recorded events needed for the selected time. No model calls happen on either read path.

Use the time slider or **Replay from start**, then **Play replay**. Replay speed controls the recorded timeline and does not change the live simulation. **Recorded event** still selects an exact event boundary. The camera can follow the selected citizen, pan by dragging, or zoom. Pixel sprites, speech bubbles and night lighting are presentation only.

The inspector uses the selected event sequence for personal observations, memories, commitments and completed thinking turns. A later reflection does not appear in an earlier view. Old thinking turns without a saved completion boundary are omitted from historical views rather than guessed. Exact model requests, proposed calls and actual tool outcomes can be expanded. The inspector is an operator view; an acting citizen still receives only its own permitted context.

## What gets archived

Each checkpoint queues a recording interval from the previous checkpoint, in the same SQL transaction as the checkpoint and outbox rows. A chunk contains:

- Starting checkpoint and its SHA-256 state hash.
- Contiguous ordered events through the ending checkpoint.
- Ending world hash, checked by replay before upload.
- Completed actor contexts, exact round requests, responses and receipts.
- Retrieval audits belonging to those completed turns.
- Memory task requests and responses whose publication/index events occur in the interval.

Unpublished or failed model tasks remain in PostgreSQL. Search vectors, memory records, commitments and their version history also remain there. The R2 viewer loads the recorded world from the chunk; its personal-memory inspector still queries PostgreSQL at the selected boundary. This phase does not delete hot data or claim a complete cold-database restore.

The worker writes a content-addressed JSON object to the private R2 bucket, reads the entire object back, and verifies its SHA-256 and byte length. Only then does it publish the interval manifest and completed task state in PostgreSQL. Repeated publication returns the existing immutable descriptor. Failed uploads retain hot data and show task failure after bounded attempts. Requesting the latest archive again explicitly resets a failed interval with a new delivery generation. The stable interval ID and any published manifest remain unchanged.

Lookup uses the recording manifest in PostgreSQL. It does not scan the R2 bucket. Chunks are limited to 20,000 events, 250 completed actor traces, 500 published memory task IDs and 16 MiB of JSON. Oversized intervals fail visibly and retain their source data; automatic subdivision and retention policies are later work.

## How a clip is made

1. The API validates a recorded start/end time, speed and fixed camera. It freezes the run's current upper event sequence. The request ID hashes these values, so repeating the same request at that boundary reuses its export.
2. PostgreSQL saves the request, task and outbox row. BullMQ handles delivery. SQL leases and generations prevent an expired worker from publishing a result.
3. The media worker loads the exact recorded interval. It copies the built web assets into an immutable in-memory snapshot for that job and hashes every asset.
4. A private loopback server serves only that asset snapshot. Owned, pinned headless Chromium opens the app's capture scene. Capture receives the recorded bundle and camera directly, without calling the simulation API or an AI model. External network requests are blocked.
5. The capture scene waits for Phaser to render each requested simulation timestamp. The worker checks the renderer's selected event sequence against `Playback`, then saves a PNG frame. It samples the interval's start, excluding its end, at a fixed 30 fps output clock.
6. FFmpeg encodes H.264 MP4 with `yuv420p` and `faststart`. The first frame becomes a PNG thumbnail. A JSON manifest records timestamps, speed, camera, frame count, renderer version, asset hashes, browser version, FFmpeg version, source hash and sampled state hashes.
7. The worker uploads the MP4, thumbnail and manifest to content-addressed private R2 keys and fully verifies each one. Only then does a fenced SQL transaction publish the three files. A failed export leaves the world intact and can be retried explicitly.

One renderer job runs at a time through the media queue. A worker renews a 60-second lease; an abandoned job can be reclaimed with a new generation. There are three crash attempts before failure. Explicit retry starts a new attempt budget for the same frozen request.

The initial format is 1280×720 at 30 fps, at most 30 output seconds and one simulated hour per clip. A fast playback speed can compress that simulated hour. Longer clips and 1080p need a measured throughput and memory budget first.

The browser requests video through the existing same-origin API proxy. That API reads a known published R2 key and verifies it before returning bytes. R2 keys and credentials are never put in the client bundle. An optional API endpoint issues a five-minute signed URL. Direct browser use of signed R2 URLs would require a bucket CORS rule for the application's origin; the current proxy path does not require that rule.

Browser graphics and fonts can vary across machines. The manifest records the exact capture build and browser; world hashes are the authoritative reproducibility check. Pixel-identical encoding across different operating systems is not promised.

## Local setup

Keep the existing four `R2_*` values in root `.env`. Install the capture browser and make FFmpeg and ffprobe available on `PATH`:

```sh
bun run media:install
ffmpeg -version
ffprobe -version
bun run build
```

On this machine FFmpeg and ffprobe are already installed. A fresh machine must install them before video export. The worker serves its own snapshot of `apps/web/dist`; a dev server alone is not an export renderer. Rebuild the web app after changing capture or rendering code.

Run the normal API, web and background worker with the root development command. Export jobs live in the background worker, so they can finish with the viewer closed. Video status and any failure appear under **Recordings & video export**. A failed clip does not pause the world.

```sh
bun run verify:video
```

This creates a labeled operator fixture, records a short walk, delivers its export through Redis/BullMQ, checks all R2 files, probes the MP4 and compares sampled world hashes. It also counts actor and memory model rows before and after. Both must stay at zero. The proof, MP4, PNG and manifest go to ignored `.local/`.

This check proves recording/export mechanics. It does not measure agent believability or long-term memory quality. Those evaluations remain separate.
