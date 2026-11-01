import { useCallback, useEffect, useState } from "react";
import type { Action, Receipt, WorldState } from "@repo/contracts";
import { request, worldUrl } from "../lib/api";

type CatalogItem = { id: string; name: string; citizens: number };
type RunItem = {
  id: string;
  scenarioId: string;
  status: string;
  sequence: number;
};
type RunsResponse = { runs: RunItem[] };
type CatalogResponse = { scenarios: CatalogItem[] };
export function useWorld() {
  const [scenarios, setScenarios] = useState<CatalogItem[]>([]);
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [runId, setRunId] = useState(
    () => localStorage.getItem("simcity.run") || "",
  );
  const [live, setLive] = useState<WorldState | null>(null);
  const [historical, setHistorical] = useState<WorldState | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    "Choose a saved run or create a town.",
  );
  const refreshRuns = useCallback(async () => {
    const result = await request<RunsResponse>("/runs");
    setRuns(result.runs);
  }, []);
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
    const stream = new EventSource(worldUrl(`/runs/${runId}/stream`));
    stream.addEventListener("world", (event) => {
      const incoming = JSON.parse(event.data) as WorldState;
      setLive((previous) =>
        previous?.runId === incoming.runId &&
        previous.sequence > incoming.sequence
          ? previous
          : incoming,
      );
      setConnected(true);
    });
    stream.onerror = () => {
      setConnected(false);
    };
    return () => stream.close();
  }, [runId]);
  function selectRun(id: string) {
    setLive(null);
    setHistorical(null);
    setConnected(false);
    setRunId(id);
  }
  async function create(scenarioId: string) {
    setBusy(true);
    try {
      const result = await request<{ state: WorldState }>("/runs", {
        method: "POST",
        body: JSON.stringify({ scenarioId }),
      });
      selectRun(result.state.runId);
      setMessage("Town created. Select a citizen, then click a destination.");
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
    if (!runId || historical || busy) return;
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
    setBusy(true);
    try {
      const result = await request<{ state: WorldState }>(
        `/runs/${runId}/replay?sequence=${sequence}`,
      );
      setHistorical(result.state);
      setMessage(`Recorded event ${sequence}. Replay is read only.`);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Replay unavailable.",
      );
    } finally {
      setBusy(false);
    }
  }
  return {
    scenarios,
    runs,
    runId,
    setRunId: selectRun,
    live,
    state: historical ?? live,
    replaying: Boolean(historical),
    connected,
    busy,
    message,
    create,
    command,
    seek,
    returnLive: () => setHistorical(null),
  };
}
