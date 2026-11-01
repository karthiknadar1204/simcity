import { z } from "zod";
import type { WorldState, WorldEvent } from "./types";
export const rendererVersion = "pixel-town-v2";
export interface PlaybackBundle {
  version: 1;
  runId: string;
  checkpoint: { state: WorldState; stateHash: string };
  events: WorldEvent[];
  fromMs: number;
  toMs: number;
  upperSequence: number;
}
export const exportRequestSchema = z
  .strictObject({
    startMs: z.number().int().safe().nonnegative(),
    endMs: z.number().int().safe().nonnegative(),
    speed: z.number().min(0.25).max(3600),
    fps: z.literal(30),
    width: z.literal(1280),
    height: z.literal(720),
    camera: z.strictObject({
      x: z.number().finite(),
      y: z.number().finite(),
      zoom: z.number().min(0.25).max(4),
    }),
  })
  .refine(
    (value) =>
      value.endMs > value.startMs &&
      value.endMs - value.startMs <= 3600000 &&
      (value.endMs - value.startMs) / value.speed <= 30000,
    "Choose a positive recorded interval of at most one simulated hour and 30 output seconds.",
  );
export type VideoRequest = z.infer<typeof exportRequestSchema>;
export type RecordingPayload = {
  runId: string;
  fromSequence: number;
  toSequence: number;
};
export type VideoPayload = {
  runId: string;
  upperSequence: number;
  request: VideoRequest;
};
export type MediaFile = {
  kind: "video" | "thumbnail" | "manifest";
  key: string;
  checksum: string;
  bytes: number;
  contentType: string;
};
export interface RecordingDescriptor {
  version: 1;
  runId: string;
  fromSequence: number;
  toSequence: number;
  startMs: number;
  endMs: number;
  key: string;
  checksum: string;
  bytes: number;
  traceCount: number;
}
