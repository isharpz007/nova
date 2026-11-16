# NOVA Phase 2 — Layers & Animation Timeline Implementation Report

**Date:** 2026-11-16
**Status:** Complete. 46/46 animation checks + 36/36 drawing checks + 20/20 Phase 0 regression + clean typecheck.

---

## 1. Summary

The studio evolved from a single-canvas drawing surface into a structured 2D animation workspace: **frames → layers → elements**, with a real timeline, onion skinning, playback, and a unified undo system — all stored in the existing `projects.document` JSONB column (no DB changes) and fully backward-compatible with Phase 0/1 documents.

## 2. Files created

| File | Purpose |
|---|---|
| `lib/studio/animation-types.ts` | v3 model: `AnimationDocument`, `AnimationFrame`, `AnimationLayer`; `settings {grid, fps, loop, onion}`; duration/fps constants |
| `lib/studio/animation-ops.ts` | All pure document ops — layer CRUD/reorder/guards, frame add/duplicate/delete/reorder/duration, selection + repair, `advanceFrameIndex` (playback sequencing), `onionSources` |
| `scripts/test-animation.mjs` | 46 checks covering document, layers, frames, playback sequencing, onion sources, v3 round-trip, mixed history |

## 3. Files modified

| File | Change |
|---|---|
| `app/studio/[id]/page.tsx` | Rewritten for the animation model (~1,000 LOC): layers panel, timeline with thumbnails, playback, onion skin, composite-aware fill |
| `lib/studio/drawing-types.ts` | `FillElement.mask?: number[]` — baked fill mask |
| `lib/studio/drawing-serialization.ts` | Now produces v3; migrates v1/v2; per-frame/layer sanitizers |
| `lib/studio/drawing-history.ts` | Rewritten as a **generic command stack** — drawing commits and structural changes share one undo timeline |
| `lib/studio/drawing-engine.ts` | + `renderLayerCanvas`, `compositeFrame`, `tintCanvas`, `floodFillMask`, `encodeMaskRle`, `decodeMaskRle`, `applyMask` |
| `components/Icons.tsx` | + eye, eye-off, lock, unlock, play, pause, stop, prev, next, copy, chevrons (4), onion |
| `scripts/test-drawing.mjs` | Updated for v3 model + new history API (36 checks) |

**Untouched:** agents, Devin, task runner, chat, auth, project API, schema, guest mode, dashboard.

## 4. Animation document architecture (v3)

```json
{
  "version": 3,
  "canvas": { "width": 1920, "height": 1080, "background": "#fff" },
  "settings": { "grid": false, "fps": 12, "loop": true, "onion": false },
  "frames": [{
    "id": "el_…", "name": "Frame 1", "durationMs": 83,
    "layers": [{
      "id": "el_…", "name": "Layer 1", "visible": true,
      "opacity": 1, "locked": false, "elements": [/* Phase 1 element types */]
    }]
  }],
  "activeFrameId": "…", "activeLayerId": "…"
}
```

- Element types are unchanged — v2 elements nest directly into layers.
- IDs are stable across reorder; array indexes are never used as identifiers.
- `settings.fps` = default duration for **new** frames; `frame.durationMs` is authoritative during playback.

## 5. Layer system

Panel (right, replaces Phase 1 placeholder): add / rename (double-click inline, empty rejected) / delete (confirm, last-layer guarded, reselects) / move up-down / visibility eye / lock / per-row opacity % input. Drawing tools write only to the active layer; locked layers reject all modification; hidden layers don't render but persist. Layer bitmaps live in a per-layer canvas cache (`layerCanvases`) rebuilt on refresh/frame-switch — pointer moves never replay elements.

## 6. Frame & timeline

Timeline (bottom, replaces placeholder): real **canvas thumbnails** (`compositeFrame` scaled into `FrameThumb`), frame number + duration, selected ring, add / duplicate / delete / move-left-right, prev/next navigation, duration input (ms, clamped 10–60,000), play/pause/stop, loop toggle. Duplicates get fresh ids + deep-copied elements (verified independent). Last-frame deletion guarded; selection auto-repairs.

## 7. Onion skinning

Toolbar toggle (persisted in `settings.onion`). Previous frame composited → tinted `#ff6b6b` at 40% **under** the artwork; next frame → tinted `#4dabf7` at 30% **over** it. Tinted composites cached per-frame and invalidated on that frame's mutations. Never editable, never serialized, never in exports — pure display overlays. Boundary frames degrade gracefully (no prev/next → no overlay).

## 8. Playback

`setTimeout` chain honouring each frame's `durationMs`; sequencing via pure `advanceFrameIndex` (loop-aware, single-frame safe, stale-index safe). **Play** resumes from paused frame or starts at active frame; **Pause** freezes on the current frame (drawing stays blocked — the canvas still shows the playback frame); **Stop** returns to the active frame. Space toggles. Timer cleared on unmount. Only one timer can exist (`playTimerRef` guard).

## 9. Fill against the composite (design note)

Spec asked for fills computed against the visible composite but stored on the editable layer. Implemented by **baking the mask at commit**: compute `floodFillMask` on the frame's visible composite (background substituted for transparent pixels so filling "empty" space works), apply the mask to the active layer only, and store it RLE-encoded on the element. Replay applies the stored mask — deterministic even if other layers change later, compact (RLE of flat regions), no base64 bitmaps in JSONB. Elements without a mask (older fills) fall back to layer-local flood fill.

## 10. Undo/redo

One command stack for everything: element commits (`recordAdd`) plus structural commands (add/delete/rename/move layers, visibility/opacity/lock, add/duplicate/delete/move frames, duration, loop). Delete commands capture the removed object so **redo re-inserts the identical frame/layer** (ids preserved). 100-entry cap. After any history op: `fixSelection` → rebuild active-frame layer canvases → repaint.

## 11. Persistence & migration

- Same explicit Save; `document = serializeDocument(doc)` → existing `PATCH /api/projects/:id`. No schema change.
- **v2 → v3**: all elements → Frame 1/Layer 1; canvas dims/background/grid preserved; flagged `migrated`.
- **v1 / unversioned** → empty v3. **Malformed** → empty v3 + warnings, never throws.
- Dirty/save semantics unchanged from Phase 1 (snapshot-dirty, mid-flight re-save, no false "Saved", `beforeunload` guard).

## 12. Test results

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | **clean** |
| `scripts/test-animation.mjs` | **46/46** — doc creation, layer CRUD/reorder/guards, frame add/dup (deep-copy independence)/delete/reorder/duration/clamps, cross-frame artwork independence, selection repair, playback sequencing (order/loop/stop/single-frame/stale), onion sources at boundaries, v3 round-trip (settings/active ids/layer props/duration/artwork), malformed v3, mixed structural+drawing history |
| `scripts/test-drawing.mjs` | **36/36** — updated for v3: v1→v3, v2→v3 (elements → Frame1/Layer1, grid kept), corrupt elements, new history API, mask RLE round-trip |
| `scripts/test-projects.mjs` | **20/20** — Phase 0 regression clean |

## 13. Browser acceptance

**Not yet performed** — automated suites all pass and the page compiles (307 redirect for unauthenticated, as expected), but rendered output needs a manual pass: thumbnails, onion tint visibility, playback smoothness, layer-panel ergonomics, touch drawing on the new layout.

## 14. Known limitations

- Layer canvases + frame composites are per-frame caches — memory scales with canvas size, not frame count (rebuilt per active frame; composites cached lazily).
- `compositeFrame` replays all elements incl. fills for thumbnails/onion — fine at 1080p for typical docs; heavy fill counts may need caching.
- Right panel hidden below `md` (layers unavailable on phones — acceptable tablet+ target).
- No drag-and-drop reorder (move buttons instead), no layer merge/duplicate-layer, no frame copy-paste across projects.
- Pause keeps the frozen frame visible; Stop returns to the editing frame — deliberate semantics.

## 15. Recommended next phase

**Phase 3 — AI image generation & editing**, as audited: an `image` provider kind in `llm.ts`, `POST /api/generate` + `/api/edit` (inpaint/extend), and "generate → new layer/asset" flows. Blocker: all model providers are currently out of quota — top up first.
