import { AUTO, Game, Scale, Scene, GameObjects } from "phaser";
import type { Citizen, Point, WorldState } from "@repo/contracts";

type Drawing = {
  body: GameObjects.Graphics;
  label: GameObjects.Text;
  x: number;
  y: number;
  trail: Point[];
  citizen: Citizen;
  color: number;
};
const colors = [0xe9b18a, 0xa8c8cc, 0xc1b0d6, 0xe1cf8d, 0x9dbaa2];

export function createGame(
  parent: HTMLElement,
  onTile: (point: Point, shift: boolean) => void,
) {
  let state: WorldState | null = null;
  let selection = "";
  let ready = false;
  class TownScene extends Scene {
    terrain!: GameObjects.Graphics;
    labels: GameObjects.Text[] = [];
    actors = new Map<string, Drawing>();
    previous: WorldState | null = null;
    constructor() {
      super("town");
    }
    create() {
      this.terrain = this.add.graphics();
      ready = true;
      this.input.on(
        "pointerdown",
        (pointer: { x: number; y: number; event: MouseEvent }) => {
          if (!state || pointer.event.target !== this.game.canvas) return;
          if (
            pointer.x < 0 ||
            pointer.y < 0 ||
            pointer.x >= state.map.width * state.map.tileSize ||
            pointer.y >= state.map.height * state.map.tileSize
          )
            return;
          onTile(
            {
              x: Math.floor(pointer.x / state.map.tileSize),
              y: Math.floor(pointer.y / state.map.tileSize),
            },
            pointer.event.shiftKey,
          );
        },
      );
      this.paint(true);
    }
    paint(snap = false) {
      if (!state) return;
      const size = state.map.tileSize;
      this.scale.resize(state.map.width * size, state.map.height * size);
      this.terrain.clear();
      this.labels.forEach((label) => label.destroy());
      this.labels = [];
      const walls = new Set(state.map.blocked.map((p) => `${p.x},${p.y}`));
      for (let y = 0; y < state.map.height; y++)
        for (let x = 0; x < state.map.width; x++) {
          const blocked = walls.has(`${x},${y}`);
          this.terrain.fillStyle(
            blocked
              ? 0x405650
              : (x * 7 + y * 3) % 5 === 0
                ? 0x63816b
                : 0x6a8972,
          );
          this.terrain.fillRect(x * size, y * size, size - 1, size - 1);
          if (blocked) {
            this.terrain.fillStyle(0x536b62);
            this.terrain.fillRect(x * size + 2, y * size + 2, size - 5, 5);
          }
        }
      for (const object of Object.values(state.objects)) {
        const x = object.position.x * size,
          y = object.position.y * size;
        const bed = object.tags.includes("bed");
        this.terrain.fillStyle(bed ? 0xcbab84 : 0xad8c62);
        this.terrain.fillRect(x + 5, y + 8, size - 10, size - 12);
        this.terrain.fillStyle(bed ? 0xeee0ba : 0xd4bb8a);
        this.terrain.fillRect(x + 7, y + 6, size - 14, 6);
        this.labels.push(
          this.add
            .text(x + size / 2, y - 2, object.name, {
              fontFamily: "monospace",
              fontSize: "9px",
              color: "#fff4d7",
              backgroundColor: "#283e35",
            })
            .setOrigin(0.5, 1),
        );
      }
      Object.values(state.citizens).forEach((citizen, index) => {
        let actor = this.actors.get(citizen.id);
        if (!actor) {
          actor = {
            body: this.add.graphics(),
            label: this.add
              .text(0, 0, citizen.name, {
                fontFamily: "monospace",
                fontSize: "10px",
                color: "#fff8df",
                backgroundColor: "#26352d",
              })
              .setOrigin(0.5, 1),
            x: citizen.position.x,
            y: citizen.position.y,
            trail: [],
            citizen,
            color: colors[index % colors.length]!,
          };
          this.actors.set(citizen.id, actor);
        }
        const oldCitizen = this.previous?.citizens[citizen.id];
        const oldJob = oldCitizen?.actionId
          ? this.previous?.jobs[oldCitizen.actionId]
          : undefined;
        const job = oldJob ? state!.jobs[oldJob.id] : undefined;
        if (snap || this.previous?.runId !== state!.runId || !oldCitizen) {
          actor.x = citizen.position.x;
          actor.y = citizen.position.y;
          actor.trail = [];
        } else if (
          oldCitizen.position.x !== citizen.position.x ||
          oldCitizen.position.y !== citizen.position.y
        ) {
          // Intermediate points come only from already committed route steps.
          const points =
            oldJob?.kind === "move" && job?.kind === "move"
              ? job.path.slice(oldJob.stepIndex + 1, job.stepIndex + 1)
              : [citizen.position];
          actor.trail.push(...points);
        }
        actor.citizen = citizen;
      });
      this.previous = state;
    }
    update(time: number, delta: number) {
      if (!state) return;
      const size = state.map.tileSize;
      for (const [id, actor] of this.actors) {
        const target = actor.trail[0];
        if (target) {
          const dx = target.x - actor.x,
            dy = target.y - actor.y;
          const length = Math.hypot(dx, dy);
          const step =
            delta / Math.min(220, Math.max(30, 450 / actor.trail.length));
          if (length <= step) {
            actor.x = target.x;
            actor.y = target.y;
            actor.trail.shift();
          } else {
            actor.x += (dx / length) * step;
            actor.y += (dy / length) * step;
          }
        }
        const x = Math.round((actor.x + 0.5) * size),
          y = Math.round((actor.y + 0.5) * size);
        const g = actor.body;
        g.clear();
        g.setDepth(y + 100);
        g.fillStyle(0x23392b, 0.3);
        g.fillEllipse(x, y + 10, 18, 7);
        if (id === selection) {
          g.lineStyle(2, 0xffedb5);
          g.strokeRect(x - 12, y - 14, 24, 29);
        }
        const stride = target ? (Math.floor(time / 100) % 2) * 2 : 0;
        g.fillStyle(0x33465b);
        g.fillRect(x - 5, y + 5, 4, 6 - stride);
        g.fillRect(x + 1, y + 5, 4, 4 + stride);
        g.fillStyle(actor.color);
        g.fillRect(x - 7, y - 3, 14, 10);
        g.fillStyle(0xe6bf93);
        g.fillRect(x - 5, y - 12, 10, 10);
        g.fillStyle(0x4a3832);
        g.fillRect(x - 5, y - 13, 10, 4);
        g.fillStyle(0x2d3334);
        if (actor.citizen.facing !== "up") {
          const offset =
            actor.citizen.facing === "left"
              ? -4
              : actor.citizen.facing === "right"
                ? 2
                : -3;
          g.fillRect(x + offset, y - 7, 2, 2);
          if (actor.citizen.facing === "down") g.fillRect(x + 2, y - 7, 2, 2);
        }
        actor.label.setPosition(x, y - 17).setDepth(y + 101);
      }
    }
  }
  const scene = new TownScene();
  const game = new Game({
    type: AUTO,
    parent,
    width: 768,
    height: 512,
    backgroundColor: "#263b32",
    pixelArt: true,
    roundPixels: true,
    scale: { mode: Scale.FIT, autoCenter: Scale.CENTER_BOTH },
    scene,
  });
  return {
    destroy: () => game.destroy(true),
    setWorld: (next: WorldState, snap: boolean) => {
      state = next;
      if (ready) scene.paint(snap);
    },
    setSelection: (id: string) => {
      selection = id;
    },
  };
}
