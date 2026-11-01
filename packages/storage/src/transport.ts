// Retry transport/serialization failures, never rules, credentials or schema errors.
export function isTransientDatabaseError(error: unknown): boolean {
  let current = error;
  for (
    let depth = 0;
    depth < 8 && current && typeof current === "object";
    depth++
  ) {
    const item = current as {
      message?: string;
      code?: string;
      cause?: unknown;
    };
    if (
      ["08000", "08003", "08006", "57P01", "40001", "40P01", "25P03"].includes(
        item.code ?? "",
      ) ||
      /statement timeout|lock timeout|query read timeout|connection terminated|connection.*(?:closed|reset)|ECONNRESET|ETIMEDOUT|websocket.*(?:closed|error)/i.test(
        item.message ?? "",
      )
    )
      return true;
    current = item.cause;
  }
  return false;
}
