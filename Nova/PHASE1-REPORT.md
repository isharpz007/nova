# NOVA Phase 1 — Drawing Engine Implementation Report

**Date:** 2026-11-16
**Status:** Complete. 33/33 drawing checks + 20/20 Phase 0 regression + clean typecheck.

---

## 1. Objective

Transform the Phase 0 studio canvas from a static placeholder into a functional 2D drawing environment — brush, eraser, colour, shapes, fill, text, undo/redo, zoom, save — with a document model designed for Phase 2 (layers/frames) and beyond.

---

## 2. Files created

| File | Purpose |
|---|---|
| `lib/studio/drawing-types.ts` | v2 document model: `canvas {width,height,background}`, `elements[]` (stroke / shape / fill / text union), `settings {grid}`; tool settings; limits (brush 1–200, font 8–400, history cap 100) |
| `lib/studio/drawing-engine.ts` | **Pure core** (Node-testable, no DOM): `clientToCanvas`, `appendPoint` decimation, `hexToRgba`, `floodFillRegion` (scanline, tolerance, operates on raw `Uint8ClampedArray`), `shapeBounds`. **DOM renderers**: `replayElements`, `drawLiveElement` |
| `lib/studio/drawing-serialization.ts` | Never-throws loader: Phase 0 v1 → v2 migration, malformed / unknown-version → empty v2 + warnings, per-element sanitizer (drops corrupt entries, keeps valid ones) |
| `lib/studio/drawing-history.ts` | Command-based undo/redo — records element add/remove only (no bitmap copies); order-preserving redo; 100-entry cap |
| `scripts/test-drawing.mjs` | Compiles `lib/studio` to CJS in a temp dir, runs 33 pure-function checks |

## 3. Files modified

| File | Change |
|---|---|
| `app/studio/[id]/page.tsx` | Rewritten as the full drawing workspace (~700 LOC) |
| `components/Icons.tsx` | + `IconUndo`, `IconRedo`, `IconHand`, `IconZoomIn`, `IconZoomOut`, `IconFit`, `IconGrid` |

**Nothing else touched** — agents, Devin, task runner, chat, auth, project API, schema, guest mode all unchanged.

---

## 4. Architecture

```
pointer events → clientToCanvas (zoom-correct) → element refs
                                              ↓
        offscreen "ink" canvas (project px)  ← replayElements(elements)
                                              ↓
display canvas = background fill + drawImage(ink) + live preview + grid
                                              ↓
        save → serializeDocument → PATCH /api/projects/:id
```

- **Ink canvas** is transparent — the background is painted underneath by the compositor, so the eraser (`destination-out`) can never destroy the page colour.
- **Elements replay deterministically** — undo/redo is just removing/re-inserting an element and replaying; fills replay their flood fill over the composite of preceding elements, which stays correct under undo.
- **Engine state lives in refs** (`docRef`, `inkCtxRef`, `activeRef`, `historyRef`) — pointer moves never trigger React re-renders; only a `tick` bumps for undo/redo button state.

## 5. Feature checklist

| Requirement | Status |
|---|---|
| Brush — colour, size 1–200, opacity 0–100%, smooth strokes, pointer capture, cancel-safe | ✅ |
| Eraser — size 1–200, artwork-only erasing, undoable | ✅ |
| Colour picker — visual + hex input + 8 recent swatches, per-tool colour | ✅ |
| Tool settings panel — contextual per tool, values displayed, live update | ✅ |
| Shapes — rect / ellipse / line, drag preview, stroke width, undoable, zero-size discarded | ✅ |
| Fill — scanline flood fill, colour tolerance, connected-region, undoable, bounded-tested | ✅ |
| Text — click-to-place inline input, Enter/blur commit, Escape cancel, serializable, font size + colour | ✅ |
| Undo/redo — Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y, correct disabled states, all element types | ✅ |
| Zoom — 5–800%, fit-to-screen, % display, exact pointer mapping at any zoom | ✅ |
| Pan — hand tool drag, `grab` cursor | ✅ |
| Grid — optional overlay | ✅ |
| Keyboard shortcuts — B/E/G/S/T/H tool keys, Escape | ✅ |
| Touch — Pointer Events, `touch-none` (no page scroll while drawing) | ✅ |
| High-DPI / zoom fidelity — art is vectors replayed at project resolution; display is CSS-scaled | ✅ |
| Save — explicit Save, dirty tracking, snapshot semantics, no false "Saved", `beforeunload` warn | ✅ |
| Responsive — left rail always available; right panel hidden < md | ✅ |

## 6. Document format (v2)

```json
{
  "version": 2,
  "canvas":  { "width": 1920, "height": 1080, "background": "#ffffff" },
  "elements": [
    { "id": "el_…", "type": "stroke", "tool": "brush", "color": "#000000",
      "size": 5, "opacity": 1, "points": [{"x":…,"y":…}] },
    { "type": "shape", "shape": "rect|ellipse|line", "color": "…", "strokeWidth": 3,
      "from": {"x":…,"y":…}, "to": {"x":…,"y":…} },
    { "type": "fill", "seed": {"x":…,"y":…}, "color": "…", "tolerance": 32 },
    { "type": "text", "position": {"x":…,"y":…}, "text": "…", "color": "…", "fontSize": 24 }
  ],
  "settings": { "grid": false }
}
```

- Stored in the existing `projects.document` JSONB column — **no DB change required**.
- Compact: fills store only `{seed, colour, tolerance}`, strokes store decimated points. No base64 bitmaps in JSONB (per requirement).
- Forward-compatible: `layers[]` (each holding `elements`) and `frames[]` slot in without a v3 migration.
- Phase 0 docs (`version: 1` or missing) → transparent migration to empty v2. Malformed docs → fresh v2 + warnings, never a crash and never silent data loss.

## 7. Save semantics

- Edits mark dirty → "Unsaved changes" (amber).
- Save snapshots `dirtyRef = false` **before** the request — mutations arriving mid-flight re-mark dirty and trigger a follow-up save in `finally` (no overlapping-save corruption, no lost edits).
- "Saved" (teal) shows **only** after a 2xx with the persisted row returned. Errors show red with the server's message; dirty flag is restored on failure.
- `beforeunload` warns when `dirtyRef` is set.

## 8. Test results

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | **PASS** — clean |
| `scripts/test-drawing.mjs` | **33/33 PASS** — coordinate mapping (incl. zoomed rect), point decimation, hex parse, flood fill (full-canvas, wall-bounded, wall-untouched, same-colour no-op, out-of-bounds no-op), shape bounds, v1→v2 migration, null/malformed/unknown-version safety, v2 round-trip (all 4 element types), corrupt-element skipping, id uniqueness, undo/redo order + redo-clearing |
| `scripts/test-projects.mjs` (Phase 0) | **20/20 PASS** — no regression |

> Note: an earlier suite run showed transient `POST /api/projects 404`s — the dev server was mid-recompile; a clean rerun passed 20/20.

## 9. Known issues / limitations

- **Interactive drawing not browser-verified** — pointer UX (stroke feel, text overlay position, pan) should get a manual pass: draw → erase → fill → undo → save → leave → reopen.
- **Fill replay cost** — each fill re-runs flood fill over the composite at replay time. Fine at 1920×1080 for typical element counts; if fills stack heavily, add a cached-fill optimisation.
- **Zoom is CSS scaling** — simple and correct for pointer mapping; pixel-level crispness at very high zoom could be improved later by rendering at zoom×DPR backing store.
- **Right panel hidden below `md`** — left rail + canvas remain fully usable; a collapse toggle can come later.
- **Not implemented (by design)**: layers, frames/timeline, AI tools, autosave, vector/node editing, selection/move.

## 10. Ready for Phase 2

The model is already layer-ready: `elements[]` can become `layers[].elements`, history commands can gain a `layerId` scope, and frames can reference layer stacks. The ink-canvas compositor trivially becomes "composite N layer canvases."
