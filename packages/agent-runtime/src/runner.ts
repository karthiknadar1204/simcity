import { agentPolicy, activeConversation } from "@repo/contracts";
import {
  AgentStore,
  WorldStore,
  ThinkingError,
  isTransientDatabaseError,
} from "@repo/storage";
import { buildContext } from "./context";
import { citizenInstructions } from "./prompt";
import {
  countInput,
  ModelRequestRejected,
  type CitizenModel,
  type ModelRequest,
} from "./openai";
import { ToolBroker, type WorldPort } from "./broker";
import type { ContextCompiler } from "./memory/compiler";
import type { MemoryQueries } from "./memory/queries";
import { boundedRequest } from "./memory/compaction";

export class AgentRunner {
  readonly ownerId = crypto.randomUUID();
  constructor(
    readonly worlds: WorldStore,
    readonly agents: AgentStore,
    readonly port: WorldPort,
    readonly model: (id: string) => CitizenModel,
    readonly compiler?: ContextCompiler,
    readonly queries?: MemoryQueries,
  ) {}
  async run(taskId: string) {
    const claimed = await this.agents.begin(taskId, this.ownerId);
    if (!claimed) return;
    const { guard, state, configuration, turn } = claimed;
    let activeRound: number | null = null;
    const abort = new AbortController();
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.agents
        .heartbeat(guard)
        .then((valid) => {
          if (!valid) abort.abort();
        })
        .catch(() => abort.abort())
        .finally(() => {
          renewing = false;
        });
    }, 5000);
    try {
      let context = turn.context;
      const boundary = turn.boundarySequence ?? state.sequence;
      const frozen =
        boundary === state.sequence
          ? state
          : await this.worlds.atSequence(state.runId, boundary);
      if (!context) {
        if (configuration.memory) {
          if (!this.compiler)
            throw new Error("Memory context compiler is unavailable.");
          context = (await this.compiler.compile(frozen, guard, turn.reasons))
            .context;
        } else {
          const evidence = await this.agents.personalEvidence(
            state.runId,
            guard.citizenId,
            boundary,
          );
          context = buildContext(
            frozen,
            guard.citizenId,
            evidence,
            turn.reasons,
          );
          const memories = context.memories as {
            recent: unknown[];
            initial: unknown[];
          };
          while (
            countInput({
              instructions: citizenInstructions,
              context: JSON.stringify(context),
              history: [],
            }) > agentPolicy.contextTokens &&
            (memories.recent.length || memories.initial.length > 1)
          ) {
            if (memories.recent.length) memories.recent.pop();
            else memories.initial.pop();
          }
        }
        await this.agents.saveContext(state.runId, guard, context, boundary);
      }
      const broker = new ToolBroker(
        this.worlds,
        this.agents,
        this.port,
        frozen,
        guard,
        boundary,
        configuration.memory ? this.compiler?.memory : undefined,
        configuration.memory ? this.queries : undefined,
      );
      const saved = await this.agents.rounds(taskId);
      const history: unknown[] = [];
      const citizen = state.citizens[guard.citizenId]!;
      let allowTextOnly = citizen.actionId
        ? state.jobs[citizen.actionId]?.status === "running"
        : false;
      const conversation = activeConversation(state, guard.citizenId);
      if (conversation && conversation.nextSpeakerId !== guard.citizenId)
        allowTextOnly = true;
      for (let round = 0; round < agentPolicy.maxRounds; round++) {
        let record = saved.find((row) => row.round === round);
        if (!record) {
          const request: ModelRequest = boundedRequest(
            context,
            history,
            allowTextOnly,
          );
          record = await this.agents.reserveRound(
            state.runId,
            guard,
            round,
            request,
          );
          activeRound = round;
          const answer = await this.model(configuration.model).respond(
            request,
            abort.signal,
          );
          await this.agents.saveAnswer(state.runId, guard, round, answer);
          activeRound = null;
          record = { ...record, status: "responded", answer };
        } else if (
          record.status === "reserved" ||
          record.status === "uncertain"
        ) {
          if (record.status === "reserved")
            await this.agents.uncertain(state.runId, guard, round);
          await this.agents.finish(
            state.runId,
            guard,
            "Interrupted model request has uncertain delivery; charged conservatively. Retry explicitly.",
            "error",
          );
          return;
        }
        const answer = record.answer;
        if (!answer) throw new Error("Saved model answer is missing.");
        if (answer.completion === "incomplete") {
          await this.agents.finish(
            state.runId,
            guard,
            "Model output was incomplete; usage recorded and no partial action applied.",
            "error",
          );
          await this.port.execute(state.runId, {
            id: crypto.randomUUID(),
            action: { kind: "set-status", status: "paused" },
          });
          return;
        }
        history.push(...answer.output);
        if (!answer.call) {
          await this.agents.finish(state.runId, guard, "continued-or-idle");
          return;
        }
        const outcome =
          record.outcome ??
          (await broker.execute(
            answer.call.name,
            answer.call.arguments,
            round,
          ));
        if (!record.outcome)
          await this.agents.saveOutcome(state.runId, guard, round, outcome);
        broker.rememberOutcome(outcome);
        if (
          answer.call.name === "actions_cancel" &&
          outcome.status === "accepted"
        )
          allowTextOnly = false;
        if (answer.call.name === "memory_search" && record.outcome)
          broker.searches++;
        history.push({
          type: "function_call_output",
          call_id: answer.call.callId,
          output: JSON.stringify(outcome),
        });
        if (outcome.yield) {
          await this.agents.finish(state.runId, guard, "yielded-to-action");
          return;
        }
      }
      await this.agents.finish(
        state.runId,
        guard,
        "tool-round-limit; recorded review scheduled",
      );
    } catch (error) {
      if (activeRound !== null) {
        if (error instanceof ModelRequestRejected)
          await this.agents
            .rejectRound(state.runId, guard, activeRound)
            .catch(() => undefined);
        else
          await this.agents
            .uncertain(state.runId, guard, activeRound)
            .catch(() => undefined);
      }
      if (
        (error instanceof ThinkingError && error.code === "paused") ||
        isTransientDatabaseError(error)
      ) {
        await this.agents.park(guard).catch(() => undefined);
        return;
      }
      if (error instanceof ThinkingError && error.code === "stale") return;
      const limited =
        error instanceof ThinkingError && error.code === "limited";
      let detail =
        error instanceof Error
          ? error.message.split("\n")[0]!.slice(0, 500)
          : "Unknown thinking error";
      for (const [key, value] of Object.entries(process.env)) {
        if (
          value &&
          value.length > 10 &&
          /KEY|TOKEN|SECRET|DATABASE_URL/i.test(key)
        )
          detail = detail.replaceAll(value, "[redacted]");
      }
      const message = limited
        ? error.message
        : `Thinking failed: ${detail}. No successful action was invented.`;
      await this.agents
        .finish(state.runId, guard, message, limited ? "limited" : "error")
        .catch(() => undefined);
      if (limited || error instanceof ModelRequestRejected)
        await this.port.execute(state.runId, {
          id: crypto.randomUUID(),
          action: { kind: "set-status", status: "paused" },
        });
    } finally {
      clearInterval(timer);
      while (renewing) await Bun.sleep(10);
      await this.agents.releaseLease(guard).catch(() => undefined);
    }
  }
}
