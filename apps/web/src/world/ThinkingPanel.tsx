import { useEffect, useState } from "react";
import { request } from "../lib/api";

type ThinkingView = {
  control: {
    status: string;
    error: string | null;
    pendingReasons: string[];
    configuration: { model: string };
    taskId: string | null;
  };
  budget: {
    spentMicroUsd: number;
    reservedMicroUsd: number;
    limitMicroUsd: number;
    requests: number;
    maxRequests: number;
  };
  turns: {
    id: string;
    status: string;
    reasons: string[];
    boundarySequence: number | null;
    context: unknown;
    outcome: string | null;
    rounds: {
      round: number;
      status: string;
      inputTokens: number;
      answer: {
        call: { name: string; arguments: string } | null;
        inputTokens: number;
        outputTokens: number;
      } | null;
      outcome: {
        status: string;
        reason?: string;
        yield?: boolean;
        data?: unknown;
      } | null;
    }[];
  }[];
};
type Reply = { thinking: ThinkingView | null };
function readableArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
const dollars = (amount: number) => `$${(amount / 1000000).toFixed(4)}`;
export function ThinkingPanel({
  runId,
  citizenId,
}: {
  runId: string;
  citizenId: string;
}) {
  const [view, setView] = useState<ThinkingView | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const reply = await request<Reply>(
          `/runs/${runId}/citizens/${citizenId}/thinking`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setView(reply.thinking);
          setMessage("");
        }
      } catch {
        if (!controller.signal.aborted)
          setMessage("Thinking trace temporarily unavailable.");
      } finally {
        loading = false;
      }
    }
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [runId, citizenId]);
  if (!view)
    return <p className="muted">{message || "Loading citizen decisions…"}</p>;
  const { control, budget } = view;
  return (
    <section className="thinking-panel">
      <h3>Citizen decisions</h3>
      <span className="pill">
        {control.status === "active"
          ? control.taskId
            ? "Thinking task pending / running"
            : "Acting / awaiting next review"
          : control.status}
      </span>
      <p className="muted">{control.configuration.model}</p>
      <p className="spending">
        Estimated budget use: {dollars(budget.spentMicroUsd)} /{" "}
        {dollars(budget.limitMicroUsd)} · {budget.requests}/{budget.maxRequests}{" "}
        model requests
      </p>
      {budget.reservedMicroUsd > 0 && (
        <p className="muted">
          {dollars(budget.reservedMicroUsd)} reserved / unresolved estimates
        </p>
      )}
      {control.error && <p role="alert">{control.error}</p>}
      {control.status === "error" && (
        <button
          onClick={() => {
            void request(`/runs/${runId}/citizens/${citizenId}/retry`, {
              method: "POST",
              body: "{}",
            })
              .then(() => setMessage("Retry scheduled."))
              .catch((error) => setMessage(error.message));
          }}
        >
          Retry thinking
        </button>
      )}
      {message && <p className="muted">{message}</p>}
      {view.turns.map((turn, index) => (
        <details key={turn.id} open={index === 0}>
          <summary>
            {turn.status} · {turn.reasons.join(", ")}
          </summary>
          <small>
            Boundary #{turn.boundarySequence ?? "not fixed"} ·{" "}
            {turn.outcome || "in progress"}
          </small>
          <ol className="tool-trace">
            {turn.rounds.map((round) => (
              <li key={round.round}>
                <strong>{round.answer?.call?.name || round.status}</strong>
                <span>
                  {round.outcome?.status || round.status}
                  {round.outcome?.reason ? `: ${round.outcome.reason}` : ""}
                </span>
                <small>
                  {round.answer
                    ? `${round.answer.inputTokens} input / ${round.answer.outputTokens} output tokens`
                    : `${round.inputTokens} estimated input tokens · ${round.status === "rejected" ? "request rejected" : round.status === "uncertain" ? "usage unknown" : "output pending"}`}
                </small>
                {round.answer?.call && (
                  <details>
                    <summary>Tool request and actual result</summary>
                    <pre>
                      {JSON.stringify(
                        {
                          arguments: readableArguments(
                            round.answer.call.arguments,
                          ),
                          result: round.outcome,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ol>
          {turn.context != null && (
            <details>
              <summary>Context supplied to the model</summary>
              <pre>{JSON.stringify(turn.context, null, 2)}</pre>
            </details>
          )}
        </details>
      ))}
    </section>
  );
}
