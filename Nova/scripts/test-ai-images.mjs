// Phase 3 tests — AI image provider layer + image element model.
// Compiles lib/studio + lib/ai-images to a temp dir (CommonJS) then exercises:
//   • mock provider (deterministic real PNGs — no paid calls)
//   • provider registry resolution + error mapping
//   • ImageElement sanitization/migration safety
//   • image-ops (hit test, handles, resize/move/placement)
//   • history undo/redo for insert/move/resize/delete/replace
// Usage: node scripts/test-ai-images.mjs

import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// load .env.local so provider-credential checks behave like the app
for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const out = mkdtempSync(join(tmpdir(), "nova-ai-"));
execSync(
  `npx tsc lib/studio/drawing-types.ts lib/studio/drawing-serialization.ts lib/studio/drawing-history.ts lib/studio/drawing-engine.ts lib/studio/animation-types.ts lib/studio/animation-ops.ts lib/studio/image-assets.ts lib/studio/image-ops.ts lib/ai-images/types.ts lib/ai-images/openai.ts lib/ai-images/gemini.ts lib/ai-images/mock.ts lib/ai-images/index.ts --outDir "${out}" --module commonjs --target es2020 --skipLibCheck --esModuleInterop`,
  { cwd: process.cwd(), stdio: "pipe" }
);
const req = createRequire(import.meta.url);
const ser = req(join(out, "studio", "drawing-serialization.js"));
const { DrawingHistory } = req(join(out, "studio", "drawing-history.js"));
const { makeDocument, makeLayer, addLayer } = req(join(out, "studio", "animation-ops.js"));
const ops = req(join(out, "studio", "image-ops.js"));
const ai = req(join(out, "ai-images", "index.js"));
const { mockProvider, encodePng, mockImage } = req(join(out, "ai-images", "mock.js"));
const { upstreamError } = req(join(out, "ai-images", "types.js"));

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

// ---------- mock provider: real deterministic PNGs ----------
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const imgs = await mockProvider.generate({ prompt: "a red fox", size: "1024x1024", count: 2 });
check("mock generate returns requested count", imgs.length === 2);
const raw = Buffer.from(imgs[0].b64, "base64");
check("mock image is real PNG", PNG_MAGIC.every((b, i) => raw[i] === b), raw.slice(0, 4).toString("hex"));
check("mock mediaType png", imgs[0].mediaType === "image/png");
const raw2 = Buffer.from(imgs[1].b64, "base64");
check("variations differ", !raw.equals(raw2));
const again = Buffer.from((await mockProvider.generate({ prompt: "a red fox", size: "1024x1024", count: 1 }))[0].b64, "base64");
check("same prompt → deterministic image", raw.equals(again));
// IHDR width check — mock 1024x1024 → 256px
check("mock PNG has expected width", raw.readUInt32BE(16) === 256, String(raw.readUInt32BE(16)));
const edited = await mockProvider.edit({ prompt: "bluer", image: { b64: imgs[0].b64, mediaType: "image/png" } });
check("mock edit returns image", edited.length === 1 && edited[0].b64.length > 50);
check("encodePng produces valid signature", PNG_MAGIC.every((b, i) => encodePng(4, 4, new Uint8Array(64))[i] === b));

// ---------- provider registry ----------
check("registry: explicit mock resolves", ai.getImageProvider("mock")?.capabilities().id === "mock");
check("registry: unknown id → null", ai.getImageProvider("nope") === null);
check("registry: openai configured", ai.getImageProvider("openai")?.capabilities().id === "openai");
check("registry: gemini configured", ai.getImageProvider("gemini")?.capabilities().id === "gemini");
check("registry: auto picks a real provider", ["openai", "gemini"].includes(ai.getImageProvider()?.capabilities().id));
check("listImageProviders only lists configured", ai.listImageProviders().every((c) => ["openai", "gemini", "mock"].includes(c.id)));
const caps = ai.getImageProvider("openai").capabilities();
check("openai caps: gen+edit+4 sizes", caps.generate && caps.edit && caps.sizes.length === 4 && caps.maxCount === 4);

// ---------- upstreamError mapping ----------
check("401→auth", upstreamError("X", 401, "bad key").code === "provider_auth");
check("429→quota", upstreamError("X", 429, "slow down").code === "provider_quota");
check("500→unavailable", upstreamError("X", 503, "oops").code === "provider_unavailable");
const leaked = upstreamError("X", 400, "key=sk-secret123 invalid");
check("error message redacts keys", !leaked.message.includes("sk-secret123"), leaked.message);
check("ProviderError is an Error", upstreamError("X", 500, "") instanceof Error);

// ---------- ImageElement sanitization ----------
const doc = makeDocument(400, 300, "#ffffff", 12);
const imgEl = {
  id: "img1",
  type: "image",
  assetPath: "u/p/img_1.png",
  x: 10, y: 20, w: 100, h: 50, srcW: 256, srcH: 128, rotation: 0, opacity: 0.8,
};
doc.frames[0].layers[0].elements.push(imgEl);
const round = ser.deserializeDocument(ser.serializeDocument(doc), 400, 300, "#ffffff");
const restored = round.document.frames[0].layers[0].elements[0];
check("image element survives serialize→deserialize", restored?.type === "image" && restored.assetPath === imgEl.assetPath);
check("image element fields round-trip", restored.w === 100 && restored.h === 50 && restored.srcW === 256 && restored.opacity === 0.8);

// sanitize: malformed image elements dropped, rest preserved
const bad = JSON.parse(JSON.stringify(ser.serializeDocument(doc)));
bad.frames[0].layers[0].elements.push({ type: "image", assetPath: "", w: 10, h: 10, srcW: 5, srcH: 5 }); // no path
bad.frames[0].layers[0].elements.push({ type: "image", assetPath: "u/p/a.png", w: 0, h: 10, srcW: 5, srcH: 5 }); // zero w
bad.frames[0].layers[0].elements.push({ type: "image", assetPath: "u/p/a.png", w: 10, h: 10 }); // no src dims
const badRound = ser.deserializeDocument(bad, 400, 300, "#ffffff");
check("malformed image elements dropped, valid kept", badRound.document.frames[0].layers[0].elements.length === 1);
check("dropped elements produce warning", badRound.warnings.some((w) => /corrupt|skipped/.test(w)));

// v2 doc with image? — legacy docs can't contain images; ensure v2 migration unaffected
const v2 = { version: 2, canvas: { width: 400, height: 300, background: "#fff" }, elements: [{ id: "a", type: "stroke", tool: "brush", color: "#000", size: 5, opacity: 1, points: [{ x: 1, y: 1 }] }], settings: { grid: false } };
const v2r = ser.deserializeDocument(v2, 400, 300, "#ffffff");
check("v2 migration still wraps elements into F1/L1", v2r.document.frames[0].layers[0].elements.length === 1);

// ---------- image-ops ----------
const frame = doc.frames[0];
const top = { id: "top", type: "image", assetPath: "u/p/t.png", x: 0, y: 0, w: 50, h: 50, srcW: 10, srcH: 10, rotation: 0, opacity: 1 };
const bottom = { id: "bot", type: "image", assetPath: "u/p/b.png", x: 0, y: 0, w: 50, h: 50, srcW: 10, srcH: 10, rotation: 0, opacity: 1 };
frame.layers[0].elements = [bottom];
const l2 = makeLayer(frame.layers.length + 1);
l2.elements.push(top);
frame.layers.push(l2); // layers[] bottom→top; l2 is now topmost

let hit = ops.hitTestImage(frame, 25, 25);
check("hit test picks top layer image", hit?.element.id === "top");
check("hit test misses outside bounds", ops.hitTestImage(frame, 400, 400) === null);
frame.layers[1].locked = true;
check("locked layer image not hit-testable", ops.hitTestImage(frame, 25, 25)?.element.id === "bot");
frame.layers[1].locked = false;
frame.layers[1].visible = false;
check("hidden layer image not hit-testable", ops.hitTestImage(frame, 25, 25)?.element.id === "bot");
frame.layers[1].visible = true;
check("findImage locates by id", ops.findImage(frame, "bot")?.element.id === "bot");

// handles + corners
check("cornerAt tl", ops.cornerAt(top, 1, 1, 10) === "tl");
check("cornerAt br", ops.cornerAt(top, 49, 49, 10) === "br");
check("cornerAt inside body → null", ops.cornerAt(top, 25, 25, 10) === null);

// resize keeps aspect + anchors opposite corner
const st = { x: 10, y: 10, w: 100, h: 50 };
const r1 = ops.resizeRect(st, "br", 20, 0);
check("resize br grows, aspect 2:1", Math.abs(r1.w / r1.h - 2) < 0.01, `${r1.w}x${r1.h}`);
check("resize br anchors tl", r1.x === 10 && r1.y === 10);
const r2 = ops.resizeRect(st, "tl", -20, 0);
check("resize tl grows leftward, anchors br", Math.abs(r2.x + r2.w - 110) < 0.01 && Math.abs(r2.y + r2.h - 60) < 0.01);
check("resize clamps min", ops.resizeRect(st, "br", -500, 0).w >= 8);
check("moveRect translates", (() => { const m = ops.moveRect(st, 5, -5); return m.x === 15 && m.y === 5 && m.w === 100; })());

// placement: centred + aspect preserved
const pl = ops.placementRect(256, 128, 400, 300);
check("placement preserves aspect", Math.abs(pl.w / pl.h - 2) < 0.01);
check("placement centred", Math.abs(pl.x + pl.w / 2 - 200) <= 1 && Math.abs(pl.y + pl.h / 2 - 150) <= 1);
check("placement fits canvas", pl.w <= 400 * 0.6 + 1 && pl.h <= 300 * 0.6 + 1);

// ---------- history: image ops undo/redo ----------
const hist = new DrawingHistory();
const layer = frame.layers[0];
const el2 = { id: "h1", type: "image", assetPath: "u/p/h.png", x: 0, y: 0, w: 20, h: 20, srcW: 10, srcH: 10, rotation: 0, opacity: 1 };

// insert
hist.push({ redo: () => { layer.elements.push(el2); }, undo: () => { const i = layer.elements.indexOf(el2); if (i >= 0) layer.elements.splice(i, 1); } });
layer.elements.push(el2); // simulate run() calling redo first
check("insert leaves element on layer", layer.elements.includes(el2));
hist.undo(); check("undo insert removes", !layer.elements.includes(el2));
hist.redo(); check("redo insert restores same object", layer.elements.includes(el2));

// move (same-object mutation, like the drag command)
const start = { x: 0, y: 0, w: 20, h: 20 };
const end = { x: 30, y: 40, w: 40, h: 20 };
hist.push({
  redo: () => { el2.x = end.x; el2.y = end.y; el2.w = end.w; el2.h = end.h; },
  undo: () => { el2.x = start.x; el2.y = start.y; el2.w = start.w; el2.h = start.h; },
});
el2.x = end.x; el2.y = end.y; el2.w = end.w; el2.h = end.h;
check("move applied", el2.x === 30 && el2.w === 40);
hist.undo(); check("undo move restores rect", el2.x === 0 && el2.w === 20);
hist.redo(); check("redo move re-applies", el2.x === 30 && el2.h === 20);

// delete
hist.push({ redo: () => { const i = layer.elements.indexOf(el2); if (i >= 0) layer.elements.splice(i, 1); }, undo: () => { if (!layer.elements.includes(el2)) layer.elements.push(el2); } });
layer.elements.splice(layer.elements.indexOf(el2), 1);
check("delete removes", !layer.elements.includes(el2));
hist.undo(); check("undo delete restores element", layer.elements.includes(el2));

// replace assetPath (AI edit-replace)
const oldPath = el2.assetPath, newPath = "u/p/edited.png";
hist.push({ redo: () => { el2.assetPath = newPath; }, undo: () => { el2.assetPath = oldPath; } });
el2.assetPath = newPath;
check("replace swaps asset", el2.assetPath === newPath);
hist.undo(); check("undo replace restores original", el2.assetPath === oldPath);

// ---------- API surface sanity (live dev server) ----------
// Unauthenticated requests must be rejected — deeper coverage runs in the
// browser suite which holds a real session.
const apiBase = "http://localhost:3000";
try {
  const r = await fetch(`${apiBase}/api/projects/00000000-0000-0000-0000-000000000000/ai-image`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("ai-image route rejects unauthenticated", r.status === 401, String(r.status));
  const r2 = await fetch(`${apiBase}/api/projects/00000000-0000-0000-0000-000000000000/assets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("assets route rejects unauthenticated", r2.status === 401, String(r2.status));
} catch (e) {
  check("routes reachable (dev server)", false, e.message);
}

console.log(`\n${pass}/${pass + fail} checks passed`);
// process.exitCode (not process.exit) — avoids a libuv handle assertion on
// Windows when undici keep-alive sockets are still closing.
process.exitCode = fail ? 1 : 0;
