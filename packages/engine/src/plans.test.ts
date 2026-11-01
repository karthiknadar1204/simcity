import { test, expect } from "bun:test";
import { createWorld, applyCommand, replay } from "./index";
import scenario from "../../../experiments/scenarios/dev/town.json";

test("personal plans persist as private intentions without changing inventory or controlling another citizen", () => {
  const world = createWorld(scenario, "plan-world");
  const actor = Object.values(world.citizens)[0]!;
  const plan = {
    dayOutline: [{ window: "morning", activity: "Choose useful work" }],
    goal: "Explore a known place",
    currentActivity: "Consider the surroundings",
    knownConstraints: [],
    steps: ["Inspect a place"],
    cursor: 0,
    blocker: null,
    reviewAfterMs: 30000,
    evidenceIds: [],
    briefReason: "A personal motivation suggests exploring.",
  };
  const result = applyCommand(world, {
    id: "plan-a",
    action: { kind: "plan", actorId: actor.id, expectedVersion: 0, plan },
  });
  expect(result.receipt.status).toBe("accepted");
  expect(result.state.citizens[actor.id]!.plan?.version).toBe(1);
  expect(result.state.citizens[actor.id]!.inventory).toEqual(actor.inventory);
  expect(
    result.observations.every((entry) => entry.citizenId === actor.id),
  ).toBeTrue();
  expect(replay(world, result.events)).toEqual(result.state);
  expect(
    applyCommand(result.state, {
      id: "plan-stale",
      action: { kind: "plan", actorId: actor.id, expectedVersion: 0, plan },
    }).receipt.status,
  ).toBe("rejected");
});
