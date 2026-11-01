import { test, expect } from "bun:test";
import { createOpenAIModel, ModelRequestRejected } from "./openai";
import { agentPolicy } from "@repo/contracts";

test("a rejected quota request is distinguishable from an uncertain in-flight inference", async () => {
  let requests = 0;
  const model = createOpenAIModel(
    "test-only-key",
    agentPolicy.model,
    async () => {
      requests++;
      return new Response(
        JSON.stringify({
          error: {
            message: "You have no credits remaining.",
            type: "insufficient_quota",
            code: "insufficient_quota",
            param: null,
          },
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      );
    },
  );
  await expect(
    model.respond(
      { instructions: "fixture", context: "{}", history: [], inputTokens: 10 },
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(ModelRequestRejected);
  expect(requests).toBe(1);
});

for (const status of ["completed", "incomplete"] as const) {
  test(`the Responses adapter preserves tool identity and usage for a ${status} response`, async () => {
    const model = createOpenAIModel(
      "test-only-key",
      agentPolicy.model,
      async (_url, init) => {
        expect(String(init?.body)).not.toContain("test-only-key");
        return new Response(
          JSON.stringify({
            id: "resp-fixture",
            status,
            model: agentPolicy.model,
            output: [
              {
                type: "function_call",
                call_id: "call-fixture",
                name: "time_wait",
                arguments: '{"durationMs":1000}',
              },
            ],
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              input_tokens_details: { cached_tokens: 10 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    const result = await model.respond(
      { instructions: "fixture", context: "{}", history: [], inputTokens: 100 },
      new AbortController().signal,
    );
    expect(result.completion).toBe(status);
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(20);
    expect(result.cachedTokens).toBe(10);
    expect(result.call).toEqual(
      status === "completed"
        ? {
            callId: "call-fixture",
            name: "time_wait",
            arguments: '{"durationMs":1000}',
          }
        : null,
    );
  });
}
