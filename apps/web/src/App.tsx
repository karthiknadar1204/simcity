import { useState } from "react";
import { PhaserGame } from "./game/PhaserGame";
import { CitizenPanel } from "./world/CitizenPanel";
import { useWorld } from "./world/useWorld";

function clock(time: number, dayLength: number) {
  const withinDay = time % dayLength;
  const hour = Math.floor(withinDay / 3600000)
    .toString()
    .padStart(2, "0");
  const minute = Math.floor((withinDay % 3600000) / 60000)
    .toString()
    .padStart(2, "0");
  return `Day ${Math.floor(time / dayLength) + 1} · ${hour}:${minute}`;
}
export function App() {
  const world = useWorld();
  const [selected, setSelected] = useState("");
  const [residentId, setResidentId] = useState("");
  const [scenario, setScenario] = useState("");
  const [boundary, setBoundary] = useState("0");
  const state = world.state;
  const citizen =
    state?.citizens[selected] ??
    state?.citizens[world.manifest?.agent?.citizenId ?? ""] ??
    Object.values(state?.citizens ?? {})[0];
  const disabled = world.busy || world.replaying;
  const aiCitizen = world.manifest?.agent?.citizenId;
  const agentProvider = world.manifest?.agent?.provider;
  const chosenScenario =
    world.scenarios.find((item) => item.id === scenario) ?? world.scenarios[0];
  return (
    <main className="app">
      <header>
        <div>
          <p className="eyebrow">SIMCITY / PHASE 03</p>
          <h1>A little world, in motion.</h1>
          <p className="description">
            {agentProvider === "fixture"
              ? "Scripted provider fixture. This run tests mechanics and recovery."
              : aiCitizen
                ? "One citizen chooses with OpenAI. Every action has a real recorded outcome."
                : "Operator sandbox. Create an AI town to run one autonomous citizen."}
          </p>
        </div>
        <span className={`status ${world.connected ? "online" : ""}`}>
          {world.connected ? "Live connection" : "Waiting for world"}
        </span>
      </header>
      <section className="toolbar" aria-label="Run selection">
        <label>
          Saved run
          <select
            value={world.runId}
            disabled={world.busy}
            onChange={(event) => world.setRunId(event.target.value)}
          >
            <option value="">Choose a run</option>
            {world.runs.map((run) => (
              <option key={run.id} value={run.id}>
                {run.scenarioId} · {run.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Scenario
          <select
            value={scenario || world.scenarios[0]?.id || ""}
            onChange={(event) => setScenario(event.target.value)}
          >
            {world.scenarios.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary"
          disabled={world.busy || !world.scenarios.length}
          onClick={() => void world.create(scenario || world.scenarios[0]!.id)}
        >
          Create town
        </button>
        <label>
          AI citizen
          <select
            value={residentId || chosenScenario?.residents[0]?.id || ""}
            onChange={(event) => setResidentId(event.target.value)}
          >
            {chosenScenario?.residents.map((resident) => (
              <option key={resident.id} value={resident.id}>
                {resident.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary"
          disabled={world.busy || !chosenScenario}
          onClick={() => (
            setSelected(residentId || chosenScenario!.residents[0]!.id),
            void world.create(
              chosenScenario!.id,
              true,
              residentId || chosenScenario!.residents[0]?.id,
            )
          )}
        >
          Create AI town
        </button>
      </section>
      {state && citizen ? (
        <>
          <section className="toolbar" aria-label="World controls">
            <strong className="clock">
              {clock(state.simTimeMs, state.rules.dayLengthMs)}
            </strong>
            <span className="pill">
              {world.replaying ? "Recorded history" : state.status}
            </span>
            <button
              disabled={disabled}
              onClick={() =>
                void world.command({
                  kind: "set-status",
                  status: state.status === "running" ? "paused" : "running",
                })
              }
            >
              {state.status === "running" ? "Pause" : "Play"}
            </button>
            <button
              disabled={disabled || state.status === "running"}
              onClick={() =>
                void world.command({ kind: "advance", durationMs: 1000 })
              }
            >
              Step 1s
            </button>
            <button
              disabled={disabled || state.status === "running"}
              onClick={() =>
                void world.command({ kind: "advance", durationMs: 60000 })
              }
            >
              Step 1 min
            </button>
            <label>
              Speed
              <select
                value={state.speed}
                disabled={disabled}
                onChange={(event) =>
                  void world.command({
                    kind: "set-speed",
                    speed: Number(event.target.value),
                  })
                }
              >
                {[0.25, 1, 4, 8, 16].map((speed) => (
                  <option key={speed} value={speed}>
                    {speed}×
                  </option>
                ))}
              </select>
            </label>
          </section>
          <div className="workspace">
            <section className="map-panel">
              <div className="citizen-tabs" role="group" aria-label="Citizens">
                {Object.values(state.citizens).map((item) => (
                  <button
                    className={citizen.id === item.id ? "selected" : ""}
                    key={item.id}
                    onClick={() => setSelected(item.id)}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
              <PhaserGame
                key={state.runId}
                state={state}
                selectedId={citizen.id}
                replaying={world.replaying}
                onTile={(position, shift) => {
                  if (disabled || (!shift && citizen.id === aiCitizen)) return;
                  void world.command(
                    shift
                      ? {
                          kind: "set-blocked",
                          position,
                          blocked: !state.map.blocked.some(
                            (p) => p.x === position.x && p.y === position.y,
                          ),
                        }
                      : {
                          kind: "move",
                          actorId: citizen.id,
                          destination: position,
                        },
                  );
                }}
              />
              <p className="map-hint">
                {citizen.id === aiCitizen
                  ? "AI chooses destinations."
                  : `Click a tile to move ${citizen.name}.`}{" "}
                Shift + click toggles a blocked tile. Use Play or Step to
                advance time.
              </p>
              <div className="replay-controls">
                <label htmlFor="sequence">Recorded event</label>
                <input
                  id="sequence"
                  type="number"
                  min="0"
                  max={world.live?.sequence ?? 0}
                  value={boundary}
                  onChange={(event) => setBoundary(event.target.value)}
                />
                <button
                  disabled={world.busy}
                  onClick={() => void world.seek(Number(boundary))}
                >
                  View history
                </button>
                {world.replaying && (
                  <button onClick={world.returnLive}>Return live</button>
                )}
                <span className="muted">
                  Current #{state.sequence} / latest #{world.live?.sequence}
                </span>
              </div>
            </section>
            <CitizenPanel
              key={`${state.runId}-${citizen.id}`}
              state={state}
              citizen={citizen}
              disabled={disabled || citizen.id === aiCitizen}
              replaying={world.replaying}
              autonomous={citizen.id === aiCitizen}
              agentProvider={agentProvider}
              command={world.command}
            />
          </div>
          <footer>
            Run <code>{state.runId}</code> · Engine time freezes while the
            server is offline.
          </footer>
        </>
      ) : (
        <div className="empty">
          <div className="empty-grid" />
          <h2>Make room for a small town.</h2>
          <p>
            Select a scenario and create your first run. Every action and tile
            step will be recorded.
          </p>
        </div>
      )}
      <p className="message" role="status">
        {world.message}
      </p>
    </main>
  );
}
