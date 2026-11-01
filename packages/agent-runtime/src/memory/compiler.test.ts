import { test, expect } from "bun:test";
import { createWorld } from "@repo/engine";
import {
  memoryPolicy,
  type CommitmentRecord,
  type MemoryRecord,
  type MemoryRetrieval,
} from "@repo/contracts";
import { buildContext } from "../context";
import { citizenInstructions } from "../prompt";
import { countInput } from "../openai";
import { assembleContext, type CompilationInput } from "./compiler";
import scenario from "../../../../experiments/scenarios/dev/town.json";
function input(): CompilationInput {
  const world = createWorld(scenario, "compiler-fixture"),
    citizen = Object.values(world.citizens)[0]!;
  const commitment = {
    id: "cv1",
    logicalId: "c1",
    version: 2,
    runId: world.runId,
    citizenId: citizen.id,
    debtorId: citizen.id,
    creditorId: "peer",
    resource: "supplies",
    amount: 6,
    deadlineMs: 36000000,
    status: "accepted",
    originSourceId: "s1",
    sourceIds: ["s1", "s2"],
    effectiveSequence: 2,
    availableSequence: 3,
    supersededSequence: null,
  } satisfies CommitmentRecord;
  const retrieval: MemoryRetrieval = {
    query: "supplies",
    asOf: 10,
    mode: "text",
    fallback: "Indexes pending",
    pendingIndexes: 4,
    sourceIds: [],
    candidates: Array.from({ length: 1000 }, (_, i) => ({
      memory: {
        id: `m${i}`,
        title: "An old experience",
        text: "Unrelated recollection. ".repeat(500),
        sourceIds: [`old${i}`],
        eventStartMs: 0,
        eventEndMs: 0,
        availableSequence: 0,
        certainty: "reported",
        kind: "episode",
        payload: {},
      } as MemoryRecord,
      score: 1000 - i,
      channels: ["text"],
    })),
  };
  return {
    base: buildContext(world, citizen.id, [], ["review"]),
    commitments: [commitment],
    counts: { accepted: 1, due: 1 },
    retrieval,
    pending: { episodes: [], sources: [] },
    evidence: [
      {
        id: "s2",
        citizenId: citizen.id,
        sequence: 2,
        simTimeMs: 2,
        kind: "speech.delivered",
        content: "The amended deadline is agreed.",
        actorId: "peer",
        participantIds: [citizen.id, "peer"],
        entityIds: [],
      },
    ],
    recentActions: [
      {
        action: { kind: "move", destination: { x: 3, y: 4 } },
        status: "rejected",
        reason: "No walkable route.",
      },
    ],
    relatedCommitments: [],
  };
}
test("the compiler pins current obligations and failures while bounding large optional memory sets", () => {
  const result = assembleContext(input());
  expect(result.context.obligations.current[0]!.deadlineMs).toBe(36000000);
  expect(JSON.stringify(result.context.recentActions)).toContain(
    "No walkable route",
  );
  expect(result.context.memories.retrieved.length).toBeLessThanOrEqual(
    memoryPolicy.maxSelected,
  );
  expect(
    countInput({
      instructions: citizenInstructions,
      context: JSON.stringify(result.context),
      history: [],
    }),
  ).toBeLessThanOrEqual(memoryPolicy.contextTokens);
  expect(result.audit.candidates.length).toBeGreaterThan(
    result.audit.selectedIds.length,
  );
  expect(result.audit.omitted.length).toBeGreaterThan(0);
  expect(result.audit.fallback).toBe("Indexes pending");
});
test("essential overflow is explicit rather than silently dropping due obligations", () => {
  const data = input();
  data.counts.due = memoryPolicy.maxObligations + 1;
  expect(() => assembleContext(data)).toThrow("obligations");
});
test("source coverage includes retained initial, recent and pending evidence", () => {
  const data = input();
  data.base.memories = {
    initial: [{ id: "seed-x", content: "A seed" }],
    recent: [{ id: "recent-x", content: "Recent observation" }],
  };
  data.pending = {
    episodes: ["pending-episode"],
    sources: [{ ...data.evidence[0]!, id: "pending-x" }],
  };
  const { audit } = assembleContext(data);
  expect(audit.selectedSourceIds).toContain("seed-x");
  expect(audit.selectedSourceIds).toContain("recent-x");
  expect(audit.selectedSourceIds).toContain("pending-x");
});
