import {
  agentPolicy,
  activeConversation,
  type WorldEvent,
  type WorldState,
} from "@repo/contracts";
import { citizenView, applyEvent, perceive } from "@repo/engine";

export function reviewDeadline(state: WorldState, citizenId: string) {
  const citizen = state.citizens[citizenId]!;
  const fallback = state.simTimeMs + agentPolicy.idleReviewMs;
  const requested = citizen.plan?.nextReviewAtMs ?? fallback;
  const deadline = requested > state.simTimeMs ? requested : fallback;
  const job = citizen.actionId ? state.jobs[citizen.actionId] : null;
  const conversation = activeConversation(state, citizenId);
  if (conversation && conversation.nextSpeakerId !== citizenId)
    return conversation.expiresAtMs;
  if (job && job.kind !== "move") return job.endsAt;
  return job?.status === "running" ? deadline : Math.min(deadline, fallback);
}

export function decisionTriggers(
  before: WorldState,
  after: WorldState,
  events: WorldEvent[],
  citizenId: string,
): string[] {
  if (before.sequence === after.sequence) return [];
  const reasons = new Set<string>();
  let current = before;
  for (const event of events) {
    const next = applyEvent(current, event);
    const received = perceive(next, event).some(
      (observation) => observation.citizenId === citizenId,
    );
    if (received) {
      if (event.kind === "speech.delivered" && event.actorId !== citizenId)
        reasons.add("message");
      if (event.kind === "alert.delivered") reasons.add("urgent-message");
      if (event.kind === "conversation.ended")
        reasons.add("conversation-ended");
      if (
        ["action.completed", "action.failed", "action.interrupted"].includes(
          event.kind,
        ) &&
        event.actorId === citizenId
      )
        reasons.add("action-result");
      if (
        event.kind === "terrain.changed" ||
        (["resources.transferred", "work.completed"].includes(event.kind) &&
          event.actorId !== citizenId)
      )
        reasons.add("surroundings");
    }
    if (event.kind === "movement.stepped") {
      const oldVisible = new Set(
        citizenView(current, citizenId).citizens.map((citizen) => citizen.id),
      );
      if (
        citizenView(next, citizenId).citizens.some(
          (citizen) => !oldVisible.has(citizen.id),
        )
      )
        reasons.add("encounter");
    }
    current = next;
  }
  return [...reasons];
}
