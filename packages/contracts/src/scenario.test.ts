import { expect, test } from "bun:test";
import { parseScenario, parseCommand } from "./index";
import scenario from "../../../experiments/scenarios/dev/town.json";

test("loads a scenario from data with valid citizen knowledge and locations", () => {
  const loaded = parseScenario(scenario);
  expect(loaded.citizens).toHaveLength(3);
  expect(loaded.citizens[0]?.initialMemories.length).toBeGreaterThan(0);
});

test("accepts typed commands and rejects negative resource transfers", () => {
  expect(
    parseCommand({
      id: "command-1",
      action: {
        kind: "transfer",
        actorId: "actor-a",
        targetId: "actor-b",
        resource: "food",
        amount: 2,
      },
    }).action.kind,
  ).toBe("transfer");
  expect(() =>
    parseCommand({
      id: "command-2",
      action: {
        kind: "transfer",
        actorId: "actor-a",
        targetId: "actor-b",
        resource: "food",
        amount: -1,
      },
    }),
  ).toThrow();
});

test("rejects invalid references instead of granting a citizen invented knowledge", () => {
  const invalid = structuredClone(scenario);
  invalid.citizens[0]!.knownEntityIds.push("unknown-person");
  expect(() => parseScenario(invalid)).toThrow(
    "Unknown initial knowledge reference",
  );
});
