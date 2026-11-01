import { isTransientDatabaseError } from "../../packages/storage/src";
// Use only for reads or commands whose identity is fixed outside the callback.
export async function retryDatabase<T>(
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 2 || !isTransientDatabaseError(error)) throw error;
      console.error(
        "Transient database transport failure; retrying the same durable operation.",
      );
      await Bun.sleep(250 * (attempt + 1));
    }
  }
}
