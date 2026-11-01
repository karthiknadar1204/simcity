import type {
  Observation,
  Point,
  WorldEvent,
  WorldState,
} from "@repo/contracts";
import { distance, lineOfSight } from "./geometry";
import { activeConversation } from "@repo/contracts";

export function perceive(world: WorldState, event: WorldEvent): Observation[] {
  if (!event.position) return [];
  const entityIds = [
    ...new Set([
      ...(event.actorId ? [event.actorId] : []),
      ...Object.keys(event.patch.citizens ?? {}),
      ...Object.keys(event.patch.objects ?? {}),
    ]),
  ];
  return Object.values(world.citizens)
    .filter((citizen) => {
      if (event.audienceIds) return event.audienceIds.includes(citizen.id);
      if (citizen.id === event.actorId) return true;
      if (citizen.actionId && world.jobs[citizen.actionId]?.kind === "sleep")
        return false;
      if (event.kind === "speech.delivered")
        return (
          distance(citizen.position, event.position!) <= citizen.hearingRadius
        );
      return (
        distance(citizen.position, event.position!) <= citizen.visionRadius &&
        lineOfSight(world.map, citizen.position, event.position!)
      );
    })
    .map((citizen) => ({
      id: `${event.sequence}-${citizen.id}`,
      citizenId: citizen.id,
      eventSequence: event.sequence,
      simTimeMs: event.simTimeMs,
      kind: event.kind,
      content: event.description,
      entityIds,
    }));
}

export function canSeeTile(
  world: WorldState,
  citizenId: string,
  position: Point,
) {
  const citizen = world.citizens[citizenId];
  return Boolean(
    citizen &&
    position.x >= 0 &&
    position.y >= 0 &&
    position.x < world.map.width &&
    position.y < world.map.height &&
    distance(citizen.position, position) <= citizen.visionRadius &&
    lineOfSight(world.map, citizen.position, position),
  );
}

export function citizenView(world: WorldState, citizenId: string) {
  const citizen = Object.hasOwn(world.citizens, citizenId)
    ? world.citizens[citizenId]
    : undefined;
  if (!citizen) throw new Error("Citizen not found.");
  const visible = (position: Point) => canSeeTile(world, citizenId, position);
  return {
    self: citizen,
    simTimeMs: world.simTimeMs,
    terrain: world.map.blocked.filter(visible),
    citizens: Object.values(world.citizens)
      .filter((c) => c.id !== citizenId && visible(c.position))
      .map((c) => ({
        id: c.id,
        name: c.name,
        position: c.position,
        facing: c.facing,
        activity: c.actionId
          ? (world.jobs[c.actionId]?.kind ?? "idle")
          : "idle",
        conversationAvailable: !activeConversation(world, c.id),
      })),
    objects: Object.values(world.objects)
      .filter((o) => visible(o.position))
      .map((o) => ({
        id: o.id,
        name: o.name,
        position: o.position,
        tags: o.tags,
        ...(distance(citizen.position, o.position) <= 1 &&
        (!o.ownerId || o.ownerId === citizenId)
          ? {
              inventory: o.inventory,
              capabilities: o.capabilities,
              progress: o.progress,
            }
          : {}),
      })),
  };
}
