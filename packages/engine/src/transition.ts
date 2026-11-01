import type {
  StatePatch,
  WorldEvent,
  WorldState,
  Observation,
  Point,
} from "@repo/contracts";
import { perceive } from "./perception";

export class RuleError extends Error {}
export function requireRule(
  condition: unknown,
  reason: string,
): asserts condition {
  if (!condition) throw new RuleError(reason);
}

export function applyEvent(state: WorldState, event: WorldEvent): WorldState {
  requireRule(event.sequence === state.sequence + 1, "Event sequence gap.");
  requireRule(
    event.simTimeMs >= state.simTimeMs,
    "Event time moved backwards.",
  );
  const patch = structuredClone(event.patch);
  return {
    ...state,
    ...patch,
    citizens: { ...state.citizens, ...patch.citizens },
    objects: { ...state.objects, ...patch.objects },
    jobs: { ...state.jobs, ...patch.jobs },
    ...(state.conversations || patch.conversations
      ? { conversations: { ...state.conversations, ...patch.conversations } }
      : {}),
    sequence: event.sequence,
  };
}

export function replay(checkpoint: WorldState, events: WorldEvent[]) {
  return events.reduce(applyEvent, structuredClone(checkpoint));
}

export class WorldTransition {
  state: WorldState;
  events: WorldEvent[] = [];
  observations: Observation[] = [];

  constructor(
    state: WorldState,
    readonly causeId: string,
  ) {
    this.state = structuredClone(state);
  }

  emit(
    kind: string,
    description: string,
    patch: StatePatch = {},
    details: {
      actorId?: string;
      position?: Point;
      audienceIds?: string[];
    } = {},
  ) {
    requireRule(
      this.events.length < this.state.rules.maxEventsPerTransition,
      "Transition event limit exceeded.",
    );
    const event: WorldEvent = {
      sequence: this.state.sequence + 1,
      simTimeMs: patch.simTimeMs ?? this.state.simTimeMs,
      kind,
      description,
      patch: structuredClone(patch),
      causeId: this.causeId,
      actorId: details.actorId ?? null,
      position: details.position ?? null,
      ...(details.audienceIds ? { audienceIds: details.audienceIds } : {}),
    };
    this.state = applyEvent(this.state, event);
    this.events.push(event);
    this.observations.push(...perceive(this.state, event));
  }
}
