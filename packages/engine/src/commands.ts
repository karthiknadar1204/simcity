import {
  parseCommand,
  stableStringify,
  type Command,
  type Transition,
  type WorldState,
  type Receipt,
} from "@repo/contracts";
import { WorldTransition, RuleError, requireRule } from "./transition";
import { occupied, sameTile } from "./geometry";
import { advanceClock } from "./clock";
import { act } from "./actor";

export function applyCommand(
  world: WorldState,
  input: Command,
  previous?: Receipt,
): Transition {
  const command = parseCommand(input);
  if (previous) {
    requireRule(
      previous.id === command.id &&
        stableStringify(previous.action) === stableStringify(command.action),
      "Command ID already used with different parameters.",
    );
    return { state: world, events: [], observations: [], receipt: previous };
  }
  let ctx = new WorldTransition(world, command.id);
  let status: Receipt["status"] = "accepted";
  let reason: string | undefined;
  try {
    const action = command.action;
    switch (action.kind) {
      case "advance":
        advanceClock(ctx, action.durationMs);
        break;
      case "set-blocked": {
        requireRule(
          action.position.x < ctx.state.map.width &&
            action.position.y < ctx.state.map.height,
          "Tile outside map.",
        );
        requireRule(
          !action.blocked || !occupied(ctx.state, action.position, ""),
          "Cannot block an occupied tile.",
        );
        const blocked = ctx.state.map.blocked.filter(
          (p) => !sameTile(p, action.position),
        );
        if (action.blocked) blocked.push(action.position);
        ctx.emit(
          "terrain.changed",
          action.blocked ? "A route was blocked." : "A route was opened.",
          { map: { ...ctx.state.map, blocked } },
          { position: action.position },
        );
        break;
      }
      case "set-status":
        ctx.emit("run.status-changed", `Run ${action.status}.`, {
          status: action.status,
        });
        break;
      case "set-speed":
        ctx.emit("run.speed-changed", `Speed set to ${action.speed}.`, {
          speed: action.speed,
        });
        break;
      default:
        act(ctx, action);
    }
  } catch (error) {
    if (!(error instanceof RuleError)) throw error;
    ctx = new WorldTransition(world, command.id);
    status = "rejected";
    reason = error.message;
  }
  const action = command.action;
  const actor =
    "actorId" in action && Object.hasOwn(ctx.state.citizens, action.actorId)
      ? ctx.state.citizens[action.actorId]
      : undefined;
  const receipt: Receipt = {
    id: command.id,
    action,
    status,
    ...(reason ? { reason } : {}),
    ...(actor?.actionId ? { jobId: actor.actionId } : {}),
    eventSequence: ctx.state.sequence + 1,
  };
  ctx.emit(
    `command.${status}`,
    reason ?? "Command accepted.",
    {},
    actor
      ? { actorId: actor.id, position: actor.position, audienceIds: [actor.id] }
      : {},
  );
  return {
    state: ctx.state,
    events: ctx.events,
    observations: ctx.observations,
    receipt,
  };
}
