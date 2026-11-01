import { test, expect } from "bun:test";
import { createWorld, applyCommand } from "@repo/engine";
import { contentHash, type PlaybackBundle } from "@repo/contracts";
import scenario from "../../../experiments/scenarios/dev/town.json";
import { Playback } from "./index";
test("timestamp playback interpolates only committed walking, preserves exact state, and uses simulation time for animation", async () => {
  const initial = createWorld(scenario, "playback-fixture"),
    citizen = Object.values(initial.citizens)[0]!;
  const move = applyCommand(initial, {
    id: "walk",
    action: {
      kind: "move",
      actorId: citizen.id,
      destination: { x: citizen.position.x + 1, y: citizen.position.y },
    },
  });
  const advance = applyCommand(move.state, {
    id: "tick",
    action: { kind: "advance", durationMs: 400 },
  });
  const bundle: PlaybackBundle = {
    version: 1,
    runId: initial.runId,
    checkpoint: { state: initial, stateHash: await contentHash(initial) },
    events: [...move.events, ...advance.events],
    fromMs: initial.simTimeMs,
    toMs: advance.state.simTimeMs,
    upperSequence: advance.state.sequence,
  };
  const playback = new Playback(bundle),
    middle = initial.simTimeMs + 200;
  expect(playback.stateAt(middle).citizens[citizen.id]!.position).toEqual(
    citizen.position,
  );
  const actor = playback
    .frameAt(middle)
    .actors.find((item) => item.id === citizen.id)!;
  expect(actor.x).toBe(citizen.position.x + 0.5);
  expect(actor.activity).toBe("walk");
  expect(playback.frameAt(middle)).toEqual(playback.frameAt(middle));
  expect(await contentHash(playback.stateAt(advance.state.simTimeMs))).toBe(
    await contentHash(advance.state),
  );
  expect(await contentHash(initial)).toBe(bundle.checkpoint.stateHash);
  expect(() => playback.frameAt(advance.state.simTimeMs + 1)).toThrow(
    "interval",
  );
});
test("an interrupted route cannot animate an unrecorded tile, and old sequence views exclude later speech", async () => {
  let state = createWorld(scenario, "interrupted-playback");
  const checkpoint = state,
    citizen = Object.values(state.citizens)[0]!,
    neighbor = Object.values(state.citizens)[1]!;
  neighbor.position = { x: 4, y: 4 };
  const move = applyCommand(state, {
    id: "move",
    action: { kind: "move", actorId: citizen.id, destination: { x: 3, y: 5 } },
  });
  state = move.state;
  const wall = applyCommand(state, {
    id: "wall",
    action: { kind: "set-blocked", position: { x: 3, y: 5 }, blocked: true },
  });
  state = wall.state;
  const tick = applyCommand(state, {
    id: "tick",
    action: { kind: "advance", durationMs: 400 },
  });
  state = tick.state;
  const say = applyCommand(state, {
    id: "say",
    action: { kind: "say", actorId: neighbor.id, text: "Only known later" },
  });
  const playback = new Playback({
    version: 1,
    runId: state.runId,
    checkpoint: { state: checkpoint, stateHash: await contentHash(checkpoint) },
    events: [...move.events, ...wall.events, ...tick.events, ...say.events],
    fromMs: checkpoint.simTimeMs,
    toMs: say.state.simTimeMs,
    upperSequence: say.state.sequence,
  });
  expect(
    playback
      .frameAt(checkpoint.simTimeMs + 200)
      .actors.find((item) => item.id === citizen.id)!.y,
  ).toBe(4);
  expect(
    playback
      .frameAt(state.simTimeMs, state.sequence)
      .actors.find((item) => item.id === neighbor.id)!.speech,
  ).toBeNull();
  expect(
    playback
      .frameAt(state.simTimeMs)
      .actors.find((item) => item.id === neighbor.id)!.speech,
  ).toContain("Only known later");
});
