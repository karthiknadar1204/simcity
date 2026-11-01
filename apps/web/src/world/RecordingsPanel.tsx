import { useEffect, useState } from "react";
import type {
  MediaFile,
  WorldState,
  RecordingDescriptor,
} from "@repo/contracts";
import { request, worldUrl } from "../lib/api";
type ExportRow = {
  export: {
    id: string;
    files: MediaFile[] | null;
    metadata: Record<string, unknown> | null;
  };
  status: string;
  error: string | null;
};
type ChunkRow = {
  chunk: {
    id: string;
    fromSequence: number;
    toSequence: number;
    manifest: RecordingDescriptor | null;
  };
  status: string;
};
export function RecordingsPanel({
  state,
  startMs,
  selectedTime,
  onArchive,
}: {
  state: WorldState;
  startMs: number;
  selectedTime: number;
  onArchive: (id: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [exports, setExports] = useState<ExportRow[]>([]),
    [chunks, setChunks] = useState<ChunkRow[]>([]),
    [selected, setSelected] = useState(""),
    [chunk, setChunk] = useState(""),
    [message, setMessage] = useState("");
  const [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [speed, setSpeed] = useState("1"),
    [zoom, setZoom] = useState("1.25"),
    [x, setX] = useState(String(state.map.width / 2 - 0.5)),
    [y, setY] = useState(String(state.map.height / 2 - 0.5));
  const elapsed = (state.simTimeMs - startMs) / 1000;
  const refresh = async () => {
    const [media, recordings] = await Promise.all([
      request<{ exports: ExportRow[] }>(`/runs/${state.runId}/exports`),
      request<{ recordings: ChunkRow[] }>(`/runs/${state.runId}/recordings`),
    ]);
    setExports(media.exports);
    setChunks(recordings.recordings);
  };
  useEffect(() => {
    if (!open) return;
    let active = true;
    const load = () => {
      if (active)
        void refresh().catch(() => {
          if (active) setMessage("Recording service temporarily unavailable.");
        });
    };
    load();
    const timer = setInterval(load, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    }; // renderer state changes do not restart the poll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.runId, open]);
  const chosen =
      exports.find((row) => row.export.id === selected) ?? exports[0],
    published = chunks.filter((row) => row.chunk.manifest),
    chosenChunk = chunk || published[0]?.chunk.id;
  async function create() {
    try {
      const fromMs =
          from === ""
            ? Math.max(startMs, state.simTimeMs - 10000)
            : startMs + Number(from) * 1000,
        toMs = to === "" ? state.simTimeMs : startMs + Number(to) * 1000;
      const reply = await request<{ id: string }>(
        `/runs/${state.runId}/exports`,
        {
          method: "POST",
          body: JSON.stringify({
            startMs: Math.round(fromMs),
            endMs: Math.round(toMs),
            speed: Number(speed),
            fps: 30,
            width: 1280,
            height: 720,
            camera: {
              x: (Number(x) + 0.5) * state.map.tileSize,
              y: (Number(y) + 0.5) * state.map.tileSize,
              zoom: Number(zoom),
            },
          }),
        },
      );
      setSelected(reply.id);
      setMessage(
        "Export queued. It uses recorded events and makes no model requests.",
      );
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Export unavailable.",
      );
    }
  }
  const fileUrl = (kind: string) =>
    worldUrl(`/runs/${state.runId}/exports/${chosen!.export.id}/files/${kind}`);
  return (
    <details
      className="recordings-panel"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Recordings & video export</summary>
      <p className="muted">
        Short clips, 720p · 30 fps · fixed camera. Times are seconds after the
        run began. Maximum 30 output seconds and one simulated hour.
      </p>
      <div className="export-fields">
        <label>
          Start seconds
          <input
            type="number"
            min="0"
            max={elapsed}
            value={from}
            placeholder={String(Math.max(0, elapsed - 10))}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          End seconds
          <input
            type="number"
            min="0"
            max={elapsed}
            value={to}
            placeholder={String(elapsed)}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <label>
          Playback speed
          <input
            type="number"
            min="0.25"
            max="3600"
            value={speed}
            onChange={(e) => setSpeed(e.target.value)}
          />
        </label>
        <label>
          Camera tile X
          <input
            type="number"
            value={x}
            onChange={(e) => setX(e.target.value)}
          />
        </label>
        <label>
          Camera tile Y
          <input
            type="number"
            value={y}
            onChange={(e) => setY(e.target.value)}
          />
        </label>
        <label>
          Camera zoom
          <input
            type="number"
            min="0.25"
            max="4"
            step="0.25"
            value={zoom}
            onChange={(e) => setZoom(e.target.value)}
          />
        </label>
      </div>
      <div className="button-row">
        <button
          onClick={() => {
            setFrom(String(Math.max(0, (selectedTime - startMs) / 1000)));
            setTo(
              String(Math.min(elapsed, (selectedTime - startMs) / 1000 + 10)),
            );
          }}
        >
          Start at selected time
        </button>
        <button onClick={() => void create()}>Export clip</button>
      </div>
      {message && <p role="status">{message}</p>}
      {exports.length > 0 && (
        <>
          <label>
            Exports
            <select
              value={chosen?.export.id ?? ""}
              onChange={(e) => setSelected(e.target.value)}
            >
              {exports.map((row) => (
                <option key={row.export.id} value={row.export.id}>
                  {row.status} · {row.export.id.slice(0, 18)}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">
            {chosen?.status}
            {chosen?.error ? ` · ${chosen.error}` : ""}
          </p>
          {chosen?.status === "failed" && (
            <button
              onClick={() =>
                void request(
                  `/runs/${state.runId}/exports/${chosen.export.id}/retry`,
                  { method: "POST", body: "{}" },
                )
                  .then(refresh)
                  .catch((e) => setMessage(e.message))
              }
            >
              Retry export
            </button>
          )}
          {chosen?.status === "completed" && (
            <>
              <video
                key={chosen.export.id}
                controls
                preload="metadata"
                poster={fileUrl("thumbnail")}
                src={fileUrl("video")}
                aria-label="Recorded town video"
              />
              <div className="button-row">
                <a href={fileUrl("video")} download="simcity.mp4">
                  Download MP4
                </a>
                <a href={fileUrl("manifest")} target="_blank" rel="noreferrer">
                  Export manifest
                </a>
              </div>
            </>
          )}
        </>
      )}
      <h3>R2 recording intervals</h3>
      <p className="muted">
        Published chunks contain a verified checkpoint, events, and completed
        actor traces. PostgreSQL retains the original data.
      </p>
      <button
        onClick={() =>
          void request(`/runs/${state.runId}/recordings`, {
            method: "POST",
            body: "{}",
          })
            .then(() => {
              setMessage("Latest checkpoint interval queued for archive.");
              return refresh();
            })
            .catch((e) => setMessage(e.message))
        }
      >
        Archive latest checkpoint interval
      </button>
      {published.length > 0 && (
        <div className="button-row">
          <select
            aria-label="Archived interval"
            value={chosenChunk}
            onChange={(e) => setChunk(e.target.value)}
          >
            {published.map((row) => (
              <option key={row.chunk.id} value={row.chunk.id}>
                Events {row.chunk.fromSequence}–{row.chunk.toSequence}
              </option>
            ))}
          </select>
          <button onClick={() => void onArchive(chosenChunk!)}>
            Load R2 recording
          </button>
        </div>
      )}
      <small>
        {chunks.filter((row) => row.status !== "completed").length} archive jobs
        pending or failed
      </small>
    </details>
  );
}
