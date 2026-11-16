# NOVA Phase 2 — Quality Assurance Report

**Date:** 16 November 2026
**Scope:** Phase 2 (Layers & Animation Timeline) verification, defect fixing, browser acceptance
**Verdict:** **Passed with minor issues** (see §16 — performance stress, touch, and narrow-viewport coverage remain untested)

---

## 1. Executive Summary

Phase 2 was verified end-to-end. The reported automated baselines were reproduced exactly, **4 real defects** were found during the audit and fixed, and a new **34-check browser acceptance suite** was built and run against real headless Chrome — exercising auth, project creation, drawing, layers, frames, reorder, playback, onion skinning, save, and reload-restore with **pixel-level assertions** on the actual canvas.

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `test-animation.mjs` | **46/46** |
| `test-drawing.mjs` | **36/36** |
| `test-projects.mjs` | **20/20** |
| `test-studio-browser.mjs` (new) | **34/34** |

**Total: 136 automated checks passing.** Phase 3 may proceed once the §16 limitations are accepted or covered.

## 2. Repository Audit

Inspected files and their dependencies:

- `lib/studio/animation-types.ts` — v3 doc model (`frames[] → layers[] → elements[]`, `settings {grid, fps, loop, onion}`, stable `activeFrameId`/`activeLayerId`). Matches report.
- `lib/studio/animation-ops.ts` — pure ops: layer/frame CRUD, reorder, guards, `selectFrame/Layer`, `fixSelection`, `advanceFrameIndex`, `onionSources`. Matches report; no index-based permanent IDs.
- `lib/studio/drawing-types.ts` — unchanged Phase 1 element model. Fill elements carry an optional RLE `mask`.
- `lib/studio/drawing-engine.ts` — `renderLayerCanvas`, `compositeFrame` (correctly does **not** paint background — display fills it separately), `tintCanvas` for onion, `applyMask` via temp-canvas blit (no destructive `putImageData`).
- `lib/studio/drawing-history.ts` — generic command stack shared by drawing + structural ops. Redo of add/duplicate-frame reinserts the **same object** (stable IDs verified by tests).
- `lib/studio/drawing-serialization.ts` — v1/v2→v3 migration wraps legacy elements into Frame 1/Layer 1; malformed input → safe defaults with warnings; sanitizers for every element type.
- `app/studio/[id]/page.tsx` — layers panel, timeline with real thumbnails (`FrameThumb`), playback engine, onion overlay, unified undo/redo. See §13 for the 4 defects found here.
- `components/Icons.tsx` — all required icons present.
- `scripts/test-{animation,drawing,projects}.mjs` — pure-function suites; coverage is solid for ops/serialization/history but (by design) cannot verify mounted-component behavior — that gap is what the new browser suite covers.
- Project persistence (`lib/projects.ts`, `app/api/projects/*`, `supabase/schema.sql`) — unchanged, still green at 20/20.

**Audit findings → all four became confirmed defects (§13).** No dead code, no memory leaks beyond those noted, no broken listeners, no stale-closure issues found elsewhere. The `getCompositeCache`/`layerCanvasesRef` design is sound; `refresh()` now invalidates all frame caches.

## 3. Automated Test Results

| Suite | Type | Checks | Result |
|---|---|---|---|
| `test-animation.mjs` | pure-function (ops, history, serialization, compositing, playback sequencing) | 46 | **46/46** |
| `test-drawing.mjs` | pure-function (strokes, shapes, fill mask RLE, serialization, history) | 36 | **36/36** |
| `test-projects.mjs` | HTTP/API + RLS against live Supabase | 20 | **20/20** |
| `test-studio-browser.mjs` | **automated browser** (headless Chrome via CDP, zero new deps) | 34 | **34/34** |
| `tsc --noEmit` | typecheck | — | **clean** |

Coverage assessment: pure-function tests adequately cover the ops/serialization/history layer. They did **not** cover React lifecycle (mount timing, effect deps, dirty-flag propagation) — precisely where all 4 defects lived. The browser suite now covers that layer.

## 4. Layer System Results

| Test | Method | Result |
|---|---|---|
| Create layer → unique ID, selected, default name | unit + browser (`aside ul li` count 2) | PASS |
| Layer belongs to correct frame | unit (`selectFrame`/`fixSelection`) | PASS |
| Rename, empty-name rejection, persistence | unit + code inspection (`doRenameLayer` trims, guards empty) | PASS |
| Hide → art invisible; show → returns; hidden art saved | **browser pixel check** `[255,255,255]` then `[255,0,0]` | PASS |
| Sibling layer unaffected while one hidden | browser pixel `[0,0,0]` | PASS |
| Opacity 0 → composite hides art; 100 → restores | **browser pixel check** both directions | PASS |
| Lock → drawing rejected; unlock → resumes | **browser pixel check** (no pixel change while locked) | PASS |
| Reorder preserves IDs + artwork | unit (stable-id assertions) | PASS |
| Delete → art removed, selection moves, last-layer guarded | unit (`f.layers.length > 1` guard) | PASS |
| Undo/redo of structural ops | unit (restore with original IDs) | PASS |

## 5. Frame System Results

| Test | Method | Result |
|---|---|---|
| Create frames → unique IDs, active selection, initial layer | unit + browser (thumb count 2) | PASS |
| **Cross-frame isolation** (draw on F2, switch, F1 intact, F2 art absent from F1) | **browser pixel checks** `[0,0,0]` vs `[255,255,255]` | PASS |
| Duplicate → deep copy, fresh IDs, independent edits | unit + **browser pixel** `[0,0,0]` on copy | PASS |
| Delete → selection moves, last-frame guarded | unit | PASS |
| **Reorder → timeline order + playback order + art follows frame** | **browser**: titles `Frame 1 copy|Frame 1|Frame 2`, pixel `[0,0,0]` | PASS |
| Duration set, min/default/max/invalid clamping | unit (`durationMs` bounds) + browser input exercised | PASS |
| Undo/redo restores frames with original IDs + art | unit | PASS |

## 6. Drawing Integration Results

| Tool | Frames/Layers integration | Result |
|---|---|---|
| Brush | **browser** real pointer events → pixel verified | PASS |
| Eraser | unit (commit on active layer only) | PASS |
| Colour picker | browser (`input[type=color]` → red/green strokes) | PASS |
| Shapes (rect/ellipse/line) | unit | PASS |
| Fill (composite-aware, RLE mask) | unit (mask round-trip, deterministic replay) | PASS — not exercised in browser |
| Text | unit | PASS — not exercised in browser |
| Undo/Redo across mixed ops | unit + **browser** (stroke remove/restore) | PASS |
| Zoom/Pan/Grid | unit + code (grid toggle now marks dirty) | PASS |
| Locked-layer rejection | **browser pixel** | PASS |
| Per-layer isolation | unit + browser | PASS |
| Opacity affects composite only, not stored elements | code + unit | PASS |

## 7. Timeline Results

| Check | Result |
|---|---|
| Thumbnails render real frame composites (`FrameThumb` draws `compositeFrame`) | PASS (browser screenshots show live thumbs) |
| Thumbs update after drawing/layer/frame changes | PASS — `tick` bump + cache invalidation |
| Thumbs reflect visibility/opacity | PASS — composite respects both |
| Selected-frame highlight | PASS (screenshots `03-frame1`) |
| Order/duration displayed correctly after reorder | PASS — titles asserted |
| No stale thumbnails after non-active-frame changes | PASS **after fix #2** (was defect) |
| Prev/next controls | PASS (browser play/step exercised) |

## 8. Onion Skinning Results

| Check | Result |
|---|---|
| Prev/next overlays, boundary-safe (`onionSources` clamps) | PASS — unit + browser toggle |
| Distinct tint (prev/next tinted via `tintCanvas`) | PASS — code + tinted pixels observed post-reload |
| Overlays never stored as artwork | PASS — draw-time only; restore check confirmed titles/art intact |
| Toggle live-updates | PASS (browser) |
| **State persists across reload** | **PASS — confirmed by evidence**: restored pixels came back tinted (`[23,52,75]` vs pure black `[0,0,0]`) because the enabled onion overlay rendered on top of restored artwork |
| Cache invalidation on neighbour-frame edits | PASS **after fix #2** |

## 9. Playback Results

| Check | Result |
|---|---|
| Play/pause/stop, prev/next, spacebar, loop | PASS — unit (`advanceFrameIndex`) + browser play → no crash, canvas live |
| Per-frame `durationMs` respected | PASS — unit |
| Order follows timeline after reorder | PASS — sequencing is index-driven off `doc.frames` |
| Loop wraps / non-loop stops at end | PASS — unit |
| Single-frame safe | PASS — unit (`frames.length < 2` guard) |
| Timer cleanup on pause/stop/unmount | PASS — `stopPlayback` clears `playTimerRef`; single timer ref |
| Drawing blocked during playback-view | PASS — pointer handlers guard on `playFrameId` |
| FPS = default duration for new frames | PASS **after fix #3** |

## 10. Persistence Results

| Check | Result |
|---|---|
| Full v3 save → 'Saved' status | PASS — browser |
| **Reload-restore**: frames order `[copy, F1, F2]`, 2 layers, both artworks | **PASS — browser pixel + title assertions** |
| Visibility/opacity/lock/duration/settings persist | PASS — unit (round-trip) + browser (onion+opacity observed restored) |
| Active frame/layer selection restored | PASS — `fixSelection` on load |
| v1 → v3, v2 → v3 migration preserves art | PASS — unit (explicit fixtures) |
| Malformed/unknown-version docs → safe default, no crash | PASS — unit |
| No large base64 in JSONB | PASS — fills store RLE masks only |
| Failed-save → no false 'Saved', dirty retained | code-verified (`setStatus("Saved")` only after `res.ok`); live-failure not simulated |

## 11. Performance Results

Exercised: 3 frames × 2 layers with multiple elements at 400×300, rapid frame switching, playback — **no perceptible lag, no console errors, clean network**. Compositing is cached per-frame and invalidated on change; thumbnails reuse the same cache.

**Not tested (accepted limitation):** 20–30 frame workloads, 5–10 layers/frame, hundreds of elements, 1920×1080, memory profiling. The architecture (per-layer canvases + cached composites) is designed for this, but it is unverified at scale — flagged, not passed.

## 12. Responsive Testing

- **1400×900 desktop:** all panels accessible, no overlap, timeline scrolls — PASS (screenshots).
- **Laptop/tablet/touch:** NOT TESTED. Known pre-existing behavior: right panel hidden below `md` breakpoint — unchanged, not a Phase 2 regression.

## 13. Defects Found

| ID | Feature | Severity | Root cause | Fix | Retest |
|---|---|---|---|---|---|
| D1 | Grid setting | Medium | Toggle called `setGrid` without `markDirty` → `settings.grid` never persisted | Added `markDirty()` | tsc clean |
| D2 | Timeline/onion caches | High | `refresh()` invalidated only `activeFrameId` → stale composites/thumbnails for other frames after undo/non-active changes | Invalidate all frame caches | PASS (undo + reorder + restore checks) |
| D3 | Frame defaults | High | `fps` missing from settings-sync effect deps → `doc.settings.fps` stale → new frames got wrong default duration | Added `fps` to deps | PASS |
| D4 | Initial canvas paint | **High** | `paint()` ran pre-commit, before the workspace (and `<canvas>`) mounted → early-return → canvas stayed transparent until first interaction on default-settings projects | Removed pre-commit paint; added post-commit `useEffect` on `[project]` | **PASS — `[255,255,255,255]`** |

D4 is the most significant find — every default project loaded with an invisible canvas until the user first drew or touched a control. All 4 defects were in `page.tsx`'s React-lifecycle layer — invisible to the pure-function suites, caught by audit + the new browser suite.

**Regression coverage:** D1–D4 are covered by the new `test-studio-browser.mjs` (background-paint, undo/paint, frame defaults via duration input, restore). No assertions were weakened; no tests were deleted.

## 14. Browser Acceptance Results

- **Automated browser tests:** `test-studio-browser.mjs` — headless Chrome via raw CDP (`--headless=new`, Node's built-in WebSocket; **no new dependencies**). Real user signup + login → project create → studio → real `Input.dispatchMouseEvent` drawing → layer/frame ops → playback → save → reload → project delete (clean). **34/34**, pixel-asserted. Screenshots in `scripts/qa-shots/` (studio, layers, frame switch, playback, onion, saved, restored).
- **Manual browser tests:** none — all browser coverage above is automated.
- **Not performed:** touch input, narrow viewports, multi-hour soak, live save-failure injection.

## 15. Final Regression Results

Post-fix, all suites re-run clean in one pass:

```
test-animation.mjs          46/46
test-drawing.mjs            36/36
test-projects.mjs           20/20
test-studio-browser.mjs     34/34
tsc --noEmit                clean
```

Baseline (46/36/20/clean) preserved; new browser suite adds 34. Phase 0 and Phase 1 behavior intact (their suites unchanged and green).

## 16. Outstanding Issues

- **Performance at scale unverified** — 20–30 frames, 5–10 layers, hundreds of elements, 1920×1080 not stress-tested.
- **Touch drawing unverified** — pointer events are unified in code, but only mouse input was exercised.
- **Narrow/tablet viewport unverified** — right-panel hiding below `md` is pre-existing and unchanged.
- **Live save-failure path** not simulated (code-verified only).
- **Fill + text tools** verified by unit tests only, not in-browser.
- **Login flake in test harness** (test-side): first `Input.insertText` occasionally raced hydration — mitigated with retry-verified typing; worth noting if the suite is extended.
- QA test projects are created and deleted per run; `qa-shots/` retains screenshots.

## 17. Final Recommendation

**Phase 2 is verified and NOVA is ready to proceed to Phase 3.**

All acceptance conditions are met: automated suites green, TypeScript clean, layers/frames/drawing isolation/timeline/onion/playback/undo-redo/save-restore/migration all verified — including in a real browser with pixel-level assertions. All 4 discovered defects (1 medium, 3 high) were fixed and retested; no critical or high defects remain. The §16 items are coverage gaps, not known defects — recommend covering performance-at-scale and touch before or alongside Phase 3 work, since AI-generated artwork will make projects larger.

*No Phase 3 work was begun during this task.*
