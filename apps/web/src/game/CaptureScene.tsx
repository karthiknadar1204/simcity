import { useEffect, useRef } from "react";
import {
  rendererVersion,
  type PlaybackBundle,
  type VideoRequest,
} from "@repo/contracts";
import { Playback } from "@repo/playback";
import { createGame } from "./createGame";
declare global {
  interface Window {
    __SIMCITY_CAPTURE__?: {
      version: string;
      load: (
        bundle: PlaybackBundle,
        camera: VideoRequest["camera"],
      ) => Promise<void>;
      seek: (time: number) => Promise<{ sequence: number; timeMs: number }>;
    };
  }
}
export function CaptureScene() {
  const parent = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const game = createGame(parent.current!, () => {}, {
      width: 1280,
      height: 720,
    });
    let playback: Playback | null = null;
    window.__SIMCITY_CAPTURE__ = {
      version: rendererVersion,
      async load(bundle, camera) {
        await game.ready;
        playback = new Playback(bundle);
        game.setCamera(camera);
        game.setFrame(playback.frameAt(bundle.fromMs));
        await game.rendered();
      },
      async seek(time) {
        if (!playback) throw new Error("Playback is not loaded");
        const frame = playback.frameAt(time);
        game.setFrame(frame);
        await game.rendered();
        return { sequence: frame.state.sequence, timeMs: time };
      },
    };
    return () => {
      delete window.__SIMCITY_CAPTURE__;
      game.destroy();
    };
  }, []);
  return <div ref={parent} style={{ width: 1280, height: 720 }} />;
}
