import { useEffect, useRef } from "react";
import type { Point, WorldState } from "@repo/contracts";
import { createGame } from "./createGame";

export function PhaserGame({
  state,
  selectedId,
  replaying,
  onTile,
}: {
  state: WorldState;
  selectedId: string;
  replaying: boolean;
  onTile: (point: Point, shift: boolean) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const game = useRef<ReturnType<typeof createGame> | null>(null);
  const handler = useRef(onTile);
  useEffect(() => {
    handler.current = onTile;
  }, [onTile]);
  useEffect(() => {
    if (!container.current) return;
    game.current = createGame(container.current, (point, shift) =>
      handler.current(point, shift),
    );
    return () => {
      game.current?.destroy();
      game.current = null;
    };
  }, []);
  useEffect(() => {
    game.current?.setWorld(state, replaying);
  }, [state, replaying]);
  useEffect(() => {
    game.current?.setSelection(selectedId);
  }, [selectedId]);
  return (
    <div
      className="game"
      style={{ aspectRatio: `${state.map.width} / ${state.map.height}` }}
      ref={container}
      aria-label="Town map. Select a citizen then click a tile to move. Shift click to toggle a blocked tile."
    />
  );
}
