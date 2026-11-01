import { expect, test } from "bun:test";
import { worldRoutes } from "./worlds";

test("the scenario catalog loads validated data without exposing held-out cases", async () => {
  const app = worldRoutes(null, null);
  const response = await app.request("/scenarios");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { scenarios: { id: string }[] };
  expect(body.scenarios.length).toBeGreaterThan(0);
  expect(
    body.scenarios.some((s: { id: string }) => s.id === "unfamiliar-town-v1"),
  ).toBeFalse();
});

test("operator authentication preserves its challenge and rejects foreign write origins", async () => {
  const previous = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "local-test-operator";
  try {
    const app = worldRoutes(null, null);
    const denied = await app.request("/scenarios");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("WWW-Authenticate")).toContain("Bearer");
    const permitted = await app.request("/scenarios", {
      headers: { Authorization: "Bearer local-test-operator" },
    });
    expect(permitted.status).toBe(200);
    const crossOrigin = await app.request("/runs", {
      method: "POST",
      headers: {
        Origin: "https://untrusted.example",
        Authorization: "Bearer local-test-operator",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ scenarioId: "unused" }),
    });
    expect(crossOrigin.status).toBe(403);
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previous;
  }
});
