# NOVA Phase 0 — Studio Foundation Implementation Report

**Date:** 2026-11-16
**Status:** Code complete. End-to-end test blocked on applying the new SQL to Supabase.

---

## 1. Objective

Establish the foundation for users to create, save, reopen, and manage drawing/animation projects — **without** removing or breaking any existing functionality (auth, profiles, guest mode, Supabase helpers, RLS patterns, AI providers, agents, Devin, task runner, chat).

---

## 2. Files created

| File | Purpose |
|---|---|
| `lib/projects.ts` | Shared helpers: `validateProjectInput` (title/width/height/background/fps/document), `getAuthedClient` (cookie session **and** Bearer token — RLS applies in both), `DEFAULT_DOCUMENT`, canvas/fps limits |
| `app/api/projects/route.ts` | `GET` — list own projects (summary columns, ordered by `updated_at`); `POST` — create with validation, returns 201 |
| `app/api/projects/[id]/route.ts` | `GET` / `PATCH` / `DELETE` on a single project. UUID format check, ownership verification on every op, 404 for not-found-or-not-owned |
| `app/studio/[id]/page.tsx` | Studio workspace — see §6 |
| `scripts/test-projects.mjs` | 18-check end-to-end suite (creates throwaway users, exercises API over HTTP + RLS directly) |

## 3. Files modified

| File | Change |
|---|---|
| `supabase/schema.sql` | Appended `projects` table + `project-assets` private storage bucket policies — **additive only**, `if not exists` everywhere, safe to re-run |
| `lib/types.ts` | Added `Project`, `ProjectSummary`, `ProjectDocument` types |
| `components/Icons.tsx` | Added `IconBack`, `IconBrush`, `IconEraser`, `IconFill`, `IconText`, `IconShapes` (matching existing stroke style) |
| `app/(dashboard)/page.tsx` | New "Projects" section: create form (name + width × height), list with open/rename/delete, guest-aware |

Nothing deleted. Agents, Devin integration, task runner, research pipeline, chat, and all other dashboard features are untouched.

---

## 4. Database changes (written — pending application)

```sql
public.projects (
  id uuid pk default gen_random_uuid(),
  user_id uuid → auth.users (cascade),
  title text default 'Untitled project',
  width/height int check (8..8192),
  background text default '#ffffff',
  fps int check (1..120) default 12,
  document jsonb default '{"version":1,"layers":[],"frames":[]}',
  created_at, updated_at + touch_updated_at trigger
)
```

- RLS enabled; four `*_own` policies (`auth.uid() = user_id`).
- `project-assets` bucket: **private**, insert/select/update/delete scoped to `auth.uid()::text = foldername(name))[1]` — same pattern as `avatars`.
- Document = JSONB (evaluated as requested): flexible enough for the Phase 1–2 layer/frame model without schema churn.

## 5. Storage changes

New private bucket `project-assets` (DDL above). Not yet used by code — reserved for bitmap layers, generated assets, and export artifacts in later phases.

## 6. API endpoints

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/api/projects` | List caller's projects (no `document` in list payload) |
| `POST` | `/api/projects` | Create; requires `width`, `height`; optional `title`, `background`, `fps`, `document` |
| `GET` | `/api/projects/:id` | Full row including `document` |
| `PATCH` | `/api/projects/:id` | Partial update of any validated field; empty body → 400 |
| `DELETE` | `/api/projects/:id` | Deletes; returns `{ ok: true }` |

All five: 401 unauthenticated, 404 for non-owned IDs (no existence leak), 400 with a specific message for invalid input.

## 7. Frontend implemented

**`/studio/[id]`** (outside the dashboard group — full workspace, no sidebar):
- Top toolbar: back link, inline-editable project name, dims display, save status (`Unsaved changes` / `Saving…` / `Saved` / error — **no false success**; "Saved" only shows after a 200), Save button
- Center stage: `<canvas>` at project `width × height`, filled with the project background, pixelated scaling on a dark stage
- Left rail: brush/eraser/fill/text/shapes icons, disabled ("coming in Phase 1")
- Right panel: **Properties** (background colour picker + fps input — both editable, mark dirty) and Layers placeholder
- Bottom strip: Timeline placeholder
- States: guest/unauthenticated → sign-in prompt; 404 → not-found; error → retry; loading spinner

**Dashboard `/`**: Projects card — create form (name + W×H, inline validation errors), list (title, dims, updated date), open (link to `/studio/{id}`), rename (prompt → PATCH), delete (confirm → DELETE). Guests see a sign-in empty state.

**Save/restore cycle:** edits mark dirty → Save PATCHes `title + background + fps + document` → server returns the persisted row → status shows "Saved". Restore verified structurally; live round-trip pending DB.

---

## 8. Tests performed

| Test | Result |
|---|---|
| `npx tsc --noEmit` | **PASS** (clean) |
| `GET /api/projects` unauthenticated | **PASS** — 401 `{"error":"Unauthorized"}` |
| `GET /api/projects/:id` unauthenticated | **PASS** — 401 |
| `GET /api/projects/not-a-uuid` | **PASS** — 400 `Invalid project id` |
| `GET /studio/{uuid}` unauthenticated | **PASS** — 307 → `/login` |
| Table `public.projects` exists | **FAIL — not yet applied** (`Could not find the table 'public.projects' in the schema cache`) |
| CRUD / RLS / ownership / validation / restore | **BLOCKED** — needs the table; `scripts/test-projects.mjs` runs all 18 checks |

## 9. Known issues

- **`projects` table + `project-assets` bucket don't exist in Supabase yet** — every DB-touching path returns an error until the SQL is applied (I have no service-role key or CLI access; it must be run in the SQL editor).
- Studio page has no autosave — explicit Save button only (by design for Phase 0).
- `document` is currently an opaque round-tripped JSONB — no layer/frame editing until Phase 1–2.
- Canvas display is `image-rendering: pixelated` — fine for sprites; may want smooth scaling as a setting later.

## 10. Remaining work before Phase 1

1. **Apply the SQL** — Supabase → SQL Editor → run the `-- ---------- projects (studio, Phase 0)` section at the bottom of `supabase/schema.sql` (or the whole file — idempotent).
2. **Run the suite** — `node scripts/test-projects.mjs` (dev server on :3000 must be up) — validates real CRUD, two-user RLS isolation, ownership denial, all validation rejections, and save→leave→restore.
3. Optionally: a quick manual pass — create a project on the dashboard, open `/studio/{id}`, rename + change background, save, leave, reopen.

Once the suite passes, Phase 0 is done and Phase 1 (drawing engine — brushes, eraser, fill, shapes, text, undo) can start.
