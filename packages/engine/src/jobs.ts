import type { ActionJob, Citizen } from "@repo/contracts";
import { WorldTransition, RuleError, requireRule } from "./transition";
import { distance, occupied, walkable } from "./geometry";
import { change, scale, total } from "./resources";
import { clampNeed } from "./work";

export function finishJob(
  ctx: WorldTransition,
  original: ActionJob,
  status: "completed" | "failed" | "interrupted",
  reason?: string,
) {
  const job = {
    ...original,
    status,
    finishedAt: ctx.state.simTimeMs,
    ...(reason ? { reason } : {}),
  };
  const actor = structuredClone(ctx.state.citizens[job.actorId]!);
  actor.actionId = null;
  const objects = {} as Record<string, import("@repo/contracts").WorldObject>;
  if (job.kind === "work" && status !== "completed") {
    actor.inventory = change(actor.inventory, job.reservedActor, 1);
    const target = structuredClone(ctx.state.objects[job.targetId]!);
    target.inventory = change(target.inventory, job.reservedObject, 1);
    objects[target.id] = target;
  }
  ctx.emit(
    `action.${status}`,
    `${actor.name}: ${reason ?? `${job.kind} completed`}.`,
    { jobs: { [job.id]: job }, citizens: { [actor.id]: actor }, objects },
    { actorId: actor.id, position: actor.position },
  );
}

export function progressJob(ctx: WorldTransition, original: ActionJob) {
  if (original.kind === "work") {
    try {
      const actor = structuredClone(ctx.state.citizens[original.actorId]!);
      const target = structuredClone(ctx.state.objects[original.targetId]!);
      requireRule(
        target &&
          distance(actor.position, target.position) <= 1 &&
          (!target.ownerId || target.ownerId === actor.id),
        "Work target is no longer accessible.",
      );
      actor.inventory = change(
        actor.inventory,
        scale(original.capability.actorOutputs, original.units),
        1,
      );
      requireRule(
        total(actor.inventory) <= actor.capacity,
        "Inventory became full before completion.",
      );
      target.inventory = change(
        target.inventory,
        scale(original.capability.objectOutputs, original.units),
        1,
      );
      target.progress += original.capability.progressDelta * original.units;
      requireRule(
        Number.isSafeInteger(target.progress) && target.progress >= 0,
        "Invalid progress outcome.",
      );
      actor.needs = {
        hunger: clampNeed(
          actor.needs.hunger +
            original.capability.needs.hunger * original.units,
        ),
        energy: clampNeed(
          actor.needs.energy +
            original.capability.needs.energy * original.units,
        ),
      };
      ctx.emit(
        "work.completed",
        `${actor.name} completed ${original.capability.label}.`,
        { citizens: { [actor.id]: actor }, objects: { [target.id]: target } },
        { actorId: actor.id, position: target.position },
      );
      finishJob(ctx, original, "completed");
    } catch (error) {
      if (!(error instanceof RuleError)) throw error;
      finishJob(ctx, original, "failed", error.message);
    }
    return;
  }
  if (original.kind === "sleep" || original.kind === "wait") {
    finishJob(ctx, original, "completed");
    return;
  }
  const job = structuredClone(original);
  const actor = structuredClone(ctx.state.citizens[job.actorId]!);
  const next = job.path[job.stepIndex + 1];
  if (
    !next ||
    !walkable(ctx.state.map, next) ||
    occupied(ctx.state, next, actor.id)
  ) {
    finishJob(ctx, job, "interrupted", "Route blocked");
    return;
  }
  const dx = next.x - actor.position.x,
    dy = next.y - actor.position.y;
  actor.facing = dx > 0 ? "right" : dx < 0 ? "left" : dy > 0 ? "down" : "up";
  actor.position = next;
  job.stepIndex++;
  job.nextStepAt += actor.moveDurationMs;
  ctx.emit(
    "movement.stepped",
    `${actor.name} moved to ${next.x},${next.y}.`,
    { citizens: { [actor.id]: actor }, jobs: { [job.id]: job } },
    { actorId: actor.id, position: next },
  );
  if (job.stepIndex === job.path.length - 1) finishJob(ctx, job, "completed");
}

export function startMovement(
  ctx: WorldTransition,
  actor: Citizen,
  path: { x: number; y: number }[],
) {
  if (path.length === 1) return;
  const id = `${ctx.causeId}-action`;
  const job: ActionJob = {
    id,
    commandId: ctx.causeId,
    actorId: actor.id,
    startedAt: ctx.state.simTimeMs,
    finishedAt: null,
    status: "running",
    kind: "move",
    path,
    stepIndex: 0,
    nextStepAt: ctx.state.simTimeMs + actor.moveDurationMs,
  };
  ctx.emit(
    "action.started",
    `${actor.name} started walking.`,
    {
      citizens: { [actor.id]: { ...actor, actionId: id } },
      jobs: { [id]: job },
    },
    { actorId: actor.id, position: actor.position },
  );
}

export function startTimedJob(
  ctx: WorldTransition,
  actor: Citizen,
  durationMs: number,
  targetId?: string,
) {
  const id = `${ctx.causeId}-action`;
  const endsAt = ctx.state.simTimeMs + durationMs;
  requireRule(Number.isSafeInteger(endsAt), "Action duration is too large.");
  const common = {
    id,
    commandId: ctx.causeId,
    actorId: actor.id,
    startedAt: ctx.state.simTimeMs,
    finishedAt: null,
    status: "running" as const,
    endsAt,
  };
  const job: ActionJob = targetId
    ? { ...common, kind: "sleep", targetId }
    : { ...common, kind: "wait" };
  ctx.emit(
    "action.started",
    `${actor.name} started ${job.kind}.`,
    {
      citizens: { [actor.id]: { ...actor, actionId: id } },
      jobs: { [id]: job },
    },
    { actorId: actor.id, position: actor.position },
  );
}
