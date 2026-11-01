import { useEffect, useState } from "react";
import type { Action, Citizen, Observation, WorldState } from "@repo/contracts";
import { parseCommand } from "@repo/contracts";
import { request } from "../lib/api";
import { ThinkingPanel } from "./ThinkingPanel";

type ObservationsResponse = { observations: Observation[] };
type Props = {
  state: WorldState;
  citizen: Citizen;
  disabled: boolean;
  autonomous: boolean;
  agentProvider?: "openai" | "fixture";
  replaying: boolean;
  command: (action: Action) => Promise<void>;
};
export function CitizenPanel({
  state,
  citizen,
  disabled,
  command,
  autonomous,
  agentProvider,
  replaying,
}: Props) {
  const [observations, setObservations] = useState<Observation[]>([]);
  const [text, setText] = useState("");
  const [draft, setDraft] = useState('{"kind":"wait","durationMs":1000}');
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    request<ObservationsResponse>(
      `/runs/${state.runId}/citizens/${citizen.id}/observations?limit=12&before=${state.sequence}`,
      { signal: controller.signal },
    )
      .then((result) => setObservations(result.observations))
      .catch(() => {
        if (!controller.signal.aborted) setObservations([]);
      });
    return () => controller.abort();
  }, [state.runId, state.sequence, citizen.id]);
  const job = citizen.actionId ? state.jobs[citizen.actionId] : null;
  function sendDraft() {
    try {
      const { action } = parseCommand({
        id: crypto.randomUUID(),
        action: { ...JSON.parse(draft), actorId: citizen.id },
      });
      setError("");
      void command(action);
    } catch {
      setError("Check the action JSON and its required fields.");
    }
  }
  return (
    <aside className="citizen-panel">
      <p className="eyebrow">SELECTED CITIZEN</p>
      <h2>{citizen.name}</h2>
      <p className="muted">
        Tile {citizen.position.x}, {citizen.position.y} · {job?.kind || "idle"}
      </p>
      {autonomous && (
        <span className="pill">
          {agentProvider === "fixture"
            ? "Scripted provider fixture"
            : "OpenAI citizen"}
        </span>
      )}
      {citizen.plan && (
        <section className="plan">
          <h3>Current intention</h3>
          <strong>{citizen.plan.currentActivity}</strong>
          <p>{citizen.plan.goal}</p>
          <p className="muted">{citizen.plan.briefReason}</p>
          {citizen.plan.blocker && <p>Blocker: {citizen.plan.blocker}</p>}
          <details>
            <summary>Day outline and project steps</summary>
            <ul>
              {citizen.plan.dayOutline.map((entry, index) => (
                <li key={index}>
                  <b>{entry.window}:</b> {entry.activity}
                </li>
              ))}
            </ul>
            <ol>
              {citizen.plan.steps.map((step, index) => (
                <li
                  key={index}
                  className={
                    citizen.plan!.cursor === index ? "current-step" : ""
                  }
                >
                  {step}
                </li>
              ))}
            </ol>
            <small>
              Plan v{citizen.plan.version} · intentions; action receipts
              establish outcomes.
            </small>
          </details>
        </section>
      )}
      {autonomous && !replaying && (
        <ThinkingPanel
          key={`${state.runId}-${citizen.id}`}
          runId={state.runId}
          citizenId={citizen.id}
        />
      )}
      {autonomous && replaying && (
        <p className="muted">
          This is the plan saved at the historical boundary. Live thinking
          traces are hidden.
        </p>
      )}
      <div className="needs">
        <span>
          Energy <b>{citizen.needs.energy}/1000</b>
        </span>
        <meter min="0" max="1000" value={citizen.needs.energy} />
        <span>
          Hunger <b>{citizen.needs.hunger}/1000</b>
        </span>
        <meter min="0" max="1000" value={citizen.needs.hunger} />
      </div>
      <p className="inventory">
        {Object.entries(citizen.inventory)
          .map(([resource, amount]) => `${resource}: ${amount}`)
          .join(" · ") || "Empty inventory"}
      </p>
      <div className="button-row">
        <button
          disabled={disabled || !job}
          onClick={() => void command({ kind: "cancel", actorId: citizen.id })}
        >
          Cancel activity
        </button>
        <button
          disabled={disabled}
          onClick={() =>
            void command({
              kind: "wait",
              actorId: citizen.id,
              durationMs: 60000,
            })
          }
        >
          Wait 1 min
        </button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) {
            void command({
              kind: "say",
              actorId: citizen.id,
              text: text.trim(),
            });
            setText("");
          }
        }}
      >
        <label htmlFor="speech">Say something nearby</label>
        <div className="button-row">
          <input
            id="speech"
            maxLength={2000}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="A message to nearby listeners"
          />
          <button disabled={disabled || !text.trim()}>Say</button>
        </div>
      </form>
      <details>
        <summary>Object capabilities & operator actions</summary>
        <p className="muted">
          Mechanics only. The engine validates distance, access, resources, and
          activity state.
        </p>
        <div className="capabilities">
          {Object.values(state.objects).map((object) => (
            <div key={object.id}>
              <strong>{object.name}</strong>
              <span className="muted">
                {" "}
                ({object.position.x}, {object.position.y})
              </span>
              <div className="button-row">
                <button
                  disabled={disabled}
                  onClick={() =>
                    void command({
                      kind: "inspect",
                      actorId: citizen.id,
                      targetId: object.id,
                    })
                  }
                >
                  Inspect
                </button>
                {object.tags.includes("bed") && (
                  <button
                    disabled={disabled}
                    onClick={() =>
                      void command({
                        kind: "sleep",
                        actorId: citizen.id,
                        targetId: object.id,
                        durationMs: 8 * 60 * 60 * 1000,
                      })
                    }
                  >
                    Sleep 8h
                  </button>
                )}
                {object.capabilities.map((capability) => (
                  <button
                    key={capability.id}
                    disabled={disabled}
                    onClick={() =>
                      void command({
                        kind: "interact",
                        actorId: citizen.id,
                        targetId: object.id,
                        capabilityId: capability.id,
                        units: 1,
                      })
                    }
                  >
                    {capability.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <label htmlFor="action-json">
          Action JSON · selected citizen ID is added for you
        </label>
        <textarea
          id="action-json"
          rows={4}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
        />
        <button disabled={disabled} onClick={sendDraft}>
          Send action
        </button>
        {error && <p role="alert">{error}</p>}
        <p className="muted">
          For a transfer, use kind, targetId, resource, and amount. Citizen IDs:{" "}
          {Object.keys(state.citizens).join(", ")}. Directed speech accepts
          audienceIds.
        </p>
      </details>
      <h3>Personal observations</h3>
      <p className="muted">
        Only evidence delivered to this citizen, up to event {state.sequence}.
      </p>
      <ol className="observations">
        {observations
          .filter(
            (observation) =>
              observation.citizenId === citizen.id &&
              observation.eventSequence <= state.sequence,
          )
          .map((observation) => (
            <li key={observation.id}>
              <small>
                #{observation.eventSequence} · {observation.kind}
              </small>
              <span>{observation.content}</span>
            </li>
          ))}
      </ol>
      {!observations.length && (
        <p className="muted">No recorded observations at this boundary.</p>
      )}
    </aside>
  );
}
