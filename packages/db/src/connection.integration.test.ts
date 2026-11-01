import { test, expect } from "bun:test";
import "./env";
import { createDatabase, sql } from "./index";
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
live(
  "a query already queued behind a dropped connection proceeds without a later query nudging the pool",
  async () => {
    const { pool } = createDatabase(process.env.DATABASE_URL!, { max: 1 }),
      killer = createDatabase(process.env.DATABASE_URL!);
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
      const queued = pool.query<{ ok: number }>("select 1 as ok");
      await killer.pool.query("select pg_terminate_backend($1)", [pid]);
      await disconnected;
      client.release(true);
      released = true;
      const result = await Promise.race([
        queued,
        Bun.sleep(2500).then(() => {
          throw new Error(
            "Queued query stayed stuck after the disconnected client was removed",
          );
        }),
      ]);
      expect(result.rows[0]!.ok).toBe(1);
    } finally {
      if (!released) client.release(true);
      await pool.query("select 1").catch(() => undefined);
      await pool.end();
      await killer.pool.end();
    }
  },
  20000,
);
live(
  "a lost BEGIN acknowledgement releases its leased client instead of leaking an idle transaction",
  async () => {
    const { pool, db } = createDatabase(process.env.DATABASE_URL!, { max: 1 }),
      client = await pool.connect();
    let injected = false,
      callbacks = 0;
    client.query = new Proxy(client.query, {
      apply(target, self, args) {
        const pending = Reflect.apply(target, self, args);
        const first = args[0],
          text = typeof first === "string" ? first : first?.text;
        if (!injected && typeof text === "string" && /^begin\b/i.test(text)) {
          injected = true;
          return Promise.resolve(pending).then(() => {
            throw new Error("Query read timeout");
          });
        }
        return pending;
      },
    });
    client.release();
    try {
      await expect(
        db.transaction(async () => {
          callbacks++;
        }),
      ).rejects.toThrow();
      expect(injected).toBeTrue();
      expect(callbacks).toBe(0);
      expect(pool.totalCount).toBe(0);
      expect(
        (await pool.query<{ ok: number }>("select 1 as ok")).rows[0]!.ok,
      ).toBe(1);
      await db.transaction(async (tx) => {
        const result = await tx.execute(
          sql`show idle_in_transaction_session_timeout`,
        );
        expect(result.rows[0]?.idle_in_transaction_session_timeout).toBe("10s");
      });
    } finally {
      try {
        client.release(true);
      } catch {
        /* The corrected adapter has already released it. */
      }
      await pool.end();
    }
  },
  15000,
);
