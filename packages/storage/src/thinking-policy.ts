import {
  agentPolicy,
  activeConversation,
  type WorldEvent,
  type WorldState,
} from "@repo/contracts";
import { citizenView, applyEvent, perceive } from "@repo/engine";

export function attentionDeadline(state: WorldState, citizenId: string) {
  const self = state.citizens[citizenId]!,
    now = state.simTimeMs,
    rules = state.rules,
    times: number[] = [];
  for (const minute of self.dailyRhythm
    ? [self.dailyRhythm.sleepMinute, self.dailyRhythm.wakeMinute]
    : []) {
    const offset = minute * 60000;
    if (offset < rules.dayLengthMs) {
      let time =
        Math.floor(now / rules.dayLengthMs) * rules.dayLengthMs + offset;
      if (time <= now) time += rules.dayLengthMs;
      times.push(time);
    }
  }
  const tick = Math.floor(now / rules.metabolismIntervalMs) + 1;
  for (const boundary of [agentPolicy.attentionEnergy, 0])
    if (self.needs.energy > boundary && rules.energyPerTick > 0)
      times.push(
        (tick +
          Math.ceil((self.needs.energy - boundary) / rules.energyPerTick) -
          1) *
          rules.metabolismIntervalMs,
      );
  for (const boundary of [agentPolicy.attentionHunger, 1000])
    if (self.needs.hunger < boundary && rules.hungerPerTick > 0)
      times.push(
        (tick +
          Math.ceil((boundary - self.needs.hunger) / rules.hungerPerTick) -
          1) *
          rules.metabolismIntervalMs,
      );
  return Math.min(...times);
}
export function reviewDeadline(
  state: WorldState,
  citizenId: string,
  commitmentDeadlines: number[] = [],
) {
  const citizen = state.citizens[citizenId]!;
  const fallback = state.simTimeMs + agentPolicy.idleReviewMs;
  const requested = citizen.plan?.nextReviewAtMs ?? fallback;
  const deadline = requested > state.simTimeMs ? requested : fallback;
  const job = citizen.actionId ? state.jobs[citizen.actionId] : null;
  const conversation = activeConversation(state, citizenId);
  if (conversation && conversation.nextSpeakerId !== citizenId)
    return conversation.expiresAtMs;
  if (job?.kind === "sleep") return job.endsAt;
  const attention = Math.min(
    attentionDeadline(state, citizenId),
    ...commitmentDeadlines.filter((time) => time > state.simTimeMs),
  );
  if (job && job.kind !== "move") return Math.min(job.endsAt, attention);
  return Math.min(
    attention,
    job?.status === "running" ? deadline : Math.min(deadline, fallback),
  );
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
    const self = current.citizens[citizenId]!,
      sleeping = self.actionId && current.jobs[self.actionId]?.kind === "sleep";
    if (
      !sleeping &&
      event.kind === "clock.advanced" &&
      next.simTimeMs >= attentionDeadline(current, citizenId)
    )
      reasons.add("scheduled-attention");
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
