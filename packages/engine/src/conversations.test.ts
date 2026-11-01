import { test, expect } from "bun:test";
import {
  parseScenario,
  type Action,
  type WorldState,
  conversationPolicy,
} from "@repo/contracts";
import { createWorld, applyCommand, replay } from "./index";
import scenario from "../../../experiments/scenarios/dev/town.json";
function town() {
  const input = parseScenario(scenario);
  input.citizens.forEach(
    (citizen, index) => (citizen.position = { x: 3 + index, y: 4 }),
  );
  return createWorld(input, "social-fixture");
}
const command = (state: WorldState, action: Action) =>
  applyCommand(state, { id: crypto.randomUUID(), action });
test("conversation invitations claim participants, enforce actual speakers and versions, and release on refusal", () => {
  let state = town();
  const [a, b, c] = Object.keys(state.citizens);
  const start = command(state, {
    kind: "conversation-start",
    actorId: a!,
    targetId: b!,
    text: "Hello. How is your morning?",
  });
  expect(start.receipt.status).toBe("accepted");
  state = start.state;
  const conversation = Object.values(state.conversations!)[0]!;
  expect(conversation.status).toBe("invited");
  expect(conversation.nextSpeakerId).toBe(b!);
  expect(conversation.turns[0]!.speakerId).toBe(a!);
  expect(
    command(state, {
      kind: "conversation-start",
      actorId: c!,
      targetId: b!,
      text: "Another conversation",
    }).receipt.status,
  ).toBe("rejected");
  expect(
    command(state, {
      kind: "conversation-reply",
      actorId: a!,
      conversationId: conversation.id,
      expectedVersion: 1,
      text: "I cannot speak for you",
      end: false,
    }).receipt.status,
  ).toBe("rejected");
  const reply = command(state, {
    kind: "conversation-reply",
    actorId: b!,
    conversationId: conversation.id,
    expectedVersion: 1,
    text: "I am doing well.",
    end: false,
  });
  state = reply.state;
  expect(state.conversations![conversation.id]!.version).toBe(2);
  expect(
    command(state, {
      kind: "conversation-end",
      actorId: a!,
      conversationId: conversation.id,
      expectedVersion: 1,
      reason: "stale",
    }).receipt.status,
  ).toBe("rejected");
  const ended = command(state, {
    kind: "conversation-end",
    actorId: b!,
    conversationId: conversation.id,
    expectedVersion: 2,
    reason: "I need to return to my work",
  });
  expect(ended.state.conversations![conversation.id]!.status).toBe("ended");
  expect(replay(start.state, [...reply.events, ...ended.events])).toEqual(
    ended.state,
  );
});
test("conversations time out and cap turns without inventing participant replies", () => {
  let state = town();
  const [a, b] = Object.keys(state.citizens);
  state = command(state, {
    kind: "conversation-start",
    actorId: a!,
    targetId: b!,
    text: "Hello",
  }).state;
  const id = Object.keys(state.conversations!)[0]!;
  const timed = command(state, {
    kind: "advance",
    durationMs: conversationPolicy.timeoutMs,
  });
  expect(timed.state.conversations![id]!.status).toBe("ended");
  expect(timed.state.conversations![id]!.turns).toHaveLength(1);
  for (let index = 1; index < conversationPolicy.maxTurns; index++) {
    const current = state.conversations![id]!;
    state = command(state, {
      kind: "conversation-reply",
      actorId: current.nextSpeakerId!,
      conversationId: id,
      expectedVersion: current.version,
      text: `Actual turn ${index}`,
      end: false,
    }).state;
  }
  expect(state.conversations![id]!.status).toBe("ended");
  expect(state.conversations![id]!.turns).toHaveLength(
    conversationPolicy.maxTurns,
  );
});
test("ordinary speech cannot wake a sleeper but a nearby explicit urgent alert interrupts sleep with real evidence", () => {
  let state = town();
  const [a, b] = Object.keys(state.citizens);
  const bed = Object.values(state.objects).find(
    (object) => object.ownerId === a && object.tags.includes("bed"),
  )!;
  state = command(state, {
    kind: "sleep",
    actorId: a!,
    targetId: bed.id,
    durationMs: 60000,
  }).state;
  const job = state.citizens[a!]!.actionId!;
  const ordinary = command(state, {
    kind: "say",
    actorId: b!,
    text: "A normal greeting",
  });
  expect(ordinary.state.citizens[a!]!.actionId).toBe(job);
  expect(
    ordinary.observations.some((source) => source.citizenId === a),
  ).toBeFalse();
  const urgent = command(state, {
    kind: "alert",
    actorId: b!,
    targetId: a!,
    text: "Please wake up, I need urgent help nearby.",
  });
  expect(urgent.receipt.status).toBe("accepted");
  expect(urgent.state.jobs[job]!.status).toBe("interrupted");
  expect(urgent.state.citizens[a!]!.actionId).toBeNull();
  expect(
    urgent.observations.some(
      (source) => source.citizenId === a && source.kind === "alert.delivered",
    ),
  ).toBeTrue();
});
