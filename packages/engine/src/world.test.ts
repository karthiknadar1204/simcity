import { expect, test } from "bun:test";
import { createWorld } from "./index";
import scenario from "../../../experiments/scenarios/dev/town.json";
import unfamiliar from "../../../experiments/scenarios/held-out/unfamiliar-town.json";

test("initializes independent paused worlds from arbitrary valid scenario data", () => {
  const world = createWorld(scenario, "world-a");
  const other = createWorld(unfamiliar, "world-b");
  expect(world.status).toBe("paused");
  expect(world.simTimeMs).toBe(scenario.startTimeMs);
  expect(Object.keys(other.citizens)).not.toContain("mira");
  world.citizens.mira!.inventory.food = 99;
  expect(scenario.citizens[0]!.inventory.food).toBe(2);
});
