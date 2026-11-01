import { test, expect } from "bun:test";
import { isTransientDatabaseError } from "./transport";
test("server timeouts can retry durable work while credentials, rules and explicit cancellation cannot", () => {
  expect(
    isTransientDatabaseError(
      new Error("Drizzle query failed", {
        cause: Object.assign(
          new Error("canceling statement due to statement timeout"),
          { code: "57014" },
        ),
      }),
    ),
  ).toBeTrue();
  expect(
    isTransientDatabaseError(
      Object.assign(new Error("canceling statement due to user request"), {
        code: "57014",
      }),
    ),
  ).toBeFalse();
  expect(
    isTransientDatabaseError(
      Object.assign(new Error("password authentication failed"), {
        code: "28P01",
      }),
    ),
  ).toBeFalse();
  expect(
    isTransientDatabaseError(
      new Error("Target does not support that capability"),
    ),
  ).toBeFalse();
});
