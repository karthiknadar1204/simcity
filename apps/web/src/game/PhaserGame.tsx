import { useEffect, useRef } from "react";
import { createGame } from "./createGame";

export function PhaserGame() {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    const game = createGame(container.current);
    return () => game.destroy(true);
  }, []);

  return (
    <div className="game" ref={container} aria-label="Simulation canvas" />
  );
}
