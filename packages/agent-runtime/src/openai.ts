import OpenAI, { type ClientOptions } from "openai";
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
export class ModelRequestRejected extends Error {}
export function createOpenAIModel(
  apiKey: string,
  model: string = agentPolicy.model,
  fetcher?: ClientOptions["fetch"],
): CitizenModel {
  if (![agentPolicy.model, "gpt-5.4-mini"].includes(model))
    throw new Error(
      "Configure a verified model pricing profile before using another actor model.",
    );
  const client = new OpenAI({
    apiKey,
    maxRetries: 0,
    timeout: agentPolicy.timeoutMs,
    ...(fetcher ? { fetch: fetcher } : {}),
  });
  return {
    async respond(request, signal) {
      const response = await client.responses
        .create(
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
        )
        .catch((error: unknown) => {
          if (
            error instanceof OpenAI.APIError &&
            error.status &&
            [400, 401, 403, 404, 422, 429].includes(error.status)
          )
            throw new ModelRequestRejected(
              error.message.replaceAll(apiKey, "[redacted]"),
              { cause: error },
            );
          throw error;
        });
      if (!response.usage)
        throw new Error("Model response did not include usage.");
      const calls = response.output.filter(
        (item) => item.type === "function_call",
      );
      if (calls.length > 1)
        throw new Error("Actor returned multiple simultaneous actions.");
      const call = calls[0];
      return {
        completion:
          response.status === "completed" ? "completed" : "incomplete",
        responseId: response.id,
        model: response.model,
        output: response.output,
        call:
          call && response.status === "completed"
            ? {
                callId: call.call_id,
                name: call.name,
                arguments: call.arguments,
              }
            : null,
        inputTokens: response.usage.input_tokens,
        cachedTokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
        outputTokens: response.usage.output_tokens,
      };
    },
  };
}
