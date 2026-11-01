// Real Neon and deterministic, explicitly labeled extraction/vector responses. No paid inference.
import { test, expect } from "bun:test";
import "@repo/db/env";
import { createDatabase } from "@repo/db";
import { and, desc, eq } from "drizzle-orm";
import { memories, memoryTasks } from "@repo/db/tables";
import {
  agentPolicy,
  memoryPolicy,
  parseScenario,
  type AgreementCandidate,
  type Command,
  type MemoryCallAnswer,
  type MemoryExtraction,
} from "@repo/contracts";
import { WorldStore } from "./world-store";
import { MemoryStore } from "./memory-store";
import { MemoryWorkStore } from "./memory-work-store";
import { publishMemoryAnswer } from "./memory-publication";
import scenario from "../../../experiments/scenarios/dev/town.json";
const live = process.env.RUN_INTEGRATION === "1" ? test : test.skip;

live(
  "published agreement amendments and indexes preserve earlier knowledge and exact replay",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const worlds = new WorldStore(db),
      memory = new MemoryStore(db),
      work = new MemoryWorkStore(db),
      owner = crypto.randomUUID();
    let runId = "";
    const execute = async (command: Command) => {
      const generation = await worlds.claim(runId, owner);
      return worlds.execute(runId, owner, generation, command);
    };
    try {
      const input = parseScenario(scenario),
        self = input.citizens[0]!,
        peer = input.citizens[1]!;
      self.inventory.food = 10;
      peer.position = { x: self.position.x + 1, y: self.position.y };
      runId = (
        await worlds.create(input, "memory-publication-fixture", undefined, {
          provider: "fixture",
          citizenId: self.id,
          model: agentPolicy.model,
          maxRequests: 40,
          spendingLimitMicroUsd: 100000,
          memory: true,
        })
      ).state.runId;
      await execute({
        id: "promise",
        action: {
          kind: "say",
          actorId: self.id,
          audienceIds: [peer.id],
          text: "I will bring six food by 18:00.",
        },
      });
      await execute({
        id: "accept",
        action: {
          kind: "say",
          actorId: peer.id,
          audienceIds: [self.id],
          text: "Agreed.",
        },
      });
      const atAgreement = (await worlds.current(runId)).state;
      const sources = (
        await memory.sources(runId, self.id, atAgreement.sequence)
      ).sort((a, b) => a.sequence - b.sequence);
      const origin = sources.find(
        (source) =>
          source.actorId === self.id && source.kind === "speech.delivered",
      )!;
      const initialAccept = sources.find(
        (source) =>
          source.actorId === peer.id && source.kind === "speech.delivered",
      )!;
      const proposal: AgreementCandidate = {
        operation: "agree",
        originSourceId: origin.id,
        commitmentId: null,
        debtorId: self.id,
        creditorId: peer.id,
        resource: "food",
        amount: 6,
        deadlineMs: 64800000,
        proposal: {
          sourceId: origin.id,
          quote: "I will bring six food by 18:00.",
        },
        acceptance: { sourceId: initialAccept.id, quote: "Agreed." },
        termsEvidence: [
          { sourceId: origin.id, quote: "I will bring six food by 18:00." },
        ],
      };
      async function extract(candidate: AgreementCandidate) {
        const state = (await worlds.current(runId)).state;
        const [task] = await db
          .select({ id: memoryTasks.id })
          .from(memoryTasks)
          .innerJoin(memories, eq(memories.id, memoryTasks.memoryId))
          .where(
            and(
              eq(memories.runId, runId),
              eq(memoryTasks.operation, "extract"),
            ),
          )
          .orderBy(desc(memoryTasks.cutoff))
          .limit(1);
        const claimed = (await work.begin(
          task!.id,
          crypto.randomUUID(),
          true,
        ))!;
        const observed = await memory.sources(
          runId,
          self.id,
          claimed.payload.cutoff,
        );
        const data: MemoryExtraction = {
          title: "Food agreement",
          summary:
            "The residents discussed a food agreement; exact terms remain linked to sources.",
          summaryEvidence: [{ sourceId: origin.id, quote: "six food" }],
          agreements: [candidate],
          claims: [],
        };
        const answer: MemoryCallAnswer = {
          model: memoryPolicy.extractionModel,
          data,
          inputTokens: 200,
          cachedTokens: 0,
          outputTokens: 100,
        };
        await work.reserveCall(runId, self.id, claimed.guard, "main", {
          kind: "extract",
          model: memoryPolicy.extractionModel,
          instructions: "Fixture",
          input: JSON.stringify({ sources: observed }),
          inputTokens: 200,
        });
        await work.saveAnswer(runId, claimed.guard, "main", answer);
        const result = await publishMemoryAnswer(
          db,
          claimed.guard,
          claimed.payload,
          answer,
        );
        expect(result.rejected).toEqual([]);
        expect((await worlds.current(runId)).state.simTimeMs).toBe(
          state.simTimeMs,
        );
        return result.sequence;
      }
      const firstPublication = await extract(proposal);
      console.log(`Memory publication ${runId}: initial agreement`);
      expect(
        await memory.commitments(runId, self.id, atAgreement.sequence),
      ).toEqual([]);
      const [accepted] = await memory.commitments(
        runId,
        self.id,
        firstPublication,
      );
      expect(accepted!.deadlineMs).toBe(64800000);
      const summary = (
        await memory.list(runId, self.id, firstPublication)
      ).find((item) => item.payload.interpretation)!;
      const vector = Array.from({ length: memoryPolicy.dimensions }, (_, i) =>
        i === 0 ? 1 : 0,
      );
      expect(
        (await memory.search(runId, self.id, firstPublication, "food", vector))
          .mode,
      ).toBe("text");
      console.log(`Memory publication ${runId}: pre-index fallback`);
      const [embeddingTask] = await db
        .select({ id: memoryTasks.id })
        .from(memoryTasks)
        .where(
          and(
            eq(memoryTasks.memoryId, summary.id),
            eq(memoryTasks.operation, "embed"),
          ),
        )
        .limit(1);
      const indexed = (await work.begin(
        embeddingTask!.id,
        "index-worker",
        true,
      ))!;
      const answer: MemoryCallAnswer = {
        model: memoryPolicy.embeddingModel,
        data: vector,
        inputTokens: 20,
        cachedTokens: 0,
        outputTokens: 0,
      };
      await work.reserveCall(runId, self.id, indexed.guard, "main", {
        kind: "embed",
        model: memoryPolicy.embeddingModel,
        instructions: "",
        input: summary.searchText,
        inputTokens: 20,
      });
      await work.saveAnswer(runId, indexed.guard, "main", answer);
      const indexPublication = await publishMemoryAnswer(
        db,
        indexed.guard,
        indexed.payload,
        answer,
      );
      console.log(`Memory publication ${runId}: vector published`);
      const hybrid = await memory.search(
        runId,
        self.id,
        indexPublication.sequence,
        "provisions",
        vector,
      );
      expect(hybrid.mode).toBe("hybrid");
      expect(
        hybrid.candidates.some(
          (item) =>
            item.memory.id === summary.id && item.channels.includes("vector"),
        ),
      ).toBeTrue();
      await execute({
        id: "amend-proposal",
        action: {
          kind: "say",
          actorId: peer.id,
          audienceIds: [self.id],
          text: "Can we move the deadline to 19:00?",
        },
      });
      const pendingState = (await worlds.current(runId)).state;
      const change = (
        await memory.sources(runId, self.id, pendingState.sequence)
      ).find(
        (source) => source.utterance === "Can we move the deadline to 19:00?",
      )!;
      const amend: AgreementCandidate = {
        ...proposal,
        originSourceId: change.id,
        operation: "amend",
        commitmentId: accepted!.logicalId,
        deadlineMs: 68400000,
        proposal: {
          sourceId: change.id,
          quote: "Can we move the deadline to 19:00?",
        },
        acceptance: null,
        termsEvidence: [
          { sourceId: change.id, quote: "Can we move the deadline to 19:00?" },
        ],
      };
      const pendingPublication = await extract(amend);
      console.log(`Memory publication ${runId}: pending amendment`);
      expect(
        (await memory.commitments(runId, self.id, pendingPublication))[0]!
          .deadlineMs,
      ).toBe(64800000);
      await execute({
        id: "amend-accept",
        action: {
          kind: "say",
          actorId: self.id,
          audienceIds: [peer.id],
          text: "Yes, agreed.",
        },
      });
      const response = (
        await memory.sources(
          runId,
          self.id,
          (await worlds.current(runId)).state.sequence,
        )
      ).find((source) => source.utterance === "Yes, agreed.")!;
      const secondPublication = await extract({
        ...amend,
        acceptance: { sourceId: response.id, quote: "Yes, agreed." },
      });
      expect(
        (await memory.commitments(runId, self.id, secondPublication))[0]!
          .deadlineMs,
      ).toBe(68400000);
      expect(
        (await memory.commitments(runId, self.id, secondPublication))[0]!
          .originSourceId,
      ).toBe(origin.id);
      expect(
        (await memory.commitments(runId, self.id, firstPublication))[0]!
          .deadlineMs,
      ).toBe(64800000);
      const transferred = await execute({
        id: "fulfill-agreement",
        action: {
          kind: "transfer",
          actorId: self.id,
          targetId: peer.id,
          resource: "food",
          amount: 6,
        },
      });
      expect(transferred.receipt.status).toBe("accepted");
      expect(
        (
          await memory.commitments(runId, self.id, transferred.state.sequence)
        )[0]!.status,
      ).toBe("fulfilled");
      expect(
        (await memory.commitments(runId, self.id, secondPublication))[0]!
          .status,
      ).toBe("accepted");
      const incomingText = "I will bring four food by 20:00.";
      await execute({
        id: "incoming-offer",
        action: {
          kind: "say",
          actorId: peer.id,
          audienceIds: [self.id],
          text: incomingText,
        },
      });
      await execute({
        id: "incoming-acceptance",
        action: {
          kind: "say",
          actorId: self.id,
          audienceIds: [peer.id],
          text: "Yes, agreed.",
        },
      });
      const incomingSources = await memory.sources(
        runId,
        self.id,
        (await worlds.current(runId)).state.sequence,
      );
      const incomingOffer = incomingSources.find(
        (source) => source.utterance === incomingText,
      )!;
      const incomingAcceptance = incomingSources.find(
        (source) =>
          source.utterance === "Yes, agreed." &&
          source.sequence > incomingOffer.sequence,
      )!;
      const incomingPublication = await extract({
        ...proposal,
        debtorId: peer.id,
        creditorId: self.id,
        amount: 4,
        deadlineMs: 72000000,
        originSourceId: incomingOffer.id,
        proposal: { sourceId: incomingOffer.id, quote: incomingText },
        acceptance: { sourceId: incomingAcceptance.id, quote: "Yes, agreed." },
        termsEvidence: [{ sourceId: incomingOffer.id, quote: incomingText }],
      });
      const incomingCommitment = (
        await memory.commitments(runId, self.id, incomingPublication)
      ).find((item) => item.debtorId === peer.id)!;
      expect(incomingCommitment.status).toBe("accepted");
      const received = await execute({
        id: "receive-fulfillment",
        action: {
          kind: "transfer",
          actorId: peer.id,
          targetId: self.id,
          resource: "food",
          amount: 4,
        },
      });
      expect(received.receipt.status).toBe("accepted");
      expect(
        (
          await memory.commitments(runId, self.id, received.state.sequence)
        ).find((item) => item.logicalId === incomingCommitment.logicalId)!
          .status,
      ).toBe("fulfilled");
      expect(
        await memory.read(
          runId,
          input.citizens[2]!.id,
          secondPublication,
          summary.id,
        ),
      ).toBeNull();
      expect((await worlds.load(runId)).stateHash).toBe(
        (await worlds.current(runId)).stateHash,
      );
      console.log(`Memory publication fixture ${runId}`);
    } finally {
      if (runId) {
        const generation = await worlds.claim(runId, owner);
        await worlds.release(runId, owner, generation);
      }
      await pool.end();
    }
  },
  120000,
);
