import { test, expect } from "bun:test";
import { createWorld } from "@repo/engine";
import scenario from "../../../experiments/scenarios/dev/town.json";
import { buildContext } from "./context";
test("context contains legitimate places and personal sources without distant stock or another biography", () => {
  const state = createWorld(scenario, "context-proof");
  const [self, other] = Object.values(state.citizens);
  other!.biography = "PRIVATE_OTHER_PROFILE";
  const distant = Object.values(state.objects).find(
    (object) =>
      Math.abs(object.position.x - self!.position.x) +
        Math.abs(object.position.y - self!.position.y) >
      self!.visionRadius,
  )!;
  self!.knownEntityIds.push(distant.id);
  distant.inventory.secret_stock = 987654321;
  const context = buildContext(
    state,
    self!.id,
    [
      {
        id: "future",
        citizenId: self!.id,
        eventSequence: 5,
        simTimeMs: state.simTimeMs,
        kind: "speech",
        content: "FORBIDDEN_FUTURE",
        entityIds: [],
      },
      {
        id: "other",
        citizenId: other!.id,
        eventSequence: 0,
        simTimeMs: state.simTimeMs,
        kind: "speech",
        content: "FORBIDDEN_RECIPIENT",
        entityIds: [],
      },
    ],
    ["self-initiated"],
  );
  const text = JSON.stringify(context);
  expect(text).toContain(distant.id);
  expect(text).not.toContain("987654321");
  expect(text).not.toContain("PRIVATE_OTHER_PROFILE");
  expect(text).not.toContain("FORBIDDEN_FUTURE");
  expect(text).not.toContain("FORBIDDEN_RECIPIENT");
  expect(text).toContain(self!.initialMemories[0]!);
});
