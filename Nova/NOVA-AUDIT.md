# NOVA → AI Drawing & Animation Studio — Technical Audit

**Date:** 2026-11-16
**Scope:** Read-only audit of `C:\Users\Administrator\Desktop\odi007\Nova`
**Rule compliance:** No files deleted, no code modified, no dependencies installed, no schema/env changes.

---

## 1. Executive Summary

Nova is a **working multi-agent chat application** (Next.js 15, React 19, Supabase, ~5,900 LOC of application code).

- Its **platform shell** — authentication, RLS-isolated data, guest mode, SSE streaming, a canvas side-panel, dashboard chrome — is directly reusable for a drawing/animation studio.
- Its **brain** — a 6-agent general-purpose orchestrator (~3,300 LOC in `lib/agents/`) — is almost entirely off-purpose and should be replaced by a small image-tool service rather than adapted.
- **Verdict:** keep the platform (~40% of code), remove the agent system (~55%), build the studio core (~5% exists today — `CanvasPanel.tsx` is the only seed).

---

## 2. Existing Architecture Overview

```
Browser (React 19)
  ├─ ChatThread → POST /api/tasks (SSE) ─→ lib/agents/taskrunner
  │     plan → subtasks (DAG, cap 3) → rescue → author → deliver
  ├─ ChatThread ⚡ → POST /api/chat (SSE) ─→ orchestrator.runFastAgent
  ├─ CanvasPanel ← artifacts extracted from assistant markdown
  └─ Supabase JS → conversations/messages/profiles/notifications (RLS)
```

- **Auth:** Supabase cookie sessions via `middleware.ts` + `@supabase/ssr`; guest mode via `nova_guest` cookie.
- **AI:** 6-provider router (`openai, gemini, groq, anthropic, custom, ollama`) with per-agent primary/fallback chains, retries, and call metrics.
- **Research:** `outlook_llm.ts` (Tavily/DuckDuckGo, SSRF-guarded scraping, relevance scoring).
- **Delivery:** `author.ts` is the sole user-facing writer; `deliverResponse` in `orchestrator.ts` applies a code-only gate (empty / truncated / unclosed fence / internal words) before delivery.

---

## 3. Repository Structure (verified)

```
Nova/
├── app/
│   ├── layout.tsx, globals.css
│   ├── (auth)/  login | signup | forgot-password | update-password   (4 pages)
│   ├── (dashboard)/
│   │   ├── layout.tsx                 sidebar + bottom nav chrome
│   │   ├── page.tsx                   stats dashboard (recharts, 291 LOC)
│   │   ├── chats/ page | new | [id]   chat list + thread
│   │   ├── models/page.tsx            provider metrics dashboard
│   │   └── notifications | profile | settings  (pages)
│   └── api/
│       ├── chat/route.ts              SSE orchestrator (older pipeline)
│       ├── tasks/route.ts             SSE DAG task runner (current)
│       ├── agents/metrics/route.ts    in-memory call metrics
│       └── health/models/route.ts     dev-only provider probe
├── components/ (18 files)
│   ├── ChatThread.tsx (656) — main chat surface, SSE client, agent strip
│   ├── AgentDashboard.tsx (379), AgentFlow.tsx (200), AgentPanel.tsx (55)
│   ├── CanvasPanel.tsx (344) — file tree, tabs, line numbers, HTML preview
│   ├── Sidebar, BottomNav, AgentToggle, CanvasToggle, StatCard,
│   │   Skeletons, EmptyState, Icons, ThemeProvider, ThemeToggle, SignOutButton
├── lib/
│   ├── agents/ (13 files, ~3,300 LOC — the multi-agent brain)
│   │   ├── llm.ts (430) — provider router, DEFAULT_CONFIG, probeProvider
│   │   ├── orchestrator.ts (610), taskrunner.ts (398), agents.ts (95)
│   │   ├── author.ts (269), codegen.ts (102), devin.ts (152)
│   │   ├── outlook_llm.ts (409), search.ts (67), board.ts, bus.ts,
│   │   │   metrics.ts, types.ts
│   ├── artifacts.ts, sse.ts, reply.ts, guest.ts, guest-server.ts, types.ts
│   └── supabase/ client.ts, server.ts
├── supabase/ schema.sql, seed.sql
├── scripts/ test-meta-goal.mjs
└── middleware.ts, next.config.mjs, tailwind/postcss/ts configs
```

---

## 4. Existing Functionality Inventory (verified)

| Feature | Status | Evidence |
|---|---|---|
| Email/password auth, signup, reset | **Implemented** | `app/(auth)/*`, `middleware.ts` |
| Guest mode | **Implemented** | `lib/guest*.ts`, `nova_guest` cookie, `isGuestClient` in every page |
| RLS-isolated profiles | **Implemented** | `profiles` table + `handle_new_user` trigger |
| Conversations + messages persistence | **Implemented** | schema + `ChatThread` insert/select |
| Notifications | **Implemented but orphaned** | table + page exist; **nothing writes notifications** |
| Avatars storage bucket | **Implemented (DDL only)** | `storage.buckets` + policies; no upload UI |
| Model router, fallbacks, metrics | **Implemented** | `llm.ts`, `metrics.ts`, `/api/agents/metrics`, `/models` page |
| SSE streaming | **Implemented** | `/api/tasks`, `/api/chat`, `lib/sse.ts` |
| Multi-agent DAG runner | **Implemented** | `taskrunner.ts` (plan → parallel subtasks → rescue → author) |
| Author + delivery gate | **Implemented** | `author.ts`, `deliverResponse` |
| Devin delegation + cooldown | **Implemented** | `devin.ts` (billing errors confirmed live) |
| Web research | **Implemented** | `outlook_llm.ts`, `search.ts` |
| Canvas/preview panel | **Partially implemented** | `CanvasPanel.tsx` — code viewer, **not a drawing surface** |
| Tests | **Nearly absent** | only `scripts/test-meta-goal.mjs` smoke test |

---

## 5. Classifications

### KEEP — use as-is

| Item | Files | Reason | Risk |
|---|---|---|---|
| Auth + middleware | `(auth)/*`, `middleware.ts` | Identical need for studio accounts | None |
| Supabase client/server helpers | `lib/supabase/*` | Thin wrappers, stack-correct | None |
| RLS schema pattern | `schema.sql` (profiles, triggers) | Same pattern needed for projects/layers | None |
| Guest mode | `lib/guest*.ts` | "Try before signup" for a drawing tool | None |
| `lib/sse.ts` | SSE reader | Reusable for AI-generation streams | None |
| UI primitives | `EmptyState`, `Skeletons`, `StatCard`, `Icons`, `ThemeProvider/Toggle`, `Sidebar`, `BottomNav`, `SignOutButton` | Chrome stays; content changes | Icons need additions (brush/layers) |
| CanvasPanel code view | `components/CanvasPanel.tsx` | File tree/tabs/preview pattern reusable for asset viewer | It's a *code* viewer — preview needs to become raster |

### MODIFY

| Item | Files | Change needed | Risk |
|---|---|---|---|
| Chat shell | `ChatThread.tsx` | Becomes AI-assistant sidebar in studio (prompt → image ops), not the main surface | 656 LOC tightly coupled to task events; keep SSE plumbing, drop agent strip |
| Dashboard home | `(dashboard)/page.tsx` | From chat stats → project grid ("recent projects") | recharts usage goes away entirely |
| `lib/types.ts` | — | Add Project/Layer/Frame/Asset types alongside Conversation/Message | None |
| Provider router | `llm.ts` | Keep provider infra; add an `image` provider kind | Current keys are all quota-dead |
| Model metrics | `metrics.ts`, `/api/agents/metrics`, `/models` page | Repurpose to generation metrics or drop page | Tied to agent ids |
| `/api/chat` route | `app/api/chat/route.ts` | Keep SSE pattern; replace orchestrator with tool-call pipeline | None |

### REMOVE — no longer in product

| Item | Files | Exclusive dependencies | Risk if removed |
|---|---|---|---|
| Agent orchestrator | `orchestrator.ts` (610) | `board.ts`, `bus.ts`, `agents.ts`, `codegen.ts`, `PERSONAS` | ChatThread + `/api/chat` must be rewired first |
| DAG task runner | `taskrunner.ts` (398) | `/api/tasks`, `Subtask`/`TaskEvent` types, `generateFiles` | Same — rewire chat first |
| Author + gate | `author.ts` | Called by both runners + chat route fallback | Remove together with callers |
| Devin integration | `devin.ts` | `runDevinOrRescue` calls; `DEVIN_*` env vars | None once runners go |
| Research pipeline | `outlook_llm.ts` (409), `search.ts` | Used by runner, rescue, orchestrator, devin rescue | Optional keep for prompt enrichment — likely remove |
| Per-file code generation | `codegen.ts` | `generateFiles` calls | None |
| Agent UI | `AgentDashboard`, `AgentFlow`, `AgentPanel`, `AgentToggle`, `ActivityList` | `AgentRun` type, agent_status events | Strip from ChatThread/dashboard |
| Code artifact parsing | `artifacts.ts` | `extractArtifacts`, `projectArtifact`, preview builder | CanvasPanel depends on it — remove together |
| Placeholder replies | `reply.ts` | `/api/chat` last-ditch fallback | None |
| Models dashboard | `(dashboard)/models` | `agentAssignments()` | None |
| Notifications | `notifications` table + page | Nothing writes to it — already orphaned | Zero |
| Meta-goal test script | `scripts/test-meta-goal.mjs` | None | None |

### BUILD — missing entirely

| Capability | Existing foundation to reuse |
|---|---|
| Drawing surface (brush/eraser/shapes/fill/text, pointer pressure) | None. Build on `<canvas>` 2D context (no dep) or Fabric.js if an object model + undo is wanted — justified dep |
| Raster layer system (stacked canvases, opacity/blend/visibility/reorder/merge) | None |
| Frames + timeline (per-frame duration, onion-skin, reorder) | None. Frame = per-frame layer stack or shared-layers model |
| Playback engine (rAF loop, FPS control, loop modes) | None. ~150 LOC, no dependency needed |
| Project model + autosave | `conversations` pattern proves RLS approach; see §7 |
| AI image generation (text→image, character sheets) | **Not available in any current provider.** New `image` provider kind in `llm.ts` registry (OpenAI Images / Imagen / Stability / Replicate / local SD) |
| AI image editing (inpaint region, erase object, extend canvas) | New: mask + source image → image-edit endpoint |
| Export (PNG sequence, sprite sheet, GIF/WebM/APNG) | GIF needs `gif.js`-style lib (justified); WebM via MediaRecorder (no dep); PNG sequence trivial |
| Asset library (generated images, reusable characters) | Supabase Storage — `avatars` bucket is the policy template |
| Undo/redo (command stack or layer snapshots) | None |
| Canvas settings (dimensions, bg, grid, zoom/pan) | None |

---

## 6. Assessments

### Frontend
`ChatThread` is the only interactive surface and is message-centric. The studio needs a workspace layout (canvas center, tools left, layers/timeline right + bottom). Dashboard `layout.tsx` nav/sidebar chrome is reusable. React 19 + Tailwind are fine; no canvas library exists today.

### Backend
Next route handlers + SSE are adequate. AI work moves from "multi-agent text" to single-purpose image ops (`POST /api/generate`, `/api/edit`, `/api/inpaint`). The router's *plumbing* (env gating, retries, metrics, `probeProvider`) is worth keeping; all agent *prompts/runners* go.

### Supabase
Auth, RLS, Storage policies, triggers — all reusable verbatim. See §7 for new structures.

### AI integration
Text-model routing is overbuilt but functional. Image generation is at 0% — a new provider kind + routes are required. **All provider keys currently fail quota** (verified via `/api/health/models` — OpenAI, Anthropic, Gemini, Groq, custom, ollama all FAIL).

### Dependencies
`recharts` becomes unused when the dashboard redesigns → removal candidate (drop with the same change). Otherwise the stack is lean. Justified additions: a canvas lib (optional), a GIF encoder (if GIF export required), possibly `zustand` for canvas state (optional — context/useState may suffice).

---

## 7. Database Assessment

**Reusable:** `profiles`, auth users, `touch_updated_at` + `handle_new_user` triggers, RLS policy idiom, `avatars` bucket pattern, `notifications` (could carry "generation complete" events — or drop).

**New structures needed (proposal only — do not execute):**

```sql
projects        (id, user_id, title, width, height, fps, bg_color, updated_at)
layers          (id, project_id, name, position, opacity, blend_mode, visible, kind)
frames          (id, project_id, position, duration_ms, thumbnail_path)
frame_layers    (frame_id, layer_id, bitmap_path | vector_json)
assets          (id, user_id, project_id?, storage_path, kind, ai_source jsonb)
ai_generations  (id, project_id, user_id, prompt, params jsonb,
                 result_asset_id, model, status)
exports         (id, project_id, format, storage_path, settings jsonb)
```

**Alternative:** `projects.document jsonb` storing the whole project document (bitmaps as Storage paths) — often a better fit for save/restore than row-per-layer. Decide after defining the document format.

**Storage:** new `projects` + `assets` buckets (private, `auth.uid()::text = foldername(name))[1]` — same policy shape as `avatars`).

---

## 8. Technical Risks

1. **Provider quota is zero across the board** (verified — every provider fails). Any AI feature is dead until billing is topped up.
2. **Bitmap storage size**: animation projects × layers × frames grow large fast — plan Storage quotas, compression, and thumbnailing.
3. **ChatThread coupling**: removing the agent UI from a 656-line component — do incrementally, not by rewrite.
4. **No test coverage** beyond one smoke script; every migration step is unguarded.
5. **Dev-server instability observed** (stale `.next`, OOM on a ~12 GB box) — expect during heavy canvas dev; workaround: stop server, `rm -rf .next`, restart.
6. **Devin delegation billing** returns 403s today; removing `devin.ts` eliminates an external dependency and a whole env-var family.

---

## 9. Recommended Future Architecture

```
app/(studio)/
  studio/[id]/page.tsx        workspace: canvas + tools + layers + timeline
  projects/page.tsx           project grid (reuse chats-list pattern)
api/
  generate/route.ts           text→image (SSE progress)
  edit/route.ts               image ops (inpaint / extend / erase)
  projects/route.ts           CRUD + autosave
lib/
  studio/                     NEW: document model, commands, playback, export
  ai/image.ts                 NEW: image provider kind registered in llm.ts
  agents/ → deleted           REPLACE with lib/ai/tools.ts (prompt→op parsing only)
```

---

## 10. Proposed Implementation Phases

| Phase | Scope | Touches existing? |
|---|---|---|
| **0 — Skeleton** | `projects` table + `projects` bucket + project CRUD routes + empty workspace page (canvas, dimensions, save/restore) | DB additive only; zero removals |
| **1 — Drawing** | brush/eraser/fill/shapes/text on `<canvas>`, color/size tools, single layer, undo | New `lib/studio/`; no removals |
| **2 — Layers & Frames** | layer stack, timeline, per-frame durations, onion-skin, playback | Same |
| **3 — AI** | `image` provider kind + `/api/generate` ("generate → new layer/asset") + edit ops | Extends `llm.ts` registry only |
| **4 — Export** | PNG sequence, WebM, sprite sheet; optional GIF | Storage assets |
| **5 — Excision** | Remove agent system, agent UI, `/api/tasks`, Devin, research, artifacts; rewire remaining chat to a minimal tool-call pipeline | Biggest removal step — **do last**, after studio is self-sufficient |

---

## 11. Features to Verify Before Removal (Phase 5 checklist)

- `/api/chat` fast path — used by the ⚡ button in ChatThread; decide keep/replace/drop before removing `orchestrator.ts`.
- `/api/tasks` SSE — sole consumer is `ChatThread`; safe after studio has its own AI surface.
- `conversations`/`messages` — may be reused as project AI-history; decide before dropping.
- `author.ts` deterministic fallback — its plain-language failure style is worth copying into image ops before deleting the file.
- `CanvasPanel` — extract the file-tree/tabs pattern into the asset viewer before deleting `artifacts.ts`.
- `metrics.ts` + `/models` page — decide whether generation metrics reuse it.

---

## Recommendation: First Implementation Phase

**Phase 0 — the skeleton.** Add `projects` (and optionally `document jsonb`) + a private `projects` storage bucket, project CRUD API, and a minimal `/studio/[id]` page that renders an empty `<canvas>` at chosen dimensions and round-trips a save. This:

- Reuses auth/RLS/Storage verbatim — zero risk to the existing app.
- Establishes the document format **early** — the single most consequential design decision (row-per-layer vs. document JSONB + bitmap paths).
- Gives a working save/restore loop to build every later feature against.
- Delays all removals until the studio stands on its own.
