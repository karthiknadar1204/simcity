import type { Command, WorldState } from "@repo/contracts";
import type { WorldStore } from "@repo/storage";

export class Coordinator {
  readonly ownerId = crypto.randomUUID();
  private owned = new Map<string, { generation: number; state: WorldState }>();
  private pending = new Map<string, Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopping = false;
  private lastRestore = 0;

  constructor(readonly store: WorldStore) {}

  private serialize<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.pending.set(id, next);
    void next
      .finally(() => {
        if (this.pending.get(id) === next) this.pending.delete(id);
      })
      .catch(() => undefined);
    return next;
  }

  async execute(id: string, command: Command) {
    return this.serialize(id, async () => {
      const generation = await this.store.claim(id, this.ownerId);
      const result = await this.store.execute(
        id,
        this.ownerId,
        generation,
        command,
      );
      this.owned.set(id, { generation, state: result.state });
      return result;
    });
  }

  async start() {
    await this.restore();
    this.timer = setInterval(() => {
      void this.tick();
    }, 500);
  }

  private async restore() {
    this.lastRestore = Date.now();
    for (const run of await this.store.list()) {
      if (run.status !== "running" || this.owned.has(run.id)) continue;
      try {
        const generation = await this.store.claim(run.id, this.ownerId);
        const restored = await this.store.load(run.id);
        this.owned.set(run.id, { generation, state: restored.state });
      } catch {
        console.error(
          `Run ${run.id} could not be restored or is owned by another coordinator.`,
        );
      }
    }
  }

  private async tick() {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      if (Date.now() - this.lastRestore >= 5000) await this.restore();
      for (const [id, entry] of this.owned) {
        if (entry.state.status !== "running") continue;
        try {
          await this.execute(id, {
            id: crypto.randomUUID(),
            action: {
              kind: "advance",
              durationMs: Math.round(500 * entry.state.speed),
            },
          });
        } catch {
          this.owned.delete(id);
          console.error(
            `Run ${id} stopped advancing after a commit or ownership failure.`,
          );
        }
      }
    } catch {
      console.error(
        "Coordinator reconciliation failed; the next tick will retry.",
      );
    } finally {
      this.ticking = false;
    }
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    while (this.ticking) await Bun.sleep(10);
    await Promise.allSettled([...this.pending.values()]);
    for (const [id, entry] of this.owned)
      await this.store.release(id, this.ownerId, entry.generation);
    this.owned.clear();
  }
}
