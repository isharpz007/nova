// Serialization + migration for the studio document.
// v1 (Phase 0): { version: 1, layers: [], frames: [] }
// v2 (Phase 1): { version: 2, canvas, elements, settings:{grid} }
// v3 (Phase 2): { version: 3, canvas, settings{grid,fps,loop,onion},
//                 frames[{id,name,durationMs,layers[{…,elements}]}],
//                 activeFrameId, activeLayerId }
// All older formats migrate to v3 without losing artwork; anything
// unrecognized degrades to an empty v3 document with a warning.

import type {
  AnimationDocument,
  AnimationFrame,
  AnimationLayer,
} from "./animation-types";
import { DEFAULT_FPS, MAX_FRAME_MS, MIN_FRAME_MS } from "./animation-types";
import { makeDocument, makeFrame, makeLayer } from "./animation-ops";
import type {
  DrawingElement,
  FillElement,
  ImageElement,
  ShapeElement,
  StrokeElement,
  TextElement,
} from "./drawing-types";
import type { ProjectDocument } from "../types";

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
let counter = 0;

export function nextElementId(): string {
  counter += 1;
  return `el_${Date.now().toString(36)}_${counter.toString(36)}`;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v ? v : fallback;
}
function color(v: unknown, fallback: string): string {
  return typeof v === "string" && HEX.test(v) ? v : fallback;
}
function point(v: unknown): { x: number; y: number } | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const p = v as Record<string, unknown>;
    if (typeof p.x === "number" && typeof p.y === "number") return { x: p.x, y: p.y };
  }
  return null;
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function sanitizeElement(raw: unknown): DrawingElement | null {
  const e = obj(raw);
  if (!e.type) return null;
  const id = str(e.id, nextElementId());

  switch (e.type) {
    case "stroke": {
      const pts = Array.isArray(e.points) ? e.points.map(point).filter(Boolean) : [];
      if (pts.length === 0) return null;
      const tool = e.tool === "eraser" ? "eraser" : "brush";
      return {
        id,
        type: "stroke",
        tool,
        color: color(e.color, "#000000"),
        size: Math.min(200, Math.max(1, num(e.size, 5))),
        opacity: Math.min(1, Math.max(0, num(e.opacity, 1))),
        points: pts as { x: number; y: number }[],
      } satisfies StrokeElement;
    }
    case "shape": {
      const from = point(e.from);
      const to = point(e.to);
      if (!from || !to) return null;
      const shape = e.shape === "ellipse" || e.shape === "line" ? e.shape : "rect";
      return {
        id,
        type: "shape",
        shape,
        color: color(e.color, "#000000"),
        strokeWidth: Math.min(100, Math.max(1, num(e.strokeWidth, 3))),
        from,
        to,
      } satisfies ShapeElement;
    }
    case "fill": {
      const seed = point(e.seed);
      if (!seed) return null;
      const mask = Array.isArray(e.mask)
        ? (e.mask as unknown[]).filter((n): n is number => typeof n === "number" && n >= 0)
        : undefined;
      return {
        id,
        type: "fill",
        seed,
        color: color(e.color, "#000000"),
        tolerance: Math.min(255, Math.max(0, num(e.tolerance, 32))),
        ...(mask && mask.length ? { mask } : {}),
      } satisfies FillElement;
    }
    case "text": {
      const position = point(e.position);
      const text = typeof e.text === "string" ? e.text : "";
      if (!position || !text.trim()) return null;
      return {
        id,
        type: "text",
        position,
        text,
        color: color(e.color, "#000000"),
        fontSize: Math.min(400, Math.max(8, num(e.fontSize, 24))),
      } satisfies TextElement;
    }
    case "image": {
      const assetPath = typeof e.assetPath === "string" ? e.assetPath.trim() : "";
      const w = num(e.w, 0);
      const h = num(e.h, 0);
      const srcW = num(e.srcW, 0);
      const srcH = num(e.srcH, 0);
      if (!assetPath || w <= 0 || h <= 0 || srcW <= 0 || srcH <= 0) return null;
      return {
        id,
        type: "image",
        assetPath,
        x: num(e.x, 0),
        y: num(e.y, 0),
        w: Math.min(8192, w),
        h: Math.min(8192, h),
        srcW: Math.min(8192, srcW),
        srcH: Math.min(8192, srcH),
        rotation: num(e.rotation, 0),
        opacity: Math.min(1, Math.max(0, num(e.opacity, 1))),
      } satisfies ImageElement;
    }
    default:
      return null;
  }
}

function sanitizeElements(raw: unknown, warnings: string[]): DrawingElement[] {
  if (!Array.isArray(raw)) return [];
  const out = raw.map(sanitizeElement).filter((e): e is DrawingElement => e !== null);
  const dropped = raw.length - out.length;
  if (dropped > 0) warnings.push(`${dropped} element(s) were corrupt and skipped.`);
  return out;
}

function sanitizeLayer(raw: unknown, index: number, warnings: string[]): AnimationLayer {
  const l = obj(raw);
  return {
    id: str(l.id, nextElementId()),
    name: str(l.name, `Layer ${index + 1}`),
    visible: l.visible !== false,
    opacity: Math.min(1, Math.max(0, num(l.opacity, 1))),
    locked: l.locked === true,
    elements: sanitizeElements(l.elements, warnings),
  };
}

function sanitizeFrame(raw: unknown, index: number, warnings: string[]): AnimationFrame {
  const f = obj(raw);
  const layers = Array.isArray(f.layers)
    ? f.layers.map((l, i) => sanitizeLayer(l, i, warnings))
    : [];
  return {
    id: str(f.id, nextElementId()),
    name: str(f.name, `Frame ${index + 1}`),
    durationMs: Math.min(MAX_FRAME_MS, Math.max(MIN_FRAME_MS, num(f.durationMs, Math.round(1000 / DEFAULT_FPS)))),
    layers: layers.length ? layers : [makeLayer("Layer 1")],
  };
}

export interface DeserializeResult {
  document: AnimationDocument;
  migrated: boolean; // true if input was not a clean v3 doc
  warnings: string[];
}

/**
 * Loads any stored document (v1, v2, v3, malformed, missing) into a valid
 * AnimationDocument. Never throws — degrades safely rather than destroying
 * user work.
 */
export function deserializeDocument(
  raw: ProjectDocument | null | undefined,
  canvasWidth: number,
  canvasHeight: number,
  canvasBackground: string
): DeserializeResult {
  const warnings: string[] = [];
  const base = makeDocument(canvasWidth, canvasHeight, canvasBackground);

  if (raw == null) return { document: base, migrated: false, warnings };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("Unrecognized document format — starting fresh.");
    return { document: base, migrated: true, warnings };
  }

  // ---- v1 (Phase 0) / unversioned → empty v3 ----
  if (raw.version === 1) {
    return { document: base, migrated: true, warnings };
  }
  if (raw.version === undefined) {
    warnings.push("Document had no version — treated as empty project.");
    return { document: base, migrated: true, warnings };
  }

  // ---- v2 (Phase 1) → wrap elements into Frame 1 / Layer 1 ----
  if (raw.version === 2) {
    const c = obj(raw.canvas);
    const s = obj(raw.settings);
    const elements = sanitizeElements(raw.elements, warnings);
    const layer = makeLayer("Layer 1", elements);
    const frame = makeFrame("Frame 1", Math.round(1000 / DEFAULT_FPS), [layer]);
    return {
      document: {
        version: 3,
        canvas: {
          width: num(c.width, canvasWidth),
          height: num(c.height, canvasHeight),
          background: color(c.background, canvasBackground),
        },
        settings: { grid: s.grid === true, fps: DEFAULT_FPS, loop: true, onion: false },
        frames: [frame],
        activeFrameId: frame.id,
        activeLayerId: layer.id,
      },
      migrated: true,
      warnings,
    };
  }

  if (raw.version !== 3) {
    warnings.push(`Unsupported document version ${raw.version} — starting fresh.`);
    return { document: base, migrated: true, warnings };
  }

  // ---- v3 ----
  const c = obj(raw.canvas);
  const s = obj(raw.settings);
  const frames = Array.isArray(raw.frames)
    ? (raw.frames as unknown[]).map((f, i) => sanitizeFrame(f, i, warnings))
    : [];
  const safeFrames = frames.length ? frames : [makeFrame("Frame 1", Math.round(1000 / DEFAULT_FPS))];

  const activeFrame =
    safeFrames.find((f) => f.id === raw.activeFrameId) ?? safeFrames[0];
  const activeLayer =
    activeFrame.layers.find((l) => l.id === raw.activeLayerId) ??
    activeFrame.layers[activeFrame.layers.length - 1];

  return {
    document: {
      version: 3,
      canvas: {
        width: num(c.width, canvasWidth),
        height: num(c.height, canvasHeight),
        background: color(c.background, canvasBackground),
      },
      settings: {
        grid: s.grid === true,
        fps: Math.min(120, Math.max(1, num(s.fps, DEFAULT_FPS))),
        loop: s.loop !== false,
        onion: s.onion === true,
      },
      frames: safeFrames,
      activeFrameId: activeFrame.id,
      activeLayerId: activeLayer.id,
    },
    migrated: false,
    warnings,
  };
}

/** Serializes an AnimationDocument for the projects.document JSONB column. */
export function serializeDocument(doc: AnimationDocument): ProjectDocument {
  return doc as unknown as ProjectDocument;
}
