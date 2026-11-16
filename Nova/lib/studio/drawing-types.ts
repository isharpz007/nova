// Drawing document model — version 2.
// Elements replay deterministically to produce the artwork; the model is
// designed so later phases can add `layers[]` (each holding elements) and
// `frames[]` without another format migration.

export type ToolName = "hand" | "select" | "brush" | "eraser" | "fill" | "shapes" | "text";
export type ShapeKind = "rect" | "ellipse" | "line";

export interface Point {
  x: number;
  y: number;
}

export interface StrokeElement {
  id: string;
  type: "stroke";
  tool: "brush" | "eraser";
  color: string; // ignored for eraser
  size: number;
  opacity: number; // 0..1
  points: Point[];
}

export interface ShapeElement {
  id: string;
  type: "shape";
  shape: ShapeKind;
  color: string;
  strokeWidth: number;
  from: Point;
  to: Point;
}

export interface FillElement {
  id: string;
  type: "fill";
  seed: Point; // canvas-space seed; replayed as flood fill over prior elements
  color: string;
  tolerance: number; // 0..255 channel tolerance
  /**
   * Optional RLE mask baked at commit time (mask computed against the visible
   * composite). When present, replay applies the mask exactly — deterministic
   * even if other layers change later.
   */
  mask?: number[];
}

export interface TextElement {
  id: string;
  type: "text";
  position: Point;
  text: string;
  color: string;
  fontSize: number;
}

/**
 * AI-generated (or imported) raster image. The document only stores the
 * storage path inside the private `project-assets` bucket — never pixels.
 */
export interface ImageElement {
  id: string;
  type: "image";
  /** Path inside the `project-assets` bucket, e.g. "{uid}/{projectId}/{file}.png" */
  assetPath: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Original pixel dimensions of the asset (for aspect-ratio math). */
  srcW: number;
  srcH: number;
  /** Radians, clockwise, around the element centre. Default 0. */
  rotation: number;
  opacity: number; // 0..1
}

export type DrawingElement = StrokeElement | ShapeElement | FillElement | TextElement | ImageElement;

export interface DrawingDocument {
  version: 2;
  canvas: { width: number; height: number; background: string };
  elements: DrawingElement[];
  settings: { grid: boolean };
}

export interface BrushSettings {
  color: string;
  size: number;
  opacity: number; // 0..1
}

export interface ToolSettings {
  brush: BrushSettings;
  eraser: { size: number };
  shapes: { shape: ShapeKind; color: string; strokeWidth: number };
  text: { color: string; fontSize: number };
}

export const DEFAULT_TOOL_SETTINGS: ToolSettings = {
  brush: { color: "#000000", size: 5, opacity: 1 },
  eraser: { size: 20 },
  shapes: { shape: "rect", color: "#000000", strokeWidth: 3 },
  text: { color: "#000000", fontSize: 24 },
};

export const BRUSH_MIN = 1;
export const BRUSH_MAX = 200;
export const ERASER_MIN = 1;
export const ERASER_MAX = 200;
export const STROKE_WIDTH_MIN = 1;
export const STROKE_WIDTH_MAX = 100;
export const FONT_MIN = 8;
export const FONT_MAX = 400;
export const FILL_TOLERANCE = 32;
export const MAX_HISTORY = 100;
