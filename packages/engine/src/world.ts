import { parseScenario, type WorldState } from "@repo/contracts";

export function createWorld(input: unknown, runId: string): WorldState {
  const scenario = parseScenario(input);
  return {
    schemaVersion: 1,
    runId,
    scenarioId: scenario.id,
    simTimeMs: scenario.startTimeMs,
    sequence: 0,
    status: "paused",
    speed: scenario.speed,
    rngState: scenario.seed,
    map: scenario.map,
    rules: scenario.rules,
    citizens: Object.fromEntries(scenario.citizens.map((c) => [c.id, c])),
    objects: Object.fromEntries(scenario.objects.map((o) => [o.id, o])),
    jobs: {},
  };
}
