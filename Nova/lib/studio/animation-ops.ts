// Pure frame/layer/document operations for the v3 animation model.
// No DOM — unit-testable in Node. Ops mutate the passed objects and return
// info the caller needs (e.g. the created layer, or null when a guard fires).

import type {
  AnimationDocument,
  AnimationFrame,
  AnimationLayer,
} from "./animation-types";
import { DEFAULT_FPS, MAX_FRAME_MS, MIN_FRAME_MS } from "./animation-types";
import type { DrawingElement } from "./drawing-types";
import { nextElementId } from "./drawing-serialization";

// ---------- constructors ----------

export function makeLayer(name: string, elements: DrawingElement[] = []): AnimationLayer {
  return { id: nextElementId(), name, visible: true, opacity: 1, locked: false, elements };
}

export function makeFrame(name: string, durationMs: number, layers?: AnimationLayer[]): AnimationFrame {
  return { id: nextElementId(), name, durationMs, layers: layers ?? [makeLayer("Layer 1")] };
}

export function makeDocument(width: number, height: number, background: string): AnimationDocument {
  const frame = makeFrame("Frame 1", frameMsFor(DEFAULT_FPS));
  return {
    version: 3,
    canvas: { width, height, background },
    settings: { grid: false, fps: DEFAULT_FPS, loop: true, onion: false },
    frames: [frame],
    activeFrameId: frame.id,
    activeLayerId: frame.layers[0].id,
  };
}

function frameMsFor(fps: number): number {
  return Math.round(1000 / Math.max(1, fps));
}

// ---------- lookups ----------

export function activeFrame(doc: AnimationDocument): AnimationFrame {
  return doc.frames.find((f) => f.id === doc.activeFrameId) ?? doc.frames[0];
}

export function activeLayer(doc: AnimationDocument): AnimationLayer {
  const frame = activeFrame(doc);
  return frame.layers.find((l) => l.id === doc.activeLayerId) ?? frame.layers[frame.layers.length - 1];
}

export function frameIndex(doc: AnimationDocument, frameId: string): number {
  return doc.frames.findIndex((f) => f.id === frameId);
}

export function layerIndex(frame: AnimationFrame, layerId: string): number {
  return frame.layers.findIndex((l) => l.id === layerId);
}

// ---------- layer ops ----------

export function addLayer(frame: AnimationFrame): AnimationLayer {
  const layer = makeLayer(`Layer ${frame.layers.length + 1}`);
  frame.layers.push(layer);
  return layer;
}

export function insertLayerAt(frame: AnimationFrame, index: number, layer: AnimationLayer): void {
  frame.layers.splice(Math.min(Math.max(0, index), frame.layers.length), 0, layer);
}

export function removeLayerAt(frame: AnimationFrame, index: number): AnimationLayer | null {
  if (index < 0 || index >= frame.layers.length || frame.layers.length <= 1) return null;
  return frame.layers.splice(index, 1)[0] ?? null;
}

export function renameLayer(layer: AnimationLayer, name: string): string | null {
  const next = name.trim();
  if (!next) return null;
  const prev = layer.name;
  layer.name = next;
  return prev;
}

export function moveLayer(frame: AnimationFrame, layerId: string, dir: -1 | 1): boolean {
  const i = layerIndex(frame, layerId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= frame.layers.length) return false;
  const [layer] = frame.layers.splice(i, 1);
  frame.layers.splice(j, 0, layer);
  return true;
}

// ---------- frame ops ----------

export function addFrame(doc: AnimationDocument): AnimationFrame {
  const frame = makeFrame(`Frame ${doc.frames.length + 1}`, frameMsFor(doc.settings.fps));
  const at = frameIndex(doc, doc.activeFrameId);
  doc.frames.splice(at + 1, 0, frame);
  doc.activeFrameId = frame.id;
  doc.activeLayerId = frame.layers[0].id;
  return frame;
}

export function insertFrameAt(doc: AnimationDocument, index: number, frame: AnimationFrame): void {
  doc.frames.splice(Math.min(Math.max(0, index), doc.frames.length), 0, frame);
}

export function removeFrameAt(doc: AnimationDocument, index: number): AnimationFrame | null {
  if (index < 0 || index >= doc.frames.length || doc.frames.length <= 1) return null;
  const [removed] = doc.frames.splice(index, 1);
  if (doc.activeFrameId === removed.id) {
    const next = doc.frames[Math.min(index, doc.frames.length - 1)];
    doc.activeFrameId = next.id;
    doc.activeLayerId = next.layers[next.layers.length - 1].id;
  }
  return removed;
}

/** Deep-copies a frame with fresh ids so edits never affect the original. */
export function duplicateFrame(doc: AnimationDocument, frameId: string): AnimationFrame | null {
  const i = frameIndex(doc, frameId);
  const src = doc.frames[i];
  if (!src) return null;
  const copy: AnimationFrame = {
    id: nextElementId(),
    name: `${src.name} copy`,
    durationMs: src.durationMs,
    layers: src.layers.map((l) => ({
      id: nextElementId(),
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      locked: l.locked,
      elements: l.elements.map((e) => ({ ...e, id: nextElementId() })),
    })),
  };
  doc.frames.splice(i + 1, 0, copy);
  doc.activeFrameId = copy.id;
  doc.activeLayerId = copy.layers[copy.layers.length - 1].id;
  return copy;
}

export function moveFrame(doc: AnimationDocument, frameId: string, dir: -1 | 1): boolean {
  const i = frameIndex(doc, frameId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= doc.frames.length) return false;
  const [frame] = doc.frames.splice(i, 1);
  doc.frames.splice(j, 0, frame);
  return true;
}

export function setFrameDuration(frame: AnimationFrame, ms: number): number {
  const prev = frame.durationMs;
  frame.durationMs = Math.min(MAX_FRAME_MS, Math.max(MIN_FRAME_MS, Math.round(ms)));
  return prev;
}

/** Selects a frame and a valid layer within it. Returns false if the id is unknown. */
export function selectFrame(doc: AnimationDocument, frameId: string): boolean {
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame) return false;
  doc.activeFrameId = frame.id;
  if (!frame.layers.some((l) => l.id === doc.activeLayerId)) {
    doc.activeLayerId = frame.layers[frame.layers.length - 1].id;
  }
  return true;
}

export function selectLayer(doc: AnimationDocument, layerId: string): boolean {
  const frame = activeFrame(doc);
  if (!frame.layers.some((l) => l.id === layerId)) return false;
  doc.activeLayerId = layerId;
  return true;
}

/** Repairs selection pointers after structural changes. */
export function fixSelection(doc: AnimationDocument): void {
  const frame = activeFrame(doc);
  doc.activeFrameId = frame.id;
  if (!frame.layers.some((l) => l.id === doc.activeLayerId)) {
    doc.activeLayerId = frame.layers[frame.layers.length - 1].id;
  }
}

// ---------- playback (pure sequencing — timers live in the page) ----------

/**
 * Returns the index of the frame to show after `current`, or -1 to stop.
 * Handles a stale/unknown current index and single-frame docs.
 */
export function advanceFrameIndex(doc: AnimationDocument, current: number): number {
  const n = doc.frames.length;
  if (n === 0) return -1;
  if (n === 1) return doc.settings.loop ? 0 : -1;
  const next = current < 0 ? 0 : current + 1;
  if (next < n) return next;
  return doc.settings.loop ? 0 : -1;
}

/** Ids of the frames to onion-skin around the active frame. */
export function onionSources(doc: AnimationDocument): { prev: string | null; next: string | null } {
  const i = frameIndex(doc, doc.activeFrameId);
  return {
    prev: i > 0 ? doc.frames[i - 1].id : null,
    next: i >= 0 && i < doc.frames.length - 1 ? doc.frames[i + 1].id : null,
  };
}
