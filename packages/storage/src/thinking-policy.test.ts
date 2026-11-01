import { test, expect } from "bun:test";
import { createWorld, applyCommand } from "@repo/engine";
import scenario from "../../../experiments/scenarios/dev/town.json";
import { decisionTriggers } from "./thinking-policy";

test("thinking wakes on a delivered message but not on each clock or walking frame", () => {
  const world = createWorld(scenario, "triggers");
  const [actor, other] = Object.values(world.citizens);
  other!.position = { x: actor!.position.x + 1, y: actor!.position.y };
  const speech = applyCommand(world, {
    id: "message",
    action: {
      kind: "say",
      actorId: other!.id,
      audienceIds: [actor!.id],
      text: "The route has changed.",
    },
  });
  expect(
    decisionTriggers(world, speech.state, speech.events, actor!.id),
  ).toContain("message");
  const tick = applyCommand(world, {
    id: "tick",
    action: { kind: "advance", durationMs: 500 },
  });
  expect(decisionTriggers(world, tick.state, tick.events, actor!.id)).toEqual(
    [],
  );
  const move = applyCommand(world, {
    id: "move",
    action: {
      kind: "move",
      actorId: actor!.id,
      destination: { x: actor!.position.x, y: actor!.position.y + 3 },
    },
  });
  const step = applyCommand(move.state, {
    id: "step",
    action: { kind: "advance", durationMs: 400 },
  });
  expect(
    decisionTriggers(move.state, step.state, step.events, actor!.id),
  ).not.toContain("review");
});
