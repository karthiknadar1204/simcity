import type { PlaybackBundle, WorldState, WorldEvent } from "@repo/contracts";
import { applyEvent } from "@repo/engine";
export class Playback {
  private states: WorldState[];
  constructor(readonly bundle: PlaybackBundle) {
    if (
      bundle.version !== 1 ||
      bundle.events.length > 20000 ||
      bundle.checkpoint.state.runId !== bundle.runId
    )
      throw new Error("Invalid playback bundle");
    this.states = [bundle.checkpoint.state];
    for (const event of bundle.events) {
      if (event.sequence > bundle.upperSequence)
        throw new Error("Playback exceeds recorded boundary");
      this.states.push(applyEvent(this.states[this.states.length - 1]!, event));
    }
    if (
      bundle.fromMs < bundle.checkpoint.state.simTimeMs ||
      bundle.toMs < this.bundle.fromMs ||
      bundle.toMs > this.states[this.states.length - 1]!.simTimeMs
    )
      throw new Error("Incomplete recorded interval");
  }
  private index(timeMs: number, sequence?: number) {
    if (
      !Number.isFinite(timeMs) ||
      timeMs < this.bundle.fromMs ||
      timeMs > this.bundle.toMs
    )
      throw new Error("Time is outside the recorded interval");
    let low = 0,
      high = this.states.length;
    while (low < high) {
      const mid = (low + high) >>> 1,
        state = this.states[mid]!;
      if (
        state.simTimeMs <= timeMs &&
        (sequence === undefined || state.sequence <= sequence)
      )
        low = mid + 1;
      else high = mid;
    }
    if (low === 0) throw new Error("Sequence is outside the recorded interval");
    return low - 1;
  }
  stateAt(timeMs: number, sequence?: number): WorldState {
    return this.states[this.index(timeMs, sequence)]!;
  }
  frameAt(timeMs: number, sequence?: number): SceneFrame {
    const index = this.index(timeMs, sequence),
      state = this.states[index]!;
    const actors = Object.values(state.citizens).map((citizen) => {
      const job = citizen.actionId ? state.jobs[citizen.actionId] : null;
      let x = citizen.position.x,
        y = citizen.position.y,
        facing: string = citizen.facing;
      if (sequence === undefined && job?.kind === "move") {
        for (let i = index; i < this.bundle.events.length; i++) {
          const event = this.bundle.events[i]!;
          const nextJob = event.patch.jobs?.[job.id];
          if (event.actorId !== citizen.id) continue;
          if (nextJob && nextJob.status !== "running") break;
          if (
            event.kind === "movement.stepped" &&
            nextJob?.kind === "move" &&
            nextJob.stepIndex === job.stepIndex + 1
          ) {
            const position = event.patch.citizens?.[citizen.id]?.position;
            if (!position) break;
            const start = event.simTimeMs - citizen.moveDurationMs,
              ratio = Math.max(
                0,
                Math.min(1, (timeMs - start) / citizen.moveDurationMs),
              );
            x += (position.x - x) * ratio;
            y += (position.y - y) * ratio;
            facing =
              position.x > citizen.position.x
                ? "right"
                : position.x < citizen.position.x
                  ? "left"
                  : position.y > citizen.position.y
                    ? "down"
                    : "up";
            break;
          }
        }
      }
      const activity =
        job?.kind === "move"
          ? "walk"
          : job?.kind === "work"
            ? job.capability.needs.hunger < 0
              ? "eat"
              : "work"
            : (job?.kind ?? "idle");
      const speech =
        citizen.lastSpeech &&
        citizen.lastSpeech.sequence <= state.sequence &&
        timeMs - citizen.lastSpeech.simTimeMs < 8000
          ? citizen.lastSpeech.text
          : null;
      return {
        id: citizen.id,
        name: citizen.name,
        x,
        y,
        facing,
        activity,
        phase:
          Math.floor(
            timeMs /
              (activity === "walk" ? 100 : activity === "sleep" ? 1000 : 400),
          ) % 4,
        progress:
          job && job.kind !== "move"
            ? Math.max(
                0,
                Math.min(
                  1,
                  (timeMs - job.startedAt) / (job.endsAt - job.startedAt),
                ),
              )
            : 0,
        speech,
      };
    });
    const hour = (timeMs % state.rules.dayLengthMs) / 3600000;
    const night =
      hour < 5 || hour >= 21
        ? 0.62
        : hour < 7
          ? (0.62 * (7 - hour)) / 2
          : hour >= 18
            ? (0.62 * (hour - 18)) / 3
            : 0;
    return { state, timeMs, night, actors };
  }
}
export function snapshotBundle(state: WorldState): PlaybackBundle {
  return {
    version: 1,
    runId: state.runId,
    checkpoint: { state, stateHash: "live-snapshot" },
    events: [],
    fromMs: state.simTimeMs,
    toMs: state.simTimeMs,
    upperSequence: state.sequence,
  };
}
export function intervalBundle(
  before: WorldState,
  after: WorldState,
  events: WorldEvent[],
): PlaybackBundle {
  return {
    version: 1,
    runId: after.runId,
    checkpoint: { state: before, stateHash: "live-verified-events" },
    events,
    fromMs: before.simTimeMs,
    toMs: after.simTimeMs,
    upperSequence: after.sequence,
  };
}
export interface SceneFrame {
  state: WorldState;
  timeMs: number;
  night: number;
  actors: {
    id: string;
    name: string;
    x: number;
    y: number;
    facing: string;
    activity: string;
    phase: number;
    progress: number;
    speech: string | null;
  }[];
}
