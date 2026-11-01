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
