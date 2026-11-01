import { isTransientDatabaseError } from "@repo/storage";
// Only wrap database reads or idempotent writes with stable task/round IDs.
// A provider inference call must never be retried by this helper.
export async function durableDatabase<T>(
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 2 || !isTransientDatabaseError(error)) throw error;
      await Bun.sleep(250 * (attempt + 1));
    }
  }
}
