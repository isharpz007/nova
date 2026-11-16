// Phase 2 animation tests — document model, layer ops, frame ops, playback
// sequencing, onion sources, migration. Pure functions only; no DOM.
// Usage: node scripts/test-animation.mjs

import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = mkdtempSync(join(tmpdir(), "nova-anim-"));
execSync(
  `npx tsc lib/studio/animation-types.ts lib/studio/animation-ops.ts lib/studio/drawing-types.ts lib/studio/drawing-serialization.ts lib/studio/drawing-history.ts lib/studio/drawing-engine.ts --outDir "${out}" --module commonjs --target es2019 --skipLibCheck --esModuleInterop`,
  { cwd: process.cwd(), stdio: "pipe" }
);
const req = createRequire(import.meta.url);
const ops = req(join(out, "studio", "animation-ops.js"));
const ser = req(join(out, "studio", "drawing-serialization.js"));
const { DrawingHistory } = req(join(out, "studio", "drawing-history.js"));

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

const stroke = (id) => ({ id, type: "stroke", tool: "brush", color: "#000", size: 5, opacity: 1, points: [{ x: 0, y: 0 }] });

// ---- document ----
let doc = ops.makeDocument(800, 600, "#ffffff");
check("new doc has 1 frame / 1 layer", doc.frames.length === 1 && doc.frames[0].layers.length === 1);
check("active ids valid", doc.activeFrameId === doc.frames[0].id && doc.activeLayerId === doc.frames[0].layers[0].id);

// ---- layer ops ----
const f0 = ops.activeFrame(doc);
const l2 = ops.addLayer(f0);
check("addLayer appends + names", f0.layers.length === 2 && l2.name === "Layer 2");
check("renameLayer ok", ops.renameLayer(l2, "Ink") === "Layer 2" && l2.name === "Ink");
check("renameLayer empty rejected", ops.renameLayer(l2, "  ") === null && l2.name === "Ink");

ops.moveLayer(f0, l2.id, -1);
check("moveLayer down", f0.layers[0] === l2);
check("moveLayer past bottom blocked", ops.moveLayer(f0, l2.id, -1) === false);
ops.moveLayer(f0, l2.id, 1);
check("moveLayer up restores", f0.layers[1] === l2);

const l1 = f0.layers[0];
const removed = ops.removeLayerAt(f0, ops.layerIndex(f0, l2.id));
check("removeLayerAt removes", removed === l2 && f0.layers.length === 1);
check("removeLayerAt last layer blocked", ops.removeLayerAt(f0, 0) === null);

// visibility / opacity / lock are plain fields (set by commands in the page)
l1.visible = false;
check("layer visibility toggles", l1.visible === false);
l1.opacity = 0.4;
check("layer opacity stores", l1.opacity === 0.4);
l1.locked = true;
check("layer lock stores", l1.locked === true);
l1.visible = true; l1.opacity = 1; l1.locked = false;

// ---- frame ops ----
const f2 = ops.addFrame(doc);
check("addFrame appends + selects", doc.frames.length === 2 && doc.activeFrameId === f2.id);
check("new frame duration follows fps", f2.durationMs === Math.round(1000 / doc.settings.fps));

// drawing independence across frames
ops.activeFrame(doc).layers[0].elements.push(stroke("f2-stroke"));
ops.selectFrame(doc, f0.id);
ops.activeFrame(doc).layers[0].elements.push(stroke("f1-stroke"));
check("frame1 artwork independent", f0.layers[0].elements.length === 1 && f0.layers[0].elements[0].id === "f1-stroke");
check("frame2 artwork independent", f2.layers[0].elements.length === 1 && f2.layers[0].elements[0].id === "f2-stroke");

// duplicate
ops.selectFrame(doc, f0.id);
const dup = ops.duplicateFrame(doc, f0.id);
check("duplicate inserts after source", doc.frames[1] === dup && doc.activeFrameId === dup.id);
check("duplicate fresh ids", dup.id !== f0.id && dup.layers[0].id !== f0.layers[0].id);
dup.layers[0].elements[0].color = "#ff0000";
check("duplicate is deep copy", f0.layers[0].elements[0].color === "#000");

// reorder + delete
ops.moveFrame(doc, dup.id, -1);
check("moveFrame left", doc.frames[0] === dup);
check("moveFrame past edge blocked", ops.moveFrame(doc, dup.id, -1) === false);
ops.removeFrameAt(doc, ops.frameIndex(doc, dup.id));
check("removeFrameAt removes + reselects", doc.frames.length === 2 && doc.activeFrameId === f0.id);
check("removeFrameAt last frame blocked", doc.frames.length > 1 || ops.removeFrameAt(doc, 0) === null);
// build a 1-frame doc for the guard
const single = ops.makeDocument(100, 100, "#fff");
check("single frame delete blocked", ops.removeFrameAt(single, 0) === null);

// duration
const f3 = doc.frames[0];
check("setFrameDuration stores", ops.setFrameDuration(f3, 500) >= 0 && f3.durationMs === 500);
check("setFrameDuration clamps low", (ops.setFrameDuration(f3, 1), f3.durationMs === 10));
f3.durationMs = Math.round(1000 / doc.settings.fps);

// selection repair
doc.activeLayerId = "bogus";
ops.fixSelection(doc);
check("fixSelection repairs layer", doc.frames[doc.frames.findIndex(f => f.id === doc.activeFrameId)].layers.some(l => l.id === doc.activeLayerId));

// ---- playback sequencing ----
const play = ops.makeDocument(100, 100, "#fff");
ops.addFrame(play); ops.addFrame(play); // 3 frames
check("advance 0→1", ops.advanceFrameIndex(play, 0) === 1);
check("advance last stops (no loop)", (play.settings.loop = false, ops.advanceFrameIndex(play, 2) === -1));
check("advance last loops", (play.settings.loop = true, ops.advanceFrameIndex(play, 2) === 0));
const oneFrame = ops.makeDocument(100, 100, "#fff");
check("single frame stops", (oneFrame.settings.loop = false, ops.advanceFrameIndex(oneFrame, 0) === -1));
check("single frame loops", (oneFrame.settings.loop = true, ops.advanceFrameIndex(oneFrame, 0) === 0));
check("advance stale index starts at 0", ops.advanceFrameIndex(play, -1) === 0);

// ---- onion sources ----
ops.selectFrame(play, play.frames[1].id);
let src = ops.onionSources(play);
check("onion has both neighbours", src.prev === play.frames[0].id && src.next === play.frames[2].id);
ops.selectFrame(play, play.frames[0].id);
src = ops.onionSources(play);
check("first frame: only next", src.prev === null && src.next === play.frames[1].id);
ops.selectFrame(play, play.frames[2].id);
src = ops.onionSources(play);
check("last frame: only prev", src.next === null && src.prev === play.frames[1].id);

// ---- serialization round-trip v3 ----
doc.settings.fps = 24;
doc.settings.loop = false;
doc.settings.onion = true;
doc.settings.grid = true;
const stored = ser.serializeDocument(doc);
const r = ser.deserializeDocument(stored, 800, 600, "#ffffff");
check("v3 round-trip frames", r.document.frames.length === 2 && !r.migrated);
check("v3 restores settings", r.document.settings.fps === 24 && r.document.settings.loop === false && r.document.settings.onion === true && r.document.settings.grid === true);
check("v3 restores active ids", r.document.activeFrameId === doc.activeFrameId && r.document.activeLayerId === doc.activeLayerId);
check("v3 restores layer props", JSON.stringify(r.document.frames[0].layers.map(l => [l.visible, l.opacity, l.locked])) !== "");
check("v3 restores frame duration", r.document.frames[0].durationMs === doc.frames[0].durationMs);
check("v3 restores artwork", r.document.frames[0].layers[0].elements.length === 1);

// malformed v3
const bad = ser.deserializeDocument({ version: 3, frames: "nope", canvas: null, settings: null }, 800, 600, "#fff");
check("malformed v3 → safe default", bad.document.frames.length === 1 && bad.document.frames[0].layers.length === 1);

// ---- structural history through DrawingHistory ----
const hist = new DrawingHistory();
const hdoc = ops.makeDocument(100, 100, "#fff");
const hf = ops.activeFrame(hdoc);
const hl = ops.addLayer(hf);
const idx = hf.layers.length - 1;
hist.push({ redo: () => {}, undo: () => { hf.layers.splice(idx, 1); } });
check("structural undo removes layer", hist.undo() && hf.layers.length === 1);
// drawing add on the same stack
const el = stroke("mix1");
hf.layers[0].elements.push(el);
hist.recordAdd(hf.layers[0].elements, el);
check("mixed history: element undo", hist.undo() && hf.layers[0].elements.length === 0);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
