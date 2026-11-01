import { test, expect } from "bun:test";
import { frameTimes } from "./render";
test("video samples use a fixed output clock and never sample past the requested end", () => {
  const times = frameTimes({
    startMs: 1000,
    endMs: 3000,
    speed: 2,
    fps: 30,
    width: 1280,
    height: 720,
    camera: { x: 0, y: 0, zoom: 1 },
  });
  expect(times).toHaveLength(30);
  expect(times[0]).toBe(1000);
  expect(times[15]).toBe(2000);
  expect(times[29]).toBeLessThan(3000);
});
