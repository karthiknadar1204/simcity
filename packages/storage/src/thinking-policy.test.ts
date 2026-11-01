import { test, expect } from "bun:test";
import { createWorld, applyCommand } from "@repo/engine";
import scenario from "../../../experiments/scenarios/dev/town.json";
import { decisionTriggers, reviewDeadline } from "./thinking-policy";
import { agentPolicy } from "@repo/contracts";

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

test("an idle resident reviews promptly even when its project has a later review", () => {
  const state = createWorld(scenario, "idle-review");
  const self = Object.values(state.citizens)[0]!;
  self.plan = {
    dayOutline: [{ window: "Morning", activity: "Explore" }],
    goal: "Explore",
    currentActivity: "Choose a useful next activity",
    knownConstraints: [],
    steps: ["Choose an action"],
    cursor: 0,
    blocker: null,
    reviewAfterMs: 300000,
    evidenceIds: [],
    briefReason: "I am free to act.",
    version: 1,
    updatedAtMs: state.simTimeMs,
    nextReviewAtMs: state.simTimeMs + 300000,
  };
  expect(reviewDeadline(state, self.id)).toBe(
    state.simTimeMs + agentPolicy.idleReviewMs,
  );
  const moving = applyCommand(state, {
    id: "walk",
    action: {
      kind: "move",
      actorId: self.id,
      destination: { x: self.position.x, y: self.position.y + 3 },
    },
  }).state;
  expect(reviewDeadline(moving, self.id)).toBe(self.plan.nextReviewAtMs);
  self.plan.nextReviewAtMs = state.simTimeMs - 1;
  expect(reviewDeadline(state, self.id)).toBe(
    state.simTimeMs + agentPolicy.idleReviewMs,
  );
});

test("long activities get a needs or personal-clock review without forcing a replacement action", () => {
  const state = createWorld(scenario, "attention-timer-fixture"),
    self = Object.values(state.citizens)[0]!;
  self.needs = { energy: 101, hunger: 699 };
  const waiting = applyCommand(state, {
    id: "wait-for-attention",
    action: { kind: "wait", actorId: self.id, durationMs: 600000 },
  }).state;
  expect(reviewDeadline(waiting, self.id)).toBe(state.simTimeMs + 60000);
  const progressed = applyCommand(waiting, {
    id: "attention-tick",
    action: { kind: "advance", durationMs: 60000 },
  });
  expect(
    decisionTriggers(waiting, progressed.state, progressed.events, self.id),
  ).toContain("scheduled-attention");
  expect(progressed.state.citizens[self.id]!.actionId).toBe(
    waiting.citizens[self.id]!.actionId,
  );
  const evening = createWorld(
      {
        ...scenario,
        startTimeMs: 21 * 3600000 + 59 * 60000,
        objects: scenario.objects.map((o) => ({
          ...o,
          ...(o.regeneration
            ? { regeneration: { ...o.regeneration, nextAt: 22 * 3600000 } }
            : {}),
        })),
      },
      "rhythm-fixture",
    ),
    resident = Object.values(evening.citizens)[0]!;
  resident.dailyRhythm = { sleepMinute: 1320, wakeMinute: 420 };
  const job = applyCommand(evening, {
    id: "long-wait",
    action: { kind: "wait", actorId: resident.id, durationMs: 3600000 },
  }).state;
  expect(reviewDeadline(job, resident.id)).toBe(22 * 3600000);
});
