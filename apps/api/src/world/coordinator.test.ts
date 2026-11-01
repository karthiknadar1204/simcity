import { test, expect } from "bun:test";
import { applyCommand, createWorld } from "@repo/engine";
import { runtimePolicy, type Command } from "@repo/contracts";
import type { WorldStore } from "@repo/storage";
import scenario from "../../../../experiments/scenarios/dev/town.json";
import { Coordinator } from "./coordinator";

test("a clock tick queued behind Pause cannot advance the paused world", async () => {
  let state = createWorld(scenario, "pause-race-fixture");
  state.status = "running";
  const before = state.simTimeMs;
  let releasePause!: () => void;
  let enteredPause!: () => void;
  const pauseBarrier = new Promise<void>((resolve) => {
    releasePause = resolve;
  });
  const pauseEntered = new Promise<void>((resolve) => {
    enteredPause = resolve;
  });
  const store = {
    async claim() {
      return 1;
    },
    async recoverableRuns() {
      return [{ id: state.runId }];
    },
    async load() {
      return { state };
    },
    async execute(
      _id: string,
      _owner: string,
      _generation: number,
      command: Command,
    ) {
      if (
        command.action.kind === "set-status" &&
        command.action.status === "paused"
      ) {
        enteredPause();
        await pauseBarrier;
      }
      const result = applyCommand(state, command);
      state = result.state;
      return result;
    },
    async release() {},
  };
  const coordinator = new Coordinator(store as unknown as WorldStore);
  try {
    await coordinator.start();
    const pausing = coordinator.execute(state.runId, {
      id: "pause-world",
      action: { kind: "set-status", status: "paused" },
    });
    await pauseEntered;
    // Let the real interval enqueue a tick while the prior write is still pending.
    await Bun.sleep(runtimePolicy.tickIntervalMs + 50);
    releasePause();
    expect((await pausing).receipt.status).toBe("accepted");
    await coordinator.execute(state.runId, {
      id: "drain-prior-writes",
      action: { kind: "set-speed", speed: 1 },
    });
    await coordinator.stop();
    expect(state).toMatchObject({ status: "paused", simTimeMs: before });
  } finally {
    releasePause();
    await coordinator.stop();
  }
});
