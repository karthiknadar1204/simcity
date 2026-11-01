import { AUTO, Game, Scale, Scene } from "phaser";

class BootScene extends Scene {
  constructor() {
    super("boot");
  }

  create() {
    const grid = this.add.graphics();
    grid.lineStyle(1, 0x283c36, 1);
    for (let x = 0; x <= 640; x += 32) grid.lineBetween(x, 0, x, 384);
    for (let y = 0; y <= 384; y += 32) grid.lineBetween(0, y, 640, y);
    this.add
      .text(320, 170, "SIMCITY", {
        fontFamily: "monospace",
        fontSize: "32px",
        color: "#c7e8ba",
      })
      .setOrigin(0.5);
    this.add
      .text(320, 210, "Phaser scene ready", {
        fontFamily: "monospace",
        fontSize: "14px",
        color: "#95afa3",
      })
      .setOrigin(0.5);
  }
}

export function createGame(parent: HTMLElement) {
  return new Game({
    type: AUTO,
    parent,
    width: 640,
    height: 384,
    backgroundColor: "#192b25",
    pixelArt: true,
    roundPixels: true,
    scale: { mode: Scale.FIT, autoCenter: Scale.CENTER_BOTH },
    scene: BootScene,
  });
}
