import { agentPolicy } from "@repo/contracts";
import { ThinkingError } from "@repo/storage";
import { countInput, type ModelRequest } from "../openai";
import { citizenInstructions } from "../prompt";

// Deterministic compaction: the original compilation and every exact tool result
// remain in SQL. No generated summary replaces quantities, deadlines or receipts.
export function boundedRequest(
  context: Record<string, unknown>,
  history: unknown[],
  allowTextOnly: boolean,
): ModelRequest {
  const copy = structuredClone(context);
  copy.roundCompaction = {
    omittedOptionalItems: 0,
    fullCompilationRetained: true,
  };
  const memory = copy.memories as Record<string, unknown[]> | undefined;
  const request = () => ({
    instructions: citizenInstructions,
    context: JSON.stringify(copy),
    history: [...history],
    allowTextOnly,
  });
  let current = request(),
    inputTokens = countInput(current);
  while (inputTokens > agentPolicy.contextTokens) {
    const optional = ["retrieved", "evidence", "recent", "initial"]
      .map((key) => memory?.[key])
      .find((items) => Array.isArray(items) && items.length);
    if (!optional)
      throw new ThinkingError(
        "limited",
        "Essential context and exact tool results exceed the round budget. Narrow the decision explicitly.",
      );
    optional.pop();
    (copy.roundCompaction as { omittedOptionalItems: number })
      .omittedOptionalItems++;
    current = request();
    inputTokens = countInput(current);
  }
  return { ...current, inputTokens };
}
