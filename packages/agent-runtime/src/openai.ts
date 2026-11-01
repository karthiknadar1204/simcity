import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { getEncoding } from "js-tiktoken";
import { agentPolicy, type ModelAnswer } from "@repo/contracts";
import { tools } from "./tools";
const encoding = getEncoding("o200k_base");
export type ModelRequest = {
  instructions: string;
  context: string;
  history: unknown[];
  inputTokens: number;
};
export function countInput(request: Omit<ModelRequest, "inputTokens">) {
  return (
    encoding.encode(
      JSON.stringify({
        instructions: request.instructions,
        tools,
        input: [{ role: "user", content: request.context }, ...request.history],
      }),
    ).length + 128
  );
}
export interface CitizenModel {
  respond(request: ModelRequest, signal: AbortSignal): Promise<ModelAnswer>;
}
export function createOpenAIModel(
  apiKey: string,
  model: string = agentPolicy.model,
): CitizenModel {
  if (![agentPolicy.model, "gpt-5.4-mini"].includes(model))
    throw new Error(
      "Configure a verified model pricing profile before using another actor model.",
    );
  const client = new OpenAI({
    apiKey,
    maxRetries: 0,
    timeout: agentPolicy.timeoutMs,
  });
  return {
    async respond(request, signal) {
      const response = await client.responses.create(
        {
          model,
          store: false,
          instructions: request.instructions,
          input: [
            { role: "user", content: request.context },
            ...request.history,
          ] as ResponseInputItem[],
          tools,
          parallel_tool_calls: false,
          reasoning: { effort: "none" },
          text: { verbosity: "low" },
          max_output_tokens: agentPolicy.maxOutputTokens,
        },
        { signal },
      );
      if (response.status !== "completed" || !response.usage)
        throw new Error("Model response did not complete with usage.");
      const calls = response.output.filter(
        (item) => item.type === "function_call",
      );
      if (calls.length > 1)
        throw new Error("Actor returned multiple simultaneous actions.");
      const call = calls[0];
      return {
        responseId: response.id,
        model: response.model,
        output: response.output,
        call: call
          ? { callId: call.call_id, name: call.name, arguments: call.arguments }
          : null,
        inputTokens: response.usage.input_tokens,
        cachedTokens: response.usage.input_tokens_details.cached_tokens,
        outputTokens: response.usage.output_tokens,
      };
    },
  };
}
