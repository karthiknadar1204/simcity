export type Point = { x: number; y: number };
export type Resources = Record<string, number>;
export type Needs = { hunger: number; energy: number };
export type Facing = "up" | "down" | "left" | "right";
export type WorldMap = {
  width: number;
  height: number;
  tileSize: number;
  blocked: Point[];
};

export interface Capability {
  id: string;
  label: string;
  durationMs: number;
  actorInputs: Resources;
  objectInputs: Resources;
  actorOutputs: Resources;
  objectOutputs: Resources;
  needs: Needs;
  progressDelta: number;
}

export interface Citizen {
  id: string;
  name: string;
  biography: string;
  motivations: string[];
  position: Point;
  inventory: Resources;
  capacity: number;
  needs: Needs;
  visionRadius: number;
  hearingRadius: number;
  moveDurationMs: number;
  knownEntityIds: string[];
  initialMemories: string[];
  actionId: string | null;
  facing: Facing;
  plan?: import("./agents").CitizenPlan;
}

export interface WorldObject {
  id: string;
  name: string;
  position: Point;
  tags: string[];
  ownerId: string | null;
  inventory: Resources;
  capabilities: Capability[];
  progress: number;
  regeneration?: {
    resource: string;
    intervalMs: number;
    amount: number;
    maximum: number;
    probability: number;
    nextAt: number;
  };
}

export interface Rules {
  dayLengthMs: number;
  checkpointIntervalMs: number;
  checkpointEventInterval: number;
  maxAdvanceMs: number;
  maxEventsPerTransition: number;
  metabolismIntervalMs: number;
  hungerPerTick: number;
  energyPerTick: number;
  sleepRecoveryPerTick: number;
}

export interface Scenario {
  version: 1;
  id: string;
  name: string;
  seed: number;
  startTimeMs: number;
  speed: number;
  map: WorldMap;
  rules: Rules;
  citizens: Citizen[];
  objects: WorldObject[];
}

export type Action =
  | {
      kind: "plan";
      actorId: string;
      expectedVersion: number;
      plan: import("./agents").PlanProposal;
    }
  | { kind: "move"; actorId: string; destination: Point }
  | {
      kind: "interact";
      actorId: string;
      targetId: string;
      capabilityId: string;
      units: number;
    }
  | {
      kind: "transfer";
      actorId: string;
      targetId: string;
      resource: string;
      amount: number;
    }
  | { kind: "say"; actorId: string; text: string; audienceIds?: string[] }
  | { kind: "wait"; actorId: string; durationMs: number }
  | { kind: "sleep"; actorId: string; targetId: string; durationMs: number }
  | { kind: "cancel"; actorId: string }
  | { kind: "inspect"; actorId: string; targetId: string }
  | { kind: "advance"; durationMs: number }
  | { kind: "set-blocked"; position: Point; blocked: boolean }
  | { kind: "set-status"; status: "running" | "paused" }
  | { kind: "set-speed"; speed: number };

export interface Command {
  id: string;
  action: Action;
}
export interface Receipt {
  id: string;
  action: Action;
  status: "accepted" | "rejected";
  reason?: string;
  jobId?: string;
  eventSequence: number;
}
type JobBase = {
  id: string;
  commandId: string;
  actorId: string;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "completed" | "failed" | "interrupted";
  reason?: string;
};
export type ActionJob = JobBase &
  (
    | { kind: "move"; path: Point[]; stepIndex: number; nextStepAt: number }
    | {
        kind: "work";
        targetId: string;
        capability: Capability;
        units: number;
        reservedActor: Resources;
        reservedObject: Resources;
        endsAt: number;
      }
    | { kind: "sleep"; targetId: string; endsAt: number }
    | { kind: "wait"; endsAt: number }
  );

export interface WorldState {
  schemaVersion: 1;
  runId: string;
  scenarioId: string;
  simTimeMs: number;
  sequence: number;
  status: "running" | "paused";
  speed: number;
  rngState: number;
  map: WorldMap;
  rules: Rules;
  citizens: Record<string, Citizen>;
  objects: Record<string, WorldObject>;
  jobs: Record<string, ActionJob>;
}

export type StatePatch = Partial<
  Pick<
    WorldState,
    | "simTimeMs"
    | "status"
    | "speed"
    | "rngState"
    | "map"
    | "citizens"
    | "objects"
    | "jobs"
  >
>;
export interface WorldEvent {
  sequence: number;
  simTimeMs: number;
  kind: string;
  actorId: string | null;
  position: Point | null;
  audienceIds?: string[];
  description: string;
  causeId: string;
  patch: StatePatch;
}
export interface Observation {
  id: string;
  citizenId: string;
  eventSequence: number;
  simTimeMs: number;
  kind: string;
  content: string;
  entityIds: string[];
}
export interface Transition {
  state: WorldState;
  events: WorldEvent[];
  observations: Observation[];
  receipt: Receipt;
}
export interface RunManifest {
  version: 1;
  runId: string;
  parentRunId: string | null;
  engineVersion: string;
  schemaVersion: string;
  scenarioId: string;
  scenarioHash: string;
  engineCommit: string;
  seed: number;
  clockPolicy: "freeze-during-downtime";
  actorMode: "operator-fixture" | "autonomous";
  agent?: import("./agents").AgentConfiguration;
  agentRuntime?: typeof import("./agents").agentPolicy;
  modelRoles: Record<string, string>;
  promptVersion: string | null;
  toolVersion: string;
  memoryVariant: "observations-only";
  contextTokenLimit: number;
  spendingLimitUsd: number;
  createdAt: string;
  // Optional only for compatibility with earlier Phase 1 fixture manifests.
  configuration?: typeof import("./runtime").runtimePolicy;
  scenarioVersion?: number;
  mapHash?: string;
  profilesHash?: string;
  provenance?: RunProvenance;
}

export interface RunProvenance {
  sourceDirty: boolean | null;
  dependencyLockHash: string | null;
  protocol: { id: string; version: number; hash: string } | null;
}
