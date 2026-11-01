import {
  contentHash,
  type AgentGuard,
  type Command,
  type Receipt,
  type ToolOutcome,
  type WorldState,
} from "@repo/contracts";
import { citizenView } from "@repo/engine";
import { AgentStore, ThinkingError, type WorldStore } from "@repo/storage";
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
  constructor(
    readonly worlds: WorldStore,
    readonly agents: AgentStore,
    readonly port: WorldPort,
    readonly world: WorldState,
    readonly guard: AgentGuard,
    readonly boundary: number,
  ) {}
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
      if (tool === "memory_search") {
        if (++this.searches > 2)
          return { status: "rejected", reason: "Memory search limit reached." };
        const query = String(args.query).toLowerCase();
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
              ? state.jobs[view.self.actionId]
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
          if (
            !(await this.agents.readEvidence(
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
          longAction &&
          result.receipt.status === "accepted" &&
          job?.status === "running",
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
          job,
          observations: personal,
        },
      };
    } catch (error) {
      if (error instanceof ThinkingError) throw error;
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
