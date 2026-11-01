import { expect, test } from "bun:test";
import { createWorld, applyCommand, citizenView } from "./index";
import scenario from "../../../experiments/scenarios/dev/town.json";

test("an observer sees the blocking surface of a new wall but not an object behind it", () => {
  const world = createWorld(scenario, "wall-visibility");
  const citizen = Object.values(world.citizens)[0]!;
  const wall = { x: citizen.position.x + 1, y: citizen.position.y };
  const object = Object.values(world.objects)[0]!;
  object.position = { x: citizen.position.x + 2, y: citizen.position.y };
  const result = applyCommand(world, {
    id: "wall",
    action: { kind: "set-blocked", position: wall, blocked: true },
  });
  expect(
    result.observations.some(
      (source) =>
        source.citizenId === citizen.id && source.kind === "terrain.changed",
    ),
  ).toBeTrue();
  expect(
    citizenView(result.state, citizen.id).objects.some(
      (entry) => entry.id === object.id,
    ),
  ).toBeFalse();
});
