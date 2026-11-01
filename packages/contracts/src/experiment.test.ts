import { expect, test } from "bun:test";
import { parseScenario } from "./index";
import development from "../../../experiments/scenarios/dev/town.json";
import heldOut from "../../../experiments/scenarios/held-out/unfamiliar-town.json";
import developmentCases from "../../../experiments/cases/dev/memory.json";
import heldOutCases from "../../../experiments/cases/held-out/memory.json";

for (const [scenarioInput, pack] of [
  [development, developmentCases],
  [heldOut, heldOutCases],
] as const) {
  test(`${pack.id}: expected sources belong to the reader and precede the query boundary`, () => {
    const scenario = parseScenario(scenarioInput);
    const citizens = new Set(scenario.citizens.map((citizen) => citizen.id));
    expect(pack.scenarioId).toBe(scenario.id);
    expect(pack.cases).toHaveLength(6);
    for (const fixture of pack.cases) {
      expect(citizens.has(fixture.probe.citizenId)).toBeTrue();
      const permitted = new Set(
        fixture.evidence
          .filter(
            (source) =>
              source.recipientIds.includes(fixture.probe.citizenId) &&
              source.simTimeMs <= fixture.probe.asOfSimTimeMs,
          )
          .map((source) => source.id),
      );
      for (const source of fixture.requiredSourceIds)
        expect(permitted.has(source)).toBeTrue();
      if ("forbiddenSourceIds" in fixture.expected)
        for (const source of fixture.expected.forbiddenSourceIds ?? [])
          expect(permitted.has(source)).toBeFalse();
      for (const source of fixture.evidence) {
        expect(citizens.has(source.speakerId)).toBeTrue();
        for (const recipient of source.recipientIds)
          expect(citizens.has(recipient)).toBeTrue();
      }
    }
  });
}
