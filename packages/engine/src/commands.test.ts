import { expect, test } from "bun:test";
import { applyCommand, createWorld } from "./index";
import scenario from "../../../experiments/scenarios/dev/town.json";

test("transfers conserve resources and retries return the prior receipt without another effect", () => {
  const world = createWorld(scenario, "transfer-world");
  const ids = Object.keys(world.citizens);
  const sender = world.citizens[ids[0]!]!;
  const recipient = world.citizens[ids[1]!]!;
  recipient.position = { x: sender.position.x + 1, y: sender.position.y };
  const command = {
    id: "transfer-1",
    action: {
      kind: "transfer" as const,
      actorId: sender.id,
      targetId: recipient.id,
      resource: "food",
      amount: 1,
    },
  };
  const result = applyCommand(world, command);
  expect(result.receipt.status).toBe("accepted");
  expect(result.state.citizens[sender.id]!.inventory.food).toBe(1);
  expect(result.state.citizens[recipient.id]!.inventory.food).toBe(3);
  expect(sender.inventory.food).toBe(2);
  const retry = applyCommand(result.state, command, result.receipt);
  expect(retry.events).toHaveLength(0);
  expect(retry.state).toEqual(result.state);
});

test("directed speech reaches permitted nearby listeners without exposing it to bystanders", () => {
  const world = createWorld(scenario, "speech-world");
  const [speaker, listener, bystander] = Object.values(world.citizens);
  listener!.position = { x: speaker!.position.x + 1, y: speaker!.position.y };
  bystander!.position = { x: speaker!.position.x, y: speaker!.position.y + 1 };
  const result = applyCommand(world, {
    id: "speech-1",
    action: {
      kind: "say",
      actorId: speaker!.id,
      text: "A private arrangement",
      audienceIds: [listener!.id],
    },
  });
  expect(result.receipt.status).toBe("accepted");
  const heard = result.observations
    .filter((o) => o.kind === "speech.delivered")
    .map((o) => o.citizenId)
    .sort();
  expect(heard).toEqual([speaker!.id, listener!.id].sort());
  expect(
    result.observations.some((o) => o.citizenId === bystander!.id),
  ).toBeFalse();
});

test("sleep restores energy on the simulation clock and resumes from a serialized in-progress job", () => {
  let world = createWorld(scenario, "sleep-world");
  const actor = Object.values(world.citizens)[0]!;
  const bed = Object.values(world.objects).find(
    (o) => o.tags.includes("bed") && o.ownerId === actor.id,
  )!;
  actor.position = bed.position;
  actor.needs.energy = 100;
  const interval = world.rules.metabolismIntervalMs ?? 60000;
  const result = applyCommand(world, {
    id: "sleep-1",
    action: {
      kind: "sleep",
      actorId: actor.id,
      targetId: bed.id,
      durationMs: interval * 2,
    },
  });
  expect(result.receipt.status).toBe("accepted");
  world = applyCommand(result.state, {
    id: "sleep-tick-1",
    action: { kind: "advance", durationMs: interval },
  }).state;
  expect(world.citizens[actor.id]!.needs.energy).toBeGreaterThan(100);
  const restored = JSON.parse(JSON.stringify(world));
  const finished = applyCommand(restored, {
    id: "sleep-tick-2",
    action: { kind: "advance", durationMs: interval },
  });
  expect(finished.state.citizens[actor.id]!.actionId).toBeNull();
  expect(finished.state.simTimeMs).toBe(scenario.startTimeMs + interval * 2);
});

test("competing work reserves finite stock and cancellation or failed completion refunds it", () => {
  let world = createWorld(scenario, "work-world");
  const actors = Object.values(world.citizens);
  const target = Object.values(world.objects).find((o) =>
    o.capabilities.some((c) => Object.keys(c.actorOutputs).length),
  )!;
  const capability = target.capabilities.find(
    (c) => Object.keys(c.actorOutputs).length,
  )!;
  const resource = Object.keys(capability.objectInputs)[0]!;
  target.inventory[resource] = 3;
  actors[0]!.position = { x: target.position.x - 1, y: target.position.y };
  actors[1]!.position = { x: target.position.x, y: target.position.y - 1 };
  actors[0]!.inventory = {};
  actors[1]!.inventory = {};
  const work = (id: string, actorId: string) => ({
    id,
    action: {
      kind: "interact" as const,
      actorId,
      targetId: target.id,
      capabilityId: capability.id,
      units: 2,
    },
  });
  let result = applyCommand(world, work("work-1", actors[0]!.id));
  expect(result.receipt.status).toBe("accepted");
  expect(result.state.objects[target.id]!.inventory[resource]).toBe(1);
  result = applyCommand(result.state, work("work-2", actors[1]!.id));
  expect(result.receipt.status).toBe("rejected");
  world = applyCommand(result.state, {
    id: "cancel-1",
    action: { kind: "cancel", actorId: actors[0]!.id },
  }).state;
  expect(world.objects[target.id]!.inventory[resource]).toBe(3);
  world = applyCommand(world, work("work-3", actors[0]!.id)).state;
  world.citizens[actors[0]!.id]!.capacity = 1;
  result = applyCommand(world, {
    id: "work-tick",
    action: { kind: "advance", durationMs: capability.durationMs * 2 },
  });
  expect(result.state.objects[target.id]!.inventory[resource]).toBe(3);
  expect(result.state.citizens[actors[0]!.id]!.inventory[resource] ?? 0).toBe(
    0,
  );
  expect(
    Object.values(result.state.jobs).filter((j) => j.status === "failed"),
  ).toHaveLength(1);
});

test("walking advances tile by tile and interrupts when the next tile becomes blocked", () => {
  let world = createWorld(scenario, "walking-world");
  const id = Object.keys(world.citizens)[0]!;
  const start = world.citizens[id]!.position;
  let result = applyCommand(world, {
    id: "move-1",
    action: {
      kind: "move",
      actorId: id,
      destination: { x: start.x + 3, y: start.y },
    },
  });
  expect(result.receipt.status).toBe("accepted");
  world = applyCommand(result.state, {
    id: "tick-1",
    action: { kind: "advance", durationMs: 400 },
  }).state;
  expect(world.citizens[id]!.position.x).toBe(start.x + 1);
  world = applyCommand(world, {
    id: "block-1",
    action: {
      kind: "set-blocked",
      position: { x: start.x + 2, y: start.y },
      blocked: true,
    },
  }).state;
  result = applyCommand(world, {
    id: "tick-2",
    action: { kind: "advance", durationMs: 400 },
  });
  expect(result.state.citizens[id]!.position.x).toBe(start.x + 1);
  expect(Object.values(result.state.jobs)[0]?.status).toBe("interrupted");
});
