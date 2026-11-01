import type { Point, WorldMap, WorldState } from "@repo/contracts";

export const tileKey = (p: Point) => `${p.x},${p.y}`;
export const distance = (a: Point, b: Point) =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export const sameTile = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

export function walkable(map: WorldMap, p: Point) {
  return (
    p.x >= 0 &&
    p.y >= 0 &&
    p.x < map.width &&
    p.y < map.height &&
    !map.blocked.some((b) => sameTile(b, p))
  );
}

export function occupied(world: WorldState, p: Point, exceptId: string) {
  return Object.values(world.citizens).some(
    (c) => c.id !== exceptId && sameTile(c.position, p),
  );
}

export function lineOfSight(map: WorldMap, from: Point, to: Point) {
  let { x, y } = from;
  const dx = Math.abs(to.x - x),
    dy = Math.abs(to.y - y);
  const sx = x < to.x ? 1 : -1,
    sy = y < to.y ? 1 : -1;
  let error = dx - dy;
  while (x !== to.x || y !== to.y) {
    const twice = 2 * error;
    if (twice > -dy) {
      error -= dy;
      x += sx;
    }
    if (twice < dx) {
      error += dx;
      y += sy;
    }
    if (!walkable(map, { x, y })) return x === to.x && y === to.y;
  }
  return true;
}
