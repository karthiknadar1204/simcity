import {
  contentHash,
  activeConversation,
  type AgentGuard,
  type Command,
  type Receipt,
  type ToolOutcome,
  type WorldState,
} from "@repo/contracts";
import { citizenView } from "@repo/engine";
import {
  AgentStore,
  ThinkingError,
  isTransientDatabaseError,
  type WorldStore,
  type MemoryStore,
} from "@repo/storage";
import type { MemoryQueries } from "./memory/queries";
import { jobView } from "./memory/compiler";
import { diverseMemories } from "@repo/memory";
import { actionFor, parseTool } from "./tools";
export interface WorldPort {
  execute(
    runId: string,
    command: Command,
    guard?: AgentGuard,
  ): Promise<{ state: WorldState; receipt: Receipt }>;
}
export class ToolBroker {
  searches = 0;
  private observedSources = new Map<string, number>();
  constructor(
    readonly worlds: WorldStore,
    readonly agents: AgentStore,
    readonly port: WorldPort,
    readonly world: WorldState,
    readonly guard: AgentGuard,
    readonly boundary: number,
    readonly memory?: MemoryStore,
    readonly queries?: MemoryQueries,
  ) {}
  rememberOutcome(outcome: ToolOutcome) {
    const data = outcome.data as
      | {
          asOfSequence?: number;
          observations?: {
            id: string;
            citizenId: string;
            eventSequence: number;
          }[];
        }
      | undefined;
    if (
      !data ||
      !Number.isSafeInteger(data.asOfSequence) ||
      !Array.isArray(data.observations)
    )
      return;
    for (const source of data.observations)
      if (
        typeof source.id === "string" &&
        source.citizenId === this.guard.citizenId &&
        Number.isSafeInteger(source.eventSequence) &&
        source.eventSequence >= 0 &&
        source.eventSequence <= data.asOfSequence!
      )
        this.observedSources.set(source.id, source.eventSequence);
  }
  async execute(
    name: string,
    input: string,
    round: number,
  ): Promise<ToolOutcome> {
    try {
      const { name: tool, args } = parseTool(name, input);
      const runId = this.world.runId,
        citizenId = this.guard.citizenId;
      const self = this.world.citizens[citizenId]!;
      if (tool === "world_find_places") {
        const visible = new Set(
          citizenView(this.world, citizenId).objects.map((object) => object.id),
        );
        const query = String(args.query).toLowerCase(),
          offset = Number(args.offset);
        const places = Object.values(this.world.objects).filter(
          (object) =>
            (self.knownEntityIds.includes(object.id) ||
              visible.has(object.id)) &&
            `${object.id} ${object.name} ${object.tags.join(" ")}`
              .toLowerCase()
              .includes(query),
        );
        return {
          status: "ok",
          data: {
            asOfSequence: this.boundary,
            total: places.length,
            places: places.slice(offset, offset + 20).map((object) => ({
              id: object.id,
              name: object.name,
              position: object.position,
              tags: object.tags,
              accessible: !object.ownerId || object.ownerId === citizenId,
            })),
            nextOffset: places.length > offset + 20 ? offset + 20 : null,
          },
        };
      }
      if (tool === "commitments_list")
        return this.memory
          ? {
              status: "ok",
              data: {
                asOfSequence: this.boundary,
                offset: args.offset,
                pageSize: 12,
                commitments: await this.memory.commitments(
                  runId,
                  citizenId,
                  this.boundary,
                  12,
                  Number(args.offset),
                ),
              },
            }
          : {
              status: "unavailable",
              reason: "This legacy run has no extracted commitment ledger.",
            };
      if (tool === "memory_search") {
        if (++this.searches > 2)
          return { status: "rejected", reason: "Memory search limit reached." };
        const query = String(args.query).toLowerCase();
        if (this.memory && this.queries) {
          const result = await this.queries.search(
            runId,
            citizenId,
            this.boundary,
            query,
            this.guard,
          );
          const selected = diverseMemories(result.candidates, 8);
          await this.memory.saveAudit(
            `ctx-${this.guard.taskId}-search-${this.searches}`,
            this.guard.taskId,
            runId,
            citizenId,
            this.boundary,
            {
              query,
              mode: result.mode,
              fallback: result.fallback,
              pendingIndexes: result.pendingIndexes,
              candidates: result.candidates.map((item) => ({
                id: item.memory.id,
                score: item.score,
                channels: item.channels,
                sourceIds: item.memory.sourceIds,
              })),
              selectedIds: selected.map((item) => item.memory.id),
              selectedSourceIds: [
                ...new Set(selected.flatMap((item) => item.memory.sourceIds)),
              ],
              omitted: result.candidates
                .filter((item) => !selected.includes(item))
                .map((item) => ({
                  id: item.memory.id,
                  reason: "redundant evidence or tool result limit",
                })),
              tokens: {},
            },
          );
          const related = await this.memory.commitmentsByLogicalIds(
            runId,
            citizenId,
            this.boundary,
            selected.flatMap((item) =>
              typeof item.memory.payload.commitmentId === "string"
                ? [item.memory.payload.commitmentId]
                : [],
            ),
          );
          return {
            status: "ok",
            data: {
              asOfSequence: this.boundary,
              mode: result.mode,
              fallback: result.fallback,
              pendingIndexes: result.pendingIndexes,
              relatedCommitmentState: related,
              memories: selected.map(({ memory, channels }) => ({
                id: memory.id,
                kind: memory.kind,
                certainty: memory.certainty,
                text: memory.text.slice(0, 800),
                truncated: memory.text.length > 800,
                sourceIds: memory.sourceIds,
                eventEndMs: memory.eventEndMs,
                availableSequence: memory.availableSequence,
                historicalExperience: true,
                channels,
              })),
            },
          };
        }
        const words = query.match(/[\p{L}\p{N}]+/gu) ?? [];
        const seeds = self.initialMemories
          .map((content, index) => ({
            id: `seed-${index}`,
            content,
            simTimeMs: 0,
          }))
          .filter((source) =>
            words.some((word) => source.content.toLowerCase().includes(word)),
          );
        const evidence = await this.agents.personalEvidence(
          runId,
          citizenId,
          this.boundary,
          8,
          query,
        );
        return {
          status: "ok",
          data: {
            asOfSequence: this.boundary,
            sources: [...seeds.slice(0, 4), ...evidence].slice(0, 8),
            variant: "personal-observation-search",
          },
        };
      }
      if (tool === "memory_read") {
        if (this.memory) {
          const found = await this.memory.read(
            runId,
            citizenId,
            this.observedSources.get(String(args.sourceId)) ?? this.boundary,
            String(args.sourceId),
          );
          if (!found)
            return {
              status: "unavailable",
              reason: "No accessible personal source at this boundary.",
            };
          if (found.kind === "memory")
            return {
              status: "ok",
              data: {
                kind: found.kind,
                current: found.current,
                id: found.memory.id,
                title: found.memory.title,
                text: found.memory.text.slice(0, 2400),
                truncated: found.memory.text.length > 2400,
                certainty: found.memory.certainty,
                sourceIds: found.memory.sourceIds,
                eventEndMs: found.memory.eventEndMs,
                availableSequence: found.memory.availableSequence,
              },
            };
          return { status: "ok", data: found };
        }
        const sourceId = String(args.sourceId),
          seed = /^seed-(\d+)$/.exec(sourceId);
        const content = seed
          ? self.initialMemories[Number(seed[1])]
          : undefined;
        const source = content
          ? { id: sourceId, content, simTimeMs: 0 }
          : await this.agents.readEvidence(
              runId,
              citizenId,
              this.boundary,
              sourceId,
            );
        return source
          ? { status: "ok", data: source }
          : {
              status: "unavailable",
              reason: "No accessible personal source at this boundary.",
            };
      }
      if (
        ["world_observe", "world_capabilities", "actions_status"].includes(tool)
      ) {
        const { state } = await this.worlds.current(runId);
        const view = citizenView(state, citizenId);
        if (
          tool !== "actions_status" &&
          view.self.actionId &&
          state.jobs[view.self.actionId]?.kind === "sleep"
        )
          return {
            status: "unavailable",
            reason:
              "The citizen is asleep; surroundings are not being observed.",
          };
        if (tool === "world_capabilities") {
          const object = view.objects.find(
            (entry) => entry.id === args.targetId,
          );
          return object && "capabilities" in object
            ? {
                status: "ok",
                data: {
                  object,
                  dedicatedSleepTool:
                    object.tags.includes("bed") &&
                    (!state.objects[object.id]!.ownerId ||
                      state.objects[object.id]!.ownerId === citizenId)
                      ? "time_sleep"
                      : null,
                  standingOnTarget:
                    object.position.x === view.self.position.x &&
                    object.position.y === view.self.position.y,
                  visibleOccupantId:
                    view.citizens.find(
                      (citizen) =>
                        citizen.position.x === object.position.x &&
                        citizen.position.y === object.position.y,
                    )?.id ?? null,
                  asOfSequence: state.sequence,
                  simTimeMs: state.simTimeMs,
                },
              }
            : {
                status: "unavailable",
                reason:
                  "Capability details require a nearby accessible object.",
              };
        }
        if (tool === "actions_status")
          return {
            status: "ok",
            data: view.self.actionId
              ? jobView(state.jobs[view.self.actionId])
              : { activity: "idle" },
          };
        return {
          status: "ok",
          data: {
            asOfSequence: state.sequence,
            simTimeMs: state.simTimeMs,
            self: {
              position: view.self.position,
              inventory: view.self.inventory,
              needs: view.self.needs,
              actionId: view.self.actionId,
            },
            citizens: view.citizens,
            objects: view.objects,
            localBlockedTiles: view.terrain,
          },
        };
      }
      if (tool === "plans_update") {
        for (const sourceId of args.evidenceIds as string[]) {
          const seed = /^seed-(\d+)$/.exec(sourceId);
          if (seed && self.initialMemories[Number(seed[1])]) continue;
          if (this.observedSources.has(sourceId)) continue;
          if (
            !(this.memory
              ? await this.memory.read(
                  runId,
                  citizenId,
                  this.boundary,
                  sourceId,
                )
              : await this.agents.readEvidence(
                  runId,
                  citizenId,
                  this.boundary,
                  sourceId,
                ))
          )
            return {
              status: "rejected",
              reason: "Plan cites an inaccessible source.",
            };
        }
      }
      const action = actionFor(tool, args, this.world, citizenId);
      if (!action)
        return { status: "rejected", reason: "Unsupported citizen tool." };
      const commandId = `a-${await contentHash({ taskId: this.guard.taskId, round })}`;
      const result = await this.port.execute(
        runId,
        { id: commandId, action },
        this.guard,
      );
      const citizen = result.state.citizens[citizenId]!;
      const job = citizen.actionId ? result.state.jobs[citizen.actionId] : null;
      const longAction = ["move", "interact", "wait", "sleep"].includes(
        action.kind,
      );
      const conversation = activeConversation(result.state, citizenId);
      const personal = await this.agents.personalEvidence(
        runId,
        citizenId,
        result.state.sequence,
        3,
      );
      return {
        status: result.receipt.status,
        reason: result.receipt.reason,
        yield:
          (result.receipt.status === "accepted" &&
            (action.kind === "conversation-start" ||
              action.kind === "conversation-reply") &&
            Boolean(
              conversation && conversation.nextSpeakerId !== citizenId,
            )) ||
          (longAction &&
            result.receipt.status === "accepted" &&
            job?.status === "running"),
        data: {
          receipt: result.receipt,
          asOfSequence: result.state.sequence,
          simTimeMs: result.state.simTimeMs,
          self: {
            position: citizen.position,
            inventory: citizen.inventory,
            needs: citizen.needs,
          },
          planVersion: citizen.plan?.version ?? 0,
          job: jobView(job),
          conversation,
          observations: personal,
        },
      };
    } catch (error) {
      if (error instanceof ThinkingError) throw error;
      if (isTransientDatabaseError(error))
        throw new ThinkingError(
          "paused",
          "Temporary database interruption; retry this saved tool request.",
        );
      // Ownership conflicts must be retried with the saved response, not treated as a citizen mistake.
      if (error instanceof Error && /ownership/i.test(error.message))
        throw new ThinkingError("paused", "Waiting for world ownership.");
      return {
        status: "rejected",
        reason:
          error instanceof Error
            ? error.message.slice(0, 240)
            : "Invalid tool request.",
      };
    }
  }
}
