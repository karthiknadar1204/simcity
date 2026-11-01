import { z } from "zod";
import { citizenView } from "@repo/engine";
import {
  planProposalSchema,
  parseCommand,
  type Action,
  type WorldState,
} from "@repo/contracts";
import type { FunctionTool } from "openai/resources/responses/responses";
const id = z.string().min(1).max(160);
const whole = z.number().int().nonnegative();
const definitions = {
  world_observe: {
    description:
      "Read your permitted surroundings, needs, inventory and current activity.",
    schema: z.strictObject({}),
  },
  world_inspect: {
    description:
      "Inspect a visible target. Detailed stock requires nearby permitted access.",
    schema: z.strictObject({ targetId: id }),
  },
  world_capabilities: {
    description:
      "Read advertised interactions on a nearby accessible object. Does not disclose distant stock.",
    schema: z.strictObject({ targetId: id }),
  },
  world_move: {
    description:
      "Start navigation to a known place ID, or a nearby tile using x/y. For place ID set x/y null; for tile set targetId null. Yields on accepted walking job.",
    schema: z.strictObject({
      targetId: id.nullable(),
      x: whole.nullable(),
      y: whole.nullable(),
    }),
  },
  world_interact: {
    description:
      "Request one advertised object capability. Inputs, proximity, ownership and capacity are validated. Yields while working.",
    schema: z.strictObject({
      targetId: id,
      capabilityId: id,
      units: z.number().int().min(1).max(100),
    }),
  },
  inventory_transfer: {
    description:
      "Give an adjacent citizen a positive quantity of a resource you actually own.",
    schema: z.strictObject({
      targetId: id,
      resource: id,
      amount: z.number().int().min(1).max(1000000),
    }),
  },
  social_say: {
    description:
      "Speak audibly nearby. audienceIds null broadcasts; named recipients must be nearby and awake.",
    schema: z.strictObject({
      text: z.string().min(1).max(2000),
      audienceIds: z.array(id).min(1).max(20).nullable(),
    }),
  },
  time_wait: {
    description:
      "Start an explicit wait on the simulation clock. Yields until completion or a relevant message.",
    schema: z.strictObject({
      durationMs: z.number().int().min(1000).max(3600000),
    }),
  },
  time_sleep: {
    description:
      "Sleep at an accessible bed at your current tile for a chosen simulated duration. Yields until waking.",
    schema: z.strictObject({
      targetId: id,
      durationMs: z.number().int().min(1000).max(86400000),
    }),
  },
  actions_status: {
    description: "Read your current activity and its real progress/outcome.",
    schema: z.strictObject({}),
  },
  actions_cancel: {
    description:
      "Cancel your ongoing activity; reserved work inputs are refunded. Cancel before replacing a physical action.",
    schema: z.strictObject({}),
  },
  memory_search: {
    description:
      "Search your own initial memories and delivered observations at this turn's recorded boundary. Maximum two searches.",
    schema: z.strictObject({ query: z.string().min(1).max(200) }),
  },
  memory_read: {
    description:
      "Open an exact personal source ID. Another citizen's or a future source is unavailable.",
    schema: z.strictObject({ sourceId: id }),
  },
  plans_update: {
    description:
      "Save a revisable personal day outline/current goal. expectedVersion is current plan version, or 0 initially. Cannot create effects or agreements.",
    schema: planProposalSchema.extend({ expectedVersion: whole }),
  },
} as const;
export type ToolName = keyof typeof definitions;
export const tools: FunctionTool[] = Object.entries(definitions).map(
  ([name, definition]) => {
    const parameters = z.toJSONSchema(definition.schema, {
      target: "draft-7",
    }) as Record<string, unknown>;
    delete parameters.$schema;
    return {
      type: "function",
      name,
      description: definition.description,
      strict: true,
      parameters,
    };
  },
);
export function parseTool(name: string, input: string) {
  if (!Object.hasOwn(definitions, name))
    throw new Error("Unknown citizen tool.");
  return {
    name: name as ToolName,
    args: definitions[name as ToolName].schema.parse(
      JSON.parse(input),
    ) as Record<string, unknown>,
  };
}
export function actionFor(
  name: ToolName,
  args: Record<string, unknown>,
  state: WorldState,
  citizenId: string,
): Action | null {
  let action: unknown;
  switch (name) {
    case "world_move": {
      const self = state.citizens[citizenId]!;
      const visible = citizenView(state, citizenId).objects.map(
        (object) => object.id,
      );
      const target =
        typeof args.targetId === "string" &&
        [...self.knownEntityIds, ...visible].includes(args.targetId)
          ? state.objects[args.targetId]
          : undefined;
      const destination =
        target?.position ??
        (args.targetId === null &&
        typeof args.x === "number" &&
        typeof args.y === "number" &&
        Math.abs(args.x - self.position.x) +
          Math.abs(args.y - self.position.y) <=
          self.visionRadius
          ? { x: args.x, y: args.y }
          : null);
      if (!destination)
        throw new Error(
          "Destination is not a known place or locally perceived tile.",
        );
      action = { kind: "move", actorId: citizenId, destination };
      break;
    }
    case "world_inspect":
      action = { kind: "inspect", actorId: citizenId, targetId: args.targetId };
      break;
    case "world_interact":
      action = { kind: "interact", actorId: citizenId, ...args };
      break;
    case "inventory_transfer":
      action = { kind: "transfer", actorId: citizenId, ...args };
      break;
    case "social_say":
      action = {
        kind: "say",
        actorId: citizenId,
        text: args.text,
        ...(args.audienceIds ? { audienceIds: args.audienceIds } : {}),
      };
      break;
    case "time_wait":
      action = { kind: "wait", actorId: citizenId, ...args };
      break;
    case "time_sleep":
      action = { kind: "sleep", actorId: citizenId, ...args };
      break;
    case "actions_cancel":
      action = { kind: "cancel", actorId: citizenId };
      break;
    case "plans_update": {
      const { expectedVersion, ...plan } = args;
      action = { kind: "plan", actorId: citizenId, expectedVersion, plan };
      break;
    }
    default:
      return null;
  }
  return parseCommand({ id: "tool-validation", action }).action;
}
