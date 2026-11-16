// Phase 1 drawing-engine unit tests.
// Compiles lib/studio to a temp dir (CommonJS) then exercises the pure core:
// coordinate math, point decimation, flood fill, serialization/migration,
// and undo/redo — no DOM needed.
// Usage: node scripts/test-drawing.mjs

import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = mkdtempSync(join(tmpdir(), "nova-draw-"));
execSync(
  `npx tsc lib/studio/drawing-types.ts lib/studio/drawing-serialization.ts lib/studio/drawing-history.ts lib/studio/drawing-engine.ts --outDir "${out}" --module commonjs --target es2019 --skipLibCheck --esModuleInterop`,
  { cwd: process.cwd(), stdio: "pipe" }
);
const req = createRequire(import.meta.url);
const types = req(join(out, "studio", "drawing-types.js"));
const ser = req(join(out, "studio", "drawing-serialization.js"));
const { DrawingHistory } = req(join(out, "studio", "drawing-history.js"));
const eng = req(join(out, "studio", "drawing-engine.js"));

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

// ---- coordinate mapping ----
let p = eng.clientToCanvas(100, 50, { left: 10, top: 20, width: 200, height: 100 }, 400, 200);
check("clientToCanvas maps centre→centre", p.x === 180 && p.y === 60);
p = eng.clientToCanvas(10, 20, { left: 10, top: 20, width: 200, height: 100 }, 400, 200);
check("clientToCanvas maps corner→origin", p.x === 0 && p.y === 0);
p = eng.clientToCanvas(210, 120, { left: 10, top: 20, width: 200, height: 100 }, 800, 400);
check("zoomed rect maps to canvas edge", p.x === 800 && p.y === 400);

// ---- point decimation ----
const pts = [];
eng.appendPoint(pts, 0, 0);
check("first point appended", pts.length === 1);
eng.appendPoint(pts, 0.1, 0.1); // below minDist — dropped
check("sub-threshold point dropped", pts.length === 1);
eng.appendPoint(pts, 2, 2);
check("distant point appended", pts.length === 2);

// ---- hexToRgba ----
check("hexToRgba #ff0000", JSON.stringify(eng.hexToRgba("#ff0000")) === "[255,0,0,255]");
check("hexToRgba short #f0f", JSON.stringify(eng.hexToRgba("#f0f")) === "[255,0,255,255]");

// ---- flood fill ----
const W = 8, H = 8;
const mkBuf = () => new Uint8ClampedArray(W * H * 4); // all transparent
let buf = mkBuf();
let filled = eng.floodFillRegion(buf, W, H, 3, 3, [255, 0, 0, 255], 32);
check("flood fill empty canvas fills all", filled === 64, `${filled}px`);
check("filled pixel colour", buf[(3 * W + 3) * 4] === 255 && buf[(3 * W + 3) * 4 + 3] === 255);

// bounded region: draw a vertical wall at x=3 (opaque black)
buf = mkBuf();
for (let y = 0; y < H; y++) {
  const i = (y * W + 3) * 4;
  buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 255;
}
filled = eng.floodFillRegion(buf, W, H, 0, 0, [0, 255, 0, 255], 32);
check("fill bounded by wall fills one side", filled === 24, `${filled}px`); // 3 cols × 8
check("wall untouched by fill", buf[(0 * W + 3) * 4 + 3] === 255 && buf[(0 * W + 3) * 4] === 0);

// same-colour seed → no-op
filled = eng.floodFillRegion(buf, W, H, 0, 0, [0, 255, 0, 255], 32);
check("fill same colour is no-op", filled === 0);

// out-of-bounds seed → no-op
filled = eng.floodFillRegion(buf, W, H, -1, 0, [1, 2, 3, 255], 32);
check("out-of-bounds seed is no-op", filled === 0);

// ---- shape bounds ----
const b = eng.shapeBounds({ from: { x: 50, y: 80 }, to: { x: 10, y: 20 } });
check("shapeBounds normalises", b.x === 10 && b.y === 20 && b.w === 40 && b.h === 60);

// ---- serialization: Phase 0 v1 → v3 ----
let r = ser.deserializeDocument({ version: 1, layers: [], frames: [] }, 800, 600, "#aabbcc");
check("v1 migrates to v3 empty doc", r.document.version === 3 && r.document.frames[0].layers[0].elements.length === 0);
check("v1 migration keeps canvas", r.document.canvas.width === 800 && r.document.canvas.background === "#aabbcc");
check("v1 flagged migrated", r.migrated === true);

r = ser.deserializeDocument(null, 800, 600, "#fff");
check("null doc → empty v3", r.document.version === 3 && r.document.frames.length === 1);
r = ser.deserializeDocument({ version: 99 }, 800, 600, "#fff");
check("unknown version → fresh + warning", r.document.frames[0].layers[0].elements.length === 0 && r.warnings.length > 0);
r = ser.deserializeDocument("garbage", 800, 600, "#fff");
check("malformed doc → fresh, no throw", r.document.version === 3 && r.warnings.length > 0);

// v2 → v3: elements land in Frame 1 / Layer 1
const v2els = [
  { id: "a1", type: "stroke", tool: "brush", color: "#000000", size: 5, opacity: 1, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
  { id: "a2", type: "shape", shape: "ellipse", color: "#ff0000", strokeWidth: 3, from: { x: 0, y: 0 }, to: { x: 50, y: 30 } },
  { id: "a3", type: "fill", seed: { x: 5, y: 5 }, color: "#00ff00", tolerance: 32 },
  { id: "a4", type: "text", position: { x: 10, y: 10 }, text: "hello", color: "#0000ff", fontSize: 20 },
];
r = ser.deserializeDocument({ version: 2, canvas: { width: 640, height: 480, background: "#112233" }, elements: v2els, settings: { grid: true } }, 640, 480, "#112233");
const m = r.document;
check("v2 → v3 migrates", r.migrated === true && m.version === 3);
check("v2 elements → Frame 1 Layer 1", m.frames[0].layers[0].elements.length === 4);
check("text element restores", m.frames[0].layers[0].elements[3].text === "hello");
check("fill element restores", m.frames[0].layers[0].elements[2].seed.x === 5);
check("v2 grid setting kept", m.settings.grid === true);

// corrupt elements get dropped, valid ones kept
r = ser.deserializeDocument(
  { version: 2, canvas: {}, elements: [{ type: "stroke", points: [] }, { type: "nonsense" }, v2els[0]], settings: {} },
  640, 480, "#fff"
);
check("corrupt elements skipped with warning", r.document.frames[0].layers[0].elements.length === 1 && r.warnings.length > 0);

// element id uniqueness
check("nextElementId unique", ser.nextElementId() !== ser.nextElementId());

// ---- history (generic command stack) ----
const hist = new DrawingHistory();
const els = [];
check("canUndo false initially", !hist.canUndo);
const e1 = { id: "h1", type: "fill", seed: { x: 0, y: 0 }, color: "#000", tolerance: 32 };
els.push(e1);
hist.recordAdd(els, e1);
check("canUndo after add", hist.canUndo && !hist.canRedo);
check("undo removes element", hist.undo() === true && els.length === 0 && hist.canRedo);
check("redo restores element", hist.redo() === true && els[0] === e1);
check("undo again empties", hist.undo() && els.length === 0);

// redo cleared by new add
const e2 = { id: "h2", type: "fill", seed: { x: 1, y: 1 }, color: "#000", tolerance: 32 };
els.push(e2);
hist.recordAdd(els, e2);
check("new add clears redo", !hist.canRedo);

// order preserved on redo after interleaved undo
const hist2 = new DrawingHistory();
const els2 = [{ id: "x" }, { id: "y" }, { id: "z" }].map((e) => ({ ...e, type: "fill", seed: { x: 0, y: 0 }, color: "#000", tolerance: 0 }));
els2.forEach((e) => hist2.recordAdd(els2, e));
hist2.undo();
hist2.redo();
check("redo restores original order", els2.map((e) => e.id).join(",") === "x,y,z");

// RLE mask round-trip
const mask = new Uint8Array([0,0,1,1,1,0,0,1]);
const rle = eng.encodeMaskRle(mask);
const back = eng.decodeMaskRle(rle, 8);
check("mask RLE round-trip", JSON.stringify([...back]) === JSON.stringify([...mask]));

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
