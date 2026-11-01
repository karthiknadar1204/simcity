import type {
  ActionJob,
  Capability,
  Citizen,
  WorldObject,
} from "@repo/contracts";
import { WorldTransition, requireRule } from "./transition";
import { change, scale, total } from "./resources";

export const clampNeed = (value: number) => Math.min(1000, Math.max(0, value));

export function startWork(
  ctx: WorldTransition,
  actor: Citizen,
  target: WorldObject,
  capability: Capability,
  units: number,
) {
  const reservedActor = scale(capability.actorInputs, units);
  const reservedObject = scale(capability.objectInputs, units);
  const actorInventory = change(actor.inventory, reservedActor, -1);
  const objectInventory = change(target.inventory, reservedObject, -1);
  requireRule(
    total(actorInventory) + total(scale(capability.actorOutputs, units)) <=
      actor.capacity,
    "Inventory cannot hold the output.",
  );
  requireRule(
    actor.needs.energy >= Math.max(0, -capability.needs.energy * units),
    "Insufficient energy.",
  );
  const id = `${ctx.causeId}-action`;
  const endsAt = ctx.state.simTimeMs + capability.durationMs * units;
  requireRule(Number.isSafeInteger(endsAt), "Action duration is too large.");
  const job: ActionJob = {
    id,
    commandId: ctx.causeId,
    actorId: actor.id,
    startedAt: ctx.state.simTimeMs,
    finishedAt: null,
    status: "running",
    kind: "work",
    targetId: target.id,
    capability,
    units,
    reservedActor,
    reservedObject,
    endsAt,
  };
  ctx.emit(
    "action.started",
    `${actor.name} started ${capability.label}.`,
    {
      citizens: {
        [actor.id]: { ...actor, inventory: actorInventory, actionId: id },
      },
      objects: { [target.id]: { ...target, inventory: objectInventory } },
      jobs: { [id]: job },
    },
    { actorId: actor.id, position: actor.position },
  );
}
