import type { Point, WorldState } from "@repo/contracts";
import { occupied, sameTile, tileKey, walkable } from "./geometry";

export function findPath(
  world: WorldState,
  actorId: string,
  destination: Point,
): Point[] | null {
  const start = world.citizens[actorId]!.position;
  if (
    !walkable(world.map, destination) ||
    occupied(world, destination, actorId)
  )
    return null;
  const queue = [start];
  const previous = new Map<string, Point | null>([[tileKey(start), null]]);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const point = queue[cursor]!;
    if (sameTile(point, destination)) {
      const path: Point[] = [];
      for (let p: Point | null = point; p; p = previous.get(tileKey(p)) ?? null)
        path.push(p);
      return path.reverse();
    }
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ] as const) {
      const next = { x: point.x + dx, y: point.y + dy };
      if (
        previous.has(tileKey(next)) ||
        !walkable(world.map, next) ||
        occupied(world, next, actorId)
      )
        continue;
      previous.set(tileKey(next), point);
      queue.push(next);
    }
  }
  return null;
}
