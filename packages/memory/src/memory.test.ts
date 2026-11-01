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
