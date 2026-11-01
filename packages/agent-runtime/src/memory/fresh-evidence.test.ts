import { test, expect } from "bun:test";
import { createWorld } from "@repo/engine";
import type { AgentStore, MemoryStore, WorldStore } from "@repo/storage";
import { ToolBroker, type WorldPort } from "../broker";
import scenario from "../../../../experiments/scenarios/dev/town.json";
test("a turn can reopen an exact fresh source it actually received, including after outcome recovery", async () => {
  const world = createWorld(scenario, "fresh-evidence"),
    citizenId = Object.keys(world.citizens)[0]!;
  const boundaries: number[] = [];
  const memory = {
    async read(run: string, citizen: string, boundary: number, id: string) {
      expect(run).toBe(world.runId);
      expect(citizen).toBe(citizenId);
      boundaries.push(boundary);
      return id === "fresh" && boundary >= 4
        ? {
            kind: "source",
            source: {
              id,
              citizenId,
              sequence: 4,
              content: "Actual inspection",
            },
          }
        : null;
    },
  } as unknown as MemoryStore;
  const broker = new ToolBroker(
    {} as WorldStore,
    {} as AgentStore,
    {} as WorldPort,
    world,
    { taskId: "t", ownerId: "o", generation: 1, citizenId, version: 1 },
    3,
    memory,
  );
  expect(
    (await broker.execute("memory_read", '{"sourceId":"fresh"}', 0)).status,
  ).toBe("unavailable");
  broker.rememberOutcome({
    status: "accepted",
    data: {
      asOfSequence: 5,
      observations: [
        { id: "fresh", citizenId, eventSequence: 4 },
        { id: "foreign", citizenId: "other", eventSequence: 5 },
      ],
    },
  });
  expect(
    (await broker.execute("memory_read", '{"sourceId":"fresh"}', 1)).status,
  ).toBe("ok");
  expect(
    (await broker.execute("memory_read", '{"sourceId":"foreign"}', 2)).status,
  ).toBe("unavailable");
  expect(boundaries).toEqual([3, 4, 3]);
});
