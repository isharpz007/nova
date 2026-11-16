import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";
import type { ProjectDocument } from "@/lib/types";

export const CANVAS_MIN = 8;
export const CANVAS_MAX = 8192;
export const FPS_MIN = 1;
export const FPS_MAX = 120;
export const TITLE_MAX = 200;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const DEFAULT_DOCUMENT: ProjectDocument = {
  version: 1,
  layers: [],
  frames: [],
};

export interface ProjectInput {
  title?: unknown;
  width?: unknown;
  height?: unknown;
  background?: unknown;
  fps?: unknown;
  document?: unknown;
}

export interface ValidatedProjectFields {
  title?: string;
  width?: number;
  height?: number;
  background?: string;
  fps?: number;
  document?: ProjectDocument;
}

/**
 * Validates a subset of project fields. Unknown keys are ignored; present-but-
 * invalid values return an error message. `required` lists fields that must be
 * present (used by create; update uses a subset).
 */
export function validateProjectInput(
  input: ProjectInput,
  required: (keyof ProjectInput)[]
): { fields?: ValidatedProjectFields; error?: string } {
  const fields: ValidatedProjectFields = {};

  for (const key of required) {
    if (input[key] === undefined) {
      return { error: `Missing required field: ${key}` };
    }
  }

  if (input.title !== undefined) {
    if (typeof input.title !== "string" || !input.title.trim()) {
      return { error: "title must be a non-empty string" };
    }
    const title = input.title.trim();
    if (title.length > TITLE_MAX) {
      return { error: `title must be ${TITLE_MAX} characters or fewer` };
    }
    fields.title = title;
  }

  for (const dim of ["width", "height"] as const) {
    if (input[dim] === undefined) continue;
    const v = input[dim];
    if (typeof v !== "number" || !Number.isInteger(v) || v < CANVAS_MIN || v > CANVAS_MAX) {
      return { error: `${dim} must be an integer between ${CANVAS_MIN} and ${CANVAS_MAX}` };
    }
    fields[dim] = v;
  }

  if (input.fps !== undefined) {
    const v = input.fps;
    if (typeof v !== "number" || !Number.isInteger(v) || v < FPS_MIN || v > FPS_MAX) {
      return { error: `fps must be an integer between ${FPS_MIN} and ${FPS_MAX}` };
    }
    fields.fps = v;
  }

  if (input.background !== undefined) {
    if (typeof input.background !== "string" || !HEX_COLOR.test(input.background)) {
      return { error: "background must be a hex colour like #ffffff" };
    }
    fields.background = input.background;
  }

  if (input.document !== undefined) {
    if (
      typeof input.document !== "object" ||
      input.document === null ||
      Array.isArray(input.document)
    ) {
      return { error: "document must be a JSON object" };
    }
    fields.document = input.document as ProjectDocument;
  }

  return { fields };
}

/**
 * Returns a Supabase client + user for the request. Supports Bearer tokens
 * (scripts, future native clients) and cookie sessions (the browser app).
 * RLS applies in both modes — queries are scoped to the caller.
 */
export async function getAuthedClient(
  request: NextRequest
): Promise<{ supabase: SupabaseClient; user: User } | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (!token) return null;
    const supabase = createClient(url, key, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();
    if (error || !user) return null;
    return { supabase, user };
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return { supabase, user };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Authenticates the request and verifies the caller owns the project.
 * Returns either a ready-to-use {supabase, user, id} or a NextResponse error.
 */
export async function requireOwnedProject(
  request: NextRequest,
  id: string
): Promise<{ supabase: SupabaseClient; user: User; id: string } | NextResponse> {
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid project id" }, { status: 400 });
  }
  const auth = await getAuthedClient(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { data, error } = await auth.supabase
    .from("projects")
    .select("id")
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return { supabase: auth.supabase, user: auth.user, id };
}
