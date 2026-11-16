// Animation document model — version 3.
// v3 wraps the Phase 1 element model into frames → layers → elements.
// Element types are unchanged (see drawing-types.ts).

import type { DrawingElement } from "./drawing-types";

export interface AnimationLayer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number; // 0..1
  locked: boolean;
  elements: DrawingElement[];
}

export interface AnimationFrame {
  id: string;
  name: string;
  durationMs: number; // display time during playback
  layers: AnimationLayer[]; // bottom → top; last entry is topmost
}

export interface AnimationDocument {
  version: 3;
  canvas: { width: number; height: number; background: string };
  settings: {
    grid: boolean;
    fps: number; // project default frame rate — sets NEW frame durations
    loop: boolean;
    onion: boolean;
  };
  frames: AnimationFrame[];
  activeFrameId: string;
  activeLayerId: string;
}

export const MIN_FRAME_MS = 10;
export const MAX_FRAME_MS = 60_000;
export const DEFAULT_FPS = 12;

export function frameDurationForFps(fps: number): number {
  return Math.round(1000 / Math.max(1, fps));
}
