import { WorldTransition, requireRule } from "./transition";
import { progressJob } from "./jobs";
import { clampNeed } from "./work";
import { amount } from "./resources";
import { reconcileConversations } from "./conversations";

function metabolism(ctx: WorldTransition) {
  const rules = ctx.state.rules;
  const citizens = Object.fromEntries(
    Object.values(ctx.state.citizens).map((citizen) => {
      const sleeping =
        citizen.actionId && ctx.state.jobs[citizen.actionId]?.kind === "sleep";
      return [
        citizen.id,
        {
          ...citizen,
          needs: {
            hunger: clampNeed(citizen.needs.hunger + rules.hungerPerTick),
            energy: clampNeed(
              citizen.needs.energy +
                (sleeping ? rules.sleepRecoveryPerTick : -rules.energyPerTick),
            ),
          },
        },
      ];
    }),
  );
  ctx.emit("needs.changed", "Needs progressed.", { citizens });
}

function regenerate(ctx: WorldTransition) {
  for (const original of Object.values(ctx.state.objects).sort((a, b) =>
    a.id < b.id ? -1 : 1,
  )) {
    if (
      !original.regeneration ||
      original.regeneration.nextAt !== ctx.state.simTimeMs
    )
      continue;
    const target = structuredClone(original);
    const regen = target.regeneration!;
    let random = ctx.state.rngState;
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    random >>>= 0;
    regen.nextAt += regen.intervalMs;
    const succeeded = random / 4294967296 < regen.probability;
    const current = amount(target.inventory, regen.resource);
    if (succeeded)
      target.inventory[regen.resource] =
        current + Math.max(0, Math.min(regen.maximum - current, regen.amount));
    ctx.emit(
      "environment.regenerated",
      succeeded
        ? `${target.name} replenished ${regen.resource}.`
        : `${target.name} regeneration check completed.`,
      { objects: { [target.id]: target }, rngState: random },
      { position: target.position },
    );
  }
}

export function advanceClock(ctx: WorldTransition, durationMs: number) {
  requireRule(
    durationMs <= ctx.state.rules.maxAdvanceMs,
    "Advance exceeds the world's limit.",
  );
  const target = ctx.state.simTimeMs + durationMs;
  requireRule(
    Number.isSafeInteger(target),
    "Simulation time exceeds integer precision.",
  );
  while (ctx.state.simTimeMs < target) {
    const active = Object.values(ctx.state.jobs).filter(
      (job) => job.status === "running",
    );
    const nextMetabolism =
      (Math.floor(ctx.state.simTimeMs / ctx.state.rules.metabolismIntervalMs) +
        1) *
      ctx.state.rules.metabolismIntervalMs;
    const next = Math.min(
      target,
      nextMetabolism,
      ...Object.values(ctx.state.objects).flatMap((o) =>
        o.regeneration ? [o.regeneration.nextAt] : [],
      ),
      ...active.map((job) =>
        job.kind === "move" ? job.nextStepAt : job.endsAt,
      ),
      ...Object.values(ctx.state.conversations ?? {})
        .filter((item) => item.status !== "ended")
        .map((item) => item.expiresAtMs),
    );
    requireRule(next > ctx.state.simTimeMs, "A job has an invalid due time.");
    ctx.emit("clock.advanced", "Simulation time advanced.", {
      simTimeMs: next,
    });
    if (next === nextMetabolism) metabolism(ctx);
    regenerate(ctx);
    for (const job of active.sort((a, b) => (a.id < b.id ? -1 : 1)))
      if ((job.kind === "move" ? job.nextStepAt : job.endsAt) === next)
        progressJob(ctx, job);
    reconcileConversations(ctx);
  }
}
