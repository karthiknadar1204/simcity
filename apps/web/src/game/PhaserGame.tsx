import { useEffect, useRef } from "react";
import type { Point, WorldState } from "@repo/contracts";
import type { SceneFrame } from "@repo/playback";
import { createGame } from "./createGame";
export function PhaserGame({
  state,
  selectedId,
  frame,
  follow,
  zoom,
  onTile,
}: {
  state: WorldState;
  selectedId: string;
  replaying: boolean;
  frame?: SceneFrame | null;
  follow?: boolean;
  zoom?: number;
  onTile: (point: Point, shift: boolean) => void;
}) {
  const container = useRef<HTMLDivElement>(null),
    game = useRef<ReturnType<typeof createGame> | null>(null),
    handler = useRef(onTile);
  useEffect(() => {
    handler.current = onTile;
  }, [onTile]);
  useEffect(() => {
    if (!container.current) return;
    const renderer = createGame(container.current, (point, shift) =>
      handler.current(point, shift),
    );
    game.current = renderer;
    return () => {
      renderer.destroy();
      game.current = null;
    };
  }, []);
  useEffect(() => {
    if (frame) game.current?.setFrame(frame);
    else game.current?.setWorld(state);
  }, [state, frame]);
  useEffect(() => {
    game.current?.setSelection(selectedId);
  }, [selectedId]);
  useEffect(() => {
    game.current?.follow(Boolean(follow));
  }, [follow]);
  useEffect(() => {
    if (zoom)
      game.current?.setCamera({
        x: (state.map.width * state.map.tileSize) / 2,
        y: (state.map.height * state.map.tileSize) / 2,
        zoom,
      });
  }, [zoom, state.map.width, state.map.height, state.map.tileSize]);
  return (
    <div
      className="game"
      style={{ aspectRatio: `${state.map.width} / ${state.map.height}` }}
      ref={container}
      aria-label="Town map. Drag to pan, scroll to zoom, or select a citizen to follow."
    />
  );
}
