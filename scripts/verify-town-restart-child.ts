// Process owned by verify-town-restart.ts. It never calls a model.
import "../packages/db/src/env";
import { createDatabase } from "../packages/db/src";
import { WorldStore, MemoryWorkStore } from "../packages/storage/src";
const [id, mode, path] = process.argv.slice(2);
if (!id || !mode || !path)
  throw new Error("Expected run, mode and report path");
const { db, pool } = createDatabase(process.env.DATABASE_URL!),
  worlds = new WorldStore(db),
  owner = crypto.randomUUID();
let generation: number | undefined;
try {
  const deadline = Date.now() + 25000;
  while (generation === undefined) {
    try {
      generation = await worlds.claim(id, owner);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(250);
    }
  }
  const before = await worlds.load(id);
  await Bun.write(
    path,
    JSON.stringify({ mode, stateHash: before.stateHash, state: before.state }),
  );
  if (mode === "hold") await new Promise(() => {});
  if (mode === "wake") {
    let result;
    for (let hour = 0; hour < 9; hour++) {
      generation = await worlds.claim(id, owner);
      result = await worlds.execute(id, owner, generation, {
        id: `fixture-overnight-advance-${hour}`,
        action: { kind: "advance", durationMs: 3600000 },
      });
    }
    if (!result) throw new Error("No fixture advance");
    const tasks = await Promise.all(
      Object.keys(result.state.citizens).map((citizen) =>
        new MemoryWorkStore(db).status(id, citizen),
      ),
    );
    await Bun.write(
      path,
      JSON.stringify({
        mode,
        beforeHash: before.stateHash,
        beforeTime: before.state.simTimeMs,
        state: result.state,
        stateHash: (await worlds.current(id)).stateHash,
        consolidationTasks: tasks
          .flat()
          .filter((row) => row.task.operation === "consolidate")
          .map((row) => row.task),
      }),
    );
  }
} finally {
  if (generation !== undefined) await worlds.release(id, owner, generation);
  await pool.end();
}
