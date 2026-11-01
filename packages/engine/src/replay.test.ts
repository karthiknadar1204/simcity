import { expect, test } from "bun:test";
import { contentHash, type WorldEvent } from "@repo/contracts";
import { applyCommand, citizenView, createWorld, replay } from "./index";
import scenario from "../../../experiments/scenarios/dev/town.json";
import unfamiliar from "../../../experiments/scenarios/held-out/unfamiliar-town.json";

test("checkpoint plus ordered events reconstructs the exact state including random progression", async () => {
  const initial = createWorld(unfamiliar, "replay-world");
  const events: WorldEvent[] = [];
  let world = initial;
  const actor = Object.values(world.citizens)[0]!;
  for (const command of [
    {
      id: "walk",
      action: {
        kind: "move" as const,
        actorId: actor.id,
        destination: { x: actor.position.x + 2, y: actor.position.y },
      },
    },
    { id: "tick", action: { kind: "advance" as const, durationMs: 60000 } },
    {
      id: "pause",
      action: { kind: "set-status" as const, status: "paused" as const },
    },
  ]) {
    const result = applyCommand(world, command);
    expect(result.receipt.status).toBe("accepted");
    world = result.state;
    events.push(...result.events);
  }
  const middle = Math.floor(events.length / 2);
  const checkpoint = replay(initial, events.slice(0, middle));
  expect(
    await contentHash(
      replay(JSON.parse(JSON.stringify(checkpoint)), events.slice(middle)),
    ),
  ).toBe(await contentHash(world));
  expect(world.rngState).not.toBe(initial.rngState);
  expect(() => replay(initial, events.slice(1))).toThrow("sequence gap");
});

test("views omit other biographies and distant inventories, and walls occlude sight", () => {
  const world = createWorld(scenario, "view-world");
  const [first, second] = Object.values(world.citizens);
  first!.position = { x: 11, y: 4 };
  second!.position = { x: 13, y: 4 };
  expect(
    citizenView(world, first!.id).citizens.some((c) => c.id === second!.id),
  ).toBeFalse();
  second!.position = { x: 10, y: 4 };
  const view = citizenView(world, first!.id);
  expect(view.citizens.find((c) => c.id === second!.id)).not.toHaveProperty(
    "biography",
  );
  expect(view.citizens.find((c) => c.id === second!.id)).not.toHaveProperty(
    "initialMemories",
  );
  expect(view.objects.find((o) => o.id === "storehouse")).not.toHaveProperty(
    "inventory",
  );
});

test("invalid transfers leave inventories unchanged and command ID reuse is rejected", () => {
  const world = createWorld(scenario, "invalid-world");
  const [a, b] = Object.values(world.citizens);
  b!.position = { x: a!.position.x + 1, y: a!.position.y };
  const result = applyCommand(world, {
    id: "too-much",
    action: {
      kind: "transfer",
      actorId: a!.id,
      targetId: b!.id,
      resource: "food",
      amount: 999,
    },
  });
  expect(result.receipt.status).toBe("rejected");
  expect(result.state.citizens).toEqual(world.citizens);
  expect(() =>
    applyCommand(
      result.state,
      {
        id: "too-much",
        action: { kind: "wait", actorId: a!.id, durationMs: 1000 },
      },
      result.receipt,
    ),
  ).toThrow("different parameters");
});

test("regeneration never destroys stock above its replenishment ceiling", () => {
  const world = createWorld(scenario, "growth-world");
  const target = Object.values(world.objects).find((o) => o.regeneration)!;
  target.regeneration!.probability = 1;
  const resource = target.regeneration!.resource;
  target.inventory[resource] = target.regeneration!.maximum + 1;
  const result = applyCommand(world, {
    id: "grow",
    action: { kind: "advance", durationMs: 60000 },
  });
  expect(result.state.objects[target.id]!.inventory[resource]).toBe(
    target.inventory[resource],
  );
});
