import { test, expect } from "bun:test";
import "./env";
import { createDatabase } from "./index";
const live = process.env.RUN_INTEGRATION === "1" ? test : test.skip;
live(
  "a lost leased database session fails its work and the pool accepts a fresh query",
  async () => {
    const { pool } = createDatabase(process.env.DATABASE_URL!);
    const client = await pool.connect();
    let released = false;
    try {
      await client.query("begin");
      const pid = (
        await client.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      const disconnected = new Promise<void>((resolve) =>
        client.once("error", () => resolve()),
      );
      const result = await pool.query<{ stopped: boolean }>(
        "select pg_terminate_backend($1) as stopped",
        [pid],
      );
      expect(result.rows[0]!.stopped).toBeTrue();
      await Promise.race([
        disconnected,
        Bun.sleep(3000).then(() => {
          throw new Error("Fixture session did not disconnect");
        }),
      ]);
      await expect(client.query("select 1")).rejects.toThrow();
      client.release(true);
      released = true;
      expect(
        (await pool.query<{ value: number }>("select 1 as value")).rows[0]!
          .value,
      ).toBe(1);
    } finally {
      if (!released) {
        await client.query("rollback").catch(() => undefined);
        client.release(true);
      }
      await pool.end();
    }
  },
  20000,
);
