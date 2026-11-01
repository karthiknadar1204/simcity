import type {
  AgreementCandidate,
  ClaimCandidate,
  CommitmentRecord,
  EvidenceQuote,
  MemorySource,
  MemoryRecord,
  RetrievedMemory,
} from "@repo/contracts";

export function validateQuotes(
  quotes: EvidenceQuote[],
  sources: MemorySource[],
  citizenId: string,
  cutoff: number,
): MemorySource[] {
  if (!quotes.length) throw new Error("Evidence is required.");
  return quotes.map((quote) => {
    const source = sources.find(
      (item) =>
        item.id === quote.sourceId &&
        item.citizenId === citizenId &&
        item.sequence <= cutoff,
    );
    if (!source || !quote.quote.trim() || !source.content.includes(quote.quote))
      throw new Error(
        "Evidence is inaccessible, from the future, or not an exact quote.",
      );
    return source;
  });
}

const hedged =
  /\b(maybe|might|possibly|perhaps|tentatively|if|not|cannot|can't|won't|never|refuse|decline)\b/i;
const affirmative =
  /^(?:yes\b|agreed\b|i agree\b|okay\b|ok\b|accepted\b|sounds good\b|that works\b|we agree\b)/i;
const smallNumbers = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
];
function normalizeNumbers(text: string) {
  return text.toLowerCase().replace(/\b[a-z]+\b/g, (word) => {
    const number = smallNumbers.indexOf(word);
    return number < 0 ? word : String(number);
  });
}
export function deadlineFromQuote(
  text: string,
  sourceTimeMs: number,
  dayLengthMs: number,
): number | null {
  const explicit = /\b\d{7,16}\b/.exec(text);
  if (explicit && Number.isSafeInteger(Number(explicit[0])))
    return Number(explicit[0]);
  const time = /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i.exec(text);
  const shortTime = /\b(\d{1,2})\s*(am|pm)\b/i.exec(text);
  if (!time && !shortTime) return null;
  let hour = Number((time ?? shortTime)![1]);
  const minute = time ? Number(time[2]) : 0;
  const suffix = (time?.[3] ?? shortTime?.[2])?.toLowerCase();
  if (minute > 59 || hour > (suffix ? 12 : 23)) return null;
  if (suffix) hour = (hour % 12) + (suffix === "pm" ? 12 : 0);
  const explicitDay = /\bday\s+(\d+)\b/i.exec(text);
  const day = explicitDay
    ? Number(explicitDay[1]) - 1
    : Math.floor(sourceTimeMs / dayLengthMs) +
      (/\btomorrow\b/i.test(text) ? 1 : 0);
  return day < 0 ? null : day * dayLengthMs + hour * 3600000 + minute * 60000;
}

export function validateAgreement(
  candidate: AgreementCandidate,
  sources: MemorySource[],
  citizenId: string,
  cutoff: number,
  dayLengthMs: number,
  existing: CommitmentRecord | null,
) {
  const quotes = [
    candidate.proposal,
    ...candidate.termsEvidence,
    ...(candidate.acceptance ? [candidate.acceptance] : []),
  ];
  const referenced = validateQuotes(quotes, sources, citizenId, cutoff);
  const proposal = referenced[0]!;
  const origin = sources.find(
    (item) =>
      item.id === candidate.originSourceId &&
      item.citizenId === citizenId &&
      item.sequence <= cutoff,
  );
  const parties = [candidate.debtorId, candidate.creditorId];
  if (
    !origin ||
    parties[0] === parties[1] ||
    !parties.includes(citizenId) ||
    proposal.kind !== "speech.delivered" ||
    !proposal.actorId ||
    !parties.includes(proposal.actorId)
  )
    throw new Error("A commitment requires the actual participating parties.");
  if (candidate.operation === "amend" || candidate.operation === "cancel") {
    if (
      !existing ||
      candidate.commitmentId !== existing.logicalId ||
      existing.originSourceId !== candidate.originSourceId ||
      existing.debtorId !== candidate.debtorId ||
      existing.creditorId !== candidate.creditorId ||
      existing.resource !== candidate.resource
    )
      throw new Error(
        "Amendment does not identify an existing personal agreement.",
      );
  }
  if (
    candidate.commitmentId &&
    existing &&
    candidate.commitmentId !== existing.logicalId
  )
    throw new Error("Commitment identity changed.");
  if (candidate.operation !== "cancel") {
    const quantitySupported =
      candidate.termsEvidence.some((evidence) => {
        const words = normalizeNumbers(evidence.quote).split(/[^a-z0-9_-]+/);
        const resourceIndex = words.indexOf(candidate.resource.toLowerCase());
        return (
          resourceIndex > 0 &&
          words
            .slice(Math.max(0, resourceIndex - 4), resourceIndex)
            .includes(String(candidate.amount))
        );
      }) ||
      Boolean(
        existing &&
        candidate.amount === existing.amount &&
        candidate.resource === existing.resource,
      );
    if (!quantitySupported)
      throw new Error("Quantity/resource is not supported by exact evidence.");
    if (
      candidate.deadlineMs !== null &&
      !(existing?.deadlineMs === candidate.deadlineMs) &&
      !candidate.termsEvidence.some((evidence) => {
        const source = sources.find((item) => item.id === evidence.sourceId)!;
        return (
          deadlineFromQuote(evidence.quote, source.simTimeMs, dayLengthMs) ===
          candidate.deadlineMs
        );
      })
    )
      throw new Error("Deadline is not supported by the source calendar.");
  } else if (!/\b(cancel|call off)\b/i.test(proposal.content)) {
    throw new Error("Cancellation requires explicit cancellation evidence.");
  }
  if (
    existing &&
    candidate.operation === "cancel" &&
    (candidate.amount !== existing.amount ||
      candidate.deadlineMs !== existing.deadlineMs)
  )
    throw new Error("Cancellation cannot silently change terms.");
  const acceptance = candidate.acceptance
    ? referenced[referenced.length - 1]!
    : null;
  if (
    acceptance &&
    (acceptance.kind !== "speech.delivered" ||
      !acceptance.actorId ||
      !parties.includes(acceptance.actorId) ||
      acceptance.actorId === proposal.actorId ||
      acceptance.sequence <= proposal.sequence)
  )
    throw new Error(
      "Agreement requires a later acceptance by the other party.",
    );
  const accepted =
    candidate.operation !== "propose" &&
    Boolean(
      acceptance &&
      affirmative.test(candidate.acceptance!.quote.trim()) &&
      !hedged.test(acceptance.content) &&
      !hedged.test(proposal.content),
    );
  return {
    accepted,
    sourceIds: [...new Set(referenced.map((source) => source.id))],
    effectiveSequence: Math.max(...referenced.map((source) => source.sequence)),
    candidate,
  };
}

export function validateClaim(
  candidate: ClaimCandidate,
  sources: MemorySource[],
  citizenId: string,
  cutoff: number,
) {
  const evidence = validateQuotes(
    candidate.evidence,
    sources,
    citizenId,
    cutoff,
  );
  const allowed = new Set(
    evidence.flatMap((source) => [
      ...source.entityIds,
      ...source.participantIds,
    ]),
  );
  if (candidate.entityIds.some((id) => !allowed.has(id)))
    throw new Error("Claim mentions an unsupported entity.");
  if (candidate.kind === "routine") {
    const completions = new Set(
      evidence
        .filter(
          (source) =>
            source.actorId === citizenId &&
            source.result?.status === "completed",
        )
        .map((source) => source.result!.jobId),
    );
    if (completions.size < 2)
      throw new Error(
        "A routine requires distinct successful personal experiences.",
      );
  }
  return [...new Set(evidence.map((source) => source.id))];
}

export function episodeKey(source: MemorySource): string {
  if (source.kind === "speech.delivered")
    return `conversation:${[...new Set(source.participantIds)].sort().join(":")}`;
  const jobId = source.result?.jobId ?? source.receipt?.jobId;
  return jobId
    ? `activity:${jobId}`
    : `${source.kind}:${source.actorId ?? "world"}:${[...source.entityIds].sort().join(":")}`;
}

export function diverseMemories(
  items: RetrievedMemory[],
  limit: number,
): RetrievedMemory[] {
  const selected: RetrievedMemory[] = [],
    ids = new Set<string>(),
    evidence = new Set<string>();
  for (const item of [...items].sort(
    (a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id),
  )) {
    if (selected.length >= limit) break;
    if (
      ids.has(item.memory.id) ||
      (item.memory.sourceIds.length &&
        item.memory.sourceIds.every((id) => evidence.has(id)))
    )
      continue;
    selected.push(item);
    ids.add(item.memory.id);
    for (const id of item.memory.sourceIds) evidence.add(id);
  }
  return selected;
}

export function currentAt(
  memory: Pick<MemoryRecord, "availableSequence" | "supersededSequence">,
  asOf: number,
): boolean {
  return (
    memory.availableSequence <= asOf &&
    (memory.supersededSequence === null || memory.supersededSequence > asOf)
  );
}
