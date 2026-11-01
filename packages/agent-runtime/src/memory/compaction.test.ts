import { test, expect } from "bun:test";
import { boundedRequest } from "./compaction";
test("round compaction removes optional copies while preserving exact calls, errors and current terms", () => {
  const context = {
    obligations: { current: [{ amount: 6, deadlineMs: 68400000 }] },
    memories: {
      retrieved: Array.from({ length: 30 }, () => ({
        text: "old optional experience ".repeat(300),
      })),
      evidence: [],
      recent: [],
      initial: [],
    },
  };
  const history = [
    {
      type: "function_call",
      call_id: "call-1",
      name: "inventory_transfer",
      arguments: '{"amount":6}',
    },
    {
      type: "function_call_output",
      call_id: "call-1",
      output: JSON.stringify({
        status: "rejected",
        reason: "Only 2 units available",
        amount: 6,
      }),
    },
  ];
  const result = boundedRequest(context, history, false);
  expect(result.inputTokens).toBeLessThanOrEqual(8000);
  expect(result.history).toEqual(history);
  expect(JSON.parse(result.context).obligations.current[0].deadlineMs).toBe(
    68400000,
  );
  expect(context.memories.retrieved).toHaveLength(30);
  expect(
    JSON.parse(result.context).roundCompaction.omittedOptionalItems,
  ).toBeGreaterThan(0);
});
test("an oversized essential receipt fails explicitly", () => {
  expect(() =>
    boundedRequest(
      { obligations: { current: [] } },
      [
        {
          type: "function_call_output",
          call_id: "c",
          output: "exact evidence ".repeat(20000),
        },
      ],
      false,
    ),
  ).toThrow("Essential");
});
