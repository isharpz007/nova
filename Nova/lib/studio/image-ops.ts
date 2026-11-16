// Pure helpers for image-element selection, movement and resizing.
// Kept DOM-free so they are unit-testable.

import type { AnimationFrame } from "./animation-types";
import type { ImageElement } from "./drawing-types";

export interface ImageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Corner = "tl" | "tr" | "bl" | "br";

export interface ImageHit {
  element: ImageElement;
  /** Layer containing the element (index into frame.layers). */
  layerIndex: number;
}

/** Axis-aligned bounds check (rotation ignored — handles stay rectangular). */
export function pointInRect(px: number, py: number, r: ImageRect): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

/** Corner handle at `corner`, `size` canvas px on a side. */
export function handleRect(el: ImageElement, corner: Corner, size: number): ImageRect {
  const half = size / 2;
  const cx = corner === "tl" || corner === "bl" ? el.x : el.x + el.w;
  const cy = corner === "tl" || corner === "tr" ? el.y : el.y + el.h;
  return { x: cx - half, y: cy - half, w: size, h: size };
}

export function cornerAt(el: ImageElement, px: number, py: number, size: number): Corner | null {
  for (const c of ["tl", "tr", "bl", "br"] as const) {
    if (pointInRect(px, py, handleRect(el, c, size))) return c;
  }
  return null;
}

/**
 * Topmost-first hit test over a frame's image elements. Layers on top win;
 * hidden and locked layers are skipped (locked = not editable, hidden =
 * not interactable). Returns the element + its layer index.
 */
export function hitTestImage(frame: AnimationFrame, px: number, py: number): ImageHit | null {
  for (let li = frame.layers.length - 1; li >= 0; li--) {
    const layer = frame.layers[li];
    if (!layer.visible || layer.locked) continue;
    for (let ei = layer.elements.length - 1; ei >= 0; ei--) {
      const el = layer.elements[ei];
      if (el.type !== "image") continue;
      if (pointInRect(px, py, el)) return { element: el, layerIndex: li };
    }
  }
  return null;
}

/** Finds an image element anywhere in the frame (for selection lookup). */
export function findImage(frame: AnimationFrame, elementId: string): ImageHit | null {
  for (let li = frame.layers.length - 1; li >= 0; li--) {
    const layer = frame.layers[li];
    for (const el of layer.elements) {
      if (el.type === "image" && el.id === elementId) {
        return { element: el, layerIndex: li };
      }
    }
  }
  return null;
}

const MIN_IMG = 8;

/**
 * Resizes `start` from `corner` by (dx, dy) canvas px, preserving aspect
 * ratio and anchoring the opposite corner. Width drives; height follows.
 */
export function resizeRect(start: ImageRect, corner: Corner, dx: number, dy: number): ImageRect {
  const aspect = start.w > 0 && start.h > 0 ? start.w / start.h : 1;
  let w: number;
  switch (corner) {
    case "tl":
    case "bl":
      w = start.w - dx;
      break;
    case "tr":
    case "br":
      w = start.w + dx;
      break;
  }
  w = Math.max(MIN_IMG, w);
  const h = w / aspect;
  const x = corner === "tl" || corner === "bl" ? start.x + start.w - w : start.x;
  const y = corner === "tl" || corner === "tr" ? start.y + start.h - h : start.y;
  return { x, y, w, h };
}

/** Moves a rect by (dx, dy). */
export function moveRect(start: ImageRect, dx: number, dy: number): ImageRect {
  return { x: start.x + dx, y: start.y + dy, w: start.w, h: start.h };
}

/** Initial placement for a newly inserted image — centred, fit to `fit` of the canvas. */
export function placementRect(
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
  fit = 0.6
): ImageRect {
  const scale = Math.min(1, (canvasW * fit) / srcW, (canvasH * fit) / srcH);
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  return { x: Math.round((canvasW - w) / 2), y: Math.round((canvasH - h) / 2), w, h };
}
