import { test, expect } from "bun:test";
import type {
  AgreementCandidate,
  CommitmentRecord,
  MemorySource,
  RetrievedMemory,
} from "@repo/contracts";
import {
  validateAgreement,
  validateQuotes,
  episodeKey,
  currentAt,
  diverseMemories,
  validateClaim,
  normalizeAgreementCalendar,
  normalizeAgreementReference,
} from "./index";

const sources: MemorySource[] = [
  {
    id: "s1",
    citizenId: "a",
    sequence: 1,
    simTimeMs: 25200000,
    kind: "speech.delivered",
    content: "I will bring six food by 18:00.",
    actorId: "a",
    participantIds: ["a", "b"],
    entityIds: ["a", "b"],
  },
  {
    id: "s2",
    citizenId: "a",
    sequence: 2,
    simTimeMs: 25201000,
    kind: "speech.delivered",
    content: "Agreed.",
    actorId: "b",
    participantIds: ["a", "b"],
    entityIds: ["a", "b"],
  },
];
const proposal: AgreementCandidate = {
  operation: "agree",
  originSourceId: "s1",
  commitmentId: null,
  debtorId: "a",
  creditorId: "b",
  resource: "food",
  amount: 6,
  deadlineMs: 64800000,
  proposal: { sourceId: "s1", quote: sources[0]!.content },
  acceptance: { sourceId: "s2", quote: "Agreed." },
  termsEvidence: [{ sourceId: "s1", quote: sources[0]!.content }],
};

test("a definite agreement requires accessible exact evidence, both parties, and supported terms", () => {
  expect(
    validateAgreement(proposal, sources, "a", 2, 86400000, null).accepted,
  ).toBeTrue();
  expect(() =>
    validateQuotes(
      [{ sourceId: "s1", quote: "Invented content" }],
      sources,
      "a",
      2,
    ),
  ).toThrow();
  expect(() =>
    validateAgreement(proposal, sources, "other", 2, 86400000, null),
  ).toThrow();
  expect(() =>
    validateAgreement(proposal, sources, "a", 1, 86400000, null),
  ).toThrow();
  expect(() =>
    validateAgreement(
      { ...proposal, amount: 9 },
      sources,
      "a",
      2,
      86400000,
      null,
    ),
  ).toThrow();
  expect(() =>
    validateAgreement(
      { ...proposal, deadlineMs: 68400000 },
      sources,
      "a",
      2,
      86400000,
      null,
    ),
  ).toThrow();
});
test("a scoped existing agreement supplies its canonical origin without changing proposed terms", () => {
  const existing = {
    logicalId: "c1",
    originSourceId: "s1",
  } as CommitmentRecord;
  const amendment = {
    ...proposal,
    operation: "amend" as const,
    commitmentId: "c1",
    originSourceId: "s3",
    deadlineMs: 68400000,
  };
  expect(normalizeAgreementReference(amendment, existing)).toEqual({
    ...amendment,
    originSourceId: "s1",
  });
  expect(
    normalizeAgreementReference(
      { ...amendment, commitmentId: "foreign" },
      existing,
    ).originSourceId,
  ).toBe("s3");
});
test("calendar normalization uses exact unambiguous clock evidence instead of model arithmetic", () => {
  expect(
    normalizeAgreementCalendar(
      { ...proposal, deadlineMs: 61200000 },
      sources,
      "a",
      2,
      86400000,
      null,
    ).deadlineMs,
  ).toBe(64800000);
  expect(() =>
    normalizeAgreementCalendar(
      { ...proposal, proposal: { sourceId: "s1", quote: "by 19:00" } },
      sources,
      "a",
      2,
      86400000,
      null,
    ),
  ).toThrow();
});
test("extraction cannot silently erase an explicit deadline or invent a new commitment ID", () => {
  expect(() =>
    validateAgreement(
      { ...proposal, deadlineMs: null },
      sources,
      "a",
      2,
      86400000,
      null,
    ),
  ).toThrow("deadline");
  expect(() =>
    validateAgreement(
      { ...proposal, commitmentId: "command-id" },
      sources,
      "a",
      2,
      86400000,
      null,
    ),
  ).toThrow("identity");
});

test("a routine needs structured applicability and two distinct completed personal jobs", () => {
  const experiences = [
    {
      ...sources[0]!,
      kind: "action.completed",
      result: {
        jobId: "j1",
        kind: "work" as const,
        status: "completed" as const,
      },
    },
    {
      ...sources[0]!,
      id: "s3",
      sequence: 3,
      result: {
        jobId: "j2",
        kind: "work" as const,
        status: "completed" as const,
      },
    },
  ];
  const routine = {
    kind: "routine" as const,
    title: "A possible useful work pattern",
    text: "This worked twice under these conditions.",
    entityIds: [],
    evidence: experiences.map((source) => ({
      sourceId: source.id,
      quote: source.content,
    })),
    routine: {
      parameters: ["target"],
      steps: ["Inspect the target", "Use an advertised capability"],
      preconditions: ["Target accessible and inputs available"],
      limitations: ["Past success does not guarantee current stock"],
    },
  };
  expect(validateClaim(routine, experiences, "a", 3)).toEqual(["s1", "s3"]);
  expect(() =>
    validateClaim({ ...routine, routine: null }, experiences, "a", 3),
  ).toThrow("steps");
  expect(() =>
    validateClaim(
      routine,
      [experiences[0]!, { ...experiences[1]!, result: experiences[0]!.result }],
      "a",
      3,
    ),
  ).toThrow("distinct");
});

test("tentative, negated, third-party and unaccepted amendments cannot create accepted obligations", () => {
  const tentative = [
    { ...sources[0]!, content: "Maybe I can bring six food by 18:00." },
    sources[1]!,
  ];
  const uncertain = {
    ...proposal,
    proposal: { sourceId: "s1", quote: tentative[0]!.content },
    termsEvidence: [{ sourceId: "s1", quote: tentative[0]!.content }],
  };
  expect(
    validateAgreement(uncertain, tentative, "a", 2, 86400000, null).accepted,
  ).toBeFalse();
  expect(
    validateAgreement(
      { ...proposal, acceptance: null },
      sources,
      "a",
      2,
      86400000,
      null,
    ).accepted,
  ).toBeFalse();
  expect(() =>
    validateAgreement(
      proposal,
      [sources[0]!, { ...sources[1]!, actorId: "c" }],
      "a",
      2,
      86400000,
      null,
    ),
  ).toThrow();
  const negated = [sources[0]!, { ...sources[1]!, content: "Not agreed." }];
  expect(
    validateAgreement(
      { ...proposal, acceptance: { sourceId: "s2", quote: "Not agreed." } },
      negated,
      "a",
      2,
      86400000,
      null,
    ).accepted,
  ).toBeFalse();
  const existing = {
    logicalId: "c1",
    debtorId: "a",
    creditorId: "b",
    resource: "food",
    amount: 6,
    deadlineMs: 64800000,
    originSourceId: "s1",
    effectiveSequence: 2,
  } as CommitmentRecord;
  const amendmentSources = [
    ...sources,
    {
      ...sources[1]!,
      id: "s3",
      sequence: 3,
      content: "Can we move the deadline to 19:00?",
    },
    { ...sources[0]!, id: "s4", sequence: 4, content: "Yes, agreed." },
  ];
  const amend = {
    ...proposal,
    operation: "amend" as const,
    commitmentId: "c1",
    deadlineMs: 68400000,
    proposal: { sourceId: "s3", quote: amendmentSources[2]!.content },
    acceptance: { sourceId: "s4", quote: "Yes, agreed." },
    termsEvidence: [{ sourceId: "s3", quote: amendmentSources[2]!.content }],
  };
  expect(
    validateAgreement(amend, amendmentSources, "a", 4, 86400000, existing)
      .accepted,
  ).toBeTrue();
  expect(
    validateAgreement(
      { ...amend, acceptance: null },
      amendmentSources,
      "a",
      4,
      86400000,
      existing,
    ).accepted,
  ).toBeFalse();
});

test("publication, supersession, and grouping preserve historical knowledge boundaries", () => {
  expect(
    currentAt({ availableSequence: 10, supersededSequence: 20 }, 9),
  ).toBeFalse();
  expect(
    currentAt({ availableSequence: 10, supersededSequence: 20 }, 10),
  ).toBeTrue();
  expect(
    currentAt({ availableSequence: 10, supersededSequence: 20 }, 19),
  ).toBeTrue();
  expect(
    currentAt({ availableSequence: 10, supersededSequence: 20 }, 20),
  ).toBeFalse();
  expect(episodeKey(sources[0]!)).toBe(episodeKey(sources[1]!));
  expect(episodeKey({ ...sources[0]!, participantIds: ["a", "c"] })).not.toBe(
    episodeKey(sources[0]!),
  );
});

test("speaker labels do not prevent a real acceptance from being recognized", () => {
  expect(
    validateAgreement(
      {
        ...proposal,
        acceptance: { sourceId: "s2", quote: "Speaker: Agreed." },
      },
      [sources[0]!, { ...sources[1]!, content: "Speaker: Agreed." }],
      "a",
      2,
      86400000,
      null,
    ).accepted,
  ).toBeTrue();
});

test("an accepted quantity amendment can resolve a reference to existing terms", () => {
  const existing = {
    logicalId: "c1",
    debtorId: "a",
    creditorId: "b",
    resource: "food",
    amount: 3,
    deadlineMs: 64800000,
    originSourceId: "s1",
    effectiveSequence: 2,
  } as CommitmentRecord;
  const changed = [
    ...sources,
    { ...sources[1]!, id: "s3", sequence: 3, content: "Make it six instead." },
    { ...sources[0]!, id: "s4", sequence: 4, content: "Yes, agreed." },
  ];
  expect(
    validateAgreement(
      {
        ...proposal,
        operation: "amend",
        commitmentId: "c1",
        proposal: { sourceId: "s3", quote: "Make it six instead." },
        acceptance: { sourceId: "s4", quote: "Yes, agreed." },
        termsEvidence: [{ sourceId: "s3", quote: "Make it six instead." }],
      },
      changed,
      "a",
      4,
      86400000,
      existing,
    ).accepted,
  ).toBeTrue();
});

test("retrieval deduplicates repeated evidence while keeping distinct experiences", () => {
  const item = (id: string, evidence: string[], score: number) =>
    ({
      memory: { id, sourceIds: evidence },
      score,
      channels: ["text"],
    }) as RetrievedMemory;
  expect(
    diverseMemories(
      [
        item("episode", ["s1", "s2"], 4),
        item("reflection", ["s1", "s2"], 3),
        item("later", ["s3"], 2),
      ],
      2,
    ).map((i) => i.memory.id),
  ).toEqual(["episode", "later"]);
});
