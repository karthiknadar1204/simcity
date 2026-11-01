export * from "./types";
export * from "./agents";
import { planProposalSchema } from "./agents";
export { runtimePolicy } from "./runtime";
import type { Scenario, Command } from "./types";
import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const integer = z.number().int().safe().nonnegative();
const positive = integer.min(1);
const point = z.strictObject({ x: integer, y: integer });
const resources = z.record(id, integer);
const needs = z.strictObject({
  hunger: integer.max(1000),
  energy: integer.max(1000),
});
const deltaNeeds = z.strictObject({
  hunger: z.number().int().min(-1000).max(1000),
  energy: z.number().int().min(-1000).max(1000),
});
const capability = z.strictObject({
  id,
  label: z.string().min(1).max(100),
  durationMs: positive.max(86400000),
  actorInputs: resources,
  objectInputs: resources,
  actorOutputs: resources,
  objectOutputs: resources,
  needs: deltaNeeds,
  progressDelta: z.number().int().min(-1000).max(1000),
});
const citizen = z.strictObject({
  id,
  name: z.string().min(1).max(100),
  biography: z.string().max(4000),
  motivations: z.array(z.string().max(1000)).max(20),
  position: point,
  inventory: resources,
  capacity: positive,
  needs,
  visionRadius: integer.max(50),
  hearingRadius: integer.max(50),
  moveDurationMs: positive.min(100).max(60000),
  knownEntityIds: z.array(id),
  initialMemories: z.array(z.string().max(4000)).max(100),
  actionId: z.null(),
  facing: z.enum(["up", "down", "left", "right"]),
});
const object = z.strictObject({
  id,
  name: z.string().min(1).max(100),
  position: point,
  tags: z.array(id).max(20),
  ownerId: id.nullable(),
  inventory: resources,
  capabilities: z.array(capability).max(20),
  progress: integer,
  regeneration: z
    .strictObject({
      resource: id,
      intervalMs: positive.min(1000),
      amount: positive,
      maximum: positive,
      probability: z.number().min(0).max(1),
      nextAt: integer,
    })
    .optional(),
});
const scenarioSchema = z.strictObject({
  version: z.literal(1),
  id,
  name: z.string().min(1).max(100),
  seed: positive.max(4294967295),
  startTimeMs: integer,
  speed: z.number().min(0.25).max(16),
  map: z.strictObject({
    width: positive.max(128),
    height: positive.max(128),
    tileSize: positive.min(8).max(64),
    blocked: z.array(point).max(16384),
  }),
  rules: z.strictObject({
    dayLengthMs: positive,
    checkpointIntervalMs: positive,
    checkpointEventInterval: positive,
    maxAdvanceMs: positive.max(3600000),
    maxEventsPerTransition: positive.max(20000),
    metabolismIntervalMs: positive.min(1000).max(3600000),
    hungerPerTick: integer.max(100),
    energyPerTick: integer.max(100),
    sleepRecoveryPerTick: positive.max(1000),
  }),
  citizens: z.array(citizen).min(1).max(100),
  objects: z.array(object).max(1000),
});

export function parseScenario(input: unknown): Scenario {
  const value = scenarioSchema.parse(input);
  const allIds = [...value.citizens, ...value.objects].map(
    (entity) => entity.id,
  );
  const ids = new Set(allIds);
  if (ids.size !== allIds.length) throw new Error("Entity IDs must be unique.");
  const inside = (p: { x: number; y: number }) =>
    p.x < value.map.width && p.y < value.map.height;
  const blocked = new Set(value.map.blocked.map((p) => `${p.x},${p.y}`));
  if (
    blocked.size !== value.map.blocked.length ||
    value.map.blocked.some((p) => !inside(p))
  )
    throw new Error("Invalid blocked tiles.");
  for (const entity of [...value.citizens, ...value.objects]) {
    if (
      !inside(entity.position) ||
      blocked.has(`${entity.position.x},${entity.position.y}`)
    )
      throw new Error("Entity must start on a walkable map tile.");
  }
  for (const actor of value.citizens) {
    if (actor.knownEntityIds.some((key) => !ids.has(key)))
      throw new Error("Unknown initial knowledge reference.");
    if (
      Object.values(actor.inventory).reduce((a, b) => a + b, 0) > actor.capacity
    )
      throw new Error("Initial inventory exceeds capacity.");
  }
  const citizenIds = new Set(value.citizens.map((c) => c.id));
  for (const target of value.objects) {
    if (target.ownerId && !citizenIds.has(target.ownerId))
      throw new Error("Unknown object owner.");
    if (
      new Set(target.capabilities.map((c) => c.id)).size !==
      target.capabilities.length
    )
      throw new Error("Duplicate capability ID.");
    if (target.regeneration && target.regeneration.nextAt <= value.startTimeMs)
      throw new Error("Regeneration must be scheduled in the future.");
  }
  return value;
}

const actionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("plan"),
    actorId: id,
    expectedVersion: integer,
    plan: planProposalSchema,
  }),
  z.strictObject({ kind: z.literal("move"), actorId: id, destination: point }),
  z.strictObject({
    kind: z.literal("interact"),
    actorId: id,
    targetId: id,
    capabilityId: id,
    units: positive.max(100),
  }),
  z.strictObject({
    kind: z.literal("transfer"),
    actorId: id,
    targetId: id,
    resource: id,
    amount: positive.max(1000000),
  }),
  z.strictObject({
    kind: z.literal("say"),
    actorId: id,
    text: z.string().trim().min(1).max(2000),
    audienceIds: z.array(id).min(1).max(100).optional(),
  }),
  z.strictObject({
    kind: z.literal("wait"),
    actorId: id,
    durationMs: positive.max(86400000),
  }),
  z.strictObject({
    kind: z.literal("sleep"),
    actorId: id,
    targetId: id,
    durationMs: positive.max(86400000),
  }),
  z.strictObject({ kind: z.literal("cancel"), actorId: id }),
  z.strictObject({ kind: z.literal("inspect"), actorId: id, targetId: id }),
  z.strictObject({
    kind: z.literal("advance"),
    durationMs: positive.max(3600000),
  }),
  z.strictObject({
    kind: z.literal("set-blocked"),
    position: point,
    blocked: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("set-status"),
    status: z.enum(["running", "paused"]),
  }),
  z.strictObject({
    kind: z.literal("set-speed"),
    speed: z.number().min(0.25).max(16),
  }),
]);

export function parseCommand(input: unknown): Command {
  return z.strictObject({ id, action: actionSchema }).parse(input);
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export async function contentHash(value: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableStringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
