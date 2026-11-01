import type { Observation, WorldState } from "@repo/contracts";
import { citizenView } from "@repo/engine";
import { activeConversation } from "@repo/contracts";

export function buildContext(
  world: WorldState,
  citizenId: string,
  evidence: Observation[],
  reasons: string[],
): Record<string, unknown> {
  const view = citizenView(world, citizenId);
  const self = view.self;
  const visibleIds = new Set(view.objects.map((object) => object.id));
  const knownIds = new Set(self.knownEntityIds);
  const ownJob = self.actionId ? world.jobs[self.actionId] : null;
  const recent = evidence
    .filter(
      (source) =>
        source.citizenId === citizenId &&
        source.eventSequence <= world.sequence,
    )
    .slice(0, 20);
  return {
    boundary: {
      runId: world.runId,
      citizenId,
      eventSequence: world.sequence,
      simTimeMs: world.simTimeMs,
    },
    calendar: {
      day: Math.floor(world.simTimeMs / world.rules.dayLengthMs) + 1,
      hour: Math.floor((world.simTimeMs % world.rules.dayLengthMs) / 3600000),
      minute: Math.floor((world.simTimeMs % 3600000) / 60000),
    },
    reasons,
    identity: {
      id: self.id,
      name: self.name,
      biography: self.biography,
      motivations: self.motivations,
      dailyRhythm: self.dailyRhythm ?? null,
    },
    self: {
      position: self.position,
      needs: self.needs,
      inventory: self.inventory,
      capacity: self.capacity,
      job: ownJob,
    },
    plan: self.plan ?? null,
    conversation: activeConversation(world, citizenId),
    knownPlaces: Object.values(world.objects)
      .filter((object) => knownIds.has(object.id) || visibleIds.has(object.id))
      .map((object) => ({
        id: object.id,
        name: object.name,
        position: object.position,
        tags: object.tags,
        accessible: !object.ownerId || object.ownerId === citizenId,
      })),
    surroundings: {
      citizens: view.citizens,
      objects: view.objects,
      localBlockedTiles: view.terrain,
      mapSize: { width: world.map.width, height: world.map.height },
    },
    memories: {
      variant: "personal-seeds-and-observations",
      initial: self.initialMemories.map((content, index) => ({
        id: `seed-${index}`,
        content,
        learnedAtMs: 0,
      })),
      recent,
    },
    rules: {
      clock: "integer simulation milliseconds; freezes offline",
      needs:
        "energy 0..1000; higher is better; hunger 0..1000; higher means hungrier",
      durations:
        "actions use simulation time; physical effects require engine receipts",
      sleep:
        "sleep at an accessible bed tile; choose sleep duration from current time and your own plan",
    },
  };
}
