import { agentPolicy } from "@repo/contracts";
import { AgentStore, WorldStore, ThinkingError } from "@repo/storage";
import { buildContext } from "./context";
import { citizenInstructions } from "./prompt";
import { countInput, type CitizenModel, type ModelRequest } from "./openai";
import { ToolBroker, type WorldPort } from "./broker";

export class AgentRunner {
  readonly ownerId = crypto.randomUUID();
  constructor(
    readonly worlds: WorldStore,
    readonly agents: AgentStore,
    readonly port: WorldPort,
    readonly model: (id: string) => CitizenModel,
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
      if (!context) {
        const evidence = await this.agents.personalEvidence(
          state.runId,
          guard.citizenId,
          state.sequence,
        );
        context = buildContext(state, guard.citizenId, evidence, turn.reasons);
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
        await this.agents.saveContext(state.runId, guard, context, boundary);
      }
      const broker = new ToolBroker(
        this.worlds,
        this.agents,
        this.port,
        state,
        guard,
        boundary,
      );
      const saved = await this.agents.rounds(taskId);
      const history: unknown[] = [];
      for (let round = 0; round < agentPolicy.maxRounds; round++) {
        let record = saved.find((row) => row.round === round);
        if (!record) {
          const requestBase = {
            instructions: citizenInstructions,
            context: JSON.stringify(context),
            history: [...history],
          };
          const request: ModelRequest = {
            ...requestBase,
            inputTokens: countInput(requestBase),
          };
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
      if (activeRound !== null)
        await this.agents
          .uncertain(state.runId, guard, activeRound)
          .catch(() => undefined);
      if (error instanceof ThinkingError && error.code === "paused") {
        await this.agents.park(guard);
        return;
      }
      if (error instanceof ThinkingError && error.code === "stale") return;
      const limited =
        error instanceof ThinkingError && error.code === "limited";
      const message = limited
        ? error.message
        : `Thinking failed (${error instanceof Error ? error.name : "unknown"}); no successful action was invented.`;
      await this.agents
        .finish(state.runId, guard, message, limited ? "limited" : "error")
        .catch(() => undefined);
      if (limited)
        await this.port.execute(state.runId, {
          id: crypto.randomUUID(),
          action: { kind: "set-status", status: "paused" },
        });
    } finally {
      clearInterval(timer);
      while (renewing) await Bun.sleep(10);
    }
  }
}
