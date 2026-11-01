import { test, expect } from "bun:test";
import { memoryPolicy, type MemoryCallRequest } from "@repo/contracts";
import { createOpenAIMemoryModel } from "./openai";
import { ModelRequestRejected } from "../openai";

test("memory embeddings request a pinned model and matching dimensions", async () => {
  const vector = Array.from({ length: memoryPolicy.dimensions }, () => 0.1);
  const model = createOpenAIMemoryModel("test-only-key", async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(memoryPolicy.embeddingModel);
    expect(body.dimensions).toBe(memoryPolicy.dimensions);
    return new Response(
      JSON.stringify({
        model: memoryPolicy.embeddingModel,
        data: [{ index: 0, embedding: vector }],
        usage: { prompt_tokens: 12, total_tokens: 12 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  const result = await model.respond(
    {
      kind: "embed",
      model: memoryPolicy.embeddingModel,
      instructions: "",
      input: "A personal experience",
      inputTokens: 12,
    },
    new AbortController().signal,
  );
  expect(result.data).toEqual(vector);
  expect(result.inputTokens).toBe(12);
});

for (const status of ["completed", "incomplete"] as const) {
  test(`memory structured output preserves usage for ${status} responses`, async () => {
    const data = {
      title: "A received experience",
      summary: "A source was heard.",
      summaryEvidence: [{ sourceId: "1-a", quote: "Hello" }],
      agreements: [],
      claims: [],
    };
    const model = createOpenAIMemoryModel(
      "test-only-key",
      async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.store).toBeFalse();
        expect(body.text.format.type).toBe("json_schema");
        expect(body.text.format.strict).toBeTrue();
        return new Response(
          JSON.stringify({
            id: "response-fixture",
            object: "response",
            status,
            model: memoryPolicy.extractionModel,
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: JSON.stringify(data) }],
              },
            ],
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              input_tokens_details: { cached_tokens: 10 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    const result = await model.respond(
      {
        kind: "extract",
        model: memoryPolicy.extractionModel,
        instructions: "Fixture",
        input: "{}",
        inputTokens: 100,
      },
      new AbortController().signal,
    );
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.data).toEqual(status === "completed" ? data : null);
    expect(Boolean(result.error)).toBe(status !== "completed");
  });
}

test("a quota rejection makes one attempt and retains its known-rejection classification", async () => {
  let calls = 0;
  const model = createOpenAIMemoryModel("test-only-key", async () => {
    calls++;
    return new Response(
      JSON.stringify({
        error: {
          message: "Quota fixture",
          type: "insufficient_quota",
          code: "insufficient_quota",
        },
      }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  });
  const request: MemoryCallRequest = {
    kind: "extract",
    model: memoryPolicy.extractionModel,
    instructions: "Fixture",
    input: "{}",
    inputTokens: 20,
  };
  await expect(
    model.respond(request, new AbortController().signal),
  ).rejects.toBeInstanceOf(ModelRequestRejected);
  expect(calls).toBe(1);
});
