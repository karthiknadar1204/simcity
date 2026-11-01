import OpenAI, { type ClientOptions } from "openai";
import {
  memoryPolicy,
  memoryExtractionSchema,
  type MemoryCallRequest,
  type MemoryCallAnswer,
} from "@repo/contracts";
import { z } from "zod";
import { getEncoding } from "js-tiktoken";
import { ModelRequestRejected } from "../openai";
export interface MemoryModel {
  respond(
    request: MemoryCallRequest,
    signal: AbortSignal,
  ): Promise<MemoryCallAnswer>;
}
const encoding = getEncoding("o200k_base"),
  embeddingEncoding = getEncoding("cl100k_base");
const schema = z.toJSONSchema(memoryExtractionSchema, {
  target: "draft-7",
}) as Record<string, unknown>;
delete schema.$schema;
export function memoryInputTokens(
  request: Omit<MemoryCallRequest, "inputTokens">,
) {
  return request.kind === "embed" || request.kind === "query"
    ? embeddingEncoding.encode(request.input).length + 16
    : encoding.encode(
        JSON.stringify({
          instructions: request.instructions,
          input: request.input,
          schema,
        }),
      ).length + 128;
}
export function createOpenAIMemoryModel(
  key: string,
  fetcher?: ClientOptions["fetch"],
): MemoryModel {
  const client = new OpenAI({
    apiKey: key,
    maxRetries: 0,
    timeout: memoryPolicy.timeoutMs,
    ...(fetcher ? { fetch: fetcher } : {}),
  });
  return {
    async respond(request, signal) {
      try {
        if (request.kind === "embed" || request.kind === "query") {
          const result = await client.embeddings.create(
            {
              model: memoryPolicy.embeddingModel,
              input: request.input,
              dimensions: memoryPolicy.dimensions,
              encoding_format: "float",
            },
            { signal },
          );
          const vector = result.data[0]?.embedding;
          const valid =
            vector?.length === memoryPolicy.dimensions &&
            vector.every((value) => Number.isFinite(value));
          return {
            model: result.model,
            data: valid ? vector! : null,
            inputTokens: result.usage.prompt_tokens,
            outputTokens: 0,
            cachedTokens: 0,
            ...(valid
              ? {}
              : {
                  error:
                    "Embedding output did not match the configured dimensions.",
                }),
          };
        }
        const result = await client.responses.create(
          {
            model: memoryPolicy.extractionModel,
            store: false,
            instructions: request.instructions,
            input: request.input,
            text: {
              format: {
                type: "json_schema",
                name: "citizen_memory_v1",
                strict: true,
                schema,
              },
              verbosity: "low",
            },
            reasoning: { effort: "none" },
            max_output_tokens: memoryPolicy.maxOutputTokens,
          },
          { signal },
        );
        if (!result.usage) throw new Error("Memory response omitted usage.");
        const rawText = result.output_text.slice(0, 32000);
        let data: MemoryCallAnswer["data"] = null,
          error: string | undefined;
        if (result.status !== "completed")
          error =
            "Memory output was incomplete; no interpretation was applied.";
        else if (!rawText)
          error = "Memory model refused or returned no structured output.";
        else {
          try {
            data = memoryExtractionSchema.parse(JSON.parse(rawText));
          } catch {
            error = "Memory output did not satisfy the extraction schema.";
          }
        }
        return {
          model: result.model,
          data,
          rawText,
          inputTokens: result.usage.input_tokens,
          cachedTokens: result.usage.input_tokens_details?.cached_tokens ?? 0,
          outputTokens: result.usage.output_tokens,
          ...(error ? { error } : {}),
        };
      } catch (error) {
        if (
          error instanceof OpenAI.APIError &&
          error.status &&
          [400, 401, 403, 404, 422, 429].includes(error.status)
        )
          throw new ModelRequestRejected(
            error.message.replaceAll(key, "[redacted]"),
            { cause: error },
          );
        throw error;
      }
    },
  };
}
