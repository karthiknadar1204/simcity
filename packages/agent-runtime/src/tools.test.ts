import { test, expect } from "bun:test";
import { createWorld } from "@repo/engine";
import { parseTool, actionFor } from "./tools";
import scenario from "../../../experiments/scenarios/dev/town.json";

test("citizen tools cannot select another actor, invoke operator controls, or resolve unknown places", () => {
  expect(() => parseTool("set-status", '{"status":"running"}')).toThrow(
    "Unknown citizen tool",
  );
  expect(() =>
    parseTool("time_wait", '{"durationMs":1000,"actorId":"another-resident"}'),
  ).toThrow();
  const world = createWorld(scenario, "tool-scopes");
  const self = Object.values(world.citizens)[0]!;
  const hidden = Object.values(world.objects).find(
    (object) =>
      Math.abs(object.position.x - self.position.x) +
        Math.abs(object.position.y - self.position.y) >
      self.visionRadius,
  )!;
  self.knownEntityIds = [self.id];
  expect(() =>
    actionFor(
      "world_move",
      { targetId: hidden.id, x: null, y: null },
      world,
      self.id,
    ),
  ).toThrow("not a known place");
  expect(actionFor("time_wait", { durationMs: 1000 }, world, self.id)).toEqual({
    kind: "wait",
    actorId: self.id,
    durationMs: 1000,
  });
});

test("local movement targets cannot disclose tiles hidden behind a wall", () => {
  const world = createWorld(scenario, "occluded-tool-scope");
  const self = Object.values(world.citizens)[0]!;
  self.position = { x: 3, y: 4 };
  world.map.blocked = [{ x: 4, y: 4 }];
  expect(() =>
    actionFor("world_move", { targetId: null, x: 5, y: 4 }, world, self.id),
  ).toThrow("not a known place");
  expect(
    actionFor("world_move", { targetId: null, x: 3, y: 5 }, world, self.id),
  ).toEqual({
    kind: "move",
    actorId: self.id,
    destination: { x: 3, y: 5 },
  });
});
test("a chosen public place resolves to a reachable interaction tile while beds keep their exact tile requirement", () => {
  const world = createWorld(scenario, "approach-fixture"),
    [self, other] = Object.values(world.citizens),
    place = world.objects.storehouse!;
  other!.position = { ...place.position };
  const action = actionFor(
    "world_move",
    { targetId: place.id, x: null, y: null },
    world,
    self!.id,
  );
  expect(action?.kind).toBe("move");
  if (action?.kind !== "move") throw new Error("Expected a walk");
  expect(
    Math.abs(action.destination.x - place.position.x) +
      Math.abs(action.destination.y - place.position.y),
  ).toBe(1);
  expect(action.destination).not.toEqual(other!.position);
  const bed = Object.values(world.objects).find(
    (object) => object.ownerId === self!.id && object.tags.includes("bed"),
  )!;
  expect(
    actionFor(
      "world_move",
      { targetId: bed.id, x: null, y: null },
      world,
      self!.id,
    ),
  ).toEqual({ kind: "move", actorId: self!.id, destination: bed.position });
});
