import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Action,
  Receipt,
  WorldState,
  WorldEvent,
  RunManifest,
  PlaybackBundle,
} from "@repo/contracts";
import { Playback, intervalBundle, snapshotBundle } from "@repo/playback";
import { request, worldUrl } from "../lib/api";
type CatalogItem = {
  id: string;
  name: string;
  citizens: number;
  residents: { id: string; name: string }[];
};
type CatalogResponse = { scenarios: CatalogItem[] };
type RunsResponse = { runs: RunItem[] };
type RunDetails = { state: WorldState; manifest: RunManifest };
type RunItem = {
  id: string;
  scenarioId: string;
  status: string;
  sequence: number;
};
export function useWorld() {
  const [scenarios, setScenarios] = useState<CatalogItem[]>([]),
    [runs, setRuns] = useState<RunItem[]>([]),
    [runId, setRunId] = useState(
      () => localStorage.getItem("simcity.run") || "",
    );
  const [manifest, setManifest] = useState<RunManifest | null>(null),
    [live, setLive] = useState<WorldState | null>(null),
    [liveBundle, setLiveBundle] = useState<PlaybackBundle | null>(null),
    [recording, setRecording] = useState<PlaybackBundle | null>(null);
  const [timeMs, setTimeMs] = useState<number | null>(null),
    [startMs, setStartMs] = useState(0),
    [connected, setConnected] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("Choose a saved run or create a town."),
    [playing, setPlaying] = useState(false),
    [rate, setRate] = useState(1),
    [liveTime, setLiveTime] = useState(0);
  const streamState = useRef<WorldState | null>(null),
    seekVersion = useRef(0);
  const refreshRuns = useCallback(
    async () => setRuns((await request<RunsResponse>("/runs")).runs),
    [],
  );
  useEffect(() => {
    let active = true;
    Promise.all([
      request<CatalogResponse>("/scenarios"),
      request<RunsResponse>("/runs"),
    ])
      .then(([catalog, saved]) => {
        if (active) {
          setScenarios(catalog.scenarios);
          setRuns(saved.runs);
        }
      })
      .catch((error) => {
        if (active) setMessage(error.message);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!runId) return;
    localStorage.setItem("simcity.run", runId);
    const controller = new AbortController();
    streamState.current = null;
    Promise.all([
      request<RunDetails>(`/runs/${runId}`, { signal: controller.signal }),
      request<{ state: WorldState }>(`/runs/${runId}/replay?sequence=0`, {
        signal: controller.signal,
      }),
    ])
      .then(([details, initial]) => {
        if (!controller.signal.aborted) {
          setManifest(details.manifest);
          setStartMs(initial.state.simTimeMs);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setMessage(error.message);
      });
    const stream = new EventSource(worldUrl(`/runs/${runId}/stream`));
    stream.addEventListener("frame", (event) => {
      const { state: incoming, events } = JSON.parse(event.data) as {
          state: WorldState;
          events: WorldEvent[];
        },
        previous = streamState.current;
      if (previous && incoming.sequence < previous.sequence) return;
      streamState.current = incoming;
      setLive((previous) =>
        previous?.runId === incoming.runId &&
        previous.sequence > incoming.sequence
          ? previous
          : incoming,
      );
      try {
        const bundle =
          previous && events.length === incoming.sequence - previous.sequence
            ? intervalBundle(previous, incoming, events)
            : snapshotBundle(incoming);
        new Playback(bundle);
        setLiveBundle(bundle);
      } catch {
        setLiveBundle(snapshotBundle(incoming));
      }
      setConnected(true);
    });
    stream.onerror = () => setConnected(false);
    return () => {
      controller.abort();
      stream.close();
    };
  }, [runId]);
  useEffect(() => {
    if (!liveBundle) return;
    let raf = 0;
    const start = performance.now();
    function draw(now: number) {
      const ratio = Math.min(1, (now - start) / 500);
      setLiveTime(
        liveBundle!.fromMs + (liveBundle!.toMs - liveBundle!.fromMs) * ratio,
      );
      if (ratio < 1) raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [liveBundle]);
  const livePlayback = useMemo(
      () => (liveBundle ? new Playback(liveBundle) : null),
      [liveBundle],
    ),
    historyPlayback = useMemo(
      () => (recording ? new Playback(recording) : null),
      [recording],
    );
  const frame =
    historyPlayback && timeMs !== null
      ? historyPlayback.frameAt(
          Math.max(recording!.fromMs, Math.min(recording!.toMs, timeMs)),
        )
      : (livePlayback?.frameAt(
          Math.max(liveBundle!.fromMs, Math.min(liveBundle!.toMs, liveTime)),
        ) ??
        (live
          ? new Playback(snapshotBundle(live)).frameAt(live.simTimeMs)
          : null));
  function selectRun(id: string) {
    setMessage("Loading saved run…");
    seekVersion.current++;
    setManifest(null);
    setLive(null);
    setLiveBundle(null);
    setRecording(null);
    setTimeMs(null);
    setPlaying(false);
    setConnected(false);
    setRunId(id);
  }
  async function create(
    scenarioId: string,
    autonomous = false,
    citizenId?: string,
  ) {
    setBusy(true);
    try {
      const result = await request<RunDetails>("/runs", {
        method: "POST",
        body: JSON.stringify({
          scenarioId,
          ...(autonomous
            ? { autonomous: true, ...(citizenId ? { citizenId } : {}) }
            : {}),
        }),
      });
      selectRun(result.state.runId);
      setManifest(result.manifest);
      setMessage(
        autonomous
          ? "AI town created and paused. Press Play to let the citizens choose."
          : "Town created. Select a citizen, then click a destination.",
      );
      await refreshRuns();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not create town.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function command(action: Action) {
    if (!runId || recording || busy) return;
    setBusy(true);
    try {
      const result = await request<{ state: WorldState; receipt: Receipt }>(
        `/runs/${runId}/commands`,
        {
          method: "POST",
          body: JSON.stringify({ id: crypto.randomUUID(), action }),
        },
      );
      setLive((previous) =>
        previous && previous.sequence > result.state.sequence
          ? previous
          : result.state,
      );
      setMessage(
        result.receipt.status === "rejected"
          ? `Rejected: ${result.receipt.reason}`
          : `${action.kind} accepted · event ${result.receipt.eventSequence}`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Command failed.");
    } finally {
      setBusy(false);
    }
  }
  async function seek(sequence: number) {
    if (!runId) return;
    const version = ++seekVersion.current;
    setBusy(true);
    setPlaying(false);
    try {
      const result = await request<{ state: WorldState }>(
        `/runs/${runId}/replay?sequence=${sequence}`,
      );
      if (version !== seekVersion.current) return;
      setRecording(snapshotBundle(result.state));
      setTimeMs(result.state.simTimeMs);
      setMessage(`Recorded event ${sequence}. Replay is read only.`);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Replay unavailable.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function seekTime(time: number, continuePlaying = false) {
    if (!live || !Number.isFinite(time)) return;
    const version = ++seekVersion.current;
    setBusy(true);
    try {
      const selected = Math.round(
          Math.max(startMs, Math.min(live.simTimeMs, time)),
        ),
        from = Math.max(startMs, selected - 2000),
        to = Math.min(live.simTimeMs, selected + 30000),
        bundle = await request<PlaybackBundle>(
          `/runs/${runId}/playback?fromMs=${from}&toMs=${to}&upperSequence=${live.sequence}`,
        );
      if (version !== seekVersion.current) return;
      setRecording(bundle);
      setTimeMs(selected);
      setPlaying(continuePlaying);
      setMessage(
        "Recorded time. World and personal memories use this event boundary.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Replay unavailable.",
      );
      setPlaying(false);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!playing || !recording || timeMs === null) return;
    let raf = 0,
      last = performance.now(),
      time = timeMs;
    function tick(now: number) {
      time += (now - last) * rate;
      last = now;
      if (time >= recording!.toMs) {
        setTimeMs(recording!.toMs);
        setPlaying(false);
        if (live && recording!.toMs < live.simTimeMs)
          void seekTime(recording!.toMs + 1, true);
        return;
      }
      setTimeMs(time);
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf); // timeMs advances inside this loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, recording, rate]);
  async function loadArchive(id: string) {
    setBusy(true);
    setPlaying(false);
    try {
      const { bundle } = await request<{ bundle: PlaybackBundle }>(
        `/runs/${runId}/recordings/${id}`,
      );
      new Playback(bundle);
      setRecording(bundle);
      setTimeMs(bundle.fromMs);
      setMessage("Playing a verified R2 recording. No inference is requested.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Archive unavailable.",
      );
    } finally {
      setBusy(false);
    }
  }
  return {
    manifest,
    scenarios,
    runs,
    runId,
    setRunId: selectRun,
    live,
    state: frame?.state ?? live,
    frame,
    replaying: Boolean(recording),
    connected,
    busy,
    message,
    create,
    command,
    seek,
    seekTime,
    startMs,
    timeMs: timeMs ?? live?.simTimeMs ?? startMs,
    playing,
    setPlaying,
    rate,
    setRate,
    loadArchive,
    returnLive: () => {
      seekVersion.current++;
      setRecording(null);
      setTimeMs(null);
      setPlaying(false);
      setMessage("Returned to the live world.");
    },
  };
}
