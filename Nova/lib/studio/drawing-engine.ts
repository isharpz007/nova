// Drawing engine: pure geometric/pixel core + Canvas2D renderers.
// The artwork lives on an offscreen "ink" canvas at project resolution;
// elements replay deterministically onto it. Fills replay as flood fill over
// the composite of preceding elements — correct under undo/redo.

import type {
  DrawingElement,
  FillElement,
  ImageElement,
  Point,
  ShapeElement,
  StrokeElement,
  TextElement,
} from "./drawing-types";
import { getAssetImage, getAssetStatus } from "./image-assets";

// ---------- pure helpers (no DOM — unit-testable) ----------

/** Maps a client pointer position to canvas-space coordinates. */
export function clientToCanvas(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  canvasWidth: number,
  canvasHeight: number
): Point {
  return {
    x: ((clientX - rect.left) / rect.width) * canvasWidth,
    y: ((clientY - rect.top) / rect.height) * canvasHeight,
  };
}

/**
 * Appends a point to a stroke's point list if it is far enough from the last
 * one. Keeps stored strokes compact at high pointer-event rates.
 * Returns true if the point was appended.
 */
export function appendPoint(points: Point[], x: number, y: number, minDist = 0.5): boolean {
  const last = points[points.length - 1];
  if (!last) {
    points.push({ x, y });
    return true;
  }
  const dx = x - last.x;
  const dy = y - last.y;
  if (dx * dx + dy * dy >= minDist * minDist) {
    points.push({ x, y });
    return true;
  }
  return false;
}

export function hexToRgba(hex: string): [number, number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 6) h += "ff";
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
    parseInt(h.slice(6, 8), 16),
  ];
}

/**
 * Scanline flood fill over an RGBA pixel buffer. Pure — operates on
 * Uint8ClampedArray so it is testable without a DOM. `data` is w*h*4.
 * Fills the connected region of the seed pixel's colour with `rgba` when the
 * channel difference is within `tolerance`. Mutates `data`; returns pixels filled.
 */
export function floodFillRegion(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  seedX: number,
  seedY: number,
  rgba: [number, number, number, number],
  tolerance: number
): number {
  const sx = Math.floor(seedX);
  const sy = Math.floor(seedY);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return 0;

  const si = (sy * w + sx) * 4;
  const tr = data[si];
  const tg = data[si + 1];
  const tb = data[si + 2];
  const ta = data[si + 3];
  const tol = tolerance * tolerance * 4;

  // Already the target colour — nothing to do.
  if (
    tr === rgba[0] && tg === rgba[1] && tb === rgba[2] && ta === rgba[3]
  ) {
    return 0;
  }

  const within = (i: number): boolean => {
    const dr = data[i] - tr;
    const dg = data[i + 1] - tg;
    const db = data[i + 2] - tb;
    const da = data[i + 3] - ta;
    return dr * dr + dg * dg + db * db + da * da <= tol;
  };

  const stack: number[] = [sx + sy * w];
  const visited = new Uint8Array(w * h);
  visited[sx + sy * w] = 1;
  let filled = 0;

  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    const y = (p - x) / w;
    const i = p * 4;
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
    filled++;

    // Scanline expansion — checks runs rather than blindly pushing 4 neighbours.
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ] as const) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const np = nx + ny * w;
      if (!visited[np] && within(np * 4)) {
        visited[np] = 1;
        stack.push(np);
      }
    }
  }
  return filled;
}

/** Bounding box of a shape element (for future hit-testing / selection). */
export function shapeBounds(el: ShapeElement): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(el.from.x, el.to.x),
    y: Math.min(el.from.y, el.to.y),
    w: Math.abs(el.to.x - el.from.x),
    h: Math.abs(el.to.y - el.from.y),
  };
}

// ---------- Canvas2D renderers ----------

function drawStroke(ctx: CanvasRenderingContext2D, el: StrokeElement): void {
  ctx.save();
  ctx.globalAlpha = el.opacity;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = el.color;
  ctx.fillStyle = el.color;
  ctx.lineWidth = el.size;
  if (el.tool === "eraser") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "#000";
    ctx.fillStyle = "#000";
  }
  if (el.points.length === 1) {
    const p = el.points[0];
    ctx.beginPath();
    ctx.arc(p.x, p.y, el.size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(el.points[0].x, el.points[0].y);
    for (let i = 1; i < el.points.length; i++) ctx.lineTo(el.points[i].x, el.points[i].y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawShape(ctx: CanvasRenderingContext2D, el: ShapeElement): void {
  const b = shapeBounds(el);
  ctx.save();
  ctx.strokeStyle = el.color;
  ctx.lineWidth = el.strokeWidth;
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (el.shape === "rect") {
    ctx.rect(b.x, b.y, b.w, b.h);
  } else if (el.shape === "ellipse") {
    ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, Math.max(1, b.w / 2), Math.max(1, b.h / 2), 0, 0, Math.PI * 2);
  } else {
    ctx.moveTo(el.from.x, el.from.y);
    ctx.lineTo(el.to.x, el.to.y);
    ctx.lineCap = "round";
  }
  ctx.stroke();
  ctx.restore();
}

function applyFill(ctx: CanvasRenderingContext2D, el: FillElement, w: number, h: number): void {
  const rgba = hexToRgba(el.color);
  if (el.mask && el.mask.length) {
    applyMask(ctx, w, h, decodeMaskRle(el.mask, w * h), rgba);
    return;
  }
  const img = ctx.getImageData(0, 0, w, h);
  const mask = floodFillMask(img.data, w, h, el.seed.x, el.seed.y, el.tolerance);
  applyMask(ctx, w, h, mask, rgba);
}

function drawText(ctx: CanvasRenderingContext2D, el: TextElement): void {
  ctx.save();
  ctx.fillStyle = el.color;
  ctx.font = `${el.fontSize}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.fillText(el.text, el.position.x, el.position.y);
  ctx.restore();
}

/**
 * Raster image element. The bitmap resolves through the async asset cache;
 * while loading (or on error) a placeholder is drawn so one missing asset
 * can never block the rest of the artwork. The cache notifies the studio to
 * repaint once the real pixels arrive.
 */
function drawImageElement(ctx: CanvasRenderingContext2D, el: ImageElement): void {
  const img = getAssetImage(el.assetPath);
  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0, el.opacity));
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  if (el.rotation) {
    ctx.translate(cx, cy);
    ctx.rotate(el.rotation);
    ctx.translate(-cx, -cy);
  }
  if (img) {
    ctx.drawImage(img, el.x, el.y, el.w, el.h);
  } else {
    const status = getAssetStatus(el.assetPath);
    ctx.fillStyle = status === "error" ? "rgba(160,60,60,0.15)" : "rgba(120,120,120,0.12)";
    ctx.fillRect(el.x, el.y, el.w, el.h);
    ctx.strokeStyle = status === "error" ? "#a04040" : "#888";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(el.x + 0.5, el.y + 0.5, el.w - 1, el.h - 1);
    ctx.setLineDash([]);
    if (status === "error") {
      ctx.beginPath();
      ctx.moveTo(el.x + 6, el.y + 6);
      ctx.lineTo(el.x + el.w - 6, el.y + el.h - 6);
      ctx.moveTo(el.x + el.w - 6, el.y + 6);
      ctx.lineTo(el.x + 6, el.y + el.h - 6);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * Replays all elements onto a cleared context (the ink canvas — transparent
 * where nothing was drawn). `background` is NOT painted here; the display
 * compositor fills it underneath so erasers can't destroy the page colour.
 */
export function replayElements(
  ctx: CanvasRenderingContext2D,
  elements: DrawingElement[],
  width: number,
  height: number
): void {
  ctx.clearRect(0, 0, width, height);
  for (const el of elements) {
    switch (el.type) {
      case "stroke":
        drawStroke(ctx, el);
        break;
      case "shape":
        drawShape(ctx, el);
        break;
      case "fill":
        applyFill(ctx, el, width, height);
        break;
      case "text":
        drawText(ctx, el);
        break;
      case "image":
        drawImageElement(ctx, el);
        break;
    }
  }
}

/** Draws a single element incrementally (live stroke preview during drawing). */
export function drawLiveElement(
  ctx: CanvasRenderingContext2D,
  el: DrawingElement,
  width: number,
  height: number
): void {
  switch (el.type) {
    case "stroke":
      drawStroke(ctx, el);
      break;
    case "shape":
      drawShape(ctx, el);
      break;
    case "fill":
      applyFill(ctx, el, width, height);
      break;
    case "text":
      drawText(ctx, el);
      break;
    case "image":
      drawImageElement(ctx, el);
      break;
  }
}

// ---------- layer / frame compositing ----------

import type { AnimationFrame, AnimationLayer } from "./animation-types";

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** Renders one layer's elements onto its own canvas (transparent bg). */
export function renderLayerCanvas(layer: AnimationLayer, w: number, h: number): HTMLCanvasElement {
  const c = makeCanvas(w, h);
  const ctx = c.getContext("2d");
  if (ctx) replayElements(ctx, layer.elements, w, h);
  return c;
}

/**
 * Composites a whole frame: visible layers bottom→top, each at its own
 * opacity, over a transparent canvas. Used for onion skins and thumbnails —
 * the displayed background is filled separately.
 */
export function compositeFrame(frame: AnimationFrame, w: number, h: number): HTMLCanvasElement {
  const out = makeCanvas(w, h);
  const ctx = out.getContext("2d");
  if (!ctx) return out;
  for (const layer of frame.layers) {
    if (!layer.visible) continue;
    const layerCanvas = renderLayerCanvas(layer, w, h);
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(layerCanvas, 0, 0);
  }
  ctx.globalAlpha = 1;
  return out;
}

/** Returns a tinted copy of `src` — opaque pixels recoloured, alpha kept. */
export function tintCanvas(src: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const out = makeCanvas(src.width, src.height);
  const ctx = out.getContext("2d");
  if (!ctx) return out;
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, out.width, out.height);
  return out;
}

// ---------- composite-aware fill (mask-baked) ----------

/**
 * Like floodFillRegion but returns a 0/1 mask instead of writing pixels —
 * lets a fill be computed against the visible composite while the result is
 * applied to (and stored on) only the editable layer.
 */
export function floodFillMask(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  seedX: number,
  seedY: number,
  tolerance: number
): Uint8Array {
  const mask = new Uint8Array(w * h);
  const sx = Math.floor(seedX);
  const sy = Math.floor(seedY);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;

  const si = (sy * w + sx) * 4;
  const tr = data[si], tg = data[si + 1], tb = data[si + 2], ta = data[si + 3];
  const tol = tolerance * tolerance * 4;
  const within = (i: number): boolean => {
    const dr = data[i] - tr, dg = data[i + 1] - tg, db = data[i + 2] - tb, da = data[i + 3] - ta;
    return dr * dr + dg * dg + db * db + da * da <= tol;
  };

  const stack = [sx + sy * w];
  mask[sx + sy * w] = 1;
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w, y = (p - x) / w;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const np = nx + ny * w;
      if (!mask[np] && within(np * 4)) {
        mask[np] = 1;
        stack.push(np);
      }
    }
  }
  return mask;
}

/** Run-length encodes a 0/1 mask: alternating run lengths starting with a 0-run. */
export function encodeMaskRle(mask: Uint8Array): number[] {
  const out: number[] = [];
  let cur = 0, run = 0;
  for (const b of mask) {
    if (b === cur) run++;
    else {
      out.push(run);
      cur = b;
      run = 1;
    }
  }
  out.push(run);
  return out;
}

/** Decodes an RLE mask into a 0/1 mask buffer of length w*h. */
export function decodeMaskRle(rle: number[], length: number): Uint8Array {
  const mask = new Uint8Array(length);
  let i = 0, val = 0;
  for (const run of rle) {
    if (val === 1) mask.fill(1, i, i + run);
    i += run;
    val = 1 - val;
  }
  return mask.subarray(0, length);
}

/** Applies a mask to a context: fills masked pixels with rgba, leaving the rest untouched. */
export function applyMask(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  mask: Uint8Array,
  rgba: [number, number, number, number]
): void {
  const img = new ImageData(w, h);
  for (let p = 0; p < w * h; p++) {
    if (!mask[p]) continue;
    const i = p * 4;
    img.data[i] = rgba[0];
    img.data[i + 1] = rgba[1];
    img.data[i + 2] = rgba[2];
    img.data[i + 3] = rgba[3];
  }
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  tmp.getContext("2d")!.putImageData(img, 0, 0);
  ctx.drawImage(tmp, 0, 0);
}
