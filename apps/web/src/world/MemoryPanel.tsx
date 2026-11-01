import { useEffect, useState } from "react";
import type { MemoryRecord, CommitmentRecord } from "@repo/contracts";
import { request } from "../lib/api";

type View = {
  variant: string;
  asOf: number;
  records: (MemoryRecord & { indexing: string })[];
  commitments: CommitmentRecord[];
  audits: {
    id: string;
    boundary: number;
    audit: {
      mode: string;
      fallback: string | null;
      candidates: { id: string; channels: string[]; score: number }[];
      selectedIds: string[];
      selectedSourceIds: string[];
      omitted: { id: string; reason: string }[];
      tokens: Record<string, number>;
    };
  }[];
  jobs: {
    task: { id: string; operation: string; outcome: unknown };
    status: string;
    error: string | null;
    calls: { status: string; costMicroUsd: number | null }[];
  }[];
};
export function MemoryPanel({
  runId,
  citizenId,
  sequence,
  replaying,
}: {
  runId: string;
  citizenId: string;
  sequence: number;
  replaying: boolean;
}) {
  const [open, setOpen] = useState(false),
    [view, setView] = useState<View | null>(null);
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState("");
  const [error, setError] = useState(""),
    [source, setSource] = useState<unknown>(null);
  const historicalSequence = replaying ? sequence : undefined;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await request<View>(
          `/runs/${runId}/citizens/${citizenId}/memories?q=${encodeURIComponent(search)}${historicalSequence === undefined ? "" : `&asOf=${historicalSequence}`}`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setView(result);
          setError("");
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error ? error.message : "Memory unavailable.",
          );
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [runId, citizenId, open, search, historicalSequence]);
  const read = async (id: string) => {
    try {
      setSource(
        await request(
          `/runs/${runId}/citizens/${citizenId}/memories/${encodeURIComponent(id)}?asOf=${view?.asOf ?? sequence}`,
        ),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Source unavailable.");
    }
  };
  return (
    <details
      className="memory-panel"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Memory & context inspector</summary>
      {error && <p role="alert">{error}</p>}
      {view && (
        <>
          <p className="muted">
            {view.variant} · knowledge at event #{view.asOf}. Search here uses
            PostgreSQL text retrieval and makes no model requests.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(query);
            }}
          >
            <label htmlFor={`memory-${citizenId}`}>
              Search personal memories
            </label>
            <div className="button-row">
              <input
                id={`memory-${citizenId}`}
                value={query}
                maxLength={200}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button>Search memories</button>
            </div>
          </form>
          <h3>Current commitments</h3>
          {!view.commitments.length && (
            <p className="muted">
              No extracted accepted commitments at this boundary. Proposals
              appear among memories below.
            </p>
          )}
          {view.commitments.map((item) => (
            <details key={item.id}>
              <summary>
                {item.status} · {item.amount} {item.resource} · v{item.version}
              </summary>
              <p>
                {item.debtorId} → {item.creditorId} · deadline:{" "}
                {item.deadlineMs === null
                  ? "unspecified"
                  : `${Math.floor(item.deadlineMs / 3600000)}h ${Math.floor((item.deadlineMs % 3600000) / 60000)}m from simulation origin`}
              </p>
              <p className="muted">
                Known since #{item.availableSequence}; terms evidenced at #
                {item.effectiveSequence}.
              </p>
              {item.sourceIds.map((id) => (
                <button
                  className="source-link"
                  key={id}
                  onClick={() => void read(id)}
                >
                  {id}
                </button>
              ))}
            </details>
          ))}
          <h3>Episodes & interpretations</h3>
          {!view.records.length && (
            <p className="muted">
              No matching memories. Legacy runs retain their original
              observations.
            </p>
          )}
          {view.records.map((item) => (
            <details key={item.id}>
              <summary>
                {item.title} · {item.kind} · {item.certainty}
              </summary>
              <p>{item.text}</p>
              <p className="muted">
                v{item.version} · known since #{item.availableSequence} · vector{" "}
                {item.indexing}. Historical experience; current stock may
                differ.
              </p>
              {item.sourceIds.map((id) => (
                <button
                  className="source-link"
                  key={id}
                  onClick={() => void read(id)}
                >
                  {id}
                </button>
              ))}
              {item.payload.routine != null && (
                <pre>{JSON.stringify(item.payload.routine, null, 2)}</pre>
              )}
            </details>
          ))}
          {source != null && (
            <details open>
              <summary>Original evidence / version</summary>
              <button onClick={() => setSource(null)}>Close evidence</button>
              <pre>{JSON.stringify(source, null, 2)}</pre>
            </details>
          )}
          <h3>Retrieval & final context</h3>
          {!view.audits.length && (
            <p className="muted">No memory context compiled yet.</p>
          )}
          {view.audits.map((item) => (
            <details key={item.id}>
              <summary>
                Boundary #{item.boundary} · {item.audit.mode} ·{" "}
                {item.audit.selectedIds.length}/{item.audit.candidates.length}{" "}
                selected
              </summary>
              <p className="muted">
                {item.audit.fallback ||
                  "Compatible semantic indexes participated in retrieval."}
              </p>
              <p>
                {item.audit.tokens.total !== undefined
                  ? `${item.audit.tokens.total} estimated input tokens including instructions and tools. Later rounds may compact optional copies; exact requests remain recorded.`
                  : "Explicit memory_search tool result."}
              </p>
              <pre>{JSON.stringify(item.audit, null, 2)}</pre>
            </details>
          ))}
          {!replaying && (
            <>
              <h3>Background memory work</h3>
              {view.jobs.map((job) => (
                <details key={job.task.id}>
                  <summary>
                    {job.task.operation} · {job.status}
                  </summary>
                  <p>{job.error}</p>
                  <pre>
                    {JSON.stringify(
                      { outcome: job.task.outcome, calls: job.calls },
                      null,
                      2,
                    )}
                  </pre>
                  {job.status === "failed" && (
                    <button
                      onClick={() => {
                        void request(
                          `/runs/${runId}/citizens/${citizenId}/memory-jobs/${job.task.id}/retry`,
                          { method: "POST", body: "{}" },
                        )
                          .then(() => setError("Retry scheduled."))
                          .catch((error) => setError(error.message));
                      }}
                    >
                      Retry memory work
                    </button>
                  )}
                </details>
              ))}
            </>
          )}
        </>
      )}
    </details>
  );
}
