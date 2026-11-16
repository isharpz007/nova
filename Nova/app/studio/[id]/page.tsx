"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { isGuestClient } from "@/lib/guest";
import type { Project } from "@/lib/types";
import type {
  AnimationDocument,
  AnimationFrame,
  AnimationLayer,
} from "@/lib/studio/animation-types";
import {
  activeFrame,
  activeLayer,
  addFrame,
  addLayer,
  advanceFrameIndex,
  duplicateFrame,
  fixSelection,
  frameIndex,
  layerIndex,
  insertFrameAt,
  moveFrame,
  moveLayer,
  onionSources,
  removeFrameAt,
  removeLayerAt,
  renameLayer,
  selectFrame,
  selectLayer,
  setFrameDuration,
} from "@/lib/studio/animation-ops";
import type {
  DrawingElement,
  FillElement,
  ImageElement,
  Point,
  ShapeElement,
  ShapeKind,
  StrokeElement,
  TextElement,
  ToolName,
  ToolSettings,
} from "@/lib/studio/drawing-types";
import {
  BRUSH_MAX,
  BRUSH_MIN,
  DEFAULT_TOOL_SETTINGS,
  ERASER_MAX,
  ERASER_MIN,
  FILL_TOLERANCE,
  FONT_MAX,
  FONT_MIN,
  STROKE_WIDTH_MAX,
  STROKE_WIDTH_MIN,
} from "@/lib/studio/drawing-types";
import { deserializeDocument, nextElementId, serializeDocument } from "@/lib/studio/drawing-serialization";
import { DrawingHistory, type HistoryCommand } from "@/lib/studio/drawing-history";
import {
  appendPoint,
  clientToCanvas,
  compositeFrame,
  drawLiveElement,
  encodeMaskRle,
  floodFillMask,
  hexToRgba,
  renderLayerCanvas,
  tintCanvas,
} from "@/lib/studio/drawing-engine";
import {
  setAssetResolver,
  setImageReadyCallback,
} from "@/lib/studio/image-assets";
import type { GeneratedImage, ProviderCapabilities } from "@/lib/ai-images/types";
import {
  cornerAt,
  findImage,
  handleRect,
  hitTestImage,
  moveRect,
  placementRect,
  resizeRect,
  type Corner,
  type ImageRect,
} from "@/lib/studio/image-ops";
import {
  IconBack,
  IconBrush,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconCopy,
  IconEraser,
  IconEye,
  IconEyeOff,
  IconFill,
  IconFit,
  IconGrid,
  IconHand,
  IconLock,
  IconNext,
  IconOnion,
  IconPause,
  IconPlay,
  IconPlus,
  IconPrev,
  IconRedo,
  IconSelect,
  IconShapes,
  IconSparkle,
  IconStop,
  IconText,
  IconTrash,
  IconUndo,
  IconUnlock,
  IconZoomIn,
  IconZoomOut,
} from "@/components/Icons";

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

const TOOLS: { id: ToolName; Icon: (p: { className?: string }) => React.ReactElement; label: string; key: string }[] = [
  { id: "hand", Icon: IconHand, label: "Pan", key: "h" },
  { id: "select", Icon: IconSelect, label: "Select image", key: "v" },
  { id: "brush", Icon: IconBrush, label: "Brush", key: "b" },
  { id: "eraser", Icon: IconEraser, label: "Eraser", key: "e" },
  { id: "fill", Icon: IconFill, label: "Fill", key: "g" },
  { id: "shapes", Icon: IconShapes, label: "Shapes", key: "s" },
  { id: "text", Icon: IconText, label: "Text", key: "t" },
];

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 8;
const MAX_RECENT_COLORS = 8;
const THUMB_H = 40;
const ONION_PREV = "#ff6b6b";
const ONION_NEXT = "#4dabf7";
const ONION_PREV_ALPHA = 0.4;
const ONION_NEXT_ALPHA = 0.3;

interface TextDraft {
  canvas: Point;
  screenX: number;
  screenY: number;
  value: string;
}

export default function StudioPage() {
  const { id } = useParams<{ id: string }>();

  // ----- persisted project state -----
  const [project, setProject] = useState<Project | null>(null);
  const [title, setTitle] = useState("");
  const [background, setBackground] = useState("#ffffff");
  const [fps, setFps] = useState(12);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  // ----- drawing / workspace state -----
  const [tool, setTool] = useState<ToolName>("brush");
  const [settings, setSettings] = useState<ToolSettings>(DEFAULT_TOOL_SETTINGS);
  const [recentColors, setRecentColors] = useState<string[]>([]);
  const [zoom, setZoom] = useState(1);
  const [grid, setGrid] = useState(false);
  const [onion, setOnion] = useState(false);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [tick, setElemTick] = useState(0);
  const [renamingLayerId, setRenamingLayerId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);

  // ----- AI generation panel state -----
  const [aiOpen, setAiOpen] = useState(false);
  const [aiCaps, setAiCaps] = useState<ProviderCapabilities[] | null>(null);
  const [aiProvider, setAiProvider] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiSize, setAiSize] = useState("auto");
  const [aiCount, setAiCount] = useState(1);
  const [aiBusy, setAiBusy] = useState<"generate" | "edit" | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiResults, setAiResults] = useState<GeneratedImage[]>([]);
  const [aiEditPrompt, setAiEditPrompt] = useState("");
  const [aiEditResult, setAiEditResult] = useState<GeneratedImage | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);

  // ----- playback state -----
  const [playing, setPlaying] = useState(false);
  const [playFrameId, setPlayFrameId] = useState<string | null>(null);

  // ----- load state -----
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [guest, setGuest] = useState(false);

  // ----- engine refs (never in React render path) -----
  const displayRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<AnimationDocument | null>(null);
  const layerCanvases = useRef(new Map<string, HTMLCanvasElement>());
  const frameComposites = useRef(new Map<string, HTMLCanvasElement>());
  const onionTints = useRef(new Map<string, HTMLCanvasElement>());
  const historyRef = useRef(new DrawingHistory());
  const activeRef = useRef<StrokeElement | ShapeElement | null>(null);
  const handDragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const imgDragRef = useRef<{
    el: ImageElement;
    layer: AnimationLayer;
    start: ImageRect;
    mode: "move" | Corner;
    origin: Point;
  } | null>(null);
  const toolRef = useRef<ToolName>("brush");
  useEffect(() => {
    toolRef.current = tool;
    if (tool !== "select") setSelectedImageId(null);
  }, [tool]);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const playTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playFrameIdRef = useRef<string | null>(null);

  const selectedImageRef = useRef<string | null>(null);
  useEffect(() => {
    selectedImageRef.current = selectedImageId;
  }, [selectedImageId]);

  useEffect(() => setGuest(isGuestClient()), []);

  // Image elements resolve their pixels through the auth-proxied assets
  // route; when one finishes loading we repaint + refresh thumbnails.
  useEffect(() => {
    setAssetResolver((p) => `/api/projects/${id}/assets?path=${encodeURIComponent(p)}`);
    setImageReadyCallback(() => {
      const doc = docRef.current;
      if (!doc) return;
      rebuildLayerCanvases();
      frameComposites.current.clear();
      onionTints.current.clear();
      paint();
      bumpTick();
    });
    return () => setImageReadyCallback(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const bumpTick = useCallback(() => setElemTick((t) => t + 1), []);

  // ---------- canvas caches ----------

  const invalidateFrame = useCallback((frameId: string) => {
    frameComposites.current.delete(frameId);
    onionTints.current.delete(frameId);
  }, []);

  const layerCanvas = useCallback((layerId: string): HTMLCanvasElement | null => {
    return layerCanvases.current.get(layerId) ?? null;
  }, []);

  const rebuildLayerCanvases = useCallback(() => {
    const doc = docRef.current;
    layerCanvases.current.clear();
    if (!doc) return;
    const frame = activeFrame(doc);
    for (const layer of frame.layers) {
      layerCanvases.current.set(layer.id, renderLayerCanvas(layer, doc.canvas.width, doc.canvas.height));
    }
  }, []);

  const frameComposite = useCallback((frame: AnimationFrame, w: number, h: number): HTMLCanvasElement => {
    let c = frameComposites.current.get(frame.id);
    if (!c) {
      c = compositeFrame(frame, w, h);
      frameComposites.current.set(frame.id, c);
    }
    return c;
  }, []);

  // ---------- paint ----------

  const paint = useCallback(() => {
    const display = displayRef.current;
    const doc = docRef.current;
    if (!display || !doc) return;
    const ctx = display.getContext("2d");
    if (!ctx) return;
    const { width, height, background } = doc.canvas;

    ctx.save();
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    const playId = playFrameIdRef.current;
    if (playId) {
      const pf = doc.frames.find((f) => f.id === playId);
      if (pf) ctx.drawImage(frameComposite(pf, width, height), 0, 0);
    } else {
      const { prev: prevOnion, next: nextOnion } = doc.settings.onion
        ? onionSources(doc)
        : { prev: null, next: null };

      if (prevOnion) {
        const f = doc.frames.find((x) => x.id === prevOnion)!;
        let t = onionTints.current.get(prevOnion);
        if (!t) {
          t = tintCanvas(frameComposite(f, width, height), ONION_PREV);
          onionTints.current.set(prevOnion, t);
        }
        ctx.globalAlpha = ONION_PREV_ALPHA;
        ctx.drawImage(t, 0, 0);
        ctx.globalAlpha = 1;
      }

      const frame = activeFrame(doc);
      for (const layer of frame.layers) {
        if (!layer.visible) continue;
        const lc = layerCanvas(layer.id);
        if (!lc) continue;
        ctx.globalAlpha = layer.opacity;
        ctx.drawImage(lc, 0, 0);
        ctx.globalAlpha = 1;
      }

      if (nextOnion) {
        const f = doc.frames.find((x) => x.id === nextOnion)!;
        let t = onionTints.current.get(nextOnion);
        if (!t) {
          t = tintCanvas(frameComposite(f, width, height), ONION_NEXT);
          onionTints.current.set(nextOnion, t);
        }
        ctx.globalAlpha = ONION_NEXT_ALPHA;
        ctx.drawImage(t, 0, 0);
        ctx.globalAlpha = 1;
      }

      const active = activeRef.current;
      if (active) drawLiveElement(ctx, active, width, height);

      // image-selection chrome (canvas space — scales with zoom)
      const selId = selectedImageRef.current;
      if (selId && toolRef.current === "select") {
        const hit = findImage(activeFrame(doc), selId);
        if (hit) {
          const el = hit.element;
          ctx.strokeStyle = "#14b8a6";
          ctx.lineWidth = Math.max(1.5 / zoom, 0.5);
          ctx.setLineDash([6 / zoom, 4 / zoom]);
          ctx.strokeRect(el.x, el.y, el.w, el.h);
          ctx.setLineDash([]);
          const hs = 10 / zoom;
          ctx.fillStyle = "#14b8a6";
          for (const c of ["tl", "tr", "bl", "br"] as const) {
            const r = handleRect(el, c, hs);
            ctx.fillRect(r.x, r.y, r.w, r.h);
          }
        }
      }
    }

    if (doc.settings.grid) {
      const step = 50;
      ctx.strokeStyle = "rgba(0,0,0,0.08)";
      ctx.lineWidth = Math.max(1 / zoom, 0.5);
      ctx.beginPath();
      for (let x = step; x < width; x += step) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
      }
      for (let y = step; y < height; y += step) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }, [zoom, frameComposite, layerCanvas]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setSaveState("dirty");
  }, []);

  const trackColor = useCallback((c: string) => {
    setRecentColors((r) => [c, ...r.filter((x) => x !== c)].slice(0, MAX_RECENT_COLORS));
  }, []);

  /** After any document mutation: fix selection, rebuild caches, repaint, dirty. */
  const refresh = useCallback(() => {
    const doc = docRef.current;
    if (!doc) return;
    fixSelection(doc);
    rebuildLayerCanvases();
    // A history op can affect any frame's contents — clear every cached
    // composite so thumbnails/onion never go stale.
    frameComposites.current.clear();
    onionTints.current.clear();
    paint();
    markDirty();
    bumpTick();
  }, [markDirty, paint, rebuildLayerCanvases, bumpTick]);

  /** Execute a reversible command and refresh. */
  const run = useCallback(
    (cmd: HistoryCommand) => {
      cmd.redo();
      historyRef.current.push(cmd);
      refresh();
    },
    [refresh]
  );

  const commitElement = useCallback(
    (el: DrawingElement) => {
      const doc = docRef.current;
      if (!doc) return;
      const layer = activeLayer(doc);
      if (layer.locked) return;
      const lc = layerCanvases.current.get(layer.id);
      layer.elements.push(el);
      historyRef.current.recordAdd(layer.elements, el);
      if (lc) drawLiveElement(lc.getContext("2d")!, el, doc.canvas.width, doc.canvas.height);
      invalidateFrame(doc.activeFrameId);
      paint();
      markDirty();
      bumpTick();
      if (el.type === "stroke" && el.tool === "brush") trackColor(el.color);
      if (el.type === "shape" || el.type === "fill" || el.type === "text") trackColor(el.color);
    },
    [invalidateFrame, markDirty, paint, bumpTick, trackColor]
  );

  const undo = useCallback(() => {
    if (historyRef.current.undo()) refresh();
  }, [refresh]);

  const redo = useCallback(() => {
    if (historyRef.current.redo()) refresh();
  }, [refresh]);

  // ---------- load ----------

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/projects/${id}`);
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (res.status === 401) {
          if (!cancelled) setLoadError("Sign in to open studio projects.");
          return;
        }
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Failed to load project");
        if (cancelled) return;
        const p = json.project as Project;
        setProject(p);
        setTitle(p.title);
        setBackground(p.background);
        setFps(p.fps);

        const { document: doc, warnings } = deserializeDocument(p.document, p.width, p.height, p.background);
        warnings.forEach((w) => console.warn("[studio]", w));
        doc.settings.fps = p.fps; // top-level column is authoritative
        docRef.current = doc;
        setGrid(doc.settings.grid);
        setOnion(doc.settings.onion);
        rebuildLayerCanvases();
        historyRef.current.clear();
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load project");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Paint once the loaded project has committed — the canvas element only
  // mounts then, so a pre-commit paint() early-returns and leaves it blank.
  useEffect(() => {
    if (!project || !docRef.current) return;
    paint();
    bumpTick();
  }, [project, paint, bumpTick]);

  // Repaint when visual settings change.
  useEffect(() => {
    const doc = docRef.current;
    if (doc) {
      doc.canvas.background = background;
      doc.settings.grid = grid;
      doc.settings.onion = onion;
      doc.settings.fps = fps;
      paint();
      bumpTick();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [background, grid, onion, zoom, fps, paint]);

  // ---------- pointer handling ----------

  const canvasPoint = (e: React.PointerEvent): Point => {
    const display = displayRef.current!;
    const doc = docRef.current!;
    const rect = display.getBoundingClientRect();
    return clientToCanvas(e.clientX, e.clientY, rect, doc.canvas.width, doc.canvas.height);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const doc = docRef.current;
    if (!doc || playFrameIdRef.current || e.button !== 0) return;
    const layer = activeLayer(doc);
    if (tool !== "hand" && tool !== "select" && layer.locked) return;
    const pt = canvasPoint(e);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    if (tool === "select") {
      const frame = activeFrame(doc);
      const hs = 10 / zoom;
      // resize handle on the already-selected image takes priority
      const selId = selectedImageRef.current;
      if (selId) {
        const cur = findImage(frame, selId);
        const curLayer = cur && frame.layers[cur.layerIndex];
        if (cur && curLayer && curLayer.visible && !curLayer.locked) {
          const c = cornerAt(cur.element, pt.x, pt.y, hs);
          if (c) {
            imgDragRef.current = {
              el: cur.element,
              layer: curLayer,
              start: { x: cur.element.x, y: cur.element.y, w: cur.element.w, h: cur.element.h },
              mode: c,
              origin: pt,
            };
            return;
          }
        }
      }
      const hit = hitTestImage(frame, pt.x, pt.y);
      if (hit) {
        setSelectedImageId(hit.element.id);
        imgDragRef.current = {
          el: hit.element,
          layer: frame.layers[hit.layerIndex],
          start: { x: hit.element.x, y: hit.element.y, w: hit.element.w, h: hit.element.h },
          mode: "move",
          origin: pt,
        };
      } else {
        setSelectedImageId(null);
        paint();
      }
      return;
    }

    if (tool === "hand") {
      const stage = stageRef.current!;
      handDragRef.current = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
      return;
    }
    if (tool === "brush" || tool === "eraser") {
      activeRef.current = {
        id: nextElementId(),
        type: "stroke",
        tool,
        color: settings.brush.color,
        size: tool === "brush" ? settings.brush.size : settings.eraser.size,
        opacity: tool === "brush" ? settings.brush.opacity : 1,
        points: [pt],
      };
      paint();
      return;
    }
    if (tool === "shapes") {
      activeRef.current = {
        id: nextElementId(),
        type: "shape",
        shape: settings.shapes.shape,
        color: settings.shapes.color,
        strokeWidth: settings.shapes.strokeWidth,
        from: pt,
        to: pt,
      };
      paint();
      return;
    }
    if (tool === "fill") {
      // Fill against the visible composite; result lands on the active layer only.
      const frame = activeFrame(doc);
      const composite = frameComposite(frame, doc.canvas.width, doc.canvas.height);
      const img = composite.getContext("2d")!.getImageData(0, 0, doc.canvas.width, doc.canvas.height);
      // Composite is transparent where nothing is drawn — treat that area as
      // the background colour so filling "empty" space works.
      const bg = hexToRgba(doc.canvas.background);
      const data = img.data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) {
          data[i] = bg[0]; data[i + 1] = bg[1]; data[i + 2] = bg[2]; data[i + 3] = bg[3];
        }
      }
      const mask = floodFillMask(data, doc.canvas.width, doc.canvas.height, pt.x, pt.y, FILL_TOLERANCE);
      const el: FillElement = {
        id: nextElementId(),
        type: "fill",
        seed: pt,
        color: settings.brush.color,
        tolerance: FILL_TOLERANCE,
        mask: encodeMaskRle(mask),
      };
      commitElement(el);
      return;
    }
    if (tool === "text") {
      setTextDraft({ canvas: pt, screenX: e.clientX, screenY: e.clientY, value: "" });
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (handDragRef.current) {
      const d = handDragRef.current;
      const stage = stageRef.current!;
      stage.scrollLeft = d.left - (e.clientX - d.x);
      stage.scrollTop = d.top - (e.clientY - d.y);
      return;
    }
    const drag = imgDragRef.current;
    if (drag) {
      const pt = canvasPoint(e);
      const dx = pt.x - drag.origin.x;
      const dy = pt.y - drag.origin.y;
      const r =
        drag.mode === "move"
          ? moveRect(drag.start, dx, dy)
          : resizeRect(drag.start, drag.mode, dx, dy);
      drag.el.x = r.x;
      drag.el.y = r.y;
      drag.el.w = r.w;
      drag.el.h = r.h;
      const doc = docRef.current;
      if (doc) {
        layerCanvases.current.set(
          drag.layer.id,
          renderLayerCanvas(drag.layer, doc.canvas.width, doc.canvas.height)
        );
        invalidateFrame(doc.activeFrameId);
      }
      paint();
      return;
    }
    const active = activeRef.current;
    if (!active) return;
    const pt = canvasPoint(e);
    if (active.type === "stroke") {
      if (appendPoint(active.points, pt.x, pt.y)) paint();
    } else {
      active.to = pt;
      paint();
    }
  };

  const finishPointer = () => {
    handDragRef.current = null;
    const drag = imgDragRef.current;
    imgDragRef.current = null;
    if (drag) {
      const { el, start } = drag;
      const end = { x: el.x, y: el.y, w: el.w, h: el.h };
      if (start.x !== end.x || start.y !== end.y || start.w !== end.w || start.h !== end.h) {
        run({
          redo: () => {
            el.x = end.x; el.y = end.y; el.w = end.w; el.h = end.h;
          },
          undo: () => {
            el.x = start.x; el.y = start.y; el.w = start.w; el.h = start.h;
          },
        });
      } else {
        paint();
      }
      return;
    }
    const active = activeRef.current;
    activeRef.current = null;
    if (!active) return;
    if (active.type === "stroke" && active.points.length === 0) return;
    if (
      active.type === "shape" &&
      active.shape !== "line" &&
      active.from.x === active.to.x &&
      active.from.y === active.to.y
    ) {
      return;
    }
    commitElement(active);
  };

  // ---------- text ----------

  const commitText = (draft: TextDraft) => {
    setTextDraft(null);
    const value = draft.value.trim();
    if (!value) return;
    const el: TextElement = {
      id: nextElementId(),
      type: "text",
      position: draft.canvas,
      text: value,
      color: settings.text.color,
      fontSize: settings.text.fontSize,
    };
    commitElement(el);
  };

  // ---------- structural ops (all undoable via run()) ----------

  const frame = docRef.current ? activeFrame(docRef.current) : null;
  const layer = docRef.current ? activeLayer(docRef.current) : null;
  const selImage = frame && selectedImageId ? findImage(frame, selectedImageId)?.element ?? null : null;

  const doAddLayer = () => {
    const doc = docRef.current!;
    const f = activeFrame(doc);
    const idx = f.layers.length;
    run({
      redo: () => {
        const l = addLayer(f);
        doc.activeLayerId = l.id;
      },
      undo: () => {
        f.layers.splice(idx, 1);
        fixSelection(doc);
      },
    });
  };

  const doDeleteLayer = () => {
    const doc = docRef.current!;
    const f = activeFrame(doc);
    const idx = layerIndex(f, doc.activeLayerId);
    const l = f.layers[idx];
    if (!l || f.layers.length <= 1) return;
    if (!window.confirm(`Delete "${l.name}" and its artwork?`)) return;
    const prevLayerId = doc.activeLayerId;
    run({
      redo: () => {
        removeLayerAt(f, idx);
        if (doc.activeLayerId === l.id) doc.activeLayerId = f.layers[Math.min(idx, f.layers.length - 1)].id;
      },
      undo: () => {
        f.layers.splice(idx, 0, l);
        doc.activeLayerId = prevLayerId;
      },
    });
  };

  const doRenameLayer = (layerId: string, name: string) => {
    setRenamingLayerId(null);
    const doc = docRef.current!;
    const l = activeFrame(doc).layers.find((x) => x.id === layerId);
    if (!l) return;
    const prev = l.name;
    const next = name.trim() || prev;
    if (next === prev) return;
    run({ redo: () => void renameLayer(l, next), undo: () => void renameLayer(l, prev) });
  };

  const doMoveLayer = (dir: -1 | 1) => {
    const doc = docRef.current!;
    const f = activeFrame(doc);
    const id = doc.activeLayerId;
    run({ redo: () => void moveLayer(f, id, dir), undo: () => void moveLayer(f, id, -dir as -1 | 1) });
  };

  const toggleVisible = (l: AnimationLayer) => {
    run({ redo: () => { l.visible = !l.visible; }, undo: () => { l.visible = !l.visible; } });
  };

  const toggleLocked = (l: AnimationLayer) => {
    run({ redo: () => { l.locked = !l.locked; }, undo: () => { l.locked = !l.locked; } });
  };

  const setLayerOpacity = (l: AnimationLayer, opacity: number) => {
    const prev = l.opacity;
    const next = Math.min(1, Math.max(0, opacity));
    if (next === prev) return;
    run({ redo: () => { l.opacity = next; }, undo: () => { l.opacity = prev; } });
  };

  const doAddFrame = () => {
    const doc = docRef.current!;
    const idx = frameIndex(doc, doc.activeFrameId) + 1;
    let created: AnimationFrame | null = null;
    run({
      redo: () => {
        if (!created) {
          created = addFrame(doc);
          return;
        }
        insertFrameAt(doc, idx, created);
        doc.activeFrameId = created.id;
        doc.activeLayerId = created.layers[created.layers.length - 1].id;
      },
      undo: () => {
        if (created) removeFrameAt(doc, frameIndex(doc, created.id));
        fixSelection(doc);
      },
    });
  };

  const doDuplicateFrame = () => {
    const doc = docRef.current!;
    const srcId = doc.activeFrameId;
    const idx = frameIndex(doc, srcId) + 1;
    let dup: AnimationFrame | null = null;
    run({
      redo: () => {
        if (!dup) {
          dup = duplicateFrame(doc, srcId);
          return;
        }
        insertFrameAt(doc, idx, dup);
        selectFrame(doc, dup.id);
      },
      undo: () => {
        if (dup) removeFrameAt(doc, frameIndex(doc, dup.id));
        selectFrame(doc, srcId);
      },
    });
  };

  const doDeleteFrame = () => {
    const doc = docRef.current!;
    const idx = frameIndex(doc, doc.activeFrameId);
    const f = doc.frames[idx];
    if (!f || doc.frames.length <= 1) return;
    if (!window.confirm(`Delete "${f.name}" and all its layers?`)) return;
    run({
      redo: () => void removeFrameAt(doc, idx),
      undo: () => {
        doc.frames.splice(idx, 0, f);
        selectFrame(doc, f.id);
      },
    });
  };

  const doMoveFrame = (dir: -1 | 1) => {
    const doc = docRef.current!;
    const id = doc.activeFrameId;
    run({ redo: () => void moveFrame(doc, id, dir), undo: () => void moveFrame(doc, id, -dir as -1 | 1) });
  };

  const doSelectFrame = (frameId: string) => {
    const doc = docRef.current!;
    stopPlayback();
    selectFrame(doc, frameId);
    rebuildLayerCanvases();
    paint();
    bumpTick();
  };

  const doSelectLayer = (layerId: string) => {
    const doc = docRef.current!;
    selectLayer(doc, layerId);
    bumpTick();
  };

  const doSetDuration = (f: AnimationFrame, ms: number) => {
    const prev = f.durationMs;
    const next = Math.max(10, ms);
    if (next === prev) return;
    run({ redo: () => void setFrameDuration(f, next), undo: () => void setFrameDuration(f, prev) });
  };

  // ---------- playback ----------

  const stopPlayback = useCallback(() => {
    if (playTimerRef.current) clearTimeout(playTimerRef.current);
    playTimerRef.current = null;
    playFrameIdRef.current = null;
    setPlayFrameId(null);
    setPlaying(false);
    paint();
  }, [paint]);

  const stepPlayback = useCallback(
    (index: number) => {
      const doc = docRef.current;
      if (!doc || index < 0 || index >= doc.frames.length) {
        stopPlayback();
        return;
      }
      const f = doc.frames[index];
      playFrameIdRef.current = f.id;
      setPlayFrameId(f.id);
      paint();
      playTimerRef.current = setTimeout(() => {
        const next = advanceFrameIndex(doc, index);
        if (next < 0) {
          stopPlayback();
        } else {
          stepPlayback(next);
        }
      }, Math.max(10, f.durationMs));
    },
    [paint, stopPlayback]
  );

  const startPlayback = useCallback(() => {
    const doc = docRef.current;
    if (!doc || playTimerRef.current) return;
    setPlaying(true);
    // Resume from the paused frame when there is one, else the active frame.
    const resumeIdx = playFrameIdRef.current
      ? frameIndex(doc, playFrameIdRef.current)
      : -1;
    stepPlayback(resumeIdx >= 0 ? resumeIdx : frameIndex(doc, doc.activeFrameId));
  }, [stepPlayback]);

  const pausePlayback = useCallback(() => {
    if (playTimerRef.current) clearTimeout(playTimerRef.current);
    playTimerRef.current = null;
    setPlaying(false);
    // playFrameIdRef stays — canvas keeps showing the paused frame until
    // Play (resume) or Stop (back to active frame).
  }, []);

  const stepFrame = (dir: -1 | 1) => {
    const doc = docRef.current;
    if (!doc) return;
    stopPlayback();
    const i = frameIndex(doc, doc.activeFrameId);
    const j = Math.min(doc.frames.length - 1, Math.max(0, i + dir));
    doSelectFrame(doc.frames[j].id);
  };

  // Cleanup playback timer on unmount.
  useEffect(() => {
    return () => {
      if (playTimerRef.current) clearTimeout(playTimerRef.current);
    };
  }, []);

  // ---------- keyboard ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (typing) return;
      if (e.key === "Escape") {
        activeRef.current = null;
        imgDragRef.current = null;
        setTextDraft(null);
        setSelectedImageId(null);
        stopPlayback();
        paint();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedImageRef.current) {
        const doc = docRef.current;
        if (!doc) return;
        const frame = activeFrame(doc);
        const hit = findImage(frame, selectedImageRef.current);
        if (hit) {
          const layer = frame.layers[hit.layerIndex];
          if (!layer.locked) {
            const el = hit.element;
            run({
              redo: () => {
                const i = layer.elements.indexOf(el);
                if (i >= 0) layer.elements.splice(i, 1);
              },
              undo: () => {
                if (!layer.elements.includes(el)) layer.elements.push(el);
              },
            });
            setSelectedImageId(null);
          }
        }
        e.preventDefault();
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        if (playing) pausePlayback();
        else startPlayback();
        return;
      }
      const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
      if (t && !e.ctrlKey && !e.metaKey && !e.altKey) setTool(t.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, paint, playing, pausePlayback, startPlayback, stopPlayback, run]);

  // Warn before leaving with unsaved work.
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, []);

  // ---------- AI generation ----------

  const loadAiCaps = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${id}/ai-image`);
      if (!res.ok) return;
      const j = (await res.json()) as { providers: ProviderCapabilities[] };
      setAiCaps(j.providers);
    } catch {
      /* caps stay null — panel shows "unavailable" */
    }
  }, [id]);

  useEffect(() => {
    if (aiOpen && aiCaps === null) void loadAiCaps();
  }, [aiOpen, aiCaps, loadAiCaps]);

  useEffect(() => {
    if (aiCaps && !aiProvider && aiCaps.length) setAiProvider(aiCaps[0].id);
  }, [aiCaps, aiProvider]);

  const aiGenerate = async () => {
    const prompt = aiPrompt.trim();
    if (!prompt || aiBusy) return;
    const ctrl = new AbortController();
    aiAbortRef.current = ctrl;
    setAiBusy("generate");
    setAiError(null);
    try {
      const res = await fetch(`/api/projects/${id}/ai-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "generate",
          prompt,
          size: aiSize,
          count: aiCount,
          ...(aiProvider ? { provider: aiProvider } : {}),
        }),
        signal: ctrl.signal,
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `Generation failed (${res.status})`);
      setAiResults(j.images as GeneratedImage[]);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setAiError(e instanceof Error ? e.message : "Generation failed");
      }
    } finally {
      setAiBusy(null);
      aiAbortRef.current = null;
    }
  };

  /** Uploads b64 image data as a project asset, returns the storage path. */
  const uploadAsset = async (img: GeneratedImage): Promise<string> => {
    const res = await fetch(`/api/projects/${id}/assets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(img),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error ?? "Asset upload failed");
    return j.assetPath as string;
  };

  const imageDims = (img: GeneratedImage): Promise<{ w: number; h: number }> =>
    new Promise((res) => {
      const im = new Image();
      im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => res({ w: 256, h: 256 });
      im.src = `data:${img.mediaType};base64,${img.b64}`;
    });

  /** Inserts generated pixels as an image element on the active layer. */
  const insertGenerated = async (img: GeneratedImage) => {
    const doc = docRef.current;
    if (!doc || aiBusy) return;
    setAiError(null);
    try {
      const layer = activeLayer(doc);
      if (layer.locked) {
        setAiError("Unlock the active layer to insert.");
        return;
      }
      const [dims, assetPath] = await Promise.all([imageDims(img), uploadAsset(img)]);
      const r = placementRect(dims.w, dims.h, doc.canvas.width, doc.canvas.height);
      const el: ImageElement = {
        id: nextElementId(),
        type: "image",
        assetPath,
        ...r,
        srcW: dims.w,
        srcH: dims.h,
        rotation: 0,
        opacity: 1,
      };
      run({
        redo: () => {
          layer.elements.push(el);
        },
        undo: () => {
          const i = layer.elements.indexOf(el);
          if (i >= 0) layer.elements.splice(i, 1);
        },
      });
      setSelectedImageId(el.id);
      setTool("select");
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "Insert failed");
    }
  };

  const aiEdit = async () => {
    const doc = docRef.current;
    const prompt = aiEditPrompt.trim();
    if (!doc || !selectedImageId || !prompt || aiBusy) return;
    const hit = findImage(activeFrame(doc), selectedImageId);
    if (!hit) return;
    const ctrl = new AbortController();
    aiAbortRef.current = ctrl;
    setAiBusy("edit");
    setAiError(null);
    setAiEditResult(null);
    try {
      const res = await fetch(`/api/projects/${id}/ai-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "edit",
          prompt,
          assetPath: hit.element.assetPath,
          ...(aiProvider ? { provider: aiProvider } : {}),
        }),
        signal: ctrl.signal,
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `Edit failed (${res.status})`);
      setAiEditResult((j.images as GeneratedImage[])[0] ?? null);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setAiError(e instanceof Error ? e.message : "Edit failed");
      }
    } finally {
      setAiBusy(null);
      aiAbortRef.current = null;
    }
  };

  /** Replace the selected element's asset (original preserved until confirmed). */
  const applyEditReplace = async (img: GeneratedImage) => {
    const doc = docRef.current;
    if (!doc || !selectedImageId) return;
    const hit = findImage(activeFrame(doc), selectedImageId);
    if (!hit) return;
    setAiError(null);
    try {
      const assetPath = await uploadAsset(img);
      const el = hit.element;
      const prev = el.assetPath;
      run({
        redo: () => {
          el.assetPath = assetPath;
        },
        undo: () => {
          el.assetPath = prev;
        },
      });
      setAiEditResult(null);
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "Replace failed");
    }
  };

  // ---------- save ----------

  const save = useCallback(async () => {
    const proj = project;
    const doc = docRef.current;
    if (!proj || !doc || savingRef.current) return;
    savingRef.current = true;
    setSaveState("saving");
    setSaveError(null);
    dirtyRef.current = false;
    try {
      const res = await fetch(`/api/projects/${proj.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          background,
          fps,
          document: serializeDocument(doc),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `Save failed (${res.status})`);
      setProject(json.project as Project);
      setSaveState("saved");
    } catch (err) {
      dirtyRef.current = true;
      setSaveError(err instanceof Error ? err.message : "Save failed");
      setSaveState("error");
    } finally {
      savingRef.current = false;
      if (dirtyRef.current) void save();
    }
  }, [project, title, background, fps]);

  // ---------- zoom ----------

  const zoomTo = (z: number) => setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)));
  const fitToScreen = () => {
    const stage = stageRef.current;
    const doc = docRef.current;
    if (!stage || !doc) return;
    const pad = 48;
    zoomTo(
      Math.min(
        (stage.clientWidth - pad) / doc.canvas.width,
        (stage.clientHeight - pad) / doc.canvas.height
      )
    );
  };

  // ---------- settings helpers ----------

  const setBrush = (patch: Partial<ToolSettings["brush"]>) =>
    setSettings((s) => ({ ...s, brush: { ...s.brush, ...patch } }));
  const setEraser = (patch: Partial<ToolSettings["eraser"]>) =>
    setSettings((s) => ({ ...s, eraser: { ...s.eraser, ...patch } }));
  const setShapes = (patch: Partial<ToolSettings["shapes"]>) =>
    setSettings((s) => ({ ...s, shapes: { ...s.shapes, ...patch } }));
  const setTextSettings = (patch: Partial<ToolSettings["text"]>) =>
    setSettings((s) => ({ ...s, text: { ...s.text, ...patch } }));

  const pickColor = (v: string) => {
    if (tool === "shapes") setShapes({ color: v });
    else if (tool === "text") setTextSettings({ color: v });
    else setBrush({ color: v });
  };
  const activeColor =
    tool === "shapes" ? settings.shapes.color : tool === "text" ? settings.text.color : settings.brush.color;

  // ---------- render ----------

  if (guest || loadError === "Sign in to open studio projects.") {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-[#1e1e1e] text-neutral-300 px-4 text-center">
        <p className="font-medium">Sign in to use the studio</p>
        <p className="text-sm text-neutral-500">Projects are saved to your account.</p>
        <div className="flex gap-2">
          <Link href="/login" className="rounded-lg bg-teal-600 px-4 py-2 text-sm text-white">
            Sign in
          </Link>
          <Link href="/" className="rounded-lg border border-white/10 px-4 py-2 text-sm">
            Back
          </Link>
        </div>
      </div>
    );
  }
  if (notFound) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-[#1e1e1e] text-neutral-300">
        <p>Project not found.</p>
        <Link href="/" className="text-sm text-teal-400 hover:underline">
          Back to dashboard
        </Link>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-[#1e1e1e] text-neutral-300">
        <p>{loadError}</p>
        <Link href="/" className="text-sm text-teal-400 hover:underline">
          Back
        </Link>
      </div>
    );
  }
  if (!project || !docRef.current) {
    return (
      <div className="flex h-dvh items-center justify-center bg-[#1e1e1e] text-neutral-500 text-sm">
        Loading project…
      </div>
    );
  }

  const doc = docRef.current;
  const dirty = saveState === "dirty";
  const frames = doc.frames;

  return (
    <div className="flex h-dvh flex-col bg-[#1e1e1e] text-neutral-200 overflow-hidden">
      {/* Top toolbar */}
      <header className="shrink-0 flex flex-wrap items-center gap-2 border-b border-white/10 bg-[#252525] px-3 py-2">
        <Link href="/" className="rounded-lg p-2 text-neutral-400 hover:bg-white/10 hover:text-white" aria-label="Back to dashboard">
          <IconBack className="h-4 w-4" />
        </Link>
        <input
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            markDirty();
          }}
          className="w-40 rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm font-medium focus:border-teal-500 focus:bg-white/5 focus:outline-none"
          aria-label="Project name"
        />
        <span className="text-xs text-neutral-500">
          {doc.canvas.width} × {doc.canvas.height}
        </span>
        <div className="flex items-center gap-1 border-l border-white/10 pl-2 ml-1">
          <button onClick={undo} disabled={!historyRef.current.canUndo} title="Undo (Ctrl+Z)"
            className="rounded-lg p-2 text-neutral-400 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent">
            <IconUndo className="h-4 w-4" />
          </button>
          <button onClick={redo} disabled={!historyRef.current.canRedo} title="Redo (Ctrl+Shift+Z / Ctrl+Y)"
            className="rounded-lg p-2 text-neutral-400 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent">
            <IconRedo className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-1 border-l border-white/10 pl-2">
          <button onClick={() => zoomTo(zoom / 1.25)} title="Zoom out" className="rounded-lg p-2 text-neutral-400 hover:bg-white/10 hover:text-white">
            <IconZoomOut className="h-4 w-4" />
          </button>
          <span className="w-12 text-center text-xs text-neutral-400">{Math.round(zoom * 100)}%</span>
          <button onClick={() => zoomTo(zoom * 1.25)} title="Zoom in" className="rounded-lg p-2 text-neutral-400 hover:bg-white/10 hover:text-white">
            <IconZoomIn className="h-4 w-4" />
          </button>
          <button onClick={fitToScreen} title="Fit to screen" className="rounded-lg p-2 text-neutral-400 hover:bg-white/10 hover:text-white">
            <IconFit className="h-4 w-4" />
          </button>
          <button onClick={() => { setGrid((g) => !g); markDirty(); }} title="Toggle grid"
            className={`rounded-lg p-2 ${grid ? "bg-teal-600/20 text-teal-400" : "text-neutral-400 hover:bg-white/10 hover:text-white"}`}>
            <IconGrid className="h-4 w-4" />
          </button>
          <button onClick={() => { setOnion((o) => !o); markDirty(); }} title="Onion skin"
            className={`rounded-lg p-2 ${onion ? "bg-teal-600/20 text-teal-400" : "text-neutral-400 hover:bg-white/10 hover:text-white"}`}>
            <IconOnion className="h-4 w-4" />
          </button>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span
            className={`text-xs ${
              saveState === "error" ? "text-red-400" : dirty ? "text-amber-400" : saveState === "saved" ? "text-teal-400" : "text-neutral-500"
            }`}
            role="status"
          >
            {saveState === "saving" ? "Saving…" : saveState === "error" ? (saveError ?? "Save failed") : dirty ? "Unsaved changes" : saveState === "saved" ? "Saved" : ""}
          </span>
          <button
            onClick={save}
            disabled={saveState === "saving" || (!dirty && saveState !== "error")}
            className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 hover:bg-teal-700"
          >
            Save
          </button>
          {!guest && (
            <button
              onClick={() => setAiOpen((v) => !v)}
              title="AI image generation"
              aria-pressed={aiOpen}
              className={`rounded-lg p-1.5 transition ${
                aiOpen ? "bg-teal-600/25 text-teal-300" : "text-neutral-400 hover:bg-white/10 hover:text-white"
              }`}
            >
              <IconSparkle className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      {/* Workspace */}
      <div className="flex flex-1 min-h-0">
        {/* Left tools */}
        <aside className="w-12 shrink-0 flex flex-col items-center gap-1 border-r border-white/10 bg-[#252525] py-2">
          {TOOLS.map(({ id: tid, Icon, label, key }) => (
            <button
              key={tid}
              onClick={() => setTool(tid)}
              title={`${label} (${key.toUpperCase()})`}
              aria-pressed={tool === tid}
              className={`rounded-lg p-2.5 transition ${
                tool === tid ? "bg-teal-600/25 text-teal-300" : "text-neutral-400 hover:bg-white/10 hover:text-white"
              }`}
            >
              <Icon className="h-5 w-5" />
            </button>
          ))}
          <div className="mt-auto mb-1">
            <input
              type="color"
              value={activeColor}
              onChange={(e) => pickColor(e.target.value)}
              title="Colour"
              aria-label="Colour"
              className="h-8 w-8 cursor-pointer rounded-lg border border-white/15 bg-transparent"
            />
          </div>
        </aside>

        {/* Canvas stage */}
        <div
          ref={stageRef}
          className="flex-1 min-w-0 overflow-auto bg-[#1e1e1e] bg-[radial-gradient(circle,#2a2a2a_1px,transparent_1px)] [background-size:16px_16px]"
        >
          <div className="min-h-full min-w-full flex items-center justify-center p-6 w-max">
            <canvas
              ref={displayRef}
              width={doc.canvas.width}
              height={doc.canvas.height}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={finishPointer}
              onPointerCancel={finishPointer}
              onContextMenu={(e) => e.preventDefault()}
              className="shadow-2xl ring-1 ring-white/15 touch-none"
              style={{
                width: doc.canvas.width * zoom,
                height: doc.canvas.height * zoom,
                cursor: tool === "hand" ? "grab" : tool === "select" ? "default" : "crosshair",
              }}
            />
          </div>
        </div>

        {/* Right panel: tool settings + layers */}
        <aside className="hidden md:flex w-56 shrink-0 border-l border-white/10 bg-[#252525] flex-col overflow-hidden">
          <section className="border-b border-white/10 p-3 overflow-y-auto max-h-56">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-3">Tool</h2>
            {(tool === "brush" || tool === "fill") && (
              <ColorField color={settings.brush.color} recents={recentColors} onChange={(v) => setBrush({ color: v })} />
            )}
            {tool === "shapes" && (
              <>
                <label className="block text-xs text-neutral-400 mb-1">Shape</label>
                <div className="flex gap-1 mb-3">
                  {(["rect", "ellipse", "line"] as ShapeKind[]).map((s) => (
                    <button
                      key={s}
                      onClick={() => setShapes({ shape: s })}
                      className={`flex-1 rounded-lg px-2 py-1 text-xs capitalize ${
                        settings.shapes.shape === s ? "bg-teal-600/25 text-teal-300" : "bg-white/5 text-neutral-400"
                      }`}
                    >
                      {s === "rect" ? "Rect" : s}
                    </button>
                  ))}
                </div>
                <ColorField color={settings.shapes.color} recents={recentColors} onChange={(v) => setShapes({ color: v })} />
                <SliderField label="Stroke width" value={settings.shapes.strokeWidth} min={STROKE_WIDTH_MIN} max={STROKE_WIDTH_MAX} onChange={(v) => setShapes({ strokeWidth: v })} />
              </>
            )}
            {tool === "brush" && (
              <>
                <SliderField label="Size" value={settings.brush.size} min={BRUSH_MIN} max={BRUSH_MAX} onChange={(v) => setBrush({ size: v })} />
                <SliderField label="Opacity" value={Math.round(settings.brush.opacity * 100)} min={1} max={100} suffix="%" onChange={(v) => setBrush({ opacity: v / 100 })} />
              </>
            )}
            {tool === "eraser" && (
              <SliderField label="Size" value={settings.eraser.size} min={ERASER_MIN} max={ERASER_MAX} onChange={(v) => setEraser({ size: v })} />
            )}
            {tool === "text" && (
              <>
                <ColorField color={settings.text.color} recents={recentColors} onChange={(v) => setTextSettings({ color: v })} />
                <SliderField label="Font size" value={settings.text.fontSize} min={FONT_MIN} max={FONT_MAX} onChange={(v) => setTextSettings({ fontSize: v })} />
                <p className="text-xs text-neutral-600">Click the canvas to place text.</p>
              </>
            )}
            {tool === "fill" && <p className="text-xs text-neutral-600 mt-2">Click a region to fill it.</p>}
            {tool === "hand" && <p className="text-xs text-neutral-600">Drag the canvas to pan.</p>}
            {layer?.locked && <p className="text-xs text-amber-400 mt-2">Active layer is locked.</p>}
          </section>

          {/* Layers */}
          <section className="flex-1 min-h-0 flex flex-col">
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Layers</h2>
              <div className="flex items-center gap-0.5">
                <button onClick={doAddLayer} title="Add layer" className="rounded p-1 text-neutral-400 hover:bg-white/10 hover:text-white">
                  <IconPlus className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => doMoveLayer(1)} title="Move layer up" className="rounded p-1 text-neutral-400 hover:bg-white/10 hover:text-white">
                  <IconChevronUp className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => doMoveLayer(-1)} title="Move layer down" className="rounded p-1 text-neutral-400 hover:bg-white/10 hover:text-white">
                  <IconChevronDown className="h-3.5 w-3.5" />
                </button>
                <button onClick={doDeleteLayer} title="Delete layer" className="rounded p-1 text-neutral-400 hover:bg-white/10 hover:text-red-400">
                  <IconTrash className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <ul className="flex-1 overflow-y-auto">
              {frame &&
                [...frame.layers].reverse().map((l) => (
                  <li
                    key={l.id}
                    onClick={() => doSelectLayer(l.id)}
                    className={`flex items-center gap-1 px-2 py-1.5 cursor-pointer text-xs border-b border-white/5 ${
                      l.id === doc.activeLayerId ? "bg-teal-600/20 text-teal-200" : "hover:bg-white/5"
                    }`}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleVisible(l);
                      }}
                      title={l.visible ? "Hide layer" : "Show layer"}
                      className="text-neutral-400 hover:text-white"
                    >
                      {l.visible ? <IconEye className="h-3.5 w-3.5" /> : <IconEyeOff className="h-3.5 w-3.5 opacity-50" />}
                    </button>
                    {renamingLayerId === l.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => doRenameLayer(l.id, renameValue)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") doRenameLayer(l.id, renameValue);
                          if (e.key === "Escape") setRenamingLayerId(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="flex-1 min-w-0 rounded bg-white/10 px-1 py-0.5 text-xs focus:outline-none"
                      />
                    ) : (
                      <span
                        className={`flex-1 min-w-0 truncate ${l.visible ? "" : "opacity-40"}`}
                        onDoubleClick={() => {
                          setRenamingLayerId(l.id);
                          setRenameValue(l.name);
                        }}
                        title="Double-click to rename"
                      >
                        {l.name}
                      </span>
                    )}
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={Math.round(l.opacity * 100)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setLayerOpacity(l, parseInt(e.target.value) || 0)}
                      title="Opacity %"
                      className="w-9 rounded bg-white/5 px-1 py-0.5 text-[10px] text-neutral-400 focus:outline-none"
                    />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleLocked(l);
                      }}
                      title={l.locked ? "Unlock layer" : "Lock layer"}
                      className="text-neutral-400 hover:text-white"
                    >
                      {l.locked ? <IconLock className="h-3.5 w-3.5 text-amber-400" /> : <IconUnlock className="h-3.5 w-3.5 opacity-50" />}
                    </button>
                  </li>
                ))}
            </ul>
          </section>

          <section className="border-t border-white/10 p-3">
            <label className="block text-xs text-neutral-400 mb-1">Background</label>
            <div className="flex items-center gap-2 mb-2">
              <input
                type="color"
                value={background}
                onChange={(e) => {
                  setBackground(e.target.value);
                  markDirty();
                }}
                className="h-7 w-10 cursor-pointer rounded border border-white/10 bg-transparent"
              />
              <span className="text-xs text-neutral-400">{background}</span>
            </div>
            <label className="block text-xs text-neutral-400 mb-1">Frame rate (fps)</label>
            <input
              type="number"
              min={1}
              max={120}
              value={fps}
              onChange={(e) => {
                setFps(Math.min(120, Math.max(1, parseInt(e.target.value) || 1)));
                markDirty();
              }}
              className="w-20 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs focus:border-teal-500 focus:outline-none"
            />
          </section>
        </aside>

        {/* AI generation panel */}
        {aiOpen && !guest && (
          <aside className="w-72 shrink-0 border-l border-white/10 bg-[#252525] flex flex-col overflow-y-auto">
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
              <span className="text-xs font-medium text-neutral-300 flex items-center gap-1.5">
                <IconSparkle className="h-3.5 w-3.5 text-teal-400" /> AI Generate
              </span>
              <button onClick={() => setAiOpen(false)} className="text-neutral-500 hover:text-white text-sm leading-none" title="Close AI panel">
                ×
              </button>
            </div>

            <div className="p-3 space-y-3">
              {aiCaps === null ? (
                <p className="text-xs text-neutral-500">Checking providers…</p>
              ) : aiCaps.length === 0 ? (
                <p className="text-xs text-amber-400">
                  No image provider configured. Set OPENAI_API_KEY or GEMINI_API_KEY and restart.
                </p>
              ) : (
                <>
                  {aiCaps.length > 1 && (
                    <select
                      value={aiProvider ?? aiCaps[0].id}
                      onChange={(e) => setAiProvider(e.target.value)}
                      className="w-full rounded bg-white/5 border border-white/10 px-2 py-1.5 text-xs focus:outline-none focus:border-teal-500"
                      title="Image provider"
                    >
                      {aiCaps.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  )}

                  <textarea
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value.slice(0, 2000))}
                    rows={3}
                    placeholder="Describe the image to generate…"
                    className="w-full rounded-lg bg-white/5 border border-white/10 px-2.5 py-2 text-xs resize-y focus:outline-none focus:border-teal-500"
                  />
                  <div className="flex gap-2">
                    <select
                      value={aiSize}
                      onChange={(e) => setAiSize(e.target.value)}
                      className="flex-1 rounded bg-white/5 border border-white/10 px-2 py-1.5 text-xs focus:outline-none"
                      title="Image size"
                    >
                      <option value="auto">Auto</option>
                      <option value="1024x1024">Square</option>
                      <option value="1536x1024">Landscape</option>
                      <option value="1024x1536">Portrait</option>
                    </select>
                    <select
                      value={aiCount}
                      onChange={(e) => setAiCount(parseInt(e.target.value))}
                      className="w-20 rounded bg-white/5 border border-white/10 px-2 py-1.5 text-xs focus:outline-none"
                      title="Variations"
                    >
                      {[1, 2, 3, 4].map((n) => (
                        <option key={n} value={n}>
                          ×{n}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={aiGenerate}
                      disabled={Boolean(aiBusy) || !aiPrompt.trim()}
                      className="flex-1 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 hover:bg-teal-700"
                    >
                      {aiBusy === "generate" ? "Generating…" : aiResults.length ? "Regenerate" : "Generate"}
                    </button>
                    {aiBusy && (
                      <button
                        onClick={() => aiAbortRef.current?.abort()}
                        className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-neutral-300 hover:bg-white/10"
                      >
                        Cancel
                      </button>
                    )}
                    {aiPrompt && !aiBusy && (
                      <button
                        onClick={() => setAiPrompt("")}
                        className="rounded-lg border border-white/15 px-2.5 py-1.5 text-xs text-neutral-400 hover:bg-white/10"
                        title="Clear prompt"
                      >
                        Clear
                      </button>
                    )}
                  </div>

                  {aiError && <p className="text-xs text-red-400">{aiError}</p>}

                  {aiResults.length > 0 && (
                    <div className="grid grid-cols-2 gap-2">
                      {aiResults.map((img, i) => (
                        <figure key={i} className="rounded-lg overflow-hidden border border-white/10 bg-black/30">
                          <img
                            src={`data:${img.mediaType};base64,${img.b64}`}
                            alt={`Generated ${i + 1}`}
                            className="w-full aspect-square object-cover"
                          />
                          <figcaption className="flex gap-1 p-1.5">
                            <button
                              onClick={() => void insertGenerated(img)}
                              className="flex-1 rounded bg-teal-600/80 px-1.5 py-1 text-[10px] font-medium text-white hover:bg-teal-600"
                              title="Insert into canvas"
                            >
                              Insert
                            </button>
                            <a
                              href={`data:${img.mediaType};base64,${img.b64}`}
                              download={`nova-ai-${i + 1}.png`}
                              className="rounded border border-white/15 px-1.5 py-1 text-[10px] text-neutral-300 hover:bg-white/10"
                              title="Download"
                            >
                              ↓
                            </a>
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                  )}

                  {/* AI edit — only when an image element is selected */}
                  {selImage && aiCaps.find((c) => c.id === (aiProvider ?? aiCaps[0].id))?.edit && (
                    <div className="border-t border-white/10 pt-3 space-y-2">
                      <p className="text-[10px] uppercase tracking-wide text-neutral-500">Edit selected image</p>
                      <textarea
                        value={aiEditPrompt}
                        onChange={(e) => setAiEditPrompt(e.target.value.slice(0, 2000))}
                        rows={2}
                        placeholder="Describe the change… e.g. 'make the sky sunset orange'"
                        className="w-full rounded-lg bg-white/5 border border-white/10 px-2.5 py-2 text-xs resize-y focus:outline-none focus:border-teal-500"
                      />
                      <button
                        onClick={aiEdit}
                        disabled={Boolean(aiBusy) || !aiEditPrompt.trim()}
                        className="w-full rounded-lg bg-teal-600/80 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 hover:bg-teal-600"
                      >
                        {aiBusy === "edit" ? "Editing…" : "Generate edit"}
                      </button>
                      {aiEditResult && (
                        <figure className="rounded-lg overflow-hidden border border-white/10 bg-black/30">
                          <img
                            src={`data:${aiEditResult.mediaType};base64,${aiEditResult.b64}`}
                            alt="Edited preview"
                            className="w-full aspect-square object-cover"
                          />
                          <figcaption className="flex gap-1 p-1.5">
                            <button
                              onClick={() => void applyEditReplace(aiEditResult)}
                              className="flex-1 rounded bg-teal-600/80 px-1.5 py-1 text-[10px] font-medium text-white hover:bg-teal-600"
                              title="Replace the selected image's content"
                            >
                              Replace
                            </button>
                            <button
                              onClick={() => void insertGenerated(aiEditResult)}
                              className="flex-1 rounded border border-white/15 px-1.5 py-1 text-[10px] text-neutral-300 hover:bg-white/10"
                              title="Insert as a new image element"
                            >
                              Insert new
                            </button>
                            <button
                              onClick={() => setAiEditResult(null)}
                              className="rounded border border-white/15 px-1.5 py-1 text-[10px] text-neutral-400 hover:bg-white/10"
                              title="Discard preview"
                            >
                              ×
                            </button>
                          </figcaption>
                        </figure>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* Timeline */}
      <footer className="h-28 shrink-0 border-t border-white/10 bg-[#252525] flex items-stretch gap-2 px-3 py-2 overflow-hidden">
        {/* playback controls */}
        <div className="flex flex-col justify-center gap-1">
          <div className="flex items-center gap-0.5">
            <button onClick={() => stepFrame(-1)} title="Previous frame" className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white">
              <IconPrev className="h-4 w-4" />
            </button>
            {playing ? (
              <button onClick={pausePlayback} title="Pause (Space)" className="rounded p-1.5 bg-teal-600/25 text-teal-300">
                <IconPause className="h-4 w-4" />
              </button>
            ) : (
              <button onClick={startPlayback} title="Play (Space)" className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white">
                <IconPlay className="h-4 w-4" />
              </button>
            )}
            <button onClick={stopPlayback} title="Stop" className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white">
              <IconStop className="h-4 w-4" />
            </button>
            <button onClick={() => stepFrame(1)} title="Next frame" className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white">
              <IconNext className="h-4 w-4" />
            </button>
            <button
              onClick={() => {
                const doc = docRef.current!;
                run({ redo: () => { doc.settings.loop = !doc.settings.loop; }, undo: () => { doc.settings.loop = !doc.settings.loop; } });
              }}
              title="Loop playback"
              className={`rounded px-1.5 py-1 text-[10px] font-medium ${doc.settings.loop ? "bg-teal-600/25 text-teal-300" : "text-neutral-400 hover:bg-white/10"}`}
            >
              Loop
            </button>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-neutral-400">
            <span>dur</span>
            <input
              type="number"
              min={10}
              max={60000}
              value={frame?.durationMs ?? 0}
              onChange={(e) => frame && doSetDuration(frame, parseInt(e.target.value) || 10)}
              title="Frame duration (ms)"
              className="w-14 rounded bg-white/5 px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
            <span>ms</span>
          </div>
        </div>

        <div className="w-px bg-white/10" />

        {/* frame strip */}
        <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto">
          {frames.map((f, i) => (
            <button
              key={f.id}
              onClick={() => doSelectFrame(f.id)}
              className={`shrink-0 rounded-lg border p-1 text-left transition ${
                f.id === (playFrameId ?? doc.activeFrameId)
                  ? "border-teal-500 bg-teal-600/15"
                  : "border-white/10 hover:border-white/30"
              }`}
              title={`${f.name} — ${f.durationMs}ms`}
            >
              <FrameThumb frame={f} w={doc.canvas.width} h={doc.canvas.height} bg={doc.canvas.background} tick={tick} />
              <div className="mt-0.5 flex justify-between text-[9px] text-neutral-400">
                <span className="truncate max-w-12">{i + 1}</span>
                <span>{f.durationMs}ms</span>
              </div>
            </button>
          ))}
        </div>

        {/* frame ops */}
        <div className="flex flex-col justify-center gap-0.5">
          <div className="flex gap-0.5">
            <button onClick={doAddFrame} title="Add frame" className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white">
              <IconPlus className="h-4 w-4" />
            </button>
            <button onClick={doDuplicateFrame} title="Duplicate frame" className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white">
              <IconCopy className="h-4 w-4" />
            </button>
            <button onClick={doDeleteFrame} title="Delete frame" className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-red-400">
              <IconTrash className="h-4 w-4" />
            </button>
          </div>
          <div className="flex gap-0.5">
            <button onClick={() => doMoveFrame(-1)} title="Move frame left" className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white">
              <IconChevronLeft className="h-4 w-4" />
            </button>
            <button onClick={() => doMoveFrame(1)} title="Move frame right" className="rounded p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white">
              <IconChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </footer>

      {/* Text placement input */}
      {textDraft && (
        <input
          autoFocus
          value={textDraft.value}
          onChange={(e) => setTextDraft({ ...textDraft, value: e.target.value })}
          onBlur={() => commitText(textDraft)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitText(textDraft);
            if (e.key === "Escape") setTextDraft(null);
          }}
          placeholder="Type…"
          className="fixed z-50 rounded border border-teal-500 bg-[#252525] px-1 py-0.5 text-neutral-100 focus:outline-none"
          style={{
            left: textDraft.screenX,
            top: textDraft.screenY,
            fontSize: Math.max(12, settings.text.fontSize * zoom * 0.5),
            color: settings.text.color,
          }}
        />
      )}
    </div>
  );
}

// ---------- frame thumbnail ----------

function FrameThumb({ frame, w, h, bg, tick }: { frame: AnimationFrame; w: number; h: number; bg: string; tick: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const scale = THUMB_H / h;
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = THUMB_H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const composite = compositeFrame(frame, w, h);
    ctx.drawImage(composite, 0, 0, w, h, 0, 0, canvas.width, canvas.height);
  }, [frame, w, h, bg, tick]);
  return <canvas ref={ref} className="block rounded-sm" style={{ height: THUMB_H, width: "auto" }} />;
}

// ---------- small controls ----------

function SliderField({
  label,
  value,
  min,
  max,
  suffix = "px",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mb-3">
      <div className="flex justify-between text-xs text-neutral-400 mb-1">
        <span>{label}</span>
        <span>
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value))}
        className="w-full accent-teal-500"
      />
    </div>
  );
}

function ColorField({
  color,
  recents,
  onChange,
}: {
  color: string;
  recents: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="mb-3">
      <label className="block text-xs text-neutral-400 mb-1">Colour</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={color}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-10 cursor-pointer rounded border border-white/10 bg-transparent"
        />
        <input
          value={color}
          onChange={(e) => onChange(e.target.value)}
          maxLength={9}
          className="w-20 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs font-mono focus:border-teal-500 focus:outline-none"
          aria-label="Hex colour"
        />
      </div>
      {recents.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {recents.map((c) => (
            <button
              key={c}
              onClick={() => onChange(c)}
              title={c}
              className="h-5 w-5 rounded border border-white/20"
              style={{ background: c }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
