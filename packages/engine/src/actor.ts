import { stableStringify, type Action } from "@repo/contracts";
import { WorldTransition, requireRule } from "./transition";
import { citizenView } from "./perception";
import { change, scale, total } from "./resources";
import { distance, sameTile } from "./geometry";
import { findPath } from "./navigation";
import { finishJob, startMovement, startTimedJob } from "./jobs";
import { startWork } from "./work";

export function act(
  ctx: WorldTransition,
  action: Extract<Action, { actorId: string }>,
) {
  const actor = Object.hasOwn(ctx.state.citizens, action.actorId)
    ? structuredClone(ctx.state.citizens[action.actorId]!)
    : undefined;
  requireRule(actor, "Citizen not found.");
  const currentJob = actor.actionId
    ? ctx.state.jobs[actor.actionId]
    : undefined;
  if (action.kind === "cancel") {
    requireRule(currentJob, "Citizen has no running action.");
    finishJob(ctx, currentJob, "interrupted", "Action cancelled");
    return;
  }
  requireRule(currentJob?.kind !== "sleep", "Citizen is sleeping.");
  if (action.kind === "plan") {
    requireRule(
      action.expectedVersion === (actor.plan?.version ?? 0),
      "Plan version changed.",
    );
    requireRule(
      action.plan.cursor < action.plan.steps.length,
      "Plan cursor is outside its steps.",
    );
    const plan = {
      ...action.plan,
      version: action.expectedVersion + 1,
      updatedAtMs: ctx.state.simTimeMs,
      nextReviewAtMs: ctx.state.simTimeMs + action.plan.reviewAfterMs,
    };
    ctx.emit(
      "plan.updated",
      `Personal plan revised: ${plan.currentActivity}`,
      { citizens: { [actor.id]: { ...actor, plan } } },
      { actorId: actor.id, position: actor.position, audienceIds: [actor.id] },
    );
    return;
  }
  if (action.kind === "say") {
    const audienceIds = action.audienceIds
      ? [...new Set([actor.id, ...action.audienceIds])]
      : undefined;
    for (const id of audienceIds ?? []) {
      const listener = Object.hasOwn(ctx.state.citizens, id)
        ? ctx.state.citizens[id]
        : undefined;
      requireRule(
        listener &&
          distance(actor.position, listener.position) <=
            listener.hearingRadius &&
          (!listener.actionId ||
            ctx.state.jobs[listener.actionId]?.kind !== "sleep"),
        "A named listener cannot hear this message.",
      );
    }
    ctx.emit(
      "speech.delivered",
      `${actor.name}: ${action.text}`,
      {},
      {
        actorId: actor.id,
        position: actor.position,
        ...(audienceIds ? { audienceIds } : {}),
      },
    );
    return;
  }
  if (action.kind === "inspect") {
    const view = citizenView(ctx.state, actor.id);
    const target = [...view.objects, ...view.citizens].find(
      (entry) => entry.id === action.targetId,
    );
    requireRule(target, "Target is outside current perception.");
    const knownEntityIds = [...new Set([...actor.knownEntityIds, target.id])];
    ctx.emit(
      "inspection.completed",
      stableStringify(target),
      { citizens: { [actor.id]: { ...actor, knownEntityIds } } },
      { actorId: actor.id, position: actor.position, audienceIds: [actor.id] },
    );
    return;
  }
  requireRule(!currentJob, "Citizen is busy.");
  switch (action.kind) {
    case "move": {
      requireRule(actor.needs.energy > 0, "Citizen needs rest.");
      const path = findPath(ctx.state, actor.id, action.destination);
      requireRule(path, "No walkable route.");
      startMovement(ctx, actor, path);
      return;
    }
    case "wait":
      startTimedJob(ctx, actor, action.durationMs);
      return;
    case "sleep": {
      const bed = Object.hasOwn(ctx.state.objects, action.targetId)
        ? ctx.state.objects[action.targetId]
        : undefined;
      requireRule(
        bed &&
          bed.tags.includes("bed") &&
          sameTile(actor.position, bed.position) &&
          (!bed.ownerId || bed.ownerId === actor.id),
        "Citizen needs an accessible bed at their location.",
      );
      startTimedJob(ctx, actor, action.durationMs, bed.id);
      return;
    }
    case "interact": {
      const target = Object.hasOwn(ctx.state.objects, action.targetId)
        ? ctx.state.objects[action.targetId]
        : undefined;
      requireRule(
        target &&
          distance(actor.position, target.position) <= 1 &&
          (!target.ownerId || target.ownerId === actor.id),
        "Work target is not accessible.",
      );
      const capability = target.capabilities.find(
        (c) => c.id === action.capabilityId,
      );
      requireRule(capability, "Target does not support that capability.");
      startWork(ctx, actor, target, capability, action.units);
      return;
    }
    case "transfer": {
      const target = Object.hasOwn(ctx.state.citizens, action.targetId)
        ? structuredClone(ctx.state.citizens[action.targetId]!)
        : undefined;
      requireRule(
        target && target.id !== actor.id,
        "Transfer target is invalid.",
      );
      requireRule(
        distance(actor.position, target.position) <= 1,
        "Transfer target is too far away.",
      );
      const pending = target.actionId
        ? ctx.state.jobs[target.actionId]
        : undefined;
      const reservedSlots =
        pending?.kind === "work"
          ? Math.max(
              total(pending.reservedActor),
              total(scale(pending.capability.actorOutputs, pending.units)),
            )
          : 0;
      actor.inventory = change(
        actor.inventory,
        { [action.resource]: action.amount },
        -1,
      );
      target.inventory = change(
        target.inventory,
        { [action.resource]: action.amount },
        1,
      );
      requireRule(
        total(target.inventory) + reservedSlots <= target.capacity,
        "Recipient inventory is full or reserved.",
      );
      ctx.emit(
        "resources.transferred",
        `${actor.name} gave ${target.name} ${action.amount} ${action.resource}.`,
        { citizens: { [actor.id]: actor, [target.id]: target } },
        { actorId: actor.id, position: actor.position },
      );
      return;
    }
  }
}
