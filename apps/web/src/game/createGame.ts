import { CANVAS, Game, Scale, Scene, GameObjects } from "phaser";
import type { Point, WorldState, VideoRequest } from "@repo/contracts";
import { Playback, snapshotBundle, type SceneFrame } from "@repo/playback";

export function createGame(
  parent: HTMLElement,
  onTile: (point: Point, shift: boolean) => void,
  size?: { width: number; height: number },
) {
  let frame: SceneFrame | null = null,
    selected = "",
    follow = false;
  let camera: VideoRequest["camera"] | null = null;
  let readyResolve!: () => void;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  class TownScene extends Scene {
    private ink!: GameObjects.Graphics;
    private labels = new Map<string, GameObjects.Text>();
    private dragging = false;
    private moved = false;
    private start = { x: 0, y: 0 };
    create() {
      this.ink = this.add.graphics();
      this.cameras.main.setBackgroundColor("#233b35");
      this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
        this.dragging = true;
        this.moved = false;
        this.start = { x: p.x, y: p.y };
      });
      this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
        if (!this.dragging || !p.isDown) return;
        const dx = p.x - this.start.x,
          dy = p.y - this.start.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) {
          this.moved = true;
          follow = false;
          this.cameras.main.scrollX -= dx / this.cameras.main.zoom;
          this.cameras.main.scrollY -= dy / this.cameras.main.zoom;
        }
        this.start = { x: p.x, y: p.y };
      });
      this.input.on("pointerup", (p: Phaser.Input.Pointer) => {
        this.dragging = false;
        if (this.moved || !frame) return;
        const q = this.cameras.main.getWorldPoint(p.x, p.y),
          tile = frame.state.map.tileSize;
        onTile(
          { x: Math.floor(q.x / tile), y: Math.floor(q.y / tile) },
          p.event.shiftKey,
        );
      });
      this.input.on(
        "wheel",
        (_p: unknown, _o: unknown, _x: number, delta: number) => {
          this.cameras.main.setZoom(
            Math.max(
              0.25,
              Math.min(4, this.cameras.main.zoom * (delta > 0 ? 0.9 : 1.1)),
            ),
          );
        },
      );
      readyResolve();
    }
    label(
      id: string,
      text: string,
      x: number,
      y: number,
      color = "#eaf1da",
      background?: string,
    ) {
      let label = this.labels.get(id);
      if (!label) {
        label = this.add
          .text(x, y, text, {
            fontFamily: "monospace",
            fontSize: "10px",
            color,
            align: "center",
            backgroundColor: background,
            padding: { x: 3, y: 2 },
            wordWrap: { width: 180 },
          })
          .setOrigin(0.5, 1);
        this.labels.set(id, label);
      }
      label.setText(text).setPosition(x, y).setColor(color).setVisible(true);
    }
    update() {
      if (!frame || !this.ink) return;
      const f = frame,
        s = f.state,
        t = s.map.tileSize,
        g = this.ink;
      g.clear();
      for (const label of this.labels.values()) label.setVisible(false);
      if (camera) {
        this.cameras.main.setZoom(camera.zoom).centerOn(camera.x, camera.y);
        camera = null;
      }
      for (let y = 0; y < s.map.height; y++)
        for (let x = 0; x < s.map.width; x++) {
          const noise = (x * 47 + y * 31) % 11;
          g.fillStyle(
            noise < 3 ? 0x71975d : noise < 7 ? 0x789f65 : 0x7da46a,
          ).fillRect(x * t, y * t, t, t);
          if (noise === 0)
            g.fillStyle(0xaccb7d).fillRect(x * t + 7, y * t + 21, 2, 3);
          if (y === 8 || x === 9 || y === 4)
            g.fillStyle(0xc5b38b).fillRect(x * t, y * t, t, t);
        }
      for (const p of s.map.blocked) {
        g.fillStyle(0x496443).fillRect(
          p.x * t + 2,
          p.y * t + 13,
          t - 4,
          t - 14,
        );
        g.fillStyle(0x2f6248).fillRect(p.x * t + 3, p.y * t + 2, t - 6, t - 12);
        g.fillStyle(0x407957).fillRect(p.x * t + 7, p.y * t - 2, t - 14, t - 7);
      }
      for (const o of Object.values(s.objects)) {
        const x = o.position.x * t,
          y = o.position.y * t;
        if (o.tags.includes("bed")) {
          g.fillStyle(0x354a45).fillRect(x - 7, y + 8, t + 14, t - 1);
          g.fillStyle(0xe0c99b).fillRect(x - 4, y + 2, t + 8, t - 3);
          g.fillStyle(0x9e6550).fillRect(x - 7, y - 4, t + 14, 12);
          g.fillStyle(0xb97b5c).fillRect(x - 2, y - 9, t + 4, 6);
          g.fillStyle(0x526d72).fillRect(x + 12, y + 17, 9, 15);
          g.fillStyle(0xe8d18a).fillRect(x + 1, y + 13, 7, 8);
        } else if (o.tags.includes("garden")) {
          g.fillStyle(0x765b40).fillRect(x - 6, y - 4, t + 12, t + 8);
          for (let k = 0; k < 4; k++) {
            g.fillStyle(0x447442).fillRect(x - 2 + k * 9, y, 5, 26);
            g.fillStyle(0xa7c777).fillRect(x - 3 + k * 9, y + 7, 7, 3);
          }
        } else if (o.tags.includes("repairable")) {
          g.fillStyle(0x987d55).fillRect(x - 5, y + 9, t + 10, 5);
          for (let k = 0; k < 4; k++) g.fillRect(x - 5 + k * 12, y + 3, 4, 27);
        } else if (o.tags.includes("meeting")) {
          g.fillStyle(0xada783).fillRect(x - 3, y - 3, t + 6, t + 6);
          g.fillStyle(0x669a9c).fillRect(x + 7, y + 7, t - 14, t - 14);
        } else {
          g.fillStyle(0xdda96c).fillRect(x - 5, y + 1, t + 10, t);
          g.fillStyle(
            o.tags.includes("kitchen") ? 0x9c5856 : 0x65827a,
          ).fillRect(x - 9, y - 7, t + 18, 12);
          g.fillStyle(0x425b53).fillRect(x + 9, y + 15, 12, 17);
          g.fillStyle(0xe8d18a).fillRect(x - 1, y + 7, 6, 7);
        }
        this.label(
          `object-${o.id}`,
          o.name,
          x + t / 2,
          y - 11,
          "#f3ecd6",
          "#344b3de6",
        );
      }
      for (const actor of f.actors) {
        const x = (actor.x + 0.5) * t,
          y = (actor.y + 1) * t - 3;
        const color = [0x6f83b6, 0xc07e62, 0xb4a55e, 0x7d9c83][
          [...actor.id].reduce((n, c) => n + c.charCodeAt(0), 0) % 4
        ]!;
        g.fillStyle(0x253d35, 0.25).fillEllipse(x, y, 22, 7);
        if (selected === actor.id)
          g.lineStyle(2, 0xf1d994).strokeEllipse(x, y, 27, 11);
        if (actor.activity === "sleep") {
          g.fillStyle(color).fillRect(x - 10, y - 10, 20, 8);
          g.fillStyle(0xe4ba91).fillRect(x + 7, y - 14, 8, 8);
          this.label(
            `sleep-${actor.id}`,
            actor.phase % 2 ? "z z" : "z",
            x + 14,
            y - 18,
          );
        } else {
          const step =
            actor.activity === "walk" ? (actor.phase % 2 ? 2 : -2) : 0;
          g.fillStyle(0x33434b)
            .fillRect(x - 6, y - 7 + step, 4, 8)
            .fillRect(x + 2, y - 7 - step, 4, 8);
          g.fillStyle(color).fillRect(x - 7, y - 20, 14, 15);
          g.fillStyle(0xe4ba91).fillRect(x - 6, y - 31, 12, 12);
          g.fillStyle(0x4d3c35).fillRect(x - 7, y - 33, 14, 5);
          g.fillStyle(0x27342e);
          if (actor.facing !== "up")
            g.fillRect(
              x +
                (actor.facing === "left"
                  ? -4
                  : actor.facing === "right"
                    ? 3
                    : -3),
              y - 25,
              2,
              2,
            );
          if (actor.activity === "work")
            g.fillStyle(0xced3c2).fillRect(
              x + 8,
              y - 19 + (actor.phase % 2) * 4,
              10,
              3,
            );
          if (actor.activity === "eat")
            g.fillStyle(0xeac783).fillRect(
              x + 5,
              y - 23 + (actor.phase % 2) * 3,
              7,
              4,
            );
        }
        if (actor.progress > 0 && actor.progress < 1) {
          g.fillStyle(0x354d42).fillRect(x - 11, y + 5, 22, 3);
          g.fillStyle(0xb8d48d).fillRect(x - 11, y + 5, 22 * actor.progress, 3);
        }
        this.label(
          `name-${actor.id}`,
          actor.name,
          x,
          y + 23,
          selected === actor.id ? "#fff0b9" : "#f6f0da",
          "#354a40dc",
        );
        if (actor.speech)
          this.label(
            `speech-${actor.id}`,
            actor.speech.length > 160
              ? actor.speech.slice(0, 157) + "…"
              : actor.speech,
            x,
            y - 41,
            "#273c34",
            "#faf1d9",
          );
      }
      if (f.night > 0) {
        g.fillStyle(0x182643, f.night).fillRect(
          0,
          0,
          s.map.width * t,
          s.map.height * t,
        );
        for (const o of Object.values(s.objects).filter(
          (o) => o.tags.includes("bed") || o.tags.includes("kitchen"),
        ))
          g.fillStyle(0xf4c76d, 0.65).fillRect(
            o.position.x * t + 1,
            o.position.y * t + 13,
            6,
            7,
          );
      }
      if (follow) {
        const actor = f.actors.find((a) => a.id === selected);
        if (actor)
          this.cameras.main.centerOn((actor.x + 0.5) * t, (actor.y + 0.5) * t);
      }
    }
  }
  const game = new Game({
    type: CANVAS,
    parent,
    width: size?.width ?? 768,
    height: size?.height ?? 512,
    pixelArt: true,
    antialias: false,
    backgroundColor: "#233b35",
    scene: TownScene,
    scale: {
      mode: size ? Scale.NONE : Scale.FIT,
      autoCenter: Scale.CENTER_BOTH,
    },
    banner: false,
    audio: { noAudio: true },
    fps: { target: 30, forceSetTimeOut: true },
  });
  return {
    ready,
    setFrame(value: SceneFrame) {
      frame = value;
    },
    setWorld(state: WorldState) {
      frame = new Playback(snapshotBundle(state)).frameAt(state.simTimeMs);
    },
    setSelection(id: string) {
      selected = id;
    },
    setCamera(value: VideoRequest["camera"]) {
      follow = false;
      camera = value;
    },
    follow(value: boolean) {
      follow = value;
    },
    async rendered() {
      await ready;
      return new Promise<void>((resolve) => {
        game.events.once("postrender", () => resolve());
      });
    },
    destroy() {
      game.destroy(true);
    },
  };
}
